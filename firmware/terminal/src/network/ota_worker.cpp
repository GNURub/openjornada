#include "openjornada/ota_worker.hpp"

#ifdef ARDUINO

#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <ctime>
#include <new>
#include <string_view>
#include <utility>

#include "openjornada/ota_configuration.hpp"
#include "openjornada/version.hpp"

#ifndef CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE
#error "El firmware OTA requiere rollback del bootloader habilitado"
#endif

extern "C" const uint8_t openjornada_ca_bundle[]
    asm("_binary_x509_crt_bundle_start");

namespace openjornada {
namespace {

constexpr const char* kPreferencesNamespace = "openjornada";
constexpr const char* kPendingVersionKey = "ota_pending_v";
constexpr const char* kPendingHashKey = "ota_pending_h";
constexpr const char* kPendingPhaseKey = "ota_phase";
constexpr const char* kTargetVersionKey = "ota_target_v";
constexpr const char* kTargetHashKey = "ota_target_h";
constexpr const char* kCheckedAtKey = "ota_checked";
constexpr const char* kBlockedVersionKey = "ota_blocked_v";
constexpr const char* kBlockedHashKey = "ota_blocked_h";
constexpr const char* kOtaStatusKey = "ota_status";
constexpr const char* kOtaErrorKey = "ota_error";
constexpr uint32_t kHttpTimeoutMs = 15000U;
constexpr uint8_t kMaxRedirects = 4;

std::string siblingUrl(std::string manifestUrl, const char* suffix) {
  constexpr std::string_view manifestSuffix = "-manifest.json";
  if (manifestUrl.size() < manifestSuffix.size() ||
      manifestUrl.substr(manifestUrl.size() - manifestSuffix.size()) !=
          manifestSuffix) {
    return {};
  }
  manifestUrl.resize(manifestUrl.size() - manifestSuffix.size());
  manifestUrl.append(suffix);
  return manifestUrl;
}

bool redirectStatus(int status) {
  return status == HTTP_CODE_MOVED_PERMANENTLY || status == HTTP_CODE_FOUND ||
         status == HTTP_CODE_TEMPORARY_REDIRECT || status == 308;
}

bool fetchText(std::string url, size_t maximum, bool developmentTransport,
               std::string& output) {
  for (uint8_t redirects = 0; redirects <= kMaxRedirects; ++redirects) {
    if (!otaDownloadUrlAllowed(url, developmentTransport)) return false;
    WiFiClientSecure secureClient;
    WiFiClient plainClient;
    WiFiClient* client = &secureClient;
    if (url.rfind("https://", 0) == 0) {
      secureClient.setCACertBundle(openjornada_ca_bundle);
    } else {
      client = &plainClient;
    }
    HTTPClient http;
    http.setConnectTimeout(kHttpTimeoutMs);
    http.setTimeout(kHttpTimeoutMs);
    http.setUserAgent(kTerminalUserAgent.data());
    if (!http.begin(*client, url.c_str())) return false;
    const int status = http.GET();
    if (redirectStatus(status)) {
      const String location = http.getLocation();
      http.end();
      if (location.isEmpty()) return false;
      url = location.c_str();
      continue;
    }
    const int contentLength = http.getSize();
    if (status != HTTP_CODE_OK || contentLength <= 0 ||
        contentLength > static_cast<int>(maximum)) {
      http.end();
      return false;
    }
    const String body = http.getString();
    http.end();
    if (body.isEmpty() || body.length() > maximum) return false;
    output.assign(body.c_str(), body.length());
    return true;
  }
  return false;
}

std::string lowerHex(const std::array<uint8_t, 32>& bytes) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string output(bytes.size() * 2U, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    output[index * 2] = alphabet[bytes[index] >> 4U];
    output[index * 2 + 1] = alphabet[bytes[index] & 0x0fU];
  }
  return output;
}

FirmwareUpdateError downloadFirmware(std::string url,
                                     const FirmwareManifest& manifest,
                                     int64_t checkedAtEpochSeconds,
                                     bool developmentTransport,
                                     OtaStateStore& stateStore,
                                     std::atomic<FirmwareUpdateStatus>& updateStatus) {
  for (uint8_t redirects = 0; redirects <= kMaxRedirects; ++redirects) {
    if (!otaDownloadUrlAllowed(url, developmentTransport)) {
      return FirmwareUpdateError::Download;
    }
    WiFiClientSecure secureClient;
    WiFiClient plainClient;
    WiFiClient* client = &secureClient;
    if (url.rfind("https://", 0) == 0) {
      secureClient.setCACertBundle(openjornada_ca_bundle);
    } else {
      client = &plainClient;
    }
    HTTPClient http;
    http.setConnectTimeout(kHttpTimeoutMs);
    http.setTimeout(kHttpTimeoutMs);
    http.setUserAgent(kTerminalUserAgent.data());
    if (!http.begin(*client, url.c_str())) return FirmwareUpdateError::Download;
    const int status = http.GET();
    if (redirectStatus(status)) {
      const String location = http.getLocation();
      http.end();
      if (location.isEmpty()) return FirmwareUpdateError::Download;
      url = location.c_str();
      continue;
    }
    const int contentLength = http.getSize();
    if (status != HTTP_CODE_OK ||
        (contentLength >= 0 &&
         static_cast<uint32_t>(contentLength) != manifest.size)) {
      http.end();
      return contentLength >= 0 ? FirmwareUpdateError::Size
                                : FirmwareUpdateError::Download;
    }
    if (!Update.begin(manifest.size, U_FLASH)) {
      http.end();
      return FirmwareUpdateError::Flash;
    }
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts_ret(&sha, 0);
    WiFiClient& stream = http.getStream();
    std::array<uint8_t, 4096> buffer{};
    uint32_t written = 0;
    uint32_t lastProgressAt = millis();
    bool failed = false;
    while (written < manifest.size) {
      const int available = stream.available();
      if (available <= 0) {
        if (!http.connected() ||
            static_cast<uint32_t>(millis() - lastProgressAt) >= kHttpTimeoutMs) {
          failed = true;
          break;
        }
        delay(10);
        continue;
      }
      const size_t requested = std::min<size_t>(
          buffer.size(), std::min<uint32_t>(available, manifest.size - written));
      const size_t received = stream.readBytes(buffer.data(), requested);
      if (received == 0 || Update.write(buffer.data(), received) != received) {
        failed = true;
        break;
      }
      mbedtls_sha256_update_ret(&sha, buffer.data(), received);
      written += received;
      lastProgressAt = millis();
    }
    std::array<uint8_t, 32> digest{};
    mbedtls_sha256_finish_ret(&sha, digest.data());
    mbedtls_sha256_free(&sha);
    http.end();
    if (failed || written != manifest.size) {
      Update.abort();
      return FirmwareUpdateError::Download;
    }
    updateStatus.store(FirmwareUpdateStatus::Verifying);
    std::string expected = manifest.sha256;
    std::transform(expected.begin(), expected.end(), expected.begin(),
                   [](unsigned char byte) { return std::tolower(byte); });
    if (lowerHex(digest) != expected) {
      Update.abort();
      return FirmwareUpdateError::Hash;
    }
    const FirmwareUpdateError preparation = prepareOtaBootCommit(
        stateStore, manifest.firmwareVersion, manifest.sha256,
        checkedAtEpochSeconds);
    if (preparation != FirmwareUpdateError::None) {
      Update.abort();
      return preparation;
    }
    // Persist boot intent before Update.end() selects the candidate partition.
    // A power cut from this point is classified conservatively as an attempted
    // boot, so a bad image can never be reinstalled in a loop.
    if (!Update.end(true)) {
      Update.abort();
      (void)stateStore.clearPending();
      return FirmwareUpdateError::Flash;
    }
    return FirmwareUpdateError::None;
  }
  return FirmwareUpdateError::Download;
}

OtaPersistedPhase persistedPhase(std::string_view value) {
  if (value == "staged") return OtaPersistedPhase::Staged;
  if (value == "boot_pending") return OtaPersistedPhase::BootPending;
  return OtaPersistedPhase::None;
}

FirmwareUpdateStatus persistedStatus(std::string_view value) {
  if (value == "available") return FirmwareUpdateStatus::Available;
  if (value == "pending_reboot") return FirmwareUpdateStatus::PendingReboot;
  if (value == "updated") return FirmwareUpdateStatus::Updated;
  if (value == "failed") return FirmwareUpdateStatus::Failed;
  if (value == "rolled_back") return FirmwareUpdateStatus::RolledBack;
  if (value == "blocked") return FirmwareUpdateStatus::Blocked;
  return FirmwareUpdateStatus::Idle;
}

FirmwareUpdateError persistedError(std::string_view value) {
  if (value == "manifest_fetch") return FirmwareUpdateError::ManifestFetch;
  if (value == "manifest_signature") {
    return FirmwareUpdateError::ManifestSignature;
  }
  if (value == "manifest_invalid") return FirmwareUpdateError::ManifestInvalid;
  if (value == "incompatible") return FirmwareUpdateError::Incompatible;
  if (value == "download") return FirmwareUpdateError::Download;
  if (value == "size") return FirmwareUpdateError::Size;
  if (value == "hash") return FirmwareUpdateError::Hash;
  if (value == "flash") return FirmwareUpdateError::Flash;
  if (value == "boot_validation") return FirmwareUpdateError::BootValidation;
  if (value == "rollback") return FirmwareUpdateError::Rollback;
  return FirmwareUpdateError::None;
}

bool runningPartitionPendingVerification() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  if (running == nullptr) return false;
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  return esp_ota_get_state_partition(running, &state) == ESP_OK &&
         state == ESP_OTA_IMG_PENDING_VERIFY;
}

}  // namespace

bool OtaStateStore::blocked(std::string_view version,
                            std::string_view hash) const {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, true)) return true;
  const std::string blockedVersion =
      preferences.getString(kBlockedVersionKey, "").c_str();
  const std::string blockedHash =
      preferences.getString(kBlockedHashKey, "").c_str();
  preferences.end();
  return version == blockedVersion && hash == blockedHash;
}

bool OtaStateStore::stageCandidate(const std::string& version,
                                   const std::string& hash,
                                   int64_t checkedAtEpochSeconds) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool saved =
      preferences.putString(kPendingVersionKey, version.c_str()) ==
          version.size() &&
      preferences.putString(kPendingHashKey, hash.c_str()) == hash.size() &&
      preferences.putString(kTargetVersionKey, version.c_str()) ==
          version.size() &&
      preferences.putString(kTargetHashKey, hash.c_str()) == hash.size() &&
      preferences.putString(kPendingPhaseKey, "staged") == 6U &&
      preferences.putLong64(kCheckedAtKey, checkedAtEpochSeconds) ==
          sizeof(int64_t) &&
      preferences.putString(kOtaStatusKey, "verifying") == 9U &&
      preferences.putString(kOtaErrorKey, "") == 0U;
  preferences.end();
  return saved;
}

bool OtaStateStore::markBootPending() {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool saved =
      preferences.putString(kPendingPhaseKey, "boot_pending") == 12U &&
      preferences.putString(kOtaStatusKey, "pending_reboot") == 14U &&
      preferences.putString(kOtaErrorKey, "") == 0U;
  preferences.end();
  return saved;
}

bool OtaStateStore::recordFailure(const std::string& version,
                                  const std::string& hash,
                                  FirmwareUpdateError error) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const char* errorValue = firmwareUpdateErrorValue(error);
  const bool saved =
      preferences.putString(kBlockedVersionKey, version.c_str()) ==
          version.size() &&
      preferences.putString(kBlockedHashKey, hash.c_str()) == hash.size() &&
      preferences.putString(kTargetVersionKey, version.c_str()) ==
          version.size() &&
      preferences.putString(kTargetHashKey, hash.c_str()) == hash.size() &&
      preferences.putString(kOtaStatusKey, "blocked") == 7U &&
      preferences.putString(kOtaErrorKey, errorValue) ==
          std::char_traits<char>::length(errorValue);
  preferences.remove(kPendingVersionKey);
  preferences.remove(kPendingHashKey);
  preferences.remove(kPendingPhaseKey);
  preferences.end();
  return saved;
}

bool OtaStateStore::clearPending() {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool removedVersion = !preferences.isKey(kPendingVersionKey) ||
                              preferences.remove(kPendingVersionKey);
  const bool removedHash = !preferences.isKey(kPendingHashKey) ||
                           preferences.remove(kPendingHashKey);
  const bool removedPhase = !preferences.isKey(kPendingPhaseKey) ||
                            preferences.remove(kPendingPhaseKey);
  preferences.end();
  return removedVersion && removedHash && removedPhase;
}

bool OtaStateStore::loadSnapshot(OtaResult& snapshot) const {
  snapshot = {};
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, true)) return false;
  snapshot.targetVersion =
      preferences.getString(kTargetVersionKey, "").c_str();
  snapshot.targetHash = preferences.getString(kTargetHashKey, "").c_str();
  if (snapshot.targetVersion.empty()) {
    snapshot.targetVersion =
        preferences.getString(kPendingVersionKey, "").c_str();
  }
  if (snapshot.targetHash.empty()) {
    snapshot.targetHash = preferences.getString(kPendingHashKey, "").c_str();
  }
  snapshot.checkedAtEpochSeconds = preferences.getLong64(kCheckedAtKey, 0);
  snapshot.status = persistedStatus(
      preferences.getString(kOtaStatusKey, "").c_str());
  snapshot.error =
      persistedError(preferences.getString(kOtaErrorKey, "").c_str());
  preferences.end();
  return true;
}

bool OtaStateStore::prepareBoot(std::string_view runningVersion,
                                OtaResult& snapshot,
                                bool& candidateNeedsValidation) {
  const bool pendingVerification = runningPartitionPendingVerification();
  candidateNeedsValidation = pendingVerification;
  if (!loadSnapshot(snapshot)) return false;
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const std::string pendingVersion =
      preferences.getString(kPendingVersionKey, "").c_str();
  const std::string pendingHash =
      preferences.getString(kPendingHashKey, "").c_str();
  const OtaPersistedPhase phase = persistedPhase(
      preferences.getString(kPendingPhaseKey, "").c_str());
  const OtaBootAction action = decideOtaBootAction(
      phase, !pendingVersion.empty(), pendingVersion == runningVersion,
      pendingVerification, true);
  if (action == OtaBootAction::RejectCandidate) {
    candidateNeedsValidation = pendingVerification;
    preferences.end();
    return false;
  }
  if (action == OtaBootAction::ConfirmCandidate && pendingVerification) {
    candidateNeedsValidation = true;
    const bool promoted =
        preferences.putString(kPendingPhaseKey, "boot_pending") == 12U;
    preferences.end();
    snapshot.status = FirmwareUpdateStatus::PendingReboot;
    snapshot.error = FirmwareUpdateError::None;
    return promoted;
  }
  if (action == OtaBootAction::RecordRollback) {
    preferences.putString(kBlockedVersionKey, pendingVersion.c_str());
    preferences.putString(kBlockedHashKey, pendingHash.c_str());
    preferences.putString(kOtaStatusKey, "rolled_back");
    preferences.putString(kOtaErrorKey, "rollback");
    preferences.remove(kPendingVersionKey);
    preferences.remove(kPendingHashKey);
    preferences.remove(kPendingPhaseKey);
    snapshot.status = FirmwareUpdateStatus::RolledBack;
    snapshot.error = FirmwareUpdateError::Rollback;
    snapshot.targetVersion = pendingVersion;
    snapshot.targetHash = pendingHash;
    preferences.end();
    return true;
  }
  if (action == OtaBootAction::ClearInterruptedStage ||
      action == OtaBootAction::ConfirmCandidate) {
    preferences.remove(kPendingVersionKey);
    preferences.remove(kPendingHashKey);
    preferences.remove(kPendingPhaseKey);
    if (action == OtaBootAction::ConfirmCandidate) {
      preferences.putString(kOtaStatusKey, "updated");
      preferences.putString(kOtaErrorKey, "");
      snapshot.status = FirmwareUpdateStatus::Updated;
      snapshot.error = FirmwareUpdateError::None;
      snapshot.targetVersion = pendingVersion;
      snapshot.targetHash = pendingHash;
    } else {
      preferences.putString(kOtaStatusKey, "failed");
      preferences.putString(kOtaErrorKey, "flash");
      snapshot.status = FirmwareUpdateStatus::Failed;
      snapshot.error = FirmwareUpdateError::Flash;
      snapshot.targetVersion = pendingVersion;
      snapshot.targetHash = pendingHash;
    }
    preferences.end();
    return true;
  }
  preferences.end();
  return true;
}

bool OtaStateStore::confirmBoot(std::string_view runningVersion,
                                OtaResult& snapshot) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const std::string pendingVersion =
      preferences.getString(kPendingVersionKey, "").c_str();
  const std::string pendingHash =
      preferences.getString(kPendingHashKey, "").c_str();
  if (pendingVersion.empty() || pendingVersion != runningVersion ||
      !runningPartitionPendingVerification()) {
    preferences.end();
    return false;
  }
  if (esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) {
    preferences.end();
    return false;
  }
  preferences.remove(kPendingVersionKey);
  preferences.remove(kPendingHashKey);
  preferences.remove(kPendingPhaseKey);
  preferences.putString(kOtaStatusKey, "updated");
  preferences.putString(kOtaErrorKey, "");
  snapshot.status = FirmwareUpdateStatus::Updated;
  snapshot.error = FirmwareUpdateError::None;
  snapshot.targetVersion = pendingVersion;
  snapshot.targetHash = pendingHash;
  snapshot.checkedAtEpochSeconds = preferences.getLong64(kCheckedAtKey, 0);
  preferences.end();
  return true;
}

bool OtaStateStore::rejectCandidateAndReboot() {
  Preferences preferences;
  if (preferences.begin(kPreferencesNamespace, false)) {
    preferences.putString(kOtaStatusKey, "failed");
    preferences.putString(kOtaErrorKey, "boot_validation");
    preferences.putString(kPendingPhaseKey, "boot_pending");
    preferences.end();
  }
  return esp_ota_mark_app_invalid_rollback_and_reboot() == ESP_OK;
}

OtaWorker::OtaWorker(OtaStateStore& stateStore) : stateStore_(stateStore) {}

OtaWorker::~OtaWorker() {
  if (task_ != nullptr) {
    stopRequested_.store(true, std::memory_order_release);
    constexpr uint8_t marker = 0xffU;
    if (pendingQueue_ != nullptr) xQueueSend(pendingQueue_, &marker, 0);
    if (stopAck_ != nullptr) xSemaphoreTake(stopAck_, portMAX_DELAY);
  }
  if (pendingQueue_ != nullptr) vQueueDelete(pendingQueue_);
  if (resultQueue_ != nullptr) vQueueDelete(resultQueue_);
  if (slotMutex_ != nullptr) vSemaphoreDelete(slotMutex_);
  if (stopAck_ != nullptr) vSemaphoreDelete(stopAck_);
}

bool OtaWorker::begin() {
  pendingQueue_ = xQueueCreate(1, sizeof(uint8_t));
  resultQueue_ = xQueueCreate(1, sizeof(uint8_t));
  slotMutex_ = xSemaphoreCreateMutex();
  stopAck_ = xSemaphoreCreateBinary();
  if (pendingQueue_ == nullptr || resultQueue_ == nullptr ||
      slotMutex_ == nullptr || stopAck_ == nullptr) {
    return false;
  }
  return xTaskCreatePinnedToCore(taskEntry, "oj-ota", 14336, this, 1, &task_,
                                 0) == pdPASS;
}

bool OtaWorker::enqueue(OtaJob&& job) {
  bool expected = false;
  if (!busy_.compare_exchange_strong(expected, true)) return false;
  if (xSemaphoreTake(slotMutex_, portMAX_DELAY) != pdTRUE) {
    busy_.store(false);
    return false;
  }
  try {
    job_ = std::move(job);
  } catch (const std::bad_alloc&) {
    xSemaphoreGive(slotMutex_);
    busy_.store(false);
    return false;
  }
  xSemaphoreGive(slotMutex_);
  constexpr uint8_t marker = 1U;
  if (xQueueSend(pendingQueue_, &marker, 0) != pdTRUE) {
    busy_.store(false);
    return false;
  }
  return true;
}

bool OtaWorker::poll(OtaResult& output) {
  uint8_t marker = 0;
  if (xQueueReceive(resultQueue_, &marker, 0) != pdTRUE || marker != 1U) {
    return false;
  }
  if (xSemaphoreTake(slotMutex_, portMAX_DELAY) != pdTRUE) return false;
  output = std::move(result_);
  result_ = {};
  xSemaphoreGive(slotMutex_);
  busy_.store(false);
  return true;
}

bool OtaWorker::busy() const { return busy_.load(); }

FirmwareUpdateStatus OtaWorker::status() const { return status_.load(); }

void OtaWorker::taskEntry(void* context) {
  static_cast<OtaWorker*>(context)->taskLoop();
  vTaskDelete(nullptr);
}

void OtaWorker::taskLoop() {
  while (!stopRequested_.load()) {
    uint8_t marker = 0;
    if (xQueueReceive(pendingQueue_, &marker, pdMS_TO_TICKS(50)) != pdTRUE) {
      continue;
    }
    if (marker == 0xffU || stopRequested_.load()) break;
    xSemaphoreTake(slotMutex_, portMAX_DELAY);
    OtaJob job = std::move(job_);
    xSemaphoreGive(slotMutex_);
    OtaResult result;
    try {
      execute(job, result);
    } catch (const std::bad_alloc&) {
      result.status = FirmwareUpdateStatus::Failed;
      result.error = FirmwareUpdateError::ManifestFetch;
      status_.store(result.status);
    }
    xSemaphoreTake(slotMutex_, portMAX_DELAY);
    result_ = std::move(result);
    xSemaphoreGive(slotMutex_);
    constexpr uint8_t resultMarker = 1U;
    while (!stopRequested_.load() &&
           xQueueSend(resultQueue_, &resultMarker, pdMS_TO_TICKS(50)) != pdTRUE) {
    }
  }
  xSemaphoreGive(stopAck_);
}

void OtaWorker::execute(const OtaJob& job, OtaResult& output) {
  output = {};
  output.kind = job.kind;
  output.checkedAtEpochSeconds =
      job.checkedAtEpochSeconds > 0 ? job.checkedAtEpochSeconds
                                    : std::time(nullptr);
  if (job.kind == OtaJobKind::Install) {
    if (!job.candidate.has_value() ||
        !manifestIsInstallable(*job.candidate, job.currentVersion,
                               job.protocolVersion)) {
      output.status = FirmwareUpdateStatus::Failed;
      output.error = FirmwareUpdateError::Incompatible;
      status_.store(output.status);
      return;
    }
    const FirmwareManifest& manifest = *job.candidate;
    output.targetVersion = manifest.firmwareVersion;
    output.targetHash = manifest.sha256;
    if (stateStore_.blocked(manifest.firmwareVersion, manifest.sha256)) {
      output.status = FirmwareUpdateStatus::Blocked;
      output.error = FirmwareUpdateError::Rollback;
      status_.store(output.status);
      return;
    }
    status_.store(FirmwareUpdateStatus::Downloading);
    const std::string binaryUrl = siblingUrl(job.manifestUrl, ".bin");
    const FirmwareUpdateError download =
        binaryUrl.empty()
            ? FirmwareUpdateError::Download
            : downloadFirmware(binaryUrl, manifest,
                               output.checkedAtEpochSeconds,
                               job.developmentTransport, stateStore_, status_);
    if (download != FirmwareUpdateError::None) {
      output.status = FirmwareUpdateStatus::Failed;
      output.error = download;
      status_.store(output.status);
      return;
    }
    output.status = FirmwareUpdateStatus::PendingReboot;
    output.rebootRequired = true;
    status_.store(output.status);
    return;
  }
  status_.store(FirmwareUpdateStatus::Checking);
  std::string manifestBytes;
  std::string signatureText;
  const std::string signatureUrl = siblingUrl(job.manifestUrl, "-manifest.sig");
  if (signatureUrl.empty() ||
      !fetchText(job.manifestUrl, kOtaManifestMaxBytes,
                 job.developmentTransport, manifestBytes) ||
      !fetchText(signatureUrl, 128, job.developmentTransport, signatureText)) {
    output.status = FirmwareUpdateStatus::Failed;
    output.error = FirmwareUpdateError::ManifestFetch;
    status_.store(output.status);
    return;
  }
  while (!signatureText.empty() &&
         (signatureText.back() == '\n' || signatureText.back() == '\r')) {
    signatureText.pop_back();
  }
  std::array<uint8_t, 64> signature{};
  if (!decodeBase64Signature(signatureText, signature) ||
      !verifyEd25519Manifest(manifestBytes, signature, job.publicKey)) {
    output.status = FirmwareUpdateStatus::Blocked;
    output.error = FirmwareUpdateError::ManifestSignature;
    status_.store(output.status);
    return;
  }
  FirmwareManifest manifest;
  if (!parseFirmwareManifest(manifestBytes, manifest)) {
    output.status = FirmwareUpdateStatus::Blocked;
    output.error = FirmwareUpdateError::ManifestInvalid;
    status_.store(output.status);
    return;
  }
  output.targetVersion = manifest.firmwareVersion;
  output.targetHash = manifest.sha256;
  const auto comparison =
      compareSemanticVersions(manifest.firmwareVersion, job.currentVersion);
  if (comparison.has_value() && *comparison <= 0) {
    output.status = FirmwareUpdateStatus::Idle;
    output.targetVersion.clear();
    output.targetHash.clear();
    status_.store(output.status);
    return;
  }
  if (!manifestIsInstallable(manifest, job.currentVersion,
                             job.protocolVersion)) {
    output.status = FirmwareUpdateStatus::Blocked;
    output.error = FirmwareUpdateError::Incompatible;
    status_.store(output.status);
    return;
  }
  if (stateStore_.blocked(manifest.firmwareVersion, manifest.sha256)) {
    output.status = FirmwareUpdateStatus::Blocked;
    output.error = FirmwareUpdateError::Rollback;
    status_.store(output.status);
    return;
  }
  output.status = FirmwareUpdateStatus::Available;
  output.candidate = std::move(manifest);
  status_.store(output.status);
}

}  // namespace openjornada

#endif
