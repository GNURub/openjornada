#include <unity.h>

#include <string>

#include "openjornada/config.hpp"
#include "openjornada/url_policy.hpp"

using namespace openjornada;

void test_release_accepts_https_only() {
  TEST_ASSERT_TRUE(
      validateBaseUrl("https://jornada.example.com", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("http://192.168.1.20:8090", BuildProfile::Release)
          .allowed);
}

void test_development_http_is_limited_to_rfc1918() {
  TEST_ASSERT_TRUE(
      validateBaseUrl("http://10.1.2.3", BuildProfile::Development).allowed);
  TEST_ASSERT_TRUE(
      validateBaseUrl("http://172.16.0.1:8090", BuildProfile::Development)
          .allowed);
  TEST_ASSERT_TRUE(
      validateBaseUrl("http://172.31.255.254", BuildProfile::Development)
          .allowed);
  TEST_ASSERT_TRUE(
      validateBaseUrl("http://192.168.1.20:8090", BuildProfile::Development)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("http://172.32.0.1", BuildProfile::Development).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("http://203.0.113.10", BuildProfile::Development)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("http://openjornada.local", BuildProfile::Development)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("http://169.254.1.2", BuildProfile::Development).allowed);
}

void test_rejects_loopback_credentials_fragments_and_unsupported_schemes() {
  TEST_ASSERT_FALSE(
      validateBaseUrl("http://127.0.0.1:8090", BuildProfile::Development)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://localhost", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://user:password@example.com", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com/#secret", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("ftp://example.com", BuildProfile::Release).allowed);
}

void test_rejects_malformed_authority_and_ports() {
  TEST_ASSERT_FALSE(validateBaseUrl("HTTPS://example.com", BuildProfile::Release)
                        .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com:0", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com:65536", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com:", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://-bad.example", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example..com", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://127.0.0.01", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://2130706433", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://[2001:db8::1]", BuildProfile::Release).allowed);
}

void test_rejects_path_traversal_query_whitespace_and_backslash() {
  TEST_ASSERT_TRUE(
      validateBaseUrl("https://example.com/openjornada", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com/a/../b", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com/a/%2e%2E/b", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com/a%2fb", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com?token=x", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com\\path", BuildProfile::Release)
          .allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com/a b", BuildProfile::Release).allowed);
  TEST_ASSERT_FALSE(
      validateBaseUrl("https://example.com/%7f", BuildProfile::Release)
          .allowed);
}

void test_config_limits_and_token_prefix() {
  DeviceConfig valid{"wifi", std::string(63, 'p'),
                     "https://jornada.example.com", "ojterm_secret", true};
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ConfigError::None),
                        static_cast<int>(
                            validateDeviceConfig(valid, BuildProfile::Release)));

  valid.ssid.clear();
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ConfigError::EmptySsid),
      static_cast<int>(validateDeviceConfig(valid, BuildProfile::Release)));
  valid.ssid = std::string(33, 's');
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ConfigError::SsidTooLong),
      static_cast<int>(validateDeviceConfig(valid, BuildProfile::Release)));
  valid.ssid = "wifi";
  valid.wifiPassword = std::string(64, 'p');
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ConfigError::WifiPasswordTooLong),
      static_cast<int>(validateDeviceConfig(valid, BuildProfile::Release)));
  valid.wifiPassword.clear();
  valid.baseUrl = "https://jornada.example.com";
  valid.terminalToken = "wrong_secret";
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ConfigError::InvalidTerminalToken),
      static_cast<int>(validateDeviceConfig(valid, BuildProfile::Release)));
  valid.terminalToken = std::string("ojterm_") + std::string(90, 'x');
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ConfigError::TerminalTokenTooLong),
      static_cast<int>(validateDeviceConfig(valid, BuildProfile::Release)));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_release_accepts_https_only);
  RUN_TEST(test_development_http_is_limited_to_rfc1918);
  RUN_TEST(test_rejects_loopback_credentials_fragments_and_unsupported_schemes);
  RUN_TEST(test_rejects_malformed_authority_and_ports);
  RUN_TEST(test_rejects_path_traversal_query_whitespace_and_backslash);
  RUN_TEST(test_config_limits_and_token_prefix);
  return UNITY_END();
}
