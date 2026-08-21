#pragma once

#include <cstdint>

namespace openjornada {

enum class RfidPollStatus { Unavailable, NoNewCard, ReadFailed, ReadSuccess };

class RfidDiagnosticGate {
 public:
  explicit RfidDiagnosticGate(uint32_t failureIntervalMs);

  bool shouldLog(RfidPollStatus status, uint32_t nowMs);

 private:
  uint32_t failureIntervalMs_;
  RfidPollStatus lastStatus_ = RfidPollStatus::Unavailable;
  uint32_t lastFailureLogMs_ = 0;
  bool failureLogged_ = false;
};

}  // namespace openjornada
