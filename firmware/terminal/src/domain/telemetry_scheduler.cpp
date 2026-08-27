#include "openjornada/telemetry_scheduler.hpp"

#include <cstdint>

namespace openjornada {

bool TelemetryScheduler::due(uint32_t nowMs, bool connected, bool primaryBusy,
                             bool telemetryBusy) const {
  if (!connected || primaryBusy || telemetryBusy) return false;
  if (!scheduledOnce_) return true;
  return static_cast<int32_t>(nowMs - nextAtMs_) >= 0;
}

void TelemetryScheduler::markEnqueued(uint32_t nowMs) {
  scheduledOnce_ = true;
  nextAtMs_ = nowMs + intervalMs_;
}

}  // namespace openjornada
