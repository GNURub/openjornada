#include <Arduino.h>
#include <M5Unified.h>
#include <esp_partition.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>
#include <string>

#include "openjornada/cache_store.hpp"
#include "openjornada/config.hpp"
#include "openjornada/domain.hpp"
#include "openjornada/gesture.hpp"
#include "openjornada/hardware.hpp"
#include "openjornada/outbox.hpp"
#include "openjornada/provisioning.hpp"
#include "openjornada/storage_layout.hpp"
#include "openjornada/uid_gate.hpp"

namespace {

using openjornada::Button;
using openjornada::BootButtons;
using openjornada::BootGesture;
using openjornada::BootGestureDetector;
using openjornada::BuildProfile;
using openjornada::CacheStore;
using openjornada::ConfigError;
using openjornada::ConfigStore;
using openjornada::DeviceConfig;
using openjornada::Hardware;
using openjornada::LittleFsOutboxStorage;
using openjornada::Outbox;
using openjornada::OutboxCodec;
using openjornada::OutboxError;
using openjornada::ProvisioningPortal;
using openjornada::RfidDiagnosticGate;
using openjornada::RfidPollStatus;
using openjornada::UidGate;

Hardware hardware;
UidGate uidGate{300};
RfidDiagnosticGate rfidDiagnosticGate{2000};
bool rfidReady = false;
uint32_t tagCount = 0;
uint32_t buttonCount[3]{};
std::string maskedUid = "esperando";
std::string scanMessage = "esperando tag";
size_t uidBytes = 0;
bool terminalBlocked = false;

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
    if (event.gesture == BootGesture::Provisioning) {
      return BootChoice::Provisioning;
    }
    if (event.gesture == BootGesture::FactoryResetRequest) {
      drawFactoryConfirmation(event.pendingCount);
    }
    if (event.gesture == BootGesture::FactoryReset) {
      return BootChoice::FactoryReset;
    }
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
      openjornada::kLittleFsPartitionLabel);
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
  // intact and any recoverable outbox remains usable on the next boot.
  return configStore.clear();
}

void showFactoryResetResult(bool success) {
  openjornada::drawProvisioningStatus(
      success ? "Datos borrados" : "No se pudo borrar",
      success ? "Reiniciando para configurar el terminal..."
              : "Los datos no se borraron por completo. Reinicia y repite.",
      !success);
}

bool runProvisioning(ConfigStore& store, BuildProfile profile,
                     const std::optional<DeviceConfig>& active,
                     size_t pendingCount) {
  ProvisioningPortal portal(store, profile, active, pendingCount);
  const auto result = portal.run(
      [](const DeviceConfig&, std::string& displayError) {
        // Task 7 injects the protocol-v1 bootstrap transport here. Refusing the
        // candidate is safer than persisting credentials that the server has
        // not authenticated.
        displayError = "La comprobación del servidor aún no está disponible "
                       "en esta versión.";
        return false;
      });
  return result.saved;
}

size_t buttonIndex(Button button) {
  return static_cast<size_t>(button);
}

std::string maskUid(const std::string& uid) {
  const size_t suffixLength = std::min<size_t>(4, uid.size());
  return "****" + uid.substr(uid.size() - suffixLength);
}

void drawStaticScreen() {
  auto& display = M5.Display;
  display.fillScreen(TFT_BLACK);
  display.fillRect(0, 0, 107, 8, TFT_RED);
  display.fillRect(107, 0, 106, 8, TFT_GREEN);
  display.fillRect(213, 0, 107, 8, TFT_BLUE);
  display.setTextDatum(top_left);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.setTextSize(2);
  display.drawString("OpenJornada", 12, 15);
  display.setTextSize(1);
  display.setTextColor(TFT_YELLOW, TFT_BLACK);
  display.drawString("DIAGNOSTICO FISICO", 12, 42);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.drawString("Pantalla: OK", 12, 62);
  display.drawString(rfidReady ? "RFID2: OK (0x28)" : "RFID2: NO DETECTADO",
                     12, 78);
  display.drawString("Pulsa A, B y C (sonara un tono)", 12, 101);
  display.drawString("Acerca un tag y retiralo 300 ms", 12, 116);
  display.drawFastHLine(12, 136, 296, TFT_DARKGREY);
}

void drawDynamicScreen() {
  auto& display = M5.Display;
  display.fillRect(0, 139, display.width(), 101, TFT_BLACK);
  display.setTextDatum(top_left);
  display.setTextSize(1);
  display.setTextColor(TFT_WHITE, TFT_BLACK);

  char line[80]{};
  snprintf(line, sizeof(line), "Botones  A:%lu  B:%lu  C:%lu",
           static_cast<unsigned long>(buttonCount[0]),
           static_cast<unsigned long>(buttonCount[1]),
           static_cast<unsigned long>(buttonCount[2]));
  display.drawString(line, 12, 145);

  snprintf(line, sizeof(line), "Tag: %s   Lecturas: %lu", scanMessage.c_str(),
           static_cast<unsigned long>(tagCount));
  display.drawString(line, 12, 165);

  snprintf(line, sizeof(line), "UID: %u bytes  %s",
           static_cast<unsigned>(uidBytes), maskedUid.c_str());
  display.drawString(line, 12, 185);
  display.setTextColor(TFT_CYAN, TFT_BLACK);
  display.drawString("Serie: 115200 | nunca muestra UID completo", 12, 211);
}

void handleButton(Button button, char label) {
  if (!hardware.pressed(button)) {
    return;
  }
  ++buttonCount[buttonIndex(button)];
  hardware.toneSuccess();
  Serial.printf("[OJ-DIAG] button=%c count=%lu\n", label,
                static_cast<unsigned long>(buttonCount[buttonIndex(button)]));
  drawDynamicScreen();
}

void logRfidDiagnostic(RfidPollStatus status,
                       const std::optional<std::string>& uid) {
  if (!rfidDiagnosticGate.shouldLog(status, millis())) {
    return;
  }

  if (status == RfidPollStatus::ReadFailed) {
    Serial.println("[OJ-DIAG] RFID scan=card_detected result=read_failed");
    scanMessage = "detectado / fallo lectura";
    drawDynamicScreen();
  } else if (status == RfidPollStatus::ReadSuccess && uid.has_value()) {
    Serial.printf("[OJ-DIAG] RFID scan=card_detected result=read_ok uid_bytes=%u\n",
                  static_cast<unsigned>(uid->size() / 2U));
    scanMessage = "leido correctamente";
  }
}

}  // namespace

void setup() {
  rfidReady = hardware.begin();

  ConfigStore configStore;
  CacheStore cacheStore;
  LittleFsOutboxStorage outboxStorage;
  const BuildProfile profile = openjornada::currentBuildProfile();
  ConfigError configError = ConfigError::Storage;
  std::optional<DeviceConfig> activeConfig =
      configStore.load(profile, &configError);

  bool filesystemReady = outboxStorage.begin();
  size_t pendingCount = 0;
  if (filesystemReady) {
    Outbox outbox(outboxStorage);
    if (outbox.begin() != OutboxError::None ||
        outbox.pendingCount(pendingCount) != OutboxError::None) {
      // Unknown must be treated as pending so a key rotation cannot orphan
      // actions that could still be recoverable.
      pendingCount = OutboxCodec::kCapacity;
    }
  } else {
    pendingCount = OutboxCodec::kCapacity;
  }

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

  if (!filesystemReady && !activeConfig.has_value()) {
    filesystemReady = initializeFirstUseStorage(cacheStore);
    if (filesystemReady) pendingCount = 0;
  }

  if (choice == BootChoice::Provisioning || !activeConfig.has_value()) {
    if (!filesystemReady && !activeConfig.has_value()) {
      openjornada::drawProvisioningStatus(
          "Inicialización necesaria",
          "No se borró ningún dato. Para preparar la memoria: reinicia con el "
          "botón lateral, mantén A+B+C 10 s, suelta todos y después mantén "
          "SOLO C 5 s.",
          true);
      terminalBlocked = true;
      return;
    }
    if (runProvisioning(configStore, profile, activeConfig, pendingCount)) {
      delay(800);
      ESP.restart();
    }
    if (!activeConfig.has_value()) {
      terminalBlocked = true;
      return;
    }
  }

  Serial.println("[OJ-DIAG] boot diagnostic=physical");
  Serial.printf("[OJ-DIAG] RFID2=%s address=0x28 SDA=21 SCL=22\n",
                rfidReady ? "OK" : "MISSING");

  drawStaticScreen();
  drawDynamicScreen();
  if (rfidReady) {
    hardware.toneSuccess();
  } else {
    hardware.toneError();
  }
}

void loop() {
  if (terminalBlocked) {
    hardware.update();
    delay(20);
    return;
  }
  hardware.update();
  handleButton(Button::A, 'A');
  handleButton(Button::B, 'B');
  handleButton(Button::C, 'C');

  const auto uid = hardware.pollUid();
  const bool present = hardware.tagPresent();
  logRfidDiagnostic(hardware.rfidPollStatus(), uid);
  bool redraw = false;

  if (uid.has_value() && uidGate.accept(*uid, present, millis())) {
    ++tagCount;
    uidBytes = uid->size() / 2U;
    maskedUid = maskUid(*uid);
    hardware.toneSuccess();
    Serial.printf("[OJ-DIAG] tag count=%lu uid_bytes=%u\n",
                  static_cast<unsigned long>(tagCount),
                  static_cast<unsigned>(uidBytes));
    redraw = true;
  } else if (!uid.has_value()) {
    uidGate.accept("", present, millis());
  }

  if (redraw) {
    drawDynamicScreen();
  }
  delay(20);
}
