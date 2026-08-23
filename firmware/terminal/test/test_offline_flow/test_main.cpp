#include <unity.h>

#include "openjornada/clock_trust.hpp"

using namespace openjornada;

namespace {

void test_boot_requires_a_fresh_ntp_sync_for_new_offline_actions() {
  ClockTrust trust{1'000};
  trust.onBoot();
  TEST_ASSERT_FALSE(trust.canCreateOffline(1'001));
  TEST_ASSERT_TRUE(trust.canSyncQueued());
  TEST_ASSERT_TRUE(trust.onNtpSync(2'000));
  TEST_ASSERT_TRUE(trust.canCreateOffline(2'001));
}

void test_clock_trust_expires_after_exactly_twenty_four_hours() {
  ClockTrust trust;
  trust.onBoot();
  TEST_ASSERT_TRUE(trust.onNtpSync(10'000));
  TEST_ASSERT_TRUE(trust.canCreateOffline(10'000 + 86'400));
  TEST_ASSERT_FALSE(trust.canCreateOffline(10'000 + 86'401));
}

void test_invalid_or_backwards_time_never_becomes_trusted() {
  ClockTrust trust;
  trust.onBoot();
  TEST_ASSERT_FALSE(trust.onNtpSync(0));
  TEST_ASSERT_FALSE(trust.canCreateOffline(1));
  TEST_ASSERT_TRUE(trust.onNtpSync(10'000));
  TEST_ASSERT_FALSE(trust.canCreateOffline(9'999));
}

void test_periodic_ntp_refresh_extends_trust_without_accepting_rollback() {
  ClockTrust trust;
  trust.onBoot();
  TEST_ASSERT_TRUE(trust.onNtpSync(10'000));
  TEST_ASSERT_TRUE(trust.onNtpSync(20'000));
  TEST_ASSERT_TRUE(trust.canCreateOffline(20'000 + 86'400));
  TEST_ASSERT_FALSE(trust.onNtpSync(19'999));
  TEST_ASSERT_EQUAL_INT64(20'000, trust.lastNtpEpochSeconds());
}

void test_first_ntp_sync_after_boot_cannot_rollback_persisted_evidence() {
  ClockTrust trust{20'000};
  trust.onBoot();
  TEST_ASSERT_FALSE(trust.onNtpSync(19'999));
  TEST_ASSERT_FALSE(trust.canCreateOffline(20'000));
  TEST_ASSERT_TRUE(trust.onNtpSync(20'000));
  TEST_ASSERT_TRUE(trust.canCreateOffline(20'001));
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_boot_requires_a_fresh_ntp_sync_for_new_offline_actions);
  RUN_TEST(test_clock_trust_expires_after_exactly_twenty_four_hours);
  RUN_TEST(test_invalid_or_backwards_time_never_becomes_trusted);
  RUN_TEST(test_periodic_ntp_refresh_extends_trust_without_accepting_rollback);
  RUN_TEST(test_first_ntp_sync_after_boot_cannot_rollback_persisted_evidence);
  return UNITY_END();
}
