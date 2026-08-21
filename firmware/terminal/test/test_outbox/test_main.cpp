#include <unity.h>

#include <algorithm>
#include <array>
#include <cstring>
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
  mutable size_t maximumRead = 0;
  mutable bool oversizedRead = false;
  size_t readLimit = OutboxCodec::kMaxRecordSize;
  size_t renameCalls = 0;
  size_t failRenameCall = 0;
  size_t corruptRenameCall = 0;
  bool failWrites = false;
  std::string corruptAppendPath;
  std::string corruptWritePath;
  bool inPlaceRewrite = false;

  bool exists(const char* path) const override {
    return files.find(path) != files.end();
  }

  bool size(const char* path, size_t& output) const override {
    const auto found = files.find(path);
    if (found == files.end()) return false;
    output = found->second.size();
    return true;
  }

  bool read(const char* path, size_t offset, uint8_t* output,
            size_t length) const override {
    maximumRead = std::max(maximumRead, length);
    if (length > readLimit) {
      oversizedRead = true;
      return false;
    }
    const auto found = files.find(path);
    if (found == files.end() || offset > found->second.size() ||
        found->second.size() - offset < length) {
      return false;
    }
    if (length != 0) {
      std::memcpy(output, found->second.data() + offset, length);
    }
    return true;
  }

  bool appendAndFlush(const char* path,
                      const std::vector<uint8_t>& bytes) override {
    auto& file = files[path];
    file.insert(file.end(), bytes.begin(), bytes.end());
    if (corruptAppendPath == path && !bytes.empty()) {
      file[file.size() - bytes.size()] ^= 0x01U;
      corruptAppendPath.clear();
    }
    ++durableAppends;
    return true;
  }

  bool writeAndFlush(const char* path,
                     const std::vector<uint8_t>& bytes) override {
    if (failWrites) return false;
    if ((std::string(path) == Outbox::kCurrentPath ||
         std::string(path) == Outbox::kCompletionPath) &&
        files.find(path) != files.end()) {
      inPlaceRewrite = true;
    }
    files[path] = bytes;
    if (corruptWritePath == path) {
      if (files[path].empty()) {
        files[path].push_back(0xFFU);
      } else {
        files[path][0] ^= 0x01U;
      }
      corruptWritePath.clear();
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
    if (corruptRenameCall != 0 && renameCalls == corruptRenameCall) {
      if (files[to].empty()) {
        files[to].push_back(0xFFU);
      } else {
        files[to][std::min(OutboxCodec::kHeaderSize,
                           files[to].size() - 1)] ^= 0x01U;
      }
    }
    return true;
  }
};

QueuedAction action(uint32_t sequence = 1, std::string id = "req-1") {
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

void appendU32(std::vector<uint8_t>& output, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    output.push_back(static_cast<uint8_t>((value >> shift) & 0xFFU));
  }
}

uint32_t crc32(const uint8_t* bytes, size_t length) {
  uint32_t crc = 0xFFFFFFFFU;
  for (size_t index = 0; index < length; ++index) {
    crc ^= bytes[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      const uint32_t mask = 0U - (crc & 1U);
      crc = (crc >> 1U) ^ (0xEDB88320U & mask);
    }
  }
  return ~crc;
}

std::vector<uint8_t> completionRecord(const std::string& id) {
  std::vector<uint8_t> payload;
  payload.push_back(static_cast<uint8_t>(id.size() & 0xFFU));
  payload.push_back(static_cast<uint8_t>((id.size() >> 8U) & 0xFFU));
  payload.insert(payload.end(), id.begin(), id.end());
  std::vector<uint8_t> frame{'O', 'J', 'D', 'N', 1};
  appendU32(frame, static_cast<uint32_t>(payload.size()));
  frame.insert(frame.end(), payload.begin(), payload.end());
  appendU32(frame, crc32(frame.data(), frame.size()));
  return frame;
}

void appendCompletion(std::vector<uint8_t>& journal, const std::string& id) {
  const auto record = completionRecord(id);
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

void populateActions(MemoryStorage& storage, size_t count,
                     bool completions = false) {
  auto& actions = storage.files[Outbox::kCurrentPath];
  auto& done = storage.files[Outbox::kCompletionPath];
  for (size_t index = 0; index < count; ++index) {
    const std::string id = "req-" + std::to_string(index);
    QueuedAction value = action(static_cast<uint32_t>(index + 1), id);
    if (index != 0) value.previousLocalHash = std::string(64, 'b');
    appendRaw(actions, value);
    if (completions) appendCompletion(done, id);
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
  std::vector<uint8_t> oversized = bytes;
  oversized[5] = 0xFFU;
  oversized[6] = 0xFFU;
  oversized[7] = 0xFFU;
  oversized[8] = 0xFFU;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::Length),
                        static_cast<int>(OutboxCodec::decode(oversized, decoded)));
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

void test_truncated_action_tail_repairs_atomically_without_in_place_write() {
  MemoryStorage storage;
  appendRaw(storage.files[Outbox::kCurrentPath], action(1, "req-1"));
  const auto prefix = storage.files[Outbox::kCurrentPath];
  const auto second = encoded(action(2, "req-2"));
  storage.files[Outbox::kCurrentPath].insert(
      storage.files[Outbox::kCurrentPath].end(), second.begin(),
      second.end() - 5);
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  TEST_ASSERT_FALSE(storage.inPlaceRewrite);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(prefix.data(),
                                storage.files[Outbox::kCurrentPath].data(),
                                prefix.size());
  TEST_ASSERT_EQUAL_UINT(prefix.size(),
                         storage.files[Outbox::kCurrentPath].size());
}

void test_truncated_completion_tail_repairs_with_done_new_old() {
  MemoryStorage storage;
  appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
  appendRaw(storage.files[Outbox::kCurrentPath], action(2, "B"));
  appendCompletion(storage.files[Outbox::kCompletionPath], "A");
  const auto prefix = storage.files[Outbox::kCompletionPath];
  const auto second = completionRecord("B");
  storage.files[Outbox::kCompletionPath].insert(
      storage.files[Outbox::kCompletionPath].end(), second.begin(),
      second.end() - 2);
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  TEST_ASSERT_FALSE(storage.inPlaceRewrite);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(prefix.data(),
                                storage.files[Outbox::kCompletionPath].data(),
                                prefix.size());
  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(pending)));
  assertIds(pending, {"B"});
}

void test_tail_repair_failures_preserve_recoverable_prefix() {
  for (size_t failure = 1; failure <= 4; ++failure) {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
    const auto prefix = storage.files[Outbox::kCurrentPath];
    const auto tail = encoded(action(2, "B"));
    storage.files[Outbox::kCurrentPath].insert(
        storage.files[Outbox::kCurrentPath].end(), tail.begin(), tail.end() - 3);
    if (failure == 1) storage.failRenameCall = 1;
    if (failure == 2) storage.failRenameCall = 2;
    if (failure == 3) storage.corruptAppendPath = Outbox::kNewPath;
    if (failure == 4) storage.corruptRenameCall = 2;
    Outbox failed(storage);
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(OutboxError::None),
                          static_cast<int>(failed.begin()));
    storage.failRenameCall = 0;
    storage.corruptRenameCall = 0;
    storage.corruptAppendPath.clear();
    Outbox recovered(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.list(pending)));
    assertIds(pending, {"A"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(prefix.data(),
                                  storage.files[Outbox::kCurrentPath].data(),
                                  prefix.size());
  }
}

void test_completion_tail_failures_preserve_recoverable_prefix() {
  for (size_t failure = 1; failure <= 4; ++failure) {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
    appendRaw(storage.files[Outbox::kCurrentPath], action(2, "B"));
    appendCompletion(storage.files[Outbox::kCompletionPath], "A");
    const auto prefix = storage.files[Outbox::kCompletionPath];
    const auto tail = completionRecord("B");
    storage.files[Outbox::kCompletionPath].insert(
        storage.files[Outbox::kCompletionPath].end(), tail.begin(),
        tail.end() - 2);
    if (failure == 1) storage.failRenameCall = 1;
    if (failure == 2) storage.failRenameCall = 2;
    if (failure == 3) {
      storage.corruptAppendPath = Outbox::kCompletionNewPath;
    }
    if (failure == 4) storage.corruptRenameCall = 2;
    Outbox failed(storage);
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(OutboxError::None),
                          static_cast<int>(failed.begin()));
    storage.failRenameCall = 0;
    storage.corruptRenameCall = 0;
    storage.corruptAppendPath.clear();
    Outbox recovered(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.list(pending)));
    assertIds(pending, {"B"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(
        prefix.data(), storage.files[Outbox::kCompletionPath].data(),
        prefix.size());
    TEST_ASSERT_FALSE(storage.inPlaceRewrite);
  }
}

void test_only_old_truncated_is_promoted_for_actions_and_completions() {
  {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kOldPath], action(1, "A"));
    const auto prefix = storage.files[Outbox::kOldPath];
    const auto tail = encoded(action(2, "B"));
    storage.files[Outbox::kOldPath].insert(
        storage.files[Outbox::kOldPath].end(), tail.begin(), tail.end() - 4);
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    TEST_ASSERT_FALSE(storage.exists(Outbox::kOldPath));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(prefix.data(),
                                  storage.files[Outbox::kCurrentPath].data(),
                                  prefix.size());
  }
  {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
    appendRaw(storage.files[Outbox::kCurrentPath], action(2, "B"));
    appendCompletion(storage.files[Outbox::kCompletionOldPath], "A");
    const auto prefix = storage.files[Outbox::kCompletionOldPath];
    const auto tail = completionRecord("B");
    storage.files[Outbox::kCompletionOldPath].insert(
        storage.files[Outbox::kCompletionOldPath].end(), tail.begin(),
        tail.end() - 2);
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {"B"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(
        prefix.data(), storage.files[Outbox::kCompletionPath].data(),
        prefix.size());
  }
}

void test_invalid_current_and_truncated_old_converge_to_old_prefix() {
  {
    MemoryStorage storage;
    storage.files[Outbox::kCurrentPath] = encoded(action(9, "corrupt"));
    storage.files[Outbox::kCurrentPath][OutboxCodec::kHeaderSize] ^= 0x01U;
    appendRaw(storage.files[Outbox::kOldPath], action(1, "A"));
    const auto prefix = storage.files[Outbox::kOldPath];
    const auto tail = encoded(action(2, "B"));
    storage.files[Outbox::kOldPath].insert(
        storage.files[Outbox::kOldPath].end(), tail.begin(), tail.end() - 3);
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {"A"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(prefix.data(),
                                  storage.files[Outbox::kCurrentPath].data(),
                                  prefix.size());
  }
  {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
    appendRaw(storage.files[Outbox::kCurrentPath], action(2, "B"));
    storage.files[Outbox::kCompletionPath] = completionRecord("A");
    storage.files[Outbox::kCompletionPath][OutboxCodec::kHeaderSize] ^= 0x01U;
    appendCompletion(storage.files[Outbox::kCompletionOldPath], "A");
    const auto prefix = storage.files[Outbox::kCompletionOldPath];
    const auto tail = completionRecord("B");
    storage.files[Outbox::kCompletionOldPath].insert(
        storage.files[Outbox::kCompletionOldPath].end(), tail.begin(),
        tail.end() - 2);
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {"B"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(
        prefix.data(), storage.files[Outbox::kCompletionPath].data(),
        prefix.size());
  }
}

void test_cuts_while_promoting_truncated_old_always_recover() {
  for (size_t failure = 1; failure <= 4; ++failure) {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kOldPath], action(1, "A"));
    const auto prefix = storage.files[Outbox::kOldPath];
    const auto tail = encoded(action(2, "B"));
    storage.files[Outbox::kOldPath].insert(
        storage.files[Outbox::kOldPath].end(), tail.begin(), tail.end() - 3);
    if (failure == 1) storage.failWrites = true;
    if (failure == 2) storage.corruptAppendPath = Outbox::kNewPath;
    if (failure == 3) storage.failRenameCall = 1;
    if (failure == 4) storage.corruptRenameCall = 1;
    Outbox failed(storage);
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(OutboxError::None),
                          static_cast<int>(failed.begin()));
    storage.failWrites = false;
    storage.failRenameCall = 0;
    storage.corruptRenameCall = 0;
    storage.corruptAppendPath.clear();
    Outbox recovered(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.list(pending)));
    assertIds(pending, {"A"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(prefix.data(),
                                  storage.files[Outbox::kCurrentPath].data(),
                                  prefix.size());
  }
  for (size_t failure = 1; failure <= 4; ++failure) {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
    appendRaw(storage.files[Outbox::kCurrentPath], action(2, "B"));
    appendCompletion(storage.files[Outbox::kCompletionOldPath], "A");
    const auto prefix = storage.files[Outbox::kCompletionOldPath];
    const auto tail = completionRecord("B");
    storage.files[Outbox::kCompletionOldPath].insert(
        storage.files[Outbox::kCompletionOldPath].end(), tail.begin(),
        tail.end() - 2);
    if (failure == 1) storage.failWrites = true;
    if (failure == 2) {
      storage.corruptAppendPath = Outbox::kCompletionNewPath;
    }
    if (failure == 3) storage.failRenameCall = 1;
    if (failure == 4) storage.corruptRenameCall = 1;
    Outbox failed(storage);
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(OutboxError::None),
                          static_cast<int>(failed.begin()));
    storage.failWrites = false;
    storage.failRenameCall = 0;
    storage.corruptRenameCall = 0;
    storage.corruptAppendPath.clear();
    Outbox recovered(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(recovered.list(pending)));
    assertIds(pending, {"B"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(
        prefix.data(), storage.files[Outbox::kCompletionPath].data(),
        prefix.size());
  }
}

void test_crc_corruption_inside_journal_is_rejected() {
  MemoryStorage storage;
  appendRaw(storage.files[Outbox::kCurrentPath], action(1, "req-1"));
  appendRaw(storage.files[Outbox::kCurrentPath], action(2, "req-2"));
  const auto original = storage.files[Outbox::kCurrentPath];
  storage.files[Outbox::kCurrentPath][OutboxCodec::kHeaderSize + 4] ^= 0x01U;
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::Checksum),
                        static_cast<int>(outbox.begin()));
  TEST_ASSERT_EQUAL_UINT(original.size(),
                         storage.files[Outbox::kCurrentPath].size());
}

void test_inflated_inner_length_does_not_truncate_a_later_valid_frame() {
  MemoryStorage storage;
  appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
  appendRaw(storage.files[Outbox::kCurrentPath], action(2, "B"));
  auto& journal = storage.files[Outbox::kCurrentPath];
  const auto original = journal;
  const uint32_t inflatedPayload = 900;
  journal[5] = static_cast<uint8_t>(inflatedPayload & 0xFFU);
  journal[6] = static_cast<uint8_t>((inflatedPayload >> 8U) & 0xFFU);
  journal[7] = 0;
  journal[8] = 0;
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::Length),
                        static_cast<int>(outbox.begin()));
  TEST_ASSERT_EQUAL_UINT(original.size(), journal.size());
  TEST_ASSERT_EQUAL_UINT8_ARRAY(original.data() + encoded(action(1, "A")).size(),
                                journal.data() + encoded(action(1, "A")).size(),
                                encoded(action(2, "B")).size());
}

void test_bounds_capacity_and_batch_are_streaming_at_ten_thousand() {
  QueuedAction invalid = action();
  invalid.clientRequestId = std::string(65, 'x');
  std::vector<uint8_t> bytes;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::InvalidData),
                        static_cast<int>(OutboxCodec::encode(invalid, bytes)));
  MemoryStorage storage;
  populateActions(storage, OutboxCodec::kCapacity);
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  std::vector<QueuedAction> batch;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(
                            batch, Outbox::kProtocolBatchLimit)));
  TEST_ASSERT_EQUAL_UINT(Outbox::kMaxInMemoryBatch, batch.size());
  constexpr size_t maximumTextBytes = 64 + 20 + 35 * 3 + 64 + 64 + 64;
  constexpr size_t conservativeAllocatorOverhead = 16 * 9;
  constexpr size_t estimatedBatchBytes =
      Outbox::kMaxInMemoryBatch *
      (sizeof(QueuedAction) + maximumTextBytes +
       conservativeAllocatorOverhead);
  TEST_ASSERT_LESS_OR_EQUAL_UINT(64 * 1024, estimatedBatchBytes);
  TEST_ASSERT_EQUAL_UINT(500, Outbox::kProtocolBatchLimit);
  batch.clear();
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(batch)));
  TEST_ASSERT_EQUAL_UINT(Outbox::kDefaultBatchSize, batch.size());
  TEST_ASSERT_FALSE(storage.oversizedRead);
  TEST_ASSERT_LESS_OR_EQUAL_UINT(OutboxCodec::kMaxRecordSize,
                                 storage.maximumRead);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(OutboxError::Capacity),
      static_cast<int>(outbox.append(action(10001, "overflow"))));
}

void test_ten_thousand_completions_stream_and_compact_before_append() {
  MemoryStorage storage;
  populateActions(storage, OutboxCodec::kCapacity, true);
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  std::vector<QueuedAction> batch;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(batch)));
  TEST_ASSERT_EQUAL_UINT(0, batch.size());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.append(action(10001, "fresh"))));
  batch.clear();
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(batch)));
  assertIds(batch, {"fresh"});
  TEST_ASSERT_FALSE(storage.oversizedRead);
}

void test_completion_must_advance_chronological_prefix_without_chain_holes() {
  MemoryStorage storage;
  QueuedAction a = action(1, "A");
  a.signature = std::string(64, 'a');
  QueuedAction b = action(2, "B");
  b.previousLocalHash = a.signature;
  b.signature = std::string(64, 'b');
  QueuedAction c = action(3, "C");
  c.previousLocalHash = b.signature;
  c.signature = std::string(64, 'c');
  appendRaw(storage.files[Outbox::kCurrentPath], a);
  appendRaw(storage.files[Outbox::kCurrentPath], b);
  appendRaw(storage.files[Outbox::kCurrentPath], c);
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::InvalidData),
                        static_cast<int>(outbox.complete("B")));
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.complete("A")));
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.complete("B")));
  std::vector<QueuedAction> pending;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.list(pending)));
  assertIds(pending, {"C"});
  TEST_ASSERT_EQUAL_STRING(b.signature.c_str(),
                           pending[0].previousLocalHash.c_str());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.complete("A")));
}

void test_action_and_completion_compaction_cut_windows_recover() {
  const auto oldJournal = encoded(action(1, "old"));
  const auto newJournal = encoded(action(2, "new"));
  for (size_t window = 0; window < 4; ++window) {
    MemoryStorage storage;
    if (window == 0) {
      storage.files[Outbox::kCurrentPath] = oldJournal;
      storage.files[Outbox::kNewPath] = newJournal;
    } else if (window == 1) {
      storage.files[Outbox::kOldPath] = oldJournal;
      storage.files[Outbox::kNewPath] = newJournal;
    } else if (window == 2) {
      storage.files[Outbox::kOldPath] = oldJournal;
      storage.files[Outbox::kCurrentPath] = newJournal;
    } else {
      storage.files[Outbox::kOldPath] = oldJournal;
    }
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    assertIds(pending, {window == 0 || window == 3 ? "old" : "new"});
  }
  for (size_t window = 0; window < 4; ++window) {
    MemoryStorage storage;
    appendRaw(storage.files[Outbox::kCurrentPath], action(1, "A"));
    if (window == 0) {
      storage.files[Outbox::kCompletionPath] = completionRecord("A");
      storage.files[Outbox::kCompletionNewPath] = {};
    } else if (window == 1) {
      storage.files[Outbox::kCompletionOldPath] = completionRecord("A");
      storage.files[Outbox::kCompletionNewPath] = {};
    } else if (window == 2) {
      storage.files[Outbox::kCompletionOldPath] = completionRecord("A");
      storage.files[Outbox::kCompletionPath] = {};
    } else {
      storage.files[Outbox::kCompletionOldPath] = completionRecord("A");
    }
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.list(pending)));
    if (window == 0 || window == 3) {
      assertIds(pending, {});
    } else {
      assertIds(pending, {"A"});
    }
  }
}

void test_compaction_write_rename_and_verify_failures_preserve_actions() {
  for (size_t failure = 1; failure <= 5; ++failure) {
    MemoryStorage storage;
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.append(action(1, "A"))));
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.append(action(2, "B"))));
    const auto original = storage.files[Outbox::kCurrentPath];
    if (failure == 1) storage.failWrites = true;
    if (failure == 2) storage.corruptAppendPath = Outbox::kNewPath;
    if (failure == 3) storage.failRenameCall = 2;
    if (failure == 4) storage.failRenameCall = 3;
    if (failure == 5) storage.corruptRenameCall = 3;
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.compact()));
    storage.failWrites = false;
    storage.failRenameCall = 0;
    storage.corruptRenameCall = 0;
    storage.corruptAppendPath.clear();
    Outbox reopened(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(reopened.begin()));
    TEST_ASSERT_EQUAL_UINT(original.size(),
                           storage.files[Outbox::kCurrentPath].size());
    TEST_ASSERT_EQUAL_UINT8_ARRAY(original.data(),
                                  storage.files[Outbox::kCurrentPath].data(),
                                  original.size());
  }
}

void test_completion_clear_failures_preserve_completed_prefix() {
  for (size_t failure = 1; failure <= 4; ++failure) {
    MemoryStorage storage;
    Outbox outbox(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.begin()));
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.append(action(1, "A"))));
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.append(action(2, "B"))));
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.complete("A")));
    const auto completed = storage.files[Outbox::kCompletionPath];
    if (failure == 1) {
      storage.corruptWritePath = Outbox::kCompletionNewPath;
    }
    if (failure == 2) storage.failRenameCall = 1;
    if (failure == 3) storage.failRenameCall = 2;
    if (failure == 4) storage.corruptRenameCall = 2;
    TEST_ASSERT_NOT_EQUAL(static_cast<int>(OutboxError::None),
                          static_cast<int>(outbox.compact()));
    storage.failRenameCall = 0;
    storage.corruptRenameCall = 0;
    storage.corruptWritePath.clear();
    Outbox reopened(storage);
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(reopened.begin()));
    std::vector<QueuedAction> pending;
    TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                          static_cast<int>(reopened.list(pending)));
    assertIds(pending, {"B"});
    TEST_ASSERT_EQUAL_UINT8_ARRAY(
        completed.data(), storage.files[Outbox::kCompletionPath].data(),
        completed.size());
  }
}

void test_pending_count_scans_beyond_the_in_memory_batch() {
  MemoryStorage storage;
  Outbox outbox(storage);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.begin()));
  for (uint32_t index = 1; index <= 75; ++index) {
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(OutboxError::None),
        static_cast<int>(outbox.append(
            action(index, "pending-" + std::to_string(index)))));
  }
  for (uint32_t index = 1; index <= 12; ++index) {
    TEST_ASSERT_EQUAL_INT(
        static_cast<int>(OutboxError::None),
        static_cast<int>(outbox.complete("pending-" + std::to_string(index))));
  }
  size_t pending = 0;
  TEST_ASSERT_EQUAL_INT(static_cast<int>(OutboxError::None),
                        static_cast<int>(outbox.pendingCount(pending)));
  TEST_ASSERT_EQUAL_UINT(63, pending);
}

void test_startup_readiness_blocks_any_mount_begin_or_count_failure() {
  const auto missing = assessOutboxReadiness(
      false, OutboxError::Unsupported, OutboxError::Unsupported, 0);
  TEST_ASSERT_FALSE(missing.operational);
  TEST_ASSERT_EQUAL_UINT32(OutboxCodec::kCapacity,
                           missing.pendingForSafety);

  const auto corrupt = assessOutboxReadiness(
      true, OutboxError::Checksum, OutboxError::Unsupported, 0);
  TEST_ASSERT_FALSE(corrupt.operational);
  TEST_ASSERT_EQUAL_UINT32(OutboxCodec::kCapacity,
                           corrupt.pendingForSafety);

  const auto unreadable = assessOutboxReadiness(
      true, OutboxError::None, OutboxError::Io, 0);
  TEST_ASSERT_FALSE(unreadable.operational);
  TEST_ASSERT_EQUAL_UINT32(OutboxCodec::kCapacity,
                           unreadable.pendingForSafety);

  const auto ready = assessOutboxReadiness(
      true, OutboxError::None, OutboxError::None, 37);
  TEST_ASSERT_TRUE(ready.operational);
  TEST_ASSERT_EQUAL_UINT32(37, ready.pendingForSafety);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_codec_round_trip_preserves_retry_identity);
  RUN_TEST(test_append_flushes_before_success_and_reopens);
  RUN_TEST(test_truncated_action_tail_repairs_atomically_without_in_place_write);
  RUN_TEST(test_truncated_completion_tail_repairs_with_done_new_old);
  RUN_TEST(test_tail_repair_failures_preserve_recoverable_prefix);
  RUN_TEST(test_completion_tail_failures_preserve_recoverable_prefix);
  RUN_TEST(test_only_old_truncated_is_promoted_for_actions_and_completions);
  RUN_TEST(test_invalid_current_and_truncated_old_converge_to_old_prefix);
  RUN_TEST(test_cuts_while_promoting_truncated_old_always_recover);
  RUN_TEST(test_crc_corruption_inside_journal_is_rejected);
  RUN_TEST(test_inflated_inner_length_does_not_truncate_a_later_valid_frame);
  RUN_TEST(test_bounds_capacity_and_batch_are_streaming_at_ten_thousand);
  RUN_TEST(test_ten_thousand_completions_stream_and_compact_before_append);
  RUN_TEST(test_completion_must_advance_chronological_prefix_without_chain_holes);
  RUN_TEST(test_action_and_completion_compaction_cut_windows_recover);
  RUN_TEST(test_compaction_write_rename_and_verify_failures_preserve_actions);
  RUN_TEST(test_completion_clear_failures_preserve_completed_prefix);
  RUN_TEST(test_pending_count_scans_beyond_the_in_memory_batch);
  RUN_TEST(test_startup_readiness_blocks_any_mount_begin_or_count_failure);
  return UNITY_END();
}
