#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "openjornada/domain.hpp"

namespace openjornada {

struct CacheEntry {
  std::string employeeId;
  std::string displayName;
  std::string uid;
  WorkState state;
  std::string stateSince;
};

struct CacheSnapshot {
  uint32_t revision = 0;
  std::vector<CacheEntry> entries;
  std::string terminalId;
  std::string configFingerprint;
};

enum class CacheError {
  None,
  NotFound,
  Magic,
  Version,
  Truncated,
  Length,
  Checksum,
  Capacity,
  InvalidData,
  Io,
  Unsupported,
};

enum class CacheSlot { None, A, B };
enum class CacheSelector { Missing, A, B, Corrupt };

struct CacheSlotCandidate {
  bool valid;
  uint32_t revision;
};

struct CacheSelection {
  CacheSlot slot;
  bool repairSelector;
};

CacheSelection selectCacheSlot(CacheSelector selector,
                               CacheSlotCandidate slotA,
                               CacheSlotCandidate slotB);

class CacheCodec {
 public:
  static constexpr size_t kCapacity = 30;
  static constexpr size_t kHeaderSize = 13;
  static constexpr size_t kMaxEmployeeId = 64;
  static constexpr size_t kMaxDisplayName = 96;
  static constexpr size_t kMaxUid = 20;
  static constexpr size_t kMaxTimestamp = 64;
  static constexpr size_t kMaxTerminalId = 64;
  static constexpr size_t kFingerprintLength = 64;
  static constexpr size_t kMaxEncodedSize = 8192;

  static CacheError encode(const CacheSnapshot& snapshot,
                           std::vector<uint8_t>& output);
  static CacheError decode(const std::vector<uint8_t>& input,
                           CacheSnapshot& output);
};

class CacheStore {
 public:
  virtual ~CacheStore() = default;
  // Mounts an existing filesystem and never formats on failure.
  virtual bool begin();
  // Destructive operation reserved for explicit first-use or factory reset.
  virtual bool formatAndInitialize();
  virtual CacheError load(CacheSnapshot& output);
  virtual CacheError replaceAtomically(const CacheSnapshot& snapshot);
  virtual bool clear();
};

}  // namespace openjornada
