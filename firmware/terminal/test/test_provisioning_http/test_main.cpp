#include <unity.h>

#include <string>

#include "openjornada/provisioning.hpp"

using namespace openjornada;

namespace {

CaptiveHttpParseStatus feed(BoundedCaptiveHttpParser& parser,
                            const std::string& bytes) {
  for (const char byte : bytes) {
    if (parser.status() != CaptiveHttpParseStatus::NeedMore) break;
    parser.consume(byte);
  }
  return parser.status();
}

std::string postHeaders(size_t contentLength) {
  return "POST /save HTTP/1.1\r\n"
         "Host: 192.168.4.1\r\n"
         "Origin: http://192.168.4.1\r\n"
         "Content-Type: application/x-www-form-urlencoded\r\n"
         "Content-Length: " +
         std::to_string(contentLength) + "\r\n\r\n";
}

CaptiveHttpRequest validFormRequest() {
  CaptiveHttpRequest request;
  request.method = "POST";
  request.target = "/save";
  request.host = "192.168.4.1";
  request.origin = "http://192.168.4.1";
  request.contentType = "application/x-www-form-urlencoded";
  request.body = "csrf=expected&ssid=office&wifi_password=password&"
                 "base_url=https%3A%2F%2Fjornada.example.com&"
                 "terminal_token=ojterm_token";
  return request;
}

}  // namespace

void test_oversized_content_length_is_rejected_before_body_consumption() {
  BoundedCaptiveHttpParser parser;
  const std::string request =
      postHeaders(kMaxProvisioningFormBodyBytes + 1U) + "secret-body";

  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::BodyTooLarge),
      static_cast<int>(feed(parser, request)));
  TEST_ASSERT_EQUAL_UINT(0, parser.bodyBytesConsumed());
  TEST_ASSERT_TRUE(parser.request().body.empty());

  parser.consume('x');
  TEST_ASSERT_EQUAL_UINT(0, parser.bodyBytesConsumed());
  TEST_ASSERT_TRUE(parser.request().body.empty());
}

void test_body_at_limit_is_read_with_bounded_storage() {
  BoundedCaptiveHttpParser parser;
  const std::string body(kMaxProvisioningFormBodyBytes, 'a');

  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Complete),
      static_cast<int>(feed(parser, postHeaders(body.size()) + body)));
  TEST_ASSERT_EQUAL_UINT(body.size(), parser.bodyBytesConsumed());
  TEST_ASSERT_EQUAL_UINT(body.size(), parser.request().body.size());
}

void test_header_limit_and_transfer_encoding_are_rejected() {
  BoundedCaptiveHttpParser oversizedHeaders;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::HeaderTooLarge),
      static_cast<int>(feed(
          oversizedHeaders,
          "GET / HTTP/1.1\r\nX-Fill: " +
              std::string(kMaxProvisioningHeaderBytes, 'x'))));
  TEST_ASSERT_EQUAL_UINT(0, oversizedHeaders.bodyBytesConsumed());

  BoundedCaptiveHttpParser chunked;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Invalid),
      static_cast<int>(feed(chunked,
                            "POST /save HTTP/1.1\r\n"
                            "Host: 192.168.4.1\r\n"
                            "Transfer-Encoding: chunked\r\n\r\n")));
}

void test_ambiguous_content_length_and_transfer_encoding_are_rejected() {
  BoundedCaptiveHttpParser duplicateLength;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Invalid),
      static_cast<int>(feed(duplicateLength,
                            "POST /save HTTP/1.1\r\n"
                            "Content-Length: 0\r\n"
                            "Content-Length: 0\r\n\r\n")));

  BoundedCaptiveHttpParser lengthAndTransferEncoding;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Invalid),
      static_cast<int>(feed(lengthAndTransferEncoding,
                            "POST /save HTTP/1.1\r\n"
                            "Content-Length: 4\r\n"
                            "Transfer-Encoding: chunked\r\n\r\nbody")));
  TEST_ASSERT_EQUAL_UINT(0, lengthAndTransferEncoding.bodyBytesConsumed());
}

void test_missing_and_overflowing_content_length_are_rejected() {
  BoundedCaptiveHttpParser missingLength;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Invalid),
      static_cast<int>(feed(missingLength,
                            "POST /save HTTP/1.1\r\n"
                            "Host: 192.168.4.1\r\n\r\n")));

  BoundedCaptiveHttpParser overflowingLength;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Invalid),
      static_cast<int>(feed(overflowingLength,
                            "POST /save HTTP/1.1\r\n"
                            "Content-Length: "
                            "999999999999999999999999999999999999\r\n\r\n")));
  TEST_ASSERT_EQUAL_UINT(0, overflowingLength.bodyBytesConsumed());
}

void test_malformed_header_and_oversized_target_are_rejected() {
  BoundedCaptiveHttpParser malformedHeader;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Invalid),
      static_cast<int>(feed(malformedHeader,
                            "GET / HTTP/1.1\r\n"
                            "Header without colon\r\n\r\n")));

  BoundedCaptiveHttpParser oversizedTarget;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Invalid),
      static_cast<int>(feed(
          oversizedTarget,
          "GET /" + std::string(kMaxProvisioningRequestTargetBytes, 'a') +
              " HTTP/1.1\r\nHost: 192.168.4.1\r\n\r\n")));
}

void test_valid_post_preserves_security_headers_and_body() {
  BoundedCaptiveHttpParser parser;
  const std::string body = "csrf=abc&ssid=office";

  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Complete),
      static_cast<int>(feed(parser, postHeaders(body.size()) + body)));
  TEST_ASSERT_EQUAL_STRING("POST", parser.request().method.c_str());
  TEST_ASSERT_EQUAL_STRING("/save", parser.request().target.c_str());
  TEST_ASSERT_EQUAL_STRING("192.168.4.1", parser.request().host.c_str());
  TEST_ASSERT_EQUAL_STRING("http://192.168.4.1",
                           parser.request().origin.c_str());
  TEST_ASSERT_EQUAL_STRING("application/x-www-form-urlencoded",
                           parser.request().contentType.c_str());
  TEST_ASSERT_EQUAL_STRING(body.c_str(), parser.request().body.c_str());
}

void test_form_decoder_accepts_exact_fields_and_utf8_percent_encoding() {
  ProvisioningFormFields fields;
  TEST_ASSERT_TRUE(decodeProvisioningForm(
      "csrf=abc123&ssid=Red+Espa%C3%B1a&wifi_password=clave%21&"
      "base_url=https%3A%2F%2Fjornada.example.com&"
      "terminal_token=ojterm_token",
      fields));
  TEST_ASSERT_EQUAL_STRING("abc123", fields.csrf.c_str());
  TEST_ASSERT_EQUAL_STRING("Red España", fields.ssid.c_str());
  TEST_ASSERT_EQUAL_STRING("clave!", fields.wifiPassword.c_str());
  TEST_ASSERT_EQUAL_STRING("https://jornada.example.com",
                           fields.baseUrl.c_str());
  TEST_ASSERT_EQUAL_STRING("ojterm_token", fields.terminalToken.c_str());
}

void test_form_decoder_rejects_unknown_duplicate_and_invalid_fields() {
  ProvisioningFormFields fields;
  const std::string valid =
      "csrf=a&ssid=b&wifi_password=c&base_url=d&terminal_token=e";
  TEST_ASSERT_FALSE(decodeProvisioningForm(valid + "&extra=f", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(valid + "&ssid=again", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=%GG&ssid=b&wifi_password=c&base_url=d&terminal_token=e", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&ssid=" + std::string(kMaxSsidBytes + 1U, 's') +
          "&wifi_password=c&base_url=d&terminal_token=e",
      fields));
}

void test_form_request_policy_checks_host_origin_content_type_and_csrf() {
  ProvisioningFormFields fields;
  CaptiveHttpRequest request = validFormRequest();
  TEST_ASSERT_TRUE(
      decodeProvisioningFormRequest(request, "expected", fields));

  request.host = "attacker.example";
  TEST_ASSERT_FALSE(
      decodeProvisioningFormRequest(request, "expected", fields));
  request = validFormRequest();
  request.origin = "http://attacker.example";
  TEST_ASSERT_FALSE(
      decodeProvisioningFormRequest(request, "expected", fields));
  request = validFormRequest();
  request.contentType = "text/plain";
  TEST_ASSERT_FALSE(
      decodeProvisioningFormRequest(request, "expected", fields));
  request = validFormRequest();
  TEST_ASSERT_FALSE(
      decodeProvisioningFormRequest(request, "different", fields));
}

void test_form_request_policy_allows_known_host_and_missing_origin() {
  ProvisioningFormFields fields;
  CaptiveHttpRequest request = validFormRequest();
  request.host = "openjornada.local:80";
  request.origin.clear();
  request.contentType =
      "Application/X-WWW-Form-Urlencoded; Charset=UTF-8";

  TEST_ASSERT_TRUE(
      decodeProvisioningFormRequest(request, "expected", fields));
  TEST_ASSERT_EQUAL_STRING("office", fields.ssid.c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_oversized_content_length_is_rejected_before_body_consumption);
  RUN_TEST(test_body_at_limit_is_read_with_bounded_storage);
  RUN_TEST(test_header_limit_and_transfer_encoding_are_rejected);
  RUN_TEST(test_ambiguous_content_length_and_transfer_encoding_are_rejected);
  RUN_TEST(test_missing_and_overflowing_content_length_are_rejected);
  RUN_TEST(test_malformed_header_and_oversized_target_are_rejected);
  RUN_TEST(test_valid_post_preserves_security_headers_and_body);
  RUN_TEST(test_form_decoder_accepts_exact_fields_and_utf8_percent_encoding);
  RUN_TEST(test_form_decoder_rejects_unknown_duplicate_and_invalid_fields);
  RUN_TEST(test_form_request_policy_checks_host_origin_content_type_and_csrf);
  RUN_TEST(test_form_request_policy_allows_known_host_and_missing_origin);
  return UNITY_END();
}
