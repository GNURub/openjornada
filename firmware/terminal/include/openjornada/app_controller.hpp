#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "openjornada/api_models.hpp"
#include "openjornada/admin_flow.hpp"
#include "openjornada/cache_store.hpp"
#include "openjornada/clock_trust.hpp"
#include "openjornada/config.hpp"
#include "openjornada/network_worker.hpp"
#include "openjornada/outbox.hpp"
#include "openjornada/screen.hpp"
#include "openjornada/sync_engine.hpp"

namespace openjornada {

enum class AppEventKind { Timer, TagScanned, ButtonPressed, ButtonHeld };

struct AppEvent {
  AppEventKind kind = AppEventKind::Timer;
  uint32_t nowMs = 0;
  int64_t nowEpochSeconds = 0;
  std::string timestamp;
  std::string uid;
  Button button = Button::A;
  bool networkConnected = false;
  bool ntpTrusted = false;
  int64_t ntpSyncEpochSeconds = 0;
  bool buttonADown = false;
  bool buttonBDown = false;
  bool buttonCDown = false;
};

struct AppControllerConfig {
  ApiCredentials credentials;
  std::string clientVersion;
  std::string rebootId;
  std::string terminalId;
  std::string clockSyncedAt;
  std::string configFingerprint;
  int64_t lastNtpEpochSeconds = 0;
  CacheSnapshot initialCache;
};

enum class AppFeedback { None, Success, Error };

std::string isoUtc(int64_t epochSeconds);
const char* greetingForLocalHour(int hour);

class AppController {
 public:
  AppController(NetworkWorker& worker, Outbox& outbox,
                AppControllerConfig config, CacheStore* cacheStore = nullptr,
                ConfigStore* configStore = nullptr);

  void start(size_t pendingCount, uint32_t nowMs);
  void tick(const AppEvent& event);

  const ScreenState& screen() const { return screen_; }
  const ApiWorkState& lastAuthoritativeState() const {
    return lastAuthoritativeState_;
  }
  const std::string& timezone() const { return timezone_; }
  AppFeedback takeFeedback();

 private:
  static constexpr uint32_t kActionSelectionMs = 10000;
  static constexpr uint32_t kMessageMs = 5000;
  static constexpr uint32_t kSuccessMessageMs = 2500;
  static constexpr uint32_t kInteractionInactivityMs = 30000;

  void updateStatus(const AppEvent& event);
  void processNetworkResults(const AppEvent& event);
  void processNetworkResult(NetworkResult&& result, const AppEvent& event);
  void handleTimer(const AppEvent& event);
  void handleTag(const AppEvent& event);
  void handleButton(const AppEvent& event, bool held);
  void handleAdminTimer(const AppEvent& event);
  void openAdminPin(uint32_t nowMs);
  void enqueueAdminSession(const std::string& pin, const AppEvent& event);
  void enqueueEmployees(const AppEvent& event);
  void enqueueAssignment(const AppEvent& event, bool replace);
  void exitAdmin();
  void rememberAbandonedAdminJob(uint32_t id);
  bool consumeAbandonedAdminJob(uint32_t id);
  void showAdminEmployees();
  void enqueueBootstrap(uint32_t nowMs);
  void enqueueCacheRefresh(uint32_t nowMs);
  void enqueueSync(const AppEvent& event);
  void handleCacheResult(NetworkResult&& result, const AppEvent& event);
  void handleSyncResult(NetworkResult&& result, const AppEvent& event);
  void enqueueCloseRefresh(const AppEvent& event);
  void showQueuedCloseConfirm(uint32_t nowMs);
  void showActions(uint32_t nowMs);
  void openTimePicker(Command command, bool closesBreak,
                      const AppEvent& event);
  void executeAction(Command command, const AppEvent& event,
                     std::optional<int64_t> appliedEpoch = std::nullopt,
                     bool closeAfterBreak = false);
  void handleActionResult(NetworkResult&& result, const AppEvent& event);
  void showActionMessage(Command command, std::string detail,
                         const AppEvent& event, uint32_t durationMs);
  void showMessage(std::string detail, uint32_t nowMs, uint32_t durationMs,
                   bool error = false);
  void returnToIdle();
  bool refreshPendingCount();
  bool markActionComplete(const std::string& clientRequestId);
  bool applyLocalAction(const QueuedAction& action);
  bool updateCachedState(const std::string& uid, const ApiWorkState& state);
  void observeMonotonic(uint32_t nowMs);
  int64_t effectiveCapturedEpoch(const AppEvent& event) const;
  void failClosedOnOutbox();
  void persistRuntimeState();
  bool rehydratePending();
  std::optional<ResolveResponse> resolveFromCache(const std::string& uid) const;
  void clearActiveActionTracking();
  void armInteractionDeadline(uint32_t nowMs);
  void setActionButtons();
  std::string makeRequestId(uint32_t sequence) const;

  NetworkWorker& worker_;
  Outbox& outbox_;
  CacheStore* cacheStore_;
  ConfigStore* configStore_;
  AppControllerConfig config_;
  CacheSnapshot cache_;
  ClockTrust clockTrust_;
  SyncEngine syncEngine_;
  AdminFlow adminFlow_;
  ScreenState screen_;
  std::optional<ResolveResponse> resolved_;
  ApiWorkState lastAuthoritativeState_{};
  std::string currentUid_;
  std::string terminalId_;
  std::string timezone_;
  std::string clockSyncedAt_;
  int64_t serverTimeEpochSeconds_ = 0;
  uint64_t monotonicMs_ = 0;
  uint64_t serverTimeObservedAtMonotonicMs_ = 0;
  uint32_t lastObservedNowMs_ = 0;
  bool monotonicInitialized_ = false;
  std::string lastLocalHash_;
  std::string activeActionRequestId_;
  std::string closeExpectedEmployeeId_;
  std::vector<QueuedAction> activeSyncBatch_;
  EmployeeListResponse adminEmployees_;
  std::string pendingAdminUid_;
  uint32_t sequence_ = 0;
  uint32_t nextJobId_ = 1;
  uint32_t activeJobId_ = 0;
  uint32_t bootstrapRetryAtMs_ = 0;
  uint32_t messageNextAtMs_ = 0;
  uint32_t selectedActionDeadlineMs_ = 0;
  uint32_t interactionDeadlineMs_ = 0;
  uint32_t lastPickerPressAtMs_ = 0;
  size_t selectedEmployeeIndex_ = 0;
  int64_t pickerMinEpochSeconds_ = 0;
  int64_t pickerMaxEpochSeconds_ = 0;
  std::optional<Button> lastPickerPress_;
  Command pickerCommand_ = Command::ClockOut;
  Command activeActionCommand_ = Command::ClockIn;
  bool pickerClosesBreak_ = false;
  bool activeActionClosesBreak_ = false;
  bool interactionDeadlineActive_ = false;
  bool messageDeadlineActive_ = false;
  bool resolveForClockOut_ = false;
  bool started_ = false;
  bool bootstrapReady_ = false;
  bool bootstrapQueued_ = false;
  bool cacheRefreshQueued_ = false;
  bool cacheRefreshDone_ = false;
  bool syncBlocked_ = false;
  bool outboxOperational_ = true;
  bool resolvedOffline_ = false;
  bool closeBreakQueued_ = false;
  bool cacheRefreshForAdmin_ = false;
  std::array<uint32_t, NetworkWorker::kQueueCapacity>
      abandonedAdminJobIds_{};
  AppFeedback feedback_ = AppFeedback::None;
};

}  // namespace openjornada
