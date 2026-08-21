#include <Arduino.h>
#include <M5Unified.h>

#include <algorithm>
#include <cstdint>
#include <string>

#include "openjornada/domain.hpp"
#include "openjornada/hardware.hpp"
#include "openjornada/uid_gate.hpp"

namespace {

using openjornada::Button;
using openjornada::Hardware;
using openjornada::RfidPollStatus;
using openjornada::UidGate;

Hardware hardware;
UidGate uidGate{300};
bool rfidReady = false;
uint32_t tagCount = 0;
uint32_t buttonCount[3]{};
std::string maskedUid = "esperando";
std::string scanMessage = "esperando tag";
size_t uidBytes = 0;
RfidPollStatus lastLoggedRfidStatus = RfidPollStatus::Unavailable;
bool rfidFailureLogged = false;
uint32_t lastRfidFailureLogMs = 0;

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
  if (status == lastLoggedRfidStatus) {
    return;
  }
  lastLoggedRfidStatus = status;

  if (status == RfidPollStatus::ReadFailed) {
    if (rfidFailureLogged && millis() - lastRfidFailureLogMs < 2000) {
      return;
    }
    rfidFailureLogged = true;
    lastRfidFailureLogMs = millis();
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
