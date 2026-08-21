#include <unity.h>

#include "openjornada/gesture.hpp"
#include "openjornada/provisioning.hpp"

using namespace openjornada;

void test_ab_requires_exactly_five_seconds() {
  BootGestureDetector detector;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, false}, 100).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, false}, 5099).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::Provisioning),
      static_cast<int>(detector.update({true, true, false}, 5100).gesture));
}

void test_releasing_required_ab_button_resets_progress() {
  BootGestureDetector detector;
  detector.update({true, true, false}, 100);
  detector.update({true, false, false}, 5099);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, false}, 5100).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, false}, 10099).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::Provisioning),
      static_cast<int>(detector.update({true, true, false}, 10100).gesture));
}

void test_abc_requires_ten_seconds_and_separate_c_confirmation() {
  BootGestureDetector detector(7);
  detector.update({true, true, true}, 25);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, true}, 10024).gesture));

  const BootGestureEvent request =
      detector.update({true, true, true}, 10025);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(BootGesture::FactoryResetRequest),
                        static_cast<int>(request.gesture));
  TEST_ASSERT_EQUAL_UINT(7, request.pendingCount);
  TEST_ASSERT_TRUE(detector.awaitingFactoryConfirmation());

  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({false, false, true}, 10026).gesture));
  detector.update({false, false, false}, 10027);
  detector.update({false, false, true}, 10100);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({false, false, true}, 15099).gesture));
  const BootGestureEvent confirmed =
      detector.update({false, false, true}, 15100);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(BootGesture::FactoryReset),
                        static_cast<int>(confirmed.gesture));
  TEST_ASSERT_EQUAL_UINT(7, confirmed.pendingCount);
}

void test_factory_confirmation_resets_if_c_or_exclusivity_is_released() {
  BootGestureDetector detector(3);
  detector.update({true, true, true}, 0);
  detector.update({true, true, true}, 10000);
  detector.update({false, false, false}, 10001);

  detector.update({false, false, true}, 11000);
  detector.update({false, false, false}, 15999);
  detector.update({false, false, true}, 16000);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({false, false, true}, 20999).gesture));

  detector.update({true, false, true}, 21000);
  detector.update({false, false, true}, 21001);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({false, false, true}, 26000).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::FactoryReset),
      static_cast<int>(detector.update({false, false, true}, 26001).gesture));
}

void test_abc_never_falls_through_to_provisioning() {
  BootGestureDetector detector;
  detector.update({true, true, true}, 0);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, true}, 5000).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, false}, 5001).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::None),
      static_cast<int>(detector.update({true, true, false}, 10000).gesture));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(BootGesture::Provisioning),
      static_cast<int>(detector.update({true, true, false}, 10001).gesture));
}

void test_token_change_is_refused_only_while_actions_are_pending() {
  const DeviceConfig active{"office", "password",
                            "https://jornada.example.com", "ojterm_old", true};
  DeviceConfig candidate = active;
  candidate.terminalToken = "ojterm_new";

  TEST_ASSERT_FALSE(canApplyProvisioningCandidate(active, candidate, 1));
  TEST_ASSERT_TRUE(canApplyProvisioningCandidate(active, candidate, 0));
  candidate.terminalToken = active.terminalToken;
  TEST_ASSERT_TRUE(canApplyProvisioningCandidate(active, candidate, 20));
  TEST_ASSERT_TRUE(canApplyProvisioningCandidate(std::nullopt, candidate, 20));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_ab_requires_exactly_five_seconds);
  RUN_TEST(test_releasing_required_ab_button_resets_progress);
  RUN_TEST(test_abc_requires_ten_seconds_and_separate_c_confirmation);
  RUN_TEST(test_factory_confirmation_resets_if_c_or_exclusivity_is_released);
  RUN_TEST(test_abc_never_falls_through_to_provisioning);
  RUN_TEST(test_token_change_is_refused_only_while_actions_are_pending);
  return UNITY_END();
}
