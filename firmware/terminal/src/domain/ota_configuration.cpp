#include "openjornada/ota_configuration.hpp"

#include <cstddef>
#include <cstring>

namespace openjornada {
namespace {

int hexValue(char byte) {
  if (byte >= '0' && byte <= '9') return byte - '0';
  if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
  if (byte >= 'A' && byte <= 'F') return byte - 'A' + 10;
  return -1;
}

}  // namespace

bool decodeOtaPublicKeyHex(const char* encoded,
                           std::array<uint8_t, 32>& output) {
  if (encoded == nullptr || std::strlen(encoded) != output.size() * 2U) {
    return false;
  }
  for (size_t index = 0; index < output.size(); ++index) {
    const int high = hexValue(encoded[index * 2]);
    const int low = hexValue(encoded[index * 2 + 1]);
    if (high < 0 || low < 0) return false;
    output[index] = static_cast<uint8_t>((high << 4) | low);
  }
  return true;
}

}  // namespace openjornada
