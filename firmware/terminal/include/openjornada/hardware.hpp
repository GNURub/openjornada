#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "openjornada/domain.hpp"
#include "openjornada/rfid_diagnostic.hpp"

namespace openjornada {

class Hardware {
 public:
  bool begin();
  void update();
  bool pressed(Button button) const;
  bool down(Button button) const;
  bool held(Button button, uint32_t milliseconds) const;
  std::optional<std::string> pollUid();
  bool tagPresent() const;
  RfidPollStatus rfidPollStatus() const;
  void toneSuccess();
  void toneError();

 private:
  bool readerAvailable_ = false;
  bool tagPresent_ = false;
  bool trackingTag_ = false;
  bool absenceTimerRunning_ = false;
  uint32_t absentSinceMs_ = 0;
  RfidPollStatus rfidPollStatus_ = RfidPollStatus::Unavailable;
};

}  // namespace openjornada
