#include <Arduino.h>
#include <M5Unified.h>
#include <WiFi.h>
#include <esp_partition.h>
#include <esp_sntp.h>
#include <esp_system.h>
#include <esp_timer.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <functional>
#include <memory>
#include <new>
#include <optional>
#include <string>

#include "openjornada/api_client.hpp"
#include "openjornada/app_controller.hpp"
#include "openjornada/cache_store.hpp"
#include "openjornada/config.hpp"
#include "openjornada/display_power.hpp"
#include "openjornada/gesture.hpp"
#include "openjornada/hardware.hpp"
#include "openjornada/network_worker.hpp"
#include "openjornada/outbox.hpp"
#include "openjornada/provisioning.hpp"
#include "openjornada/screen.hpp"
#include "openjornada/signature.hpp"
#include "openjornada/storage_layout.hpp"
#include "openjornada/telemetry_scheduler.hpp"
#include "openjornada/telemetry_worker.hpp"
#include "openjornada/timezone.hpp"
#include "openjornada/uid_gate.hpp"
#include "openjornada/version.hpp"

namespace {

using namespace openjornada;

constexpr std::time_t kEarliestTrustedTime = 1704067200;

Hardware hardware;
UidGate uidGate{300};
LittleFsOutboxStorage outboxStorage;
Outbox outbox{outboxStorage};
ConfigStore configStore;
CacheStore cacheStore;
ScreenRenderer renderer;
DisplayPowerPolicy displayPower{0};
RuntimeProvisioningGesture runtimeProvisioningGesture;
std::unique_ptr<Esp32ApiClient> apiClient;
std::unique_ptr<NetworkWorker> networkWorker;
std::unique_ptr<Esp32ApiClient> telemetryApiClient;
std::unique_ptr<TelemetryWorker> telemetryWorker;
TelemetryScheduler telemetryScheduler;
std::unique_ptr<AppController> app;
std::optional<DeviceConfig> deviceConfig;
bool terminalBlocked = false;
bool soundEnabled = true;
size_t pendingCountForRecovery = OutboxCodec::kCapacity;
uint8_t lastRecoveryCountdown = UINT8_MAX;
struct BlockedScreenState {
  std::string title;
  std::string detail;
  bool error = true;
};
std::optional<BlockedScreenState> blockedScreen;
std::array<bool, 3> acceleratedHoldSent{};
std::string appliedTimezone;
std::atomic<bool> ntpSynchronizedThisBoot{false};
std::atomic<std::time_t> lastNtpSyncEpoch{0};

enum class BootChoice { Normal, Provisioning, FactoryReset };
enum class ProvisioningOutcome { Saved, Cancelled, Failed };

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

bool prepareTlsClock(const DeviceConfig& candidate, std::string& displayError,
                     const std::function<bool()>& service) {
  if (candidate.baseUrl.rfind("https://", 0) != 0 ||
      std::time(nullptr) >= kEarliestTrustedTime) {
    return true;
  }
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  const uint32_t startedMs = millis();
  while (std::time(nullptr) < kEarliestTrustedTime &&
         millis() - startedMs < 10000U) {
    if (!service()) {
      displayError = "Configuración cancelada.";
      return false;
    }
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

void drawRecoveryCountdown(uint8_t secondsRemaining) {
  if (lastRecoveryCountdown == secondsRemaining) return;
  lastRecoveryCountdown = secondsRemaining;
  char detail[96]{};
  snprintf(detail, sizeof(detail),
           "Mantén A+B. Configuración Wi-Fi en %u s.",
           static_cast<unsigned>(secondsRemaining));
  drawProvisioningStatus("Recuperar conexión", detail, false);
}

ProvisioningOutcome runProvisioning(
    ConfigStore& store, BuildProfile profile,
    const std::optional<DeviceConfig>& active, size_t pendingCount) {
  ProvisioningPortal portal(store, profile, active, pendingCount);
  Esp32ApiClient provisioningClient(profile);
  NetworkWorker provisioningWorker(provisioningClient);
  const bool workerReady = provisioningWorker.begin();
  uint32_t nextJobId = 1;
  const auto result = portal.run(
      [&](const DeviceConfig& candidate, std::string& displayError,
          const std::function<bool()>& service) {
        if (!prepareTlsClock(candidate, displayError, service)) return false;
        if (!workerReady) {
          displayError = "No se pudo iniciar la comprobación del servidor.";
          return false;
        }

        NetworkJob job;
        job.id = nextJobId++;
        job.kind = NetworkJobKind::Bootstrap;
        job.credentials = {candidate.baseUrl, candidate.terminalToken};
        job.bootstrap = {
            kTerminalProtocolVersion, std::string(kTerminalClientVersion),
            static_cast<uint32_t>(
                std::min(pendingCount, OutboxCodec::kCapacity))};
        const uint32_t expectedJobId = job.id;
        if (!provisioningWorker.enqueue(std::move(job))) {
          displayError = "No se pudo iniciar la comprobación del servidor.";
          return false;
        }

        NetworkResult networkResult;
        while (!provisioningWorker.poll(networkResult)) {
          if (!service()) {
            displayError = "Configuración cancelada.";
            return false;
          }
          delay(5);
        }
        if (networkResult.id != expectedJobId ||
            networkResult.kind != NetworkJobKind::Bootstrap ||
            networkResult.bootstrap == nullptr) {
          displayError = "La comprobación del servidor no fue válida.";
          return false;
        }
        if (!networkResult.call.ok) {
          displayError = networkResult.call.failure.safeMessage.empty()
                             ? "No se pudo comprobar OpenJornada."
                             : networkResult.call.failure.safeMessage;
          return false;
        }
        const BootstrapResponse& response = *networkResult.bootstrap;
        Serial.printf("[OJ-NET] bootstrap=ok protocol=%u cache_revision=%lu\n",
                      static_cast<unsigned>(response.protocol.current),
                      static_cast<unsigned long>(response.cacheRevision));
        return true;
      });
  if (result.saved) return ProvisioningOutcome::Saved;
  if (result.cancelled) return ProvisioningOutcome::Cancelled;
  return ProvisioningOutcome::Failed;
}

std::string makeRebootId() {
  std::array<char, 25> value{};
  snprintf(value.data(), value.size(), "%08lx%08lx",
           static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(esp_random()));
  return value.data();
}

void onNtpSynchronized(struct timeval*) {
  lastNtpSyncEpoch.store(std::time(nullptr), std::memory_order_release);
  ntpSynchronizedThisBoot.store(true, std::memory_order_release);
}

bool clockTrusted() {
  return ntpSynchronizedThisBoot.load(std::memory_order_acquire) &&
         std::time(nullptr) >= kEarliestTrustedTime;
}

void applyServerTimezone(const std::string& timezone) {
  if (timezone.empty() || timezone == appliedTimezone) return;
  const char* posix = posixTimezone(timezone);
  if (posix == nullptr) return;
  setenv("TZ", posix, 1);
  tzset();
  appliedTimezone = timezone;
}

AppEvent baseEvent(AppEventKind kind, bool includeButtonState = true) {
  AppEvent event;
  event.kind = kind;
  event.nowMs = millis();
  event.nowEpochSeconds = static_cast<int64_t>(std::time(nullptr));
  event.networkConnected = WiFi.status() == WL_CONNECTED;
  event.ntpTrusted = clockTrusted();
  event.ntpSyncEpochSeconds = static_cast<int64_t>(
      lastNtpSyncEpoch.load(std::memory_order_acquire));
  if (includeButtonState) {
    event.buttonADown = hardware.down(Button::A);
    event.buttonBDown = hardware.down(Button::B);
    event.buttonCDown = hardware.down(Button::C);
  }
  if (event.ntpTrusted) event.timestamp = isoUtc(event.nowEpochSeconds);
  return event;
}

void dispatchButton(Button button, bool pressed) {
  const size_t index = static_cast<size_t>(button);
  if (pressed) {
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

void applyDisplayPowerEvent(DisplayPowerEvent event, bool invalidateRenderer) {
  switch (event) {
    case DisplayPowerEvent::Sleep:
      M5.Display.sleep();
      break;
    case DisplayPowerEvent::Wake:
      M5.Display.wakeup();
      if (invalidateRenderer) renderer.invalidate();
      break;
    case DisplayPowerEvent::None:
      break;
  }
}

void enterBlockedState(std::string title, std::string detail, bool error) {
  blockedScreen = {std::move(title), std::move(detail), error};
  drawProvisioningStatus(blockedScreen->title, blockedScreen->detail,
                         blockedScreen->error);
  displayPower.reset(millis());
  acceleratedHoldSent.fill(false);
  terminalBlocked = true;
}

size_t currentPendingCountForRecovery() {
  size_t pendingCount = pendingCountForRecovery;
  size_t storedPendingCount = 0;
  if (outbox.pendingCount(storedPendingCount) == OutboxError::None) {
    pendingCount = storedPendingCount;
  }
  return pendingCount;
}

[[noreturn]] void enterRuntimeProvisioning() {
  const size_t pendingCount = currentPendingCountForRecovery();
  drawProvisioningStatus(
      "Configurar nueva Wi-Fi",
      "Preparando el portal. No se borrarán fichajes ni credenciales...",
      false);

  // Stop all API activity before the portal takes ownership of Wi-Fi. The
  // outbox and the active configuration remain stored and untouched.
  app.reset();
  telemetryWorker.reset();
  telemetryApiClient.reset();
  networkWorker.reset();
  apiClient.reset();

  const ProvisioningOutcome outcome =
      runProvisioning(configStore, currentBuildProfile(), deviceConfig,
                      pendingCount);
  const char* resultTitle =
      outcome == ProvisioningOutcome::Saved
          ? "Configuración guardada"
          : outcome == ProvisioningOutcome::Cancelled
                ? "Configuración cancelada"
                : "No se pudo configurar";
  drawProvisioningStatus(
      resultTitle,
      "Reiniciando el terminal con la configuración disponible...",
      outcome == ProvisioningOutcome::Failed);
  delay(800);
  ESP.restart();
  while (true) delay(1000);
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
  pendingCountForRecovery = pendingCount;

  const BootChoice choice = detectBootChoice(pendingCount);
  if (choice == BootChoice::FactoryReset) {
    outboxStorage.end();
    const bool reset = performFactoryReset(configStore, cacheStore);
    showFactoryResetResult(reset);
    delay(1200);
    if (reset) ESP.restart();
    enterBlockedState(
        "No se pudo borrar",
        "Los datos no se borraron por completo. Reinicia y repite.", true);
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
    pendingCountForRecovery = pendingCount;
  }

  if (choice == BootChoice::Provisioning || !deviceConfig.has_value()) {
    if (!storageMounted && !deviceConfig.has_value()) {
      enterBlockedState(
          "Inicialización necesaria",
          "No se borró ningún dato. Reinicia, mantén A+B+C 10 s, suelta "
          "todos y después mantén SOLO C 5 s.",
          true);
      return;
    }
    const ProvisioningOutcome outcome =
        runProvisioning(configStore, profile, deviceConfig, pendingCount);
    if (outcome == ProvisioningOutcome::Saved) {
      delay(800);
      ESP.restart();
    }
    if (outcome == ProvisioningOutcome::Cancelled) {
      drawProvisioningStatus(
          "Configuración cancelada",
          "Reiniciando con la configuración guardada...", false);
      delay(800);
      ESP.restart();
    }
    if (!deviceConfig.has_value()) {
      enterBlockedState(
          "Configuración necesaria",
          "Mantén A+B durante 5 s para volver a abrir el portal Wi-Fi.",
          false);
      return;
    }
  }

  if (!outboxReadiness.operational) {
    enterBlockedState(
        "Cola local no disponible",
        "No se aceptarán fichajes. Usa el reinicio de fábrica o revisa la "
        "memoria antes de continuar.",
        true);
    return;
  }
  if (!rfidReady) {
    enterBlockedState("RFID2 no detectado",
                      "Comprueba el cable Grove A y reinicia el terminal.",
                      true);
    hardware.toneError();
    return;
  }

  soundEnabled = deviceConfig->soundEnabled;
  WiFi.mode(WIFI_STA);
  WiFi.begin(deviceConfig->ssid.c_str(), deviceConfig->wifiPassword.c_str());
  sntp_set_time_sync_notification_cb(onNtpSynchronized);
  const char* initialTimezone = posixTimezone("Europe/Madrid");
  configTzTime(initialTimezone, "pool.ntp.org", "time.google.com");
  appliedTimezone = "Europe/Madrid";

  CacheSnapshot initialCache;
  if (cacheStore.load(initialCache) != CacheError::None) initialCache = {};
  const std::string configFingerprint = configurationFingerprint(
      deviceConfig->baseUrl, deviceConfig->terminalToken);
  auto runtime = configStore.loadRuntime();
  if (!runtime.has_value() ||
      runtime->configFingerprint != configFingerprint) {
    runtime.reset();
    initialCache = {};
  } else if (initialCache.terminalId != runtime->terminalId ||
             initialCache.configFingerprint != configFingerprint) {
    initialCache = {};
  }

  apiClient = std::make_unique<Esp32ApiClient>(profile);
  networkWorker = std::make_unique<NetworkWorker>(*apiClient);
  if (!networkWorker->begin()) {
    enterBlockedState(
        "Red no disponible",
        "No se pudo iniciar el proceso de conexión. Reinicia el terminal.",
        true);
    return;
  }
  AppControllerConfig appConfig;
  appConfig.credentials = {deviceConfig->baseUrl, deviceConfig->terminalToken};
  appConfig.clientVersion = kTerminalClientVersion;
  appConfig.rebootId = makeRebootId();
  appConfig.configFingerprint = configFingerprint;
  appConfig.initialCache = std::move(initialCache);
  if (runtime.has_value()) {
    appConfig.terminalId = runtime->terminalId;
    appConfig.clockSyncedAt = runtime->clockSyncedAt;
    appConfig.lastNtpEpochSeconds = runtime->lastNtpEpochSeconds;
  }
  app = std::make_unique<AppController>(*networkWorker, outbox,
                                        std::move(appConfig), &cacheStore,
                                        &configStore);
  try {
    telemetryApiClient = std::make_unique<Esp32ApiClient>(profile);
    telemetryWorker =
        std::make_unique<TelemetryWorker>(*telemetryApiClient);
    if (!telemetryWorker->begin()) {
      telemetryWorker.reset();
      telemetryApiClient.reset();
    }
  } catch (const std::bad_alloc&) {
    telemetryWorker.reset();
    telemetryApiClient.reset();
  }
  app->start(pendingCount, millis());
  app->tick(baseEvent(AppEventKind::Timer));
  renderer.render(app->screen(), std::time(nullptr));
  displayPower.reset(millis());
}

void loop() {
  constexpr std::array<Button, 3> kButtons{Button::A, Button::B, Button::C};
  hardware.update();
  std::array<bool, 3> pressed{};
  std::array<bool, 3> down{};
  for (size_t index = 0; index < kButtons.size(); ++index) {
    pressed[index] = hardware.pressed(kButtons[index]);
    down[index] = hardware.down(kButtons[index]);
  }
  const auto uid = hardware.pollUid();

  const DisplayPowerDecision displayDecision = displayPower.update(
      millis(), DisplayActivity{
                    std::any_of(pressed.begin(), pressed.end(),
                                [](bool value) { return value; }),
                    std::any_of(down.begin(), down.end(),
                                [](bool value) { return value; }),
                    uid.has_value()});
  const bool applicationAvailable = !terminalBlocked && app != nullptr;
  applyDisplayPowerEvent(displayDecision.power, applicationAvailable);

  const RuntimeProvisioningDecision recovery =
      runtimeProvisioningGesture.update(
          {down[0], down[1], down[2]},
          {pressed[0], pressed[1], pressed[2]},
          displayDecision.dispatchButtons && applicationAvailable, millis());
  if (recovery.provisioningRequested) enterRuntimeProvisioning();
  if (recovery.showCountdown) {
    drawRecoveryCountdown(recovery.secondsRemaining);
  }
  if (recovery.restoreScreen) {
    lastRecoveryCountdown = UINT8_MAX;
    if (applicationAvailable) {
      renderer.invalidate();
    } else if (blockedScreen.has_value()) {
      drawProvisioningStatus(blockedScreen->title, blockedScreen->detail,
                             blockedScreen->error);
    }
  }
  if (recovery.suppressButtons) {
    acceleratedHoldSent.fill(false);
    delay(20);
    return;
  }
  if (!applicationAvailable) {
    delay(20);
    return;
  }

  const bool present = hardware.tagPresent();
  const bool acceptedUid =
      uid.has_value() && uidGate.accept(*uid, present, millis());
  if (!uid.has_value()) uidGate.accept("", present, millis());

  // A button used to wake the screen must not leak into the timer event: the
  // controller also observes held buttons there for the A+C admin gesture.
  app->tick(baseEvent(AppEventKind::Timer,
                      displayDecision.dispatchButtons));
  applyServerTimezone(app->timezone());

  if (displayDecision.dispatchButtons) {
    dispatchButton(Button::A, recovery.dispatchA);
    dispatchButton(Button::B, recovery.dispatchB);
    dispatchButton(Button::C, pressed[2]);
  } else {
    acceleratedHoldSent.fill(false);
  }

  if (acceptedUid && displayDecision.dispatchTag) {
    AppEvent event = baseEvent(AppEventKind::TagScanned);
    event.uid = *uid;
    app->tick(event);
  }

  if (telemetryWorker != nullptr && networkWorker != nullptr &&
      deviceConfig.has_value()) {
    TelemetryResult ignoredTelemetry;
    while (telemetryWorker->poll(ignoredTelemetry)) ignoredTelemetry = {};

    const uint32_t nowMs = millis();
    if (telemetryScheduler.due(nowMs, WiFi.status() == WL_CONNECTED,
                               networkWorker->busy(),
                               telemetryWorker->busy())) {
      TelemetryJob job;
      job.credentials = {deviceConfig->baseUrl,
                         deviceConfig->terminalToken};
      job.heartbeat = app->heartbeatRequest(
          static_cast<int16_t>(WiFi.RSSI()),
          static_cast<uint64_t>(esp_timer_get_time()) / 1000000ULL);
      job.localIp = WiFi.localIP().toString().c_str();
      if (telemetryWorker->enqueue(std::move(job))) {
        telemetryScheduler.markEnqueued(nowMs);
      }
    }
  }

  emitFeedback();
  renderer.render(app->screen(), std::time(nullptr));
  delay(20);
}
