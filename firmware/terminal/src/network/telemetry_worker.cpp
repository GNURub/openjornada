#include "openjornada/telemetry_worker.hpp"

#include <algorithm>
#include <new>
#include <string_view>
#include <utility>

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

bool validJob(const TelemetryJob& job) {
  if (!validCredentials(job.credentials)) return false;
  std::string ignored;
  if (!ApiCodec::encodeHeartbeat(job.heartbeat, ignored)) return false;
  return ApiCodec::encodePingAck(
      {"validation", job.localIp, job.heartbeat.wifiRssiDbm,
       job.heartbeat.uptimeSeconds},
      ignored);
}

void setMemoryFailure(ApiCallResult& output) {
  output = {};
  output.ok = false;
  output.failure.code = ApiErrorCode::QueueFull;
  output.failure.safeMessage = safeApiErrorMessage(ApiErrorCode::QueueFull);
}

}  // namespace

TelemetryWorker::TelemetryWorker(TelemetryClient& client) : client_(client) {}

TelemetryWorker::~TelemetryWorker() {
#ifdef ARDUINO
  if (task_ != nullptr) {
    stopRequested_.store(true, std::memory_order_release);
    constexpr uint8_t kStopMarker = 0xFFU;
    if (pendingQueue_ != nullptr) xQueueSend(pendingQueue_, &kStopMarker, 0);
    if (stopAck_ != nullptr) xSemaphoreTake(stopAck_, portMAX_DELAY);
    task_ = nullptr;
  }
  if (pendingQueue_ != nullptr) vQueueDelete(pendingQueue_);
  if (resultQueue_ != nullptr) vQueueDelete(resultQueue_);
  if (slotMutex_ != nullptr) vSemaphoreDelete(slotMutex_);
  if (stopAck_ != nullptr) vSemaphoreDelete(stopAck_);
#endif
}

bool TelemetryWorker::begin() {
#ifdef ARDUINO
  if (task_ != nullptr) return true;
  pendingQueue_ = xQueueCreate(1, sizeof(uint8_t));
  resultQueue_ = xQueueCreate(1, sizeof(uint8_t));
  slotMutex_ = xSemaphoreCreateMutex();
  stopAck_ = xSemaphoreCreateBinary();
  if (pendingQueue_ == nullptr || resultQueue_ == nullptr ||
      slotMutex_ == nullptr || stopAck_ == nullptr) {
    if (pendingQueue_ != nullptr) vQueueDelete(pendingQueue_);
    if (resultQueue_ != nullptr) vQueueDelete(resultQueue_);
    if (slotMutex_ != nullptr) vSemaphoreDelete(slotMutex_);
    if (stopAck_ != nullptr) vSemaphoreDelete(stopAck_);
    pendingQueue_ = nullptr;
    resultQueue_ = nullptr;
    slotMutex_ = nullptr;
    stopAck_ = nullptr;
    return false;
  }
  stopRequested_.store(false, std::memory_order_release);
  if (xTaskCreatePinnedToCore(taskEntry, "oj-telemetry", 8192, this, 1,
                              &task_, 0) != pdPASS) {
    vQueueDelete(pendingQueue_);
    vQueueDelete(resultQueue_);
    vSemaphoreDelete(slotMutex_);
    vSemaphoreDelete(stopAck_);
    pendingQueue_ = nullptr;
    resultQueue_ = nullptr;
    slotMutex_ = nullptr;
    stopAck_ = nullptr;
    task_ = nullptr;
    return false;
  }
#endif
  return true;
}

bool TelemetryWorker::enqueue(TelemetryJob&& job) {
  try {
    if (!validJob(job)) return false;
  } catch (const std::bad_alloc&) {
    return false;
  }
  bool expected = false;
  if (!busy_.compare_exchange_strong(expected, true,
                                     std::memory_order_acq_rel)) {
    return false;
  }
#ifdef ARDUINO
  if (pendingQueue_ == nullptr || slotMutex_ == nullptr ||
      stopRequested_.load(std::memory_order_acquire)) {
    busy_.store(false, std::memory_order_release);
    return false;
  }
  if (xSemaphoreTake(slotMutex_, portMAX_DELAY) != pdTRUE) {
    busy_.store(false, std::memory_order_release);
    return false;
  }
  try {
    job_ = std::move(job);
  } catch (const std::bad_alloc&) {
    xSemaphoreGive(slotMutex_);
    busy_.store(false, std::memory_order_release);
    return false;
  }
  xSemaphoreGive(slotMutex_);
  constexpr uint8_t kJobMarker = 1U;
  if (xQueueSend(pendingQueue_, &kJobMarker, 0) != pdTRUE) {
    if (xSemaphoreTake(slotMutex_, portMAX_DELAY) == pdTRUE) {
      job_ = {};
      xSemaphoreGive(slotMutex_);
    }
    busy_.store(false, std::memory_order_release);
    return false;
  }
#else
  try {
    pending_.emplace(std::move(job));
  } catch (const std::bad_alloc&) {
    busy_.store(false, std::memory_order_release);
    return false;
  }
#endif
  return true;
}

bool TelemetryWorker::poll(TelemetryResult& output) {
#ifdef ARDUINO
  if (resultQueue_ == nullptr || slotMutex_ == nullptr) return false;
  uint8_t marker = 0;
  if (xQueueReceive(resultQueue_, &marker, 0) != pdTRUE || marker != 1U) {
    return false;
  }
  if (xSemaphoreTake(slotMutex_, portMAX_DELAY) != pdTRUE) return false;
  output = std::move(result_);
  job_ = {};
  result_ = {};
  xSemaphoreGive(slotMutex_);
#else
  if (!result_.has_value()) return false;
  output = std::move(*result_);
  result_.reset();
#endif
  busy_.store(false, std::memory_order_release);
  return true;
}

bool TelemetryWorker::busy() const {
  return busy_.load(std::memory_order_acquire);
}

bool TelemetryWorker::processOne() {
#ifdef ARDUINO
  return false;
#else
  if (!pending_.has_value() || result_.has_value()) return false;
  TelemetryJob job = std::move(*pending_);
  pending_.reset();
  TelemetryResult result;
  execute(job, result);
  result_.emplace(std::move(result));
  return true;
#endif
}

void TelemetryWorker::execute(const TelemetryJob& job,
                              TelemetryResult& output) {
  output = {};
  HeartbeatResponse response;
  try {
    output.heartbeat = client_.heartbeat(job.credentials, job.heartbeat,
                                         response, kRequestTimeoutMs);
    if (!output.heartbeat.ok || response.pingChallenge.empty()) return;
    output.ackAttempted = true;
    output.ack = client_.pingAck(
        job.credentials,
        {response.pingChallenge, job.localIp, job.heartbeat.wifiRssiDbm,
         job.heartbeat.uptimeSeconds},
        kRequestTimeoutMs);
  } catch (const std::bad_alloc&) {
    if (output.ackAttempted) {
      setMemoryFailure(output.ack);
    } else {
      setMemoryFailure(output.heartbeat);
    }
  }
}

#ifdef ARDUINO
void TelemetryWorker::taskEntry(void* context) {
  static_cast<TelemetryWorker*>(context)->taskLoop();
  vTaskDelete(nullptr);
}

void TelemetryWorker::taskLoop() {
  constexpr uint8_t kStopMarker = 0xFFU;
  const TickType_t pollTicks = pdMS_TO_TICKS(50U);
  while (!stopRequested_.load(std::memory_order_acquire)) {
    uint8_t marker = 0;
    if (xQueueReceive(pendingQueue_, &marker, pollTicks) != pdTRUE) continue;
    if (marker == kStopMarker ||
        stopRequested_.load(std::memory_order_acquire)) {
      break;
    }
    if (xSemaphoreTake(slotMutex_, portMAX_DELAY) != pdTRUE) continue;
    TelemetryJob job = std::move(job_);
    xSemaphoreGive(slotMutex_);

    TelemetryResult result;
    execute(job, result);
    if (xSemaphoreTake(slotMutex_, portMAX_DELAY) != pdTRUE) continue;
    result_ = std::move(result);
    xSemaphoreGive(slotMutex_);

    constexpr uint8_t kResultMarker = 1U;
    while (!stopRequested_.load(std::memory_order_acquire) &&
           xQueueSend(resultQueue_, &kResultMarker, pollTicks) != pdTRUE) {
    }
  }
  const SemaphoreHandle_t acknowledgement = stopAck_;
  xSemaphoreGive(acknowledgement);
}
#endif

}  // namespace openjornada
