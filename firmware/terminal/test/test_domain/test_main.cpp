#include <unity.h>

#include "openjornada/domain.hpp"

using namespace openjornada;

void test_idle_buttons() {
  const auto labels = visibleButtons({WorkKind::Idle, 0, 0, false, false});
  TEST_ASSERT_NULL(labels.a);
  TEST_ASSERT_EQUAL_STRING("Comenzar", labels.b);
  TEST_ASSERT_NULL(labels.c);
}

void test_short_shift_buttons() {
  const auto labels = visibleButtons({WorkKind::Working, 14'399, 0, false, false});
  TEST_ASSERT_EQUAL_STRING("Pausa", labels.a);
  TEST_ASSERT_NULL(labels.b);
  TEST_ASSERT_EQUAL_STRING("Terminar", labels.c);
}

void test_long_shift_buttons() {
  WorkState state{WorkKind::Working, 14'400, 0, true, false};
  const auto labels = visibleButtons(state);
  TEST_ASSERT_EQUAL_STRING("Pausa", labels.a);
  TEST_ASSERT_EQUAL_STRING("Terminar", labels.b);
  TEST_ASSERT_EQUAL_STRING("Antes", labels.c);
}

void test_break_buttons() {
  const auto labels = visibleButtons({WorkKind::OnBreak, 0, 1'501, false, true});
  TEST_ASSERT_EQUAL_STRING("Fin pausa", labels.a);
  TEST_ASSERT_NULL(labels.b);
  TEST_ASSERT_EQUAL_STRING("Acabar", labels.c);
}

void test_valid_state_transitions() {
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(WorkKind::Working),
      static_cast<int>(nextKind(WorkKind::Idle, Command::ClockIn)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(WorkKind::OnBreak),
      static_cast<int>(nextKind(WorkKind::Working, Command::BreakStart)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(WorkKind::Working),
      static_cast<int>(nextKind(WorkKind::OnBreak, Command::BreakEnd)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(WorkKind::Idle),
      static_cast<int>(nextKind(WorkKind::Working, Command::ClockOut)));
}

void test_invalid_state_transition_keeps_current_state() {
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(WorkKind::Idle),
      static_cast<int>(nextKind(WorkKind::Idle, Command::BreakStart)));
}

void test_adjusted_minutes() {
  TEST_ASSERT_EQUAL_INT(55, adjustedMinutes(60, Button::A, false));
  TEST_ASSERT_EQUAL_INT(65, adjustedMinutes(60, Button::C, false));
  TEST_ASSERT_EQUAL_INT(30, adjustedMinutes(60, Button::A, true));
  TEST_ASSERT_EQUAL_INT(90, adjustedMinutes(60, Button::C, true));
  TEST_ASSERT_EQUAL_INT(60, adjustedMinutes(60, Button::B, true));
}

void test_clock_trust() {
  TEST_ASSERT_TRUE(offlineClockTrusted(1'000, 87'400, false));
  TEST_ASSERT_FALSE(offlineClockTrusted(1'000, 87'401, false));
  TEST_ASSERT_FALSE(offlineClockTrusted(1'000, 1'100, true));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_idle_buttons);
  RUN_TEST(test_short_shift_buttons);
  RUN_TEST(test_long_shift_buttons);
  RUN_TEST(test_break_buttons);
  RUN_TEST(test_valid_state_transitions);
  RUN_TEST(test_invalid_state_transition_keeps_current_state);
  RUN_TEST(test_adjusted_minutes);
  RUN_TEST(test_clock_trust);
  return UNITY_END();
}
