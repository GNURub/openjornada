#include "openjornada/sync_engine.hpp"

#include <algorithm>

namespace openjornada {
namespace {

bool deadlineReached(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

uint32_t retryDelay(uint8_t attempt) {
  constexpr uint32_t delays[] = {2000U, 4000U, 8000U, 16000U, 30000U};
  return delays[std::min<size_t>(attempt, std::size(delays) - 1U)];
}

}  // namespace

std::vector<QueuedAction> SyncEngine::nextBatch(
    const std::vector<QueuedAction>& pending, size_t limit) const {
  const size_t bounded =
      std::min({pending.size(), limit, Outbox::kProtocolBatchLimit});
  return {pending.begin(), pending.begin() + bounded};
}

SyncApplyResult SyncEngine::applyResults(
    const std::vector<QueuedAction>& batch, const ApiCallResult& call,
    const SyncResponse& response) const {
  SyncApplyResult result;
  if (!call.ok) {
    result.status =
        (call.failure.retryable || call.failure.code == ApiErrorCode::Transport ||
         call.failure.code == ApiErrorCode::Timeout ||
         call.failure.code == ApiErrorCode::InvalidResponse)
            ? SyncApplyStatus::Retry
            : SyncApplyStatus::Blocked;
    return result;
  }
  if (batch.empty() || response.itemCount != batch.size() ||
      response.itemCount > response.items.size()) {
    result.status = SyncApplyStatus::Invalid;
    return result;
  }
  result.completedRequestIds.reserve(batch.size());
  for (size_t index = 0; index < batch.size(); ++index) {
    const ActionResult& item = response.items[index];
    if (item.clientRequestId.empty() ||
        item.clientRequestId != batch[index].clientRequestId) {
      result.completedRequestIds.clear();
      result.status = SyncApplyStatus::Invalid;
      return result;
    }
    if (item.status == ActionStatus::Rejected) {
      result.status = SyncApplyStatus::Blocked;
      return result;
    }
    result.completedRequestIds.push_back(item.clientRequestId);
  }
  result.status = SyncApplyStatus::Complete;
  return result;
}

void SyncEngine::onTransportFailure(uint32_t nowMs) {
  backoffUntilMs_ = nowMs + retryDelay(retryAttempt_);
  if (retryAttempt_ < 4U) ++retryAttempt_;
}

void SyncEngine::onSuccess() {
  retryAttempt_ = 0;
  backoffUntilMs_ = 0;
}

bool SyncEngine::ready(uint32_t nowMs) const {
  return backoffUntilMs_ == 0 || deadlineReached(nowMs, backoffUntilMs_);
}

WorkKind replayCommand(WorkKind current, Command command) {
  return nextKind(current, command);
}

}  // namespace openjornada
