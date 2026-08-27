#include <unity.h>

#include <cstdint>

#include "openjornada/telemetry_scheduler.hpp"

using namespace openjornada;

namespace {

void test_scheduler_never_accumulates_or_starts_while_primary_is_busy() {
  TelemetryScheduler scheduler{15000U};
  TEST_ASSERT_FALSE(scheduler.due(0U, false, false, false));
  TEST_ASSERT_FALSE(scheduler.due(0U, true, true, false));
  TEST_ASSERT_TRUE(scheduler.due(0U, true, false, false));
  scheduler.markEnqueued(0U);
  TEST_ASSERT_FALSE(scheduler.due(14999U, true, false, false));
  TEST_ASSERT_FALSE(scheduler.due(15000U, true, false, true));
  TEST_ASSERT_FALSE(scheduler.due(45000U, true, true, false));
  TEST_ASSERT_TRUE(scheduler.due(45000U, true, false, false));
  scheduler.markEnqueued(45000U);
  TEST_ASSERT_FALSE(scheduler.due(59999U, true, false, false));
  TEST_ASSERT_TRUE(scheduler.due(60000U, true, false, false));
}

void test_scheduler_deadline_is_wrap_safe() {
  TelemetryScheduler scheduler{15000U};
  constexpr uint32_t enqueuedAt = UINT32_MAX - 5000U;
  scheduler.markEnqueued(enqueuedAt);

  TEST_ASSERT_FALSE(scheduler.due(UINT32_MAX, true, false, false));
  TEST_ASSERT_FALSE(scheduler.due(9998U, true, false, false));
  TEST_ASSERT_TRUE(scheduler.due(9999U, true, false, false));
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_scheduler_never_accumulates_or_starts_while_primary_is_busy);
  RUN_TEST(test_scheduler_deadline_is_wrap_safe);
  return UNITY_END();
}
