#include "openjornada/provisioning.hpp"

#include <utility>

#ifdef ARDUINO
#include <Arduino.h>
#include <DNSServer.h>
#include <M5Unified.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_system.h>

#include <array>
#include <cstdint>
#include <cstdlib>
#endif

namespace openjornada {

bool canApplyProvisioningCandidate(
    const std::optional<DeviceConfig>& activeConfig,
    const DeviceConfig& candidate, size_t pendingCount) {
  return pendingCount == 0 || !activeConfig.has_value() ||
         activeConfig->terminalToken == candidate.terminalToken;
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
constexpr uint32_t kIdleTimeoutMs = 10U * 60U * 1000U;
constexpr size_t kMaxFormBodyBytes = kMaxSsidBytes +
                                     kMaxWifiPasswordBytes * 3U +
                                     kMaxBaseUrlBytes * 3U +
                                     kMaxTerminalTokenBytes * 3U +
                                     kMaxSsidBytes * 2U + 256U;
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

bool requestFromPortal(WebServer& server) {
  const IPAddress remote = server.client().remoteIP();
  if (remote[0] != kPortalIp[0] || remote[1] != kPortalIp[1] ||
      remote[2] != kPortalIp[2]) {
    return false;
  }
  const String host = server.hostHeader();
  if (host != F("192.168.4.1") && host != F("192.168.4.1:80") &&
      host != F("openjornada.local") && host != F("openjornada.local:80")) {
    return false;
  }
  if (server.hasHeader("Origin") &&
      server.header("Origin") != F("http://192.168.4.1")) {
    return false;
  }
  return true;
}

bool bodyWithinLimit(WebServer& server) {
  if (!server.hasHeader("Content-Length")) return false;
  const String raw = server.header("Content-Length");
  if (raw.isEmpty() || raw.length() > 5) return false;
  char* end = nullptr;
  const unsigned long length = strtoul(raw.c_str(), &end, 10);
  return end != raw.c_str() && *end == '\0' && length <= kMaxFormBodyBytes;
}

bool exactFormArguments(WebServer& server) {
  constexpr std::array<const char*, 5> expected{
      "csrf", "ssid", "wifi_password", "base_url", "terminal_token"};
  if (server.args() != static_cast<int>(expected.size())) return false;
  for (const char* name : expected) {
    if (!server.hasArg(name)) return false;
  }
  return true;
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

void securePageHeaders(WebServer& server) {
  server.sendHeader("Cache-Control", "no-store, max-age=0");
  server.sendHeader("Pragma", "no-cache");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.sendHeader("X-Frame-Options", "DENY");
  server.sendHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action "
      "http://192.168.4.1; base-uri 'none'; frame-ancestors 'none'");
}

void stopPortal(DNSServer& dns, WebServer& server, bool keepStation) {
  server.stop();
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
  WebServer server(80);
  if (!dns.start(kDnsPort, "*", kPortalIp)) {
    stopPortal(dns, server, false);
    result.displayError = "No se pudo iniciar el portal de configuración.";
    drawProvisioningStatus("Configuración", result.displayError, true);
    return result;
  }

  const char* collectedHeaders[] = {"Content-Length", "Origin"};
  server.collectHeaders(collectedHeaders, 2);
  uint32_t lastActivityMs = millis();
  bool completed = false;

  const auto sendPage = [&](int status, const String& error) {
    securePageHeaders(server);
    server.send(status, "text/html; charset=utf-8",
                portalPage(csrf, activeConfig_, error));
  };

  server.on("/", HTTP_GET, [&]() {
    lastActivityMs = millis();
    sendPage(200, {});
  });

  server.on("/save", HTTP_POST, [&]() {
    lastActivityMs = millis();
    if (!requestFromPortal(server) || !bodyWithinLimit(server) ||
        !exactFormArguments(server) || server.arg("csrf") != csrf.c_str()) {
      sendPage(403, "La solicitud ha caducado. Vuelve a abrir el portal.");
      return;
    }

    DeviceConfig candidate;
    candidate.ssid = fromArduinoString(server.arg("ssid"));
    candidate.wifiPassword = fromArduinoString(server.arg("wifi_password"));
    candidate.baseUrl = fromArduinoString(server.arg("base_url"));
    candidate.terminalToken = fromArduinoString(server.arg("terminal_token"));
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

    const ConfigError configError = validateDeviceConfig(candidate, profile_);
    if (configError != ConfigError::None) {
      sendPage(400, validationMessage(configError));
      return;
    }
    if (!canApplyProvisioningCandidate(activeConfig_, candidate,
                                       pendingCount_)) {
      sendPage(409, "Hay fichajes pendientes. Sincronízalos antes de cambiar "
                    "la API key.");
      return;
    }

    drawProvisioningStatus("Comprobando", "Conectando con el negocio...", false);
    WiFi.disconnect(false, false);
    WiFi.begin(candidate.ssid.c_str(), candidate.wifiPassword.c_str());
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
      sendPage(400, "No se pudo conectar a esa red Wi-Fi en 20 segundos.");
      return;
    }

    std::string bootstrapError;
    if (!candidateValidator(candidate, bootstrapError)) {
      WiFi.disconnect(false, false);
      drawProvisioningAccess(apSsid, apPassword);
      const std::string displayError =
          safeBootstrapError(candidate, bootstrapError);
      sendPage(400, String(displayError.c_str()));
      return;
    }
    if (!store_.save(candidate, profile_)) {
      WiFi.disconnect(false, false);
      drawProvisioningAccess(apSsid, apPassword);
      sendPage(500, "El servidor respondió, pero no se pudo guardar la "
                    "configuración.");
      return;
    }

    securePageHeaders(server);
    server.send(200, "text/html; charset=utf-8",
                "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\">"
                "<meta name=\"viewport\" content=\"width=device-width\">"
                "<title>Terminal configurado</title><body><main>"
                "<h1>Terminal configurado</h1><p>Ya puedes cerrar esta "
                "página.</p></main></body></html>");
    result.saved = true;
    result.config = candidate;
    completed = true;
    drawProvisioningStatus("Configurado", "El terminal está listo.", false);
  });

  server.onNotFound([&]() {
    server.sendHeader("Location", "http://192.168.4.1/", true);
    server.send(302, "text/plain; charset=utf-8", "Abriendo configuración...");
  });

  server.begin();
  drawProvisioningAccess(apSsid, apPassword);
  while (!completed && millis() - lastActivityMs < kIdleTimeoutMs) {
    dns.processNextRequest();
    server.handleClient();
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
