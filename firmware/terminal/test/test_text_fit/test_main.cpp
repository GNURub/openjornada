#include <unity.h>

#include <string>
#include <string_view>

#include "openjornada/screen.hpp"

using namespace openjornada;

namespace {

int fakePixelWidth(std::string_view value) {
  int width = 0;
  for (size_t index = 0; index < value.size();) {
    const unsigned char byte = value[index];
    size_t length = 1;
    if ((byte & 0xE0U) == 0xC0U) length = 2;
    else if ((byte & 0xF0U) == 0xE0U) length = 3;
    else if ((byte & 0xF8U) == 0xF0U) length = 4;
    width += length == 1 ? 7 : 9;
    index += length;
  }
  return width;
}

void test_accented_text_is_cut_only_at_utf8_boundaries_and_by_pixels() {
  const std::string value = "Administración y atención ñandú";
  const std::string fitted = fitUtf8ToWidth(value, 105, fakePixelWidth);
  TEST_ASSERT_TRUE(validUtf8(fitted));
  TEST_ASSERT_LESS_OR_EQUAL_INT(105, fakePixelWidth(fitted));
  TEST_ASSERT_NOT_EQUAL(value, fitted);
  TEST_ASSERT_TRUE(fitted.size() >= 3);
  TEST_ASSERT_EQUAL_STRING("...", fitted.substr(fitted.size() - 3).c_str());
}

void test_long_button_label_uses_available_pixel_width() {
  const std::string fitted = fitUtf8ToWidth(
      "Terminé antes de lo previsto", 96, fakePixelWidth);
  TEST_ASSERT_TRUE(validUtf8(fitted));
  TEST_ASSERT_LESS_OR_EQUAL_INT(96, fakePixelWidth(fitted));
}

void test_invalid_utf8_is_never_forwarded_to_the_display() {
  const std::string invalid = std::string("Contrase") + '\xC3' + " rota";
  const std::string fitted = fitUtf8ToWidth(invalid, 300, fakePixelWidth);
  TEST_ASSERT_TRUE(validUtf8(fitted));
  TEST_ASSERT_EQUAL_STRING("Contrase...", fitted.c_str());
}

void test_empty_suffix_returns_a_wrappable_boundary_prefix() {
  const std::string fitted = fitUtf8ToWidth(
      "Pausa terminada: conciliación pendiente", 90, fakePixelWidth, "");
  TEST_ASSERT_TRUE(validUtf8(fitted));
  TEST_ASSERT_LESS_OR_EQUAL_INT(90, fakePixelWidth(fitted));
  TEST_ASSERT_FALSE(fitted.empty());
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_accented_text_is_cut_only_at_utf8_boundaries_and_by_pixels);
  RUN_TEST(test_long_button_label_uses_available_pixel_width);
  RUN_TEST(test_invalid_utf8_is_never_forwarded_to_the_display);
  RUN_TEST(test_empty_suffix_returns_a_wrappable_boundary_prefix);
  return UNITY_END();
}
