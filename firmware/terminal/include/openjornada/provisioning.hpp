#pragma once

#include <cstddef>
#include <functional>
#include <optional>
#include <string>

#include "openjornada/config.hpp"

namespace openjornada {

struct ProvisioningResult {
  bool saved = false;
  DeviceConfig config;
  std::string displayError;
};

using CandidateValidator =
    std::function<bool(const DeviceConfig&, std::string& displayError)>;

bool canApplyProvisioningCandidate(
    const std::optional<DeviceConfig>& activeConfig,
    const DeviceConfig& candidate, size_t pendingCount);

class ProvisioningPortal {
 public:
  ProvisioningPortal(ConfigStore& store, BuildProfile profile,
                     std::optional<DeviceConfig> activeConfig,
                     size_t pendingCount);

  ProvisioningResult run(const CandidateValidator& candidateValidator);

 private:
  ConfigStore& store_;
  BuildProfile profile_;
  std::optional<DeviceConfig> activeConfig_;
  size_t pendingCount_;
};

#ifdef ARDUINO
void drawProvisioningAccess(const std::string& ssid,
                            const std::string& password);
void drawProvisioningStatus(const std::string& title,
                            const std::string& detail, bool error);
#endif

}  // namespace openjornada
