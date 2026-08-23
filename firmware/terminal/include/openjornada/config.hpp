#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include "openjornada/url_policy.hpp"

namespace openjornada {

constexpr size_t kMaxSsidBytes = 32;
constexpr size_t kMaxWifiPasswordBytes = 63;
constexpr size_t kMaxTerminalTokenBytes = 96;

struct DeviceConfig {
  std::string ssid;
  std::string wifiPassword;
  std::string baseUrl;
  std::string terminalToken;
  bool soundEnabled = true;
};

struct RuntimeState {
  std::string terminalId;
  std::string clockSyncedAt;
  std::string configFingerprint;
  int64_t lastNtpEpochSeconds = 0;
};

enum class ConfigError {
  None,
  EmptySsid,
  SsidTooLong,
  WifiPasswordTooLong,
  BaseUrlTooLong,
  InvalidBaseUrl,
  InvalidTerminalToken,
  TerminalTokenTooLong,
  InvalidText,
  Storage,
};

ConfigError validateDeviceConfig(const DeviceConfig& config,
                                 BuildProfile profile);

class ConfigStore {
 public:
  std::optional<DeviceConfig> load(BuildProfile profile,
                                   ConfigError* error = nullptr) const;
  bool save(const DeviceConfig& config, BuildProfile profile);
  std::optional<RuntimeState> loadRuntime() const;
  bool saveRuntime(const RuntimeState& state);
  bool clear();
};

}  // namespace openjornada
