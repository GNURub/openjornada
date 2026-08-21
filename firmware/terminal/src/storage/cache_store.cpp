#include "openjornada/cache_store.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <limits>
#include <string_view>
#include <unordered_set>
#include <utility>

#ifdef ARDUINO
#include <LittleFS.h>
#include <Preferences.h>
#endif

namespace openjornada {
namespace {

constexpr std::array<uint8_t, 4> kMagic{'O', 'J', 'C', 'A'};
constexpr uint8_t kFormatVersion = 1;
constexpr size_t kCrcSize = 4;
constexpr const char* kSlotAPath = "/cache-a.bin";
constexpr const char* kSlotBPath = "/cache-b.bin";
constexpr const char* kPreferencesNamespace = "openjornada";
constexpr const char* kSlotKey = "cache_slot";
constexpr uint8_t kSlotA = 1;
constexpr uint8_t kSlotB = 2;

void appendU32(std::vector<uint8_t>& output, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    output.push_back(static_cast<uint8_t>((value >> shift) & 0xFFU));
  }
}

void appendI32(std::vector<uint8_t>& output, int32_t value) {
  appendU32(output, static_cast<uint32_t>(value));
}

uint32_t readU32(const std::vector<uint8_t>& input, size_t offset) {
  uint32_t value = 0;
  for (unsigned shift = 0; shift < 32; shift += 8) {
    value |= static_cast<uint32_t>(input[offset + shift / 8]) << shift;
  }
  return value;
}

int32_t readI32(const std::vector<uint8_t>& input, size_t offset) {
  return static_cast<int32_t>(readU32(input, offset));
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

bool validUid(std::string_view uid) {
  if (uid.empty() || uid.size() > CacheCodec::kMaxUid || uid.size() % 2 != 0) {
    return false;
  }
  return std::all_of(uid.begin(), uid.end(), [](unsigned char byte) {
    return std::isdigit(byte) || (byte >= 'A' && byte <= 'F');
  });
}

bool validText(std::string_view value, size_t maximum, bool allowEmpty) {
  if ((!allowEmpty && value.empty()) || value.size() > maximum) return false;
  return std::none_of(value.begin(), value.end(), [](unsigned char byte) {
    return byte == 0 || byte == '\r' || byte == '\n';
  });
}

bool validState(const WorkState& state) {
  const int kind = static_cast<int>(state.kind);
  return kind >= static_cast<int>(WorkKind::Idle) &&
         kind <= static_cast<int>(WorkKind::OnBreak) &&
         state.workedSeconds >= 0 && state.breakSeconds >= 0;
}

CacheError validateSnapshot(const CacheSnapshot& snapshot) {
  if (snapshot.entries.size() > CacheCodec::kCapacity) {
    return CacheError::Capacity;
  }
  std::unordered_set<std::string> employeeIds;
  std::unordered_set<std::string> uids;
  for (const auto& entry : snapshot.entries) {
    if (entry.employeeId.size() > CacheCodec::kMaxEmployeeId ||
        entry.displayName.size() > CacheCodec::kMaxDisplayName) {
      return CacheError::Capacity;
    }
    if (!validText(entry.employeeId, CacheCodec::kMaxEmployeeId, false) ||
        !validText(entry.displayName, CacheCodec::kMaxDisplayName, false) ||
        !validUid(entry.uid) || !validState(entry.state) ||
        !employeeIds.insert(entry.employeeId).second ||
        !uids.insert(entry.uid).second) {
      return CacheError::InvalidData;
    }
  }
  return CacheError::None;
}

void appendString(std::vector<uint8_t>& output, std::string_view value) {
  output.push_back(static_cast<uint8_t>(value.size()));
  output.insert(output.end(), value.begin(), value.end());
}

bool takeByte(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
              uint8_t& value) {
  if (cursor >= end) return false;
  value = input[cursor++];
  return true;
}

bool takeI32(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
             int32_t& value) {
  if (cursor > end || end - cursor < 4) return false;
  value = readI32(input, cursor);
  cursor += 4;
  return true;
}

bool takeString(const std::vector<uint8_t>& input, size_t end, size_t& cursor,
                size_t maximum, std::string& value) {
  uint8_t length = 0;
  if (!takeByte(input, end, cursor, length) || length > maximum ||
      cursor > end || end - cursor < length) {
    return false;
  }
  value.assign(reinterpret_cast<const char*>(input.data() + cursor), length);
  cursor += length;
  return true;
}

#ifdef ARDUINO
bool readSelector(CacheSelector& selector) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, true)) return false;
  if (!preferences.isKey(kSlotKey)) {
    selector = CacheSelector::Missing;
    preferences.end();
    return true;
  }
  const uint8_t stored = preferences.getUChar(kSlotKey, 0);
  preferences.end();
  selector = stored == kSlotA   ? CacheSelector::A
             : stored == kSlotB ? CacheSelector::B
                                : CacheSelector::Corrupt;
  return true;
}

bool selectSlot(uint8_t slot) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool saved = preferences.putUChar(kSlotKey, slot) == sizeof(slot);
  preferences.end();
  return saved;
}

const char* slotPath(uint8_t slot) {
  return slot == kSlotA ? kSlotAPath : kSlotBPath;
}

CacheError readSlot(uint8_t slot, CacheSnapshot& output) {
  const char* path = slotPath(slot);
  if (!LittleFS.exists(path)) return CacheError::NotFound;
  File file = LittleFS.open(path, "r");
  if (!file) return CacheError::Io;
  const size_t length = file.size();
  if (length > CacheCodec::kMaxEncodedSize) {
    file.close();
    return CacheError::Length;
  }
  std::vector<uint8_t> bytes(length);
  const size_t read = file.read(bytes.data(), bytes.size());
  file.close();
  if (read != length) return CacheError::Io;
  return CacheCodec::decode(bytes, output);
}

uint8_t storedSlot(CacheSlot slot) {
  return slot == CacheSlot::A ? kSlotA : kSlotB;
}

CacheSlot selectorSlot(CacheSelector selector) {
  if (selector == CacheSelector::A) return CacheSlot::A;
  if (selector == CacheSelector::B) return CacheSlot::B;
  return CacheSlot::None;
}

struct CacheInspection {
  CacheSelector selector = CacheSelector::Missing;
  CacheSnapshot slotA;
  CacheSnapshot slotB;
  CacheError errorA = CacheError::NotFound;
  CacheError errorB = CacheError::NotFound;
  CacheSelection selection{CacheSlot::None, false};
};

CacheError inspectCache(CacheInspection& inspection) {
  if (!readSelector(inspection.selector)) return CacheError::Io;
  inspection.errorA = readSlot(kSlotA, inspection.slotA);
  inspection.errorB = readSlot(kSlotB, inspection.slotB);
  inspection.selection = selectCacheSlot(
      inspection.selector,
      {inspection.errorA == CacheError::None, inspection.slotA.revision},
      {inspection.errorB == CacheError::None, inspection.slotB.revision});
  return CacheError::None;
}

CacheError noValidSnapshotError(const CacheInspection& inspection) {
  const CacheSlot selected = selectorSlot(inspection.selector);
  if (selected == CacheSlot::A && inspection.errorA != CacheError::NotFound) {
    return inspection.errorA;
  }
  if (selected == CacheSlot::B && inspection.errorB != CacheError::NotFound) {
    return inspection.errorB;
  }
  if (inspection.errorA != CacheError::NotFound) return inspection.errorA;
  if (inspection.errorB != CacheError::NotFound) return inspection.errorB;
  return CacheError::NotFound;
}
#endif

}  // namespace

CacheSelection selectCacheSlot(CacheSelector selector,
                               CacheSlotCandidate slotA,
                               CacheSlotCandidate slotB) {
  CacheSlot selected = CacheSlot::None;
  if (slotA.valid && slotB.valid) {
    if (slotA.revision > slotB.revision) {
      selected = CacheSlot::A;
    } else if (slotB.revision > slotA.revision) {
      selected = CacheSlot::B;
    } else if (selector == CacheSelector::B) {
      selected = CacheSlot::B;
    } else {
      selected = CacheSlot::A;
    }
  } else if (slotA.valid) {
    selected = CacheSlot::A;
  } else if (slotB.valid) {
    selected = CacheSlot::B;
  }

  const CacheSlot pointed = selector == CacheSelector::A   ? CacheSlot::A
                            : selector == CacheSelector::B ? CacheSlot::B
                                                           : CacheSlot::None;
  return {selected, selected != CacheSlot::None && selected != pointed};
}

CacheError CacheCodec::encode(const CacheSnapshot& snapshot,
                              std::vector<uint8_t>& output) {
  output.clear();
  const CacheError validation = validateSnapshot(snapshot);
  if (validation != CacheError::None) return validation;

  std::vector<uint8_t> payload;
  payload.reserve(1 + snapshot.entries.size() * 32);
  payload.push_back(static_cast<uint8_t>(snapshot.entries.size()));
  for (const auto& entry : snapshot.entries) {
    appendString(payload, entry.employeeId);
    appendString(payload, entry.displayName);
    appendString(payload, entry.uid);
    payload.push_back(static_cast<uint8_t>(entry.state.kind));
    appendI32(payload, entry.state.workedSeconds);
    appendI32(payload, entry.state.breakSeconds);
    uint8_t flags = 0;
    if (entry.state.longShift) flags |= 0x01U;
    if (entry.state.staleBreak) flags |= 0x02U;
    payload.push_back(flags);
  }
  if (payload.size() > std::numeric_limits<uint32_t>::max() ||
      kHeaderSize + payload.size() + kCrcSize > kMaxEncodedSize) {
    return CacheError::Capacity;
  }

  output.reserve(kHeaderSize + payload.size() + kCrcSize);
  output.insert(output.end(), kMagic.begin(), kMagic.end());
  output.push_back(kFormatVersion);
  appendU32(output, snapshot.revision);
  appendU32(output, static_cast<uint32_t>(payload.size()));
  output.insert(output.end(), payload.begin(), payload.end());
  appendU32(output, crc32(output.data(), output.size()));
  return CacheError::None;
}

CacheError CacheCodec::decode(const std::vector<uint8_t>& input,
                              CacheSnapshot& output) {
  if (input.size() < kHeaderSize + kCrcSize) return CacheError::Truncated;
  if (input.size() > kMaxEncodedSize) return CacheError::Length;
  for (size_t index = 0; index < kMagic.size(); ++index) {
    if (input[index] != kMagic[index]) return CacheError::Magic;
  }
  if (input[4] != kFormatVersion) return CacheError::Version;
  const uint32_t payloadLength = readU32(input, 9);
  if (payloadLength > kMaxEncodedSize) {
    return CacheError::Length;
  }
  const size_t expectedSize =
      kHeaderSize + static_cast<size_t>(payloadLength) + kCrcSize;
  if (input.size() < expectedSize) return CacheError::Truncated;
  if (input.size() > expectedSize) return CacheError::Length;
  const uint32_t expected = readU32(input, input.size() - kCrcSize);
  if (crc32(input.data(), input.size() - kCrcSize) != expected) {
    return CacheError::Checksum;
  }

  const size_t payloadEnd = kHeaderSize + payloadLength;
  size_t cursor = kHeaderSize;
  uint8_t count = 0;
  if (!takeByte(input, payloadEnd, cursor, count)) return CacheError::Truncated;
  if (count > kCapacity) return CacheError::Capacity;

  CacheSnapshot candidate;
  candidate.revision = readU32(input, 5);
  candidate.entries.reserve(count);
  for (uint8_t index = 0; index < count; ++index) {
    CacheEntry entry;
    uint8_t kind = 0;
    uint8_t flags = 0;
    if (!takeString(input, payloadEnd, cursor, kMaxEmployeeId, entry.employeeId) ||
        !takeString(input, payloadEnd, cursor, kMaxDisplayName, entry.displayName) ||
        !takeString(input, payloadEnd, cursor, kMaxUid, entry.uid) ||
        !takeByte(input, payloadEnd, cursor, kind) ||
        !takeI32(input, payloadEnd, cursor, entry.state.workedSeconds) ||
        !takeI32(input, payloadEnd, cursor, entry.state.breakSeconds) ||
        !takeByte(input, payloadEnd, cursor, flags)) {
      return CacheError::Truncated;
    }
    if (kind > static_cast<uint8_t>(WorkKind::OnBreak) || (flags & ~0x03U) != 0) {
      return CacheError::InvalidData;
    }
    entry.state.kind = static_cast<WorkKind>(kind);
    entry.state.longShift = (flags & 0x01U) != 0;
    entry.state.staleBreak = (flags & 0x02U) != 0;
    candidate.entries.push_back(std::move(entry));
  }
  if (cursor != payloadEnd) return CacheError::Length;
  const CacheError validation = validateSnapshot(candidate);
  if (validation != CacheError::None) return validation;
  output = std::move(candidate);
  return CacheError::None;
}

bool CacheStore::begin() {
#ifdef ARDUINO
  return LittleFS.begin(false);
#else
  return false;
#endif
}

bool CacheStore::formatAndInitialize() {
#ifdef ARDUINO
  LittleFS.end();
  if (!LittleFS.format()) return false;
  return LittleFS.begin(false);
#else
  return false;
#endif
}

CacheError CacheStore::load(CacheSnapshot& output) {
#ifdef ARDUINO
  CacheInspection inspection;
  const CacheError inspectResult = inspectCache(inspection);
  if (inspectResult != CacheError::None) return inspectResult;
  if (inspection.selection.slot == CacheSlot::None) {
    return noValidSnapshotError(inspection);
  }
  if (inspection.selection.repairSelector &&
      !selectSlot(storedSlot(inspection.selection.slot))) {
    return CacheError::Io;
  }
  output = inspection.selection.slot == CacheSlot::A
               ? std::move(inspection.slotA)
               : std::move(inspection.slotB);
  return CacheError::None;
#else
  (void)output;
  return CacheError::Unsupported;
#endif
}

CacheError CacheStore::replaceAtomically(const CacheSnapshot& snapshot) {
  std::vector<uint8_t> encoded;
  const CacheError encodeResult = CacheCodec::encode(snapshot, encoded);
  if (encodeResult != CacheError::None) return encodeResult;
#ifdef ARDUINO
  CacheInspection inspection;
  const CacheError inspectResult = inspectCache(inspection);
  if (inspectResult != CacheError::None) return inspectResult;
  if (inspection.selection.repairSelector &&
      !selectSlot(storedSlot(inspection.selection.slot))) {
    return CacheError::Io;
  }

  CacheSlot active = inspection.selection.slot;
  if (active == CacheSlot::None) active = selectorSlot(inspection.selector);
  CacheSlot target = CacheSlot::A;
  if (active == CacheSlot::A) {
    target = CacheSlot::B;
  } else if (active == CacheSlot::None &&
             inspection.errorA != CacheError::NotFound) {
    if (inspection.errorB != CacheError::NotFound) {
      return noValidSnapshotError(inspection);
    }
    target = CacheSlot::B;
  }

  const uint8_t targetValue = storedSlot(target);
  const char* path = slotPath(targetValue);
  File file = LittleFS.open(path, "w");
  if (!file) return CacheError::Io;
  const size_t written = file.write(encoded.data(), encoded.size());
  file.flush();
  file.close();
  if (written != encoded.size()) {
    LittleFS.remove(path);
    return CacheError::Io;
  }

  CacheSnapshot verified;
  const CacheError verifyResult = readSlot(targetValue, verified);
  if (verifyResult != CacheError::None) {
    LittleFS.remove(path);
    return verifyResult;
  }
  if (!selectSlot(targetValue)) return CacheError::Io;
  return CacheError::None;
#else
  (void)snapshot;
  return CacheError::Unsupported;
#endif
}

bool CacheStore::clear() {
#ifdef ARDUINO
  const bool aRemoved =
      !LittleFS.exists(kSlotAPath) || LittleFS.remove(kSlotAPath);
  const bool bRemoved =
      !LittleFS.exists(kSlotBPath) || LittleFS.remove(kSlotBPath);
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool selectorRemoved =
      !preferences.isKey(kSlotKey) || preferences.remove(kSlotKey);
  preferences.end();
  return aRemoved && bRemoved && selectorRemoved;
#else
  return false;
#endif
}

}  // namespace openjornada
