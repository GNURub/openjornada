#include <unity.h>

#include "openjornada/admin_flow.hpp"

using namespace openjornada;

namespace {

void test_admin_combo_activates_at_three_seconds_and_cancels_early() {
  AdminFlow flow;
  TEST_ASSERT_FALSE(flow.holdCombo(true, false, true, 1000));
  TEST_ASSERT_FALSE(flow.holdCombo(true, false, true, 3999));
  TEST_ASSERT_TRUE(flow.holdCombo(true, false, true, 4000));
  TEST_ASSERT_FALSE(flow.holdCombo(true, false, true, 4001));

  AdminFlow cancelled;
  TEST_ASSERT_FALSE(cancelled.holdCombo(true, false, true, 1000));
  TEST_ASSERT_FALSE(cancelled.holdCombo(false, false, true, 3999));
  TEST_ASSERT_FALSE(cancelled.holdCombo(true, false, true, 4000));
  TEST_ASSERT_FALSE(cancelled.holdCombo(true, false, true, 6999));
  TEST_ASSERT_TRUE(cancelled.holdCombo(true, false, true, 7000));
}

void test_pin_digits_wrap_and_four_confirmations_return_exact_pin() {
  AdminFlow flow;
  flow.resetPin();
  TEST_ASSERT_FALSE(flow.updatePin(Button::A, 1).has_value());
  TEST_ASSERT_EQUAL_STRING("9___", flow.pinDisplay().c_str());
  TEST_ASSERT_FALSE(flow.updatePin(Button::B, 2).has_value());
  TEST_ASSERT_FALSE(flow.updatePin(Button::C, 3).has_value());
  TEST_ASSERT_FALSE(flow.updatePin(Button::B, 4).has_value());
  TEST_ASSERT_FALSE(flow.updatePin(Button::B, 5).has_value());
  const auto pin = flow.updatePin(Button::B, 6);
  TEST_ASSERT_TRUE(pin.has_value());
  TEST_ASSERT_EQUAL_STRING("9100", pin->c_str());
}

void test_session_is_ram_only_and_expires_on_time_or_network_loss() {
  AdminFlow flow;
  TEST_ASSERT_FALSE(flow.setSession("invalid", 1000));
  TEST_ASSERT_TRUE(flow.setSession("ojtadmin_session-capability", 1000));
  TEST_ASSERT_TRUE(flow.canAdminister(true));
  TEST_ASSERT_FALSE(flow.expire(300999, true));
  TEST_ASSERT_TRUE(flow.expire(301000, true));
  TEST_ASSERT_FALSE(flow.hasSession());

  TEST_ASSERT_TRUE(flow.setSession("ojtadmin_second", 500000));
  TEST_ASSERT_TRUE(flow.expire(500001, false));
  TEST_ASSERT_FALSE(flow.canAdminister(true));
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_admin_combo_activates_at_three_seconds_and_cancels_early);
  RUN_TEST(test_pin_digits_wrap_and_four_confirmations_return_exact_pin);
  RUN_TEST(test_session_is_ram_only_and_expires_on_time_or_network_loss);
  return UNITY_END();
}
