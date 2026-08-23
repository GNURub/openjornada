#pragma once

#include <cstddef>
#include <functional>
#include <optional>
#include <string>

#include "openjornada/config.hpp"

namespace openjornada {

// Mobile browsers can legitimately exceed 1 KiB with their default request
// headers. Keep the parser bounded, but leave enough room for current captive
// portal clients (Chrome/Brave/Safari) without rejecting the initial GET.
inline constexpr size_t kMaxProvisioningHeaderBytes = 4096;
inline constexpr size_t kMaxProvisioningRequestTargetBytes = 128;
inline constexpr size_t kMaxProvisioningFormBodyBytes =
    kMaxSsidBytes * 3U + kMaxWifiPasswordBytes * 3U +
    kMaxBaseUrlBytes * 3U + kMaxTerminalTokenBytes * 3U + 256U;
inline constexpr char kProvisioningScriptPath[] = "/provisioning.js";
inline constexpr char kProvisioningContentSecurityPolicy[] =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; "
    "form-action http://192.168.4.1; base-uri 'none'; "
    "frame-ancestors 'none'";
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

bool isProvisioningScriptRequest(const CaptiveHttpRequest& request);

template <typename WriteChunk>
bool writeAllProvisioningBytes(const uint8_t* data, size_t length,
                               WriteChunk writeChunk) {
  size_t offset = 0;
  while (offset < length) {
    const size_t remaining = length - offset;
    const size_t written =
        static_cast<size_t>(writeChunk(data + offset, remaining));
    if (written == 0 || written > remaining) return false;
    offset += written;
  }
  return true;
}

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
  bool wifiPasswordExplicit = false;
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
    std::function<bool(const DeviceConfig&, std::string& displayError,
                       const std::function<void()>& service)>;

bool canApplyProvisioningCandidate(
    const std::optional<DeviceConfig>& activeConfig,
    const DeviceConfig& candidate, size_t pendingCount);
void applyProvisioningSecretFallbacks(const DeviceConfig& activeConfig,
                                      bool wifiPasswordExplicit,
                                      DeviceConfig& candidate);

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
