#pragma once

#include <cstdint>

namespace openjornada {

class TelemetryScheduler {
 public:
  explicit TelemetryScheduler(uint32_t intervalMs = 15000U)
      : intervalMs_(intervalMs) {}

  bool due(uint32_t nowMs, bool connected, bool primaryBusy,
           bool telemetryBusy) const;
  void markEnqueued(uint32_t nowMs);

 private:
  uint32_t intervalMs_;
  uint32_t nextAtMs_ = 0;
  bool scheduledOnce_ = false;
};

}  // namespace openjornada
