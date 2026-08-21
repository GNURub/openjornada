#include "openjornada/network_worker.hpp"

#include <algorithm>
#include <new>
#include <string_view>

#include "openjornada/config.hpp"

namespace openjornada {
namespace {

bool boundedText(std::string_view value, size_t maximum, bool allowEmpty) {
  if ((!allowEmpty && value.empty()) || value.size() > maximum) return false;
  return std::none_of(value.begin(), value.end(), [](unsigned char byte) {
    return byte == 0 || byte == '\r' || byte == '\n';
  });
}

bool validCredentials(const ApiCredentials& credentials) {
  return boundedText(credentials.baseUrl, kMaxBaseUrlBytes, false) &&
         boundedText(credentials.terminalToken, kMaxTerminalTokenBytes, false) &&
         credentials.terminalToken.rfind("ojterm_", 0) == 0;
}

bool validJob(const NetworkJob& job) {
  if (job.id == 0 || !validCredentials(job.credentials)) return false;
  switch (job.kind) {
    case NetworkJobKind::Bootstrap:
      return job.bootstrap.protocolVersion == kTerminalProtocolVersion &&
             boundedText(job.bootstrap.clientVersion, 64, false) &&
             job.bootstrap.pendingCount <= OutboxCodec::kCapacity;
    case NetworkJobKind::Resolve:
      return boundedText(job.uid, 20, false);
    case NetworkJobKind::Action:
      return boundedText(job.action.clientRequestId, 64, false) &&
             boundedText(job.action.scanContext, 512, false) &&
             boundedText(job.action.deviceCapturedAt, 48, false) &&
             boundedText(job.action.clockSyncedAt, 48, false) &&
             job.action.deviceSequence > 0;
    case NetworkJobKind::Cache:
      return true;
    case NetworkJobKind::OpenAdminSession:
      return job.pin.size() == 4 &&
             std::all_of(job.pin.begin(), job.pin.end(), [](char byte) {
               return byte >= '0' && byte <= '9';
             });
    case NetworkJobKind::CloseAdminSession:
    case NetworkJobKind::Employees:
      return boundedText(job.adminSession, 96, false);
    case NetworkJobKind::AssignEmployee:
      return boundedText(job.adminSession, 96, false) &&
             boundedText(job.employeeId, 64, false) &&
             boundedText(job.uid, 20, false);
    case NetworkJobKind::RevokeEmployee:
      return boundedText(job.adminSession, 96, false) &&
             boundedText(job.employeeId, 64, false);
    case NetworkJobKind::Sync:
      return !job.sync.actions.empty() &&
             job.sync.actions.size() <= kMaxApiSyncItems &&
             job.sync.pendingCount <= OutboxCodec::kCapacity;
  }
  return false;
}

void setMemoryFailure(NetworkResult& output) {
  output.call = {};
  output.call.ok = false;
  output.call.failure.code = ApiErrorCode::QueueFull;
  output.call.failure.retryable = true;
  output.call.failure.safeMessage =
      safeApiErrorMessage(ApiErrorCode::QueueFull);
}

template <typename T>
bool allocatePayload(std::unique_ptr<T>& payload, NetworkResult& output) {
  payload.reset(new (std::nothrow) T());
  if (payload != nullptr) return true;
  setMemoryFailure(output);
  return false;
}

}  // namespace

uint32_t NetworkWorkerPolicy::timeoutMs(NetworkJobKind kind) {
  return kind == NetworkJobKind::Sync ? 30000U : 10000U;
}

uint32_t NetworkWorkerPolicy::retryBackoffMs(size_t attempt) {
  constexpr uint32_t delays[]{2000, 4000, 8000, 16000, 30000};
  return delays[std::min(attempt, std::size(delays) - 1U)];
}

NetworkWorker::NetworkWorker(ApiClient& client) : client_(client) {}

NetworkWorker::~NetworkWorker() {
#ifdef ARDUINO
  if (task_ != nullptr) {
    stopRequested_.store(true, std::memory_order_release);
    // Wake an idle receiver. If the bounded queue is full, the finite receive
    // poll still observes stopRequested_ without consuming another job.
    constexpr uint8_t kStopMarker = 0xFFU;
    if (pendingQueue_ != nullptr) xQueueSend(pendingQueue_, &kStopMarker, 0);
    if (stopAck_ != nullptr) xSemaphoreTake(stopAck_, portMAX_DELAY);
    // The acknowledgement is sent only after the task has stopped using the
    // client, slots, queues and this object. taskEntry then self-deletes.
    task_ = nullptr;
  }
  if (pendingQueue_ != nullptr) vQueueDelete(pendingQueue_);
  if (resultQueue_ != nullptr) vQueueDelete(resultQueue_);
  if (slotsMutex_ != nullptr) vSemaphoreDelete(slotsMutex_);
  if (stopAck_ != nullptr) vSemaphoreDelete(stopAck_);
#endif
}

bool NetworkWorker::begin() {
#ifdef ARDUINO
  if (task_ != nullptr) return true;
  pendingQueue_ = xQueueCreate(kQueueCapacity, sizeof(uint8_t));
  resultQueue_ = xQueueCreate(kQueueCapacity, sizeof(uint8_t));
  slotsMutex_ = xSemaphoreCreateMutex();
  stopAck_ = xSemaphoreCreateBinary();
  if (pendingQueue_ == nullptr || resultQueue_ == nullptr ||
      slotsMutex_ == nullptr || stopAck_ == nullptr) {
    if (pendingQueue_ != nullptr) vQueueDelete(pendingQueue_);
    if (resultQueue_ != nullptr) vQueueDelete(resultQueue_);
    if (slotsMutex_ != nullptr) vSemaphoreDelete(slotsMutex_);
    if (stopAck_ != nullptr) vSemaphoreDelete(stopAck_);
    pendingQueue_ = nullptr;
    resultQueue_ = nullptr;
    slotsMutex_ = nullptr;
    stopAck_ = nullptr;
    return false;
  }
  if (xTaskCreatePinnedToCore(taskEntry, "oj-network", 12288, this, 1,
                              &task_, 0) != pdPASS) {
    vQueueDelete(pendingQueue_);
    vQueueDelete(resultQueue_);
    vSemaphoreDelete(slotsMutex_);
    vSemaphoreDelete(stopAck_);
    pendingQueue_ = nullptr;
    resultQueue_ = nullptr;
    slotsMutex_ = nullptr;
    stopAck_ = nullptr;
    task_ = nullptr;
    return false;
  }
  stopRequested_.store(false, std::memory_order_release);
  return true;
#else
  return true;
#endif
}

bool NetworkWorker::enqueue(const NetworkJob& job) {
  if (!validJob(job)) return false;
#ifdef ARDUINO
  if (stopRequested_.load(std::memory_order_acquire)) return false;
  if (pendingQueue_ == nullptr || slotsMutex_ == nullptr) return false;
  size_t index = 0;
  if (!claimFreeSlot(index)) return false;
  if (xSemaphoreTake(slotsMutex_, portMAX_DELAY) != pdTRUE) {
    return false;
  }
  try {
    slots_[index].job = job;
  } catch (const std::bad_alloc&) {
    slots_[index].inUse = false;
    xSemaphoreGive(slotsMutex_);
    return false;
  }
  slots_[index].inUse = true;
  xSemaphoreGive(slotsMutex_);
  const uint8_t queued = static_cast<uint8_t>(index);
  if (xQueueSend(pendingQueue_, &queued, 0) != pdTRUE) {
    if (xSemaphoreTake(slotsMutex_, portMAX_DELAY) == pdTRUE) {
      slots_[index].inUse = false;
      slots_[index].job = {};
      xSemaphoreGive(slotsMutex_);
    }
    return false;
  }
  return true;
#else
  if (pending_.size() + results_.size() >= kQueueCapacity) return false;
  try {
    pending_.push_back(job);
  } catch (const std::bad_alloc&) {
    return false;
  }
  return true;
#endif
}

bool NetworkWorker::poll(NetworkResult& output) {
#ifdef ARDUINO
  if (resultQueue_ == nullptr || slotsMutex_ == nullptr) return false;
  uint8_t index = 0;
  if (xQueueReceive(resultQueue_, &index, 0) != pdTRUE ||
      index >= slots_.size()) {
    return false;
  }
  if (xSemaphoreTake(slotsMutex_, portMAX_DELAY) != pdTRUE) return false;
  output = std::move(slots_[index].result);
  slots_[index].job = {};
  slots_[index].result = {};
  slots_[index].inUse = false;
  xSemaphoreGive(slotsMutex_);
  return true;
#else
  if (results_.empty()) return false;
  output = std::move(results_.front());
  results_.pop_front();
  return true;
#endif
}

bool NetworkWorker::processOne() {
#ifdef ARDUINO
  if (task_ != nullptr) return false;
  if (pendingQueue_ == nullptr || resultQueue_ == nullptr) return false;
  uint8_t index = 0;
  if (xQueueReceive(pendingQueue_, &index, 0) != pdTRUE ||
      index >= slots_.size()) {
    return false;
  }
  execute(slots_[index].job, slots_[index].result);
  if (xQueueSend(resultQueue_, &index, 0) != pdTRUE) {
    if (xSemaphoreTake(slotsMutex_, portMAX_DELAY) == pdTRUE) {
      slots_[index].inUse = false;
      slots_[index].job = {};
      slots_[index].result = {};
      xSemaphoreGive(slotsMutex_);
    }
    return false;
  }
  return true;
#else
  if (pending_.empty() || results_.size() >= kQueueCapacity) return false;
  const NetworkJob job = std::move(pending_.front());
  pending_.pop_front();
  NetworkResult result;
  execute(job, result);
  results_.push_back(std::move(result));
  return true;
#endif
}

void NetworkWorker::execute(const NetworkJob& job, NetworkResult& output) {
  output = {};
  output.id = job.id;
  output.kind = job.kind;
  const uint32_t timeout = NetworkWorkerPolicy::timeoutMs(job.kind);
  try {
    switch (job.kind) {
      case NetworkJobKind::Bootstrap:
        if (!allocatePayload(output.bootstrap, output)) break;
        output.call = client_.bootstrap(job.credentials, job.bootstrap,
                                        *output.bootstrap, timeout);
        break;
      case NetworkJobKind::Resolve:
        if (!allocatePayload(output.resolve, output)) break;
        output.call = client_.resolve(job.credentials, job.uid,
                                      *output.resolve, timeout);
        break;
      case NetworkJobKind::Action:
        if (!allocatePayload(output.action, output)) break;
        output.call = client_.action(job.credentials, job.action,
                                     *output.action, timeout);
        break;
      case NetworkJobKind::Cache:
        if (!allocatePayload(output.cache, output)) break;
        output.call = client_.cache(job.credentials, job.cacheRevision,
                                    *output.cache, timeout);
        break;
      case NetworkJobKind::OpenAdminSession:
        if (!allocatePayload(output.adminSession, output)) break;
        output.call = client_.openAdminSession(
            job.credentials, job.pin, *output.adminSession, timeout);
        break;
      case NetworkJobKind::CloseAdminSession:
        output.call = client_.closeAdminSession(
            job.credentials, job.adminSession, timeout);
        break;
      case NetworkJobKind::Employees:
        if (!allocatePayload(output.employees, output)) break;
        output.call = client_.employees(job.credentials, job.adminSession,
                                        *output.employees, timeout);
        break;
      case NetworkJobKind::AssignEmployee:
        output.call = client_.assignEmployee(
            job.credentials, job.adminSession, job.employeeId, job.uid,
            job.replace, timeout);
        break;
      case NetworkJobKind::RevokeEmployee:
        output.call = client_.revokeEmployee(
            job.credentials, job.adminSession, job.employeeId, timeout);
        break;
      case NetworkJobKind::Sync:
        if (!allocatePayload(output.sync, output)) break;
        output.call = client_.sync(job.credentials, job.sync, *output.sync,
                                   timeout);
        break;
    }
  } catch (const std::bad_alloc&) {
    setMemoryFailure(output);
  }
  if (!output.call.ok && output.call.failure.retryable) {
    output.suggestedRetryMs =
        NetworkWorkerPolicy::retryBackoffMs(job.attempt);
  }
}

#ifdef ARDUINO
bool NetworkWorker::claimFreeSlot(size_t& index) {
  if (xSemaphoreTake(slotsMutex_, 0) != pdTRUE) return false;
  for (size_t candidate = 0; candidate < slots_.size(); ++candidate) {
    if (!slots_[candidate].inUse) {
      // Reserve before releasing the lock so two producers cannot claim it.
      slots_[candidate].inUse = true;
      index = candidate;
      xSemaphoreGive(slotsMutex_);
      return true;
    }
  }
  xSemaphoreGive(slotsMutex_);
  return false;
}

void NetworkWorker::taskEntry(void* context) {
  static_cast<NetworkWorker*>(context)->taskLoop();
  vTaskDelete(nullptr);
}

void NetworkWorker::taskLoop() {
  constexpr uint8_t kStopMarker = 0xFFU;
  const TickType_t pollTicks =
      pdMS_TO_TICKS(NetworkWorkerPolicy::stopPollMs());
  while (!stopRequested_.load(std::memory_order_acquire)) {
    uint8_t index = 0;
    if (xQueueReceive(pendingQueue_, &index, pollTicks) != pdTRUE) {
      continue;
    }
    if (index == kStopMarker ||
        stopRequested_.load(std::memory_order_acquire)) {
      break;
    }
    if (index >= slots_.size()) continue;
    execute(slots_[index].job, slots_[index].result);
    while (!stopRequested_.load(std::memory_order_acquire) &&
           xQueueSend(resultQueue_, &index, pollTicks) != pdTRUE) {
    }
    if (stopRequested_.load(std::memory_order_acquire)) {
      if (xSemaphoreTake(slotsMutex_, portMAX_DELAY) == pdTRUE) {
        slots_[index].inUse = false;
        slots_[index].job = {};
        slots_[index].result = {};
        xSemaphoreGive(slotsMutex_);
      }
      break;
    }
  }
  // After this give returns, taskLoop never touches members or client_ again;
  // the destructor may safely release owned resources while taskEntry performs
  // the final self-delete instruction.
  const SemaphoreHandle_t acknowledgement = stopAck_;
  xSemaphoreGive(acknowledgement);
}
#endif

}  // namespace openjornada
