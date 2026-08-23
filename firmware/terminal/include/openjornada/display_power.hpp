#pragma once

#include <cstdint>

namespace openjornada {

inline constexpr uint32_t kDisplayIdleMs = 10U * 60U * 1000U;

enum class DisplayPowerEvent { None, Sleep, Wake };

struct DisplayActivity {
  bool buttonPressed = false;
  bool buttonDown = false;
  bool tagScanned = false;
};

struct DisplayPowerDecision {
  DisplayPowerEvent power = DisplayPowerEvent::None;
  bool dispatchButtons = true;
  bool dispatchTag = false;
};

class DisplayPowerPolicy {
 public:
  explicit DisplayPowerPolicy(uint32_t startedAtMs);

  DisplayPowerDecision update(uint32_t nowMs,
                              const DisplayActivity& activity);
  void reset(uint32_t nowMs);
  bool sleeping() const;

 private:
  uint32_t lastActivityMs_;
  bool sleeping_ = false;
  bool suppressButtonsUntilReleased_ = false;
};

}  // namespace openjornada
