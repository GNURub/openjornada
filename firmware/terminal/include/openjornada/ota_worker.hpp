#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <optional>
#include <string>

#include "openjornada/ota.hpp"

#ifdef ARDUINO
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#endif

namespace openjornada {

enum class OtaJobKind { Check, Install };

struct OtaJob {
  OtaJobKind kind = OtaJobKind::Check;
  std::string manifestUrl;
  std::string currentVersion;
  uint8_t protocolVersion = 0;
  std::array<uint8_t, 32> publicKey{};
  bool developmentTransport = false;
  std::optional<FirmwareManifest> candidate;
  int64_t checkedAtEpochSeconds = 0;
};

struct OtaResult {
  OtaJobKind kind = OtaJobKind::Check;
  FirmwareUpdateStatus status = FirmwareUpdateStatus::Idle;
  FirmwareUpdateError error = FirmwareUpdateError::None;
  std::string targetVersion;
  std::string targetHash;
  int64_t checkedAtEpochSeconds = 0;
  bool rebootRequired = false;
  std::optional<FirmwareManifest> candidate;
};

#ifdef ARDUINO
class OtaStateStore final : public OtaCommitStore {
 public:
  bool blocked(std::string_view version, std::string_view hash) const;
  bool stageCandidate(const std::string& version, const std::string& hash,
                      int64_t checkedAtEpochSeconds) override;
  bool markBootPending() override;
  bool recordFailure(const std::string& version, const std::string& hash,
                     FirmwareUpdateError error);
  bool clearPending() override;
  bool prepareBoot(std::string_view runningVersion, OtaResult& snapshot,
                   bool& candidateNeedsValidation);
  bool confirmBoot(std::string_view runningVersion, OtaResult& snapshot);
  bool rejectCandidateAndReboot();
  bool loadSnapshot(OtaResult& snapshot) const;
};

class OtaWorker {
 public:
  explicit OtaWorker(OtaStateStore& stateStore);
  ~OtaWorker();

  bool begin();
  bool enqueue(OtaJob&& job);
  bool poll(OtaResult& output);
  bool busy() const;
  FirmwareUpdateStatus status() const;

 private:
  static void taskEntry(void* context);
  void taskLoop();
  void execute(const OtaJob& job, OtaResult& output);

  OtaStateStore& stateStore_;
  QueueHandle_t pendingQueue_ = nullptr;
  QueueHandle_t resultQueue_ = nullptr;
  SemaphoreHandle_t slotMutex_ = nullptr;
  SemaphoreHandle_t stopAck_ = nullptr;
  TaskHandle_t task_ = nullptr;
  OtaJob job_;
  OtaResult result_;
  std::atomic<bool> busy_{false};
  std::atomic<bool> stopRequested_{false};
  std::atomic<FirmwareUpdateStatus> status_{FirmwareUpdateStatus::Idle};
};
#endif

}  // namespace openjornada
