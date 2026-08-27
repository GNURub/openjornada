#pragma once

#include <atomic>
#include <optional>
#include <string>

#include "openjornada/api_client.hpp"

#ifdef ARDUINO
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#endif

namespace openjornada {

struct TelemetryJob {
  ApiCredentials credentials;
  HeartbeatRequest heartbeat;
  std::string localIp;
};

struct TelemetryResult {
  ApiCallResult heartbeat;
  HeartbeatResponse response;
  bool ackAttempted = false;
  ApiCallResult ack;
};

class TelemetryWorker {
 public:
  explicit TelemetryWorker(TelemetryClient& client);
  ~TelemetryWorker();

  bool begin();
  bool enqueue(TelemetryJob&& job);
  bool poll(TelemetryResult& output);
  bool busy() const;
  bool processOne();

 private:
  static constexpr uint32_t kRequestTimeoutMs = 5000U;

  void execute(const TelemetryJob& job, TelemetryResult& output);

#ifdef ARDUINO
  static void taskEntry(void* context);
  void taskLoop();

  QueueHandle_t pendingQueue_ = nullptr;
  QueueHandle_t resultQueue_ = nullptr;
  SemaphoreHandle_t slotMutex_ = nullptr;
  SemaphoreHandle_t stopAck_ = nullptr;
  TaskHandle_t task_ = nullptr;
  TelemetryJob job_;
  TelemetryResult result_;
  std::atomic<bool> stopRequested_{false};
#else
  std::optional<TelemetryJob> pending_;
  std::optional<TelemetryResult> result_;
#endif
  std::atomic<bool> busy_{false};
  TelemetryClient& client_;
};

}  // namespace openjornada
