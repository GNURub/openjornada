#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#ifdef ARDUINO
#include <FS.h>
#endif

#include "openjornada/domain.hpp"

namespace openjornada {

struct QueuedAction {
  std::string clientRequestId;
  std::string uid;
  Command command = Command::ClockIn;
  std::string deviceCapturedAt;
  std::string appliedAt;
  std::string clockSyncedAt;
  uint32_t deviceSequence = 0;
  std::string rebootId;
  std::string previousLocalHash;
  std::string signature;
};

enum class OutboxError {
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

class OutboxCodec {
 public:
  static constexpr size_t kCapacity = 10000;
  static constexpr size_t kHeaderSize = 9;
  static constexpr size_t kCrcSize = 4;
  static constexpr size_t kMaxRecordSize = 1024;

  static OutboxError encode(const QueuedAction& action,
                            std::vector<uint8_t>& output);
  static OutboxError decode(const std::vector<uint8_t>& record,
                            QueuedAction& output);
};

struct OutboxReadiness {
  bool operational = false;
  size_t pendingForSafety = OutboxCodec::kCapacity;
};

OutboxReadiness assessOutboxReadiness(bool storageMounted,
                                      OutboxError beginResult,
                                      OutboxError pendingResult,
                                      size_t pendingCount);

class OutboxStorage {
 public:
  virtual ~OutboxStorage() = default;
  virtual bool exists(const char* path) const = 0;
  virtual bool size(const char* path, size_t& output) const = 0;
  // Reads exactly length bytes. Production callers never request >1 frame.
  virtual bool read(const char* path, size_t offset, uint8_t* output,
                    size_t length) const = 0;
  // Implementations must durably flush bytes before reporting success.
  virtual bool appendAndFlush(const char* path,
                              const std::vector<uint8_t>& bytes) = 0;
  virtual bool writeAndFlush(const char* path,
                             const std::vector<uint8_t>& bytes) = 0;
  virtual bool remove(const char* path) = 0;
  virtual bool rename(const char* from, const char* to) = 0;
};

class Outbox {
 public:
  static constexpr const char* kCurrentPath = "/outbox.bin";
  static constexpr const char* kNewPath = "/outbox.new";
  static constexpr const char* kOldPath = "/outbox.old";
  static constexpr const char* kCompletionPath = "/outbox.done";
  static constexpr const char* kCompletionNewPath = "/outbox.done.new";
  static constexpr const char* kCompletionOldPath = "/outbox.done.old";
  static constexpr size_t kProtocolBatchLimit = 500;
  static constexpr size_t kMaxInMemoryBatch = 50;
  static constexpr size_t kDefaultBatchSize = kMaxInMemoryBatch;

  explicit Outbox(OutboxStorage& storage) : storage_(storage) {}

  OutboxError begin();
  OutboxError append(const QueuedAction& action);
  OutboxError list(std::vector<QueuedAction>& output,
                   size_t limit = kDefaultBatchSize) const;
  OutboxError pendingCount(size_t& output) const;
  OutboxError complete(const std::string& clientRequestId);
  OutboxError compact();

 private:
  OutboxStorage& storage_;
  bool begun_ = false;
};

#ifdef ARDUINO
class LittleFsOutboxStorage final : public OutboxStorage {
 public:
  ~LittleFsOutboxStorage() override;
  bool begin();
  void end();
  bool exists(const char* path) const override;
  bool size(const char* path, size_t& output) const override;
  bool read(const char* path, size_t offset, uint8_t* output,
            size_t length) const override;
  bool appendAndFlush(const char* path,
                      const std::vector<uint8_t>& bytes) override;
  bool writeAndFlush(const char* path,
                     const std::vector<uint8_t>& bytes) override;
  bool remove(const char* path) override;
  bool rename(const char* from, const char* to) override;

 private:
  File* openReadSession(const char* path) const;
  void closeReadSession(const char* path) const;
  void closeReadSessions() const;
  mutable std::array<File, 2> readFiles_;
  mutable std::array<std::string, 2> readPaths_;
  mutable size_t nextReadSlot_ = 0;
};
#endif

}  // namespace openjornada
