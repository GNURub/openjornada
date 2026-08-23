#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include "openjornada/domain.hpp"

namespace openjornada {

class AdminFlow {
 public:
  static constexpr uint32_t kActivationHoldMs = 3000U;
  static constexpr uint32_t kSessionIdleMs = 5U * 60U * 1000U;

  bool holdCombo(bool aDown, bool bDown, bool cDown, uint32_t nowMs);
  std::optional<std::string> updatePin(Button button, uint32_t nowMs);
  std::string pinDisplay() const;

  bool setSession(std::string capability, uint32_t nowMs);
  void touch(uint32_t nowMs);
  bool expire(uint32_t nowMs, bool networkConnected);
  void clearSession();
  bool hasSession() const { return !capability_.empty(); }
  const std::string& capability() const { return capability_; }
  bool canAdminister(bool networkConnected) const {
    return networkConnected && hasSession();
  }
  void resetPin();

 private:
  std::array<uint8_t, 4> digits_{};
  size_t digitIndex_ = 0;
  uint32_t comboStartedMs_ = 0;
  uint32_t lastActivityMs_ = 0;
  bool comboActive_ = false;
  bool comboTriggered_ = false;
  std::string capability_;
};

}  // namespace openjornada
