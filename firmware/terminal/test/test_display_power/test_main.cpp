#include <unity.h>

#include <cstdint>

#include "openjornada/admin_flow.hpp"
#include "openjornada/display_power.hpp"

using namespace openjornada;

void test_display_sleeps_after_exactly_ten_minutes_without_activity() {
  DisplayPowerPolicy policy{100};

  auto decision = policy.update(
      100 + kDisplayIdleMs - 1U, DisplayActivity{});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::None),
                        static_cast<int>(decision.power));
  TEST_ASSERT_FALSE(policy.sleeping());

  decision = policy.update(100 + kDisplayIdleMs, DisplayActivity{});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::Sleep),
                        static_cast<int>(decision.power));
  TEST_ASSERT_TRUE(policy.sleeping());
}

void test_first_button_wakes_but_is_suppressed_until_all_buttons_release() {
  DisplayPowerPolicy policy{0};
  policy.update(kDisplayIdleMs, DisplayActivity{});

  auto decision = policy.update(
      kDisplayIdleMs + 1U, DisplayActivity{true, true, false});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::Wake),
                        static_cast<int>(decision.power));
  TEST_ASSERT_FALSE(decision.dispatchButtons);

  decision = policy.update(kDisplayIdleMs + 900U,
                           DisplayActivity{false, true, false});
  TEST_ASSERT_FALSE(decision.dispatchButtons);

  decision = policy.update(kDisplayIdleMs + 901U, DisplayActivity{});
  TEST_ASSERT_FALSE(decision.dispatchButtons);

  decision = policy.update(
      kDisplayIdleMs + 902U, DisplayActivity{true, true, false});
  TEST_ASSERT_TRUE(decision.dispatchButtons);
}

void test_tag_wakes_and_is_dispatched_immediately() {
  DisplayPowerPolicy policy{0};
  policy.update(kDisplayIdleMs, DisplayActivity{});

  const auto decision = policy.update(
      kDisplayIdleMs + 1U, DisplayActivity{false, false, true});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::Wake),
                        static_cast<int>(decision.power));
  TEST_ASSERT_TRUE(decision.dispatchTag);
  TEST_ASSERT_FALSE(policy.sleeping());
}

void test_tag_and_button_together_wake_and_only_dispatch_the_tag() {
  DisplayPowerPolicy policy{0};
  policy.update(kDisplayIdleMs, DisplayActivity{});

  const auto decision = policy.update(
      kDisplayIdleMs + 1U, DisplayActivity{true, true, true});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::Wake),
                        static_cast<int>(decision.power));
  TEST_ASSERT_FALSE(decision.dispatchButtons);
  TEST_ASSERT_TRUE(decision.dispatchTag);
}

void test_wake_hold_cannot_activate_admin_combo_until_buttons_are_released() {
  DisplayPowerPolicy policy{0};
  AdminFlow admin;
  policy.update(kDisplayIdleMs, DisplayActivity{});

  auto decision = policy.update(
      kDisplayIdleMs + 1U, DisplayActivity{true, true, false});
  TEST_ASSERT_FALSE(admin.holdCombo(decision.dispatchButtons, false,
                                    decision.dispatchButtons,
                                    kDisplayIdleMs + 1U));

  decision = policy.update(kDisplayIdleMs + AdminFlow::kActivationHoldMs + 1U,
                           DisplayActivity{false, true, false});
  TEST_ASSERT_FALSE(admin.holdCombo(decision.dispatchButtons, false,
                                    decision.dispatchButtons,
                                    kDisplayIdleMs +
                                        AdminFlow::kActivationHoldMs + 1U));

  decision = policy.update(kDisplayIdleMs + AdminFlow::kActivationHoldMs + 2U,
                           DisplayActivity{});
  TEST_ASSERT_FALSE(decision.dispatchButtons);

  decision = policy.update(kDisplayIdleMs + AdminFlow::kActivationHoldMs + 3U,
                           DisplayActivity{true, true, false});
  TEST_ASSERT_TRUE(decision.dispatchButtons);
  TEST_ASSERT_FALSE(admin.holdCombo(
      true, false, true,
      kDisplayIdleMs + AdminFlow::kActivationHoldMs + 3U));
  TEST_ASSERT_TRUE(admin.holdCombo(
      true, false, true,
      kDisplayIdleMs + 2U * AdminFlow::kActivationHoldMs + 3U));
}

void test_physical_activity_restarts_the_full_idle_period() {
  DisplayPowerPolicy policy{0};
  policy.update(kDisplayIdleMs - 1U,
                DisplayActivity{true, true, false});

  auto decision = policy.update(2U * kDisplayIdleMs - 2U,
                                DisplayActivity{});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::None),
                        static_cast<int>(decision.power));
  decision = policy.update(2U * kDisplayIdleMs - 1U,
                           DisplayActivity{});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::Sleep),
                        static_cast<int>(decision.power));
}

void test_display_idle_deadline_is_millis_rollover_safe() {
  const uint32_t startedAt = UINT32_MAX - 1000U;
  DisplayPowerPolicy policy{startedAt};

  const auto decision = policy.update(startedAt + kDisplayIdleMs,
                                      DisplayActivity{});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::Sleep),
                        static_cast<int>(decision.power));
}

void test_reset_starts_a_full_idle_period_for_a_new_screen() {
  DisplayPowerPolicy policy{0};
  policy.reset(15000U);

  auto decision = policy.update(15000U + kDisplayIdleMs - 1U,
                                DisplayActivity{});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::None),
                        static_cast<int>(decision.power));
  decision = policy.update(15000U + kDisplayIdleMs, DisplayActivity{});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplayPowerEvent::Sleep),
                        static_cast<int>(decision.power));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_display_sleeps_after_exactly_ten_minutes_without_activity);
  RUN_TEST(test_first_button_wakes_but_is_suppressed_until_all_buttons_release);
  RUN_TEST(test_tag_wakes_and_is_dispatched_immediately);
  RUN_TEST(test_tag_and_button_together_wake_and_only_dispatch_the_tag);
  RUN_TEST(
      test_wake_hold_cannot_activate_admin_combo_until_buttons_are_released);
  RUN_TEST(test_physical_activity_restarts_the_full_idle_period);
  RUN_TEST(test_display_idle_deadline_is_millis_rollover_safe);
  RUN_TEST(test_reset_starts_a_full_idle_period_for_a_new_screen);
  return UNITY_END();
}
