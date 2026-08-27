#pragma once

#include <string_view>

#define OPENJORNADA_TERMINAL_VERSION_LITERAL "1.1.0"

namespace openjornada {

inline constexpr std::string_view kTerminalFirmwareVersion =
    OPENJORNADA_TERMINAL_VERSION_LITERAL;
inline constexpr std::string_view kTerminalClientVersion =
    "m5stack-" OPENJORNADA_TERMINAL_VERSION_LITERAL;
inline constexpr std::string_view kTerminalUserAgent =
    "OpenJornada-M5/" OPENJORNADA_TERMINAL_VERSION_LITERAL;

}  // namespace openjornada

#undef OPENJORNADA_TERMINAL_VERSION_LITERAL
