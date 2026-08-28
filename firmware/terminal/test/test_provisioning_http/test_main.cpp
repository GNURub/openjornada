#include <unity.h>

#include <cstdint>
#include <string>
#include <string_view>

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
                 "wifi_password_explicit=0&"
                 "base_url=https%3A%2F%2Fjornada.example.com&"
                 "terminal_token=ojterm_token";
  return request;
}

std::string base64Url(std::string_view input) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string output;
  for (size_t cursor = 0; cursor < input.size();) {
    const uint32_t first = static_cast<uint8_t>(input[cursor++]);
    const bool hasSecond = cursor < input.size();
    const uint32_t second = hasSecond ? static_cast<uint8_t>(input[cursor++]) : 0;
    const bool hasThird = cursor < input.size();
    const uint32_t third = hasThird ? static_cast<uint8_t>(input[cursor++]) : 0;
    const uint32_t bits = (first << 16U) | (second << 8U) | third;
    output.push_back(alphabet[(bits >> 18U) & 0x3fU]);
    output.push_back(alphabet[(bits >> 12U) & 0x3fU]);
    if (hasSecond) output.push_back(alphabet[(bits >> 6U) & 0x3fU]);
    if (hasThird) output.push_back(alphabet[bits & 0x3fU]);
  }
  return output;
}

UsbControlRequest validUsbProvisionRequest() {
  UsbControlRequest request;
  request.id = "AZaztV6Dql5aZQHCF4yzEA";
  request.command = UsbCommand::Provision;
  request.ojp = base64Url(
      R"({"v":1,"s":"office","p":"password","u":"https://jornada.example.com","t":"ojterm_token"})");
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

void test_mobile_sized_headers_are_accepted_within_the_bound() {
  BoundedCaptiveHttpParser parser;
  const std::string request =
      "GET / HTTP/1.1\r\n"
      "Host: 192.168.4.1\r\n"
      "User-Agent: " +
      std::string(1400, 'm') +
      "\r\nAccept: text/html,application/xhtml+xml\r\n\r\n";

  TEST_ASSERT_TRUE(request.size() > 1024U);
  TEST_ASSERT_TRUE(request.size() < kMaxProvisioningHeaderBytes);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(CaptiveHttpParseStatus::Complete),
      static_cast<int>(feed(parser, request)));
  TEST_ASSERT_EQUAL_STRING("/", parser.request().target.c_str());
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
      "wifi_password_explicit=1&"
      "base_url=https%3A%2F%2Fjornada.example.com&"
      "terminal_token=ojterm_token",
      fields));
  TEST_ASSERT_EQUAL_STRING("abc123", fields.csrf.c_str());
  TEST_ASSERT_EQUAL_STRING("Red España", fields.ssid.c_str());
  TEST_ASSERT_EQUAL_STRING("clave!", fields.wifiPassword.c_str());
  TEST_ASSERT_TRUE(fields.wifiPasswordExplicit);
  TEST_ASSERT_EQUAL_STRING("https://jornada.example.com",
                           fields.baseUrl.c_str());
  TEST_ASSERT_EQUAL_STRING("ojterm_token", fields.terminalToken.c_str());

  TEST_ASSERT_TRUE(decodeProvisioningForm(
      "csrf=abc123&ssid=Red&wifi_password=&wifi_password_explicit=0&"
      "base_url=https%3A%2F%2Fjornada.example.com&"
      "terminal_token=ojterm_token",
      fields));
  TEST_ASSERT_FALSE(fields.wifiPasswordExplicit);

  TEST_ASSERT_TRUE(decodeProvisioningForm(
      "csrf=abc123&ssid=Red&wifi_password=&"
      "base_url=https%3A%2F%2Fjornada.example.com&"
      "terminal_token=ojterm_token",
      fields));
  TEST_ASSERT_FALSE(fields.wifiPasswordExplicit);
}

void test_form_decoder_rejects_unknown_duplicate_and_invalid_fields() {
  ProvisioningFormFields fields;
  const std::string valid =
      "csrf=a&ssid=b&wifi_password=c&wifi_password_explicit=0&"
      "base_url=d&terminal_token=e";
  TEST_ASSERT_FALSE(decodeProvisioningForm(valid + "&extra=f", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(valid + "&ssid=again", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "ssid=b&wifi_password=c&base_url=d&terminal_token=e", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&wifi_password=c&base_url=d&terminal_token=e", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&ssid=b&base_url=d&terminal_token=e", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&ssid=b&wifi_password=c&terminal_token=e", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&ssid=b&wifi_password=c&base_url=d", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      valid + "&wifi_password_explicit=1", fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&ssid=b&wifi_password=c&wifi_password_explicit=2&"
      "base_url=d&terminal_token=e",
      fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&ssid=b&wifi_password=c&wifi_password_explicit=&"
      "base_url=d&terminal_token=e",
      fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=%GG&ssid=b&wifi_password=c&wifi_password_explicit=0&"
      "base_url=d&terminal_token=e",
      fields));
  TEST_ASSERT_FALSE(decodeProvisioningForm(
      "csrf=a&ssid=" + std::string(kMaxSsidBytes + 1U, 's') +
          "&wifi_password=c&wifi_password_explicit=0&base_url=d&"
          "terminal_token=e",
      fields));
}

void test_secret_fallback_distinguishes_manual_empty_from_open_wifi_qr() {
  DeviceConfig active;
  active.ssid = "office";
  active.wifiPassword = "stored-password";
  active.baseUrl = "https://jornada.example.com";
  active.terminalToken = "ojterm_stored";

  DeviceConfig manualCandidate;
  manualCandidate.ssid = "office";
  manualCandidate.baseUrl = "https://jornada.example.com";
  applyProvisioningSecretFallbacks(active, false, manualCandidate);
  TEST_ASSERT_EQUAL_STRING("stored-password",
                           manualCandidate.wifiPassword.c_str());
  TEST_ASSERT_EQUAL_STRING("ojterm_stored",
                           manualCandidate.terminalToken.c_str());

  DeviceConfig qrCandidate;
  qrCandidate.ssid = "office";
  qrCandidate.baseUrl = "https://jornada.example.com";
  applyProvisioningSecretFallbacks(active, true, qrCandidate);
  TEST_ASSERT_TRUE(qrCandidate.wifiPassword.empty());
  TEST_ASSERT_EQUAL_STRING("ojterm_stored", qrCandidate.terminalToken.c_str());

  DeviceConfig changedNetworkCandidate;
  changedNetworkCandidate.ssid = "other-office";
  applyProvisioningSecretFallbacks(active, false, changedNetworkCandidate);
  TEST_ASSERT_TRUE(changedNetworkCandidate.wifiPassword.empty());
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

void test_provisioning_script_route_only_accepts_exact_get() {
  CaptiveHttpRequest request;
  request.method = "GET";
  request.target = "/provisioning.js";
  TEST_ASSERT_TRUE(isProvisioningScriptRequest(request));
  request.method = "POST";
  TEST_ASSERT_FALSE(isProvisioningScriptRequest(request));
  request.method = "GET";
  request.target = "/provisioning.js?x=1";
  TEST_ASSERT_FALSE(isProvisioningScriptRequest(request));
}

void test_portal_routes_brave_probes_without_redirect_loops() {
  CaptiveHttpRequest request;
  request.method = "GET";

  request.target = "/";
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningHttpRoute::Index),
                        static_cast<int>(provisioningHttpRoute(request)));
  request.target = "/provisioning.js";
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningHttpRoute::Script),
                        static_cast<int>(provisioningHttpRoute(request)));
  request.target = "/status";
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningHttpRoute::Status),
                        static_cast<int>(provisioningHttpRoute(request)));
  request.target = "/favicon.ico";
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningHttpRoute::NoContent),
                        static_cast<int>(provisioningHttpRoute(request)));

  for (const char* target : {"/generate_204", "/gen_204", "/connecttest.txt",
                             "/hotspot-detect.html", "/ncsi.txt"}) {
    request.target = target;
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(ProvisioningHttpRoute::CaptiveProbe),
        static_cast<int>(provisioningHttpRoute(request)));
  }

  request.target = "/unknown";
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningHttpRoute::Redirect),
                        static_cast<int>(provisioningHttpRoute(request)));
  request.method = "POST";
  request.target = "/save";
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningHttpRoute::Save),
                        static_cast<int>(provisioningHttpRoute(request)));
}

void test_request_wait_uses_short_idle_and_bounded_total_timeouts() {
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningRequestTimeout::None),
      static_cast<int>(provisioningRequestTimeout(1000, 1100, 1300)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningRequestTimeout::Idle),
      static_cast<int>(provisioningRequestTimeout(
          1000, 1100, 1100 + kProvisioningRequestIdleTimeoutMs)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningRequestTimeout::Total),
      static_cast<int>(provisioningRequestTimeout(
          1000, 1000 + kProvisioningRequestTotalTimeoutMs - 1U,
          1000 + kProvisioningRequestTotalTimeoutMs)));

  const uint32_t nearWrap = UINT32_MAX - 20U;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningRequestTimeout::Idle),
      static_cast<int>(provisioningRequestTimeout(
          nearWrap, nearWrap, nearWrap + kProvisioningRequestIdleTimeoutMs)));
}

void test_provisioning_attempt_rejects_duplicates_and_tracks_result() {
  ProvisioningAttemptState attempt;
  DeviceConfig candidate;
  candidate.ssid = "office";
  candidate.baseUrl = "https://jornada.example.com";
  candidate.terminalToken = "ojterm_example";

  TEST_ASSERT_TRUE(attempt.canSubmit());
  TEST_ASSERT_TRUE(attempt.begin(candidate, 1000));
  TEST_ASSERT_FALSE(attempt.canSubmit());
  TEST_ASSERT_TRUE(attempt.busy());
  TEST_ASSERT_FALSE(attempt.begin(candidate, 1001));
  TEST_ASSERT_FALSE(attempt.connectionTimedOut(
      1000 + kProvisioningConnectTimeoutMs - 1U));
  TEST_ASSERT_TRUE(
      attempt.connectionTimedOut(1000 + kProvisioningConnectTimeoutMs));
  TEST_ASSERT_TRUE(attempt.markValidating());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningCheckPhase::Validating),
                        static_cast<int>(attempt.phase()));

  attempt.fail("No se pudo comprobar OpenJornada.");
  TEST_ASSERT_FALSE(attempt.busy());
  TEST_ASSERT_TRUE(attempt.canSubmit());
  TEST_ASSERT_EQUAL_STRING("No se pudo comprobar OpenJornada.",
                           attempt.error().c_str());

  TEST_ASSERT_TRUE(attempt.begin(candidate, 2000));
  TEST_ASSERT_TRUE(attempt.markValidating());
  TEST_ASSERT_FALSE(attempt.markSuccessResponseServed(2999));
  attempt.succeed(3000);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(ProvisioningCheckPhase::Succeeded),
                        static_cast<int>(attempt.phase()));
  TEST_ASSERT_FALSE(attempt.canSubmit());
  TEST_ASSERT_FALSE(attempt.cancellationAllowed());
  TEST_ASSERT_EQUAL_UINT32(3000, attempt.completedAtMs());
}

void test_pending_actions_only_allow_the_existing_terminal_token() {
  DeviceConfig active;
  active.terminalToken = "ojterm_existing";
  DeviceConfig unchanged = active;
  DeviceConfig changed = active;
  changed.terminalToken = "ojterm_changed";

  TEST_ASSERT_TRUE(canApplyProvisioningCandidate(active, unchanged, 1));
  TEST_ASSERT_FALSE(canApplyProvisioningCandidate(active, changed, 1));
  TEST_ASSERT_FALSE(
      canApplyProvisioningCandidate(std::nullopt, changed, 1));
  TEST_ASSERT_TRUE(canApplyProvisioningCandidate(active, changed, 0));
}

void test_http_and_usb_submissions_share_one_busy_attempt() {
  DeviceConfig browserCandidate;
  browserCandidate.ssid = "browser-network";
  browserCandidate.baseUrl = "https://jornada.example.com";
  browserCandidate.terminalToken = "ojterm_token";

  ProvisioningAttemptState httpFirst;
  TEST_ASSERT_TRUE(httpFirst.begin(browserCandidate, 1000));
  ProvisioningSerialAdapter serial(
      BuildProfile::Release, std::nullopt, 0,
      ProvisioningSerialMode::Portal);
  TEST_ASSERT_EQUAL(
      UsbProvisionDecision::Busy,
      serial.accept(validUsbProvisionRequest(), httpFirst, 1001).decision);

  ProvisioningAttemptState usbFirst;
  TEST_ASSERT_EQUAL(
      UsbProvisionDecision::Started,
      serial.accept(validUsbProvisionRequest(), usbFirst, 2000).decision);
  TEST_ASSERT_FALSE(usbFirst.begin(browserCandidate, 2001));
}

void test_provisioning_success_grace_starts_after_status_response() {
  ProvisioningAttemptState attempt;
  DeviceConfig candidate;
  TEST_ASSERT_TRUE(attempt.begin(candidate, 100));
  TEST_ASSERT_TRUE(attempt.markValidating());
  attempt.succeed(1000);

  TEST_ASSERT_FALSE(attempt.successWindowElapsed(
      1000 + kProvisioningSuccessResponseGraceMs));
  TEST_ASSERT_TRUE(attempt.markSuccessResponseServed(5000));
  TEST_ASSERT_TRUE(attempt.markSuccessResponseServed(6000));
  TEST_ASSERT_FALSE(attempt.successWindowElapsed(
      5000 + kProvisioningSuccessResponseGraceMs - 1U));
  TEST_ASSERT_TRUE(attempt.successWindowElapsed(
      5000 + kProvisioningSuccessResponseGraceMs));

  ProvisioningAttemptState withoutResponse;
  TEST_ASSERT_TRUE(withoutResponse.begin(candidate, UINT32_MAX - 500U));
  TEST_ASSERT_TRUE(withoutResponse.markValidating());
  withoutResponse.succeed(UINT32_MAX - 100U);
  TEST_ASSERT_FALSE(withoutResponse.successWindowElapsed(
      UINT32_MAX - 100U + kProvisioningSuccessHardStopMs - 1U));
  TEST_ASSERT_TRUE(withoutResponse.successWindowElapsed(
      UINT32_MAX - 100U + kProvisioningSuccessHardStopMs));
}

void test_provisioning_csp_allows_only_the_local_script() {
  TEST_ASSERT_EQUAL_STRING(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; "
      "connect-src 'self'; "
      "form-action http://192.168.4.1; base-uri 'none'; "
      "frame-ancestors 'none'",
      kProvisioningContentSecurityPolicy);
}

void test_provisioning_asset_writer_retries_partial_writes_without_gaps() {
  const std::string source = "provisioning-asset";
  std::string written;
  size_t calls = 0;
  const bool complete = writeAllProvisioningBytes(
      reinterpret_cast<const uint8_t*>(source.data()), source.size(),
      [&](const uint8_t* data, size_t remaining) {
        ++calls;
        const size_t chunk = remaining < 3U ? remaining : 3U;
        written.append(reinterpret_cast<const char*>(data), chunk);
        return chunk;
      });

  TEST_ASSERT_TRUE(complete);
  TEST_ASSERT_GREATER_THAN_UINT(1, calls);
  TEST_ASSERT_EQUAL_STRING(source.c_str(), written.c_str());
}

void test_provisioning_asset_writer_stops_on_zero_or_invalid_progress() {
  const uint8_t source[]{1, 2, 3};
  size_t zeroCalls = 0;
  TEST_ASSERT_FALSE(writeAllProvisioningBytes(
      source, sizeof(source), [&](const uint8_t*, size_t remaining) {
        ++zeroCalls;
        return zeroCalls == 1 ? remaining - 1U : 0U;
      }));
  TEST_ASSERT_EQUAL_UINT(2, zeroCalls);

  TEST_ASSERT_FALSE(writeAllProvisioningBytes(
      source, sizeof(source),
      [](const uint8_t*, size_t remaining) { return remaining + 1U; }));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_oversized_content_length_is_rejected_before_body_consumption);
  RUN_TEST(test_body_at_limit_is_read_with_bounded_storage);
  RUN_TEST(test_header_limit_and_transfer_encoding_are_rejected);
  RUN_TEST(test_mobile_sized_headers_are_accepted_within_the_bound);
  RUN_TEST(test_ambiguous_content_length_and_transfer_encoding_are_rejected);
  RUN_TEST(test_missing_and_overflowing_content_length_are_rejected);
  RUN_TEST(test_malformed_header_and_oversized_target_are_rejected);
  RUN_TEST(test_valid_post_preserves_security_headers_and_body);
  RUN_TEST(test_form_decoder_accepts_exact_fields_and_utf8_percent_encoding);
  RUN_TEST(test_form_decoder_rejects_unknown_duplicate_and_invalid_fields);
  RUN_TEST(test_secret_fallback_distinguishes_manual_empty_from_open_wifi_qr);
  RUN_TEST(test_form_request_policy_checks_host_origin_content_type_and_csrf);
  RUN_TEST(test_form_request_policy_allows_known_host_and_missing_origin);
  RUN_TEST(test_provisioning_script_route_only_accepts_exact_get);
  RUN_TEST(test_portal_routes_brave_probes_without_redirect_loops);
  RUN_TEST(test_request_wait_uses_short_idle_and_bounded_total_timeouts);
  RUN_TEST(test_provisioning_attempt_rejects_duplicates_and_tracks_result);
  RUN_TEST(test_pending_actions_only_allow_the_existing_terminal_token);
  RUN_TEST(test_http_and_usb_submissions_share_one_busy_attempt);
  RUN_TEST(test_provisioning_success_grace_starts_after_status_response);
  RUN_TEST(test_provisioning_csp_allows_only_the_local_script);
  RUN_TEST(test_provisioning_asset_writer_retries_partial_writes_without_gaps);
  RUN_TEST(test_provisioning_asset_writer_stops_on_zero_or_invalid_progress);
  return UNITY_END();
}
