#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "openjornada/api_client.hpp"

namespace openjornada {

enum class SyncApplyStatus { Complete, Retry, Blocked, Invalid };

struct SyncApplyResult {
  SyncApplyStatus status = SyncApplyStatus::Invalid;
  std::vector<std::string> completedRequestIds;
};

class SyncEngine {
 public:
  std::vector<QueuedAction> nextBatch(
      const std::vector<QueuedAction>& pending,
      size_t limit = Outbox::kProtocolBatchLimit) const;
  SyncApplyResult applyResults(const std::vector<QueuedAction>& batch,
                               const ApiCallResult& call,
                               const SyncResponse& response) const;

  void onTransportFailure(uint32_t nowMs);
  void onSuccess();
  bool ready(uint32_t nowMs) const;
  uint32_t backoffUntil() const { return backoffUntilMs_; }

 private:
  uint8_t retryAttempt_ = 0;
  uint32_t backoffUntilMs_ = 0;
};

WorkKind replayCommand(WorkKind current, Command command);

}  // namespace openjornada
