#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "openjornada/domain.hpp"

namespace openjornada {

class Hardware {
 public:
  bool begin();
  void update();
  bool pressed(Button button) const;
  bool held(Button button, uint32_t milliseconds) const;
  std::optional<std::string> pollUid();
  bool tagPresent() const;
  void toneSuccess();
  void toneError();

 private:
  bool readerAvailable_ = false;
  bool tagPresent_ = false;
};

}  // namespace openjornada
