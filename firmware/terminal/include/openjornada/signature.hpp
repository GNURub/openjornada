#pragma once

#include <array>
#include <cstdint>
#include <string>

#include "openjornada/outbox.hpp"

namespace openjornada {

using SigningKey = std::array<uint8_t, 32>;

SigningKey deriveSigningKey(const std::string& token);
std::string canonicalAction(const std::string& terminalId,
                            const QueuedAction& action);
std::string signAction(const SigningKey& key, const std::string& canonical);

}  // namespace openjornada
