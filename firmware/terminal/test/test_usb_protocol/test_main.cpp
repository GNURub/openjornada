#include <unity.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "openjornada/firmware_metadata.hpp"
#include "openjornada/ojp.hpp"

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

}  // namespace

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
  RUN_TEST(test_ojp_accepts_all_supported_wrappers);
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
