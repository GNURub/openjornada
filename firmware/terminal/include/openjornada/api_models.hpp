#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "openjornada/domain.hpp"
#include "openjornada/outbox.hpp"

namespace openjornada {

inline constexpr uint8_t kTerminalProtocolVersion = 1;
inline constexpr size_t kMaxApiActions = 3;
inline constexpr size_t kMaxApiCacheEntries = 30;
inline constexpr size_t kMaxApiEmployees = 30;
// The wire protocol accepts at most 500 items, while this constrained client
// deliberately materializes and sends at most 50 at once. A larger server-side
// allowance must never silently expand fixed firmware memory use.
inline constexpr size_t kProtocolMaxSyncItems = Outbox::kProtocolBatchLimit;
inline constexpr size_t kMaxApiSyncItems = Outbox::kMaxInMemoryBatch;
static_assert(kMaxApiSyncItems == 50);
static_assert(kProtocolMaxSyncItems == 500);
static_assert(kMaxApiSyncItems < kProtocolMaxSyncItems);

enum class ApiErrorCode {
  None,
  AuthenticationRequired,
  TerminalRevoked,
  AdminSessionRequired,
  AdminSessionExpired,
  PinRateLimited,
  PinInvalid,
  PinNotConfigured,
  ReplacementRequired,
  UidInUse,
  RfidCapacityReached,
  UnknownTag,
  UidRevoked,
  InactiveEmployee,
  StateConflict,
  ClockUntrusted,
  ProtocolIncompatible,
  InvalidSignature,
  IncidentFailed,
  ScanContextExpired,
  InvalidResponse,
  Transport,
  Timeout,
  HttpFailure,
  QueueFull,
  UnsupportedScheme,
};

const char* safeApiErrorMessage(ApiErrorCode code);

struct ProtocolRange {
  uint8_t current = 0;
  uint8_t minimum = 0;
  uint8_t maximum = 0;
};

struct TerminalInfo {
  std::string id;
  std::string organization;
  std::string name;
  std::string prefix;
  uint8_t protocolVersion = 0;
  std::string clientVersion;
  uint32_t cacheRevision = 0;
  std::string lastSeenAt;
  uint32_t lastPendingCount = 0;
  std::string revokedAt;
  std::string createdBy;
  std::string created;
  bool pendingQueueWarning = false;
};

struct BootstrapRequest {
  uint8_t protocolVersion = kTerminalProtocolVersion;
  std::string clientVersion;
  uint32_t pendingCount = 0;
};

struct BootstrapResponse {
  ProtocolRange protocol;
  std::string serverTime;
  std::string timezone;
  TerminalInfo terminal;
  uint32_t cacheRevision = 0;
  uint32_t maxOfflineSeconds = 0;
  uint32_t maxQueuedActions = 0;
};

enum class ActionMode { Now, ChooseTime, CloseFromBreak };

struct ActionChoice {
  Command command = Command::ClockIn;
  std::string label;
  ActionMode mode = ActionMode::Now;
  bool highlighted = false;
};

struct ApiWorkState {
  WorkKind kind = WorkKind::Idle;
  std::string since;
  int32_t workedSeconds = 0;
  int32_t breakSeconds = 0;
  bool longShift = false;
  bool staleBreak = false;
  std::array<ActionChoice, kMaxApiActions> actions{};
  uint8_t actionCount = 0;
};

struct ApiFailure {
  ApiErrorCode code = ApiErrorCode::None;
  int httpStatus = 0;
  uint32_t retryAfterSeconds = 0;
  bool retryable = false;
  std::string safeMessage;
  // HTTP 409 state_conflict carries the server-authoritative state so the UI
  // can recover immediately without pretending the rejected action succeeded.
  std::optional<ApiWorkState> authoritativeState;
};

struct EmployeeIdentity {
  std::string id;
  std::string displayName;
};

struct ResolveResponse {
  std::string scanContext;
  std::string expiresAt;
  EmployeeIdentity employee;
  ApiWorkState state;
};

struct ActionRequest {
  std::string clientRequestId;
  std::string scanContext;
  Command command = Command::ClockIn;
  std::string deviceCapturedAt;
  std::string appliedAt;
  std::string clockSyncedAt;
  uint32_t deviceSequence = 0;
};

enum class ActionStatus { Accepted, Duplicate, Incident, Rejected };

struct ActionResult {
  std::string clientRequestId;
  ActionStatus status = ActionStatus::Rejected;
  std::string workEventId;
  std::string incidentId;
  ApiWorkState state;
  ApiErrorCode errorCode = ApiErrorCode::None;
};

struct CacheItem {
  std::string employeeId;
  std::string displayName;
  std::string uid;
  ApiWorkState state;
};

struct CacheResponse {
  uint32_t revision = 0;
  bool unchanged = false;
  std::array<CacheItem, kMaxApiCacheEntries> items{};
  uint8_t itemCount = 0;
};

struct AdminSessionResponse {
  std::string token;
  std::string idleExpiresAt;
};

struct TerminalEmployee {
  std::string id;
  std::string name;
  std::string displayName;
  bool hasRfidTag = false;
};

struct EmployeeListResponse {
  std::array<TerminalEmployee, kMaxApiEmployees> items{};
  uint8_t itemCount = 0;
};

struct SyncRequest {
  std::vector<QueuedAction> actions;
  uint32_t pendingCount = 0;
};

struct SyncResponse {
  std::array<ActionResult, kMaxApiSyncItems> items{};
  uint8_t itemCount = 0;
  std::string serverTime;
};

class ApiCodec {
 public:
  static constexpr size_t kMaxRequestBytes = 48U * 1024U;
  static constexpr size_t kMaxBootstrapResponseBytes = 4096;
  static constexpr size_t kMaxResolveResponseBytes = 4096;
  static constexpr size_t kMaxActionResponseBytes = 4096;
  static constexpr size_t kMaxCacheResponseBytes = 32U * 1024U;
  static constexpr size_t kMaxAdminResponseBytes = 2048;
  static constexpr size_t kMaxEmployeeResponseBytes = 16U * 1024U;
  static constexpr size_t kMaxSyncResponseBytes = 48U * 1024U;
  static constexpr size_t kMaxErrorResponseBytes = 2048;

  static bool decodeBootstrap(std::string_view json,
                              BootstrapResponse& output,
                              ApiFailure& failure);
  static bool decodeResolve(std::string_view json, ResolveResponse& output,
                            ApiFailure& failure);
  static bool decodeActionResult(std::string_view json, ActionResult& output,
                                 ApiFailure& failure);
  static bool decodeCache(std::string_view json, CacheResponse& output,
                          ApiFailure& failure);
  static bool decodeAdminSession(std::string_view json,
                                 AdminSessionResponse& output,
                                 ApiFailure& failure);
  static bool decodeEmployees(std::string_view json,
                              EmployeeListResponse& output,
                              ApiFailure& failure);
  static bool decodeSync(std::string_view json, SyncResponse& output,
                         ApiFailure& failure);
  static bool decodeError(std::string_view json, int httpStatus,
                          ApiFailure& failure);

  static bool encodeBootstrap(const BootstrapRequest& request,
                              std::string& output);
  static bool encodeResolveUid(std::string_view uid, std::string& output);
  static bool encodeAction(const ActionRequest& request,
                           std::string& output);
  static bool encodeAdminPin(std::string_view pin, std::string& output);
  static bool encodeAssignEmployee(std::string_view uid, bool replace,
                                   std::string& output);
  static bool encodeSync(const SyncRequest& request, std::string& output);
};

const char* commandApiValue(Command command);

}  // namespace openjornada
