#include "openjornada/display_power.hpp"

namespace openjornada {

DisplayPowerPolicy::DisplayPowerPolicy(uint32_t startedAtMs)
    : lastActivityMs_(startedAtMs) {}

DisplayPowerDecision DisplayPowerPolicy::update(
    uint32_t nowMs, const DisplayActivity& activity) {
  DisplayPowerDecision decision;
  const bool buttonActivity = activity.buttonPressed || activity.buttonDown;
  const bool physicalActivity = buttonActivity || activity.tagScanned;

  if (physicalActivity) {
    lastActivityMs_ = nowMs;
    if (sleeping_) {
      sleeping_ = false;
      decision.power = DisplayPowerEvent::Wake;
      if (buttonActivity) suppressButtonsUntilReleased_ = true;
    }
  } else if (!sleeping_ && nowMs - lastActivityMs_ >= kDisplayIdleMs) {
    sleeping_ = true;
    decision.power = DisplayPowerEvent::Sleep;
  }

  if (suppressButtonsUntilReleased_) {
    decision.dispatchButtons = false;
    if (!activity.buttonDown) suppressButtonsUntilReleased_ = false;
  }
  decision.dispatchTag = activity.tagScanned;
  return decision;
}

void DisplayPowerPolicy::reset(uint32_t nowMs) {
  lastActivityMs_ = nowMs;
  sleeping_ = false;
  suppressButtonsUntilReleased_ = false;
}

bool DisplayPowerPolicy::sleeping() const { return sleeping_; }

}  // namespace openjornada
