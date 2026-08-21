#include "openjornada/outbox.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <limits>
#include <string_view>
#include <utility>

namespace openjornada {
namespace {

constexpr std::array<uint8_t, 4> kActionMagic{'O', 'J', 'A', 'C'};
constexpr std::array<uint8_t, 4> kCompletionMagic{'O', 'J', 'D', 'N'};
constexpr uint8_t kFormatVersion = 1;
constexpr size_t kMaxClientRequestId = 64;
constexpr size_t kMaxUid = 20;
constexpr size_t kMaxTimestamp = 35;
constexpr size_t kMaxRebootId = 64;
constexpr size_t kHashHexLength = 64;
constexpr size_t kCopyChunkSize = OutboxCodec::kMaxRecordSize;

enum class JournalKind { Action, Completion };

void appendU16(std::vector<uint8_t>& output, uint16_t value) {
  output.push_back(static_cast<uint8_t>(value & 0xFFU));
  output.push_back(static_cast<uint8_t>((value >> 8U) & 0xFFU));
}

void appendU32(std::vector<uint8_t>& output, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    output.push_back(static_cast<uint8_t>((value >> shift) & 0xFFU));
  }
}

uint16_t readU16(const uint8_t* input) {
  return static_cast<uint16_t>(input[0]) |
         static_cast<uint16_t>(input[1]) << 8U;
}

uint32_t readU32(const uint8_t* input) {
  uint32_t value = 0;
  for (unsigned shift = 0; shift < 32; shift += 8) {
    value |= static_cast<uint32_t>(input[shift / 8]) << shift;
  }
  return value;
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

bool validText(std::string_view value, size_t maximum, bool allowEmpty) {
  if ((!allowEmpty && value.empty()) || value.size() > maximum) return false;
  return std::none_of(value.begin(), value.end(), [](unsigned char byte) {
    return byte == 0 || byte == '\r' || byte == '\n' || byte == '|';
  });
}

bool validUpperHex(std::string_view value, size_t minimum, size_t maximum,
                   bool allowEmpty) {
  if (value.empty()) return allowEmpty;
  if (value.size() < minimum || value.size() > maximum || value.size() % 2 != 0) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](unsigned char byte) {
    return std::isdigit(byte) || (byte >= 'A' && byte <= 'F');
  });
}

bool validLowerHex(std::string_view value, bool allowEmpty) {
  if (value.empty()) return allowEmpty;
  if (value.size() != kHashHexLength) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char byte) {
    return std::isdigit(byte) || (byte >= 'a' && byte <= 'f');
  });
}

bool validCommand(Command command) {
  return static_cast<unsigned>(command) <=
         static_cast<unsigned>(Command::ClockOut);
}

OutboxError validateAction(const QueuedAction& action) {
  if (!validText(action.clientRequestId, kMaxClientRequestId, false) ||
      !validUpperHex(action.uid, 8, kMaxUid, false) ||
      !validCommand(action.command) ||
      !validText(action.deviceCapturedAt, kMaxTimestamp, false) ||
      !validText(action.appliedAt, kMaxTimestamp, true) ||
      !validText(action.clockSyncedAt, kMaxTimestamp, false) ||
      action.deviceSequence == 0 ||
      !validText(action.rebootId, kMaxRebootId, false) ||
      !validLowerHex(action.previousLocalHash, true) ||
      !validLowerHex(action.signature, false)) {
    return OutboxError::InvalidData;
  }
  return OutboxError::None;
}

void appendString(std::vector<uint8_t>& output, std::string_view value) {
  appendU16(output, static_cast<uint16_t>(value.size()));
  output.insert(output.end(), value.begin(), value.end());
}

bool takeByte(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
              uint8_t& output) {
  if (cursor >= end) return false;
  output = input[cursor++];
  return true;
}

bool takeU32(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
             uint32_t& output) {
  if (cursor > end || end - cursor < 4) return false;
  output = readU32(input.data() + cursor);
  cursor += 4;
  return true;
}

bool takeString(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
                size_t maximum, std::string& output) {
  if (cursor > end || end - cursor < 2) return false;
  const size_t length = readU16(input.data() + cursor);
  cursor += 2;
  if (length > maximum || cursor > end || end - cursor < length) return false;
  output.assign(reinterpret_cast<const char*>(input.data() + cursor), length);
  cursor += length;
  return true;
}

const std::array<uint8_t, 4>& magicFor(JournalKind kind) {
  return kind == JournalKind::Action ? kActionMagic : kCompletionMagic;
}

OutboxError framePayload(const std::array<uint8_t, 4>& magic,
                         const std::vector<uint8_t>& payload,
                         std::vector<uint8_t>& output) {
  if (payload.size() > std::numeric_limits<uint32_t>::max() ||
      OutboxCodec::kHeaderSize + payload.size() + OutboxCodec::kCrcSize >
          OutboxCodec::kMaxRecordSize) {
    return OutboxError::Capacity;
  }
  output.clear();
  output.reserve(OutboxCodec::kHeaderSize + payload.size() +
                 OutboxCodec::kCrcSize);
  output.insert(output.end(), magic.begin(), magic.end());
  output.push_back(kFormatVersion);
  appendU32(output, static_cast<uint32_t>(payload.size()));
  output.insert(output.end(), payload.begin(), payload.end());
  appendU32(output, crc32(output.data(), output.size()));
  return OutboxError::None;
}

OutboxError encodeCompletion(const std::string& id,
                             std::vector<uint8_t>& output) {
  if (!validText(id, kMaxClientRequestId, false)) {
    return OutboxError::InvalidData;
  }
  std::vector<uint8_t> payload;
  appendString(payload, id);
  return framePayload(kCompletionMagic, payload, output);
}

OutboxError decodeCompletion(const std::vector<uint8_t>& frame,
                             std::string& output) {
  if (frame.size() < OutboxCodec::kHeaderSize + OutboxCodec::kCrcSize) {
    return OutboxError::Truncated;
  }
  const size_t payloadEnd = frame.size() - OutboxCodec::kCrcSize;
  size_t cursor = OutboxCodec::kHeaderSize;
  std::string candidate;
  if (!takeString(frame, payloadEnd, cursor, kMaxClientRequestId, candidate) ||
      cursor != payloadEnd ||
      !validText(candidate, kMaxClientRequestId, false)) {
    return OutboxError::InvalidData;
  }
  output = std::move(candidate);
  return OutboxError::None;
}

bool sameAction(const QueuedAction& left, const QueuedAction& right) {
  return left.clientRequestId == right.clientRequestId &&
         left.uid == right.uid && left.command == right.command &&
         left.deviceCapturedAt == right.deviceCapturedAt &&
         left.appliedAt == right.appliedAt &&
         left.clockSyncedAt == right.clockSyncedAt &&
         left.deviceSequence == right.deviceSequence &&
         left.rebootId == right.rebootId &&
         left.previousLocalHash == right.previousLocalHash &&
         left.signature == right.signature;
}

struct FrameHeader {
  uint32_t payloadLength = 0;
  size_t frameLength = 0;
};

OutboxError readHeader(const OutboxStorage& storage, const char* path,
                       size_t fileSize, size_t offset, JournalKind kind,
                       FrameHeader& output) {
  if (offset > fileSize || fileSize - offset < OutboxCodec::kHeaderSize) {
    return OutboxError::Truncated;
  }
  std::array<uint8_t, OutboxCodec::kHeaderSize> header{};
  if (!storage.read(path, offset, header.data(), header.size())) {
    return OutboxError::Io;
  }
  const auto& magic = magicFor(kind);
  for (size_t index = 0; index < magic.size(); ++index) {
    if (header[index] != magic[index]) return OutboxError::Magic;
  }
  if (header[4] != kFormatVersion) return OutboxError::Version;
  output.payloadLength = readU32(header.data() + 5);
  const size_t maximumPayload = OutboxCodec::kMaxRecordSize -
                                OutboxCodec::kHeaderSize -
                                OutboxCodec::kCrcSize;
  if (output.payloadLength > maximumPayload) return OutboxError::Length;
  output.frameLength = OutboxCodec::kHeaderSize +
                       static_cast<size_t>(output.payloadLength) +
                       OutboxCodec::kCrcSize;
  return OutboxError::None;
}

OutboxError readCompleteFrame(const OutboxStorage& storage, const char* path,
                              size_t fileSize, size_t offset, JournalKind kind,
                              std::vector<uint8_t>& frame) {
  FrameHeader header;
  OutboxError result = readHeader(storage, path, fileSize, offset, kind, header);
  if (result != OutboxError::None) return result;
  if (header.frameLength > fileSize - offset) return OutboxError::Truncated;
  frame.resize(header.frameLength);
  if (!storage.read(path, offset, frame.data(), frame.size())) {
    return OutboxError::Io;
  }
  const uint32_t expected =
      readU32(frame.data() + frame.size() - OutboxCodec::kCrcSize);
  if (crc32(frame.data(), frame.size() - OutboxCodec::kCrcSize) != expected) {
    return OutboxError::Checksum;
  }
  return OutboxError::None;
}

OutboxError validFrameAt(const OutboxStorage& storage, const char* path,
                         size_t fileSize, size_t offset, JournalKind kind,
                         bool& valid) {
  valid = false;
  std::vector<uint8_t> frame;
  const OutboxError result =
      readCompleteFrame(storage, path, fileSize, offset, kind, frame);
  if (result == OutboxError::Io) return result;
  if (result != OutboxError::None) return OutboxError::None;
  if (kind == JournalKind::Action) {
    QueuedAction action;
    valid = OutboxCodec::decode(frame, action) == OutboxError::None;
  } else {
    std::string id;
    valid = decodeCompletion(frame, id) == OutboxError::None;
  }
  return OutboxError::None;
}

OutboxError hasValidLaterFrame(const OutboxStorage& storage, const char* path,
                               size_t fileSize, size_t after, JournalKind kind,
                               bool& found) {
  found = false;
  if (fileSize < OutboxCodec::kHeaderSize || after >= fileSize) {
    return OutboxError::None;
  }
  const size_t last = fileSize - OutboxCodec::kHeaderSize;
  for (size_t offset = after; offset <= last; ++offset) {
    std::array<uint8_t, 4> prefix{};
    if (!storage.read(path, offset, prefix.data(), prefix.size())) {
      return OutboxError::Io;
    }
    if (prefix == magicFor(kind)) {
      bool valid = false;
      const OutboxError result = validFrameAt(storage, path, fileSize, offset,
                                              kind, valid);
      if (result != OutboxError::None) return result;
      if (valid) {
        found = true;
        return OutboxError::None;
      }
    }
  }
  return OutboxError::None;
}

class ActionReader {
 public:
  ActionReader(const OutboxStorage& storage, const char* path)
      : storage_(storage), path_(path), exists_(storage.exists(path)) {
    if (exists_ && !storage_.size(path_, size_)) error_ = OutboxError::Io;
  }

  OutboxError next(QueuedAction& action, std::vector<uint8_t>& frame,
                   bool& available) {
    available = false;
    if (error_ != OutboxError::None) return error_;
    if (!exists_ || offset_ == size_) return OutboxError::None;
    FrameHeader header;
    OutboxError result = readHeader(storage_, path_, size_, offset_,
                                    JournalKind::Action, header);
    if (result != OutboxError::None) return error_ = result;
    if (header.frameLength > size_ - offset_) {
      bool laterFrame = false;
      result = hasValidLaterFrame(storage_, path_, size_, offset_ + 1,
                                  JournalKind::Action, laterFrame);
      if (result != OutboxError::None) return error_ = result;
      return error_ = laterFrame ? OutboxError::Length
                                 : OutboxError::Truncated;
    }
    result = readCompleteFrame(storage_, path_, size_, offset_,
                               JournalKind::Action, frame);
    if (result != OutboxError::None) return error_ = result;
    result = OutboxCodec::decode(frame, action);
    if (result != OutboxError::None) return error_ = result;
    if (count_ >= OutboxCodec::kCapacity) {
      return error_ = OutboxError::Capacity;
    }
    ++count_;
    offset_ += frame.size();
    available = true;
    return OutboxError::None;
  }

  size_t offset() const { return offset_; }
  size_t count() const { return count_; }

 private:
  const OutboxStorage& storage_;
  const char* path_;
  bool exists_ = false;
  size_t size_ = 0;
  size_t offset_ = 0;
  size_t count_ = 0;
  OutboxError error_ = OutboxError::None;
};

class CompletionReader {
 public:
  CompletionReader(const OutboxStorage& storage, const char* path)
      : storage_(storage), path_(path), exists_(storage.exists(path)) {
    if (exists_ && !storage_.size(path_, size_)) error_ = OutboxError::Io;
  }

  OutboxError next(std::string& id, std::vector<uint8_t>& frame,
                   bool& available) {
    available = false;
    if (error_ != OutboxError::None) return error_;
    if (!exists_ || offset_ == size_) return OutboxError::None;
    FrameHeader header;
    OutboxError result = readHeader(storage_, path_, size_, offset_,
                                    JournalKind::Completion, header);
    if (result != OutboxError::None) return error_ = result;
    if (header.frameLength > size_ - offset_) {
      bool laterFrame = false;
      result = hasValidLaterFrame(storage_, path_, size_, offset_ + 1,
                                  JournalKind::Completion, laterFrame);
      if (result != OutboxError::None) return error_ = result;
      return error_ = laterFrame ? OutboxError::Length
                                 : OutboxError::Truncated;
    }
    result = readCompleteFrame(storage_, path_, size_, offset_,
                               JournalKind::Completion, frame);
    if (result != OutboxError::None) return error_ = result;
    result = decodeCompletion(frame, id);
    if (result != OutboxError::None) return error_ = result;
    if (count_ >= OutboxCodec::kCapacity) {
      return error_ = OutboxError::Capacity;
    }
    ++count_;
    offset_ += frame.size();
    available = true;
    return OutboxError::None;
  }

  size_t offset() const { return offset_; }
  size_t count() const { return count_; }

 private:
  const OutboxStorage& storage_;
  const char* path_;
  bool exists_ = false;
  size_t size_ = 0;
  size_t offset_ = 0;
  size_t count_ = 0;
  OutboxError error_ = OutboxError::None;
};

struct JournalInspection {
  bool exists = false;
  OutboxError error = OutboxError::NotFound;
  size_t validPrefix = 0;
  size_t count = 0;
};

JournalInspection inspectJournal(const OutboxStorage& storage, const char* path,
                                 JournalKind kind) {
  JournalInspection inspection;
  inspection.exists = storage.exists(path);
  if (!inspection.exists) return inspection;
  std::vector<uint8_t> frame;
  bool available = false;
  if (kind == JournalKind::Action) {
    ActionReader reader(storage, path);
    QueuedAction action;
    while (true) {
      const OutboxError result = reader.next(action, frame, available);
      if (result != OutboxError::None) {
        inspection.error = result;
        inspection.validPrefix = reader.offset();
        inspection.count = reader.count();
        return inspection;
      }
      if (!available) break;
    }
    inspection.validPrefix = reader.offset();
    inspection.count = reader.count();
  } else {
    CompletionReader reader(storage, path);
    std::string id;
    while (true) {
      const OutboxError result = reader.next(id, frame, available);
      if (result != OutboxError::None) {
        inspection.error = result;
        inspection.validPrefix = reader.offset();
        inspection.count = reader.count();
        return inspection;
      }
      if (!available) break;
    }
    inspection.validPrefix = reader.offset();
    inspection.count = reader.count();
  }
  inspection.error = OutboxError::None;
  return inspection;
}

bool removeIfPresent(OutboxStorage& storage, const char* path) {
  return !storage.exists(path) || storage.remove(path);
}

OutboxError verifyJournal(const OutboxStorage& storage, const char* path,
                          JournalKind kind, size_t expectedCount) {
  const JournalInspection inspection = inspectJournal(storage, path, kind);
  if (inspection.error != OutboxError::None) return inspection.error;
  return inspection.count == expectedCount ? OutboxError::None
                                            : OutboxError::InvalidData;
}

OutboxError restoreOld(OutboxStorage& storage, const char* current,
                       const char* old, JournalKind kind,
                       size_t expectedCount) {
  if (!removeIfPresent(storage, current) || !storage.rename(old, current)) {
    return OutboxError::Io;
  }
  return verifyJournal(storage, current, kind, expectedCount);
}

OutboxError activateCandidate(OutboxStorage& storage, const char* candidate,
                              const char* current, const char* other,
                              JournalKind kind, size_t expectedCount) {
  if (!removeIfPresent(storage, current) ||
      !storage.rename(candidate, current)) {
    return OutboxError::Io;
  }
  const OutboxError verified =
      verifyJournal(storage, current, kind, expectedCount);
  if (verified != OutboxError::None) return verified;
  if (!removeIfPresent(storage, other)) return OutboxError::Io;
  return OutboxError::None;
}

OutboxError atomicRepairPrefix(OutboxStorage& storage, const char* current,
                               const char* fresh, const char* old,
                               JournalKind kind, size_t validPrefix,
                               size_t expectedCount) {
  if (!removeIfPresent(storage, fresh) || !removeIfPresent(storage, old) ||
      !storage.writeAndFlush(fresh, {})) {
    return OutboxError::Io;
  }
  std::array<uint8_t, kCopyChunkSize> buffer{};
  for (size_t offset = 0; offset < validPrefix;) {
    const size_t length = std::min(buffer.size(), validPrefix - offset);
    if (!storage.read(current, offset, buffer.data(), length)) {
      return OutboxError::Io;
    }
    const std::vector<uint8_t> chunk(buffer.begin(), buffer.begin() + length);
    if (!storage.appendAndFlush(fresh, chunk)) return OutboxError::Io;
    offset += length;
  }
  OutboxError result = verifyJournal(storage, fresh, kind, expectedCount);
  if (result != OutboxError::None) return result;
  if (!storage.rename(current, old)) return OutboxError::Io;
  if (!storage.rename(fresh, current)) {
    storage.rename(old, current);
    return OutboxError::Io;
  }
  result = verifyJournal(storage, current, kind, expectedCount);
  if (result != OutboxError::None) {
    removeIfPresent(storage, current);
    storage.rename(old, current);
    return result;
  }
  return removeIfPresent(storage, old) ? OutboxError::None : OutboxError::Io;
}

OutboxError recoverJournal(OutboxStorage& storage, const char* current,
                           const char* fresh, const char* old,
                           JournalKind kind) {
  const JournalInspection currentState = inspectJournal(storage, current, kind);
  if (currentState.error == OutboxError::None) {
    if (!removeIfPresent(storage, fresh) || !removeIfPresent(storage, old)) {
      return OutboxError::Io;
    }
    return OutboxError::None;
  }
  const JournalInspection freshState = inspectJournal(storage, fresh, kind);
  const JournalInspection oldState = inspectJournal(storage, old, kind);

  if (currentState.error == OutboxError::Truncated &&
      oldState.error != OutboxError::None) {
    return atomicRepairPrefix(storage, current, fresh, old, kind,
                              currentState.validPrefix, currentState.count);
  }
  if (!currentState.exists && freshState.error == OutboxError::None) {
    return activateCandidate(storage, fresh, current, old, kind,
                             freshState.count);
  }
  if (oldState.error == OutboxError::None) {
    if (!removeIfPresent(storage, current)) return OutboxError::Io;
    const OutboxError result =
        restoreOld(storage, current, old, kind, oldState.count);
    if (result != OutboxError::None) return result;
    return removeIfPresent(storage, fresh) ? OutboxError::None
                                           : OutboxError::Io;
  }
  if (freshState.error == OutboxError::None) {
    return activateCandidate(storage, fresh, current, old, kind,
                             freshState.count);
  }
  if (!currentState.exists && !freshState.exists && !oldState.exists) {
    return OutboxError::None;
  }
  if (currentState.exists) return currentState.error;
  if (oldState.exists) return oldState.error;
  return freshState.error;
}

struct QueueStats {
  size_t actions = 0;
  size_t completed = 0;
};

template <typename Visitor>
OutboxError scanQueue(const OutboxStorage& storage, Visitor&& visitor,
                      QueueStats& stats) {
  stats = {};
  ActionReader actions(storage, Outbox::kCurrentPath);
  CompletionReader completions(storage, Outbox::kCompletionPath);
  std::vector<uint8_t> actionFrame;
  std::vector<uint8_t> completionFrame;
  bool actionAvailable = false;
  bool completionAvailable = false;

  while (true) {
    std::string completedId;
    OutboxError result =
        completions.next(completedId, completionFrame, completionAvailable);
    if (result != OutboxError::None) return result;
    if (!completionAvailable) break;
    QueuedAction action;
    result = actions.next(action, actionFrame, actionAvailable);
    if (result != OutboxError::None) return result;
    if (!actionAvailable || action.clientRequestId != completedId) {
      return OutboxError::InvalidData;
    }
    ++stats.actions;
    ++stats.completed;
    result = visitor(action, actionFrame, true);
    if (result != OutboxError::None) return result;
  }

  while (true) {
    QueuedAction action;
    const OutboxError result =
        actions.next(action, actionFrame, actionAvailable);
    if (result != OutboxError::None) return result;
    if (!actionAvailable) break;
    ++stats.actions;
    const OutboxError visited = visitor(action, actionFrame, false);
    if (visited != OutboxError::None) return visited;
  }
  return OutboxError::None;
}

OutboxError atomicallyClearCompletions(OutboxStorage& storage) {
  if (!removeIfPresent(storage, Outbox::kCompletionNewPath) ||
      !storage.writeAndFlush(Outbox::kCompletionNewPath, {})) {
    return OutboxError::Io;
  }
  OutboxError result = verifyJournal(storage, Outbox::kCompletionNewPath,
                                     JournalKind::Completion, 0);
  if (result != OutboxError::None) return result;
  if (!removeIfPresent(storage, Outbox::kCompletionOldPath)) {
    return OutboxError::Io;
  }
  const bool hadCurrent = storage.exists(Outbox::kCompletionPath);
  if (hadCurrent &&
      !storage.rename(Outbox::kCompletionPath, Outbox::kCompletionOldPath)) {
    return OutboxError::Io;
  }
  if (!storage.rename(Outbox::kCompletionNewPath,
                      Outbox::kCompletionPath)) {
    if (hadCurrent) {
      storage.rename(Outbox::kCompletionOldPath, Outbox::kCompletionPath);
    }
    return OutboxError::Io;
  }
  result = verifyJournal(storage, Outbox::kCompletionPath,
                         JournalKind::Completion, 0);
  if (result != OutboxError::None) {
    removeIfPresent(storage, Outbox::kCompletionPath);
    if (hadCurrent) {
      storage.rename(Outbox::kCompletionOldPath, Outbox::kCompletionPath);
    }
    return result;
  }
  return removeIfPresent(storage, Outbox::kCompletionOldPath)
             ? OutboxError::None
             : OutboxError::Io;
}

}  // namespace

OutboxError OutboxCodec::encode(const QueuedAction& action,
                                std::vector<uint8_t>& output) {
  const OutboxError validation = validateAction(action);
  if (validation != OutboxError::None) return validation;
  std::vector<uint8_t> payload;
  appendString(payload, action.clientRequestId);
  appendString(payload, action.uid);
  payload.push_back(static_cast<uint8_t>(action.command));
  appendString(payload, action.deviceCapturedAt);
  appendString(payload, action.appliedAt);
  appendString(payload, action.clockSyncedAt);
  appendU32(payload, action.deviceSequence);
  appendString(payload, action.rebootId);
  appendString(payload, action.previousLocalHash);
  appendString(payload, action.signature);
  return framePayload(kActionMagic, payload, output);
}

OutboxError OutboxCodec::decode(const std::vector<uint8_t>& record,
                                QueuedAction& output) {
  if (record.size() < kHeaderSize + kCrcSize ||
      record.size() > kMaxRecordSize) {
    return OutboxError::Length;
  }
  for (size_t index = 0; index < kActionMagic.size(); ++index) {
    if (record[index] != kActionMagic[index]) return OutboxError::Magic;
  }
  if (record[4] != kFormatVersion) return OutboxError::Version;
  const size_t payloadLength = readU32(record.data() + 5);
  if (payloadLength > kMaxRecordSize - kHeaderSize - kCrcSize) {
    return OutboxError::Length;
  }
  if (kHeaderSize + payloadLength + kCrcSize != record.size()) {
    return OutboxError::Length;
  }
  const uint32_t expected = readU32(record.data() + record.size() - kCrcSize);
  if (crc32(record.data(), record.size() - kCrcSize) != expected) {
    return OutboxError::Checksum;
  }
  const size_t payloadEnd = record.size() - kCrcSize;
  size_t cursor = kHeaderSize;
  uint8_t command = 0;
  QueuedAction candidate;
  if (!takeString(record, payloadEnd, cursor, kMaxClientRequestId,
                  candidate.clientRequestId) ||
      !takeString(record, payloadEnd, cursor, kMaxUid, candidate.uid) ||
      !takeByte(record, payloadEnd, cursor, command) ||
      !takeString(record, payloadEnd, cursor, kMaxTimestamp,
                  candidate.deviceCapturedAt) ||
      !takeString(record, payloadEnd, cursor, kMaxTimestamp,
                  candidate.appliedAt) ||
      !takeString(record, payloadEnd, cursor, kMaxTimestamp,
                  candidate.clockSyncedAt) ||
      !takeU32(record, payloadEnd, cursor, candidate.deviceSequence) ||
      !takeString(record, payloadEnd, cursor, kMaxRebootId,
                  candidate.rebootId) ||
      !takeString(record, payloadEnd, cursor, kHashHexLength,
                  candidate.previousLocalHash) ||
      !takeString(record, payloadEnd, cursor, kHashHexLength,
                  candidate.signature) ||
      cursor != payloadEnd) {
    return OutboxError::InvalidData;
  }
  candidate.command = static_cast<Command>(command);
  const OutboxError validation = validateAction(candidate);
  if (validation != OutboxError::None) return validation;
  output = std::move(candidate);
  return OutboxError::None;
}

OutboxError Outbox::begin() {
  OutboxError result = recoverJournal(storage_, kCurrentPath, kNewPath,
                                      kOldPath, JournalKind::Action);
  if (result != OutboxError::None) return result;
  result = recoverJournal(storage_, kCompletionPath, kCompletionNewPath,
                          kCompletionOldPath, JournalKind::Completion);
  if (result != OutboxError::None) return result;
  QueueStats stats;
  result = scanQueue(storage_, [](const QueuedAction&,
                                  const std::vector<uint8_t>&, bool) {
    return OutboxError::None;
  }, stats);
  if (result != OutboxError::None) return result;
  begun_ = true;
  return OutboxError::None;
}

OutboxError Outbox::list(std::vector<QueuedAction>& output,
                         size_t limit) const {
  output.clear();
  if (!begun_) return OutboxError::Unsupported;
  const size_t boundedLimit = std::min(limit, kMaximumBatchSize);
  QueueStats stats;
  return scanQueue(
      storage_,
      [&](const QueuedAction& action, const std::vector<uint8_t>&,
          bool completed) {
        if (!completed && output.size() < boundedLimit) output.push_back(action);
        return OutboxError::None;
      },
      stats);
}

OutboxError Outbox::append(const QueuedAction& action) {
  if (!begun_) return OutboxError::Unsupported;
  std::vector<uint8_t> encoded;
  OutboxError result = OutboxCodec::encode(action, encoded);
  if (result != OutboxError::None) return result;
  bool exactDuplicate = false;
  bool conflictingDuplicate = false;
  QueueStats stats;
  result = scanQueue(
      storage_,
      [&](const QueuedAction& existing, const std::vector<uint8_t>&, bool) {
        if (existing.clientRequestId == action.clientRequestId) {
          if (sameAction(existing, action)) {
            exactDuplicate = true;
          } else {
            conflictingDuplicate = true;
          }
        }
        return OutboxError::None;
      },
      stats);
  if (result != OutboxError::None) return result;
  if (conflictingDuplicate) return OutboxError::InvalidData;
  if (exactDuplicate) return OutboxError::None;
  if (stats.actions >= OutboxCodec::kCapacity) {
    if (stats.completed == 0) return OutboxError::Capacity;
    result = compact();
    if (result != OutboxError::None) return result;
  }
  return storage_.appendAndFlush(kCurrentPath, encoded) ? OutboxError::None
                                                       : OutboxError::Io;
}

OutboxError Outbox::complete(const std::string& clientRequestId) {
  if (!begun_) return OutboxError::Unsupported;
  if (!validText(clientRequestId, kMaxClientRequestId, false)) {
    return OutboxError::InvalidData;
  }
  bool alreadyCompleted = false;
  std::string firstPending;
  QueueStats stats;
  OutboxError result = scanQueue(
      storage_,
      [&](const QueuedAction& action, const std::vector<uint8_t>&,
          bool completed) {
        if (completed && action.clientRequestId == clientRequestId) {
          alreadyCompleted = true;
        }
        if (!completed && firstPending.empty()) {
          firstPending = action.clientRequestId;
        }
        return OutboxError::None;
      },
      stats);
  if (result != OutboxError::None) return result;
  if (alreadyCompleted) return OutboxError::None;
  if (firstPending.empty()) return OutboxError::NotFound;
  if (firstPending != clientRequestId) return OutboxError::InvalidData;
  std::vector<uint8_t> completion;
  result = encodeCompletion(clientRequestId, completion);
  if (result != OutboxError::None) return result;
  return storage_.appendAndFlush(kCompletionPath, completion)
             ? OutboxError::None
             : OutboxError::Io;
}

OutboxError Outbox::compact() {
  if (!begun_) return OutboxError::Unsupported;
  if (!removeIfPresent(storage_, kNewPath) ||
      !storage_.writeAndFlush(kNewPath, {})) {
    return OutboxError::Io;
  }
  QueueStats stats;
  size_t copied = 0;
  OutboxError result = scanQueue(
      storage_,
      [&](const QueuedAction&, const std::vector<uint8_t>& frame,
          bool completed) {
        if (completed) return OutboxError::None;
        if (!storage_.appendAndFlush(kNewPath, frame)) return OutboxError::Io;
        ++copied;
        return OutboxError::None;
      },
      stats);
  if (result != OutboxError::None) return result;
  result = verifyJournal(storage_, kNewPath, JournalKind::Action, copied);
  if (result != OutboxError::None) return result;

  // Clearing completions first can only cause idempotent re-sends if power is
  // lost before the action journal swap; it can never create a chain hole.
  result = atomicallyClearCompletions(storage_);
  if (result != OutboxError::None) return result;

  if (!removeIfPresent(storage_, kOldPath)) return OutboxError::Io;
  const bool hadCurrent = storage_.exists(kCurrentPath);
  if (hadCurrent && !storage_.rename(kCurrentPath, kOldPath)) {
    return OutboxError::Io;
  }
  if (!storage_.rename(kNewPath, kCurrentPath)) {
    if (hadCurrent) storage_.rename(kOldPath, kCurrentPath);
    return OutboxError::Io;
  }
  result = verifyJournal(storage_, kCurrentPath, JournalKind::Action, copied);
  if (result != OutboxError::None) {
    removeIfPresent(storage_, kCurrentPath);
    if (hadCurrent) storage_.rename(kOldPath, kCurrentPath);
    return result;
  }
  return removeIfPresent(storage_, kOldPath) ? OutboxError::None
                                             : OutboxError::Io;
}

}  // namespace openjornada
