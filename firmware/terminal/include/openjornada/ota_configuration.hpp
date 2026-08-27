#pragma once

#include <array>
#include <cstdint>
#include <string>

namespace openjornada {

inline constexpr const char* kProductionOtaManifestUrl =
    "https://github.com/GNURub/openjornada/releases/latest/download/"
    "openjornada-m5stack-manifest.json";

inline constexpr std::array<uint8_t, 32> kProductionOtaPublicKey{
    0x9e, 0x2c, 0x9d, 0xc7, 0xa0, 0xe7, 0xb4, 0xef,
    0xf0, 0x7a, 0xdf, 0x16, 0x06, 0x14, 0x81, 0x49,
    0x05, 0xda, 0x8a, 0xaf, 0x05, 0xa3, 0x0d, 0xf7,
    0x94, 0xa6, 0x9e, 0x09, 0x45, 0x94, 0x8c, 0xc9,
};

bool decodeOtaPublicKeyHex(const char* encoded,
                           std::array<uint8_t, 32>& output);

}  // namespace openjornada
