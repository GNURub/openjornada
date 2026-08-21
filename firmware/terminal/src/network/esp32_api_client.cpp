#include "openjornada/api_client.hpp"

#ifdef ARDUINO

#include <Arduino.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cerrno>
#include <string>
#include <string_view>

#include <lwip/dns.h>
#include <sys/socket.h>

#include "openjornada/config.hpp"
#include "openjornada/http_response_reader.hpp"

extern "C" const uint8_t openjornada_ca_bundle[]
    asm("_binary_x509_crt_bundle_start");

namespace openjornada {
namespace {

constexpr std::string_view kApiPrefix = "/api/openjornada/terminal/v1";

struct HttpResponse {
  int status = 0;
  std::string body;
};

struct ParsedUrl {
  bool secure = false;
  std::string host;
  std::string authority;
  std::string targetPrefix;
  uint16_t port = 0;
};

enum class ResolveStatus { Ok, Timeout, Failed };

struct DnsContext {
  explicit DnsContext(std::string_view requestedHost) : host(requestedHost) {}
  std::atomic<uint8_t> references{2};
  std::atomic<bool> complete{false};
  std::string host;
  uint32_t address = 0;
};

void releaseDnsContext(DnsContext* context) {
  if (context->references.fetch_sub(1, std::memory_order_acq_rel) == 1U) {
    delete context;
  }
}

void dnsResolved(const char*, const ip_addr_t* address, void* rawContext) {
  auto* context = static_cast<DnsContext*>(rawContext);
  if (address != nullptr) context->address = address->u_addr.ip4.addr;
  context->complete.store(true, std::memory_order_release);
  releaseDnsContext(context);
}

ResolveStatus resolveHost(std::string_view host,
                          const RequestDeadline& deadline,
                          IPAddress& output) {
  std::string hostCopy(host);
  if (output.fromString(hostCopy.c_str())) return ResolveStatus::Ok;

  auto* context = new (std::nothrow) DnsContext(host);
  if (context == nullptr) return ResolveStatus::Failed;
  ip_addr_t immediate{};
  const err_t started = dns_gethostbyname(context->host.c_str(), &immediate,
                                          dnsResolved, context);
  if (started == ERR_OK) {
    context->address = immediate.u_addr.ip4.addr;
    context->complete.store(true, std::memory_order_release);
    // No callback will own the resolver reference for a synchronous hit.
    releaseDnsContext(context);
  } else if (started != ERR_INPROGRESS) {
    context->complete.store(true, std::memory_order_release);
    releaseDnsContext(context);
  }

  while (!context->complete.load(std::memory_order_acquire) &&
         !deadline.expired(millis())) {
    delay(1);
  }
  if (!context->complete.load(std::memory_order_acquire)) {
    // The resolver callback retains its reference and cleans up after lwIP's
    // own finite DNS attempt completes; it never points into request storage.
    releaseDnsContext(context);
    return ResolveStatus::Timeout;
  }
  const uint32_t address = context->address;
  releaseDnsContext(context);
  if (address == 0U) return ResolveStatus::Failed;
  output = IPAddress(address);
  return ResolveStatus::Ok;
}

ApiCallResult failure(ApiErrorCode code, int httpStatus = 0,
                      bool retryable = false) {
  ApiCallResult result;
  result.ok = false;
  result.failure.code = code;
  result.failure.httpStatus = httpStatus;
  result.failure.retryable = retryable;
  result.failure.safeMessage = safeApiErrorMessage(code);
  return result;
}

bool safeHeader(std::string_view value, size_t maximum,
                std::string_view prefix = {}) {
  if (value.empty() || value.size() > maximum ||
      (!prefix.empty() && value.rfind(prefix, 0) != 0)) {
    return false;
  }
  return std::none_of(value.begin(), value.end(), [](unsigned char byte) {
    return byte <= 0x20U || byte >= 0x7FU;
  });
}

bool safePathSegment(std::string_view value) {
  if (value.empty() || value.size() > 64) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char byte) {
    return std::isalnum(byte) || byte == '-' || byte == '_';
  });
}

bool parseValidatedBaseUrl(std::string_view baseUrl, ParsedUrl& output) {
  ParsedUrl candidate;
  const size_t authorityStart =
      baseUrl.rfind("https://", 0) == 0 ? 8U : 7U;
  candidate.secure = authorityStart == 8U;
  const size_t pathStart = baseUrl.find('/', authorityStart);
  const std::string_view authority = baseUrl.substr(
      authorityStart, pathStart == std::string_view::npos
                          ? std::string_view::npos
                          : pathStart - authorityStart);
  const size_t colon = authority.find(':');
  const std::string_view host = authority.substr(0, colon);
  uint32_t port = candidate.secure ? 443U : 80U;
  if (colon != std::string_view::npos) {
    port = 0;
    for (const unsigned char byte : authority.substr(colon + 1U)) {
      if (!std::isdigit(byte)) return false;
      port = port * 10U + static_cast<uint32_t>(byte - '0');
    }
  }
  if (host.empty() || port == 0U || port > 65535U) return false;
  candidate.host.assign(host);
  candidate.authority.assign(authority);
  if (pathStart != std::string_view::npos) {
    candidate.targetPrefix.assign(baseUrl.substr(pathStart));
    while (!candidate.targetPrefix.empty() &&
           candidate.targetPrefix.back() == '/') {
      candidate.targetPrefix.pop_back();
    }
  }
  candidate.targetPrefix.append(kApiPrefix);
  candidate.port = static_cast<uint16_t>(port);
  output = std::move(candidate);
  return true;
}

bool writeAll(WiFiClient& transport, bool secure, std::string_view bytes,
              const RequestDeadline& deadline) {
  size_t sent = 0;
  while (sent < bytes.size()) {
    const uint32_t remaining = deadline.remaining(millis());
    // This Arduino core exposes socket timeouts in whole seconds. Refuse to
    // begin a potentially blocking write with less than one second left, and
    // round down so the socket timeout cannot outlive the absolute deadline.
    if (remaining < 1000U) return false;
    int written = 0;
    if (secure) {
      transport.setTimeout(remaining / 1000U);
      written = static_cast<int>(transport.write(
          reinterpret_cast<const uint8_t*>(bytes.data() + sent),
          bytes.size() - sent));
    } else {
      // WiFiClient::write retries with its own rolling select timeout. Direct
      // non-blocking send keeps plain-development HTTP under our one deadline.
      written = static_cast<int>(send(
          transport.fd(), bytes.data() + sent, bytes.size() - sent,
          MSG_DONTWAIT));
      if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) written = 0;
      else if (written < 0) return false;
    }
    if (written == 0) {
      if (!transport.connected()) return false;
      delay(1);
      continue;
    }
    sent += static_cast<size_t>(written);
  }
  return !deadline.expired(millis());
}

HttpParseStatus readResponse(WiFiClient& transport,
                             const RequestDeadline& deadline,
                             BoundedHttpResponseParser& parser) {
  while (!deadline.expired(millis())) {
    int available = transport.available();
    while (available-- > 0) {
      if (deadline.expired(millis())) return HttpParseStatus::NeedMore;
      const int byte = transport.read();
      if (byte < 0) break;
      const HttpParseStatus status = parser.consume(static_cast<char>(byte));
      if (status != HttpParseStatus::NeedMore) return status;
    }
    if (!transport.connected()) return parser.finishOnDisconnect();
    delay(1);
  }
  return HttpParseStatus::NeedMore;
}

ApiCallResult request(BuildProfile profile, const ApiCredentials& credentials,
                      const char* method, std::string_view path,
                      std::string_view payload, std::string_view adminSession,
                      uint32_t timeoutMs, size_t maxResponseBytes,
                      HttpResponse& response) {
  if (!validateBaseUrl(credentials.baseUrl, profile).allowed) {
    return failure(ApiErrorCode::UnsupportedScheme);
  }
  if (!safeHeader(credentials.terminalToken, kMaxTerminalTokenBytes,
                  "ojterm_") ||
      (!adminSession.empty() &&
       !safeHeader(adminSession, 96, "ojtadmin_")) ||
      timeoutMs == 0 || timeoutMs > 30000U ||
      payload.size() > ApiCodec::kMaxRequestBytes || maxResponseBytes == 0U ||
      maxResponseBytes > ApiCodec::kMaxSyncResponseBytes) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  const RequestDeadline deadline(millis(), timeoutMs);

  ParsedUrl url;
  if (!parseValidatedBaseUrl(credentials.baseUrl, url)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  const bool secure = url.secure;
#if !defined(OPENJORNADA_DEVELOPMENT) || !OPENJORNADA_DEVELOPMENT
  // This compile-time gate prevents a caller from re-enabling plain HTTP by
  // accidentally constructing the release client with a development profile.
  if (!secure) return failure(ApiErrorCode::UnsupportedScheme);
#else
  if (!secure && profile != BuildProfile::Development) {
    return failure(ApiErrorCode::UnsupportedScheme);
  }
#endif

  std::string target = url.targetPrefix;
  target.append(path);
  if (target.empty() || target.front() != '/' ||
      target.size() > kMaxBaseUrlBytes + kApiPrefix.size() + 128U) {
    return failure(ApiErrorCode::InvalidResponse);
  }

  WiFiClientSecure secureClient;
  WiFiClient* transport = &secureClient;
#if defined(OPENJORNADA_DEVELOPMENT) && OPENJORNADA_DEVELOPMENT
  WiFiClient plainClient;
  if (!secure) transport = &plainClient;
#endif
  if (secure) {
    secureClient.setCACertBundle(openjornada_ca_bundle);
  }

  IPAddress resolvedAddress;
  const ResolveStatus resolved = resolveHost(url.host, deadline, resolvedAddress);
  if (resolved != ResolveStatus::Ok) {
    transport->stop();
    return failure(resolved == ResolveStatus::Timeout ? ApiErrorCode::Timeout
                                                      : ApiErrorCode::Transport,
                   0, true);
  }
  const uint32_t connectBudget = deadline.remaining(millis());
  bool connected = false;
  if (secure) {
    // Arduino's secure connect applies separate rolling waits to TCP connect
    // and TLS handshake. Give each at most half the remaining budget (with
    // headroom for certificate setup) so their sum cannot exceed our request
    // deadline even though the framework does not expose one combined timer.
    if (connectBudget >= 2500U) {
      const uint32_t phaseSeconds = (connectBudget - 500U) / 2000U;
      secureClient.setTimeout(phaseSeconds);
      secureClient.setHandshakeTimeout(phaseSeconds);
      connected = secureClient.connect(resolvedAddress, url.port,
                                       url.host.c_str(), nullptr, nullptr,
                                       nullptr);
    }
  } else {
#if defined(OPENJORNADA_DEVELOPMENT) && OPENJORNADA_DEVELOPMENT
    connected = connectBudget > 0U &&
                plainClient.connect(resolvedAddress, url.port, connectBudget);
#endif
  }
  if (!connected) {
    const bool timedOut = deadline.expired(millis()) ||
                          (secure && connectBudget < 2500U);
    transport->stop();
    return failure(timedOut ? ApiErrorCode::Timeout : ApiErrorCode::Transport,
                   0, true);
  }
  if (deadline.expired(millis())) {
    transport->stop();
    return failure(ApiErrorCode::Timeout, 0, true);
  }

  std::string headers;
  headers.reserve(512U + credentials.terminalToken.size() +
                  adminSession.size());
  headers.append(method);
  headers.push_back(' ');
  headers.append(target);
  headers.append(" HTTP/1.1\r\nHost: ");
  headers.append(url.authority);
  headers.append("\r\nUser-Agent: OpenJornada-M5/1.0\r\n"
                 "Accept: application/json\r\n"
                 "Content-Type: application/json\r\n"
                 "Authorization: Bearer ");
  headers.append(credentials.terminalToken);
  if (!adminSession.empty()) {
    headers.append("\r\nX-Terminal-Admin-Session: ");
    headers.append(adminSession);
  }
  headers.append("\r\nContent-Length: ");
  headers.append(std::to_string(payload.size()));
  headers.append("\r\nConnection: close\r\n\r\n");
  if (!writeAll(*transport, secure, headers, deadline) ||
      (!payload.empty() &&
       !writeAll(*transport, secure, payload, deadline))) {
    const bool timedOut = deadline.expired(millis());
    transport->stop();
    return failure(timedOut ? ApiErrorCode::Timeout : ApiErrorCode::Transport,
                   0, true);
  }

  BoundedHttpResponseParser parser(maxResponseBytes);
  const HttpParseStatus parseStatus = readResponse(*transport, deadline, parser);
  const bool timedOut = deadline.expired(millis());
  transport->stop();
  if (parseStatus != HttpParseStatus::Complete) {
    return failure(timedOut ? ApiErrorCode::Timeout
                            : ApiErrorCode::InvalidResponse,
                   parser.response().status, timedOut);
  }

  response.status = parser.response().status;
  response.body = parser.response().body;
  if (response.status < 200 || response.status >= 300) {
    ApiCallResult result;
    result.ok = false;
    if (!ApiCodec::decodeError(response.body, response.status,
                               result.failure)) {
      result.failure.code = ApiErrorCode::HttpFailure;
      result.failure.httpStatus = response.status;
      result.failure.retryable = response.status == 408 ||
                                 response.status == 429 ||
                                 response.status >= 500;
      result.failure.safeMessage =
          safeApiErrorMessage(ApiErrorCode::HttpFailure);
    }
    return result;
  }
  return {};
}

template <typename Output, typename Decoder>
ApiCallResult decodeSuccess(ApiCallResult call, const HttpResponse& response,
                            Output& output, Decoder decoder) {
  if (!call.ok) return call;
  ApiFailure parseFailure;
  if (!decoder(response.body, output, parseFailure)) {
    call.ok = false;
    call.failure = std::move(parseFailure);
    call.failure.httpStatus = response.status;
  }
  return call;
}

}  // namespace

ApiCallResult Esp32ApiClient::bootstrap(const ApiCredentials& credentials,
                                        const BootstrapRequest& requestBody,
                                        BootstrapResponse& output,
                                        uint32_t timeoutMs) {
  std::string payload;
  if (!ApiCodec::encodeBootstrap(requestBody, payload)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  HttpResponse response;
  auto call = request(profile_, credentials, "POST", "/bootstrap", payload,
                      {}, timeoutMs, ApiCodec::kMaxBootstrapResponseBytes,
                      response);
  return decodeSuccess(call, response, output, ApiCodec::decodeBootstrap);
}

ApiCallResult Esp32ApiClient::resolve(const ApiCredentials& credentials,
                                      const std::string& uid,
                                      ResolveResponse& output,
                                      uint32_t timeoutMs) {
  std::string payload;
  if (!ApiCodec::encodeResolveUid(uid, payload)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  HttpResponse response;
  auto call = request(profile_, credentials, "POST", "/resolve", payload, {},
                      timeoutMs, ApiCodec::kMaxResolveResponseBytes, response);
  return decodeSuccess(call, response, output, ApiCodec::decodeResolve);
}

ApiCallResult Esp32ApiClient::action(const ApiCredentials& credentials,
                                     const ActionRequest& requestBody,
                                     ActionResult& output,
                                     uint32_t timeoutMs) {
  std::string payload;
  if (!ApiCodec::encodeAction(requestBody, payload)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  HttpResponse response;
  auto call = request(profile_, credentials, "POST", "/actions", payload, {},
                      timeoutMs, ApiCodec::kMaxActionResponseBytes, response);
  return decodeSuccess(call, response, output, ApiCodec::decodeActionResult);
}

ApiCallResult Esp32ApiClient::cache(const ApiCredentials& credentials,
                                    uint32_t revision, CacheResponse& output,
                                    uint32_t timeoutMs) {
  const std::string path = "/cache?revision=" + std::to_string(revision);
  HttpResponse response;
  auto call = request(profile_, credentials, "GET", path, {}, {}, timeoutMs,
                      ApiCodec::kMaxCacheResponseBytes, response);
  return decodeSuccess(call, response, output, ApiCodec::decodeCache);
}

ApiCallResult Esp32ApiClient::openAdminSession(
    const ApiCredentials& credentials, const std::string& pin,
    AdminSessionResponse& output, uint32_t timeoutMs) {
  std::string payload;
  if (!ApiCodec::encodeAdminPin(pin, payload)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  HttpResponse response;
  auto call = request(profile_, credentials, "POST", "/admin-sessions",
                      payload, {}, timeoutMs,
                      ApiCodec::kMaxAdminResponseBytes, response);
  return decodeSuccess(call, response, output, ApiCodec::decodeAdminSession);
}

ApiCallResult Esp32ApiClient::closeAdminSession(
    const ApiCredentials& credentials, const std::string& adminSession,
    uint32_t timeoutMs) {
  HttpResponse response;
  return request(profile_, credentials, "DELETE", "/admin-sessions/current",
                 {}, adminSession, timeoutMs, ApiCodec::kMaxAdminResponseBytes,
                 response);
}

ApiCallResult Esp32ApiClient::employees(const ApiCredentials& credentials,
                                        const std::string& adminSession,
                                        EmployeeListResponse& output,
                                        uint32_t timeoutMs) {
  HttpResponse response;
  auto call = request(profile_, credentials, "GET", "/employees", {},
                      adminSession, timeoutMs,
                      ApiCodec::kMaxEmployeeResponseBytes, response);
  return decodeSuccess(call, response, output, ApiCodec::decodeEmployees);
}

ApiCallResult Esp32ApiClient::assignEmployee(
    const ApiCredentials& credentials, const std::string& adminSession,
    const std::string& employeeId, const std::string& uid, bool replace,
    uint32_t timeoutMs) {
  if (!safePathSegment(employeeId)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  std::string payload;
  if (!ApiCodec::encodeAssignEmployee(uid, replace, payload)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  HttpResponse response;
  const std::string path = "/employees/" + employeeId + "/rfid";
  return request(profile_, credentials, "PUT", path, payload, adminSession,
                 timeoutMs, ApiCodec::kMaxAdminResponseBytes, response);
}

ApiCallResult Esp32ApiClient::revokeEmployee(
    const ApiCredentials& credentials, const std::string& adminSession,
    const std::string& employeeId, uint32_t timeoutMs) {
  if (!safePathSegment(employeeId)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  HttpResponse response;
  const std::string path = "/employees/" + employeeId + "/rfid";
  return request(profile_, credentials, "DELETE", path, {}, adminSession,
                 timeoutMs, ApiCodec::kMaxAdminResponseBytes, response);
}

ApiCallResult Esp32ApiClient::sync(const ApiCredentials& credentials,
                                   const SyncRequest& requestBody,
                                   SyncResponse& output,
                                   uint32_t timeoutMs) {
  std::string payload;
  if (!ApiCodec::encodeSync(requestBody, payload)) {
    return failure(ApiErrorCode::InvalidResponse);
  }
  HttpResponse response;
  auto call = request(profile_, credentials, "POST", "/sync", payload, {},
                      timeoutMs, ApiCodec::kMaxSyncResponseBytes, response);
  return decodeSuccess(call, response, output, ApiCodec::decodeSync);
}

}  // namespace openjornada

#endif
