#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace openjornada {

class UidGate {
 public:
  explicit UidGate(uint32_t removalMs);

  bool accept(std::string_view uid, bool present, uint32_t nowMs);

 private:
  uint32_t removalMs_;
  uint32_t absentSinceMs_ = 0;
  bool absentTimerRunning_ = false;
  std::string lastUid_;
};

}  // namespace openjornada
