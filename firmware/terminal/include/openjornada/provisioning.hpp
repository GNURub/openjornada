#pragma once

#include <cstddef>
#include <functional>
#include <optional>
#include <string>

#include "openjornada/config.hpp"

namespace openjornada {

inline constexpr size_t kMaxProvisioningHeaderBytes = 1024;
inline constexpr size_t kMaxProvisioningRequestTargetBytes = 128;
inline constexpr size_t kMaxProvisioningFormBodyBytes =
    kMaxSsidBytes * 3U + kMaxWifiPasswordBytes * 3U +
    kMaxBaseUrlBytes * 3U + kMaxTerminalTokenBytes * 3U + 256U;

enum class CaptiveHttpParseStatus {
  NeedMore,
  Complete,
  HeaderTooLarge,
  BodyTooLarge,
  Invalid,
};

struct CaptiveHttpRequest {
  std::string method;
  std::string target;
  std::string host;
  std::string origin;
  std::string contentType;
  std::string body;
};

class BoundedCaptiveHttpParser {
 public:
  CaptiveHttpParseStatus consume(char byte);
  CaptiveHttpParseStatus status() const;
  const CaptiveHttpRequest& request() const;
  size_t bodyBytesConsumed() const;

 private:
  CaptiveHttpParseStatus parseHeaders();

  CaptiveHttpParseStatus status_ = CaptiveHttpParseStatus::NeedMore;
  CaptiveHttpRequest request_;
  std::string headers_;
  size_t contentLength_ = 0;
  size_t bodyBytesConsumed_ = 0;
  bool readingBody_ = false;
};

struct ProvisioningFormFields {
  std::string csrf;
  std::string ssid;
  std::string wifiPassword;
  std::string baseUrl;
  std::string terminalToken;
};

bool decodeProvisioningForm(const std::string& body,
                            ProvisioningFormFields& output);
bool decodeProvisioningFormRequest(const CaptiveHttpRequest& request,
                                   const std::string& expectedCsrf,
                                   ProvisioningFormFields& output);

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
