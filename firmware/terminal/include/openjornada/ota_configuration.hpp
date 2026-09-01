#pragma once

#include <array>
#include <cstdint>
#include <string>

namespace openjornada {

inline constexpr const char* kProductionOtaManifestUrl =
    "https://github.com/GNURub/openjornada/releases/latest/download/"
    "openjornada-m5stack-manifest.json";

inline constexpr std::array<uint8_t, 32> kProductionOtaPublicKey{
    0x4f, 0xbd, 0xbf, 0x77, 0xc4, 0xea, 0x6e, 0x71,
    0xc6, 0x47, 0x73, 0x8a, 0x12, 0x22, 0x77, 0xbe,
    0x3b, 0x25, 0xee, 0x7f, 0x2d, 0xb7, 0xc4, 0x59,
    0x99, 0xa8, 0x75, 0x95, 0xd0, 0x49, 0xde, 0xc4,
};

bool decodeOtaPublicKeyHex(const char* encoded,
                           std::array<uint8_t, 32>& output);

}  // namespace openjornada
