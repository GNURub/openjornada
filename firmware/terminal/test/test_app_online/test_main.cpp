#include <unity.h>

#include <algorithm>
#include <cstring>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "openjornada/app_controller.hpp"
#include "openjornada/signature.hpp"

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
    if (failReads) return false;
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
    if (failReadsAfterAppend) {
      failReadsAfterAppend = false;
      failReads = true;
    }
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
  mutable bool failReads = false;
  bool failReadsAfterAppend = false;
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
  int syncCalls = 0;
  SyncRequest lastSync;
  SyncResponse nextSync;
  ApiCallResult syncCall;
  CacheResponse nextCache;
  bool useNextCache = false;
  int cacheCalls = 0;
  AdminSessionResponse nextAdminSession;
  EmployeeListResponse nextEmployees;
  int openAdminCalls = 0;
  int closeAdminCalls = 0;
  int employeeCalls = 0;
  int assignCalls = 0;
  bool lastAssignReplace = false;
  std::string lastAssignedEmployee;
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
  ApiCallResult cache(const ApiCredentials&, uint32_t revision,
                      CacheResponse& output, uint32_t) override {
    ++cacheCalls;
    if (useNextCache) {
      output = nextCache;
      return {};
    }
    output.revision = revision;
    output.unchanged = true;
    return {};
  }
  ApiCallResult openAdminSession(const ApiCredentials&, const std::string&,
                                 AdminSessionResponse& output, uint32_t) override {
    ++openAdminCalls;
    output = nextAdminSession;
    return {};
  }
  ApiCallResult closeAdminSession(const ApiCredentials&, const std::string&,
                                  uint32_t) override {
    ++closeAdminCalls;
    return {};
  }
  ApiCallResult employees(const ApiCredentials&, const std::string&,
                          EmployeeListResponse& output, uint32_t) override {
    ++employeeCalls;
    output = nextEmployees;
    return {};
  }
  ApiCallResult assignEmployee(const ApiCredentials&, const std::string&,
                               const std::string& employeeId,
                               const std::string&, bool replace,
                               uint32_t) override {
    ++assignCalls;
    lastAssignedEmployee = employeeId;
    lastAssignReplace = replace;
    return {};
  }
  ApiCallResult revokeEmployee(const ApiCredentials&, const std::string&,
                               const std::string&, uint32_t) override { return {}; }
  ApiCallResult sync(const ApiCredentials&, const SyncRequest& request,
                     SyncResponse& output, uint32_t) override {
    ++syncCalls;
    lastSync = request;
    output = nextSync;
    return syncCall;
  }

 private:
  Outbox& outbox_;
};

class MemoryCacheStore final : public CacheStore {
 public:
  CacheError replaceAtomically(const CacheSnapshot& snapshot) override {
    ++replaceCalls;
    if (failOnReplaceCall != 0 && replaceCalls == failOnReplaceCall) {
      return CacheError::Io;
    }
    saved = snapshot;
    return CacheError::None;
  }
  bool clear() override {
    saved = {};
    return true;
  }

  CacheSnapshot saved;
  size_t replaceCalls = 0;
  size_t failOnReplaceCall = 0;
};

struct Fixture {
  MemoryStorage storage;
  Outbox outbox{storage};
  FakeApi api{outbox};
  NetworkWorker worker{api};
  MemoryCacheStore cacheStore;
  AppController app{worker, outbox,
                    {{"https://jornada.example.es", "ojterm_test_token"},
                     "m5stack-test", "reboot-test"},
                    &cacheStore};
  uint32_t nowMs = 1000;
  int64_t epoch = 1787306400;  // 2026-08-21T10:00:00Z
  int64_t ntpSyncEpoch = 1787306400;
  int64_t timestampEpochOffset = 0;
  bool emitNtp = true;

  explicit Fixture(bool ntpAvailable = true) : emitNtp(ntpAvailable) {
    TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
    TEST_ASSERT_TRUE(worker.begin());
    app.start(0, nowMs);
    tick();
    networkRoundTrip();
    networkRoundTrip();
    TEST_ASSERT_EQUAL(ScreenKind::Idle, app.screen().kind);
  }

  AppEvent event(AppEventKind kind) const {
    AppEvent value;
    value.kind = kind;
    value.nowMs = nowMs;
    value.nowEpochSeconds = epoch;
    if (emitNtp) value.timestamp = isoUtc(epoch + timestampEpochOffset);
    value.networkConnected = true;
    value.ntpTrusted = emitNtp;
    value.ntpSyncEpochSeconds = emitNtp ? ntpSyncEpoch : 0;
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

AppControllerConfig offlineConfig() {
  AppControllerConfig config;
  config.credentials = {"https://jornada.example.es", "ojterm_test_token"};
  config.clientVersion = "m5stack-test";
  config.rebootId = "offline-boot";
  config.configFingerprint = configurationFingerprint(
      config.credentials.baseUrl, config.credentials.terminalToken);
  config.terminalId = "terminal-test";
  config.clockSyncedAt = "2026-08-21T09:59:59Z";
  config.lastNtpEpochSeconds = 1787306399;
  config.initialCache.revision = 7;
  config.initialCache.terminalId = config.terminalId;
  config.initialCache.configFingerprint = config.configFingerprint;
  config.initialCache.entries.push_back(
      {"employee-1", "Marina", "04AABBCC",
       {WorkKind::Idle, 0, 0, false, false}});
  return config;
}

struct OfflineFixture {
  MemoryStorage storage;
  Outbox outbox{storage};
  FakeApi api{outbox};
  NetworkWorker worker{api};
  AppController app{worker, outbox, offlineConfig()};
  uint32_t nowMs = 1000;
  int64_t epoch = 1787306400;

  OfflineFixture() {
    TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
    TEST_ASSERT_TRUE(worker.begin());
    app.start(0, nowMs);
    TEST_ASSERT_EQUAL(ScreenKind::Idle, app.screen().kind);
  }

  AppEvent event(AppEventKind kind, bool connected = false,
                 bool trusted = true) const {
    AppEvent value;
    value.kind = kind;
    value.nowMs = nowMs;
    value.nowEpochSeconds = epoch;
    value.timestamp = isoUtc(epoch);
    value.networkConnected = connected;
    value.ntpTrusted = trusted;
    value.ntpSyncEpochSeconds = trusted ? 1787306400 : 0;
    return value;
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

void openAdminEmployeeList(Fixture& fixture) {
  fixture.api.nextAdminSession.token = "ojtadmin_test-capability";
  fixture.api.nextEmployees.itemCount = 1;
  fixture.api.nextEmployees.items[0] =
      {"employee-1", "Marina", "Marina", false};

  AppEvent combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += AdminFlow::kActivationHoldMs;
  combo.nowMs = fixture.nowMs;
  fixture.app.tick(combo);
  TEST_ASSERT_EQUAL(ScreenKind::AdminPin, fixture.app.screen().kind);

  fixture.tick();
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.networkRoundTrip();
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL(ScreenKind::AdminEmployees, fixture.app.screen().kind);
}

void test_idle_clock_in_is_durable_before_network_and_completes() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Idle));
  TEST_ASSERT_EQUAL_STRING("Comenzar jornada",
                           fixture.app.screen().buttons.b.c_str());
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  TEST_ASSERT_EQUAL_UINT32(1, fixture.app.screen().pendingCount);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_UINT32(1, fixture.api.pendingObservedByAction);
  TEST_ASSERT_EQUAL(Command::ClockIn, fixture.api.lastAction.command);
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("Buenos días, Marina",
                           fixture.app.screen().title.c_str());
  TEST_ASSERT_EQUAL_STRING("Jornada iniciada",
                           fixture.app.screen().detail.c_str());
}

void test_greetings_follow_the_local_time_of_day() {
  TEST_ASSERT_EQUAL_STRING("Buenas noches", greetingForLocalHour(5));
  TEST_ASSERT_EQUAL_STRING("Buenos días", greetingForLocalHour(6));
  TEST_ASSERT_EQUAL_STRING("Buenos días", greetingForLocalHour(13));
  TEST_ASSERT_EQUAL_STRING("Buenas tardes", greetingForLocalHour(14));
  TEST_ASSERT_EQUAL_STRING("Buenas tardes", greetingForLocalHour(20));
  TEST_ASSERT_EQUAL_STRING("Buenas noches", greetingForLocalHour(21));
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
  TEST_ASSERT_EQUAL_STRING("Comenzar pausa",
                           fixture.app.screen().buttons.a.c_str());
  TEST_ASSERT_TRUE(fixture.app.screen().buttons.b.empty());
  TEST_ASSERT_EQUAL_STRING("Terminar jornada",
                           fixture.app.screen().buttons.c.c_str());

  fixture.tick(10001);
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
  fixture.scan(work(WorkKind::Working, true));
  TEST_ASSERT_EQUAL_STRING("Comenzar pausa",
                           fixture.app.screen().buttons.a.c_str());
  TEST_ASSERT_EQUAL_STRING("Terminar ahora",
                           fixture.app.screen().buttons.b.c_str());
  TEST_ASSERT_EQUAL_STRING("Ya terminé antes",
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
  TEST_ASSERT_EQUAL_STRING("Hasta luego, Marina",
                           finish.app.screen().title.c_str());
  TEST_ASSERT_EQUAL_STRING("Jornada finalizada",
                           finish.app.screen().detail.c_str());
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

void test_cache_write_failure_keeps_accepted_action_pending() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Idle));
  fixture.accepted(WorkKind::Working);
  fixture.cacheStore.failOnReplaceCall = fixture.cacheStore.replaceCalls + 1;
  fixture.press(Button::B);
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
  TEST_ASSERT_EQUAL_STRING("-5 min", fixture.app.screen().buttons.a.c_str());
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

void test_time_picker_repeats_valid_steps_and_explains_limits() {
  Fixture repeated;
  ApiWorkState longPause = work(WorkKind::OnBreak);
  longPause.since = "2026-08-21T09:30:00Z";
  repeated.scan(longPause);
  repeated.press(Button::C);
  const auto initial = repeated.app.screen().selectedEpochSeconds;

  repeated.press(Button::A);
  repeated.press(Button::A);
  repeated.press(Button::A);
  TEST_ASSERT_EQUAL_INT64(initial - 15 * 60,
                          repeated.app.screen().selectedEpochSeconds);
  repeated.press(Button::C);
  repeated.press(Button::C);
  TEST_ASSERT_EQUAL_INT64(initial - 5 * 60,
                          repeated.app.screen().selectedEpochSeconds);
  TEST_ASSERT_EQUAL_STRING("Mantén A/C para saltar 30 min",
                           repeated.app.screen().detail.c_str());

  Fixture bounded;
  ApiWorkState shortPause = work(WorkKind::OnBreak);
  shortPause.since = "2026-08-21T09:57:00Z";
  bounded.scan(shortPause);
  bounded.press(Button::C);
  bounded.press(Button::A);
  const auto minimum = bounded.app.screen().selectedEpochSeconds;
  TEST_ASSERT_EQUAL_INT64(initial - 3 * 60, minimum);
  TEST_ASSERT_EQUAL_INT64(minimum,
                          bounded.app.screen().selectedEpochSeconds);
  TEST_ASSERT_EQUAL_STRING("Límite: inicio de la pausa",
                           bounded.app.screen().detail.c_str());
  TEST_ASSERT_EQUAL(AppFeedback::Error, bounded.app.takeFeedback());

  bounded.press(Button::C);
  TEST_ASSERT_EQUAL_INT64(initial, bounded.app.screen().selectedEpochSeconds);
  TEST_ASSERT_EQUAL_STRING("No puedes elegir una hora futura",
                           bounded.app.screen().detail.c_str());
  TEST_ASSERT_EQUAL(AppFeedback::Error, bounded.app.takeFeedback());

  Fixture workdayBound;
  ApiWorkState shortWorkday = work(WorkKind::Working, true);
  shortWorkday.since = "2026-08-21T09:57:00Z";
  workdayBound.scan(shortWorkday);
  workdayBound.press(Button::C);
  workdayBound.press(Button::A);
  TEST_ASSERT_EQUAL_STRING("Límite: inicio de la jornada",
                           workdayBound.app.screen().detail.c_str());
  TEST_ASSERT_EQUAL(AppFeedback::Error, workdayBound.app.takeFeedback());
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
    TEST_ASSERT_TRUE(saturated.worker.enqueue(std::move(queued)));
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
  TEST_ASSERT_EQUAL_STRING("Comenzar jornada",
                           fixture.app.screen().buttons.b.c_str());
}

void test_offline_action_requires_fresh_ntp_and_advances_only_after_append() {
  OfflineFixture fixture;
  AppEvent scan = fixture.event(AppEventKind::TagScanned, false, false);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);

  fixture.nowMs += 5000;
  fixture.app.tick(fixture.event(AppEventKind::Timer, false, true));
  fixture.nowMs += 5000;
  fixture.app.tick(fixture.event(AppEventKind::Timer, false, true));
  scan = fixture.event(AppEventKind::TagScanned, false, true);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::Actions, fixture.app.screen().kind);

  AppEvent press = fixture.event(AppEventKind::ButtonPressed, false, true);
  press.button = Button::B;
  fixture.app.tick(press);
  TEST_ASSERT_EQUAL_UINT32(1, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("Guardado; se sincronizará",
                           fixture.app.screen().detail.c_str());

  fixture.nowMs += 5000;
  fixture.app.tick(fixture.event(AppEventKind::Timer, false, true));
  scan = fixture.event(AppEventKind::TagScanned, false, true);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::Actions, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("Comenzar pausa",
                           fixture.app.screen().buttons.a.c_str());
}

void test_offline_confirmation_rechecks_clock_trust_after_scan() {
  OfflineFixture fixture;
  fixture.epoch = 1787306400 + ClockTrust::kMaximumOfflineAgeSeconds;
  AppEvent scan = fixture.event(AppEventKind::TagScanned, false, true);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::Actions, fixture.app.screen().kind);

  fixture.epoch += 1;
  fixture.nowMs += 1000;
  AppEvent press = fixture.event(AppEventKind::ButtonPressed, false, true);
  press.button = Button::B;
  fixture.app.tick(press);
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
  TEST_ASSERT_EQUAL_STRING("Reloj no fiable; conecta la red.",
                           fixture.app.screen().detail.c_str());
}

void test_new_reboot_starts_a_new_signature_chain_after_replaying_old_records() {
  MemoryStorage storage;
  Outbox outbox{storage};
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
  QueuedAction old = pendingAction("old-boot-1");
  old.rebootId = "old-boot";
  old.previousLocalHash.clear();
  old.signature = std::string(64, 'a');
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.append(old));

  FakeApi api{outbox};
  NetworkWorker worker{api};
  TEST_ASSERT_TRUE(worker.begin());
  AppControllerConfig config = offlineConfig();
  config.rebootId = "new-boot";
  config.initialCache.entries[0].uid = old.uid;
  AppController app{worker, outbox, config};
  app.start(1, 1000);

  AppEvent scan;
  scan.kind = AppEventKind::TagScanned;
  scan.nowMs = 1000;
  scan.nowEpochSeconds = 1787306400;
  scan.timestamp = isoUtc(scan.nowEpochSeconds);
  scan.uid = old.uid;
  scan.ntpTrusted = true;
  scan.ntpSyncEpochSeconds = scan.nowEpochSeconds;
  app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::Actions, app.screen().kind);
  AppEvent press = scan;
  press.kind = AppEventKind::ButtonPressed;
  press.button = Button::A;
  app.tick(press);

  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.list(pending));
  TEST_ASSERT_EQUAL_UINT32(2, pending.size());
  TEST_ASSERT_EQUAL_STRING("new-boot", pending[1].rebootId.c_str());
  TEST_ASSERT_TRUE(pending[1].previousLocalHash.empty());
  TEST_ASSERT_EQUAL_UINT32(1, pending[1].deviceSequence);
}

void test_offline_close_from_break_queues_break_end_then_clock_out() {
  OfflineFixture fixture;
  auto scan = fixture.event(AppEventKind::TagScanned, false, true);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  auto press = fixture.event(AppEventKind::ButtonPressed, false, true);
  press.button = Button::B;
  fixture.app.tick(press);  // clock_in
  fixture.nowMs += 5001;
  fixture.app.tick(fixture.event(AppEventKind::Timer, false, true));
  scan = fixture.event(AppEventKind::TagScanned, false, true);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  press = fixture.event(AppEventKind::ButtonPressed, false, true);
  press.button = Button::A;
  fixture.app.tick(press);  // break_start
  fixture.nowMs += 5001;
  fixture.app.tick(fixture.event(AppEventKind::Timer, false, true));
  scan = fixture.event(AppEventKind::TagScanned, false, true);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  press = fixture.event(AppEventKind::ButtonPressed, false, true);
  press.button = Button::C;
  fixture.app.tick(press);
  press.button = Button::B;
  fixture.app.tick(press);  // break_end
  TEST_ASSERT_EQUAL(ScreenKind::CloseConfirm, fixture.app.screen().kind);
  press.button = Button::C;
  fixture.app.tick(press);  // clock_out

  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL(OutboxError::None, fixture.outbox.list(pending));
  TEST_ASSERT_EQUAL_UINT32(4, pending.size());
  TEST_ASSERT_EQUAL(Command::BreakEnd, pending[2].command);
  TEST_ASSERT_EQUAL(Command::ClockOut, pending[3].command);
  TEST_ASSERT_EQUAL_STRING(pending[2].signature.c_str(),
                           pending[3].previousLocalHash.c_str());
}

void test_ambiguous_break_end_keeps_following_clock_out_queued_in_order() {
  Fixture fixture;
  fixture.scan(work(WorkKind::OnBreak));
  fixture.press(Button::C);
  fixture.api.actionCall.ok = false;
  fixture.api.actionCall.failure.code = ApiErrorCode::Timeout;
  fixture.api.actionCall.failure.retryable = true;
  fixture.press(Button::B);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL(ScreenKind::CloseConfirm, fixture.app.screen().kind);

  fixture.press(Button::C);

  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL(OutboxError::None, fixture.outbox.list(pending));
  TEST_ASSERT_EQUAL_UINT32(2, pending.size());
  TEST_ASSERT_EQUAL(Command::BreakEnd, pending[0].command);
  TEST_ASSERT_EQUAL(Command::ClockOut, pending[1].command);
  TEST_ASSERT_EQUAL_STRING(pending[0].signature.c_str(),
                           pending[1].previousLocalHash.c_str());
  TEST_ASSERT_EQUAL_INT(1, fixture.api.actionCalls);
  TEST_ASSERT_FALSE(fixture.worker.processOne());
}

void test_sync_definitive_result_completes_when_uid_left_cache() {
  MemoryStorage storage;
  Outbox outbox{storage};
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
  QueuedAction queued = pendingAction("removed-uid-request");
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.append(queued));
  FakeApi api{outbox};
  NetworkWorker worker{api};
  TEST_ASSERT_TRUE(worker.begin());
  AppControllerConfig config = offlineConfig();
  config.initialCache.entries.clear();
  AppController app{worker, outbox, config};
  app.start(1, 1000);

  AppEvent timer;
  timer.kind = AppEventKind::Timer;
  timer.nowMs = 1000;
  timer.nowEpochSeconds = 1787306400;
  timer.timestamp = isoUtc(timer.nowEpochSeconds);
  timer.networkConnected = true;
  timer.ntpTrusted = true;
  timer.ntpSyncEpochSeconds = timer.nowEpochSeconds;
  app.tick(timer);
  TEST_ASSERT_TRUE(worker.processOne());  // bootstrap
  app.tick(timer);
  TEST_ASSERT_TRUE(worker.processOne());  // cache
  app.tick(timer);

  api.nextSync.itemCount = 1;
  api.nextSync.items[0].clientRequestId = queued.clientRequestId;
  api.nextSync.items[0].status = ActionStatus::Duplicate;
  api.nextSync.items[0].state.kind = WorkKind::Idle;
  TEST_ASSERT_TRUE(worker.processOne());  // sync
  app.tick(timer);

  TEST_ASSERT_EQUAL_UINT32(0, app.screen().pendingCount);
  TEST_ASSERT_FALSE(app.screen().warning);
}

void test_online_action_uses_bootstrap_time_when_ntp_is_unavailable() {
  Fixture fixture(false);
  TEST_ASSERT_FALSE(fixture.app.screen().ntpTrusted);
  fixture.scan(work(WorkKind::Idle));
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  TEST_ASSERT_EQUAL_UINT32(1, fixture.app.screen().pendingCount);
  fixture.networkRoundTrip();

  TEST_ASSERT_EQUAL_INT(1, fixture.api.actionCalls);
  TEST_ASSERT_EQUAL_STRING("2026-08-21T10:00:00Z",
                           fixture.api.lastAction.deviceCapturedAt.c_str());
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
}

void test_online_action_replaces_stale_runtime_clock_with_bootstrap_time() {
  MemoryStorage storage;
  Outbox outbox{storage};
  FakeApi api{outbox};
  NetworkWorker worker{api};
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
  TEST_ASSERT_TRUE(worker.begin());
  AppControllerConfig config;
  config.credentials = {"https://jornada.example.es", "ojterm_test_token"};
  config.clientVersion = "m5stack-test";
  config.rebootId = "no-ntp-boot";
  config.terminalId = "terminal-test";
  config.clockSyncedAt = "2026-08-19T10:00:00Z";
  config.lastNtpEpochSeconds = 1787133600;
  AppController app{worker, outbox, config};
  app.start(0, 1000);

  AppEvent event;
  event.kind = AppEventKind::Timer;
  event.nowMs = 1000;
  event.nowEpochSeconds = 0;
  event.networkConnected = true;
  app.tick(event);
  TEST_ASSERT_TRUE(worker.processOne());
  app.tick(event);
  TEST_ASSERT_TRUE(worker.processOne());
  app.tick(event);

  api.nextResolve.scanContext = "scan-context";
  api.nextResolve.employee = {"employee-1", "Marina"};
  api.nextResolve.state = work(WorkKind::Idle);
  event.kind = AppEventKind::TagScanned;
  event.uid = "04AABBCC";
  app.tick(event);
  TEST_ASSERT_TRUE(worker.processOne());
  event.kind = AppEventKind::Timer;
  app.tick(event);
  api.nextAction.status = ActionStatus::Accepted;
  api.nextAction.state.kind = WorkKind::Working;
  event.kind = AppEventKind::ButtonPressed;
  event.button = Button::B;
  app.tick(event);
  TEST_ASSERT_TRUE(worker.processOne());
  event.kind = AppEventKind::Timer;
  app.tick(event);

  TEST_ASSERT_EQUAL_STRING("2026-08-21T10:00:00Z",
                           api.lastAction.deviceCapturedAt.c_str());
  TEST_ASSERT_EQUAL_STRING("2026-08-21T10:00:00Z",
                           api.lastAction.clockSyncedAt.c_str());
  TEST_ASSERT_EQUAL_UINT32(0, app.screen().pendingCount);
}

void test_pending_count_read_failure_after_append_fails_closed() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Idle));
  fixture.storage.failReadsAfterAppend = true;
  fixture.press(Button::B);

  TEST_ASSERT_EQUAL(ScreenKind::Fatal, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_UINT32(OutboxCodec::kCapacity,
                           fixture.app.screen().pendingCount);
  TEST_ASSERT_FALSE(fixture.worker.processOne());
}

void test_corrupt_outbox_replay_fails_closed_without_accepting_input() {
  MemoryStorage storage;
  Outbox outbox{storage};
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
  TEST_ASSERT_EQUAL(OutboxError::None,
                    outbox.append(pendingAction("corrupt-1")));
  TEST_ASSERT_EQUAL(OutboxError::None,
                    outbox.append(pendingAction("corrupt-2")));
  auto& journal = storage.files[Outbox::kCurrentPath];
  TEST_ASSERT_FALSE(journal.empty());
  journal.back() ^= 0x01U;
  FakeApi api{outbox};
  NetworkWorker worker{api};
  TEST_ASSERT_TRUE(worker.begin());
  AppController app{worker, outbox, offlineConfig()};
  app.start(2, 1000);

  TEST_ASSERT_EQUAL(ScreenKind::Fatal, app.screen().kind);
  TEST_ASSERT_EQUAL_UINT32(OutboxCodec::kCapacity,
                           app.screen().pendingCount);
  AppEvent scan;
  scan.kind = AppEventKind::TagScanned;
  scan.nowMs = 1000;
  scan.nowEpochSeconds = 1787306400;
  scan.timestamp = isoUtc(scan.nowEpochSeconds);
  scan.uid = "04AABBCC";
  scan.ntpTrusted = true;
  scan.ntpSyncEpochSeconds = scan.nowEpochSeconds;
  app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::Fatal, app.screen().kind);
}

void test_cache_refresh_preserves_sequence_and_hash_from_completed_actions() {
  Fixture fixture;
  fixture.scan(work(WorkKind::Idle));
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_STRING("reboot-test-1",
                           fixture.api.lastAction.clientRequestId.c_str());

  fixture.tick(5001);
  fixture.scan(work(WorkKind::Working));
  fixture.api.actionCall.ok = false;
  fixture.api.actionCall.failure.code = ApiErrorCode::InactiveEmployee;
  fixture.api.actionCall.failure.safeMessage = "La persona no está activa.";
  fixture.press(Button::A);
  fixture.networkRoundTrip();
  TEST_ASSERT_EQUAL_STRING("reboot-test-2",
                           fixture.api.lastAction.clientRequestId.c_str());

  fixture.api.useNextCache = true;
  fixture.api.nextCache.revision = 9;
  fixture.api.nextCache.unchanged = false;
  fixture.api.nextCache.itemCount = 1;
  fixture.api.nextCache.items[0].employeeId = "employee-1";
  fixture.api.nextCache.items[0].displayName = "Marina";
  fixture.api.nextCache.items[0].uid = "04AABBCC";
  fixture.api.nextCache.items[0].state = work(WorkKind::Working);
  fixture.tick(5001);
  fixture.tick();
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);

  fixture.scan(work(WorkKind::Working));
  fixture.api.actionCall = {};
  fixture.accepted(WorkKind::OnBreak);
  fixture.press(Button::A);
  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL(OutboxError::None, fixture.outbox.list(pending));
  TEST_ASSERT_EQUAL_UINT32(1, pending.size());
  TEST_ASSERT_EQUAL_STRING("reboot-test-3",
                           pending[0].clientRequestId.c_str());
  TEST_ASSERT_FALSE(pending[0].previousLocalHash.empty());
}

void test_online_action_uses_bootstrap_clock_after_ntp_trust_expires() {
  Fixture fixture;
  fixture.epoch += ClockTrust::kMaximumOfflineAgeSeconds + 1;
  fixture.nowMs +=
      static_cast<uint32_t>((ClockTrust::kMaximumOfflineAgeSeconds + 1) *
                            1000);
  fixture.timestampEpochOffset = 60 * 60;
  fixture.tick();
  TEST_ASSERT_FALSE(fixture.app.screen().ntpTrusted);
  fixture.scan(work(WorkKind::Idle));
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  fixture.networkRoundTrip();

  TEST_ASSERT_EQUAL_STRING(fixture.api.lastAction.deviceCapturedAt.c_str(),
                           fixture.api.lastAction.clockSyncedAt.c_str());
  TEST_ASSERT_EQUAL_STRING("2026-08-22T10:00:01Z",
                           fixture.api.lastAction.deviceCapturedAt.c_str());
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
}

void test_bootstrap_clock_remains_monotonic_across_millis_rollover() {
  Fixture fixture;
  constexpr uint64_t firstDeltaMs =
      static_cast<uint64_t>(UINT32_MAX - 1000U) - 1000U;
  constexpr uint64_t secondDeltaMs = 3001U;
  constexpr uint64_t elapsedMs = firstDeltaMs + secondDeltaMs;
  fixture.nowMs = UINT32_MAX - 1000U;
  fixture.epoch = 1787306400 + static_cast<int64_t>(firstDeltaMs / 1000U);
  fixture.tick();
  fixture.nowMs = 2000U;
  fixture.epoch = 1787306400 + static_cast<int64_t>(elapsedMs / 1000U);
  fixture.timestampEpochOffset = 60 * 60;
  fixture.tick();
  TEST_ASSERT_FALSE(fixture.app.screen().ntpTrusted);

  fixture.scan(work(WorkKind::Idle));
  fixture.accepted(WorkKind::Working);
  fixture.press(Button::B);
  fixture.networkRoundTrip();

  const std::string expected =
      isoUtc(1787306400 + static_cast<int64_t>(elapsedMs / 1000U));
  TEST_ASSERT_EQUAL_STRING(expected.c_str(),
                           fixture.api.lastAction.deviceCapturedAt.c_str());
  TEST_ASSERT_EQUAL_STRING(expected.c_str(),
                           fixture.api.lastAction.clockSyncedAt.c_str());
}

void test_automatic_sync_completes_pending_action_in_order() {
  OfflineFixture fixture;
  fixture.app.tick(fixture.event(AppEventKind::Timer, true, true));
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.app.tick(fixture.event(AppEventKind::Timer, true, true));
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.app.tick(fixture.event(AppEventKind::Timer, true, true));

  AppEvent scan = fixture.event(AppEventKind::TagScanned, false, true);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  AppEvent press = fixture.event(AppEventKind::ButtonPressed, false, true);
  press.button = Button::B;
  fixture.app.tick(press);
  fixture.nowMs += 5000;
  fixture.app.tick(fixture.event(AppEventKind::Timer, true, true));
  fixture.app.tick(fixture.event(AppEventKind::Timer, true, true));

  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL(OutboxError::None, fixture.outbox.list(pending));
  TEST_ASSERT_EQUAL_UINT32(1, pending.size());
  fixture.api.nextSync = {};
  fixture.api.nextSync.itemCount = 1;
  fixture.api.nextSync.items[0].clientRequestId = pending[0].clientRequestId;
  fixture.api.nextSync.items[0].status = ActionStatus::Duplicate;
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.app.tick(fixture.event(AppEventKind::Timer, true, true));
  TEST_ASSERT_EQUAL_UINT32(0, fixture.app.screen().pendingCount);
}

void test_admin_pin_assignment_and_session_expiry_flow() {
  Fixture fixture;
  fixture.api.nextAdminSession.token = "ojtadmin_test-capability";
  fixture.api.nextEmployees.itemCount = 1;
  fixture.api.nextEmployees.items[0] =
      {"employee-1", "Marina", "Marina", false};

  AppEvent combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += 3000;
  combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  TEST_ASSERT_EQUAL(ScreenKind::AdminPin, fixture.app.screen().kind);

  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::AdminEmployees, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_INT(1, fixture.api.openAdminCalls);

  fixture.press(Button::B);
  TEST_ASSERT_EQUAL(ScreenKind::AdminScan, fixture.app.screen().kind);
  AppEvent scan = fixture.event(AppEventKind::TagScanned);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL_INT(1, fixture.api.assignCalls);
  TEST_ASSERT_EQUAL_STRING("employee-1", fixture.api.lastAssignedEmployee.c_str());
  TEST_ASSERT_FALSE(fixture.api.lastAssignReplace);
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::AdminEmployees, fixture.app.screen().kind);

  fixture.nowMs += AdminFlow::kSessionIdleMs;
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("Acerca tu tarjeta",
                           fixture.app.screen().detail.c_str());
}

void test_admin_screens_explain_and_allow_explicit_exit() {
  Fixture fixture;
  openAdminEmployeeList(fixture);

  TEST_ASSERT_EQUAL_STRING("Mantén A+C 3 s para salir",
                           fixture.app.screen().employee.c_str());
  fixture.press(Button::B);
  TEST_ASSERT_EQUAL(ScreenKind::AdminScan, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("Mantén A+C 3 s para salir",
                           fixture.app.screen().employee.c_str());

  AppEvent combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += AdminFlow::kActivationHoldMs;
  combo.nowMs = fixture.nowMs;
  fixture.app.tick(combo);

  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_INT(0, fixture.api.closeAdminCalls);
  TEST_ASSERT_EQUAL_STRING("Acerca tu tarjeta",
                           fixture.app.screen().detail.c_str());
}

void test_admin_exit_is_immediate_while_an_admin_request_is_pending() {
  Fixture fixture;
  fixture.api.nextAdminSession.token = "ojtadmin_test-capability";
  fixture.api.nextEmployees.itemCount = 1;
  fixture.api.nextEmployees.items[0] =
      {"employee-1", "Marina", "Marina", false};

  AppEvent combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += AdminFlow::kActivationHoldMs;
  combo.nowMs = fixture.nowMs;
  fixture.app.tick(combo);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);

  combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += AdminFlow::kActivationHoldMs;
  combo.nowMs = fixture.nowMs;
  fixture.app.tick(combo);

  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("Acerca tu tarjeta",
                           fixture.app.screen().detail.c_str());

  fixture.nowMs += 1001U;
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);

  fixture.api.nextResolve = {};
  fixture.api.nextResolve.scanContext = "scan-context";
  fixture.api.nextResolve.employee = {"employee-1", "Marina"};
  fixture.api.nextResolve.state.kind = WorkKind::Idle;
  AppEvent scan = fixture.event(AppEventKind::TagScanned);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);

  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Actions, fixture.app.screen().kind);
}

void test_admin_timeout_is_immediate_while_an_admin_request_is_pending() {
  Fixture fixture;
  fixture.api.nextAdminSession.token = "ojtadmin_test-capability";
  fixture.api.nextEmployees.itemCount = 1;
  fixture.api.nextEmployees.items[0] =
      {"employee-1", "Marina", "Marina", false};

  AppEvent combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += AdminFlow::kActivationHoldMs;
  combo.nowMs = fixture.nowMs;
  fixture.app.tick(combo);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Message, fixture.app.screen().kind);

  fixture.nowMs += AdminFlow::kSessionIdleMs;
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);

  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
}

void test_admin_pin_and_activity_share_the_five_minute_timeout() {
  Fixture fixture;

  AppEvent combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += AdminFlow::kActivationHoldMs;
  combo.nowMs = fixture.nowMs;
  fixture.app.tick(combo);
  TEST_ASSERT_EQUAL(ScreenKind::AdminPin, fixture.app.screen().kind);

  fixture.nowMs += AdminFlow::kSessionIdleMs - 1U;
  fixture.press(Button::A);
  fixture.nowMs += 2U;
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::AdminPin, fixture.app.screen().kind);

  fixture.nowMs += AdminFlow::kSessionIdleMs;
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
}

void test_rfid_activity_outside_admin_scan_is_ignored_and_resets_timeout() {
  Fixture fixture;
  openAdminEmployeeList(fixture);

  fixture.nowMs += AdminFlow::kSessionIdleMs - 1U;
  AppEvent scan = fixture.event(AppEventKind::TagScanned);
  scan.uid = "04AABBCC";
  fixture.app.tick(scan);
  TEST_ASSERT_EQUAL(ScreenKind::AdminEmployees, fixture.app.screen().kind);

  fixture.nowMs += 2U;
  fixture.tick();
  TEST_ASSERT_EQUAL(ScreenKind::AdminEmployees, fixture.app.screen().kind);
}

void test_admin_inactivity_returns_directly_to_idle() {
  Fixture fixture;
  openAdminEmployeeList(fixture);

  fixture.nowMs += AdminFlow::kSessionIdleMs;
  fixture.tick();

  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("Acerca tu tarjeta",
                           fixture.app.screen().detail.c_str());
}

void test_late_employee_response_cannot_restore_an_expired_admin_session() {
  Fixture fixture;
  fixture.api.nextAdminSession.token = "ojtadmin_test-capability";
  fixture.api.nextEmployees.itemCount = 1;
  fixture.api.nextEmployees.items[0] =
      {"employee-1", "Marina", "Marina", false};

  AppEvent combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.nowMs += AdminFlow::kActivationHoldMs;
  combo = fixture.event(AppEventKind::Timer);
  combo.buttonADown = true;
  combo.buttonCDown = true;
  fixture.app.tick(combo);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);
  fixture.press(Button::B);

  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();
  fixture.nowMs += AdminFlow::kSessionIdleMs;
  TEST_ASSERT_TRUE(fixture.worker.processOne());
  fixture.tick();

  TEST_ASSERT_EQUAL(ScreenKind::Idle, fixture.app.screen().kind);
  TEST_ASSERT_EQUAL_STRING("Acerca tu tarjeta",
                           fixture.app.screen().detail.c_str());
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_idle_clock_in_is_durable_before_network_and_completes);
  RUN_TEST(test_greetings_follow_the_local_time_of_day);
  RUN_TEST(test_pending_network_work_keeps_its_busy_screen_until_result);
  RUN_TEST(test_working_buttons_and_long_shift_layout_match_simulator);
  RUN_TEST(test_working_pause_and_clock_out_commands);
  RUN_TEST(test_duplicate_and_action_rejection_are_definitive);
  RUN_TEST(test_completion_write_failure_keeps_accepted_action_pending);
  RUN_TEST(test_cache_write_failure_keeps_accepted_action_pending);
  RUN_TEST(test_completion_failure_preserves_each_server_outcome_semantics);
  RUN_TEST(test_stale_pause_warns_and_actions_expire_after_ten_seconds);
  RUN_TEST(test_time_picker_steps_five_and_held_steps_thirty);
  RUN_TEST(test_time_picker_repeats_valid_steps_and_explains_limits);
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
  RUN_TEST(test_offline_action_requires_fresh_ntp_and_advances_only_after_append);
  RUN_TEST(test_offline_confirmation_rechecks_clock_trust_after_scan);
  RUN_TEST(test_new_reboot_starts_a_new_signature_chain_after_replaying_old_records);
  RUN_TEST(test_offline_close_from_break_queues_break_end_then_clock_out);
  RUN_TEST(test_ambiguous_break_end_keeps_following_clock_out_queued_in_order);
  RUN_TEST(test_sync_definitive_result_completes_when_uid_left_cache);
  RUN_TEST(test_online_action_uses_bootstrap_time_when_ntp_is_unavailable);
  RUN_TEST(test_online_action_replaces_stale_runtime_clock_with_bootstrap_time);
  RUN_TEST(test_pending_count_read_failure_after_append_fails_closed);
  RUN_TEST(test_corrupt_outbox_replay_fails_closed_without_accepting_input);
  RUN_TEST(test_cache_refresh_preserves_sequence_and_hash_from_completed_actions);
  RUN_TEST(test_online_action_uses_bootstrap_clock_after_ntp_trust_expires);
  RUN_TEST(test_bootstrap_clock_remains_monotonic_across_millis_rollover);
  RUN_TEST(test_automatic_sync_completes_pending_action_in_order);
  RUN_TEST(test_admin_pin_assignment_and_session_expiry_flow);
  RUN_TEST(test_admin_screens_explain_and_allow_explicit_exit);
  RUN_TEST(test_admin_exit_is_immediate_while_an_admin_request_is_pending);
  RUN_TEST(test_admin_timeout_is_immediate_while_an_admin_request_is_pending);
  RUN_TEST(test_admin_pin_and_activity_share_the_five_minute_timeout);
  RUN_TEST(test_rfid_activity_outside_admin_scan_is_ignored_and_resets_timeout);
  RUN_TEST(test_admin_inactivity_returns_directly_to_idle);
  RUN_TEST(test_late_employee_response_cannot_restore_an_expired_admin_session);
  return UNITY_END();
}
