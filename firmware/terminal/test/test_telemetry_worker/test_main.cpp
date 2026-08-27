#include <unity.h>

#include <cstdint>
#include <string>
#include <utility>

#include "openjornada/telemetry_worker.hpp"

using namespace openjornada;

namespace {

ApiCallResult success() { return {}; }

ApiCallResult failed(ApiErrorCode code) {
  ApiCallResult result;
  result.ok = false;
  result.failure.code = code;
  result.failure.safeMessage = safeApiErrorMessage(code);
  return result;
}

HeartbeatRequest validHeartbeat() {
  return {1, "m5stack-1.1.0", 7, 2, -63, 3600,
          "synced", "2026-08-27T11:59:00Z"};
}

TelemetryJob validJob() {
  TelemetryJob job;
  job.credentials = {"https://jornada.example.com", "ojterm_test_token"};
  job.heartbeat = validHeartbeat();
  job.localIp = "192.168.1.44";
  return job;
}

class FakeTelemetryClient final : public TelemetryClient {
 public:
  ApiCallResult heartbeat(const ApiCredentials&, const HeartbeatRequest& request,
                          HeartbeatResponse& output,
                          uint32_t timeoutMs) override {
    ++heartbeatCalls;
    lastHeartbeat = request;
    heartbeatTimeoutMs = timeoutMs;
    output = heartbeatResponse;
    return heartbeatResult;
  }

  ApiCallResult pingAck(const ApiCredentials&, const PingAckRequest& request,
                        uint32_t timeoutMs) override {
    ++ackCalls;
    lastAck = request;
    ackTimeoutMs = timeoutMs;
    return ackResult;
  }

  int heartbeatCalls = 0;
  int ackCalls = 0;
  uint32_t heartbeatTimeoutMs = 0;
  uint32_t ackTimeoutMs = 0;
  ApiCallResult heartbeatResult = success();
  ApiCallResult ackResult = success();
  HeartbeatResponse heartbeatResponse;
  HeartbeatRequest lastHeartbeat;
  PingAckRequest lastAck;
};

void test_worker_acks_challenge_in_same_cycle() {
  FakeTelemetryClient api;
  api.heartbeatResponse.pingChallenge = "challenge-1";
  TelemetryWorker worker{api};
  TEST_ASSERT_TRUE(worker.enqueue(validJob()));
  TEST_ASSERT_TRUE(worker.busy());
  TEST_ASSERT_FALSE(worker.enqueue(TelemetryJob{}));
  TEST_ASSERT_TRUE(worker.processOne());
  TEST_ASSERT_TRUE(worker.busy());

  TelemetryResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_FALSE(worker.busy());
  TEST_ASSERT_TRUE(result.heartbeat.ok);
  TEST_ASSERT_TRUE(result.ackAttempted);
  TEST_ASSERT_TRUE(result.ack.ok);
  TEST_ASSERT_EQUAL_INT(1, api.heartbeatCalls);
  TEST_ASSERT_EQUAL_INT(1, api.ackCalls);
  TEST_ASSERT_EQUAL_UINT32(5000, api.heartbeatTimeoutMs);
  TEST_ASSERT_EQUAL_UINT32(5000, api.ackTimeoutMs);
  TEST_ASSERT_EQUAL_STRING("challenge-1", api.lastAck.pingChallenge.c_str());
  TEST_ASSERT_EQUAL_STRING("192.168.1.44", api.lastAck.localIp.c_str());
  TEST_ASSERT_EQUAL_INT16(-63, api.lastAck.wifiRssiDbm);
  TEST_ASSERT_EQUAL_UINT64(3600, api.lastAck.uptimeSeconds);
  TEST_ASSERT_FALSE(worker.poll(result));
}

void test_worker_without_challenge_does_not_ack() {
  FakeTelemetryClient api;
  TelemetryWorker worker{api};
  TEST_ASSERT_TRUE(worker.enqueue(validJob()));
  TEST_ASSERT_TRUE(worker.processOne());
  TelemetryResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_TRUE(result.heartbeat.ok);
  TEST_ASSERT_FALSE(result.ackAttempted);
  TEST_ASSERT_EQUAL_INT(0, api.ackCalls);
}

void test_worker_heartbeat_failure_does_not_ack() {
  FakeTelemetryClient api;
  api.heartbeatResult = failed(ApiErrorCode::Timeout);
  api.heartbeatResponse.pingChallenge = "must-not-be-used";
  TelemetryWorker worker{api};
  TEST_ASSERT_TRUE(worker.enqueue(validJob()));
  TEST_ASSERT_TRUE(worker.processOne());
  TelemetryResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_FALSE(result.heartbeat.ok);
  TEST_ASSERT_FALSE(result.ackAttempted);
  TEST_ASSERT_EQUAL_INT(0, api.ackCalls);
}

void test_worker_ack_failure_is_not_retried() {
  FakeTelemetryClient api;
  api.heartbeatResponse.pingChallenge = "challenge-1";
  api.ackResult = failed(ApiErrorCode::Transport);
  TelemetryWorker worker{api};
  TEST_ASSERT_TRUE(worker.enqueue(validJob()));
  TEST_ASSERT_TRUE(worker.processOne());
  TelemetryResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_TRUE(result.heartbeat.ok);
  TEST_ASSERT_TRUE(result.ackAttempted);
  TEST_ASSERT_FALSE(result.ack.ok);
  TEST_ASSERT_EQUAL_INT(1, api.ackCalls);
}

void test_worker_rejects_malformed_job_without_becoming_busy() {
  FakeTelemetryClient api;
  TelemetryWorker worker{api};
  auto job = validJob();
  job.credentials.terminalToken = "invalid";
  TEST_ASSERT_FALSE(worker.enqueue(std::move(job)));
  TEST_ASSERT_FALSE(worker.busy());
  job = validJob();
  job.localIp = "999.1.1.1";
  TEST_ASSERT_FALSE(worker.enqueue(std::move(job)));
  TEST_ASSERT_FALSE(worker.busy());
  job = validJob();
  job.heartbeat.clockStatus = "broken";
  TEST_ASSERT_FALSE(worker.enqueue(std::move(job)));
  TEST_ASSERT_FALSE(worker.busy());
  TEST_ASSERT_EQUAL_INT(0, api.heartbeatCalls);
}

void test_worker_can_accept_next_job_only_after_poll() {
  FakeTelemetryClient api;
  TelemetryWorker worker{api};
  TEST_ASSERT_TRUE(worker.begin());
  TEST_ASSERT_TRUE(worker.enqueue(validJob()));
  TEST_ASSERT_TRUE(worker.processOne());
  TEST_ASSERT_FALSE(worker.enqueue(validJob()));
  TelemetryResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_TRUE(worker.enqueue(validJob()));
  TEST_ASSERT_TRUE(worker.processOne());
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_EQUAL_INT(2, api.heartbeatCalls);
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_worker_acks_challenge_in_same_cycle);
  RUN_TEST(test_worker_without_challenge_does_not_ack);
  RUN_TEST(test_worker_heartbeat_failure_does_not_ack);
  RUN_TEST(test_worker_ack_failure_is_not_retried);
  RUN_TEST(test_worker_rejects_malformed_job_without_becoming_busy);
  RUN_TEST(test_worker_can_accept_next_job_only_after_poll);
  return UNITY_END();
}
