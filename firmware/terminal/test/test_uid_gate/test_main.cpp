#include <unity.h>

#include "openjornada/uid_gate.hpp"

using openjornada::UidGate;

void test_uid_requires_removal() {
  UidGate gate{300};
  TEST_ASSERT_TRUE(gate.accept("04A1B2C3", true, 0));
  TEST_ASSERT_FALSE(gate.accept("04A1B2C3", true, 500));
  TEST_ASSERT_FALSE(gate.accept("", false, 600));
  TEST_ASSERT_TRUE(gate.accept("04A1B2C3", true, 901));
}

void test_short_absence_does_not_rearm_gate() {
  UidGate gate{300};
  TEST_ASSERT_TRUE(gate.accept("04A1B2C3", true, 0));
  TEST_ASSERT_FALSE(gate.accept("", false, 100));
  TEST_ASSERT_FALSE(gate.accept("04A1B2C3", true, 399));
}

void test_different_uid_is_accepted_without_waiting_for_removal() {
  UidGate gate{300};
  TEST_ASSERT_TRUE(gate.accept("04A1B2C3", true, 0));
  TEST_ASSERT_TRUE(gate.accept("11223344", true, 10));
  TEST_ASSERT_FALSE(gate.accept("11223344", true, 20));
}

void test_empty_uid_is_never_accepted() {
  UidGate gate{300};
  TEST_ASSERT_FALSE(gate.accept("", true, 0));
  TEST_ASSERT_FALSE(gate.accept("", false, 500));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_uid_requires_removal);
  RUN_TEST(test_short_absence_does_not_rearm_gate);
  RUN_TEST(test_different_uid_is_accepted_without_waiting_for_removal);
  RUN_TEST(test_empty_uid_is_never_accepted);
  return UNITY_END();
}
