#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace openjornada {

inline constexpr std::string_view kOtaBoard = "m5stack-basic-core-v27";
inline constexpr std::string_view kOtaChannel = "stable";
inline constexpr std::string_view kOtaFirmwareAsset = "openjornada-m5stack.bin";
inline constexpr std::string_view kOtaKeyId = "production-2026";
inline constexpr size_t kOtaManifestMaxBytes = 2048;
inline constexpr uint32_t kOtaCheckIntervalMs = 60U * 60U * 1000U;
inline constexpr uint32_t kOtaInteractionIdleMs = 2U * 60U * 1000U;
inline constexpr uint32_t kCompatibleBootstrapMaxAgeMs =
    2U * 60U * 60U * 1000U;

enum class FirmwareUpdateStatus {
  Idle,
  Checking,
  Available,
  Downloading,
  Verifying,
  PendingReboot,
  Updated,
  Failed,
  RolledBack,
  Blocked,
};

enum class FirmwareUpdateError {
  None,
  ManifestFetch,
  ManifestSignature,
  ManifestInvalid,
  Incompatible,
  Download,
  Size,
  Hash,
  Flash,
  BootValidation,
  Rollback,
};

enum class OtaPersistedPhase { None, Staged, BootPending };

enum class OtaBootAction {
  None,
  ClearInterruptedStage,
  ConfirmCandidate,
  RejectCandidate,
  RecordRollback,
};

struct FirmwareManifest {
  uint8_t schemaVersion = 0;
  std::string channel;
  std::string board;
  std::string firmwareVersion;
  std::string releaseTag;
  uint8_t protocolVersion = 0;
  std::string assetName;
  uint32_t size = 0;
  std::string sha256;
  std::string keyId;
  std::string publishedAt;
};

struct OtaSafetyContext {
  size_t pendingCount = 0;
  bool primaryWorkerBusy = false;
  bool telemetryWorkerBusy = false;
  bool adminModeActive = false;
  bool idleScreen = false;
  bool networkConnected = false;
  bool clockTrusted = false;
  bool compatibleBootstrapRecent = false;
  uint32_t inactiveForMs = 0;
};

class OtaCommitStore {
 public:
  virtual ~OtaCommitStore() = default;
  virtual bool stageCandidate(const std::string& version,
                              const std::string& hash,
                              int64_t checkedAtEpochSeconds) = 0;
  virtual bool markBootPending() = 0;
  virtual bool clearPending() = 0;
};

class OtaScheduler {
 public:
  bool due(uint32_t nowMs) const;
  void markChecked(uint32_t nowMs);

 private:
  bool checked_ = false;
  uint32_t lastCheckedAtMs_ = 0;
};

bool parseFirmwareManifest(std::string_view json, FirmwareManifest& output);
std::optional<int> compareSemanticVersions(std::string_view left,
                                           std::string_view right);
bool manifestIsInstallable(const FirmwareManifest& manifest,
                           std::string_view currentVersion,
                           uint8_t protocolVersion);
bool otaSafetyAllowsInstall(const OtaSafetyContext& context);
bool otaStateNamespaceAvailable(bool readOnlyOpened, bool writableOpened);
FirmwareUpdateError prepareOtaBootCommit(
    OtaCommitStore& store, const std::string& version, const std::string& hash,
    int64_t checkedAtEpochSeconds);
OtaBootAction decideOtaBootAction(OtaPersistedPhase phase,
                                  bool hasPersistedCandidate,
                                  bool runningVersionMatches,
                                  bool runningPartitionPendingVerification,
                                  bool selfTestPassed);
bool otaDownloadUrlAllowed(std::string_view url, bool developmentTransport);
bool decodeBase64Signature(std::string_view encoded,
                           std::array<uint8_t, 64>& output);
bool verifyEd25519Manifest(std::string_view manifest,
                           const std::array<uint8_t, 64>& signature,
                           const std::array<uint8_t, 32>& publicKey);
bool verifyFirmwareManifestSignature(
    std::string_view manifest, std::string_view encodedSignature,
    const std::array<uint8_t, 32>& publicKey, FirmwareManifest& output,
    FirmwareUpdateError* error = nullptr);
const char* firmwareUpdateStatusValue(FirmwareUpdateStatus status);
const char* firmwareUpdateErrorValue(FirmwareUpdateError error);

}  // namespace openjornada
