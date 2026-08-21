#include <unity.h>

#include <string>

#include "openjornada/signature.hpp"

using namespace openjornada;

void test_matches_server_signature_vector_exactly() {
  const std::string token =
      "ojterm_abcdefghijkl_secret0123456789012345678901234567890123456789";
  QueuedAction action;
  action.clientRequestId = "req-1";
  action.uid = "04A1B2C3";
  action.command = Command::ClockIn;
  action.deviceCapturedAt = "2026-08-21T08:00:00.000Z";
  action.appliedAt = "";
  action.clockSyncedAt = "2026-08-21T07:59:59.000Z";
  action.deviceSequence = 1;
  action.rebootId = "boot-1";
  action.previousLocalHash = "";

  const std::string canonical = canonicalAction("terminal-a", action);
  TEST_ASSERT_EQUAL_STRING(
      "terminal-a|req-1|04A1B2C3|clock_in|2026-08-21T08:00:00.000Z||"
      "2026-08-21T07:59:59.000Z|1|boot-1|",
      canonical.c_str());
  TEST_ASSERT_EQUAL_STRING(
      "f6d92375cab26283b16c1174a19c60cdaff19ac4c646f6e34f6748a90fc6b118",
      signAction(deriveSigningKey(token), canonical).c_str());
}

void test_canonical_order_covers_adjustment_and_chain_fields() {
  QueuedAction action;
  action.clientRequestId = "req-2";
  action.uid = "11223344";
  action.command = Command::BreakEnd;
  action.deviceCapturedAt = "2026-08-21T12:00:00.000Z";
  action.appliedAt = "2026-08-21T11:55:00.000Z";
  action.clockSyncedAt = "2026-08-21T07:59:59.000Z";
  action.deviceSequence = 27;
  action.rebootId = "boot-2";
  action.previousLocalHash = std::string(64, 'a');

  TEST_ASSERT_EQUAL_STRING(
      ("terminal-b|req-2|11223344|break_end|2026-08-21T12:00:00.000Z|"
       "2026-08-21T11:55:00.000Z|2026-08-21T07:59:59.000Z|27|boot-2|" +
       std::string(64, 'a'))
          .c_str(),
      canonicalAction("terminal-b", action).c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_matches_server_signature_vector_exactly);
  RUN_TEST(test_canonical_order_covers_adjustment_and_chain_fields);
  return UNITY_END();
}
