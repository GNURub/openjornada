#include <unity.h>
#include <optional/monocypher-ed25519.h>

#include <array>
#include <cstdint>
#include <fstream>
#include <string>

#include "openjornada/ota.hpp"
#include "openjornada/ota_configuration.hpp"
#include "openjornada/usb_firmware_receiver.hpp"

using namespace openjornada;

namespace {

class FakeCommitStore final : public OtaCommitStore {
 public:
  bool stageCandidate(const std::string&, const std::string&,
                      int64_t) override {
    calls.push_back('s');
    return stageSucceeds;
  }

  bool markBootPending() override {
    calls.push_back('m');
    return markSucceeds;
  }

  bool clearPending() override {
    calls.push_back('c');
    return true;
  }

  bool stageSucceeds = true;
  bool markSucceeds = true;
  std::string calls;
};

std::array<uint8_t, 32> bytes32(const char* hex) {
  std::array<uint8_t, 32> output{};
  for (size_t index = 0; index < output.size(); ++index) {
    output[index] = static_cast<uint8_t>(std::stoul(
        std::string(hex + index * 2, 2), nullptr, 16));
  }
  return output;
}

std::array<uint8_t, 64> bytes64(const char* hex) {
  std::array<uint8_t, 64> output{};
  for (size_t index = 0; index < output.size(); ++index) {
    output[index] = static_cast<uint8_t>(std::stoul(
        std::string(hex + index * 2, 2), nullptr, 16));
  }
  return output;
}

FirmwareManifest validManifest() {
  FirmwareManifest value;
  value.schemaVersion = 1;
  value.channel = "stable";
  value.board = "m5stack-basic-core-v27";
  value.firmwareVersion = "1.2.1";
  value.releaseTag = "v0.8.0";
  value.protocolVersion = 1;
  value.assetName = "openjornada-m5stack.bin";
  value.size = 1400000;
  value.sha256 = std::string(64, 'a');
  value.keyId = "production-2026-09";
  value.publishedAt = "2026-08-27T12:00:00Z";
  return value;
}

std::string base64Signature(const std::array<uint8_t, 64>& input) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(88);
  for (size_t cursor = 0; cursor < input.size(); cursor += 3U) {
    const uint32_t first = input[cursor];
    const bool hasSecond = cursor + 1U < input.size();
    const bool hasThird = cursor + 2U < input.size();
    const uint32_t second = hasSecond ? input[cursor + 1U] : 0U;
    const uint32_t third = hasThird ? input[cursor + 2U] : 0U;
    const uint32_t bits = (first << 16U) | (second << 8U) | third;
    output.push_back(alphabet[(bits >> 18U) & 0x3fU]);
    output.push_back(alphabet[(bits >> 12U) & 0x3fU]);
    output.push_back(hasSecond ? alphabet[(bits >> 6U) & 0x3fU] : '=');
    output.push_back(hasThird ? alphabet[bits & 0x3fU] : '=');
  }
  return output;
}

}  // namespace

void test_manifest_parses_exact_contract() {
  const std::string json =
      R"({"schemaVersion":1,"channel":"stable","board":"m5stack-basic-core-v27","firmwareVersion":"1.2.1","releaseTag":"v0.8.0","protocolVersion":1,"assetName":"openjornada-m5stack.bin","size":1400000,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","keyId":"production-2026-09","publishedAt":"2026-08-27T12:00:00Z"})";
  FirmwareManifest parsed;
  TEST_ASSERT_TRUE(parseFirmwareManifest(json, parsed));
  TEST_ASSERT_EQUAL_STRING("1.2.1", parsed.firmwareVersion.c_str());
  TEST_ASSERT_EQUAL_UINT32(1400000, parsed.size);
}

void test_manifest_rejects_unknown_fields_and_bad_hash() {
  FirmwareManifest parsed;
  TEST_ASSERT_FALSE(parseFirmwareManifest(
      R"({"schemaVersion":1,"channel":"stable","board":"m5stack-basic-core-v27","firmwareVersion":"1.2.1","releaseTag":"v0.8.0","protocolVersion":1,"assetName":"openjornada-m5stack.bin","size":1,"sha256":"bad","keyId":"production-2026-09","publishedAt":"2026-08-27T12:00:00Z","url":"https://evil.invalid"})",
      parsed));
}

void test_semver_and_compatibility_reject_downgrades() {
  TEST_ASSERT_EQUAL_INT(1, *compareSemanticVersions("1.2.1", "1.2.0"));
  TEST_ASSERT_EQUAL_INT(0, *compareSemanticVersions("1.2.0", "1.2.0"));
  TEST_ASSERT_FALSE(compareSemanticVersions("01.2.0", "1.2.0").has_value());
  auto manifest = validManifest();
  TEST_ASSERT_TRUE(manifestIsInstallable(manifest, "1.2.0", 1));
  TEST_ASSERT_FALSE(manifestIsInstallable(manifest, "1.2.1", 1));
  manifest.keyId = "unknown-key";
  TEST_ASSERT_FALSE(manifestIsInstallable(manifest, "1.2.0", 1));
  manifest.keyId = "production-2026-09";
  manifest.board = "other";
  TEST_ASSERT_FALSE(manifestIsInstallable(manifest, "1.2.0", 1));
}

void test_safety_policy_requires_every_gate() {
  OtaSafetyContext context{0, false, false, false, true, true, true, true,
                           kOtaInteractionIdleMs};
  TEST_ASSERT_TRUE(otaSafetyAllowsInstall(context));
  context.pendingCount = 1;
  TEST_ASSERT_FALSE(otaSafetyAllowsInstall(context));
  context.pendingCount = 0;
  context.adminModeActive = true;
  TEST_ASSERT_FALSE(otaSafetyAllowsInstall(context));
}

void test_scheduler_handles_wraparound() {
  OtaScheduler scheduler;
  TEST_ASSERT_TRUE(scheduler.due(100));
  scheduler.markChecked(UINT32_MAX - 1000U);
  TEST_ASSERT_FALSE(scheduler.due(500U));
  TEST_ASSERT_TRUE(scheduler.due(kOtaCheckIntervalMs));
}

void test_boot_reconciliation_distinguishes_staging_from_attempted_boot() {
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::ClearInterruptedStage),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::Staged, true, false, false, true)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::RecordRollback),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::BootPending, true, false, false, true)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::ClearInterruptedStage),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::Staged, true, true, false, true)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::ClearInterruptedStage),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::None, true, true, false, true)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::ClearInterruptedStage),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::None, true, false, false, true)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::ConfirmCandidate),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::Staged, true, true, true, true)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::RejectCandidate),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::BootPending, true, true, true, false)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OtaBootAction::RejectCandidate),
      static_cast<int>(decideOtaBootAction(
          OtaPersistedPhase::None, false, false, true, true)));
}

void test_clean_first_boot_initializes_missing_ota_namespace() {
  TEST_ASSERT_TRUE(otaStateNamespaceAvailable(false, true));
  TEST_ASSERT_TRUE(otaStateNamespaceAvailable(true, false));
  TEST_ASSERT_FALSE(otaStateNamespaceAvailable(false, false));
}

void test_boot_intent_is_persisted_before_commit_and_nvs_failure_is_cleared() {
  FakeCommitStore success;
  TEST_ASSERT_EQUAL(
      FirmwareUpdateError::None,
      prepareOtaBootCommit(success, "1.2.1", std::string(64, 'a'), 123));
  TEST_ASSERT_EQUAL_STRING("sm", success.calls.c_str());

  FakeCommitStore stageFailure;
  stageFailure.stageSucceeds = false;
  TEST_ASSERT_EQUAL(FirmwareUpdateError::BootValidation,
                    prepareOtaBootCommit(stageFailure, "1.2.1",
                                         std::string(64, 'a'), 123));
  TEST_ASSERT_EQUAL_STRING("sc", stageFailure.calls.c_str());

  FakeCommitStore markFailure;
  markFailure.markSucceeds = false;
  TEST_ASSERT_EQUAL(FirmwareUpdateError::BootValidation,
                    prepareOtaBootCommit(markFailure, "1.2.1",
                                         std::string(64, 'a'), 123));
  TEST_ASSERT_EQUAL_STRING("smc", markFailure.calls.c_str());
}

void test_download_urls_are_limited_to_github_or_private_test_hosts() {
  TEST_ASSERT_TRUE(otaDownloadUrlAllowed(
      "https://github.com/GNURub/openjornada/releases/latest/download/file", false));
  TEST_ASSERT_TRUE(otaDownloadUrlAllowed(
      "https://release-assets.githubusercontent.com/path?token=value", false));
  TEST_ASSERT_FALSE(otaDownloadUrlAllowed("https://github.com.evil.invalid/file", false));
  TEST_ASSERT_FALSE(otaDownloadUrlAllowed("http://github.com/file", false));
  TEST_ASSERT_TRUE(otaDownloadUrlAllowed("http://192.168.1.20:8765/file", true));
  TEST_ASSERT_FALSE(otaDownloadUrlAllowed("http://203.0.113.20/file", true));
}

void test_ed25519_rfc8032_vector() {
  const auto publicKey = bytes32(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const auto signature = bytes64(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  TEST_ASSERT_TRUE(verifyEd25519Manifest("", signature, publicKey));
  TEST_ASSERT_FALSE(verifyEd25519Manifest("x", signature, publicKey));
  std::array<uint8_t, 64> decoded{};
  TEST_ASSERT_TRUE(decodeBase64Signature(
      "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw==",
      decoded));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(signature.data(), decoded.data(), signature.size());
  FirmwareManifest parsed;
  TEST_ASSERT_FALSE(verifyFirmwareManifestSignature(
      "{}",
      "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw==",
      publicKey, parsed));
}

void test_usb_firmware_install_policy_fails_closed() {
  UsbFirmwareContext context;
  context.imageSize = 1024;
  context.slotSize = 2048;
  context.boardCompatible = true;
  context.protocolCompatible = true;
  context.runtimeIdle = true;

  context.official = true;
  context.signatureValid = true;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::Accept,
                    decideUsbFirmwareInstall(context));

  context.pendingCount = 1;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectPendingActions,
                    decideUsbFirmwareInstall(context));
  context.pendingCount = 0;
  context.runtimeIdle = false;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectBusy,
                    decideUsbFirmwareInstall(context));
  context.runtimeIdle = true;
  context.boardCompatible = false;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectBoard,
                    decideUsbFirmwareInstall(context));
  context.boardCompatible = true;
  context.protocolCompatible = false;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectProtocol,
                    decideUsbFirmwareInstall(context));
  context.protocolCompatible = true;
  context.imageSize = 2049;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectSize,
                    decideUsbFirmwareInstall(context));
  context.imageSize = 1024;
  context.signatureValid = false;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectSignature,
                    decideUsbFirmwareInstall(context));

  context.official = false;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RequirePhysicalConfirmation,
                    decideUsbFirmwareInstall(context));
  context.physicallyConfirmed = true;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::Accept,
                    decideUsbFirmwareInstall(context));
  context.transferActive = true;
  TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectDuplicate,
                    decideUsbFirmwareInstall(context));
}

void test_production_public_key_matches_repository_pem() {
  std::ifstream source("keys/production-ed25519-public.pem",
                       std::ios::binary);
  TEST_ASSERT_TRUE(source.good());
  const std::string pem((std::istreambuf_iterator<char>(source)),
                        std::istreambuf_iterator<char>());
  TEST_ASSERT_EQUAL_STRING(
      "-----BEGIN PUBLIC KEY-----\n"
      "MCowBQYDK2VwAyEAT72/d8TqbnHGR3OKEiJ3vjsl7n8tt8RZmah1ldBJ3sQ=\n"
      "-----END PUBLIC KEY-----\n",
      pem.c_str());
  const auto expected = bytes32(
      "4fbdbf77c4ea6e71c647738a122277be3b25ee7f2db7c45999a87595d049dec4");
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected.data(), kProductionOtaPublicKey.data(),
                                expected.size());
}

void test_official_usb_intent_requires_signed_manifest_exact_match() {
  const std::string manifest =
      R"({"schemaVersion":1,"channel":"stable","board":"m5stack-basic-core-v27","firmwareVersion":"1.2.3","releaseTag":"v1.2.3","protocolVersion":1,"assetName":"openjornada-m5stack.bin","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","keyId":"production-2026-09","publishedAt":"2026-08-28T12:00:00Z"})";
  std::array<uint8_t, 32> seed{};
  for (size_t index = 0; index < seed.size(); ++index) {
    seed[index] = static_cast<uint8_t>(index);
  }
  std::array<uint8_t, 64> secretKey{};
  std::array<uint8_t, 32> publicKey{};
  crypto_ed25519_key_pair(secretKey.data(), publicKey.data(), seed.data());
  std::array<uint8_t, 64> signature{};
  crypto_ed25519_sign(signature.data(), secretKey.data(),
                      reinterpret_cast<const uint8_t*>(manifest.data()),
                      manifest.size());

  FirmwareTransferIntent intent;
  intent.size = 3;
  intent.sha256 =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  intent.metadata = {"m5stack-basic-core-v27", 1, "1.2.3"};
  intent.official = true;
  intent.manifest = manifest;
  intent.signature = base64Signature(signature);
  TEST_ASSERT_TRUE(
      officialUsbFirmwareIntentValid(intent, "1.2.0", publicKey));
  ++intent.size;
  TEST_ASSERT_FALSE(
      officialUsbFirmwareIntentValid(intent, "1.2.0", publicKey));
  --intent.size;
  TEST_ASSERT_FALSE(
      officialUsbFirmwareIntentValid(intent, "1.2.3", publicKey));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_manifest_parses_exact_contract);
  RUN_TEST(test_manifest_rejects_unknown_fields_and_bad_hash);
  RUN_TEST(test_semver_and_compatibility_reject_downgrades);
  RUN_TEST(test_safety_policy_requires_every_gate);
  RUN_TEST(test_scheduler_handles_wraparound);
  RUN_TEST(test_boot_reconciliation_distinguishes_staging_from_attempted_boot);
  RUN_TEST(test_clean_first_boot_initializes_missing_ota_namespace);
  RUN_TEST(
      test_boot_intent_is_persisted_before_commit_and_nvs_failure_is_cleared);
  RUN_TEST(test_download_urls_are_limited_to_github_or_private_test_hosts);
  RUN_TEST(test_ed25519_rfc8032_vector);
  RUN_TEST(test_usb_firmware_install_policy_fails_closed);
  RUN_TEST(test_production_public_key_matches_repository_pem);
  RUN_TEST(test_official_usb_intent_requires_signed_manifest_exact_match);
  return UNITY_END();
}
