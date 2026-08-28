#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace openjornada {

extern "C" const char kEmbeddedFirmwareMetadata[];

inline constexpr std::string_view kFirmwareMetadataPrefix{
    kEmbeddedFirmwareMetadata, 13};
inline constexpr size_t kFirmwareMetadataScanBytes = 256U * 1024U;
inline constexpr size_t kFirmwareMetadataJsonMaxBytes = 192;

struct FirmwareBuildMetadata {
  std::string board;
  uint8_t protocolVersion = 0;
  std::string firmwareVersion;
};

std::optional<FirmwareBuildMetadata> parseFirmwareBuildMetadata(
    const uint8_t* image, size_t size);

}  // namespace openjornada
