#include "openjornada/url_policy.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <string_view>

namespace openjornada {
namespace {

struct ParsedIpv4 {
  bool valid = false;
  std::array<uint8_t, 4> octets{};
};

bool asciiVisible(std::string_view value) {
  for (const unsigned char byte : value) {
    if (byte <= 0x20U || byte >= 0x7FU) {
      return false;
    }
  }
  return true;
}

ParsedIpv4 parseIpv4(std::string_view host) {
  ParsedIpv4 result;
  size_t cursor = 0;
  for (size_t part = 0; part < result.octets.size(); ++part) {
    const size_t dot = host.find('.', cursor);
    const size_t end = dot == std::string_view::npos ? host.size() : dot;
    if (end == cursor || end - cursor > 3 ||
        (end - cursor > 1 && host[cursor] == '0')) {
      return result;
    }
    uint32_t value = 0;
    for (size_t index = cursor; index < end; ++index) {
      const unsigned char byte = static_cast<unsigned char>(host[index]);
      if (!std::isdigit(byte)) {
        return result;
      }
      value = value * 10U + static_cast<uint32_t>(byte - '0');
      if (value > 255U) {
        return result;
      }
    }
    result.octets[part] = static_cast<uint8_t>(value);
    if (part + 1 < result.octets.size()) {
      if (dot == std::string_view::npos) {
        return result;
      }
      cursor = dot + 1;
    } else if (dot != std::string_view::npos) {
      return result;
    }
  }
  result.valid = true;
  return result;
}

bool isPrivate(const ParsedIpv4& address) {
  return address.octets[0] == 10 ||
         (address.octets[0] == 172 && address.octets[1] >= 16 &&
          address.octets[1] <= 31) ||
         (address.octets[0] == 192 && address.octets[1] == 168);
}

bool validDnsName(std::string_view host) {
  if (host.empty() || host.size() > 253 || host.back() == '.') {
    return false;
  }
  size_t labelStart = 0;
  while (labelStart < host.size()) {
    const size_t dot = host.find('.', labelStart);
    const size_t labelEnd = dot == std::string_view::npos ? host.size() : dot;
    const size_t labelSize = labelEnd - labelStart;
    if (labelSize == 0 || labelSize > 63 || host[labelStart] == '-' ||
        host[labelEnd - 1] == '-') {
      return false;
    }
    for (size_t index = labelStart; index < labelEnd; ++index) {
      const unsigned char byte = static_cast<unsigned char>(host[index]);
      if (!(std::islower(byte) || std::isdigit(byte) || byte == '-')) {
        return false;
      }
    }
    if (dot == std::string_view::npos) {
      return true;
    }
    labelStart = dot + 1;
  }
  return false;
}

bool numericLikeHost(std::string_view host) {
  return std::all_of(host.begin(), host.end(), [](unsigned char byte) {
    return std::isdigit(byte) || byte == '.';
  });
}

bool validPort(std::string_view port) {
  if (port.empty() || port.size() > 5) {
    return false;
  }
  uint32_t value = 0;
  for (const unsigned char byte : port) {
    if (!std::isdigit(byte)) {
      return false;
    }
    value = value * 10U + static_cast<uint32_t>(byte - '0');
  }
  return value >= 1 && value <= 65535;
}

int hexValue(char byte) {
  if (byte >= '0' && byte <= '9') return byte - '0';
  if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
  if (byte >= 'A' && byte <= 'F') return byte - 'A' + 10;
  return -1;
}

bool validPath(std::string_view path) {
  if (path.empty()) {
    return true;
  }
  if (path.front() != '/' || path.find('\\') != std::string_view::npos) {
    return false;
  }

  size_t segmentStart = 1;
  while (segmentStart <= path.size()) {
    const size_t slash = path.find('/', segmentStart);
    const size_t segmentEnd =
        slash == std::string_view::npos ? path.size() : slash;
    size_t decodedDotCount = 0;
    bool onlyDots = true;
    for (size_t index = segmentStart; index < segmentEnd; ++index) {
      unsigned char decoded = static_cast<unsigned char>(path[index]);
      if (decoded == '%') {
        if (index + 2 >= segmentEnd) return false;
        const int high = hexValue(path[index + 1]);
        const int low = hexValue(path[index + 2]);
        if (high < 0 || low < 0) return false;
        decoded = static_cast<unsigned char>((high << 4) | low);
        index += 2;
        if (decoded == '%' || decoded == '/' || decoded == '\\' ||
            decoded <= 0x20U ||
            decoded == 0x7FU) {
          return false;
        }
      }
      if (decoded != '.') {
        onlyDots = false;
      } else if (decodedDotCount < 2) {
        ++decodedDotCount;
      } else {
        onlyDots = false;
      }
    }
    if (onlyDots && (decodedDotCount == 1 || decodedDotCount == 2)) {
      return false;
    }
    if (slash == std::string_view::npos) break;
    segmentStart = slash + 1;
  }
  return true;
}

UrlDecision denied(UrlError error) { return {false, error}; }

}  // namespace

UrlDecision validateBaseUrl(std::string_view url, BuildProfile profile) {
  if (url.empty()) return denied(UrlError::Empty);
  if (url.size() > kMaxBaseUrlBytes) return denied(UrlError::TooLong);
  if (!asciiVisible(url)) return denied(UrlError::InvalidPath);
  if (url.find('#') != std::string_view::npos) {
    return denied(UrlError::Fragment);
  }
  if (url.find('?') != std::string_view::npos) return denied(UrlError::Query);
  if (url.find('\\') != std::string_view::npos) return denied(UrlError::InvalidPath);

  bool secure = false;
  size_t authorityStart = 0;
  if (url.substr(0, 8) == "https://") {
    secure = true;
    authorityStart = 8;
  } else if (url.substr(0, 7) == "http://") {
    authorityStart = 7;
  } else {
    return denied(UrlError::InvalidScheme);
  }

  const size_t pathStart = url.find('/', authorityStart);
  const std::string_view authority = url.substr(
      authorityStart, pathStart == std::string_view::npos
                          ? std::string_view::npos
                          : pathStart - authorityStart);
  if (authority.empty()) return denied(UrlError::InvalidAuthority);
  if (authority.find('@') != std::string_view::npos) {
    return denied(UrlError::Credentials);
  }

  std::string_view host;
  std::string_view port;
  bool ipv6 = false;
  if (authority.front() == '[') {
    const size_t close = authority.find(']');
    if (close == std::string_view::npos) {
      return denied(UrlError::InvalidAuthority);
    }
    host = authority.substr(1, close - 1);
    ipv6 = true;
    if (close + 1 < authority.size()) {
      if (authority[close + 1] != ':') {
        return denied(UrlError::InvalidAuthority);
      }
      port = authority.substr(close + 2);
    }
  } else {
    const size_t colon = authority.find(':');
    if (colon == std::string_view::npos) {
      host = authority;
    } else {
      if (authority.find(':', colon + 1) != std::string_view::npos) {
        return denied(UrlError::InvalidAuthority);
      }
      host = authority.substr(0, colon);
      port = authority.substr(colon + 1);
    }
  }
  if (host.empty()) return denied(UrlError::InvalidHost);
  if (!port.empty() && !validPort(port)) return denied(UrlError::InvalidPort);
  if (authority.back() == ':') return denied(UrlError::InvalidPort);

  ParsedIpv4 ipv4;
  if (ipv6) {
    // IPv6 is intentionally unsupported until the embedded HTTP transport can
    // validate bracketed literals with the same rigor as the policy layer.
    return denied(host == "::1" ? UrlError::Loopback : UrlError::InvalidHost);
  } else {
    ipv4 = parseIpv4(host);
    if (!ipv4.valid && (numericLikeHost(host) || !validDnsName(host))) {
      return denied(UrlError::InvalidHost);
    }
    if (host == "localhost" ||
        (host.size() > 10 && host.substr(host.size() - 10) == ".localhost")) {
      return denied(UrlError::Loopback);
    }
  }
  if (ipv4.valid && (ipv4.octets[0] == 127 || ipv4.octets[0] == 0)) {
    return denied(UrlError::Loopback);
  }

  if (!secure) {
    if (profile != BuildProfile::Development || ipv6 || !ipv4.valid ||
        !isPrivate(ipv4)) {
      return denied(UrlError::PrivateHttpRequired);
    }
  }

  const std::string_view path = pathStart == std::string_view::npos
                                    ? std::string_view{}
                                    : url.substr(pathStart);
  if (!validPath(path)) return denied(UrlError::InvalidPath);
  return {true, UrlError::None};
}

BuildProfile currentBuildProfile() {
#if defined(OPENJORNADA_DEVELOPMENT) && OPENJORNADA_DEVELOPMENT
  return BuildProfile::Development;
#else
  return BuildProfile::Release;
#endif
}

}  // namespace openjornada
