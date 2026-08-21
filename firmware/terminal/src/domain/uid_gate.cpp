#include "openjornada/uid_gate.hpp"

namespace openjornada {

UidGate::UidGate(uint32_t removalMs) : removalMs_(removalMs) {}

bool UidGate::accept(std::string_view uid, bool present, uint32_t nowMs) {
  if (!present) {
    if (!absentTimerRunning_) {
      absentSinceMs_ = nowMs;
      absentTimerRunning_ = true;
    }
    if (nowMs - absentSinceMs_ >= removalMs_) {
      lastUid_.clear();
    }
    return false;
  }

  if (absentTimerRunning_ && nowMs - absentSinceMs_ >= removalMs_) {
    lastUid_.clear();
  }
  absentTimerRunning_ = false;

  if (uid.empty() || uid == lastUid_) {
    return false;
  }

  lastUid_.assign(uid);
  return true;
}

}  // namespace openjornada
