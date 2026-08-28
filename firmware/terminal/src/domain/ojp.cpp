#include "openjornada/ojp.hpp"

#include <ArduinoJson.h>

#include <array>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace openjornada {
namespace {

constexpr std::string_view kUrlPrefix = "http://192.168.4.1/#ojp=";
constexpr std::string_view kFragmentPrefix = "#ojp=";
constexpr std::string_view kValuePrefix = "ojp=";

bool hasPrefix(std::string_view value, std::string_view prefix) {
  return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

std::string_view unwrap(std::string_view input) {
  if (hasPrefix(input, kUrlPrefix)) return input.substr(kUrlPrefix.size());
  if (hasPrefix(input, kFragmentPrefix)) {
    return input.substr(kFragmentPrefix.size());
  }
  if (hasPrefix(input, kValuePrefix)) return input.substr(kValuePrefix.size());
  return input;
}

int base64UrlValue(unsigned char byte) {
  if (byte >= 'A' && byte <= 'Z') return byte - 'A';
  if (byte >= 'a' && byte <= 'z') return byte - 'a' + 26;
  if (byte >= '0' && byte <= '9') return byte - '0' + 52;
  if (byte == '-') return 62;
  if (byte == '_') return 63;
  return -1;
}

bool decodeBase64Url(std::string_view input, std::vector<uint8_t>& output) {
  if (input.empty() || input.size() % 4U == 1U) return false;
  output.clear();
  output.reserve((input.size() * 3U) / 4U);
  uint32_t accumulator = 0;
  unsigned bits = 0;
  for (const unsigned char byte : input) {
    const int value = base64UrlValue(byte);
    if (value < 0) return false;
    accumulator = (accumulator << 6U) | static_cast<uint32_t>(value);
    bits += 6U;
    if (bits >= 8U) {
      bits -= 8U;
      output.push_back(static_cast<uint8_t>((accumulator >> bits) & 0xffU));
    }
  }
  if (bits != 0U) {
    const uint32_t paddingMask = (uint32_t{1} << bits) - 1U;
    if ((accumulator & paddingMask) != 0U) return false;
  }
  return true;
}

bool validUtf8(const std::vector<uint8_t>& input) {
  size_t cursor = 0;
  while (cursor < input.size()) {
    const uint8_t first = input[cursor++];
    if (first <= 0x7fU) continue;
    uint32_t codePoint = 0;
    size_t continuationCount = 0;
    uint32_t minimum = 0;
    if (first >= 0xc2U && first <= 0xdfU) {
      codePoint = first & 0x1fU;
      continuationCount = 1;
      minimum = 0x80U;
    } else if (first >= 0xe0U && first <= 0xefU) {
      codePoint = first & 0x0fU;
      continuationCount = 2;
      minimum = 0x800U;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      codePoint = first & 0x07U;
      continuationCount = 3;
      minimum = 0x10000U;
    } else {
      return false;
    }
    if (continuationCount > input.size() - cursor) return false;
    for (size_t index = 0; index < continuationCount; ++index) {
      const uint8_t byte = input[cursor++];
      if ((byte & 0xc0U) != 0x80U) return false;
      codePoint = (codePoint << 6U) | (byte & 0x3fU);
    }
    if (codePoint < minimum || codePoint > 0x10ffffU ||
        (codePoint >= 0xd800U && codePoint <= 0xdfffU)) {
      return false;
    }
  }
  return true;
}

bool consumeString(std::string_view json, size_t& cursor) {
  if (cursor >= json.size() || json[cursor++] != '"') return false;
  while (cursor < json.size()) {
    const unsigned char byte = json[cursor++];
    if (byte == '"') return true;
    if (byte < 0x20U) return false;
    if (byte != '\\') continue;
    if (cursor >= json.size()) return false;
    const char escaped = json[cursor++];
    if (escaped == 'u') {
      if (json.size() - cursor < 4U) return false;
      for (size_t index = 0; index < 4U; ++index) {
        const char hex = json[cursor++];
        if (!((hex >= '0' && hex <= '9') || (hex >= 'a' && hex <= 'f') ||
              (hex >= 'A' && hex <= 'F'))) {
          return false;
        }
      }
    } else if (std::string_view("\"\\/bfnrt").find(escaped) ==
               std::string_view::npos) {
      return false;
    }
  }
  return false;
}

bool consumeValue(std::string_view json, size_t& cursor) {
  if (cursor >= json.size()) return false;
  if (json[cursor] == '"') return consumeString(json, cursor);
  size_t nesting = 0;
  bool inString = false;
  bool escaped = false;
  const size_t start = cursor;
  while (cursor < json.size()) {
    const char byte = json[cursor];
    if (inString) {
      ++cursor;
      if (escaped) {
        escaped = false;
      } else if (byte == '\\') {
        escaped = true;
      } else if (byte == '"') {
        inString = false;
      }
      continue;
    }
    if (byte == '"') {
      inString = true;
      ++cursor;
    } else if (byte == '{' || byte == '[') {
      ++nesting;
      ++cursor;
    } else if (byte == '}' || byte == ']') {
      if (nesting == 0) break;
      --nesting;
      ++cursor;
    } else if (nesting == 0 && byte == ',') {
      break;
    } else {
      ++cursor;
    }
  }
  return cursor > start && !inString && nesting == 0;
}

void skipWhitespace(std::string_view json, size_t& cursor) {
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' ||
          json[cursor] == '\r' || json[cursor] == '\n')) {
    ++cursor;
  }
}

bool hasCanonicalKeySequence(std::string_view json) {
  constexpr std::array<std::string_view, 5> keys = {"\"v\"", "\"s\"",
                                                    "\"p\"", "\"u\"",
                                                    "\"t\""};
  size_t cursor = 0;
  skipWhitespace(json, cursor);
  if (cursor >= json.size() || json[cursor++] != '{') return false;
  for (size_t index = 0; index < keys.size(); ++index) {
    skipWhitespace(json, cursor);
    if (json.substr(cursor, keys[index].size()) != keys[index]) return false;
    cursor += keys[index].size();
    skipWhitespace(json, cursor);
    if (cursor >= json.size() || json[cursor++] != ':') return false;
    skipWhitespace(json, cursor);
    if (!consumeValue(json, cursor)) return false;
    skipWhitespace(json, cursor);
    const char delimiter = index + 1U == keys.size() ? '}' : ',';
    if (cursor >= json.size() || json[cursor++] != delimiter) return false;
  }
  skipWhitespace(json, cursor);
  return cursor == json.size();
}

void appendJsonString(std::string_view value, std::string& output) {
  static constexpr char hex[] = "0123456789abcdef";
  output.push_back('"');
  for (const unsigned char byte : value) {
    switch (byte) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (byte < 0x20U) {
          output += "\\u00";
          output.push_back(hex[byte >> 4U]);
          output.push_back(hex[byte & 0x0fU]);
        } else {
          output.push_back(static_cast<char>(byte));
        }
    }
  }
  output.push_back('"');
}

std::string canonicalJson(const DeviceConfig& config) {
  std::string output = "{\"v\":1,\"s\":";
  appendJsonString(config.ssid, output);
  output += ",\"p\":";
  appendJsonString(config.wifiPassword, output);
  output += ",\"u\":";
  appendJsonString(config.baseUrl, output);
  output += ",\"t\":";
  appendJsonString(config.terminalToken, output);
  output.push_back('}');
  return output;
}

}  // namespace

OjpDecodeResult decodeOjpPayload(std::string_view input,
                                BuildProfile profile) {
  if (input.empty()) return {OjpError::MissingPayload, std::nullopt};
  if (input.size() > kMaxOjpInputBytes) return {OjpError::TooLarge, std::nullopt};
  const std::string_view payload = unwrap(input);
  if (payload.empty()) return {OjpError::MissingPayload, std::nullopt};

  std::vector<uint8_t> decoded;
  if (!decodeBase64Url(payload, decoded)) {
    return {OjpError::InvalidEncoding, std::nullopt};
  }
  if (!validUtf8(decoded)) return {OjpError::InvalidUtf8, std::nullopt};
  const std::string_view json(reinterpret_cast<const char*>(decoded.data()),
                              decoded.size());
  if (!hasCanonicalKeySequence(json)) {
    return {OjpError::InvalidContract, std::nullopt};
  }

  ArduinoJson::JsonDocument document;
  const auto parseError = ArduinoJson::deserializeJson(
      document, json.data(), json.size(),
      ArduinoJson::DeserializationOption::NestingLimit(1));
  if (parseError || !document.is<ArduinoJson::JsonObjectConst>()) {
    return {OjpError::InvalidContract, std::nullopt};
  }
  const auto object = document.as<ArduinoJson::JsonObjectConst>();
  if (object.size() != 5 || !object["v"].is<uint8_t>() ||
      object["v"].as<uint8_t>() != 1 || !object["s"].is<const char*>() ||
      !object["p"].is<const char*>() || !object["u"].is<const char*>() ||
      !object["t"].is<const char*>()) {
    return {OjpError::InvalidContract, std::nullopt};
  }

  DeviceConfig config;
  config.ssid = object["s"].as<const char*>();
  config.wifiPassword = object["p"].as<const char*>();
  config.baseUrl = object["u"].as<const char*>();
  config.terminalToken = object["t"].as<const char*>();
  if (canonicalJson(config) != json) {
    return {OjpError::InvalidContract, std::nullopt};
  }
  if (validateDeviceConfig(config, profile) != ConfigError::None) {
    return {OjpError::InvalidConfig, std::nullopt};
  }
  return {OjpError::None, std::move(config)};
}

}  // namespace openjornada
