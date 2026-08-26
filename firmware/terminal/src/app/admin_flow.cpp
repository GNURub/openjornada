#include "openjornada/admin_flow.hpp"

#include <utility>

namespace openjornada {

bool AdminFlow::holdCombo(bool aDown, bool bDown, bool cDown,
                          uint32_t nowMs) {
  const bool exactCombo = aDown && cDown && !bDown;
  if (!exactCombo) {
    comboActive_ = false;
    comboTriggered_ = false;
    comboStartedMs_ = 0;
    return false;
  }
  if (!comboActive_) {
    comboActive_ = true;
    comboStartedMs_ = nowMs;
    return false;
  }
  if (!comboTriggered_ && nowMs - comboStartedMs_ >= kActivationHoldMs) {
    comboTriggered_ = true;
    return true;
  }
  return false;
}

std::optional<std::string> AdminFlow::updatePin(Button button,
                                                uint32_t nowMs) {
  touch(nowMs);
  if (button == Button::A) {
    digits_[digitIndex_] = static_cast<uint8_t>((digits_[digitIndex_] + 9U) % 10U);
    return std::nullopt;
  }
  if (button == Button::C) {
    digits_[digitIndex_] = static_cast<uint8_t>((digits_[digitIndex_] + 1U) % 10U);
    return std::nullopt;
  }
  if (digitIndex_ < digits_.size() - 1U) {
    ++digitIndex_;
    return std::nullopt;
  }
  std::string pin;
  pin.reserve(digits_.size());
  for (const uint8_t digit : digits_) pin.push_back(static_cast<char>('0' + digit));
  return pin;
}

std::string AdminFlow::pinDisplay() const {
  std::string display(digits_.size(), '_');
  for (size_t index = 0; index <= digitIndex_ && index < digits_.size(); ++index) {
    display[index] = static_cast<char>('0' + digits_[index]);
  }
  return display;
}

void AdminFlow::beginMode(uint32_t nowMs) {
  capability_.clear();
  resetPin();
  modeActive_ = true;
  lastActivityMs_ = nowMs;
}

bool AdminFlow::setSession(std::string capability, uint32_t nowMs) {
  if (capability.size() <= 9U || capability.size() > 160U ||
      capability.compare(0, 9, "ojtadmin_") != 0) {
    return false;
  }
  const bool alreadyActive = modeActive_;
  capability_ = std::move(capability);
  modeActive_ = true;
  if (!alreadyActive) lastActivityMs_ = nowMs;
  return true;
}

void AdminFlow::touch(uint32_t nowMs) { lastActivityMs_ = nowMs; }

bool AdminFlow::expire(uint32_t nowMs, bool networkConnected) {
  if (!modeActive_) return false;
  if (networkConnected && nowMs - lastActivityMs_ < kSessionIdleMs) {
    return false;
  }
  clearSession();
  return true;
}

void AdminFlow::clearSession() {
  capability_.clear();
  lastActivityMs_ = 0;
  modeActive_ = false;
  resetPin();
}

void AdminFlow::resetPin() {
  digits_.fill(0);
  digitIndex_ = 0;
}

}  // namespace openjornada
