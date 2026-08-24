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
  TEST_ASSERT_FALSE(canApplyProvisioningCandidate(std::nullopt, candidate, 20));
  TEST_ASSERT_TRUE(canApplyProvisioningCandidate(std::nullopt, candidate, 0));
}

void test_runtime_ab_requests_provisioning_after_five_seconds() {
  RuntimeProvisioningGesture gesture;
  auto decision = gesture.update({true, false, false}, {true, false, false},
                                 true, 100);
  TEST_ASSERT_FALSE(decision.dispatchA);
  TEST_ASSERT_FALSE(decision.suppressButtons);

  decision = gesture.update({true, true, false}, {false, true, false}, true,
                            200);
  TEST_ASSERT_TRUE(decision.suppressButtons);
  TEST_ASSERT_TRUE(decision.showCountdown);
  TEST_ASSERT_EQUAL_UINT8(5, decision.secondsRemaining);

  decision =
      gesture.update({true, true, false}, {}, true, 5199);
  TEST_ASSERT_FALSE(decision.provisioningRequested);
  TEST_ASSERT_TRUE(decision.suppressButtons);
  TEST_ASSERT_EQUAL_UINT8(1, decision.secondsRemaining);

  decision =
      gesture.update({true, true, false}, {}, true, 5200);
  TEST_ASSERT_TRUE(decision.provisioningRequested);
  TEST_ASSERT_TRUE(decision.suppressButtons);
}

void test_runtime_cancelled_combo_never_leaks_button_actions() {
  RuntimeProvisioningGesture gesture;
  gesture.update({true, false, false}, {true, false, false}, true, 0);
  gesture.update({true, true, false}, {false, true, false}, true, 100);

  auto decision = gesture.update({true, false, false}, {}, true, 1000);
  TEST_ASSERT_TRUE(decision.suppressButtons);
  TEST_ASSERT_FALSE(decision.dispatchA);
  TEST_ASSERT_FALSE(decision.dispatchB);
  TEST_ASSERT_FALSE(decision.provisioningRequested);

  decision = gesture.update({}, {}, true, 1100);
  TEST_ASSERT_FALSE(decision.suppressButtons);
  TEST_ASSERT_TRUE(decision.restoreScreen);
  TEST_ASSERT_FALSE(decision.dispatchA);
  TEST_ASSERT_FALSE(decision.dispatchB);
}

void test_runtime_single_buttons_keep_their_normal_press() {
  RuntimeProvisioningGesture gesture;
  auto decision = gesture.update({true, false, false}, {true, false, false},
                                 true, 100);
  TEST_ASSERT_FALSE(decision.dispatchA);
  decision = gesture.update({true, false, false}, {}, true, 399);
  TEST_ASSERT_FALSE(decision.dispatchA);
  decision = gesture.update({true, false, false}, {}, true, 400);
  TEST_ASSERT_TRUE(decision.dispatchA);
  TEST_ASSERT_FALSE(decision.dispatchB);

  RuntimeProvisioningGesture quickPress;
  quickPress.update({false, true, false}, {false, true, false}, true, 800);
  decision = quickPress.update({}, {}, true, 850);
  TEST_ASSERT_TRUE(decision.dispatchB);
  TEST_ASSERT_FALSE(decision.dispatchA);
}

void test_runtime_late_second_button_cannot_turn_an_emitted_action_into_recovery() {
  RuntimeProvisioningGesture gesture;
  gesture.update({true, false, false}, {true, false, false}, true, 0);
  auto decision = gesture.update({true, false, false}, {}, true, 300);
  TEST_ASSERT_TRUE(decision.dispatchA);

  decision = gesture.update({true, true, false}, {false, true, false}, true,
                            301);
  TEST_ASSERT_FALSE(decision.suppressButtons);
  TEST_ASSERT_FALSE(decision.showCountdown);
  TEST_ASSERT_FALSE(decision.provisioningRequested);
  decision = gesture.update({true, true, false}, {}, true, 601);
  TEST_ASSERT_TRUE(decision.dispatchB);
  TEST_ASSERT_FALSE(decision.provisioningRequested);
}

void test_provisioning_cancel_requires_release_then_three_seconds_of_only_c() {
  ProvisioningCancelGesture gesture;
  auto decision = gesture.update({true, true, false}, 0);
  TEST_ASSERT_FALSE(decision.showCountdown);
  gesture.update({}, 100);

  decision = gesture.update({false, false, true}, 200);
  TEST_ASSERT_TRUE(decision.showCountdown);
  TEST_ASSERT_EQUAL_UINT8(3, decision.secondsRemaining);
  decision = gesture.update({false, false, true}, 3199);
  TEST_ASSERT_FALSE(decision.cancelRequested);
  decision = gesture.update({false, false, true}, 3200);
  TEST_ASSERT_TRUE(decision.cancelRequested);
}

void test_provisioning_cancel_is_aborted_by_another_button() {
  ProvisioningCancelGesture gesture;
  gesture.update({}, 0);
  gesture.update({false, false, true}, 100);
  auto decision = gesture.update({true, false, true}, 1000);
  TEST_ASSERT_TRUE(decision.restoreScreen);
  TEST_ASSERT_FALSE(decision.cancelRequested);
  decision = gesture.update({}, 1100);
  TEST_ASSERT_FALSE(decision.cancelRequested);
  gesture.update({false, false, true}, 1200);
  decision = gesture.update({false, false, true}, 4200);
  TEST_ASSERT_TRUE(decision.cancelRequested);
}

void test_runtime_wake_press_is_not_replayed_and_timer_wrap_is_safe() {
  RuntimeProvisioningGesture wakeGesture;
  auto decision = wakeGesture.update({true, false, false}, {true, false, false},
                                     false, 100);
  TEST_ASSERT_FALSE(decision.dispatchA);
  decision = wakeGesture.update({}, {}, true, 1000);
  TEST_ASSERT_FALSE(decision.dispatchA);

  RuntimeProvisioningGesture wrapGesture;
  constexpr uint32_t started = UINT32_MAX - 1000U;
  decision = wrapGesture.update({true, true, false}, {true, true, false}, true,
                                started);
  TEST_ASSERT_TRUE(decision.suppressButtons);
  decision = wrapGesture.update({true, true, false}, {}, true, 3998U);
  TEST_ASSERT_FALSE(decision.provisioningRequested);
  decision = wrapGesture.update({true, true, false}, {}, true, 3999U);
  TEST_ASSERT_TRUE(decision.provisioningRequested);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_ab_requires_exactly_five_seconds);
  RUN_TEST(test_releasing_required_ab_button_resets_progress);
  RUN_TEST(test_abc_requires_ten_seconds_and_separate_c_confirmation);
  RUN_TEST(test_factory_confirmation_resets_if_c_or_exclusivity_is_released);
  RUN_TEST(test_abc_never_falls_through_to_provisioning);
  RUN_TEST(test_token_change_is_refused_only_while_actions_are_pending);
  RUN_TEST(test_runtime_ab_requests_provisioning_after_five_seconds);
  RUN_TEST(test_runtime_cancelled_combo_never_leaks_button_actions);
  RUN_TEST(test_runtime_single_buttons_keep_their_normal_press);
  RUN_TEST(
      test_runtime_late_second_button_cannot_turn_an_emitted_action_into_recovery);
  RUN_TEST(test_runtime_wake_press_is_not_replayed_and_timer_wrap_is_safe);
  RUN_TEST(
      test_provisioning_cancel_requires_release_then_three_seconds_of_only_c);
  RUN_TEST(test_provisioning_cancel_is_aborted_by_another_button);
  return UNITY_END();
}
