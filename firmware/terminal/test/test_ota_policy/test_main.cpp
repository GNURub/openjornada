#include <unity.h>

#include <array>
#include <cstdint>
#include <string>

#include "openjornada/ota.hpp"

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
  value.keyId = "production-2026";
  value.publishedAt = "2026-08-27T12:00:00Z";
  return value;
}

}  // namespace

void test_manifest_parses_exact_contract() {
  const std::string json =
      R"({"schemaVersion":1,"channel":"stable","board":"m5stack-basic-core-v27","firmwareVersion":"1.2.1","releaseTag":"v0.8.0","protocolVersion":1,"assetName":"openjornada-m5stack.bin","size":1400000,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","keyId":"production-2026","publishedAt":"2026-08-27T12:00:00Z"})";
  FirmwareManifest parsed;
  TEST_ASSERT_TRUE(parseFirmwareManifest(json, parsed));
  TEST_ASSERT_EQUAL_STRING("1.2.1", parsed.firmwareVersion.c_str());
  TEST_ASSERT_EQUAL_UINT32(1400000, parsed.size);
}

void test_manifest_rejects_unknown_fields_and_bad_hash() {
  FirmwareManifest parsed;
  TEST_ASSERT_FALSE(parseFirmwareManifest(
      R"({"schemaVersion":1,"channel":"stable","board":"m5stack-basic-core-v27","firmwareVersion":"1.2.1","releaseTag":"v0.8.0","protocolVersion":1,"assetName":"openjornada-m5stack.bin","size":1,"sha256":"bad","keyId":"production-2026","publishedAt":"2026-08-27T12:00:00Z","url":"https://evil.invalid"})",
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
  manifest.keyId = "production-2026";
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
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_manifest_parses_exact_contract);
  RUN_TEST(test_manifest_rejects_unknown_fields_and_bad_hash);
  RUN_TEST(test_semver_and_compatibility_reject_downgrades);
  RUN_TEST(test_safety_policy_requires_every_gate);
  RUN_TEST(test_scheduler_handles_wraparound);
  RUN_TEST(test_boot_reconciliation_distinguishes_staging_from_attempted_boot);
  RUN_TEST(
      test_boot_intent_is_persisted_before_commit_and_nvs_failure_is_cleared);
  RUN_TEST(test_download_urls_are_limited_to_github_or_private_test_hosts);
  RUN_TEST(test_ed25519_rfc8032_vector);
  return UNITY_END();
}
