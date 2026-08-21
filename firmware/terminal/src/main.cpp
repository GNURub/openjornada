#include <Arduino.h>
#include <M5Unified.h>
#include <WiFi.h>
#include <esp_partition.h>
#include <esp_system.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <memory>
#include <new>
#include <optional>
#include <string>

#include "openjornada/api_client.hpp"
#include "openjornada/app_controller.hpp"
#include "openjornada/cache_store.hpp"
#include "openjornada/config.hpp"
#include "openjornada/gesture.hpp"
#include "openjornada/hardware.hpp"
#include "openjornada/network_worker.hpp"
#include "openjornada/outbox.hpp"
#include "openjornada/provisioning.hpp"
#include "openjornada/screen.hpp"
#include "openjornada/storage_layout.hpp"
#include "openjornada/uid_gate.hpp"

namespace {

using namespace openjornada;

constexpr std::time_t kEarliestTrustedTime = 1704067200;

Hardware hardware;
UidGate uidGate{300};
LittleFsOutboxStorage outboxStorage;
Outbox outbox{outboxStorage};
ScreenRenderer renderer;
std::unique_ptr<Esp32ApiClient> apiClient;
std::unique_ptr<NetworkWorker> networkWorker;
std::unique_ptr<AppController> app;
std::optional<DeviceConfig> deviceConfig;
bool terminalBlocked = false;
bool soundEnabled = true;
std::array<bool, 3> acceleratedHoldSent{};
std::string appliedTimezone;

enum class BootChoice { Normal, Provisioning, FactoryReset };

void drawBootScreen() {
  auto& display = M5.Display;
  display.fillScreen(TFT_BLACK);
  display.setTextDatum(top_left);
  display.setTextColor(TFT_ORANGE, TFT_BLACK);
  display.setTextSize(2);
  display.drawString("OpenJornada", 12, 18);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.setTextSize(1);
  display.drawString("Mantén durante el arranque:", 12, 58);
  display.drawString("A+B  5 s   Configurar Wi-Fi", 12, 82);
  display.drawString("A+B+C  10 s Reinicio de fábrica", 12, 102);
  display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  display.drawString("El arranque normal continúa automáticamente", 12, 142);
}

void drawFactoryConfirmation(size_t pendingCount) {
  auto& display = M5.Display;
  display.fillScreen(TFT_BLACK);
  display.setTextDatum(top_left);
  display.setTextColor(TFT_RED, TFT_BLACK);
  display.setTextSize(2);
  display.drawString("Reinicio de fábrica", 10, 16);
  display.setTextSize(1);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.drawString("Suelta todos los botones.", 10, 56);
  char pending[72]{};
  if (pendingCount == OutboxCodec::kCapacity) {
    snprintf(pending, sizeof(pending), "Pendientes: no se pueden comprobar");
  } else {
    snprintf(pending, sizeof(pending), "Fichajes pendientes: %u",
             static_cast<unsigned>(pendingCount));
  }
  display.setTextColor(pendingCount > 0 ? TFT_RED : TFT_YELLOW, TFT_BLACK);
  display.drawString(pending, 10, 80);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.drawString("Se borrarán configuración, caché y cola.", 10, 105);
  display.drawString("Después mantén SOLO C durante 5 s", 10, 132);
  display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  display.drawString("Cualquier otro botón cancela el progreso", 10, 157);
}

BootButtons currentBootButtons() {
  return {hardware.down(Button::A), hardware.down(Button::B),
          hardware.down(Button::C)};
}

BootChoice detectBootChoice(size_t pendingCount) {
  constexpr uint32_t kInitialGestureWindowMs = 1500;
  BootGestureDetector detector(pendingCount);
  const uint32_t startedMs = millis();
  bool sawButton = false;
  drawBootScreen();
  while (true) {
    hardware.update();
    const BootButtons buttons = currentBootButtons();
    sawButton = sawButton || buttons.a || buttons.b || buttons.c;
    const auto event = detector.update(buttons, millis());
    if (event.gesture == BootGesture::Provisioning) return BootChoice::Provisioning;
    if (event.gesture == BootGesture::FactoryResetRequest) {
      drawFactoryConfirmation(event.pendingCount);
    }
    if (event.gesture == BootGesture::FactoryReset) return BootChoice::FactoryReset;
    if (!sawButton && millis() - startedMs >= kInitialGestureWindowMs) {
      return BootChoice::Normal;
    }
    if (sawButton && !detector.awaitingFactoryConfirmation() && !buttons.a &&
        !buttons.b && !buttons.c) {
      return BootChoice::Normal;
    }
    delay(10);
  }
}

bool partitionIsPristine() {
  const esp_partition_t* partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS,
      kLittleFsPartitionLabel);
  if (partition == nullptr) return false;
  std::array<uint8_t, 1024> bytes{};
  for (size_t offset = 0; offset < partition->size; offset += bytes.size()) {
    const size_t length =
        std::min(bytes.size(), static_cast<size_t>(partition->size - offset));
    if (esp_partition_read(partition, offset, bytes.data(), length) != ESP_OK) {
      return false;
    }
    for (size_t index = 0; index < length; ++index) {
      if (bytes[index] != 0xFFU) return false;
    }
    if ((offset / bytes.size()) % 32U == 0) delay(0);
  }
  return true;
}

bool initializeFirstUseStorage(CacheStore& cacheStore) {
  return partitionIsPristine() && cacheStore.formatAndInitialize();
}

bool performFactoryReset(ConfigStore& configStore, CacheStore& cacheStore) {
  // The 10 s + 5 s physical gesture is the explicit destructive confirmation.
  if (!cacheStore.formatAndInitialize()) return false;
  if (!cacheStore.clear()) return false;
  // Clear the API key last. If storage preparation fails, the credentials stay
  // intact and a recoverable outbox can still be used on the next boot.
  return configStore.clear();
}

bool prepareTlsClock(const DeviceConfig& candidate, std::string& displayError) {
  if (candidate.baseUrl.rfind("https://", 0) != 0 ||
      std::time(nullptr) >= kEarliestTrustedTime) {
    return true;
  }
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  const uint32_t startedMs = millis();
  while (std::time(nullptr) < kEarliestTrustedTime &&
         millis() - startedMs < 10000U) {
    M5.update();
    delay(25);
  }
  if (std::time(nullptr) >= kEarliestTrustedTime) return true;
  displayError =
      "No se pudo sincronizar la hora para comprobar el certificado.";
  return false;
}

void showFactoryResetResult(bool success) {
  drawProvisioningStatus(
      success ? "Datos borrados" : "No se pudo borrar",
      success ? "Reiniciando para configurar el terminal..."
              : "Los datos no se borraron por completo. Reinicia y repite.",
      !success);
}

bool runProvisioning(ConfigStore& store, BuildProfile profile,
                     const std::optional<DeviceConfig>& active,
                     size_t pendingCount) {
  ProvisioningPortal portal(store, profile, active, pendingCount);
  Esp32ApiClient provisioningClient(profile);
  const auto result = portal.run(
      [&](const DeviceConfig& candidate, std::string& displayError) {
        if (!prepareTlsClock(candidate, displayError)) return false;
        BootstrapResponse response;
        const ApiCredentials credentials{candidate.baseUrl,
                                         candidate.terminalToken};
        const BootstrapRequest request{
            kTerminalProtocolVersion, "m5stack-1.0.0",
            static_cast<uint32_t>(std::min(pendingCount,
                                           OutboxCodec::kCapacity))};
        ApiCallResult call;
        try {
          call = provisioningClient.bootstrap(credentials, request, response,
                                              10000);
        } catch (const std::bad_alloc&) {
          displayError = "El terminal no tiene memoria suficiente para "
                         "comprobar el servidor.";
          return false;
        }
        if (!call.ok) {
          displayError = call.failure.safeMessage.empty()
                             ? "No se pudo comprobar OpenJornada."
                             : call.failure.safeMessage;
          return false;
        }
        Serial.printf("[OJ-NET] bootstrap=ok protocol=%u cache_revision=%lu\n",
                      static_cast<unsigned>(response.protocol.current),
                      static_cast<unsigned long>(response.cacheRevision));
        return true;
      });
  return result.saved;
}

std::string makeRebootId() {
  std::array<char, 25> value{};
  snprintf(value.data(), value.size(), "%08lx%08lx",
           static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(esp_random()));
  return value.data();
}

bool clockTrusted() { return std::time(nullptr) >= kEarliestTrustedTime; }

void applyServerTimezone(const std::string& timezone) {
  if (timezone.empty() || timezone == appliedTimezone) return;
  const char* posix = nullptr;
  if (timezone == "Europe/Madrid") {
    posix = "CET-1CEST,M3.5.0,M10.5.0/3";
  } else if (timezone == "Atlantic/Canary") {
    posix = "WET0WEST,M3.5.0/1,M10.5.0";
  }
  if (posix == nullptr) return;
  setenv("TZ", posix, 1);
  tzset();
  appliedTimezone = timezone;
}

AppEvent baseEvent(AppEventKind kind) {
  AppEvent event;
  event.kind = kind;
  event.nowMs = millis();
  event.nowEpochSeconds = static_cast<int64_t>(std::time(nullptr));
  event.networkConnected = WiFi.status() == WL_CONNECTED;
  event.ntpTrusted = clockTrusted();
  if (event.ntpTrusted) event.timestamp = isoUtc(event.nowEpochSeconds);
  return event;
}

void dispatchButton(Button button) {
  const size_t index = static_cast<size_t>(button);
  if (hardware.pressed(button)) {
    AppEvent event = baseEvent(AppEventKind::ButtonPressed);
    event.button = button;
    app->tick(event);
  }
  if (hardware.down(button)) {
    if (hardware.held(button, 800) && !acceleratedHoldSent[index]) {
      acceleratedHoldSent[index] = true;
      AppEvent event = baseEvent(AppEventKind::ButtonHeld);
      event.button = button;
      app->tick(event);
    }
  } else {
    acceleratedHoldSent[index] = false;
  }
}

void emitFeedback() {
  const AppFeedback feedback = app->takeFeedback();
  if (!soundEnabled) return;
  if (feedback == AppFeedback::Success) hardware.toneSuccess();
  if (feedback == AppFeedback::Error) hardware.toneError();
}

}  // namespace

void setup() {
  const bool rfidReady = hardware.begin();
  ConfigStore configStore;
  CacheStore cacheStore;
  const BuildProfile profile = currentBuildProfile();
  ConfigError configError = ConfigError::Storage;
  deviceConfig = configStore.load(profile, &configError);

  bool storageMounted = outboxStorage.begin();
  size_t pendingCount = 0;
  OutboxError beginResult = OutboxError::Unsupported;
  OutboxError pendingResult = OutboxError::Unsupported;
  if (storageMounted) {
    beginResult = outbox.begin();
    if (beginResult == OutboxError::None) {
      pendingResult = outbox.pendingCount(pendingCount);
    }
  }
  OutboxReadiness outboxReadiness = assessOutboxReadiness(
      storageMounted, beginResult, pendingResult, pendingCount);
  pendingCount = outboxReadiness.pendingForSafety;

  const BootChoice choice = detectBootChoice(pendingCount);
  if (choice == BootChoice::FactoryReset) {
    outboxStorage.end();
    const bool reset = performFactoryReset(configStore, cacheStore);
    showFactoryResetResult(reset);
    delay(1200);
    if (reset) ESP.restart();
    terminalBlocked = true;
    return;
  }

  if (!storageMounted && !deviceConfig.has_value() &&
      initializeFirstUseStorage(cacheStore)) {
    storageMounted = outboxStorage.begin();
    beginResult = storageMounted ? outbox.begin() : OutboxError::Unsupported;
    pendingCount = 0;
    pendingResult = beginResult == OutboxError::None
                        ? outbox.pendingCount(pendingCount)
                        : OutboxError::Unsupported;
    outboxReadiness = assessOutboxReadiness(
        storageMounted, beginResult, pendingResult, pendingCount);
    pendingCount = outboxReadiness.pendingForSafety;
  }

  if (choice == BootChoice::Provisioning || !deviceConfig.has_value()) {
    if (!storageMounted && !deviceConfig.has_value()) {
      drawProvisioningStatus(
          "Inicialización necesaria",
          "No se borró ningún dato. Reinicia, mantén A+B+C 10 s, suelta "
          "todos y después mantén SOLO C 5 s.",
          true);
      terminalBlocked = true;
      return;
    }
    if (runProvisioning(configStore, profile, deviceConfig, pendingCount)) {
      delay(800);
      ESP.restart();
    }
    if (!deviceConfig.has_value()) {
      terminalBlocked = true;
      return;
    }
  }

  if (!outboxReadiness.operational) {
    drawProvisioningStatus(
        "Cola local no disponible",
        "No se aceptarán fichajes. Usa el reinicio de fábrica o revisa la "
        "memoria antes de continuar.",
        true);
    terminalBlocked = true;
    return;
  }
  if (!rfidReady) {
    drawProvisioningStatus("RFID2 no detectado",
                           "Comprueba el cable Grove A y reinicia el terminal.",
                           true);
    hardware.toneError();
    terminalBlocked = true;
    return;
  }

  soundEnabled = deviceConfig->soundEnabled;
  applyServerTimezone("Europe/Madrid");
  WiFi.mode(WIFI_STA);
  WiFi.begin(deviceConfig->ssid.c_str(), deviceConfig->wifiPassword.c_str());
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  apiClient = std::make_unique<Esp32ApiClient>(profile);
  networkWorker = std::make_unique<NetworkWorker>(*apiClient);
  if (!networkWorker->begin()) {
    drawProvisioningStatus(
        "Red no disponible",
        "No se pudo iniciar el proceso de conexión. Reinicia el terminal.",
        true);
    terminalBlocked = true;
    return;
  }
  app = std::make_unique<AppController>(
      *networkWorker, outbox,
      AppControllerConfig{{deviceConfig->baseUrl, deviceConfig->terminalToken},
                          "m5stack-1.0.0", makeRebootId()});
  app->start(pendingCount, millis());
  app->tick(baseEvent(AppEventKind::Timer));
  renderer.render(app->screen(), std::time(nullptr));
}

void loop() {
  if (terminalBlocked || app == nullptr) {
    hardware.update();
    delay(20);
    return;
  }
  hardware.update();
  app->tick(baseEvent(AppEventKind::Timer));
  applyServerTimezone(app->timezone());

  dispatchButton(Button::A);
  dispatchButton(Button::B);
  dispatchButton(Button::C);

  const auto uid = hardware.pollUid();
  const bool present = hardware.tagPresent();
  if (uid.has_value() && uidGate.accept(*uid, present, millis())) {
    AppEvent event = baseEvent(AppEventKind::TagScanned);
    event.uid = *uid;
    app->tick(event);
  } else if (!uid.has_value()) {
    uidGate.accept("", present, millis());
  }

  emitFeedback();
  renderer.render(app->screen(), std::time(nullptr));
  delay(20);
}
