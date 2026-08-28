#include "openjornada/ota.hpp"

#include <ArduinoJson.h>
#include <optional/monocypher-ed25519.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <limits>

#include "openjornada/url_policy.hpp"

namespace openjornada {
namespace {

constexpr size_t kMaxVersion = 32;
constexpr size_t kMaxTag = 64;
constexpr size_t kMaxTimestamp = 48;
constexpr size_t kMaxKeyId = 32;

bool safeText(std::string_view value, size_t maximum) {
  if (value.empty() || value.size() > maximum) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char byte) {
    return byte >= 0x20U && byte != 0x7fU;
  });
}

bool readString(JsonObjectConst object, const char* key, size_t maximum,
                std::string& output) {
  if (!object[key].is<const char*>()) return false;
  const char* value = object[key].as<const char*>();
  if (value == nullptr || !safeText(value, maximum)) return false;
  output = value;
  return true;
}

struct SemanticVersion {
  std::array<uint32_t, 3> parts{};
};

std::optional<SemanticVersion> parseSemanticVersion(std::string_view value) {
  if (value.empty() || value.size() > kMaxVersion || value.front() == 'v' ||
      value.find_first_of("+-") != std::string_view::npos) {
    return std::nullopt;
  }
  SemanticVersion parsed;
  size_t start = 0;
  for (size_t index = 0; index < parsed.parts.size(); ++index) {
    const size_t end = value.find('.', start);
    const size_t componentEnd = end == std::string_view::npos ? value.size() : end;
    const auto component = value.substr(start, componentEnd - start);
    if (component.empty() || (component.size() > 1 && component.front() == '0')) {
      return std::nullopt;
    }
    uint32_t number = 0;
    const auto conversion = std::from_chars(component.data(),
                                            component.data() + component.size(),
                                            number);
    if (conversion.ec != std::errc{} ||
        conversion.ptr != component.data() + component.size()) {
      return std::nullopt;
    }
    parsed.parts[index] = number;
    if (index + 1 < parsed.parts.size()) {
      if (end == std::string_view::npos) return std::nullopt;
      start = end + 1;
    } else if (end != std::string_view::npos) {
      return std::nullopt;
    }
  }
  return parsed;
}

int base64Value(unsigned char byte) {
  if (byte >= 'A' && byte <= 'Z') return byte - 'A';
  if (byte >= 'a' && byte <= 'z') return byte - 'a' + 26;
  if (byte >= '0' && byte <= '9') return byte - '0' + 52;
  if (byte == '+') return 62;
  if (byte == '/') return 63;
  return -1;
}

}  // namespace

bool OtaScheduler::due(uint32_t nowMs) const {
  return !checked_ || static_cast<uint32_t>(nowMs - lastCheckedAtMs_) >=
                          kOtaCheckIntervalMs;
}

void OtaScheduler::markChecked(uint32_t nowMs) {
  checked_ = true;
  lastCheckedAtMs_ = nowMs;
}

bool parseFirmwareManifest(std::string_view json, FirmwareManifest& output) {
  if (json.empty() || json.size() > kOtaManifestMaxBytes) return false;
  JsonDocument document;
  const auto error = deserializeJson(document, json.data(), json.size(),
                                     DeserializationOption::NestingLimit(2));
  if (error || !document.is<JsonObjectConst>()) return false;
  const JsonObjectConst object = document.as<JsonObjectConst>();
  if (object.size() != 11 || !object["schemaVersion"].is<uint8_t>() ||
      !object["protocolVersion"].is<uint8_t>() ||
      !object["size"].is<uint32_t>()) {
    return false;
  }
  FirmwareManifest parsed;
  parsed.schemaVersion = object["schemaVersion"].as<uint8_t>();
  parsed.protocolVersion = object["protocolVersion"].as<uint8_t>();
  parsed.size = object["size"].as<uint32_t>();
  if (!readString(object, "channel", 16, parsed.channel) ||
      !readString(object, "board", 48, parsed.board) ||
      !readString(object, "firmwareVersion", kMaxVersion,
                  parsed.firmwareVersion) ||
      !readString(object, "releaseTag", kMaxTag, parsed.releaseTag) ||
      !readString(object, "assetName", 64, parsed.assetName) ||
      !readString(object, "sha256", 64, parsed.sha256) ||
      !readString(object, "keyId", kMaxKeyId, parsed.keyId) ||
      !readString(object, "publishedAt", kMaxTimestamp, parsed.publishedAt)) {
    return false;
  }
  if (parsed.schemaVersion != 1 || parsed.size == 0 ||
      parsed.sha256.size() != 64 ||
      !std::all_of(parsed.sha256.begin(), parsed.sha256.end(),
                   [](unsigned char byte) { return std::isxdigit(byte); }) ||
      !parseSemanticVersion(parsed.firmwareVersion).has_value()) {
    return false;
  }
  output = std::move(parsed);
  return true;
}

std::optional<int> compareSemanticVersions(std::string_view left,
                                           std::string_view right) {
  const auto parsedLeft = parseSemanticVersion(left);
  const auto parsedRight = parseSemanticVersion(right);
  if (!parsedLeft.has_value() || !parsedRight.has_value()) return std::nullopt;
  if (parsedLeft->parts < parsedRight->parts) return -1;
  if (parsedLeft->parts > parsedRight->parts) return 1;
  return 0;
}

bool manifestIsInstallable(const FirmwareManifest& manifest,
                           std::string_view currentVersion,
                           uint8_t protocolVersion) {
  const auto comparison =
      compareSemanticVersions(manifest.firmwareVersion, currentVersion);
  return manifest.schemaVersion == 1 && manifest.channel == kOtaChannel &&
         manifest.board == kOtaBoard &&
         manifest.protocolVersion == protocolVersion &&
         manifest.assetName == kOtaFirmwareAsset && manifest.keyId == kOtaKeyId &&
         comparison.has_value() && *comparison > 0;
}

bool otaSafetyAllowsInstall(const OtaSafetyContext& context) {
  return context.pendingCount == 0 && !context.primaryWorkerBusy &&
         !context.telemetryWorkerBusy && !context.adminModeActive &&
         context.idleScreen && context.networkConnected && context.clockTrusted &&
         context.compatibleBootstrapRecent &&
         context.inactiveForMs >= kOtaInteractionIdleMs;
}

bool otaStateNamespaceAvailable(bool readOnlyOpened, bool writableOpened) {
  return readOnlyOpened || writableOpened;
}

FirmwareUpdateError prepareOtaBootCommit(
  OtaCommitStore& store, const std::string& version, const std::string& hash,
  int64_t checkedAtEpochSeconds) {
  if (!store.stageCandidate(version, hash, checkedAtEpochSeconds)) {
    (void)store.clearPending();
    return FirmwareUpdateError::BootValidation;
  }
  if (!store.markBootPending()) {
    (void)store.clearPending();
    return FirmwareUpdateError::BootValidation;
  }
  return FirmwareUpdateError::None;
}

OtaBootAction decideOtaBootAction(
    OtaPersistedPhase phase, bool hasPersistedCandidate,
    bool runningVersionMatches, bool runningPartitionPendingVerification,
    bool selfTestPassed) {
  if (runningPartitionPendingVerification) {
    if (!hasPersistedCandidate || !runningVersionMatches || !selfTestPassed) {
      return OtaBootAction::RejectCandidate;
    }
    return OtaBootAction::ConfirmCandidate;
  }
  if (!hasPersistedCandidate) return OtaBootAction::None;
  if (runningVersionMatches) return OtaBootAction::ConfirmCandidate;
  return phase == OtaPersistedPhase::BootPending
             ? OtaBootAction::RecordRollback
             : OtaBootAction::ClearInterruptedStage;
}

bool otaDownloadUrlAllowed(std::string_view url, bool developmentTransport) {
  if (developmentTransport && url.rfind("http://", 0) == 0) {
    return validateBaseUrl(url, BuildProfile::Development).allowed;
  }
  if (url.rfind("https://", 0) != 0 ||
      url.find('#') != std::string_view::npos) {
    return false;
  }
  constexpr size_t authorityStart = 8;
  const size_t authorityEnd = url.find_first_of("/?#", authorityStart);
  const auto authority = url.substr(
      authorityStart, authorityEnd == std::string_view::npos
                          ? std::string_view::npos
                          : authorityEnd - authorityStart);
  if (authority.empty() || authority.find('@') != std::string_view::npos) {
    return false;
  }
  const size_t colon = authority.find(':');
  const auto host = authority.substr(0, colon);
  const bool knownHost =
      host == "github.com" || host == "release-assets.githubusercontent.com" ||
      host == "objects.githubusercontent.com";
  return knownHost &&
         (colon == std::string_view::npos || authority.substr(colon) == ":443");
}

bool decodeBase64Signature(std::string_view encoded,
                           std::array<uint8_t, 64>& output) {
  if (encoded.size() != 88 || encoded.substr(86) != "==") return false;
  size_t outputIndex = 0;
  uint32_t accumulator = 0;
  int bits = 0;
  for (size_t index = 0; index < encoded.size() - 2; ++index) {
    const int value = base64Value(static_cast<unsigned char>(encoded[index]));
    if (value < 0) return false;
    accumulator = (accumulator << 6U) | static_cast<uint32_t>(value);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outputIndex >= output.size()) return false;
      output[outputIndex++] =
          static_cast<uint8_t>((accumulator >> bits) & 0xffU);
    }
  }
  return outputIndex == output.size() && bits == 4 &&
         (accumulator & 0x0fU) == 0;
}

bool verifyEd25519Manifest(std::string_view manifest,
                           const std::array<uint8_t, 64>& signature,
                           const std::array<uint8_t, 32>& publicKey) {
  return crypto_ed25519_check(signature.data(), publicKey.data(),
                              reinterpret_cast<const uint8_t*>(manifest.data()),
                              manifest.size()) == 0;
}

const char* firmwareUpdateStatusValue(FirmwareUpdateStatus status) {
  switch (status) {
    case FirmwareUpdateStatus::Idle: return "idle";
    case FirmwareUpdateStatus::Checking: return "checking";
    case FirmwareUpdateStatus::Available: return "available";
    case FirmwareUpdateStatus::Downloading: return "downloading";
    case FirmwareUpdateStatus::Verifying: return "verifying";
    case FirmwareUpdateStatus::PendingReboot: return "pending_reboot";
    case FirmwareUpdateStatus::Updated: return "updated";
    case FirmwareUpdateStatus::Failed: return "failed";
    case FirmwareUpdateStatus::RolledBack: return "rolled_back";
    case FirmwareUpdateStatus::Blocked: return "blocked";
  }
  return "failed";
}

const char* firmwareUpdateErrorValue(FirmwareUpdateError error) {
  switch (error) {
    case FirmwareUpdateError::None: return "";
    case FirmwareUpdateError::ManifestFetch: return "manifest_fetch";
    case FirmwareUpdateError::ManifestSignature: return "manifest_signature";
    case FirmwareUpdateError::ManifestInvalid: return "manifest_invalid";
    case FirmwareUpdateError::Incompatible: return "incompatible";
    case FirmwareUpdateError::Download: return "download";
    case FirmwareUpdateError::Size: return "size";
    case FirmwareUpdateError::Hash: return "hash";
    case FirmwareUpdateError::Flash: return "flash";
    case FirmwareUpdateError::BootValidation: return "boot_validation";
    case FirmwareUpdateError::Rollback: return "rollback";
  }
  return "boot_validation";
}

}  // namespace openjornada
