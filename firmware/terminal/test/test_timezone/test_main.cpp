#include <unity.h>

#include <array>
#include <cstdlib>
#include <ctime>
#include <string>

#include "openjornada/timezone.hpp"

using namespace openjornada;

namespace {

std::string localTime(const char* timezone, std::time_t epoch) {
  setenv("TZ", timezone, 1);
  tzset();
  std::tm local{};
  localtime_r(&epoch, &local);
  std::array<char, 24> output{};
  strftime(output.data(), output.size(), "%Y-%m-%d %H:%M", &local);
  return output.data();
}

}  // namespace

void test_madrid_timezone_applies_summer_and_winter_offsets() {
  const char* timezone = posixTimezone("Europe/Madrid");
  TEST_ASSERT_NOT_NULL(timezone);

  TEST_ASSERT_EQUAL_STRING(
      "2026-08-24 00:21",
      localTime(timezone, 1787523660).c_str());
  TEST_ASSERT_EQUAL_STRING(
      "2026-01-15 13:00",
      localTime(timezone, 1768478400).c_str());
}

void test_canary_timezone_applies_summer_and_winter_offsets() {
  const char* timezone = posixTimezone("Atlantic/Canary");
  TEST_ASSERT_NOT_NULL(timezone);

  TEST_ASSERT_EQUAL_STRING(
      "2026-08-23 23:21",
      localTime(timezone, 1787523660).c_str());
  TEST_ASSERT_EQUAL_STRING(
      "2026-01-15 12:00",
      localTime(timezone, 1768478400).c_str());
}

void test_unknown_timezone_is_rejected() {
  TEST_ASSERT_NULL(posixTimezone("Etc/Unknown"));
  TEST_ASSERT_NULL(posixTimezone(""));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_madrid_timezone_applies_summer_and_winter_offsets);
  RUN_TEST(test_canary_timezone_applies_summer_and_winter_offsets);
  RUN_TEST(test_unknown_timezone_is_rejected);
  return UNITY_END();
}
