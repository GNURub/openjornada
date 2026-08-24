#pragma once

#include <cstddef>
#include <cstdint>

namespace openjornada {

struct BootButtons {
  bool a = false;
  bool b = false;
  bool c = false;
};

enum class BootGesture {
  None,
  Provisioning,
  FactoryResetRequest,
  FactoryReset,
};

struct BootGestureEvent {
  BootGesture gesture = BootGesture::None;
  size_t pendingCount = 0;
};

class BootGestureDetector {
 public:
  explicit BootGestureDetector(size_t pendingCount = 0)
      : pendingCount_(pendingCount) {}

  BootGestureEvent update(BootButtons buttons, uint32_t elapsedMs);
  bool awaitingFactoryConfirmation() const;

 private:
  enum class State { BootCombos, AwaitFactoryRelease, ConfirmFactory };
  enum class Combo { None, AB, ABC };

  void resetCombo();
  void resetConfirmation();

  size_t pendingCount_ = 0;
  State state_ = State::BootCombos;
  bool comboTiming_ = false;
  Combo combo_ = Combo::None;
  uint32_t comboStartedMs_ = 0;
  bool confirmationTiming_ = false;
  uint32_t confirmationStartedMs_ = 0;
  bool provisioningEmitted_ = false;
};

struct RuntimeProvisioningDecision {
  bool suppressButtons = false;
  bool dispatchA = false;
  bool dispatchB = false;
  bool showCountdown = false;
  bool restoreScreen = false;
  bool provisioningRequested = false;
  uint8_t secondsRemaining = 0;
};

// Reserves A+B as an always-available recovery gesture without allowing either
// press to leak into attendance actions. Individual A/B presses are delayed by
// a short chord-detection window and otherwise retain their normal behaviour.
class RuntimeProvisioningGesture {
 public:
  RuntimeProvisioningDecision update(BootButtons down, BootButtons pressed,
                                     bool applicationInputAllowed,
                                     uint32_t nowMs);

 private:
  enum class State { Ready, HoldingAB, SuppressUntilRelease, Triggered };

  void clearPending();
  RuntimeProvisioningDecision startHolding(uint32_t nowMs);
  RuntimeProvisioningDecision holdingDecision(uint32_t nowMs);

  State state_ = State::Ready;
  bool pendingA_ = false;
  bool pendingB_ = false;
  uint32_t pendingAAtMs_ = 0;
  uint32_t pendingBAtMs_ = 0;
  uint32_t holdStartedMs_ = 0;
  bool individualSequenceCommitted_ = false;
};

struct ProvisioningCancelDecision {
  bool showCountdown = false;
  bool restoreScreen = false;
  bool cancelRequested = false;
  uint8_t secondsRemaining = 0;
};

// Consumes the buttons held to enter provisioning, then reserves a fresh
// three-second C hold as a non-destructive exit from the captive portal.
class ProvisioningCancelGesture {
 public:
  ProvisioningCancelDecision update(BootButtons down, uint32_t nowMs);

 private:
  enum class State { AwaitRelease, Ready, HoldingC, Triggered };

  State state_ = State::AwaitRelease;
  uint32_t holdStartedMs_ = 0;
};

}  // namespace openjornada
