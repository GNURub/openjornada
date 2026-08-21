#pragma once

#include <cstdint>

namespace openjornada {

inline constexpr char kLittleFsMountPoint[] = "/littlefs";
inline constexpr char kLittleFsPartitionLabel[] = "littlefs";
inline constexpr uint8_t kLittleFsMaxOpenFiles = 10;

}  // namespace openjornada
