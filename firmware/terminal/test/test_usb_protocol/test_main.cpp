#include <unity.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "openjornada/firmware_metadata.hpp"
#include "openjornada/ojp.hpp"
#include "openjornada/provisioning.hpp"
#include "openjornada/usb_protocol.hpp"

using namespace openjornada;

namespace {

constexpr std::string_view kCanonicalOjp =
    R"({"v":1,"s":"Red Demo","p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"})";

std::string base64Url(std::string_view input) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string output;
  output.reserve((input.size() * 4U + 2U) / 3U);
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

std::string encoded(std::string_view json) { return base64Url(json); }

std::string ojpJson(std::string_view ssid, std::string_view password,
                    std::string_view url, std::string_view token) {
  return "{\"v\":1,\"s\":\"" + std::string(ssid) + "\",\"p\":\"" +
         std::string(password) + "\",\"u\":\"" + std::string(url) +
         "\",\"t\":\"" + std::string(token) + "\"}";
}

std::vector<std::string> validOjpForms() {
  const std::string payload = encoded(kCanonicalOjp);
  return {"http://192.168.4.1/#ojp=" + payload, "#ojp=" + payload,
          "ojp=" + payload, payload};
}

std::string metadataImage(std::string_view json, size_t prefixBytes = 5) {
  return std::string(prefixBytes, '\x7f') +
         std::string(kFirmwareMetadataPrefix) + std::string(json) + '\0' +
         std::string(7, '\x55');
}

std::optional<FirmwareBuildMetadata> parseMetadata(const std::string& image) {
  return parseFirmwareBuildMetadata(
      reinterpret_cast<const uint8_t*>(image.data()), image.size());
}

constexpr std::string_view kRequestId = "AZaztV6Dql5aZQHCF4yzEA";

void feed(UsbControlParser& parser, std::string_view bytes) {
  for (const char byte : bytes) parser.consume(byte);
}

class FakeProvisioningSerialTransport final
    : public ProvisioningSerialTransport {
 public:
  void append(std::string_view bytes) { input_.append(bytes); }
  int available() override {
    return cursor_ < input_.size() ? static_cast<int>(input_.size() - cursor_)
                                   : 0;
  }
  int read() override {
    if (cursor_ >= input_.size()) return -1;
    return static_cast<uint8_t>(input_[cursor_++]);
  }
  size_t write(const uint8_t* data, size_t size) override {
    output_.append(reinterpret_cast<const char*>(data), size);
    return size;
  }
  const std::string& output() const { return output_; }

 private:
  std::string input_;
  size_t cursor_ = 0;
  std::string output_;
};

std::string controlLine(std::string_view command,
                        std::string_view payload = "{}") {
  return "OJUSB/1 {\"v\":1,\"id\":\"" + std::string(kRequestId) +
         "\",\"command\":\"" + std::string(command) +
         "\",\"payload\":" + std::string(payload) + "}\n";
}

UsbControlRequest validProvisionRequest() {
  UsbControlRequest request;
  request.id = kRequestId;
  request.command = UsbCommand::Provision;
  request.ojp = encoded(kCanonicalOjp);
  return request;
}

uint32_t testCrc32(const uint8_t* data, size_t size) {
  uint32_t crc = 0xffffffffU;
  for (size_t index = 0; index < size; ++index) {
    crc ^= data[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1U) ^ (0xedb88320U &
                           (0U - static_cast<uint32_t>(crc & 1U)));
    }
  }
  return crc ^ 0xffffffffU;
}

void appendLittleEndian(std::vector<uint8_t>& output, uint32_t value,
                        size_t bytes) {
  for (size_t index = 0; index < bytes; ++index) {
    output.push_back(static_cast<uint8_t>(value >> (index * 8U)));
  }
}

std::vector<uint8_t> firmwareFrame(uint32_t offset,
                                   std::vector<uint8_t> payload) {
  std::vector<uint8_t> output{'O', 'J', 'F', 'W'};
  appendLittleEndian(output, offset, 4);
  appendLittleEndian(output, static_cast<uint32_t>(payload.size()), 2);
  appendLittleEndian(output, testCrc32(payload.data(), payload.size()), 4);
  output.insert(output.end(), payload.begin(), payload.end());
  return output;
}

}  // namespace

void test_control_parser_accepts_fragmented_exact_request() {
  UsbControlParser parser;
  feed(parser,
       "OJUSB/1 {\"v\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"command\":");
  TEST_ASSERT_EQUAL(UsbParseStatus::NeedMore, parser.status());
  feed(parser, "\"status\",\"payload\":{}}\r\n");
  TEST_ASSERT_EQUAL(UsbParseStatus::Complete, parser.status());
  TEST_ASSERT_EQUAL(UsbCommand::Status, parser.request().command);
  TEST_ASSERT_EQUAL_STRING(kRequestId.data(), parser.request().id.c_str());

  UsbControlParser reordered;
  feed(reordered,
       "OJUSB/1 { \"payload\" : {}, \"command\" : \"status\","
       "\"id\" : \"AZaztV6Dql5aZQHCF4yzEA\", \"v\" : 1 }\n");
  TEST_ASSERT_EQUAL(UsbParseStatus::Complete, reordered.status());
  TEST_ASSERT_EQUAL(UsbCommand::Status, reordered.request().command);
}

void test_control_parser_accepts_exact_command_payload_shapes() {
  const std::vector<std::pair<std::string_view, UsbCommand>> emptyPayload = {
      {"hello", UsbCommand::Hello},
      {"status", UsbCommand::Status},
      {"doctor", UsbCommand::Doctor},
      {"logs_subscribe", UsbCommand::LogsSubscribe},
      {"reboot", UsbCommand::Reboot},
      {"factory_reset", UsbCommand::FactoryReset},
      {"firmware_commit", UsbCommand::FirmwareCommit},
      {"cancel", UsbCommand::Cancel},
  };
  for (const auto& entry : emptyPayload) {
    UsbControlParser parser;
    feed(parser, controlLine(entry.first));
    TEST_ASSERT_EQUAL(UsbParseStatus::Complete, parser.status());
    TEST_ASSERT_EQUAL(entry.second, parser.request().command);
  }

  UsbControlParser provision;
  feed(provision, controlLine("provision", R"({"ojp":"ojp=YWJj"})"));
  TEST_ASSERT_EQUAL(UsbParseStatus::Complete, provision.status());
  TEST_ASSERT_EQUAL(UsbCommand::Provision, provision.request().command);
  TEST_ASSERT_EQUAL_STRING("ojp=YWJj", provision.request().ojp.c_str());

  UsbControlParser firmware;
  feed(firmware,
       controlLine("firmware_begin",
                   R"({"size":4096,"sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","version":"1.2.3","board":"m5stack-basic-core-v27","protocolVersion":1,"official":false})"));
  TEST_ASSERT_EQUAL(UsbParseStatus::Complete, firmware.status());
  TEST_ASSERT_EQUAL(UsbCommand::FirmwareBegin, firmware.request().command);
  TEST_ASSERT_EQUAL_UINT32(4096, firmware.request().firmware.size);
  TEST_ASSERT_EQUAL_STRING("1.2.3",
                           firmware.request().firmware.metadata.firmwareVersion.c_str());
  TEST_ASSERT_FALSE(firmware.request().firmware.official);
}

void test_control_parser_rejects_nul_malformed_utf8_and_invalid_ids() {
  UsbControlParser nul;
  feed(nul, "OJUSB/1 {");
  nul.consume('\0');
  TEST_ASSERT_EQUAL(UsbParseStatus::Error, nul.status());
  TEST_ASSERT_EQUAL(UsbControlError::NulByte, nul.error());
  feed(nul, "ignored\n");
  TEST_ASSERT_EQUAL(UsbControlError::NulByte, nul.error());

  UsbControlParser utf8;
  std::string malformed = controlLine("status");
  malformed.insert(malformed.find("status"), 1, static_cast<char>(0xc3));
  feed(utf8, malformed);
  TEST_ASSERT_EQUAL(UsbParseStatus::Error, utf8.status());
  TEST_ASSERT_EQUAL(UsbControlError::InvalidUtf8, utf8.error());

  const std::vector<std::string> invalidIds = {
      "short", "AZaztV6Dql5aZQHCF4yzE=", "AZaztV6Dql5aZQHCF4yzE!",
      "AZaztV6Dql5aZQHCF4yzEB"};
  for (const auto& id : invalidIds) {
    UsbControlParser parser;
    std::string line = controlLine("status");
    line.replace(line.find(kRequestId), kRequestId.size(), id);
    feed(parser, line);
    TEST_ASSERT_EQUAL(UsbParseStatus::Error, parser.status());
    TEST_ASSERT_EQUAL(UsbControlError::InvalidId, parser.error());
  }
}

void test_control_parser_rejects_unknown_duplicate_and_wrong_payload_fields() {
  const std::vector<std::string> invalid = {
      "OJUSB/1 {\"v\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"command\":\"status\",\"payload\":{},\"extra\":true}\n",
      "OJUSB/1 {\"v\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"command\":\"status\",\"payload\":{}}\n",
      "OJUSB/1 {\"v\":1,\"\\u0076\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"command\":\"status\",\"payload\":{}}\n",
      "OJUSB/1 {\"v\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"command\":\"status\",\"payload\":{\"x\":1}}\n",
      "OJUSB/1 {\"v\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"command\":\"provision\",\"payload\":{\"ojp\":\"a\",\"ojp\":\"b\"}}\n",
      "OJUSB/1 {\"v\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"command\":\"unknown\",\"payload\":{}}\n"};
  for (const auto& line : invalid) {
    UsbControlParser parser;
    feed(parser, line);
    TEST_ASSERT_EQUAL(UsbParseStatus::Error, parser.status());
    TEST_ASSERT_EQUAL(UsbControlError::InvalidContract, parser.error());
  }
}

void test_control_parser_is_bounded_and_requires_explicit_reset() {
  UsbControlParser oversized;
  feed(oversized, std::string(kUsbControlMaxBytes, 'x'));
  TEST_ASSERT_EQUAL(UsbParseStatus::NeedMore, oversized.status());
  oversized.consume('x');
  TEST_ASSERT_EQUAL(UsbParseStatus::Error, oversized.status());
  TEST_ASSERT_EQUAL(UsbControlError::TooLarge, oversized.error());

  UsbControlParser parser;
  feed(parser, controlLine("hello"));
  TEST_ASSERT_EQUAL(UsbParseStatus::Complete, parser.status());
  feed(parser, controlLine("status"));
  TEST_ASSERT_EQUAL(UsbParseStatus::Error, parser.status());
  TEST_ASSERT_EQUAL(UsbControlError::ResetRequired, parser.error());
  parser.reset();
  feed(parser, controlLine("status"));
  TEST_ASSERT_EQUAL(UsbParseStatus::Complete, parser.status());
  TEST_ASSERT_EQUAL(UsbCommand::Status, parser.request().command);
}

void test_control_response_has_stable_order_and_json_escaping() {
  ArduinoJson::JsonDocument data;
  data["pendingCount"] = 3;
  const std::string encoded = encodeUsbResponse(
      kRequestId, "result", "ok", "Línea \"lista\"\n", data.as<ArduinoJson::JsonVariantConst>());
  TEST_ASSERT_EQUAL_STRING(
      "OJUSB/1 {\"v\":1,\"id\":\"AZaztV6Dql5aZQHCF4yzEA\",\"type\":\"result\",\"code\":\"ok\",\"message\":\"Línea \\\"lista\\\"\\n\",\"data\":{\"pendingCount\":3}}\n",
      encoded.c_str());

  std::string emptyMessage;
  TEST_ASSERT_TRUE(
      encodeUsbResponse(kRequestId, "result", "ok", "", emptyMessage));
  const std::string boundaryMessage(kUsbControlMaxBytes - emptyMessage.size(),
                                    'a');
  std::string boundary;
  TEST_ASSERT_TRUE(encodeUsbResponse(kRequestId, "result", "ok",
                                     boundaryMessage, boundary));
  TEST_ASSERT_EQUAL_UINT32(kUsbControlMaxBytes, boundary.size());
  TEST_ASSERT_FALSE(encodeUsbResponse(
      kRequestId, "result", "ok", boundaryMessage + "a", boundary));
  TEST_ASSERT_TRUE(boundary.empty());
}

void test_firmware_frame_accepts_one_byte_fragmentation_and_partial_payload() {
  const auto bytes = firmwareFrame(0, {1, 2, 3, 4, 5});
  UsbFirmwareFrameParser parser;
  for (size_t index = 0; index < bytes.size() - 1U; ++index) {
    parser.consume(&bytes[index], 1);
    TEST_ASSERT_EQUAL(UsbFrameParseStatus::NeedMore, parser.status());
    const size_t expected = index + 1U < kUsbFirmwareHeaderBytes
                                ? kUsbFirmwareHeaderBytes - index - 1U
                                : bytes.size() - index - 1U;
    TEST_ASSERT_EQUAL_UINT32(expected, parser.expectedBytes());
  }
  parser.consume(&bytes.back(), 1);
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::Complete, parser.status());
  TEST_ASSERT_EQUAL_UINT32(0, parser.frame().offset);
  TEST_ASSERT_EQUAL_UINT32(5, parser.frame().payload.size());
  TEST_ASSERT_EQUAL_UINT8_ARRAY((std::vector<uint8_t>{1, 2, 3, 4, 5}).data(),
                                parser.frame().payload.data(), 5);
}

void test_firmware_frame_accepts_two_frames_in_one_buffer() {
  auto bytes = firmwareFrame(0, {1, 2, 3});
  const auto second = firmwareFrame(3, {4, 5});
  bytes.insert(bytes.end(), second.begin(), second.end());
  UsbFirmwareFrameParser parser;
  const auto firstResult = parser.consume(bytes.data(), bytes.size());
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::Complete, parser.status());
  TEST_ASSERT_EQUAL_UINT32(firmwareFrame(0, {1, 2, 3}).size(),
                           firstResult.consumed);
  TEST_ASSERT_EQUAL_UINT32(1, parser.frameCount());
  TEST_ASSERT_EQUAL_UINT32(0, parser.frame().offset);
  const auto blocked = parser.consume(bytes.data() + firstResult.consumed,
                                      bytes.size() - firstResult.consumed);
  TEST_ASSERT_EQUAL_UINT32(0, blocked.consumed);
  TEST_ASSERT_EQUAL_UINT32(0, parser.expectedBytes());
  parser.popFrame();
  const auto secondResult = parser.consume(
      bytes.data() + firstResult.consumed, bytes.size() - firstResult.consumed);
  TEST_ASSERT_EQUAL_UINT32(second.size(), secondResult.consumed);
  TEST_ASSERT_EQUAL_UINT32(3, parser.frame().offset);
  TEST_ASSERT_EQUAL_UINT32(2, parser.frame().payload.size());
  parser.popFrame();
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::NeedMore, parser.status());
  TEST_ASSERT_EQUAL_UINT32(kUsbFirmwareHeaderBytes, parser.expectedBytes());
}

void test_firmware_frame_backpressure_preserves_many_concatenated_frames() {
  constexpr size_t kFrameCount = 32;
  std::vector<uint8_t> bytes;
  for (size_t index = 0; index < kFrameCount; ++index) {
    const auto next = firmwareFrame(static_cast<uint32_t>(index),
                                    {static_cast<uint8_t>(index)});
    bytes.insert(bytes.end(), next.begin(), next.end());
  }

  UsbFirmwareFrameParser parser;
  size_t cursor = 0;
  for (size_t index = 0; index < kFrameCount; ++index) {
    const auto result = parser.consume(bytes.data() + cursor,
                                       bytes.size() - cursor);
    TEST_ASSERT_EQUAL(UsbFrameParseStatus::Complete, result.status);
    TEST_ASSERT_EQUAL_UINT32(kUsbFirmwareHeaderBytes + 1U, result.consumed);
    TEST_ASSERT_EQUAL_UINT32(1, parser.frameCount());
    TEST_ASSERT_EQUAL_UINT32(index, parser.frame().offset);
    TEST_ASSERT_EQUAL_UINT8(index, parser.frame().payload.front());
    cursor += result.consumed;
    parser.popFrame();
  }
  TEST_ASSERT_EQUAL_UINT32(bytes.size(), cursor);
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::NeedMore, parser.status());
}

void test_firmware_frame_rejects_header_crc_and_repeated_offset() {
  const auto assertRejected = [](std::vector<uint8_t> bytes,
                                 UsbFrameError expected) {
    UsbFirmwareFrameParser parser;
    parser.consume(bytes.data(), bytes.size());
    TEST_ASSERT_EQUAL(UsbFrameParseStatus::Error, parser.status());
    TEST_ASSERT_EQUAL(expected, parser.error());
  };

  auto badMagic = firmwareFrame(0, {1});
  badMagic[0] = 'X';
  assertRejected(badMagic, UsbFrameError::InvalidMagic);
  auto zeroLength = firmwareFrame(0, {});
  assertRejected(zeroLength, UsbFrameError::InvalidLength);
  std::vector<uint8_t> longPayload(kUsbFirmwareChunkBytes + 1U, 7);
  assertRejected(firmwareFrame(0, longPayload), UsbFrameError::InvalidLength);
  auto badCrc = firmwareFrame(0, {1, 2});
  badCrc.back() ^= 0xffU;
  assertRejected(badCrc, UsbFrameError::CrcMismatch);
  assertRejected(firmwareFrame(9, {1}), UsbFrameError::UnexpectedOffset);

  UsbFirmwareFrameParser maximum;
  const auto maximumFrame =
      firmwareFrame(0, std::vector<uint8_t>(kUsbFirmwareChunkBytes, 0xa5));
  maximum.consume(maximumFrame.data(), maximumFrame.size());
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::Complete, maximum.status());
  TEST_ASSERT_EQUAL_UINT32(kUsbFirmwareChunkBytes,
                           maximum.frame().payload.size());
  TEST_ASSERT_EQUAL_UINT32(kUsbFirmwareChunkBytes, maximum.expectedOffset());

  UsbFirmwareFrameParser repeated;
  const auto first = firmwareFrame(0, {1, 2});
  const auto second = firmwareFrame(0, {3});
  repeated.consume(first.data(), first.size());
  repeated.popFrame();
  repeated.consume(second.data(), second.size());
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::Error, repeated.status());
  TEST_ASSERT_EQUAL(UsbFrameError::UnexpectedOffset, repeated.error());
}

void test_firmware_frame_reset_recovers_with_explicit_offset() {
  UsbFirmwareFrameParser parser;
  auto invalid = firmwareFrame(0, {1});
  invalid[3] = 'X';
  parser.consume(invalid.data(), invalid.size());
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::Error, parser.status());
  parser.reset(7);
  const auto valid = firmwareFrame(7, {8, 9});
  parser.consume(valid.data(), valid.size());
  TEST_ASSERT_EQUAL(UsbFrameParseStatus::Complete, parser.status());
  TEST_ASSERT_EQUAL_UINT32(7, parser.frame().offset);
}

void test_ojp_accepts_all_supported_wrappers() {
  for (const auto& input : validOjpForms()) {
    const auto result = decodeOjpPayload(input, BuildProfile::Development);
    TEST_ASSERT_EQUAL(OjpError::None, result.error);
    TEST_ASSERT_TRUE(result.config.has_value());
    TEST_ASSERT_EQUAL_STRING("Red Demo", result.config->ssid.c_str());
    TEST_ASSERT_EQUAL_STRING("clave segura",
                             result.config->wifiPassword.c_str());
    TEST_ASSERT_EQUAL_STRING("http://192.168.1.20:8090",
                             result.config->baseUrl.c_str());
    TEST_ASSERT_EQUAL_STRING("ojterm_demo_1234567890",
                             result.config->terminalToken.c_str());
  }
}

void test_usb_provision_starts_the_existing_attempt_once() {
  ProvisioningSerialAdapter serial(
      BuildProfile::Development, std::nullopt, 0,
      ProvisioningSerialMode::Portal);
  ProvisioningAttemptState attempt;

  const auto first = serial.accept(validProvisionRequest(), attempt, 1000);
  const auto second = serial.accept(validProvisionRequest(), attempt, 1001);

  TEST_ASSERT_EQUAL(UsbProvisionDecision::Started, first.decision);
  TEST_ASSERT_EQUAL(UsbProvisionDecision::Busy, second.decision);
  TEST_ASSERT_EQUAL(ProvisioningCheckPhase::Connecting, attempt.phase());
}

void test_usb_provision_service_is_fragmented_and_cooperative() {
  ProvisioningSerialAdapter serial(
      BuildProfile::Development, std::nullopt, 0,
      ProvisioningSerialMode::Portal);
  ProvisioningAttemptState attempt;
  FakeProvisioningSerialTransport transport;
  const std::string request = controlLine(
      "provision", "{\"ojp\":\"" + encoded(kCanonicalOjp) + "\"}");
  const size_t split = request.size() / 2U;

  transport.append(std::string_view(request).substr(0, split));
  serial.service(transport, attempt, 1000);
  TEST_ASSERT_TRUE(attempt.canSubmit());
  TEST_ASSERT_TRUE(transport.output().empty());

  transport.append(std::string_view(request).substr(split));
  serial.service(transport, attempt, 1001);
  TEST_ASSERT_EQUAL(ProvisioningCheckPhase::Connecting, attempt.phase());
  TEST_ASSERT_NOT_EQUAL(
      std::string::npos, transport.output().find("\"code\":\"accepted\""));
  TEST_ASSERT_NOT_EQUAL(
      std::string::npos, transport.output().find("\"code\":\"connecting\""));
  TEST_ASSERT_EQUAL(std::string::npos,
                    transport.output().find("ojterm_demo_1234567890"));
  TEST_ASSERT_EQUAL(std::string::npos,
                    transport.output().find("clave segura"));
}

void test_usb_provision_requires_portal_mode_and_respects_pending_policy() {
  ProvisioningAttemptState attempt;
  ProvisioningSerialAdapter runtime(
      BuildProfile::Development, std::nullopt, 0,
      ProvisioningSerialMode::Runtime);
  TEST_ASSERT_EQUAL(
      UsbProvisionDecision::PortalRequired,
      runtime.accept(validProvisionRequest(), attempt, 1000).decision);
  TEST_ASSERT_TRUE(attempt.canSubmit());

  DeviceConfig active;
  active.ssid = "Red Demo";
  active.wifiPassword = "clave segura";
  active.baseUrl = "http://192.168.1.20:8090";
  active.terminalToken = "ojterm_different_1234567890";
  ProvisioningSerialAdapter pending(
      BuildProfile::Development, active, 1,
      ProvisioningSerialMode::Portal);
  TEST_ASSERT_EQUAL(
      UsbProvisionDecision::PendingActions,
      pending.accept(validProvisionRequest(), attempt, 1001).decision);
  TEST_ASSERT_TRUE(attempt.canSubmit());
}

void test_usb_provision_events_never_serialize_candidate_secrets() {
  ProvisioningSerialAdapter serial(
      BuildProfile::Development, std::nullopt, 0,
      ProvisioningSerialMode::Portal);
  ProvisioningAttemptState attempt;
  TEST_ASSERT_EQUAL(
      UsbProvisionDecision::Started,
      serial.accept(validProvisionRequest(), attempt, 1000).decision);

  const auto connecting = serial.nextEvent(attempt);
  TEST_ASSERT_TRUE(connecting.has_value());
  TEST_ASSERT_NOT_EQUAL(
      std::string::npos, connecting->find("\"code\":\"connecting\""));
  TEST_ASSERT_EQUAL(std::string::npos, connecting->find("clave segura"));
  TEST_ASSERT_EQUAL(std::string::npos,
                    connecting->find("ojterm_demo_1234567890"));

  TEST_ASSERT_TRUE(attempt.markValidating());
  const auto validating = serial.nextEvent(attempt);
  TEST_ASSERT_TRUE(validating.has_value());
  TEST_ASSERT_NOT_EQUAL(
      std::string::npos, validating->find("\"code\":\"validating\""));

  attempt.fail("Error con clave segura y ojterm_demo_1234567890");
  const auto failed = serial.nextEvent(attempt);
  TEST_ASSERT_TRUE(failed.has_value());
  TEST_ASSERT_NOT_EQUAL(
      std::string::npos, failed->find("\"code\":\"provision_failed\""));
  TEST_ASSERT_EQUAL(std::string::npos, failed->find("clave segura"));
  TEST_ASSERT_EQUAL(std::string::npos,
                    failed->find("ojterm_demo_1234567890"));

  DeviceConfig browserCandidate;
  browserCandidate.ssid = "browser-network";
  browserCandidate.baseUrl = "https://jornada.example.com";
  browserCandidate.terminalToken = "ojterm_browser";
  TEST_ASSERT_TRUE(attempt.begin(browserCandidate, 1500));
  TEST_ASSERT_FALSE(serial.nextEvent(attempt).has_value());
  attempt.fail("Preparando otro intento USB.");

  TEST_ASSERT_EQUAL(
      UsbProvisionDecision::Started,
      serial.accept(validProvisionRequest(), attempt, 2000).decision);
  TEST_ASSERT_TRUE(serial.nextEvent(attempt).has_value());
  TEST_ASSERT_TRUE(attempt.markValidating());
  TEST_ASSERT_TRUE(serial.nextEvent(attempt).has_value());
  attempt.succeed(3000);
  const auto saved = serial.nextEvent(attempt);
  TEST_ASSERT_TRUE(saved.has_value());
  TEST_ASSERT_NOT_EQUAL(std::string::npos,
                        saved->find("\"code\":\"saved\""));
  TEST_ASSERT_EQUAL(std::string::npos, saved->find("clave segura"));
  TEST_ASSERT_EQUAL(std::string::npos,
                    saved->find("ojterm_demo_1234567890"));
}

void test_usb_provision_cancel_emits_terminal_event_and_closes_ownership() {
  ProvisioningSerialAdapter serial(
      BuildProfile::Development, std::nullopt, 0,
      ProvisioningSerialMode::Portal);
  ProvisioningAttemptState attempt;
  TEST_ASSERT_EQUAL(
      UsbProvisionDecision::Started,
      serial.accept(validProvisionRequest(), attempt, 1000).decision);
  TEST_ASSERT_TRUE(serial.nextEvent(attempt).has_value());
  TEST_ASSERT_TRUE(attempt.markValidating());
  TEST_ASSERT_TRUE(serial.nextEvent(attempt).has_value());

  attempt.fail("Configuración cancelada.");
  const auto cancelled = serial.nextEvent(attempt);
  TEST_ASSERT_TRUE(cancelled.has_value());
  TEST_ASSERT_NOT_EQUAL(
      std::string::npos, cancelled->find("\"code\":\"provision_failed\""));
  TEST_ASSERT_FALSE(attempt.busy());
  TEST_ASSERT_TRUE(attempt.canSubmit());
  TEST_ASSERT_FALSE(serial.nextEvent(attempt).has_value());

  DeviceConfig browserCandidate;
  browserCandidate.ssid = "browser-network";
  TEST_ASSERT_TRUE(attempt.begin(browserCandidate, 2000));
  TEST_ASSERT_FALSE(serial.nextEvent(attempt).has_value());
}

void test_ojp_rejects_missing_oversized_or_invalid_encoding() {
  TEST_ASSERT_EQUAL(OjpError::MissingPayload,
                    decodeOjpPayload("", BuildProfile::Development).error);
  TEST_ASSERT_EQUAL(OjpError::MissingPayload,
                    decodeOjpPayload("ojp=", BuildProfile::Development).error);
  TEST_ASSERT_EQUAL(OjpError::TooLarge,
                    decodeOjpPayload(std::string(601, 'A'),
                                     BuildProfile::Development)
                        .error);
  TEST_ASSERT_EQUAL(OjpError::InvalidEncoding,
                    decodeOjpPayload("ojp=%%%", BuildProfile::Development)
                        .error);
  TEST_ASSERT_EQUAL(OjpError::InvalidEncoding,
                    decodeOjpPayload(encoded(kCanonicalOjp) + "=",
                                     BuildProfile::Development)
                        .error);
  TEST_ASSERT_EQUAL(OjpError::InvalidEncoding,
                    decodeOjpPayload("A", BuildProfile::Development).error);
}

void test_ojp_rejects_invalid_utf8() {
  const std::string malformedJson =
      std::string("{\"v\":1,\"s\":\"") + static_cast<char>(0xc3) +
      "\",\"p\":\"\",\"u\":\"https://example.com\",\"t\":\"ojterm_demo\"}";
  TEST_ASSERT_EQUAL(OjpError::InvalidUtf8,
                    decodeOjpPayload(encoded(malformedJson),
                                     BuildProfile::Development)
                        .error);
}

void test_ojp_rejects_noncanonical_contracts() {
  const std::vector<std::string> invalidJson = {
      R"({"v":1,"s":"Red Demo","p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890","x":1})",
      R"({"v":1,"s":"Red Demo","s":"otra","p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"})",
      R"({"s":"Red Demo","v":1,"p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"})",
      R"({"v":1, "s":"Red Demo","p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"})",
      R"({"v":1,"s":"Red\u0020Demo","p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"})",
      R"({"v":2,"s":"Red Demo","p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"})",
      R"({"v":1,"s":7,"p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"})"};
  for (const auto& json : invalidJson) {
    TEST_ASSERT_EQUAL(OjpError::InvalidContract,
                      decodeOjpPayload(encoded(json),
                                       BuildProfile::Development)
                          .error);
  }
}

void test_ojp_applies_byte_limits_and_config_policy() {
  const auto replace = [](std::string json, std::string_view from,
                          std::string_view to) {
    json.replace(json.find(from), from.size(), to);
    return json;
  };
  const std::string base(kCanonicalOjp);
  TEST_ASSERT_EQUAL(
      OjpError::InvalidConfig,
      decodeOjpPayload(encoded(replace(base, "Red Demo", std::string(33, 's'))),
                       BuildProfile::Development)
          .error);
  TEST_ASSERT_EQUAL(
      OjpError::InvalidConfig,
      decodeOjpPayload(
          encoded(replace(base, "clave segura", std::string(64, 'p'))),
          BuildProfile::Development)
          .error);
  TEST_ASSERT_EQUAL(OjpError::InvalidConfig,
                    decodeOjpPayload(encoded(kCanonicalOjp),
                                     BuildProfile::Release)
                        .error);

  const std::string utf8Json =
      R"({"v":1,"s":"Red ñ","p":"","u":"https://example.com","t":"ojterm_demo_1234567890"})";
  TEST_ASSERT_EQUAL(OjpError::None,
                    decodeOjpPayload(encoded(utf8Json), BuildProfile::Release)
                        .error);
}

void test_ojp_accepts_each_field_at_its_maximum_byte_length() {
  const std::string maxUrl = "https://example.com/" + std::string(235, 'a');
  TEST_ASSERT_EQUAL_UINT32(255, maxUrl.size());
  const std::vector<std::string> boundaryJson = {
      ojpJson(std::string(32, 's'), "", "https://example.com", "ojterm_x"),
      ojpJson("s", std::string(63, 'p'), "https://example.com", "ojterm_x"),
      ojpJson("s", "", maxUrl, "ojterm_x"),
      ojpJson("s", "", "https://example.com",
              std::string("ojterm_") + std::string(89, 't'))};
  for (const auto& json : boundaryJson) {
    TEST_ASSERT_EQUAL(OjpError::None,
                      decodeOjpPayload(encoded(json), BuildProfile::Release)
                          .error);
  }
}

void test_embedded_firmware_metadata_has_exact_canonical_contract() {
  const std::string_view embedded(kEmbeddedFirmwareMetadata);
  TEST_ASSERT_TRUE(embedded.rfind(kFirmwareMetadataPrefix, 0) == 0);
  const auto parsed = parseFirmwareBuildMetadata(
      reinterpret_cast<const uint8_t*>(embedded.data()), embedded.size());
  TEST_ASSERT_TRUE(parsed.has_value());
  TEST_ASSERT_EQUAL_STRING("m5stack-basic-core-v27", parsed->board.c_str());
  TEST_ASSERT_EQUAL_UINT8(1, parsed->protocolVersion);
  TEST_ASSERT_EQUAL_STRING("1.2.0", parsed->firmwareVersion.c_str());
}

void test_firmware_metadata_scans_bounded_image_and_requires_one_marker() {
  const std::string canonical =
      R"({"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"1.2.0"})";
  const auto valid = parseMetadata(metadataImage(canonical));
  TEST_ASSERT_TRUE(valid.has_value());

  std::string duplicate = metadataImage(canonical);
  duplicate += metadataImage(canonical, 0);
  TEST_ASSERT_FALSE(parseMetadata(duplicate).has_value());

  std::string outside(kFirmwareMetadataScanBytes, '\x33');
  outside += std::string(kFirmwareMetadataPrefix) + canonical;
  TEST_ASSERT_FALSE(parseMetadata(outside).has_value());
  TEST_ASSERT_FALSE(parseFirmwareBuildMetadata(nullptr, 1).has_value());
}

void test_firmware_metadata_rejects_noncanonical_or_incompatible_values() {
  const std::vector<std::string> invalid = {
      R"({"protocolVersion":1,"board":"m5stack-basic-core-v27","firmwareVersion":"1.2.0"})",
      R"({"board":"m5stack-basic-core-v27","protocolVersion":1,"protocolVersion":1,"firmwareVersion":"1.2.0"})",
      R"({"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"1.2.0","extra":true})",
      R"({"board":"other","protocolVersion":1,"firmwareVersion":"1.2.0"})",
      R"({"board":"m5stack-basic-core-v27","protocolVersion":2,"firmwareVersion":"1.2.0"})",
      R"({"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"01.2.0"})",
      R"({"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"1.2"})",
      R"({"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"1.2.0-beta"})"};
  for (const auto& json : invalid) {
    TEST_ASSERT_FALSE(parseMetadata(metadataImage(json)).has_value());
  }
  TEST_ASSERT_FALSE(
      parseMetadata(metadataImage(std::string(192, 'x') + "}")).has_value());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_control_parser_accepts_fragmented_exact_request);
  RUN_TEST(test_control_parser_accepts_exact_command_payload_shapes);
  RUN_TEST(test_control_parser_rejects_nul_malformed_utf8_and_invalid_ids);
  RUN_TEST(
      test_control_parser_rejects_unknown_duplicate_and_wrong_payload_fields);
  RUN_TEST(test_control_parser_is_bounded_and_requires_explicit_reset);
  RUN_TEST(test_control_response_has_stable_order_and_json_escaping);
  RUN_TEST(
      test_firmware_frame_accepts_one_byte_fragmentation_and_partial_payload);
  RUN_TEST(test_firmware_frame_accepts_two_frames_in_one_buffer);
  RUN_TEST(
      test_firmware_frame_backpressure_preserves_many_concatenated_frames);
  RUN_TEST(test_firmware_frame_rejects_header_crc_and_repeated_offset);
  RUN_TEST(test_firmware_frame_reset_recovers_with_explicit_offset);
  RUN_TEST(test_ojp_accepts_all_supported_wrappers);
  RUN_TEST(test_usb_provision_starts_the_existing_attempt_once);
  RUN_TEST(test_usb_provision_service_is_fragmented_and_cooperative);
  RUN_TEST(
      test_usb_provision_requires_portal_mode_and_respects_pending_policy);
  RUN_TEST(test_usb_provision_events_never_serialize_candidate_secrets);
  RUN_TEST(
      test_usb_provision_cancel_emits_terminal_event_and_closes_ownership);
  RUN_TEST(test_ojp_rejects_missing_oversized_or_invalid_encoding);
  RUN_TEST(test_ojp_rejects_invalid_utf8);
  RUN_TEST(test_ojp_rejects_noncanonical_contracts);
  RUN_TEST(test_ojp_applies_byte_limits_and_config_policy);
  RUN_TEST(test_ojp_accepts_each_field_at_its_maximum_byte_length);
  RUN_TEST(test_embedded_firmware_metadata_has_exact_canonical_contract);
  RUN_TEST(test_firmware_metadata_scans_bounded_image_and_requires_one_marker);
  RUN_TEST(test_firmware_metadata_rejects_noncanonical_or_incompatible_values);
  return UNITY_END();
}
