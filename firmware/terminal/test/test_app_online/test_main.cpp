#include <unity.h>

#include <algorithm>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "openjornada/app_controller.hpp"

using namespace openjornada;

namespace {

class MemoryStorage final : public OutboxStorage {
 public:
  bool exists(const char* path) const override { return files.count(path) > 0; }
  bool size(const char* path, size_t& output) const override {
    const auto found = files.find(path);
    if (found == files.end()) return false;
    output = found->second.size();
    return true;
  }
  bool read(const char* path, size_t offset, uint8_t* output,
            size_t length) const override {
    const auto found = files.find(path);
    if (found == files.end() || offset > found->second.size() ||
        length > found->second.size() - offset) {
      return false;
    }
    std::copy_n(found->second.data() + offset, length, output);
    return true;
  }
  bool appendAndFlush(const char* path,
                      const std::vector<uint8_t>& bytes) override {
    if (failNextAppend) {
      failNextAppend = false;
      return false;
    }
    auto& target = files[path];
    target.insert(target.end(), bytes.begin(), bytes.end());
    ++flushes;
    return true;
  }
  bool writeAndFlush(const char* path,
                     const std::vector<uint8_t>& bytes) override {
    files[path] = bytes;
    ++flushes;
    return true;
  }
  bool remove(const char* path) override { return files.erase(path) > 0; }
  bool rename(const char* from, const char* to) override {
    const auto found = files.find(from);
    if (found == files.end()) return false;
    files[to] = found->second;
    files.erase(found);
    return true;
  }

  mutable std::map<std::string, std::vector<uint8_t>> files;
  size_t flushes = 0;
  bool failNextAppend = false;
};

class FakeApi final : public ApiClient {
 public:
  explicit FakeApi(Outbox& outbox) : outbox_(outbox) {}

  ResolveResponse nextResolve;
  ApiCallResult resolveCall;
  ActionResult nextAction;
  ApiCallResult actionCall;
  size_t pendingObservedByAction = 0;
  ActionRequest lastAction;
  int actionCalls = 0;
  int resolveCalls = 0;
  std::string lastResolvedUid;
  size_t pendingObservedByResolve = 0;

  ApiCallResult bootstrap(const ApiCredentials&, const BootstrapRequest&,
                          BootstrapResponse& output, uint32_t) override {
    output.protocol = {1, 1, 1};
    output.serverTime = "2026-08-21T10:00:00Z";
    output.timezone = "Europe/Madrid";
    output.terminal.id = "terminal-test";
    output.maxOfflineSeconds = 86400;
    output.maxQueuedActions = 10000;
    return {};
  }
  ApiCallResult resolve(const ApiCredentials&, const std::string& uid,
                        ResolveResponse& output, uint32_t) override {
    ++resolveCalls;
    lastResolvedUid = uid;
    TEST_ASSERT_EQUAL(OutboxError::None,
                      outbox_.pendingCount(pendingObservedByResolve));
    output = nextResolve;
    return resolveCall;
  }
  ApiCallResult action(const ApiCredentials&, const ActionRequest& request,
                       ActionResult& output, uint32_t) override {
    ++actionCalls;
    lastAction = request;
    TEST_ASSERT_EQUAL(OutboxError::None,
                      outbox_.pendingCount(pendingObservedByAction));
    output = nextAction;
    if (output.clientRequestId.empty()) {
      output.clientRequestId = request.clientRequestId;
    }
    return actionCall;
  }
  ApiCallResult cache(const ApiCredentials&, uint32_t, CacheResponse&,
                      uint32_t) override { return {}; }
  ApiCallResult openAdminSession(const ApiCredentials&, const std::string&,
                                 AdminSessionResponse&, uint32_t) override {
    return {};
  }
  ApiCallResult closeAdminSession(const ApiCredentials&, const std::string&,
                                  uint32_t) override { return {}; }
  ApiCallResult employees(const ApiCredentials&, const std::string&,
                          EmployeeListResponse&, uint32_t) override { return {}; }
  ApiCallResult assignEmployee(const ApiCredentials&, const std::string&,
                               const std::string&, const std::string&, bool,
                               uint32_t) override { return {}; }
  ApiCallResult revokeEmployee(const ApiCredentials&, const std::string&,
                               const std::string&, uint32_t) override { return {}; }
  ApiCallResult sync(const ApiCredentials&, const SyncRequest&, SyncResponse&,
                     uint32_t) override { return {}; }

 private:
  Outbox& outbox_;
};

struct Fixture {
  MemoryStorage storage;
  Outbox outbox{storage};
  FakeApi api{outbox};
  NetworkWorker worker{api};
  AppController app{worker, outbox,
                    {{"https://jornada.example.es", "ojterm_test_token"},
                     "m5stack-test", "reboot-test"}};
  uint32_t nowMs = 1000;
  int64_t epoch = 1787306400;  // 2026-08-21T10:00:00Z

  Fixture() {
    TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
    TEST_ASSERT_TRUE(worker.begin());
    app.start(0, nowMs);
    tick();
    networkRoundTrip();
    TEST_ASSERT_EQUAL(ScreenKind::Idle, app.screen().kind);
  }

  AppEvent event(AppEventKind kind) const {
    AppEvent value;
    value.kind = kind;
    value.nowMs = nowMs;
    value.nowEpochSeconds = epoch;
    value.timestamp = isoUtc(epoch);
    value.networkConnected = true;
    value.ntpTrusted = true;
    return value;
  }

  void tick(uint32_t advanceMs = 0) {
    nowMs += advanceMs;
    epoch += advanceMs / 1000;
    app.tick(event(AppEventKind::Timer));
  }

  void networkRoundTrip() {
    TEST_ASSERT_TRUE(worker.processOne());
    tick();
  }

  void scan(const ApiWorkState& state) {
    api.resolveCall = {};
    api.nextResolve = {};
    api.nextResolve.scanContext = "scan-context";
    api.nextResolve.expiresAt = "2026-08-21T10:00:10Z";
    api.nextResolve.employee = {"employee-1", "Marina"};
    api.nextResolve.state = state;
    AppEvent scan = event(AppEventKind::TagScanned);
    scan.uid = "04AABBCC";
    app.tick(scan);
    networkRoundTrip();
    TEST_ASSERT_EQUAL(ScreenKind::Actions, app.screen().kind);
  }

  void press(Button button, bool networkConnected = true) {
    AppEvent press = event(AppEventKind::ButtonPressed);
    press.button = button;
    press.networkConnected = networkConnected;
    app.tick(press);
  }

  void hold(Button button) {
    AppEvent held = event(AppEventKind::ButtonHeld);
    held.button = button;
    app.tick(held);
  }

  void accepted(WorkKind state) {
    api.actionCall = {};
    api.nextAction = {};
    api.nextAction.status = ActionStatus::Accepted;
    api.nextAction.state.kind = state;
  }
};

ApiWorkState work(WorkKind kind, bool longShift = false,
                  bool staleBreak = false) {
  ApiWorkState state;
  state.kind = kind;
  if (kind != WorkKind::Idle) state.since = "2026-08-21T06:00:00Z";
  state.longShift = longShift;
  state.staleBreak = staleBreak;
  state.workedSeconds = longShift ? 4 * 60 * 60 : 60 * 60;
  state.breakSeconds = staleBreak ? 26 * 60 : 0;
  return state;
}

QueuedAction pendingAction(std::string id) {
  QueuedAction action;
  action.clientRequestId = std::move(id);
  action.uid = "04112233";
  action.command = Command::ClockIn;
  action.deviceCapturedAt = "2026-08-21T09:00:00Z";
  action.clockSyncedAt = "2026-08-21T08:59:59Z";
  action.deviceSequence = 1;
  action.rebootId = "older-boot";
  action.signature = std::string(64, 'a');
  return action;
}

void test_idle_clock_in_is_durable_before_network_and_completes() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Idle));
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  TEST_ASSERT_EQUAL_UINT32(1, fixture.app.screen().pendingCount);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, fixture.api.pendingObservedByAction);
  TEST_ASSERT_EQUAL(Command::ClockIn, fixture.api.lastAction.command);
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);
}

void test_pending_network_work_keeps_its_busy_screen_until_result() {
  Fixture fixture;
  fixture.api.nextResolve.scanContext = "delayed-context";
  fixture.api.nextResolve.employee = {"employee-1", "Marina"};
  fixture.api.nextResolve.state = work(WorkKind::Idle);
  AppEvent scan = fixture.event(AppEventKind::TagScanned);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  fixture.tick(6000);
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);
  TEST_ASSERT_TRUE(fixture.app.screen().busy);
  fixture.networkRoundTrip();

  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  fixture.tick(6000);
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);
  TEST_ASSERT_TRUE(fixture.app.screen().busy);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
}

void test_working_buttons_and_long_shift_layout_match_simulator() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Working));
  TEST_ASSERT_EQUAL_STRING("Pausa", fixture.app.screen().buttons.a.c_str());
  TEST_ASSERT_TRUE(fixture.app.screen().buttons.b.empty());
  TEST_ASSERT_EQUAL_STRING("Terminar", fixture.app.screen().buttons.c.c_str());

  fixture.tick(10001);
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
  fixture.scan(work(WorkKind::Working, true));
  TEST_ASSERT_EQUAL_STRING("Pausa", fixture.app.screen().buttons.a.c_str());
  TEST_ASSERT_EQUAL_STRING("Terminar ahora",
                           fixture.app.screen().buttons.b.c_str());
  TEST_ASSERT_EQUAL_STRING("Terminé antes",
                           fixture.app.screen().buttons.c.c_str());

  fixture.tick(10001);
  ApiWorkState threshold = work(WorkKind::Working);
  threshold.longShift = false;
  threshold.workedSeconds = 4 * 60 * 60;
  fixture.scan(threshold);
  TEST_ASSERT_EQUAL_STRING("Terminar ahora",
                           fixture.app.screen().buttons.b.c_str());
}

void test_working_pause_and_clock_out_commands() {
  Fixture pause;
  pause.scan(work(WorkKind::Working));
  pause.accepted(WorkKind::OnBreak);
  pause.press(Button::A);
  pause.networkRoundTrip();
  TEST_ASSERT_EQUAL(Command::BreakStart, pause.api.lastAction.command);

  Fixture finish;
  finish.scan(work(WorkKind::Working));
  finish.accepted(WorkKind::Idle);
  finish.press(Button::C);
  finish.networkRoundTrip();
  TEST_ASSERT_EQUAL(Command::ClockOut, finish.api.lastAction.command);
}

void test_duplicate_and_action_rejection_are_definitive() {
  Fixture duplicate;
  duplicate.scan(work(WorkKind::Idle));
  duplicate.accepted(WorkKind::Working);
  duplicate.api.nextAction.status = ActionStatus::Duplicate;
  duplicate.press(Button::B);
  duplicate.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(0, duplicate.app.screen().pendingCount);

  Fixture rejected;
  rejected.scan(work(WorkKind::Idle));
  rejected.accepted(WorkKind::Idle);
  rejected.api.nextAction.status = ActionStatus::Rejected;
  rejected.api.nextAction.errorCode = ApiErrorCode::InactiveEmployee;
  rejected.press(Button::B);
  rejected.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(0, rejected.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("La persona no está activa.",
                           rejected.app.screen().detail.c_str());
}

void test_completion_write_failure_keeps_accepted_action_pending() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Idle));
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  fixture.storage.failNextAppend = true;
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("Registrado; pendiente de sincronizar",
                           fixture.app.screen().detail.c_str());
}

void test_completion_failure_preserves_each_server_outcome_semantics() {
  Fixture duplicate;
  duplicate.scan(work(WorkKind::Idle));
  duplicate.accepted(WorkKind::Working);
  duplicate.api.nextAction.status = ActionStatus::Duplicate;
  duplicate.press(Button::B);
  duplicate.storage.failNextAppend = true;
  duplicate.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, duplicate.app.screen().pendingCount);
  TEST_ASSERT_FALSE(duplicate.app.screen().warning);
  TEST_ASSERT_EQUAL_STRING("Registrado; pendiente de sincronizar",
                           duplicate.app.screen().detail.c_str());

  Fixture incident;
  incident.scan(work(WorkKind::Idle));
  incident.accepted(WorkKind::Idle);
  incident.api.nextAction.status = ActionStatus::Incident;
  incident.press(Button::B);
  incident.storage.failNextAppend = true;
  incident.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, incident.app.screen().pendingCount);
  TEST_ASSERT_TRUE(incident.app.screen().warning);
  TEST_ASSERT_NOT_NULL(std::strstr(incident.app.screen().detail.c_str(),
                                  "Pendiente de reconciliar"));

  Fixture rejected;
  rejected.scan(work(WorkKind::Idle));
  rejected.accepted(WorkKind::Idle);
  rejected.api.nextAction.status = ActionStatus::Rejected;
  rejected.api.nextAction.errorCode = ApiErrorCode::InactiveEmployee;
  rejected.press(Button::B);
  rejected.storage.failNextAppend = true;
  rejected.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, rejected.app.screen().pendingCount);
  TEST_ASSERT_TRUE(rejected.app.screen().warning);
  TEST_ASSERT_NOT_NULL(std::strstr(rejected.app.screen().detail.c_str(),
                                  "La persona no está activa"));
  TEST_ASSERT_NOT_NULL(std::strstr(rejected.app.screen().detail.c_str(),
                                  "Pendiente de reconciliar"));

  Fixture failedCall;
  failedCall.scan(work(WorkKind::Idle));
  failedCall.api.actionCall.ok = false;
  failedCall.api.actionCall.failure.code = ApiErrorCode::InactiveEmployee;
  failedCall.api.actionCall.failure.safeMessage = "La persona no está activa.";
  failedCall.press(Button::B);
  failedCall.storage.failNextAppend = true;
  failedCall.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, failedCall.app.screen().pendingCount);
  TEST_ASSERT_TRUE(failedCall.app.screen().warning);
  TEST_ASSERT_NOT_NULL(std::strstr(failedCall.app.screen().detail.c_str(),
                                  "Pendiente de reconciliar"));
}

void test_stale_pause_warns_and_actions_expire_after_ten_seconds() {
  Fixture fixture;
  fixture.scan(work(WorkKind::OnBreak, false, true));
  TEST_ASSERT_TRUE(fixture.app.screen().warning);
  TEST_ASSERT_EQUAL_STRING("Pausa abierta hace más de 25 min",
                           fixture.app.screen().detail.c_str());
  fixture.tick(9999);
  TEST_ASSERT_EQUAL(ScreenKind::Actions, fixture.app.screen().kind);
  fixture.tick(2);
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
}

void test_time_picker_steps_five_and_held_steps_thirty() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Working, true));
  fixture.press(Button::C);
  TEST_ASSERT_EQUAL(ScreenKind::TimePicker, fixture.app.screen().kind);
  const auto initial = fixture.app.screen().selectedEpochSeconds;
  fixture.press(Button::A);
  TEST_ASSERT_EQUAL_INT64(initial - 5 * 60,
                          fixture.app.screen().selectedEpochSeconds);
  fixture.hold(Button::C);
  TEST_ASSERT_EQUAL_INT64(initial,
                          fixture.app.screen().selectedEpochSeconds);
  fixture.accepted(WorkKind::Idle);
  fixture.press(Button::B);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL(Command::ClockOut, fixture.api.lastAction.command);
  TEST_ASSERT_FALSE(fixture.api.lastAction.appliedAt.empty());

  Fixture physicalHold;
  physicalHold.scan(work(WorkKind::Working, true));
  physicalHold.press(Button::C);
  const auto beforeHold = physicalHold.app.screen().selectedEpochSeconds;
  physicalHold.press(Button::C);
  physicalHold.hold(Button::C);
  TEST_ASSERT_EQUAL_INT64(beforeHold,
                          physicalHold.app.screen().selectedEpochSeconds);

  Fixture backwardHold;
  backwardHold.scan(work(WorkKind::Working, true));
  backwardHold.press(Button::C);
  const auto beforeBackwardHold =
      backwardHold.app.screen().selectedEpochSeconds;
  backwardHold.press(Button::A);
  backwardHold.hold(Button::A);
  TEST_ASSERT_EQUAL_INT64(beforeBackwardHold - 30 * 60,
                          backwardHold.app.screen().selectedEpochSeconds);

  Fixture lowerBound;
  ApiWorkState bounded = work(WorkKind::Working, true);
  bounded.since = "2026-08-21T09:45:00Z";
  lowerBound.scan(bounded);
  lowerBound.press(Button::C);
  const auto upper = lowerBound.app.screen().selectedEpochSeconds;
  lowerBound.press(Button::A);
  lowerBound.hold(Button::A);
  TEST_ASSERT_EQUAL_INT64(upper - 15 * 60,
                          lowerBound.app.screen().selectedEpochSeconds);
}

void test_close_from_break_asks_time_then_close_confirmation() {
  Fixture fixture;
  fixture.scan(work(WorkKind::OnBreak));
  fixture.press(Button::C);
  TEST_ASSERT_EQUAL(ScreenKind::TimePicker, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("¿A qué hora terminaste la pausa?",
                           fixture.app.screen().title.c_str());
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL(Command::BreakEnd, fixture.api.lastAction.command);
  TEST_ASSERT_EQUAL(ScreenKind::CloseConfirm, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("No", fixture.app.screen().buttons.a.c_str());
  TEST_ASSERT_EQUAL_STRING("Sí", fixture.app.screen().buttons.c.c_str());
  fixture.tick(5000);
  fixture.api.nextResolve.scanContext = "fresh-scan-context";
  fixture.api.nextResolve.state = work(WorkKind::Working);
  fixture.accepted(WorkKind::Idle);
  fixture.press(Button::C);
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_INT(1, fixture.api.actionCalls);
  TEST_ASSERT_TRUE(fixture.app.screen().busy);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(0, fixture.api.pendingObservedByResolve);
  TEST_ASSERT_EQUAL_UINT32(1, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_INT(1, fixture.api.actionCalls);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_INT(2, fixture.api.actionCalls);
  TEST_ASSERT_EQUAL(Command::ClockOut, fixture.api.lastAction.command);
  TEST_ASSERT_EQUAL_STRING("fresh-scan-context",
                           fixture.api.lastAction.scanContext.c_str());
  TEST_ASSERT_EQUAL_INT(2, fixture.api.resolveCalls);
}

void test_close_from_break_refresh_failure_never_appends_clock_out() {
  Fixture fixture;
  fixture.scan(work(WorkKind::OnBreak));
  fixture.press(Button::C);
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL(ScreenKind::CloseConfirm, fixture.app.screen().kind);

  fixture.api.resolveCall.ok = false;
  fixture.api.resolveCall.failure.code = ApiErrorCode::ScanContextExpired;
  fixture.api.resolveCall.failure.safeMessage = "Vuelve a acercar el tag.";
  fixture.press(Button::C);
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_INT(1, fixture.api.actionCalls);
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
  TEST_ASSERT_TRUE(fixture.app.screen().warning);
}

void test_close_refresh_rejects_reassigned_uid_and_unexpected_state() {
  Fixture reassigned;
  reassigned.scan(work(WorkKind::OnBreak));
  reassigned.press(Button::C);
  reassigned.accepted(WorkKind::Working);
  reassigned.press(Button::B);
  reassigned.networkRoundTrip();
  TEST_ASSERT_EQUAL(ScreenKind::CloseConfirm,
                    reassigned.app.screen().kind);
  reassigned.api.nextResolve.scanContext = "other-employee-context";
  reassigned.api.nextResolve.employee = {"employee-2", "Otra persona"};
  reassigned.api.nextResolve.state = work(WorkKind::Working);
  reassigned.press(Button::C);
  TEST_ASSERT_EQUAL_UINT32(0, reassigned.app.screen().pendingCount);
  reassigned.networkRoundTrip();
  TEST_ASSERT_EQUAL_INT(1, reassigned.api.actionCalls);
  TEST_ASSERT_EQUAL_UINT32(0, reassigned.app.screen().pendingCount);
  TEST_ASSERT_TRUE(reassigned.app.screen().warning);
  TEST_ASSERT_NOT_NULL(std::strstr(reassigned.app.screen().detail.c_str(),
                                  "otra persona"));

  Fixture changedState;
  changedState.scan(work(WorkKind::OnBreak));
  changedState.press(Button::C);
  changedState.accepted(WorkKind::Working);
  changedState.press(Button::B);
  changedState.networkRoundTrip();
  changedState.api.nextResolve.scanContext = "new-context";
  changedState.api.nextResolve.employee = {"employee-1", "Marina"};
  changedState.api.nextResolve.state = work(WorkKind::Idle);
  changedState.press(Button::C);
  changedState.networkRoundTrip();
  TEST_ASSERT_EQUAL_INT(1, changedState.api.actionCalls);
  TEST_ASSERT_EQUAL_UINT32(0, changedState.app.screen().pendingCount);
  TEST_ASSERT_EQUAL(WorkKind::Idle,
                    changedState.app.lastAuthoritativeState().kind);
  TEST_ASSERT_TRUE(changedState.app.screen().warning);
}

void test_close_refresh_network_and_queue_failure_are_safe() {
  Fixture offline;
  offline.scan(work(WorkKind::OnBreak));
  offline.press(Button::C);
  offline.accepted(WorkKind::Working);
  offline.press(Button::B);
  offline.networkRoundTrip();
  offline.press(Button::C, false);
  TEST_ASSERT_EQUAL_UINT32(0, offline.app.screen().pendingCount);
  TEST_ASSERT_TRUE(offline.app.screen().warning);
  TEST_ASSERT_EQUAL_INT(1, offline.api.actionCalls);

  Fixture saturated;
  saturated.scan(work(WorkKind::OnBreak));
  saturated.press(Button::C);
  saturated.accepted(WorkKind::Working);
  saturated.press(Button::B);
  saturated.networkRoundTrip();
  for (uint32_t index = 0; index < NetworkWorker::kQueueCapacity; ++index) {
    NetworkJob queued;
    queued.id = 100 + index;
    queued.kind = NetworkJobKind::Resolve;
    queued.credentials = {"https://jornada.example.es", "ojterm_test_token"};
    queued.uid = "04112233";
    TEST_ASSERT_TRUE(saturated.worker.enqueue(queued));
  }
  saturated.press(Button::C);
  TEST_ASSERT_EQUAL_UINT32(0, saturated.app.screen().pendingCount);
  TEST_ASSERT_TRUE(saturated.app.screen().warning);
  TEST_ASSERT_EQUAL_INT(1, saturated.api.actionCalls);
}

void test_picker_and_close_confirm_expire_and_interaction_resets_picker() {
  Fixture picker;
  picker.scan(work(WorkKind::Working, true));
  picker.press(Button::C);
  picker.tick(29999);
  TEST_ASSERT_EQUAL(ScreenKind::TimePicker, picker.app.screen().kind);
  picker.press(Button::A);
  picker.tick(29999);
  TEST_ASSERT_EQUAL(ScreenKind::TimePicker, picker.app.screen().kind);
  picker.tick(2);
  TEST_ASSERT_EQUAL(ScreenKind::Idle, picker.app.screen().kind);
  picker.scan(work(WorkKind::Idle));
  TEST_ASSERT_EQUAL(ScreenKind::Actions, picker.app.screen().kind);

  Fixture confirmation;
  confirmation.scan(work(WorkKind::OnBreak));
  confirmation.press(Button::C);
  confirmation.accepted(WorkKind::Working);
  confirmation.press(Button::B);
  confirmation.networkRoundTrip();
  TEST_ASSERT_EQUAL(ScreenKind::CloseConfirm,
                    confirmation.app.screen().kind);
  confirmation.press(Button::B);
  confirmation.tick(30001);
  TEST_ASSERT_EQUAL(ScreenKind::Idle, confirmation.app.screen().kind);
}

void test_picker_inactivity_deadline_is_millis_wrap_safe() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Working, true));
  fixture.nowMs = UINT32_MAX - 10U;
  fixture.press(Button::C);
  fixture.tick(29999);
  TEST_ASSERT_EQUAL(ScreenKind::TimePicker, fixture.app.screen().kind);
  fixture.tick(2);
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
}

void test_time_picker_crosses_midnight_without_losing_the_date() {
  Fixture fixture;
  fixture.epoch = 1787356920;  // 2026-08-22T00:02:00Z
  ApiWorkState state = work(WorkKind::Working, true);
  state.since = "2026-08-21T20:00:00Z";
  fixture.scan(state);
  fixture.press(Button::C);
  fixture.press(Button::A);
  fixture.accepted(WorkKind::Idle);
  fixture.press(Button::B);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_STRING("2026-08-21T23:57:00Z",
                           fixture.api.lastAction.appliedAt.c_str());
}

void test_ambiguous_transport_keeps_pending_and_definitive_rejection_removes_it() {
  Fixture ambiguous;
  ambiguous.scan(work(WorkKind::Idle));
  ambiguous.api.actionCall.ok = false;
  ambiguous.api.actionCall.failure.code = ApiErrorCode::Timeout;
  ambiguous.api.actionCall.failure.retryable = true;
  ambiguous.press(Button::B);
  ambiguous.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, ambiguous.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("Guardado; se sincronizará",
                           ambiguous.app.screen().detail.c_str());

  Fixture rejected;
  rejected.scan(work(WorkKind::Idle));
  rejected.api.actionCall.ok = false;
  rejected.api.actionCall.failure.code = ApiErrorCode::InactiveEmployee;
  rejected.api.actionCall.failure.safeMessage = "La persona no está activa.";
  rejected.press(Button::B);
  rejected.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(0, rejected.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("La persona no está activa.",
                           rejected.app.screen().detail.c_str());

  Fixture malformedSuccess;
  malformedSuccess.scan(work(WorkKind::Idle));
  malformedSuccess.api.actionCall.ok = false;
  malformedSuccess.api.actionCall.failure.code = ApiErrorCode::InvalidResponse;
  malformedSuccess.api.actionCall.failure.httpStatus = 200;
  malformedSuccess.press(Button::B);
  malformedSuccess.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, malformedSuccess.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("Guardado; se sincronizará",
                           malformedSuccess.app.screen().detail.c_str());

  Fixture mismatchedId;
  TEST_ASSERT_EQUAL(OutboxError::None,
                    mismatchedId.outbox.append(
                        pendingAction("different-request")));
  mismatchedId.scan(work(WorkKind::Idle));
  mismatchedId.accepted(WorkKind::Working);
  mismatchedId.api.nextAction.clientRequestId = "different-request";
  mismatchedId.press(Button::B);
  mismatchedId.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(2, mismatchedId.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("Guardado; se sincronizará",
                           mismatchedId.app.screen().detail.c_str());

  Fixture failedWithPartialPayload;
  failedWithPartialPayload.scan(work(WorkKind::Idle));
  failedWithPartialPayload.api.actionCall.ok = false;
  failedWithPartialPayload.api.actionCall.failure.code =
      ApiErrorCode::InactiveEmployee;
  failedWithPartialPayload.api.nextAction.clientRequestId =
      "different-request";
  failedWithPartialPayload.press(Button::B);
  TEST_ASSERT_EQUAL(
      OutboxError::None,
      failedWithPartialPayload.outbox.append(
          pendingAction("different-request")));
  failedWithPartialPayload.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1,
                           failedWithPartialPayload.app.screen().pendingCount);
}

void test_409_uses_authoritative_state_and_completes_attempt() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Working));
  fixture.api.actionCall.ok = false;
  fixture.api.actionCall.failure.code = ApiErrorCode::StateConflict;
  fixture.api.actionCall.failure.httpStatus = 409;
  fixture.api.actionCall.failure.safeMessage =
      "El estado de la jornada ha cambiado; acerca de nuevo el tag.";
  fixture.api.actionCall.failure.authoritativeState = work(WorkKind::OnBreak);
  fixture.press(Button::A);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL(WorkKind::OnBreak, fixture.app.lastAuthoritativeState().kind);
}

void test_operational_screens_keep_status_icons_and_button_labels() {
  Fixture fixture;
  fixture.tick();
  TEST_ASSERT_TRUE(fixture.app.screen().networkConnected);
  TEST_ASSERT_TRUE(fixture.app.screen().ntpTrusted);
  fixture.scan(work(WorkKind::Idle));
  TEST_ASSERT_EQUAL_STRING("Comenzar", fixture.app.screen().buttons.b.c_str());
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_idle_clock_in_is_durable_before_network_and_completes);
  RUN_TEST(test_pending_network_work_keeps_its_busy_screen_until_result);
  RUN_TEST(test_working_buttons_and_long_shift_layout_match_simulator);
  RUN_TEST(test_working_pause_and_clock_out_commands);
  RUN_TEST(test_duplicate_and_action_rejection_are_definitive);
  RUN_TEST(test_completion_write_failure_keeps_accepted_action_pending);
  RUN_TEST(test_completion_failure_preserves_each_server_outcome_semantics);
  RUN_TEST(test_stale_pause_warns_and_actions_expire_after_ten_seconds);
  RUN_TEST(test_time_picker_steps_five_and_held_steps_thirty);
  RUN_TEST(test_close_from_break_asks_time_then_close_confirmation);
  RUN_TEST(test_close_from_break_refresh_failure_never_appends_clock_out);
  RUN_TEST(test_close_refresh_rejects_reassigned_uid_and_unexpected_state);
  RUN_TEST(test_close_refresh_network_and_queue_failure_are_safe);
  RUN_TEST(test_picker_and_close_confirm_expire_and_interaction_resets_picker);
  RUN_TEST(test_picker_inactivity_deadline_is_millis_wrap_safe);
  RUN_TEST(test_time_picker_crosses_midnight_without_losing_the_date);
  RUN_TEST(test_ambiguous_transport_keeps_pending_and_definitive_rejection_removes_it);
  RUN_TEST(test_409_uses_authoritative_state_and_completes_attempt);
  RUN_TEST(test_operational_screens_keep_status_icons_and_button_labels);
  return UNITY_END();
}
