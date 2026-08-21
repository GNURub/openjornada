#include <unity.h>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

#include "openjornada/outbox.hpp"

using namespace openjornada;

namespace {

class MemoryStorage final : public OutboxStorage {
 public:
  std::map<std::string, std::vector<uint8_t>> files;
  size_t durableAppends = 0;
  size_t durableWrites = 0;
  size_t renameCalls = 0;
  size_t failRenameCall = 0;
  bool failWrites = false;
  bool corruptWrites = false;

  bool exists(const char* path) const override {
    return files.find(path) != files.end();
  }

  bool read(const char* path, std::vector<uint8_t>& output) const override {
    const auto found = files.find(path);
    if (found == files.end()) return false;
    output = found->second;
    return true;
  }

  bool appendAndFlush(const char* path,
                      const std::vector<uint8_t>& bytes) override {
    auto& file = files[path];
    file.insert(file.end(), bytes.begin(), bytes.end());
    ++durableAppends;
    return true;
  }

  bool writeAndFlush(const char* path,
                     const std::vector<uint8_t>& bytes) override {
    if (failWrites) return false;
    files[path] = bytes;
    if (corruptWrites && !files[path].empty()) {
      files[path][OutboxCodec::kHeaderSize] ^= 0x01U;
    }
    ++durableWrites;
    return true;
  }

  bool remove(const char* path) override {
    files.erase(path);
    return true;
  }

  bool rename(const char* from, const char* to) override {
    ++renameCalls;
    if (failRenameCall != 0 && renameCalls == failRenameCall) return false;
    const auto source = files.find(from);
    if (source == files.end() || files.find(to) != files.end()) return false;
    files[to] = std::move(source->second);
    files.erase(source);
    return true;
  }
};

QueuedAction action(unsigned sequence = 1, std::string id = "req-1") {
  QueuedAction value;
  value.clientRequestId = std::move(id);
  value.uid = "04A1B2C3";
  value.command = Command::ClockIn;
  value.deviceCapturedAt = "2026-08-21T08:00:00.000Z";
  value.clockSyncedAt = "2026-08-21T07:59:59.000Z";
  value.deviceSequence = sequence;
  value.rebootId = "boot-1";
  value.signature = std::string(64, 'a');
  return value;
}

std::vector<uint8_t> encoded(const QueuedAction& value) {
  std::vector<uint8_t> output;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(OutboxCodec::encode(value, output)));
  return output;
}

void appendRaw(std::vector<uint8_t>& journal, const QueuedAction& value) {
  const auto record = encoded(value);
  journal.insert(journal.end(), record.begin(), record.end());
}

void assertIds(const std::vector<QueuedAction>& actions,
               const std::vector<std::string>& expected) {
  TEST_ASSERT_EQUAL_UINT(expected.size(), actions.size());
  for (size_t index = 0; index < expected.size(); ++index) {
    TEST_ASSERT_EQUAL_STRING(expected[index].c_str(),
                             actions[index].clientRequestId.c_str());
  }
}

}  // namespace

void test_codec_round_trip_preserves_retry_identity() {
  const QueuedAction expected = action();
  const std::vector<uint8_t> bytes = encoded(expected);
  TEST_ASSERT_EQUAL_UINT8('O', bytes[0]);
  TEST_ASSERT_EQUAL_UINT8('J', bytes[1]);
  TEST_ASSERT_EQUAL_UINT8('A', bytes[2]);
  TEST_ASSERT_EQUAL_UINT8('C', bytes[3]);

  QueuedAction decoded;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(OutboxCodec::decode(bytes, decoded)));
  TEST_ASSERT_EQUAL_STRING(expected.clientRequestId.c_str(),
                           decoded.clientRequestId.c_str());
  TEST_ASSERT_EQUAL_UINT32(expected.deviceSequence, decoded.deviceSequence);
  TEST_ASSERT_EQUAL_STRING(expected.signature.c_str(), decoded.signature.c_str());
}

void test_append_flushes_before_success_and_reopens() {
  MemoryStorage storage;
  Outbox first(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(first.begin()));
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(first.append(action())));
  TEST_ASSERT_EQUAL_UINT(1, storage.durableAppends);

  Outbox reopened(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(reopened.begin()));
  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(reopened.list(pending)));
  assertIds(pending, {"req-1"});

  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(reopened.append(action())));
  TEST_ASSERT_EQUAL_UINT(1, storage.durableAppends);
  QueuedAction conflicting = action();
  conflicting.deviceSequence = 2;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::InvalidData),
                        static_cast<int>(reopened.append(conflicting)));
}

void test_truncated_final_record_is_discarded_on_reopen() {
  MemoryStorage storage;
  appendRaw(storage.files[Outbox::kCurrentPath], action(1, "req-1"));
  const size_t validSize = storage.files[Outbox::kCurrentPath].size();
  const auto second = encoded(action(2, "req-2"));
  storage.files[Outbox::kCurrentPath].insert(
      storage.files[Outbox::kCurrentPath].end(), second.begin(),
      second.end() - 5);

  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  TEST_ASSERT_EQUAL_UINT(validSize,
                         storage.files[Outbox::kCurrentPath].size());
  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(pending)));
  assertIds(pending, {"req-1"});
}

void test_crc_corruption_inside_journal_is_rejected() {
  MemoryStorage storage;
  appendRaw(storage.files[Outbox::kCurrentPath], action(1, "req-1"));
  appendRaw(storage.files[Outbox::kCurrentPath], action(2, "req-2"));
  storage.files[Outbox::kCurrentPath][OutboxCodec::kHeaderSize + 4] ^= 0x01U;
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::Checksum),
                        static_cast<int>(outbox.begin()));
}

void test_codec_rejects_bounds_and_more_than_ten_thousand_records() {
  QueuedAction invalid = action();
  invalid.clientRequestId = std::string(65, 'x');
  std::vector<uint8_t> bytes;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::InvalidData),
                        static_cast<int>(OutboxCodec::encode(invalid, bytes)));
  invalid = action();
  invalid.uid = "04a1b2c3";
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::InvalidData),
                        static_cast<int>(OutboxCodec::encode(invalid, bytes)));
  invalid = action();
  invalid.signature = std::string(63, 'a');
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::InvalidData),
                        static_cast<int>(OutboxCodec::encode(invalid, bytes)));

  std::vector<uint8_t> journal;
  const auto record = encoded(action());
  journal.reserve(record.size() * (OutboxCodec::kCapacity + 1));
  for (size_t index = 0; index <= OutboxCodec::kCapacity; ++index) {
    journal.insert(journal.end(), record.begin(), record.end());
  }
  std::vector<QueuedAction> decoded;
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OutboxError::Capacity),
      static_cast<int>(OutboxCodec::decodeJournal(journal, decoded)));
}

void test_completion_is_durable_idempotent_and_compacted() {
  MemoryStorage storage;
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.append(action(1, "req-1"))));
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.append(action(2, "req-2"))));
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.complete("req-1")));
  const size_t completionSize = storage.files[Outbox::kCompletionPath].size();
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.complete("req-1")));
  TEST_ASSERT_EQUAL_UINT(completionSize,
                         storage.files[Outbox::kCompletionPath].size());

  Outbox reopened(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(reopened.begin()));
  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(reopened.list(pending)));
  assertIds(pending, {"req-2"});
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(reopened.compact()));
  TEST_ASSERT_FALSE(storage.exists(Outbox::kCompletionPath));
  TEST_ASSERT_FALSE(storage.exists(Outbox::kOldPath));
  TEST_ASSERT_FALSE(storage.exists(Outbox::kNewPath));
  pending.clear();
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(reopened.list(pending)));
  assertIds(pending, {"req-2"});
}

void test_begin_recovers_every_atomic_compaction_cut_window() {
  const std::vector<uint8_t> oldJournal = encoded(action(1, "old"));
  const std::vector<uint8_t> newJournal = encoded(action(2, "new"));

  {
    MemoryStorage storage;
    storage.files[Outbox::kCurrentPath] = oldJournal;
    storage.files[Outbox::kNewPath] = newJournal;
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {"old"});
    TEST_ASSERT_FALSE(storage.exists(Outbox::kNewPath));
  }
  {
    MemoryStorage storage;
    storage.files[Outbox::kOldPath] = oldJournal;
    storage.files[Outbox::kNewPath] = newJournal;
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {"new"});
    TEST_ASSERT_FALSE(storage.exists(Outbox::kOldPath));
  }
  {
    MemoryStorage storage;
    storage.files[Outbox::kOldPath] = oldJournal;
    storage.files[Outbox::kCurrentPath] = newJournal;
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {"new"});
    TEST_ASSERT_FALSE(storage.exists(Outbox::kOldPath));
  }
  {
    MemoryStorage storage;
    storage.files[Outbox::kOldPath] = oldJournal;
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {"old"});
  }
}

void test_corrupt_new_file_never_replaces_valid_old_journal() {
  MemoryStorage storage;
  storage.files[Outbox::kOldPath] = encoded(action(1, "old"));
  storage.files[Outbox::kNewPath] = encoded(action(2, "new"));
  storage.files[Outbox::kNewPath][OutboxCodec::kHeaderSize + 2] ^= 0x01U;
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(pending)));
  assertIds(pending, {"old"});
}

void test_compaction_failures_preserve_the_current_journal() {
  for (const int failure : {1, 2, 3}) {
    MemoryStorage storage;
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.append(action(1, "req-1"))));
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.append(action(2, "req-2"))));
    const auto original = storage.files[Outbox::kCurrentPath];

    if (failure == 1) storage.failWrites = true;
    if (failure == 2) storage.corruptWrites = true;
    if (failure == 3) storage.failRenameCall = 2;
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.compact()));
    storage.failWrites = false;
    storage.corruptWrites = false;
    storage.failRenameCall = 0;

    Outbox reopened(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(reopened.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(reopened.list(pending)));
    assertIds(pending, {"req-1", "req-2"});
    TEST_ASSERT_EQUAL_UINT(original.size(),
                           storage.files[Outbox::kCurrentPath].size());
    TEST_ASSERT_EQUAL_UINT8_ARRAY(original.data(),
                                  storage.files[Outbox::kCurrentPath].data(),
                                  original.size());
  }
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_codec_round_trip_preserves_retry_identity);
  RUN_TEST(test_append_flushes_before_success_and_reopens);
  RUN_TEST(test_truncated_final_record_is_discarded_on_reopen);
  RUN_TEST(test_crc_corruption_inside_journal_is_rejected);
  RUN_TEST(test_codec_rejects_bounds_and_more_than_ten_thousand_records);
  RUN_TEST(test_completion_is_durable_idempotent_and_compacted);
  RUN_TEST(test_begin_recovers_every_atomic_compaction_cut_window);
  RUN_TEST(test_corrupt_new_file_never_replaces_valid_old_journal);
  RUN_TEST(test_compaction_failures_preserve_the_current_journal);
  return UNITY_END();
}
