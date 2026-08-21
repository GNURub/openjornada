#include <unity.h>

#include "openjornada/rfid_diagnostic.hpp"

using openjornada::RfidDiagnosticGate;
using openjornada::RfidPollStatus;

void test_failure_is_retried_after_rate_limit() {
  RfidDiagnosticGate gate{2000};
  TEST_ASSERT_FALSE(gate.shouldLog(RfidPollStatus::NoNewCard, 0));
  TEST_ASSERT_TRUE(gate.shouldLog(RfidPollStatus::ReadFailed, 100));
  TEST_ASSERT_FALSE(gate.shouldLog(RfidPollStatus::NoNewCard, 200));
  TEST_ASSERT_FALSE(gate.shouldLog(RfidPollStatus::ReadFailed, 500));
  TEST_ASSERT_TRUE(gate.shouldLog(RfidPollStatus::ReadFailed, 2100));
  TEST_ASSERT_FALSE(gate.shouldLog(RfidPollStatus::ReadFailed, 2200));
}

void test_success_is_logged_only_on_transition() {
  RfidDiagnosticGate gate{2000};
  TEST_ASSERT_TRUE(gate.shouldLog(RfidPollStatus::ReadSuccess, 0));
  TEST_ASSERT_FALSE(gate.shouldLog(RfidPollStatus::ReadSuccess, 20));
  TEST_ASSERT_FALSE(gate.shouldLog(RfidPollStatus::NoNewCard, 40));
  TEST_ASSERT_TRUE(gate.shouldLog(RfidPollStatus::ReadSuccess, 60));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_failure_is_retried_after_rate_limit);
  RUN_TEST(test_success_is_logged_only_on_transition);
  return UNITY_END();
}
