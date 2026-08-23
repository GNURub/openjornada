#include "openjornada/timezone.hpp"

namespace openjornada {

const char* posixTimezone(std::string_view timezone) {
  if (timezone == "Europe/Madrid") {
    return "CET-1CEST,M3.5.0,M10.5.0/3";
  }
  if (timezone == "Atlantic/Canary") {
    return "WET0WEST,M3.5.0/1,M10.5.0";
  }
  return nullptr;
}

}  // namespace openjornada
