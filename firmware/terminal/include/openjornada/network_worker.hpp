#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>

#include "openjornada/api_client.hpp"

#ifdef ARDUINO
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#endif

namespace openjornada {

enum class NetworkJobKind {
  Bootstrap,
  Resolve,
  Action,
  Cache,
  OpenAdminSession,
  CloseAdminSession,
  Employees,
  AssignEmployee,
  RevokeEmployee,
  Sync,
};

struct NetworkJob {
  uint32_t id = 0;
  NetworkJobKind kind = NetworkJobKind::Bootstrap;
  uint8_t attempt = 0;
  ApiCredentials credentials;
  BootstrapRequest bootstrap;
  std::string uid;
  ActionRequest action;
  uint32_t cacheRevision = 0;
  std::string pin;
  std::string adminSession;
  std::string employeeId;
  bool replace = false;
  SyncRequest sync;
};

struct NetworkResult {
  uint32_t id = 0;
  NetworkJobKind kind = NetworkJobKind::Bootstrap;
  ApiCallResult call;
  uint32_t suggestedRetryMs = 0;
  std::unique_ptr<BootstrapResponse> bootstrap;
  std::unique_ptr<ResolveResponse> resolve;
  std::unique_ptr<ActionResult> action;
  std::unique_ptr<CacheResponse> cache;
  std::unique_ptr<AdminSessionResponse> adminSession;
  std::unique_ptr<EmployeeListResponse> employees;
  std::unique_ptr<SyncResponse> sync;
};

class NetworkWorkerPolicy {
 public:
  static uint32_t timeoutMs(NetworkJobKind kind);
  static uint32_t retryBackoffMs(size_t attempt);
  static constexpr uint32_t stopPollMs() { return 50U; }
};

class NetworkWorker {
 public:
  static constexpr size_t kQueueCapacity = 4;

  // The client must outlive the worker. Destruction requests a graceful stop
  // and joins at the acknowledgement boundary; it may wait for the current
  // bounded request (at most 30 seconds) but never kills an active task.
  explicit NetworkWorker(ApiClient& client);
  ~NetworkWorker();
  bool begin();
  bool enqueue(const NetworkJob& job);
  bool poll(NetworkResult& output);
  // Host tests and deterministic diagnostics execute one queued job directly.
  // Production uses exactly one FreeRTOS task calling the same path.
  bool processOne();

 private:
  void execute(const NetworkJob& job, NetworkResult& output);

#ifdef ARDUINO
  static void taskEntry(void* context);
  void taskLoop();
  bool claimFreeSlot(size_t& index);

  struct Slot {
    NetworkJob job;
    NetworkResult result;
    bool inUse = false;
  };
  std::array<Slot, kQueueCapacity> slots_{};
  QueueHandle_t pendingQueue_ = nullptr;
  QueueHandle_t resultQueue_ = nullptr;
  SemaphoreHandle_t slotsMutex_ = nullptr;
  SemaphoreHandle_t stopAck_ = nullptr;
  TaskHandle_t task_ = nullptr;
  std::atomic<bool> stopRequested_{false};
#else
  std::deque<NetworkJob> pending_;
  std::deque<NetworkResult> results_;
#endif
  ApiClient& client_;
};

}  // namespace openjornada
