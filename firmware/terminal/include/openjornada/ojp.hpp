#pragma once

#include <cstddef>
#include <optional>
#include <string_view>

#include "openjornada/config.hpp"

namespace openjornada {

inline constexpr size_t kMaxOjpInputBytes = 600;

enum class OjpError {
  None,
  MissingPayload,
  TooLarge,
  InvalidEncoding,
  InvalidUtf8,
  InvalidContract,
  InvalidConfig,
};

struct OjpDecodeResult {
  OjpError error = OjpError::MissingPayload;
  std::optional<DeviceConfig> config;
};

OjpDecodeResult decodeOjpPayload(std::string_view input,
                                BuildProfile profile);

}  // namespace openjornada
