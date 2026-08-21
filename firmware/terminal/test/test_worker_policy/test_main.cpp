#include <unity.h>

#include "openjornada/network_worker.hpp"

using namespace openjornada;

namespace {

class FakeApiClient : public ApiClient {
 public:
  int calls = 0;
  int active = 0;
  int maximumActive = 0;
  uint32_t lastTimeoutMs = 0;

  ApiCallResult bootstrap(const ApiCredentials&, const BootstrapRequest&,
                          BootstrapResponse& output,
                          uint32_t timeoutMs) override {
    enter(timeoutMs);
    output.protocol = {1, 1, 1};
    output.serverTime = "2026-08-21T14:00:00Z";
    output.timezone = "Europe/Madrid";
    output.maxOfflineSeconds = 86400;
    output.maxQueuedActions = 10000;
    leave();
    return {};
  }

  ApiCallResult resolve(const ApiCredentials&, const std::string&,
                        ResolveResponse&, uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult action(const ApiCredentials&, const ActionRequest&,
                       ActionResult&, uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult cache(const ApiCredentials&, uint32_t, CacheResponse&,
                      uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult openAdminSession(const ApiCredentials&, const std::string&,
                                 AdminSessionResponse&,
                                 uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult closeAdminSession(const ApiCredentials&, const std::string&,
                                  uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult employees(const ApiCredentials&, const std::string&,
                          EmployeeListResponse&,
                          uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult assignEmployee(const ApiCredentials&, const std::string&,
                               const std::string&, const std::string&, bool,
                               uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult revokeEmployee(const ApiCredentials&, const std::string&,
                               const std::string&,
                               uint32_t timeoutMs) override {
    return success(timeoutMs);
  }
  ApiCallResult sync(const ApiCredentials&, const SyncRequest&, SyncResponse&,
                     uint32_t timeoutMs) override {
    return success(timeoutMs);
  }

 private:
  void enter(uint32_t timeoutMs) {
    ++calls;
    ++active;
    if (active > maximumActive) maximumActive = active;
    lastTimeoutMs = timeoutMs;
  }
  void leave() { --active; }
  ApiCallResult success(uint32_t timeoutMs) {
    enter(timeoutMs);
    leave();
    return {};
  }
};

NetworkJob makeJob(NetworkJobKind kind, uint32_t id) {
  NetworkJob job;
  job.kind = kind;
  job.id = id;
  job.credentials = {"https://jornada.example.es", "ojterm_test_token"};
  job.bootstrap = {1, "m5stack-test", 0};
  job.uid = "04AABBCC";
  job.action.clientRequestId = "request-1";
  job.action.scanContext = "context";
  job.action.deviceCapturedAt = "2026-08-21T14:00:00Z";
  job.action.clockSyncedAt = "2026-08-21T14:00:00Z";
  job.action.deviceSequence = 1;
  return job;
}

void test_timeout_and_backoff_policy() {
  TEST_ASSERT_EQUAL_UINT32(10000, NetworkWorkerPolicy::timeoutMs(NetworkJobKind::Bootstrap));
  TEST_ASSERT_EQUAL_UINT32(10000, NetworkWorkerPolicy::timeoutMs(NetworkJobKind::Action));
  TEST_ASSERT_EQUAL_UINT32(30000, NetworkWorkerPolicy::timeoutMs(NetworkJobKind::Sync));
  const uint32_t expected[] = {2000, 4000, 8000, 16000, 30000, 30000};
  for (size_t index = 0; index < 6; ++index) {
    TEST_ASSERT_EQUAL_UINT32(expected[index], NetworkWorkerPolicy::retryBackoffMs(index));
  }
  TEST_ASSERT_EQUAL_UINT32(50, NetworkWorkerPolicy::stopPollMs());
  TEST_ASSERT_TRUE(NetworkWorkerPolicy::stopPollMs() <
                   NetworkWorkerPolicy::timeoutMs(NetworkJobKind::Bootstrap));
}

void test_jobs_are_serialized_and_polling_is_non_blocking() {
  FakeApiClient api;
  NetworkWorker worker(api);
  TEST_ASSERT_TRUE(worker.enqueue(makeJob(NetworkJobKind::Bootstrap, 1)));
  TEST_ASSERT_TRUE(worker.enqueue(makeJob(NetworkJobKind::Action, 2)));

  NetworkResult result;
  TEST_ASSERT_FALSE(worker.poll(result));
  TEST_ASSERT_EQUAL_INT(0, api.calls);
  TEST_ASSERT_TRUE(worker.processOne());
  TEST_ASSERT_EQUAL_INT(1, api.calls);
  TEST_ASSERT_EQUAL_INT(1, api.maximumActive);
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_EQUAL_UINT32(1, result.id);
  TEST_ASSERT_EQUAL_UINT32(10000, api.lastTimeoutMs);

  TEST_ASSERT_TRUE(worker.processOne());
  TEST_ASSERT_EQUAL_INT(2, api.calls);
  TEST_ASSERT_EQUAL_INT(1, api.maximumActive);
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_EQUAL_UINT32(2, result.id);
}

void test_worker_queues_are_bounded() {
  FakeApiClient api;
  NetworkWorker worker(api);
  for (size_t index = 0; index < NetworkWorker::kQueueCapacity; ++index) {
    TEST_ASSERT_TRUE(worker.enqueue(makeJob(NetworkJobKind::Resolve, index + 1)));
  }
  TEST_ASSERT_FALSE(worker.enqueue(makeJob(NetworkJobKind::Resolve, 99)));
  TEST_ASSERT_TRUE(worker.processOne());
  TEST_ASSERT_FALSE(worker.enqueue(makeJob(NetworkJobKind::Resolve, 99)));
  NetworkResult completed;
  TEST_ASSERT_TRUE(worker.poll(completed));
  TEST_ASSERT_TRUE(worker.enqueue(makeJob(NetworkJobKind::Resolve, 99)));
}

void test_retry_hint_is_returned_for_transport_failure() {
  class FailingClient final : public FakeApiClient {
   public:
    ApiCallResult resolve(const ApiCredentials&, const std::string&,
                          ResolveResponse&, uint32_t) override {
      ApiCallResult result;
      result.ok = false;
      result.failure.code = ApiErrorCode::Transport;
      result.failure.retryable = true;
      return result;
    }
  } api;
  NetworkWorker worker(api);
  NetworkJob job = makeJob(NetworkJobKind::Resolve, 7);
  job.attempt = 3;
  TEST_ASSERT_TRUE(worker.enqueue(job));
  TEST_ASSERT_TRUE(worker.processOne());
  NetworkResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_FALSE(result.call.ok);
  TEST_ASSERT_EQUAL_UINT32(16000, result.suggestedRetryMs);
}

void test_action_failure_preserves_authoritative_conflict_state() {
  class ConflictClient final : public FakeApiClient {
   public:
    ApiCallResult action(const ApiCredentials&, const ActionRequest&,
                         ActionResult&, uint32_t) override {
      ApiCallResult result;
      result.ok = false;
      result.failure.code = ApiErrorCode::StateConflict;
      result.failure.httpStatus = 409;
      ApiWorkState authoritative;
      authoritative.kind = WorkKind::OnBreak;
      authoritative.workedSeconds = 7200;
      result.failure.authoritativeState = authoritative;
      return result;
    }
  } api;
  NetworkWorker worker(api);
  TEST_ASSERT_TRUE(worker.enqueue(makeJob(NetworkJobKind::Action, 8)));
  TEST_ASSERT_TRUE(worker.processOne());
  NetworkResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_FALSE(result.call.ok);
  TEST_ASSERT_EQUAL(ApiErrorCode::StateConflict, result.call.failure.code);
  TEST_ASSERT_TRUE(result.call.failure.authoritativeState.has_value());
  TEST_ASSERT_EQUAL(WorkKind::OnBreak,
                    result.call.failure.authoritativeState->kind);
  TEST_ASSERT_EQUAL_INT32(7200,
                          result.call.failure.authoritativeState->workedSeconds);
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_timeout_and_backoff_policy);
  RUN_TEST(test_jobs_are_serialized_and_polling_is_non_blocking);
  RUN_TEST(test_worker_queues_are_bounded);
  RUN_TEST(test_retry_hint_is_returned_for_transport_failure);
  RUN_TEST(test_action_failure_preserves_authoritative_conflict_state);
  return UNITY_END();
}
