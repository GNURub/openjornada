#include <unity.h>

#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>

#include "openjornada/cache_store.hpp"

using namespace openjornada;

namespace {

CacheSnapshot fixture() {
  return {42,
          {{"employee-1", "Ada", "04A1B2C3",
            {WorkKind::Working, 3600, 300, false, false}},
           {"employee-2", "Lin", "11223344",
            {WorkKind::OnBreak, 7200, 1501, false, true}}}};
}

void assertRoundTrip(const CacheSnapshot& expected,
                     const CacheSnapshot& actual) {
  TEST_ASSERT_EQUAL_UINT32(expected.revision, actual.revision);
  TEST_ASSERT_EQUAL_UINT(expected.entries.size(), actual.entries.size());
  for (size_t index = 0; index < expected.entries.size(); ++index) {
    const auto& wanted = expected.entries[index];
    const auto& got = actual.entries[index];
    TEST_ASSERT_EQUAL_STRING(wanted.employeeId.c_str(), got.employeeId.c_str());
    TEST_ASSERT_EQUAL_STRING(wanted.displayName.c_str(), got.displayName.c_str());
    TEST_ASSERT_EQUAL_STRING(wanted.uid.c_str(), got.uid.c_str());
    TEST_ASSERT_EQUAL_INT(static_cast<int>(wanted.state.kind),
                          static_cast<int>(got.state.kind));
    TEST_ASSERT_EQUAL_INT32(wanted.state.workedSeconds,
                            got.state.workedSeconds);
    TEST_ASSERT_EQUAL_INT32(wanted.state.breakSeconds,
                            got.state.breakSeconds);
    TEST_ASSERT_EQUAL(wanted.state.longShift, got.state.longShift);
    TEST_ASSERT_EQUAL(wanted.state.staleBreak, got.state.staleBreak);
  }
}

}  // namespace

void test_snapshot_round_trip() {
  std::vector<uint8_t> encoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::None),
                        static_cast<int>(CacheCodec::encode(fixture(), encoded)));
  TEST_ASSERT_TRUE(encoded.size() > CacheCodec::kHeaderSize);
  TEST_ASSERT_EQUAL_UINT8('O', encoded[0]);
  TEST_ASSERT_EQUAL_UINT8('J', encoded[1]);
  TEST_ASSERT_EQUAL_UINT8('C', encoded[2]);
  TEST_ASSERT_EQUAL_UINT8('A', encoded[3]);

  CacheSnapshot decoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::None),
                        static_cast<int>(CacheCodec::decode(encoded, decoded)));
  assertRoundTrip(fixture(), decoded);
}

void test_payload_corruption_is_detected() {
  std::vector<uint8_t> encoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::None),
                        static_cast<int>(CacheCodec::encode(fixture(), encoded)));
  encoded[CacheCodec::kHeaderSize + 2] ^= 0x01U;
  CacheSnapshot decoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Checksum),
                        static_cast<int>(CacheCodec::decode(encoded, decoded)));

  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::None),
                        static_cast<int>(CacheCodec::encode(fixture(), encoded)));
  encoded[5] ^= 0x01U;
  decoded.revision = 999;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Checksum),
                        static_cast<int>(CacheCodec::decode(encoded, decoded)));
  TEST_ASSERT_EQUAL_UINT32(999, decoded.revision);
}

void test_capacity_is_limited_to_thirty() {
  CacheSnapshot maximum;
  for (size_t index = 0; index < CacheCodec::kCapacity; ++index) {
    char uid[9]{};
    std::snprintf(uid, sizeof(uid), "%08X", static_cast<unsigned>(index));
    maximum.entries.push_back(
        {"employee-" + std::to_string(index), "Persona " + std::to_string(index),
         uid, {WorkKind::Idle, 0, 0, false, false}});
  }
  std::vector<uint8_t> encoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::None),
                        static_cast<int>(CacheCodec::encode(maximum, encoded)));

  CacheSnapshot snapshot;
  snapshot.entries.resize(CacheCodec::kCapacity + 1);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Capacity),
                        static_cast<int>(CacheCodec::encode(snapshot, encoded)));
}

void test_rejects_bad_magic_version_and_truncation() {
  std::vector<uint8_t> encoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::None),
                        static_cast<int>(CacheCodec::encode(fixture(), encoded)));
  auto badMagic = encoded;
  badMagic[0] = 'X';
  CacheSnapshot decoded{999, {}};
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Magic),
                        static_cast<int>(CacheCodec::decode(badMagic, decoded)));
  TEST_ASSERT_EQUAL_UINT32(999, decoded.revision);

  auto badVersion = encoded;
  badVersion[4] = 2;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Version),
                        static_cast<int>(CacheCodec::decode(badVersion, decoded)));

  for (size_t length = 0; length < encoded.size(); ++length) {
    const std::vector<uint8_t> truncated(encoded.begin(),
                                         encoded.begin() + length);
    decoded.revision = 999;
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(CacheError::None),
                          static_cast<int>(CacheCodec::decode(truncated, decoded)));
    TEST_ASSERT_EQUAL_UINT32(999, decoded.revision);
  }
}

void test_rejects_length_overflow_and_trailing_bytes() {
  std::vector<uint8_t> encoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::None),
                        static_cast<int>(CacheCodec::encode(fixture(), encoded)));

  auto oversized = encoded;
  oversized[9] = 0xFF;
  oversized[10] = 0xFF;
  oversized[11] = 0xFF;
  oversized[12] = 0x7F;
  CacheSnapshot decoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Length),
                        static_cast<int>(CacheCodec::decode(oversized, decoded)));

  encoded.push_back(0);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Length),
                        static_cast<int>(CacheCodec::decode(encoded, decoded)));
}

void test_rejects_invalid_entries_without_partial_mutation() {
  CacheSnapshot invalid = fixture();
  invalid.entries[0].uid = "04a1";
  std::vector<uint8_t> encoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::InvalidData),
                        static_cast<int>(CacheCodec::encode(invalid, encoded)));
  TEST_ASSERT_TRUE(encoded.empty());

  invalid = fixture();
  invalid.entries[0].displayName =
      std::string(CacheCodec::kMaxDisplayName + 1, 'n');
  TEST_ASSERT_EQUAL_INT(static_cast<int>(CacheError::Capacity),
                        static_cast<int>(CacheCodec::encode(invalid, encoded)));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_snapshot_round_trip);
  RUN_TEST(test_payload_corruption_is_detected);
  RUN_TEST(test_capacity_is_limited_to_thirty);
  RUN_TEST(test_rejects_bad_magic_version_and_truncation);
  RUN_TEST(test_rejects_length_overflow_and_trailing_bytes);
  RUN_TEST(test_rejects_invalid_entries_without_partial_mutation);
  return UNITY_END();
}
