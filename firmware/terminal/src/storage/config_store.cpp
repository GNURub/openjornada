#include "openjornada/config.hpp"

#include <array>
#include <cstdint>
#include <vector>

#ifdef ARDUINO
#include <Preferences.h>
#endif

namespace openjornada {
namespace {

bool invalidText(std::string_view value) {
  for (const unsigned char byte : value) {
    if (byte == 0 || byte == '\r' || byte == '\n') return true;
  }
  return false;
}

#ifdef ARDUINO
constexpr std::array<uint8_t, 4> kConfigMagic{'O', 'J', 'C', 'F'};
constexpr uint8_t kConfigVersion = 1;
constexpr const char* kPreferencesNamespace = "openjornada";
constexpr const char* kConfigKey = "config_blob";
constexpr size_t kConfigHeaderSize = 11;
constexpr size_t kConfigCrcSize = 4;
constexpr size_t kMaxConfigBlobSize = kConfigHeaderSize + kMaxSsidBytes +
                                      kMaxWifiPasswordBytes +
                                      kMaxBaseUrlBytes +
                                      kMaxTerminalTokenBytes + kConfigCrcSize;

void appendU16(std::vector<uint8_t>& output, uint16_t value) {
  output.push_back(static_cast<uint8_t>(value & 0xFFU));
  output.push_back(static_cast<uint8_t>((value >> 8U) & 0xFFU));
}

void appendU32(std::vector<uint8_t>& output, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    output.push_back(static_cast<uint8_t>((value >> shift) & 0xFFU));
  }
}

uint16_t readU16(const std::vector<uint8_t>& input, size_t offset) {
  return static_cast<uint16_t>(input[offset]) |
         static_cast<uint16_t>(input[offset + 1]) << 8U;
}

uint32_t readU32(const std::vector<uint8_t>& input, size_t offset) {
  uint32_t value = 0;
  for (unsigned shift = 0; shift < 32; shift += 8) {
    value |= static_cast<uint32_t>(input[offset + shift / 8]) << shift;
  }
  return value;
}

uint32_t crc32(const uint8_t* bytes, size_t length) {
  uint32_t crc = 0xFFFFFFFFU;
  for (size_t index = 0; index < length; ++index) {
    crc ^= bytes[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      const uint32_t mask = 0U - (crc & 1U);
      crc = (crc >> 1U) ^ (0xEDB88320U & mask);
    }
  }
  return ~crc;
}

std::vector<uint8_t> encodeConfig(const DeviceConfig& config) {
  std::vector<uint8_t> output;
  output.reserve(kConfigHeaderSize + config.ssid.size() +
                 config.wifiPassword.size() + config.baseUrl.size() +
                 config.terminalToken.size() + kConfigCrcSize);
  output.insert(output.end(), kConfigMagic.begin(), kConfigMagic.end());
  output.push_back(kConfigVersion);
  output.push_back(config.soundEnabled ? 1U : 0U);
  output.push_back(static_cast<uint8_t>(config.ssid.size()));
  output.push_back(static_cast<uint8_t>(config.wifiPassword.size()));
  appendU16(output, static_cast<uint16_t>(config.baseUrl.size()));
  output.push_back(static_cast<uint8_t>(config.terminalToken.size()));
  output.insert(output.end(), config.ssid.begin(), config.ssid.end());
  output.insert(output.end(), config.wifiPassword.begin(),
                config.wifiPassword.end());
  output.insert(output.end(), config.baseUrl.begin(), config.baseUrl.end());
  output.insert(output.end(), config.terminalToken.begin(),
                config.terminalToken.end());
  appendU32(output, crc32(output.data(), output.size()));
  return output;
}

std::optional<DeviceConfig> decodeConfig(const std::vector<uint8_t>& input,
                                         BuildProfile profile,
                                         ConfigError& error) {
  if (input.size() < kConfigHeaderSize + kConfigCrcSize ||
      input.size() > kMaxConfigBlobSize) {
    error = ConfigError::Storage;
    return std::nullopt;
  }
  for (size_t index = 0; index < kConfigMagic.size(); ++index) {
    if (input[index] != kConfigMagic[index]) {
      error = ConfigError::Storage;
      return std::nullopt;
    }
  }
  if (input[4] != kConfigVersion || input[5] > 1) {
    error = ConfigError::Storage;
    return std::nullopt;
  }
  const size_t ssidLength = input[6];
  const size_t passwordLength = input[7];
  const size_t urlLength = readU16(input, 8);
  if (kConfigHeaderSize + kConfigCrcSize > input.size()) {
    error = ConfigError::Storage;
    return std::nullopt;
  }
  const size_t tokenLengthOffset = 10;
  const size_t tokenLength = input[tokenLengthOffset];
  const size_t payloadStart = kConfigHeaderSize;
  const size_t payloadLength =
      ssidLength + passwordLength + urlLength + tokenLength;
  if (payloadLength > input.size() || payloadStart > input.size() ||
      input.size() - payloadStart != payloadLength + kConfigCrcSize) {
    error = ConfigError::Storage;
    return std::nullopt;
  }
  const uint32_t expected = readU32(input, input.size() - kConfigCrcSize);
  if (crc32(input.data(), input.size() - kConfigCrcSize) != expected) {
    error = ConfigError::Storage;
    return std::nullopt;
  }

  size_t cursor = payloadStart;
  const auto take = [&](size_t length) {
    std::string value(reinterpret_cast<const char*>(input.data() + cursor),
                      length);
    cursor += length;
    return value;
  };
  DeviceConfig config;
  config.soundEnabled = input[5] == 1;
  config.ssid = take(ssidLength);
  config.wifiPassword = take(passwordLength);
  config.baseUrl = take(urlLength);
  config.terminalToken = take(tokenLength);
  error = validateDeviceConfig(config, profile);
  if (error != ConfigError::None) return std::nullopt;
  return config;
}
#endif

}  // namespace

ConfigError validateDeviceConfig(const DeviceConfig& config,
                                 BuildProfile profile) {
  if (config.ssid.empty()) return ConfigError::EmptySsid;
  if (config.ssid.size() > kMaxSsidBytes) return ConfigError::SsidTooLong;
  if (config.wifiPassword.size() > kMaxWifiPasswordBytes) {
    return ConfigError::WifiPasswordTooLong;
  }
  if (config.baseUrl.size() > kMaxBaseUrlBytes) {
    return ConfigError::BaseUrlTooLong;
  }
  if (!validateBaseUrl(config.baseUrl, profile).allowed) {
    return ConfigError::InvalidBaseUrl;
  }
  if (config.terminalToken.size() > kMaxTerminalTokenBytes) {
    return ConfigError::TerminalTokenTooLong;
  }
  if (config.terminalToken.size() <= 7 ||
      config.terminalToken.compare(0, 7, "ojterm_") != 0) {
    return ConfigError::InvalidTerminalToken;
  }
  if (invalidText(config.ssid) || invalidText(config.wifiPassword) ||
      invalidText(config.terminalToken)) {
    return ConfigError::InvalidText;
  }
  return ConfigError::None;
}

std::optional<DeviceConfig> ConfigStore::load(BuildProfile profile,
                                              ConfigError* error) const {
  ConfigError result = ConfigError::Storage;
#ifdef ARDUINO
  Preferences preferences;
  if (preferences.begin(kPreferencesNamespace, true)) {
    const size_t length = preferences.getBytesLength(kConfigKey);
    if (length >= kConfigHeaderSize + kConfigCrcSize &&
        length <= kMaxConfigBlobSize) {
      std::vector<uint8_t> bytes(length);
      if (preferences.getBytes(kConfigKey, bytes.data(), bytes.size()) ==
          length) {
        preferences.end();
        auto config = decodeConfig(bytes, profile, result);
        if (error != nullptr) *error = result;
        return config;
      }
    }
    preferences.end();
  }
#else
  (void)profile;
#endif
  if (error != nullptr) *error = result;
  return std::nullopt;
}

bool ConfigStore::save(const DeviceConfig& config, BuildProfile profile) {
  if (validateDeviceConfig(config, profile) != ConfigError::None) return false;
#ifdef ARDUINO
  const std::vector<uint8_t> bytes = encodeConfig(config);
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool saved =
      preferences.putBytes(kConfigKey, bytes.data(), bytes.size()) == bytes.size();
  preferences.end();
  return saved;
#else
  (void)config;
  return false;
#endif
}

bool ConfigStore::clear() {
#ifdef ARDUINO
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool removed =
      !preferences.isKey(kConfigKey) || preferences.remove(kConfigKey);
  preferences.end();
  return removed;
#else
  return false;
#endif
}

}  // namespace openjornada
