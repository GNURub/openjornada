#include "openjornada/rfid_diagnostic.hpp"

namespace openjornada {

RfidDiagnosticGate::RfidDiagnosticGate(uint32_t failureIntervalMs)
    : failureIntervalMs_(failureIntervalMs) {}

bool RfidDiagnosticGate::shouldLog(RfidPollStatus status, uint32_t nowMs) {
  if (status == lastStatus_) {
    return false;
  }

  if (status == RfidPollStatus::ReadFailed) {
    if (failureLogged_ && nowMs - lastFailureLogMs_ < failureIntervalMs_) {
      return false;
    }
    failureLogged_ = true;
    lastFailureLogMs_ = nowMs;
    lastStatus_ = status;
    return true;
  }

  lastStatus_ = status;
  return status == RfidPollStatus::ReadSuccess;
}

}  // namespace openjornada
