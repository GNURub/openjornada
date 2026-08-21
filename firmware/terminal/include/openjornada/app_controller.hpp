#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include "openjornada/api_models.hpp"
#include "openjornada/network_worker.hpp"
#include "openjornada/outbox.hpp"
#include "openjornada/screen.hpp"

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
};

struct AppControllerConfig {
  ApiCredentials credentials;
  std::string clientVersion;
  std::string rebootId;
};

enum class AppFeedback { None, Success, Error };

std::string isoUtc(int64_t epochSeconds);

class AppController {
 public:
  AppController(NetworkWorker& worker, Outbox& outbox,
                AppControllerConfig config);

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
  void enqueueBootstrap(uint32_t nowMs);
  void enqueueCloseRefresh(const AppEvent& event);
  void showActions(uint32_t nowMs);
  void openTimePicker(Command command, bool closesBreak,
                      const AppEvent& event);
  void executeAction(Command command, const AppEvent& event,
                     std::optional<int64_t> appliedEpoch = std::nullopt,
                     bool closeAfterBreak = false);
  void handleActionResult(NetworkResult&& result, const AppEvent& event);
  void showMessage(std::string detail, uint32_t nowMs, uint32_t durationMs,
                   bool error = false);
  void returnToIdle();
  void refreshPendingCount();
  bool markActionComplete(const std::string& clientRequestId);
  void clearActiveActionTracking();
  void armInteractionDeadline(uint32_t nowMs);
  void setActionButtons();
  std::string makeRequestId(uint32_t sequence) const;

  NetworkWorker& worker_;
  Outbox& outbox_;
  AppControllerConfig config_;
  ScreenState screen_;
  std::optional<ResolveResponse> resolved_;
  ApiWorkState lastAuthoritativeState_{};
  std::string currentUid_;
  std::string terminalId_;
  std::string timezone_;
  std::string clockSyncedAt_;
  std::string lastLocalHash_;
  std::string activeActionRequestId_;
  std::string closeExpectedEmployeeId_;
  uint32_t sequence_ = 0;
  uint32_t nextJobId_ = 1;
  uint32_t activeJobId_ = 0;
  uint32_t bootstrapRetryAtMs_ = 0;
  uint32_t messageNextAtMs_ = 0;
  uint32_t selectedActionDeadlineMs_ = 0;
  uint32_t interactionDeadlineMs_ = 0;
  uint32_t lastPickerPressAtMs_ = 0;
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
  AppFeedback feedback_ = AppFeedback::None;
};

}  // namespace openjornada
