#include "openjornada/gesture.hpp"

namespace openjornada {
namespace {

constexpr uint32_t kProvisioningHoldMs = 5000;
constexpr uint32_t kFactoryRequestHoldMs = 10000;
constexpr uint32_t kFactoryConfirmHoldMs = 5000;

bool onlyAB(BootButtons buttons) {
  return buttons.a && buttons.b && !buttons.c;
}

bool allABC(BootButtons buttons) {
  return buttons.a && buttons.b && buttons.c;
}

bool onlyC(BootButtons buttons) {
  return !buttons.a && !buttons.b && buttons.c;
}

bool none(BootButtons buttons) {
  return !buttons.a && !buttons.b && !buttons.c;
}

}  // namespace

BootGestureEvent BootGestureDetector::update(BootButtons buttons,
                                              uint32_t elapsedMs) {
  if (state_ == State::AwaitFactoryRelease) {
    if (none(buttons)) {
      state_ = State::ConfirmFactory;
      resetConfirmation();
    }
    return {};
  }

  if (state_ == State::ConfirmFactory) {
    if (!onlyC(buttons)) {
      resetConfirmation();
      return {};
    }
    if (!confirmationTiming_) {
      confirmationTiming_ = true;
      confirmationStartedMs_ = elapsedMs;
      return {};
    }
    if (elapsedMs - confirmationStartedMs_ >= kFactoryConfirmHoldMs) {
      state_ = State::AwaitFactoryRelease;
      resetConfirmation();
      return {BootGesture::FactoryReset, pendingCount_};
    }
    return {};
  }

  if (allABC(buttons)) {
    provisioningEmitted_ = false;
    if (!comboTiming_ || combo_ != Combo::ABC) {
      comboTiming_ = true;
      combo_ = Combo::ABC;
      comboStartedMs_ = elapsedMs;
      return {};
    }
    if (elapsedMs - comboStartedMs_ >= kFactoryRequestHoldMs) {
      state_ = State::AwaitFactoryRelease;
      resetCombo();
      return {BootGesture::FactoryResetRequest, pendingCount_};
    }
    return {};
  }

  if (onlyAB(buttons)) {
    if (!comboTiming_ || combo_ != Combo::AB) {
      comboTiming_ = true;
      combo_ = Combo::AB;
      comboStartedMs_ = elapsedMs;
      provisioningEmitted_ = false;
      return {};
    }
    if (!provisioningEmitted_ &&
        elapsedMs - comboStartedMs_ >= kProvisioningHoldMs) {
      provisioningEmitted_ = true;
      return {BootGesture::Provisioning, pendingCount_};
    }
    return {};
  }

  resetCombo();
  return {};
}

bool BootGestureDetector::awaitingFactoryConfirmation() const {
  return state_ != State::BootCombos;
}

void BootGestureDetector::resetCombo() {
  comboTiming_ = false;
  combo_ = Combo::None;
  comboStartedMs_ = 0;
  provisioningEmitted_ = false;
}

void BootGestureDetector::resetConfirmation() {
  confirmationTiming_ = false;
  confirmationStartedMs_ = 0;
}

}  // namespace openjornada
