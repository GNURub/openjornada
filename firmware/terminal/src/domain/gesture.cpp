#include "openjornada/gesture.hpp"

namespace openjornada {
namespace {

constexpr uint32_t kProvisioningHoldMs = 5000;
constexpr uint32_t kFactoryRequestHoldMs = 10000;
constexpr uint32_t kFactoryConfirmHoldMs = 5000;
constexpr uint32_t kRuntimeChordGraceMs = 300;
constexpr uint32_t kProvisioningCancelHoldMs = 3000;

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

RuntimeProvisioningDecision RuntimeProvisioningGesture::update(
    BootButtons down, BootButtons pressed, bool applicationInputAllowed,
    uint32_t nowMs) {
  const bool exactAB = onlyAB(down);

  if (!down.a && !down.b) individualSequenceCommitted_ = false;

  if (state_ == State::Triggered) {
    RuntimeProvisioningDecision decision;
    decision.suppressButtons = true;
    decision.provisioningRequested = true;
    return decision;
  }

  if (state_ == State::HoldingAB) {
    if (exactAB) return holdingDecision(nowMs);
    state_ = State::SuppressUntilRelease;
    clearPending();
    RuntimeProvisioningDecision decision;
    decision.suppressButtons = true;
    return decision;
  }

  if (state_ == State::SuppressUntilRelease) {
    RuntimeProvisioningDecision decision;
    if (!down.a && !down.b) {
      state_ = State::Ready;
      decision.restoreScreen = true;
    } else {
      decision.suppressButtons = true;
    }
    return decision;
  }

  if (exactAB && !individualSequenceCommitted_) return startHolding(nowMs);
  if (down.a && down.b && !individualSequenceCommitted_) {
    // A+B+C is deliberately boot-only. Suppress it at runtime so a failed
    // recovery attempt cannot become an attendance action.
    state_ = State::SuppressUntilRelease;
    clearPending();
    RuntimeProvisioningDecision decision;
    decision.suppressButtons = true;
    return decision;
  }

  RuntimeProvisioningDecision decision;
  if (!applicationInputAllowed) {
    clearPending();
    return decision;
  }

  if (pressed.a) {
    pendingA_ = true;
    pendingAAtMs_ = nowMs;
  }
  if (pressed.b) {
    pendingB_ = true;
    pendingBAtMs_ = nowMs;
  }
  if (pendingA_ &&
      (!down.a || nowMs - pendingAAtMs_ >= kRuntimeChordGraceMs)) {
    decision.dispatchA = true;
    pendingA_ = false;
    individualSequenceCommitted_ = true;
  }
  if (pendingB_ &&
      (!down.b || nowMs - pendingBAtMs_ >= kRuntimeChordGraceMs)) {
    decision.dispatchB = true;
    pendingB_ = false;
    individualSequenceCommitted_ = true;
  }
  return decision;
}

void RuntimeProvisioningGesture::clearPending() {
  pendingA_ = false;
  pendingB_ = false;
  pendingAAtMs_ = 0;
  pendingBAtMs_ = 0;
}

RuntimeProvisioningDecision RuntimeProvisioningGesture::startHolding(
    uint32_t nowMs) {
  state_ = State::HoldingAB;
  holdStartedMs_ = nowMs;
  clearPending();
  return holdingDecision(nowMs);
}

RuntimeProvisioningDecision RuntimeProvisioningGesture::holdingDecision(
    uint32_t nowMs) {
  RuntimeProvisioningDecision decision;
  decision.suppressButtons = true;
  const uint32_t elapsed = nowMs - holdStartedMs_;
  if (elapsed >= kProvisioningHoldMs) {
    state_ = State::Triggered;
    decision.provisioningRequested = true;
    return decision;
  }
  decision.showCountdown = true;
  decision.secondsRemaining = static_cast<uint8_t>(
      (kProvisioningHoldMs - elapsed + 999U) / 1000U);
  return decision;
}

ProvisioningCancelDecision ProvisioningCancelGesture::update(
    BootButtons down, uint32_t nowMs) {
  const bool anyDown = down.a || down.b || down.c;
  const bool onlyC = !down.a && !down.b && down.c;
  ProvisioningCancelDecision decision;

  if (state_ == State::Triggered) {
    decision.cancelRequested = true;
    return decision;
  }
  if (state_ == State::AwaitRelease) {
    if (!anyDown) state_ = State::Ready;
    return decision;
  }
  if (state_ == State::HoldingC) {
    if (!onlyC) {
      state_ = anyDown ? State::AwaitRelease : State::Ready;
      decision.restoreScreen = true;
      return decision;
    }
    const uint32_t elapsed = nowMs - holdStartedMs_;
    if (elapsed >= kProvisioningCancelHoldMs) {
      state_ = State::Triggered;
      decision.cancelRequested = true;
      return decision;
    }
    decision.showCountdown = true;
    decision.secondsRemaining = static_cast<uint8_t>(
        (kProvisioningCancelHoldMs - elapsed + 999U) / 1000U);
    return decision;
  }
  if (onlyC) {
    state_ = State::HoldingC;
    holdStartedMs_ = nowMs;
    decision.showCountdown = true;
    decision.secondsRemaining = 3;
  }
  return decision;
}

MaintenanceConfirmationDecision MaintenanceConfirmationGesture::update(
    BootButtons buttons, uint32_t nowMs) {
  const bool anyDown = buttons.a || buttons.b || buttons.c;
  const bool exactC = onlyC(buttons);

  if (state_ == State::Done) return {terminalState_, 0};
  if (state_ == State::AwaitFirstUpdate) {
    requestedAtMs_ = nowMs;
    state_ = anyDown ? State::AwaitRelease : State::Ready;
    return {ConfirmationState::Waiting, 0};
  }
  if (nowMs - requestedAtMs_ >= timeoutMs_) {
    return terminal(ConfirmationState::TimedOut);
  }
  if (state_ == State::AwaitRelease) {
    if (!anyDown) state_ = State::Ready;
    return {ConfirmationState::Waiting, 0};
  }
  if (state_ == State::Ready) {
    if (!anyDown) return {ConfirmationState::Waiting, 0};
    if (!exactC) return terminal(ConfirmationState::Cancelled);
    state_ = State::HoldingC;
    holdStartedMs_ = nowMs;
  } else if (!exactC) {
    return terminal(ConfirmationState::Cancelled);
  }

  const uint32_t elapsed = nowMs - holdStartedMs_;
  if (elapsed >= holdMs_) return terminal(ConfirmationState::Confirmed);
  return {ConfirmationState::Counting,
          static_cast<uint8_t>((holdMs_ - elapsed + 999U) / 1000U)};
}

MaintenanceConfirmationDecision MaintenanceConfirmationGesture::cancel() {
  return terminal(ConfirmationState::Cancelled);
}

MaintenanceConfirmationDecision MaintenanceConfirmationGesture::terminal(
    ConfirmationState state) {
  state_ = State::Done;
  terminalState_ = state;
  return {state, 0};
}

}  // namespace openjornada
