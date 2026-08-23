#include <unity.h>

#include <string>
#include <vector>

#include "openjornada/sync_engine.hpp"

using namespace openjornada;

namespace {

QueuedAction action(size_t index) {
  QueuedAction value;
  value.clientRequestId = "request-" + std::to_string(index);
  value.deviceSequence = static_cast<uint32_t>(index);
  return value;
}

std::vector<QueuedAction> actions(size_t count) {
  std::vector<QueuedAction> values;
  values.reserve(count);
  for (size_t index = 0; index < count; ++index) values.push_back(action(index));
  return values;
}

void test_batches_never_exceed_protocol_limit_and_keep_order() {
  SyncEngine engine;
  const auto pending = actions(501);
  const auto first = engine.nextBatch(pending);
  TEST_ASSERT_EQUAL_UINT32(500, first.size());
  TEST_ASSERT_EQUAL_STRING("request-0", first.front().clientRequestId.c_str());
  TEST_ASSERT_EQUAL_STRING("request-499", first.back().clientRequestId.c_str());

  std::vector<QueuedAction> remainder(pending.begin() + first.size(), pending.end());
  const auto second = engine.nextBatch(remainder);
  TEST_ASSERT_EQUAL_UINT32(1, second.size());
  TEST_ASSERT_EQUAL_STRING("request-500", second.front().clientRequestId.c_str());
}

void test_definitive_results_complete_only_the_chronological_prefix() {
  SyncEngine engine;
  const auto batch = actions(4);
  SyncResponse response;
  response.itemCount = 4;
  response.items[0].clientRequestId = "request-0";
  response.items[0].status = ActionStatus::Accepted;
  response.items[1].clientRequestId = "request-1";
  response.items[1].status = ActionStatus::Duplicate;
  response.items[2].clientRequestId = "request-2";
  response.items[2].status = ActionStatus::Incident;
  response.items[3].clientRequestId = "request-3";
  response.items[3].status = ActionStatus::Rejected;

  const auto result = engine.applyResults(batch, {}, response);
  TEST_ASSERT_EQUAL(SyncApplyStatus::Blocked, result.status);
  TEST_ASSERT_EQUAL_UINT32(3, result.completedRequestIds.size());
  TEST_ASSERT_EQUAL_STRING("request-2", result.completedRequestIds.back().c_str());
}

void test_transport_and_malformed_results_keep_the_entire_batch() {
  SyncEngine engine;
  const auto batch = actions(2);
  ApiCallResult transport;
  transport.ok = false;
  transport.failure.code = ApiErrorCode::Transport;
  transport.failure.retryable = true;
  TEST_ASSERT_EQUAL(SyncApplyStatus::Retry,
                    engine.applyResults(batch, transport, {}).status);

  SyncResponse wrongOrder;
  wrongOrder.itemCount = 2;
  wrongOrder.items[0].clientRequestId = "request-1";
  wrongOrder.items[0].status = ActionStatus::Accepted;
  wrongOrder.items[1].clientRequestId = "request-0";
  wrongOrder.items[1].status = ActionStatus::Duplicate;
  TEST_ASSERT_EQUAL(SyncApplyStatus::Invalid,
                    engine.applyResults(batch, {}, wrongOrder).status);
}

void test_definitive_http_failure_blocks_without_completing_records() {
  SyncEngine engine;
  ApiCallResult revoked;
  revoked.ok = false;
  revoked.failure.code = ApiErrorCode::TerminalRevoked;
  revoked.failure.retryable = false;
  const auto result = engine.applyResults(actions(1), revoked, {});
  TEST_ASSERT_EQUAL(SyncApplyStatus::Blocked, result.status);
  TEST_ASSERT_TRUE(result.completedRequestIds.empty());
}

void test_backoff_is_bounded_and_wrap_safe() {
  SyncEngine engine;
  engine.onTransportFailure(1'000);
  TEST_ASSERT_EQUAL_UINT32(3'000, engine.backoffUntil());
  TEST_ASSERT_FALSE(engine.ready(2'999));
  TEST_ASSERT_TRUE(engine.ready(3'000));
  engine.onTransportFailure(3'000);
  TEST_ASSERT_EQUAL_UINT32(7'000, engine.backoffUntil());
  engine.onSuccess();
  TEST_ASSERT_TRUE(engine.ready(3'001));
}

void test_replay_applies_only_valid_domain_transitions() {
  TEST_ASSERT_EQUAL(WorkKind::Working,
                    replayCommand(WorkKind::Idle, Command::ClockIn));
  TEST_ASSERT_EQUAL(WorkKind::Working,
                    replayCommand(WorkKind::Working, Command::BreakEnd));
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_batches_never_exceed_protocol_limit_and_keep_order);
  RUN_TEST(test_definitive_results_complete_only_the_chronological_prefix);
  RUN_TEST(test_transport_and_malformed_results_keep_the_entire_batch);
  RUN_TEST(test_definitive_http_failure_blocks_without_completing_records);
  RUN_TEST(test_backoff_is_bounded_and_wrap_safe);
  RUN_TEST(test_replay_applies_only_valid_domain_transitions);
  return UNITY_END();
}
