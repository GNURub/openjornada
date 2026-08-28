#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>

#include "openjornada/config.hpp"
#include "openjornada/usb_protocol.hpp"

#ifdef ARDUINO
class Stream;
#endif

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
inline constexpr char kProvisioningStatusPath[] = "/status";
inline constexpr uint32_t kProvisioningRequestIdleTimeoutMs = 400;
inline constexpr uint32_t kProvisioningRequestTotalTimeoutMs = 2000;
inline constexpr uint32_t kProvisioningConnectTimeoutMs = 20000;
inline constexpr uint32_t kProvisioningSuccessResponseGraceMs = 2000;
inline constexpr uint32_t kProvisioningSuccessHardStopMs = 10000;
inline constexpr char kProvisioningContentSecurityPolicy[] =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; "
    "connect-src 'self'; "
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

enum class ProvisioningHttpRoute {
  Index,
  Script,
  Save,
  Status,
  CaptiveProbe,
  NoContent,
  Redirect,
};

ProvisioningHttpRoute provisioningHttpRoute(
    const CaptiveHttpRequest& request);
bool isProvisioningScriptRequest(const CaptiveHttpRequest& request);

enum class ProvisioningRequestTimeout { None, Idle, Total };

ProvisioningRequestTimeout provisioningRequestTimeout(uint32_t startedAtMs,
                                                      uint32_t lastProgressMs,
                                                      uint32_t nowMs);

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
  bool cancelled = false;
  DeviceConfig config;
  std::string displayError;
};

using CandidateValidator =
    std::function<bool(const DeviceConfig&, std::string& displayError,
                       const std::function<bool()>& service)>;

bool canApplyProvisioningCandidate(
    const std::optional<DeviceConfig>& activeConfig,
    const DeviceConfig& candidate, size_t pendingCount);
void applyProvisioningSecretFallbacks(const DeviceConfig& activeConfig,
                                      bool wifiPasswordExplicit,
                                      DeviceConfig& candidate);

enum class ProvisioningCheckPhase {
  Idle,
  Connecting,
  Validating,
  Succeeded,
  Failed,
};

class ProvisioningAttemptState {
 public:
  bool begin(const DeviceConfig& candidate, uint32_t nowMs);
  bool markValidating();
  void fail(std::string error);
  void succeed(uint32_t nowMs);

  bool canSubmit() const;
  bool busy() const;
  bool cancellationAllowed() const;
  bool connectionTimedOut(uint32_t nowMs) const;
  bool markSuccessResponseServed(uint32_t nowMs);
  bool successWindowElapsed(uint32_t nowMs) const;
  ProvisioningCheckPhase phase() const;
  const std::optional<DeviceConfig>& candidate() const;
  const std::string& error() const;
  uint32_t completedAtMs() const;

 private:
  ProvisioningCheckPhase phase_ = ProvisioningCheckPhase::Idle;
  std::optional<DeviceConfig> candidate_;
  std::string error_;
  uint32_t startedAtMs_ = 0;
  uint32_t completedAtMs_ = 0;
  uint32_t successResponseServedAtMs_ = 0;
  bool successResponseServed_ = false;
};

enum class ProvisioningSerialMode { Runtime, Portal };

struct ProvisioningSerialPublicContext {
  bool storageAvailable = false;
  bool rfidAvailable = false;
  std::function<bool()> wifiConnected;
};

using ProvisioningCandidateSaver =
    std::function<bool(const DeviceConfig& candidate)>;

enum class ProvisioningCandidateResult { Saved, Failed, Cancelled };

ProvisioningCandidateResult completeProvisioningAttempt(
    ProvisioningAttemptState& attempt,
    const CandidateValidator& candidateValidator,
    const ProvisioningCandidateSaver& candidateSaver,
    const std::function<bool()>& service,
    const std::function<uint32_t()>& nowMs);

enum class UsbProvisionDecision {
  Started,
  Busy,
  PortalRequired,
  PendingActions,
  InvalidPayload,
  UnsupportedCommand,
};

struct UsbProvisionAcceptance {
  UsbProvisionDecision decision = UsbProvisionDecision::UnsupportedCommand;
  std::string code;
};

class ProvisioningSerialTransport {
 public:
  virtual ~ProvisioningSerialTransport() = default;
  virtual int available() = 0;
  virtual int read() = 0;
  virtual size_t write(const uint8_t* data, size_t size) = 0;
};

class ProvisioningSerialAdapter {
 public:
  ProvisioningSerialAdapter(BuildProfile profile,
                            std::optional<DeviceConfig> activeConfig,
                            size_t pendingCount, ProvisioningSerialMode mode,
                            ProvisioningSerialPublicContext publicContext = {});

  UsbProvisionAcceptance accept(const UsbControlRequest& request,
                                ProvisioningAttemptState& attempt,
                                uint32_t nowMs);
  std::optional<std::string> nextEvent(
      const ProvisioningAttemptState& attempt);
  void service(ProvisioningSerialTransport& transport,
               ProvisioningAttemptState& attempt, uint32_t nowMs);

#ifdef ARDUINO
  void service(Stream& stream, ProvisioningAttemptState& attempt,
               uint32_t nowMs);
#endif

 private:
  BuildProfile profile_;
  std::optional<DeviceConfig> activeConfig_;
  size_t pendingCount_;
  ProvisioningSerialMode mode_;
  ProvisioningSerialPublicContext publicContext_;
  UsbControlParser parser_;
  std::string activeRequestId_;
  ProvisioningCheckPhase lastEventPhase_ = ProvisioningCheckPhase::Idle;
};

class ProvisioningPortal {
 public:
  ProvisioningPortal(ConfigStore& store, BuildProfile profile,
                     std::optional<DeviceConfig> activeConfig,
                     size_t pendingCount,
                     ProvisioningSerialPublicContext publicContext = {});

#ifdef ARDUINO
  ProvisioningResult run(const CandidateValidator& candidateValidator,
                         Stream& serial);
#else
  ProvisioningResult run(const CandidateValidator& candidateValidator);
#endif

 private:
  ConfigStore& store_;
  BuildProfile profile_;
  std::optional<DeviceConfig> activeConfig_;
  size_t pendingCount_;
  ProvisioningSerialPublicContext publicContext_;
};

#ifdef ARDUINO
void drawProvisioningAccess(const std::string& ssid,
                            const std::string& password);
void drawProvisioningStatus(const std::string& title,
                            const std::string& detail, bool error);
#endif

}  // namespace openjornada
