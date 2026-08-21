#include "openjornada/outbox.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <limits>
#include <string_view>
#include <unordered_set>
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

void appendU16(std::vector<uint8_t>& output, uint16_t value) {
  output.push_back(static_cast<uint8_t>(value & 0xFFU));
  output.push_back(static_cast<uint8_t>((value >> 8U) & 0xFFU));
}

void appendU32(std::vector<uint8_t>& output, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    output.push_back(static_cast<uint8_t>((value >> shift) & 0xFFU));
  }
}

uint16_t readU16(const std::vector<uint8_t>& input, size_t offset) {
  return static_cast<uint16_t>(input[offset]) |
         static_cast<uint16_t>(input[offset + 1]) << 8U;
}

uint32_t readU32(const std::vector<uint8_t>& input, size_t offset) {
  uint32_t value = 0;
  for (unsigned shift = 0; shift < 32; shift += 8) {
    value |= static_cast<uint32_t>(input[offset + shift / 8]) << shift;
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
  const auto value = static_cast<unsigned>(command);
  return value <= static_cast<unsigned>(Command::ClockOut);
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

bool takeU8(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
            uint8_t& output) {
  if (cursor >= end) return false;
  output = input[cursor++];
  return true;
}

bool takeU32(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
             uint32_t& output) {
  if (cursor > end || end - cursor < 4) return false;
  output = readU32(input, cursor);
  cursor += 4;
  return true;
}

bool takeString(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
                size_t maximum, std::string& output) {
  if (cursor > end || end - cursor < 2) return false;
  const size_t length = readU16(input, cursor);
  cursor += 2;
  if (length > maximum || cursor > end || end - cursor < length) return false;
  output.assign(reinterpret_cast<const char*>(input.data() + cursor), length);
  cursor += length;
  return true;
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

OutboxError inspectFrame(const std::vector<uint8_t>& input, size_t offset,
                         const std::array<uint8_t, 4>& magic,
                         size_t& frameLength) {
  frameLength = 0;
  if (offset > input.size() || input.size() - offset < OutboxCodec::kHeaderSize) {
    return OutboxError::Truncated;
  }
  for (size_t index = 0; index < magic.size(); ++index) {
    if (input[offset + index] != magic[index]) return OutboxError::Magic;
  }
  if (input[offset + 4] != kFormatVersion) return OutboxError::Version;
  const uint32_t payloadLength = readU32(input, offset + 5);
  if (payloadLength > OutboxCodec::kMaxRecordSize - OutboxCodec::kHeaderSize -
                          OutboxCodec::kCrcSize) {
    return OutboxError::Length;
  }
  frameLength = OutboxCodec::kHeaderSize +
                static_cast<size_t>(payloadLength) + OutboxCodec::kCrcSize;
  if (frameLength > input.size() - offset) return OutboxError::Truncated;
  const uint32_t expected =
      readU32(input, offset + frameLength - OutboxCodec::kCrcSize);
  if (crc32(input.data() + offset, frameLength - OutboxCodec::kCrcSize) !=
      expected) {
    return OutboxError::Checksum;
  }
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

OutboxError decodeCompletions(const std::vector<uint8_t>& journal,
                              std::vector<std::string>& output,
                              size_t* validPrefix = nullptr) {
  output.clear();
  size_t cursor = 0;
  while (cursor < journal.size()) {
    size_t frameLength = 0;
    const OutboxError frame =
        inspectFrame(journal, cursor, kCompletionMagic, frameLength);
    if (frame != OutboxError::None) {
      if (validPrefix != nullptr) *validPrefix = cursor;
      return frame;
    }
    const size_t payloadEnd = cursor + frameLength - OutboxCodec::kCrcSize;
    size_t payloadCursor = cursor + OutboxCodec::kHeaderSize;
    std::string id;
    if (!takeString(journal, payloadEnd, payloadCursor, kMaxClientRequestId, id) ||
        payloadCursor != payloadEnd ||
        !validText(id, kMaxClientRequestId, false)) {
      return OutboxError::InvalidData;
    }
    if (output.size() >= OutboxCodec::kCapacity) return OutboxError::Capacity;
    output.push_back(std::move(id));
    cursor += frameLength;
  }
  if (validPrefix != nullptr) *validPrefix = cursor;
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

bool sameActions(const std::vector<QueuedAction>& left,
                 const std::vector<QueuedAction>& right) {
  if (left.size() != right.size()) return false;
  for (size_t index = 0; index < left.size(); ++index) {
    if (!sameAction(left[index], right[index])) return false;
  }
  return true;
}

OutboxError readActionFile(OutboxStorage& storage, const char* path,
                           std::vector<QueuedAction>& actions,
                           bool recoverTruncated) {
  if (!storage.exists(path)) {
    actions.clear();
    return OutboxError::NotFound;
  }
  std::vector<uint8_t> bytes;
  if (!storage.read(path, bytes)) return OutboxError::Io;
  size_t validPrefix = 0;
  bool truncated = false;
  const OutboxError decoded =
      OutboxCodec::decodeJournal(bytes, actions, &validPrefix, &truncated);
  if (decoded != OutboxError::Truncated || !recoverTruncated) return decoded;
  bytes.resize(validPrefix);
  if (!storage.writeAndFlush(path, bytes)) return OutboxError::Io;
  return OutboxError::None;
}

OutboxError readCompletionFile(OutboxStorage& storage,
                               std::vector<std::string>& completed,
                               bool recoverTruncated) {
  if (!storage.exists(Outbox::kCompletionPath)) {
    completed.clear();
    return OutboxError::NotFound;
  }
  std::vector<uint8_t> bytes;
  if (!storage.read(Outbox::kCompletionPath, bytes)) return OutboxError::Io;
  size_t validPrefix = 0;
  const OutboxError decoded = decodeCompletions(bytes, completed, &validPrefix);
  if (decoded != OutboxError::Truncated || !recoverTruncated) return decoded;
  bytes.resize(validPrefix);
  if (!storage.writeAndFlush(Outbox::kCompletionPath, bytes)) {
    return OutboxError::Io;
  }
  return OutboxError::None;
}

bool removeIfPresent(OutboxStorage& storage, const char* path) {
  return !storage.exists(path) || storage.remove(path);
}

OutboxError verifyExact(OutboxStorage& storage, const char* path,
                        std::vector<QueuedAction>& actions) {
  return readActionFile(storage, path, actions, false);
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
  size_t frameLength = 0;
  const OutboxError frame = inspectFrame(record, 0, kActionMagic, frameLength);
  if (frame != OutboxError::None) return frame;
  if (frameLength != record.size()) return OutboxError::Length;
  const size_t payloadEnd = frameLength - kCrcSize;
  size_t cursor = kHeaderSize;
  uint8_t command = 0;
  QueuedAction candidate;
  if (!takeString(record, payloadEnd, cursor, kMaxClientRequestId,
                  candidate.clientRequestId) ||
      !takeString(record, payloadEnd, cursor, kMaxUid, candidate.uid) ||
      !takeU8(record, payloadEnd, cursor, command) ||
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

OutboxError OutboxCodec::decodeJournal(const std::vector<uint8_t>& journal,
                                       std::vector<QueuedAction>& output,
                                       size_t* validPrefix,
                                       bool* truncatedTail) {
  output.clear();
  if (validPrefix != nullptr) *validPrefix = 0;
  if (truncatedTail != nullptr) *truncatedTail = false;
  size_t cursor = 0;
  while (cursor < journal.size()) {
    size_t frameLength = 0;
    const OutboxError frame =
        inspectFrame(journal, cursor, kActionMagic, frameLength);
    if (frame != OutboxError::None) {
      if (validPrefix != nullptr) *validPrefix = cursor;
      if (truncatedTail != nullptr) {
        *truncatedTail = frame == OutboxError::Truncated;
      }
      return frame;
    }
    std::vector<uint8_t> record(journal.begin() + cursor,
                                journal.begin() + cursor + frameLength);
    QueuedAction action;
    const OutboxError decoded = decode(record, action);
    if (decoded != OutboxError::None) return decoded;
    if (output.size() >= kCapacity) return OutboxError::Capacity;
    output.push_back(std::move(action));
    cursor += frameLength;
  }
  if (validPrefix != nullptr) *validPrefix = cursor;
  return OutboxError::None;
}

OutboxError Outbox::begin() {
  std::vector<QueuedAction> current;
  std::vector<QueuedAction> candidate;
  const bool hasCurrent = storage_.exists(kCurrentPath);
  OutboxError currentResult = hasCurrent
                                  ? readActionFile(storage_, kCurrentPath,
                                                   current, false)
                                  : OutboxError::NotFound;

  if (currentResult == OutboxError::None) {
    if (!removeIfPresent(storage_, kNewPath) ||
        !removeIfPresent(storage_, kOldPath)) {
      return OutboxError::Io;
    }
  } else {
    const bool hasNew = storage_.exists(kNewPath);
    const bool hasOld = storage_.exists(kOldPath);
    std::vector<QueuedAction> fresh;
    std::vector<QueuedAction> old;
    const OutboxError newResult =
        hasNew ? verifyExact(storage_, kNewPath, fresh) : OutboxError::NotFound;
    const OutboxError oldResult =
        hasOld ? verifyExact(storage_, kOldPath, old) : OutboxError::NotFound;

    const char* recovery = nullptr;
    if (currentResult == OutboxError::Truncated &&
        oldResult != OutboxError::None) {
      currentResult =
          readActionFile(storage_, kCurrentPath, current, true);
      if (currentResult != OutboxError::None) return currentResult;
      if (!removeIfPresent(storage_, kNewPath) ||
          !removeIfPresent(storage_, kOldPath)) {
        return OutboxError::Io;
      }
    } else if (!hasCurrent && newResult == OutboxError::None) {
      recovery = kNewPath;
    } else if (oldResult == OutboxError::None) {
      recovery = kOldPath;
    } else if (newResult == OutboxError::None) {
      recovery = kNewPath;
    } else if (!hasCurrent && !hasNew && !hasOld) {
      currentResult = OutboxError::None;
    } else if (hasCurrent) {
      return currentResult;
    } else if (hasOld) {
      return oldResult;
    } else {
      return newResult;
    }

    if (recovery != nullptr) {
      if (!removeIfPresent(storage_, kCurrentPath) ||
          !storage_.rename(recovery, kCurrentPath)) {
        return OutboxError::Io;
      }
      if (verifyExact(storage_, kCurrentPath, candidate) != OutboxError::None) {
        return OutboxError::Io;
      }
      if (!removeIfPresent(storage_, kNewPath) ||
          !removeIfPresent(storage_, kOldPath)) {
        return OutboxError::Io;
      }
    }
  }

  std::vector<std::string> completed;
  const OutboxError completionResult =
      readCompletionFile(storage_, completed, true);
  if (completionResult != OutboxError::None &&
      completionResult != OutboxError::NotFound) {
    return completionResult;
  }
  begun_ = true;
  return OutboxError::None;
}

OutboxError Outbox::list(std::vector<QueuedAction>& output) const {
  output.clear();
  if (!begun_) return OutboxError::Unsupported;
  std::vector<QueuedAction> actions;
  OutboxError result =
      readActionFile(storage_, kCurrentPath, actions, false);
  if (result == OutboxError::NotFound) return OutboxError::None;
  if (result != OutboxError::None) return result;
  std::vector<std::string> completions;
  result = readCompletionFile(storage_, completions, false);
  if (result != OutboxError::None && result != OutboxError::NotFound) {
    return result;
  }
  const std::unordered_set<std::string> completed(completions.begin(),
                                                   completions.end());
  output.reserve(actions.size());
  for (auto& action : actions) {
    if (completed.find(action.clientRequestId) == completed.end()) {
      output.push_back(std::move(action));
    }
  }
  return OutboxError::None;
}

OutboxError Outbox::append(const QueuedAction& action) {
  if (!begun_) return OutboxError::Unsupported;
  std::vector<uint8_t> encoded;
  OutboxError result = OutboxCodec::encode(action, encoded);
  if (result != OutboxError::None) return result;

  std::vector<QueuedAction> all;
  result = readActionFile(storage_, kCurrentPath, all, false);
  if (result != OutboxError::None && result != OutboxError::NotFound) {
    return result;
  }
  for (const auto& existing : all) {
    if (existing.clientRequestId == action.clientRequestId) {
      return sameAction(existing, action) ? OutboxError::None
                                          : OutboxError::InvalidData;
    }
  }
  std::vector<std::string> completions;
  result = readCompletionFile(storage_, completions, false);
  if (result != OutboxError::None && result != OutboxError::NotFound) {
    return result;
  }
  if (std::find(completions.begin(), completions.end(), action.clientRequestId) !=
      completions.end()) {
    return OutboxError::None;
  }
  std::vector<QueuedAction> pending;
  result = list(pending);
  if (result != OutboxError::None) return result;
  if (pending.size() >= OutboxCodec::kCapacity) return OutboxError::Capacity;
  if (all.size() >= OutboxCodec::kCapacity) {
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
  std::vector<std::string> completions;
  OutboxError result = readCompletionFile(storage_, completions, false);
  if (result != OutboxError::None && result != OutboxError::NotFound) {
    return result;
  }
  if (std::find(completions.begin(), completions.end(), clientRequestId) !=
      completions.end()) {
    return OutboxError::None;
  }
  std::vector<QueuedAction> actions;
  result = readActionFile(storage_, kCurrentPath, actions, false);
  if (result != OutboxError::None) return result;
  const bool found = std::any_of(actions.begin(), actions.end(),
                                 [&](const QueuedAction& action) {
                                   return action.clientRequestId ==
                                          clientRequestId;
                                 });
  if (!found) return OutboxError::NotFound;
  std::vector<uint8_t> encoded;
  result = encodeCompletion(clientRequestId, encoded);
  if (result != OutboxError::None) return result;
  return storage_.appendAndFlush(kCompletionPath, encoded) ? OutboxError::None
                                                          : OutboxError::Io;
}

OutboxError Outbox::compact() {
  if (!begun_) return OutboxError::Unsupported;
  std::vector<QueuedAction> pending;
  OutboxError result = list(pending);
  if (result != OutboxError::None) return result;

  std::vector<uint8_t> compacted;
  for (const auto& action : pending) {
    std::vector<uint8_t> record;
    result = OutboxCodec::encode(action, record);
    if (result != OutboxError::None) return result;
    compacted.insert(compacted.end(), record.begin(), record.end());
  }
  if (!removeIfPresent(storage_, kNewPath) ||
      !storage_.writeAndFlush(kNewPath, compacted)) {
    return OutboxError::Io;
  }
  std::vector<QueuedAction> verified;
  if (verifyExact(storage_, kNewPath, verified) != OutboxError::None ||
      !sameActions(verified, pending)) {
    removeIfPresent(storage_, kNewPath);
    return OutboxError::Checksum;
  }

  const bool hadCurrent = storage_.exists(kCurrentPath);
  if (!removeIfPresent(storage_, kOldPath)) return OutboxError::Io;
  if (hadCurrent && !storage_.rename(kCurrentPath, kOldPath)) {
    removeIfPresent(storage_, kNewPath);
    return OutboxError::Io;
  }
  if (!storage_.rename(kNewPath, kCurrentPath)) {
    if (hadCurrent) storage_.rename(kOldPath, kCurrentPath);
    return OutboxError::Io;
  }
  verified.clear();
  result = verifyExact(storage_, kCurrentPath, verified);
  if (result != OutboxError::None || !sameActions(verified, pending)) {
    removeIfPresent(storage_, kCurrentPath);
    if (hadCurrent) storage_.rename(kOldPath, kCurrentPath);
    return result == OutboxError::None ? OutboxError::Checksum : result;
  }
  if (!removeIfPresent(storage_, kCompletionPath)) return OutboxError::Io;
  if (!removeIfPresent(storage_, kOldPath)) return OutboxError::Io;
  return OutboxError::None;
}

}  // namespace openjornada
