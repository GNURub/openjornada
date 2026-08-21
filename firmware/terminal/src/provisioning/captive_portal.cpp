#include "openjornada/provisioning.hpp"

#include <algorithm>
#include <cctype>
#include <limits>
#include <string_view>
#include <utility>

#ifdef ARDUINO
#include <Arduino.h>
#include <DNSServer.h>
#include <M5Unified.h>
#include <WiFi.h>
#include <esp_system.h>

#include <cstdint>
#include <cstdlib>
#endif

namespace openjornada {
namespace {

std::string asciiLower(std::string_view value) {
  std::string output;
  output.reserve(value.size());
  for (const unsigned char byte : value) {
    output.push_back(static_cast<char>(std::tolower(byte)));
  }
  return output;
}

std::string_view trimOws(std::string_view value) {
  while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) {
    value.remove_prefix(1);
  }
  while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) {
    value.remove_suffix(1);
  }
  return value;
}

bool validHeaderName(std::string_view name) {
  if (name.empty()) return false;
  for (const unsigned char byte : name) {
    if (!(std::isalnum(byte) || byte == '-' || byte == '_')) return false;
  }
  return true;
}

bool parseContentLength(std::string_view raw, size_t& output) {
  if (raw.empty()) return false;
  size_t value = 0;
  for (const unsigned char byte : raw) {
    if (!std::isdigit(byte)) return false;
    const size_t digit = static_cast<size_t>(byte - '0');
    if (value > (std::numeric_limits<size_t>::max() - digit) / 10U) {
      return false;
    }
    value = value * 10U + digit;
  }
  output = value;
  return true;
}

int hexDigit(char byte) {
  if (byte >= '0' && byte <= '9') return byte - '0';
  if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
  if (byte >= 'A' && byte <= 'F') return byte - 'A' + 10;
  return -1;
}

bool urlDecode(std::string_view encoded, size_t maximum,
               std::string& output) {
  output.clear();
  output.reserve(std::min(encoded.size(), maximum));
  for (size_t index = 0; index < encoded.size(); ++index) {
    unsigned char byte = static_cast<unsigned char>(encoded[index]);
    if (byte == '+') {
      byte = ' ';
    } else if (byte == '%') {
      if (index + 2 >= encoded.size()) return false;
      const int high = hexDigit(encoded[index + 1]);
      const int low = hexDigit(encoded[index + 2]);
      if (high < 0 || low < 0) return false;
      byte = static_cast<unsigned char>((high << 4) | low);
      index += 2;
    }
    if (byte == 0 || byte == '\r' || byte == '\n' ||
        output.size() >= maximum) {
      return false;
    }
    output.push_back(static_cast<char>(byte));
  }
  return true;
}

}  // namespace

CaptiveHttpParseStatus BoundedCaptiveHttpParser::consume(char byte) {
  if (status_ != CaptiveHttpParseStatus::NeedMore) return status_;

  if (readingBody_) {
    if (bodyBytesConsumed_ >= contentLength_) {
      return status_ = CaptiveHttpParseStatus::Invalid;
    }
    request_.body.push_back(byte);
    ++bodyBytesConsumed_;
    if (bodyBytesConsumed_ == contentLength_) {
      status_ = CaptiveHttpParseStatus::Complete;
    }
    return status_;
  }

  if (headers_.size() >= kMaxProvisioningHeaderBytes) {
    return status_ = CaptiveHttpParseStatus::HeaderTooLarge;
  }
  headers_.push_back(byte);
  const size_t size = headers_.size();
  if (size >= 4 && headers_[size - 4] == '\r' &&
      headers_[size - 3] == '\n' && headers_[size - 2] == '\r' &&
      headers_[size - 1] == '\n') {
    status_ = parseHeaders();
  }
  return status_;
}

CaptiveHttpParseStatus BoundedCaptiveHttpParser::status() const {
  return status_;
}

const CaptiveHttpRequest& BoundedCaptiveHttpParser::request() const {
  return request_;
}

size_t BoundedCaptiveHttpParser::bodyBytesConsumed() const {
  return bodyBytesConsumed_;
}

CaptiveHttpParseStatus BoundedCaptiveHttpParser::parseHeaders() {
  const size_t requestLineEnd = headers_.find("\r\n");
  if (requestLineEnd == std::string::npos) {
    return CaptiveHttpParseStatus::Invalid;
  }
  const std::string_view requestLine(headers_.data(), requestLineEnd);
  const size_t firstSpace = requestLine.find(' ');
  const size_t secondSpace = firstSpace == std::string_view::npos
                                 ? std::string_view::npos
                                 : requestLine.find(' ', firstSpace + 1);
  if (firstSpace == std::string_view::npos ||
      secondSpace == std::string_view::npos ||
      requestLine.find(' ', secondSpace + 1) != std::string_view::npos) {
    return CaptiveHttpParseStatus::Invalid;
  }
  const std::string_view method = requestLine.substr(0, firstSpace);
  const std::string_view target =
      requestLine.substr(firstSpace + 1, secondSpace - firstSpace - 1);
  const std::string_view version = requestLine.substr(secondSpace + 1);
  if ((method != "GET" && method != "POST") || target.empty() ||
      target.size() > kMaxProvisioningRequestTargetBytes ||
      target.front() != '/' ||
      (version != "HTTP/1.1" && version != "HTTP/1.0")) {
    return CaptiveHttpParseStatus::Invalid;
  }
  request_.method.assign(method);
  request_.target.assign(target);

  bool contentLengthSeen = false;
  bool hostSeen = false;
  bool originSeen = false;
  bool contentTypeSeen = false;
  size_t cursor = requestLineEnd + 2;
  while (cursor < headers_.size()) {
    const size_t lineEnd = headers_.find("\r\n", cursor);
    if (lineEnd == std::string::npos) return CaptiveHttpParseStatus::Invalid;
    if (lineEnd == cursor) break;
    const std::string_view line(headers_.data() + cursor, lineEnd - cursor);
    const size_t colon = line.find(':');
    if (colon == std::string_view::npos) {
      return CaptiveHttpParseStatus::Invalid;
    }
    const std::string_view rawName = line.substr(0, colon);
    if (!validHeaderName(rawName)) return CaptiveHttpParseStatus::Invalid;
    const std::string name = asciiLower(rawName);
    const std::string_view value = trimOws(line.substr(colon + 1));
    for (const unsigned char valueByte : value) {
      if (valueByte < 0x20U && valueByte != '\t') {
        return CaptiveHttpParseStatus::Invalid;
      }
    }
    if (name == "content-length") {
      if (contentLengthSeen || !parseContentLength(value, contentLength_)) {
        return CaptiveHttpParseStatus::Invalid;
      }
      contentLengthSeen = true;
    } else if (name == "transfer-encoding") {
      return CaptiveHttpParseStatus::Invalid;
    } else if (name == "host") {
      if (hostSeen) return CaptiveHttpParseStatus::Invalid;
      request_.host.assign(value);
      hostSeen = true;
    } else if (name == "origin") {
      if (originSeen) return CaptiveHttpParseStatus::Invalid;
      request_.origin.assign(value);
      originSeen = true;
    } else if (name == "content-type") {
      if (contentTypeSeen) return CaptiveHttpParseStatus::Invalid;
      request_.contentType.assign(value);
      contentTypeSeen = true;
    }
    cursor = lineEnd + 2;
  }

  if (contentLength_ > kMaxProvisioningFormBodyBytes) {
    return CaptiveHttpParseStatus::BodyTooLarge;
  }
  if (request_.method == "POST" && !contentLengthSeen) {
    return CaptiveHttpParseStatus::Invalid;
  }
  if (request_.method == "GET" && contentLength_ != 0) {
    return CaptiveHttpParseStatus::Invalid;
  }
  if (contentLength_ == 0) return CaptiveHttpParseStatus::Complete;
  request_.body.reserve(contentLength_);
  readingBody_ = true;
  return CaptiveHttpParseStatus::NeedMore;
}

bool decodeProvisioningForm(const std::string& body,
                            ProvisioningFormFields& output) {
  output = {};
  bool csrf = false;
  bool ssid = false;
  bool password = false;
  bool baseUrl = false;
  bool token = false;
  size_t fields = 0;
  size_t cursor = 0;
  while (cursor <= body.size()) {
    const size_t ampersand = body.find('&', cursor);
    const size_t end =
        ampersand == std::string::npos ? body.size() : ampersand;
    if (end == cursor) return false;
    const std::string_view pair(body.data() + cursor, end - cursor);
    const size_t equals = pair.find('=');
    if (equals == std::string_view::npos) return false;
    std::string name;
    if (!urlDecode(pair.substr(0, equals), 32, name)) return false;
    const std::string_view value = pair.substr(equals + 1);
    if (name == "csrf" && !csrf) {
      if (!urlDecode(value, 32, output.csrf)) return false;
      csrf = true;
    } else if (name == "ssid" && !ssid) {
      if (!urlDecode(value, kMaxSsidBytes, output.ssid)) return false;
      ssid = true;
    } else if (name == "wifi_password" && !password) {
      if (!urlDecode(value, kMaxWifiPasswordBytes, output.wifiPassword)) {
        return false;
      }
      password = true;
    } else if (name == "base_url" && !baseUrl) {
      if (!urlDecode(value, kMaxBaseUrlBytes, output.baseUrl)) return false;
      baseUrl = true;
    } else if (name == "terminal_token" && !token) {
      if (!urlDecode(value, kMaxTerminalTokenBytes, output.terminalToken)) {
        return false;
      }
      token = true;
    } else {
      return false;
    }
    ++fields;
    if (ampersand == std::string::npos) break;
    cursor = ampersand + 1;
  }
  return fields == 5 && csrf && ssid && password && baseUrl && token;
}

bool decodeProvisioningFormRequest(const CaptiveHttpRequest& request,
                                   const std::string& expectedCsrf,
                                   ProvisioningFormFields& output) {
  const std::string contentType = asciiLower(trimOws(request.contentType));
  if (request.method != "POST" || request.target != "/save" ||
      (request.host != "192.168.4.1" &&
       request.host != "192.168.4.1:80" &&
       request.host != "openjornada.local" &&
       request.host != "openjornada.local:80") ||
      (!request.origin.empty() &&
       request.origin != "http://192.168.4.1") ||
      (contentType != "application/x-www-form-urlencoded" &&
       contentType !=
           "application/x-www-form-urlencoded; charset=utf-8") ||
      !decodeProvisioningForm(request.body, output) ||
      output.csrf != expectedCsrf) {
    output = {};
    return false;
  }
  return true;
}

bool canApplyProvisioningCandidate(
    const std::optional<DeviceConfig>& activeConfig,
    const DeviceConfig& candidate, size_t pendingCount) {
  return pendingCount == 0 ||
         (activeConfig.has_value() &&
          activeConfig->terminalToken == candidate.terminalToken);
}

ProvisioningPortal::ProvisioningPortal(
    ConfigStore& store, BuildProfile profile,
    std::optional<DeviceConfig> activeConfig, size_t pendingCount)
    : store_(store),
      profile_(profile),
      activeConfig_(std::move(activeConfig)),
      pendingCount_(pendingCount) {}

#ifndef ARDUINO

ProvisioningResult ProvisioningPortal::run(
    const CandidateValidator& candidateValidator) {
  (void)candidateValidator;
  return {false, {}, "El portal cautivo solo está disponible en el terminal."};
}

#else

namespace {

const IPAddress kPortalIp{192, 168, 4, 1};
const IPAddress kPortalMask{255, 255, 255, 0};
constexpr uint16_t kDnsPort = 53;
constexpr uint32_t kConnectTimeoutMs = 20000;
constexpr uint32_t kRequestTimeoutMs = 2000;
constexpr uint32_t kIdleTimeoutMs = 10U * 60U * 1000U;
constexpr char kRandomAlphabet[] =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

std::string randomText(size_t length) {
  constexpr uint32_t alphabetSize = sizeof(kRandomAlphabet) - 1;
  const uint32_t threshold = static_cast<uint32_t>(-alphabetSize) % alphabetSize;
  std::string output;
  output.reserve(length);
  while (output.size() < length) {
    const uint32_t sample = esp_random();
    if (sample < threshold) continue;
    output.push_back(kRandomAlphabet[sample % alphabetSize]);
  }
  return output;
}

std::string portalSsid() {
  const uint64_t chip = ESP.getEfuseMac();
  char suffix[5]{};
  snprintf(suffix, sizeof(suffix), "%04X",
           static_cast<unsigned>(chip & 0xFFFFU));
  return std::string("OpenJornada-") + suffix;
}

std::string fromArduinoString(const String& value) {
  return std::string(value.c_str(), value.length());
}

String htmlEscape(const std::string& value) {
  String output;
  output.reserve(value.size() + 16);
  for (const char byte : value) {
    switch (byte) {
      case '&':
        output += F("&amp;");
        break;
      case '<':
        output += F("&lt;");
        break;
      case '>':
        output += F("&gt;");
        break;
      case '"':
        output += F("&quot;");
        break;
      case '\'':
        output += F("&#39;");
        break;
      default:
        output += byte;
        break;
    }
  }
  return output;
}

String validationMessage(ConfigError error) {
  switch (error) {
    case ConfigError::EmptySsid:
      return F("Selecciona una red Wi-Fi.");
    case ConfigError::SsidTooLong:
      return F("El nombre de la red es demasiado largo.");
    case ConfigError::WifiPasswordTooLong:
      return F("La contraseña Wi-Fi es demasiado larga.");
    case ConfigError::BaseUrlTooLong:
      return F("La URL de OpenJornada es demasiado larga.");
    case ConfigError::InvalidBaseUrl:
      return F("La URL no está permitida para esta versión del terminal.");
    case ConfigError::InvalidTerminalToken:
      return F("La API key debe empezar por ojterm_.");
    case ConfigError::TerminalTokenTooLong:
      return F("La API key es demasiado larga.");
    case ConfigError::InvalidText:
      return F("Los campos contienen caracteres no permitidos.");
    case ConfigError::Storage:
      return F("No se pudo guardar la configuración.");
    case ConfigError::None:
      return {};
  }
  return F("La configuración no es válida.");
}

std::string safeBootstrapError(const DeviceConfig& candidate,
                               const std::string& error) {
  if (error.empty() || error.size() > 180 ||
      (!candidate.terminalToken.empty() &&
       error.find(candidate.terminalToken) != std::string::npos) ||
      (!candidate.wifiPassword.empty() &&
       error.find(candidate.wifiPassword) != std::string::npos)) {
    return "El servidor no aceptó este terminal.";
  }
  for (const unsigned char byte : error) {
    if (byte < 0x20U || byte == 0x7FU) {
      return "El servidor no aceptó este terminal.";
    }
  }
  return error;
}

bool remoteFromPortal(const IPAddress& remote) {
  if (remote[0] != kPortalIp[0] || remote[1] != kPortalIp[1] ||
      remote[2] != kPortalIp[2]) {
    return false;
  }
  return true;
}

const char* reasonPhrase(int status) {
  switch (status) {
    case 200:
      return "OK";
    case 302:
      return "Found";
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 408:
      return "Request Timeout";
    case 409:
      return "Conflict";
    case 413:
      return "Payload Too Large";
    case 431:
      return "Request Header Fields Too Large";
    case 500:
      return "Internal Server Error";
    default:
      return "Error";
  }
}

String portalPage(const std::string& csrf,
                  const std::optional<DeviceConfig>& active,
                  const String& error) {
  const std::string ssid = active.has_value() ? active->ssid : std::string{};
  const std::string baseUrl =
      active.has_value() ? active->baseUrl : std::string{};
  String page;
  page.reserve(4200);
  page += F(
      "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
      "<title>Configurar OpenJornada</title><style>"
      ":root{font-family:system-ui,sans-serif;color:#1c1917;background:#fafaf9}"
      "body{margin:0;padding:24px 16px}main{max-width:520px;margin:auto}"
      "h1{font-size:1.7rem;margin:.2rem 0}p{line-height:1.45;color:#57534e}"
      "form{background:white;border:1px solid #e7e5e4;border-radius:18px;"
      "padding:20px;box-shadow:0 8px 28px #1c191712}label{display:block;"
      "font-weight:650;margin-top:16px}input{box-sizing:border-box;width:100%;"
      "font:inherit;margin-top:7px;padding:12px;border:1px solid #a8a29e;"
      "border-radius:10px}input:focus{outline:3px solid #fdba7466;"
      "border-color:#ea580c}button{width:100%;margin-top:22px;padding:13px;"
      "border:0;border-radius:12px;background:#f04b32;color:white;font:"
      "700 1rem system-ui}.error{padding:12px;border-radius:10px;"
      "background:#fef2f2;color:#b91c1c}.hint{font-size:.88rem}"
      "</style></head><body><main><p>TERMINAL RFID</p>"
      "<h1>Configurar OpenJornada</h1><p>Conecta el terminal a la red del "
      "negocio. La configuración solo se guardará después de comprobar el "
      "servidor.</p>");
  if (!error.isEmpty()) {
    page += F("<p class=\"error\" role=\"alert\">");
    page += htmlEscape(fromArduinoString(error));
    page += F("</p>");
  }
  page += F("<form method=\"post\" action=\"http://192.168.4.1/save\" "
            "autocomplete=\"off\"><input type=\"hidden\" name=\"csrf\" value=\"");
  page += htmlEscape(csrf);
  page += F("\"><label for=\"ssid\">Red Wi-Fi</label><input id=\"ssid\" "
            "name=\"ssid\" required maxlength=\"");
  page += String(kMaxSsidBytes);
  page += F("\" value=\"");
  page += htmlEscape(ssid);
  page += F("\"><label for=\"wifi_password\">Contraseña Wi-Fi</label>"
            "<input id=\"wifi_password\" name=\"wifi_password\" "
            "type=\"password\" maxlength=\"");
  page += String(kMaxWifiPasswordBytes);
  page += F("\"><p class=\"hint\">Si ya estaba configurado, déjala vacía "
            "para conservarla.</p><label for=\"base_url\">URL de OpenJornada"
            "</label><input id=\"base_url\" name=\"base_url\" type=\"url\" "
            "required inputmode=\"url\" maxlength=\"");
  page += String(kMaxBaseUrlBytes);
  page += F("\" placeholder=\"https://jornada.ejemplo.es\" value=\"");
  page += htmlEscape(baseUrl);
  page += F("\"><label for=\"terminal_token\">API key del terminal</label>"
            "<input id=\"terminal_token\" name=\"terminal_token\" "
            "type=\"password\" maxlength=\"");
  page += String(kMaxTerminalTokenBytes);
  page += F("\"");
  if (!active.has_value()) page += F(" required");
  page += F("><p class=\"hint\">Empieza por ojterm_. Si ya existe, déjala "
            "vacía para conservarla.</p><button type=\"submit\">Comprobar y "
            "guardar</button></form></main></body></html>");
  return page;
}

void sendResponse(WiFiClient& client, int status, const char* contentType,
                  const String& body, const char* location = nullptr) {
  client.print(F("HTTP/1.1 "));
  client.print(status);
  client.print(' ');
  client.print(reasonPhrase(status));
  client.print(F("\r\nContent-Type: "));
  client.print(contentType);
  client.print(F("\r\nContent-Length: "));
  client.print(body.length());
  client.print(F("\r\nConnection: close\r\nCache-Control: no-store, max-age=0"
                 "\r\nPragma: no-cache\r\nX-Content-Type-Options: nosniff"
                 "\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: "
                 "default-src 'none'; style-src 'unsafe-inline'; form-action "
                 "http://192.168.4.1; base-uri 'none'; frame-ancestors 'none'"
                 "\r\n"));
  if (location != nullptr) {
    client.print(F("Location: "));
    client.print(location);
    client.print(F("\r\n"));
  }
  client.print(F("\r\n"));
  client.print(body);
}

void stopPortal(DNSServer& dns, WiFiServer& server, bool keepStation) {
  server.end();
  dns.stop();
  WiFi.softAPdisconnect(true);
  if (!keepStation) {
    WiFi.disconnect(false, false);
    WiFi.mode(WIFI_OFF);
  } else {
    WiFi.mode(WIFI_STA);
  }
}

}  // namespace

ProvisioningResult ProvisioningPortal::run(
    const CandidateValidator& candidateValidator) {
  ProvisioningResult result;
  if (!candidateValidator) {
    result.displayError = "No se puede comprobar el servidor.";
    return result;
  }

  const std::string apSsid = portalSsid();
  const std::string apPassword = randomText(8);
  const std::string csrf = randomText(32);

  WiFi.mode(WIFI_AP_STA);
  if (!WiFi.softAPConfig(kPortalIp, kPortalIp, kPortalMask) ||
      !WiFi.softAP(apSsid.c_str(), apPassword.c_str(), 1, 0, 4)) {
    result.displayError = "No se pudo abrir la red de configuración.";
    drawProvisioningStatus("Configuración", result.displayError, true);
    return result;
  }

  DNSServer dns;
  WiFiServer server(80);
  if (!dns.start(kDnsPort, "*", kPortalIp)) {
    stopPortal(dns, server, false);
    result.displayError = "No se pudo iniciar el portal de configuración.";
    drawProvisioningStatus("Configuración", result.displayError, true);
    return result;
  }

  uint32_t lastActivityMs = millis();
  bool completed = false;
  server.begin();
  drawProvisioningAccess(apSsid, apPassword);
  while (!completed && millis() - lastActivityMs < kIdleTimeoutMs) {
    dns.processNextRequest();
    WiFiClient client = server.available();
    if (client) {
      BoundedCaptiveHttpParser parser;
      const uint32_t requestStartedMs = millis();
      while (parser.status() == CaptiveHttpParseStatus::NeedMore &&
             client.connected() &&
             millis() - requestStartedMs < kRequestTimeoutMs) {
        while (client.available() > 0 &&
               parser.status() == CaptiveHttpParseStatus::NeedMore) {
          const int byte = client.read();
          if (byte < 0) break;
          parser.consume(static_cast<char>(byte));
        }
        dns.processNextRequest();
        M5.update();
        delay(2);
      }

      const CaptiveHttpParseStatus parseStatus = parser.status();
      if (parseStatus == CaptiveHttpParseStatus::NeedMore) {
        sendResponse(client, 408, "text/plain; charset=utf-8",
                     "La solicitud tardó demasiado.");
      } else if (parseStatus == CaptiveHttpParseStatus::HeaderTooLarge) {
        sendResponse(client, 431, "text/plain; charset=utf-8",
                     "Las cabeceras son demasiado grandes.");
      } else if (parseStatus == CaptiveHttpParseStatus::BodyTooLarge) {
        sendResponse(client, 413, "text/plain; charset=utf-8",
                     "El formulario es demasiado grande.");
      } else if (parseStatus == CaptiveHttpParseStatus::Invalid) {
        sendResponse(client, 400, "text/plain; charset=utf-8",
                     "La solicitud no es válida.");
      } else {
        const CaptiveHttpRequest& request = parser.request();
        if (request.method == "GET" && request.target == "/") {
          lastActivityMs = millis();
          sendResponse(client, 200, "text/html; charset=utf-8",
                       portalPage(csrf, activeConfig_, {}));
        } else if (request.method == "POST" && request.target == "/save") {
          lastActivityMs = millis();
          ProvisioningFormFields form;
          if (!remoteFromPortal(client.remoteIP()) ||
              !decodeProvisioningFormRequest(request, csrf, form)) {
            sendResponse(
                client, 403, "text/html; charset=utf-8",
                portalPage(csrf, activeConfig_,
                           "La solicitud ha caducado. Vuelve a abrir el portal."));
          } else {
            DeviceConfig candidate;
            candidate.ssid = std::move(form.ssid);
            candidate.wifiPassword = std::move(form.wifiPassword);
            candidate.baseUrl = std::move(form.baseUrl);
            candidate.terminalToken = std::move(form.terminalToken);
            candidate.soundEnabled =
                activeConfig_.has_value() ? activeConfig_->soundEnabled : true;

            if (activeConfig_.has_value()) {
              if (candidate.wifiPassword.empty() &&
                  candidate.ssid == activeConfig_->ssid) {
                candidate.wifiPassword = activeConfig_->wifiPassword;
              }
              if (candidate.terminalToken.empty()) {
                candidate.terminalToken = activeConfig_->terminalToken;
              }
            }

            const ConfigError configError =
                validateDeviceConfig(candidate, profile_);
            if (configError != ConfigError::None) {
              sendResponse(client, 400, "text/html; charset=utf-8",
                           portalPage(csrf, activeConfig_,
                                      validationMessage(configError)));
            } else if (!canApplyProvisioningCandidate(
                           activeConfig_, candidate, pendingCount_)) {
              sendResponse(
                  client, 409, "text/html; charset=utf-8",
                  portalPage(csrf, activeConfig_,
                             "Hay fichajes pendientes. Sincronízalos antes de "
                             "cambiar la API key."));
            } else {
              drawProvisioningStatus("Comprobando",
                                     "Conectando con el negocio...", false);
              WiFi.disconnect(false, false);
              WiFi.begin(candidate.ssid.c_str(),
                         candidate.wifiPassword.c_str());
              const uint32_t connectStartedMs = millis();
              while (WiFi.status() != WL_CONNECTED &&
                     millis() - connectStartedMs < kConnectTimeoutMs) {
                dns.processNextRequest();
                M5.update();
                delay(25);
              }
              if (WiFi.status() != WL_CONNECTED) {
                WiFi.disconnect(false, false);
                drawProvisioningAccess(apSsid, apPassword);
                sendResponse(
                    client, 400, "text/html; charset=utf-8",
                    portalPage(csrf, activeConfig_,
                               "No se pudo conectar a esa red Wi-Fi en 20 "
                               "segundos."));
              } else {
                std::string bootstrapError;
                if (!candidateValidator(candidate, bootstrapError)) {
                  WiFi.disconnect(false, false);
                  drawProvisioningAccess(apSsid, apPassword);
                  const std::string displayError =
                      safeBootstrapError(candidate, bootstrapError);
                  sendResponse(client, 400, "text/html; charset=utf-8",
                               portalPage(csrf, activeConfig_,
                                          String(displayError.c_str())));
                } else if (!store_.save(candidate, profile_)) {
                  WiFi.disconnect(false, false);
                  drawProvisioningAccess(apSsid, apPassword);
                  sendResponse(
                      client, 500, "text/html; charset=utf-8",
                      portalPage(csrf, activeConfig_,
                                 "El servidor respondió, pero no se pudo "
                                 "guardar la configuración."));
                } else {
                  sendResponse(
                      client, 200, "text/html; charset=utf-8",
                      "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\">"
                      "<meta name=\"viewport\" content=\"width=device-width\">"
                      "<title>Terminal configurado</title><body><main>"
                      "<h1>Terminal configurado</h1><p>Ya puedes cerrar esta "
                      "página.</p></main></body></html>");
                  result.saved = true;
                  result.config = candidate;
                  completed = true;
                  drawProvisioningStatus("Configurado",
                                         "El terminal está listo.", false);
                }
              }
            }
          }
        } else {
          sendResponse(client, 302, "text/plain; charset=utf-8",
                       "Abriendo configuración...", "http://192.168.4.1/");
        }
      }
      delay(5);
      client.stop();
    }
    M5.update();
    delay(10);
  }

  const bool keepStation = completed && WiFi.status() == WL_CONNECTED;
  stopPortal(dns, server, keepStation);
  if (!completed) {
    result.displayError = "El portal se cerró por inactividad.";
    drawProvisioningStatus("Configuración", result.displayError, true);
  }
  return result;
}

#endif

}  // namespace openjornada
