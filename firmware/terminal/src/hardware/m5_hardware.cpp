#include "openjornada/hardware.hpp"

#include <Arduino.h>
#include <M5Unified.h>
#include <MFRC522_I2C.h>
#include <Wire.h>

namespace openjornada {
namespace {

constexpr uint8_t kRfidAddress = 0x28;
constexpr int kSdaPin = 21;
constexpr int kSclPin = 22;

MFRC522_I2C reader{kRfidAddress, -1, &Wire};

const m5::Button_Class& m5Button(Button button) {
  switch (button) {
    case Button::A:
      return M5.BtnA;
    case Button::B:
      return M5.BtnB;
    case Button::C:
      return M5.BtnC;
  }
  return M5.BtnA;
}

std::string normalizedUid(const MFRC522_I2C::Uid& uid) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string value;
  value.reserve(uid.size * 2U);
  for (uint8_t index = 0; index < uid.size; ++index) {
    const uint8_t byte = uid.uidByte[index];
    value.push_back(kHex[byte >> 4U]);
    value.push_back(kHex[byte & 0x0FU]);
  }
  return value;
}

}  // namespace

bool Hardware::begin() {
  auto config = M5.config();
  config.serial_baudrate = 115200;
  config.internal_mic = false;
  config.internal_spk = true;
  config.output_power = true;
  M5.begin(config);

  M5.Display.setRotation(1);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.fillScreen(TFT_BLACK);

  Wire.begin(kSdaPin, kSclPin);
  Wire.beginTransmission(kRfidAddress);
  readerAvailable_ = Wire.endTransmission() == 0;
  if (readerAvailable_) {
    reader.PCD_Init();
  }
  tagPresent_ = false;
  return readerAvailable_;
}

void Hardware::update() { M5.update(); }

bool Hardware::pressed(Button button) const {
  return m5Button(button).wasPressed();
}

bool Hardware::held(Button button, uint32_t milliseconds) const {
  return m5Button(button).pressedFor(milliseconds);
}

std::optional<std::string> Hardware::pollUid() {
  if (!readerAvailable_) {
    tagPresent_ = false;
    return std::nullopt;
  }

  byte answer[2]{};
  byte answerSize = sizeof(answer);
  const byte status = reader.PICC_WakeupA(answer, &answerSize);
  tagPresent_ = status == MFRC522_I2C::STATUS_OK ||
                status == MFRC522_I2C::STATUS_COLLISION;
  if (!tagPresent_ || !reader.PICC_ReadCardSerial()) {
    return std::nullopt;
  }

  return normalizedUid(reader.uid);
}

bool Hardware::tagPresent() const { return tagPresent_; }

void Hardware::toneSuccess() { M5.Speaker.tone(1200.0F, 90); }

void Hardware::toneError() {
  M5.Speaker.tone(320.0F, 180);
}

}  // namespace openjornada
