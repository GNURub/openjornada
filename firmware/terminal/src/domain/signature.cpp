#include "openjornada/signature.hpp"

#include <array>
#include <cstdint>
#include <string_view>

#ifdef ARDUINO
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#endif

namespace openjornada {
namespace {

constexpr std::string_view kSigningDomain =
    "openjornada-terminal-signing-v1|";

const char* commandName(Command command) {
  switch (command) {
    case Command::ClockIn:
      return "clock_in";
    case Command::BreakStart:
      return "break_start";
    case Command::BreakEnd:
      return "break_end";
    case Command::ClockOut:
      return "clock_out";
  }
  return "";
}

#ifdef ARDUINO
SigningKey sha256(std::string_view input) {
  SigningKey output{};
  mbedtls_sha256_ret(reinterpret_cast<const unsigned char*>(input.data()),
                     input.size(), output.data(), 0);
  return output;
}

SigningKey hmacSha256(const SigningKey& key, std::string_view input) {
  SigningKey output{};
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return output;
  mbedtls_md_hmac(info, key.data(), key.size(),
                  reinterpret_cast<const unsigned char*>(input.data()),
                  input.size(), output.data());
  return output;
}
#else
// Straightforward FIPS 180-4 SHA-256 for deterministic native tests. Device
// builds use the ESP32's maintained mbedTLS implementation above. Keeping this
// small, self-contained reference implementation avoids a host-only dynamic
// crypto dependency while the shared Go vector verifies its byte contract.
class Sha256 {
 public:
  Sha256()
      : state_{0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
               0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U} {}

  void update(const uint8_t* data, size_t length) {
    for (size_t index = 0; index < length; ++index) {
      buffer_[bufferLength_++] = data[index];
      if (bufferLength_ == buffer_.size()) {
        transform(buffer_.data());
        bitLength_ += 512;
        bufferLength_ = 0;
      }
    }
  }

  SigningKey finish() {
    bitLength_ += static_cast<uint64_t>(bufferLength_) * 8U;
    buffer_[bufferLength_++] = 0x80U;
    if (bufferLength_ > 56) {
      while (bufferLength_ < 64) buffer_[bufferLength_++] = 0;
      transform(buffer_.data());
      bufferLength_ = 0;
    }
    while (bufferLength_ < 56) buffer_[bufferLength_++] = 0;
    for (size_t index = 0; index < 8; ++index) {
      buffer_[63 - index] =
          static_cast<uint8_t>((bitLength_ >> (index * 8U)) & 0xFFU);
    }
    transform(buffer_.data());

    SigningKey digest{};
    for (size_t word = 0; word < state_.size(); ++word) {
      for (size_t byte = 0; byte < 4; ++byte) {
        digest[word * 4 + byte] = static_cast<uint8_t>(
            (state_[word] >> (24U - byte * 8U)) & 0xFFU);
      }
    }
    return digest;
  }

 private:
  static uint32_t rotateRight(uint32_t value, unsigned count) {
    return (value >> count) | (value << (32U - count));
  }

  void transform(const uint8_t* block) {
    static constexpr std::array<uint32_t, 64> constants{
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
        0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
        0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
        0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
        0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
        0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
        0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
        0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
        0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
        0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
        0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
        0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
        0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
        0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};
    std::array<uint32_t, 64> words{};
    for (size_t index = 0; index < 16; ++index) {
      words[index] = static_cast<uint32_t>(block[index * 4]) << 24U |
                     static_cast<uint32_t>(block[index * 4 + 1]) << 16U |
                     static_cast<uint32_t>(block[index * 4 + 2]) << 8U |
                     static_cast<uint32_t>(block[index * 4 + 3]);
    }
    for (size_t index = 16; index < words.size(); ++index) {
      const uint32_t s0 = rotateRight(words[index - 15], 7) ^
                          rotateRight(words[index - 15], 18) ^
                          (words[index - 15] >> 3U);
      const uint32_t s1 = rotateRight(words[index - 2], 17) ^
                          rotateRight(words[index - 2], 19) ^
                          (words[index - 2] >> 10U);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }

    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (size_t index = 0; index < words.size(); ++index) {
      const uint32_t sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^
                            rotateRight(e, 25);
      const uint32_t choice = (e & f) ^ (~e & g);
      const uint32_t temp1 = h + sum1 + choice + constants[index] + words[index];
      const uint32_t sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^
                            rotateRight(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t temp2 = sum0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::array<uint32_t, 8> state_;
  std::array<uint8_t, 64> buffer_{};
  size_t bufferLength_ = 0;
  uint64_t bitLength_ = 0;
};

SigningKey sha256(std::string_view input) {
  Sha256 hash;
  hash.update(reinterpret_cast<const uint8_t*>(input.data()), input.size());
  return hash.finish();
}

SigningKey hmacSha256(const SigningKey& key, std::string_view input) {
  std::array<uint8_t, 64> innerPad{};
  std::array<uint8_t, 64> outerPad{};
  for (size_t index = 0; index < innerPad.size(); ++index) {
    const uint8_t value = index < key.size() ? key[index] : 0;
    innerPad[index] = value ^ 0x36U;
    outerPad[index] = value ^ 0x5cU;
  }
  Sha256 inner;
  inner.update(innerPad.data(), innerPad.size());
  inner.update(reinterpret_cast<const uint8_t*>(input.data()), input.size());
  const SigningKey innerDigest = inner.finish();
  Sha256 outer;
  outer.update(outerPad.data(), outerPad.size());
  outer.update(innerDigest.data(), innerDigest.size());
  return outer.finish();
}
#endif

std::string lowerHex(const SigningKey& bytes) {
  static constexpr char alphabet[] = "0123456789abcdef";
  std::string output(bytes.size() * 2, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    output[index * 2] = alphabet[bytes[index] >> 4U];
    output[index * 2 + 1] = alphabet[bytes[index] & 0x0FU];
  }
  return output;
}

}  // namespace

SigningKey deriveSigningKey(const std::string& token) {
  std::string material;
  material.reserve(kSigningDomain.size() + token.size());
  material.append(kSigningDomain);
  material.append(token);
  return sha256(material);
}

std::string canonicalAction(const std::string& terminalId,
                            const QueuedAction& action) {
  return terminalId + "|" + action.clientRequestId + "|" + action.uid + "|" +
         commandName(action.command) + "|" + action.deviceCapturedAt + "|" +
         action.appliedAt + "|" + action.clockSyncedAt + "|" +
         std::to_string(action.deviceSequence) + "|" + action.rebootId + "|" +
         action.previousLocalHash;
}

std::string signAction(const SigningKey& key, const std::string& canonical) {
  return lowerHex(hmacSha256(key, canonical));
}

}  // namespace openjornada
