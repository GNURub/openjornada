#include "openjornada/api_models.hpp"

#include <ArduinoJson.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string_view>
#include <utility>

namespace openjornada {
namespace {

constexpr size_t kMaxId = 64;
constexpr size_t kMaxEmployeeName = 160;
constexpr size_t kMaxDisplayName = 96;
constexpr size_t kMaxTerminalName = 80;
constexpr size_t kMaxLabel = 96;
constexpr size_t kMaxTimestamp = 48;
constexpr size_t kMaxTimezone = 64;
constexpr size_t kMaxVersion = 64;
constexpr size_t kMaxScanContext = 512;
constexpr size_t kMaxAdminToken = 96;
constexpr size_t kMaxUid = 20;
constexpr size_t kMaxHash = 128;

template <size_t Capacity>
class BoundedAllocator final : public ArduinoJson::Allocator {
 public:
  void* allocate(size_t size) override {
    if (size == 0 || size > Capacity - used_) return nullptr;
    auto* raw = static_cast<Header*>(std::malloc(sizeof(Header) + size));
    if (raw == nullptr) return nullptr;
    raw->size = size;
    used_ += size;
    return raw + 1;
  }

  void deallocate(void* pointer) override {
    if (pointer == nullptr) return;
    auto* raw = static_cast<Header*>(pointer) - 1;
    used_ -= raw->size;
    std::free(raw);
  }

  void* reallocate(void* pointer, size_t newSize) override {
    if (pointer == nullptr) return allocate(newSize);
    if (newSize == 0) {
      deallocate(pointer);
      return nullptr;
    }
    auto* raw = static_cast<Header*>(pointer) - 1;
    const size_t oldSize = raw->size;
    if (newSize > oldSize && newSize - oldSize > Capacity - used_) {
      return nullptr;
    }
    auto* replacement = static_cast<Header*>(
        std::realloc(raw, sizeof(Header) + newSize));
    if (replacement == nullptr) return nullptr;
    used_ = used_ - oldSize + newSize;
    replacement->size = newSize;
    return replacement + 1;
  }

 private:
  struct Header {
    size_t size;
  };
  size_t used_ = 0;
};

template <size_t Capacity>
struct BoundedDocument {
  BoundedAllocator<Capacity> allocator;
  ArduinoJson::JsonDocument document{&allocator};
};

void setFailure(ApiFailure& failure, ApiErrorCode code, int status = 0,
                bool retryable = false) {
  failure = {};
  failure.code = code;
  failure.httpStatus = status;
  failure.retryable = retryable;
  failure.safeMessage = safeApiErrorMessage(code);
}

template <size_t MaxInput, size_t Capacity>
bool parseJson(std::string_view json, BoundedDocument<Capacity>& bounded,
               ApiFailure& failure) {
  if (json.empty() || json.size() > MaxInput) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  const auto error = ArduinoJson::deserializeJson(
      bounded.document, json.data(), json.size(),
      ArduinoJson::DeserializationOption::NestingLimit(8));
  if (error || bounded.document.overflowed() ||
      !bounded.document.template is<ArduinoJson::JsonObjectConst>()) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  return true;
}

bool validText(std::string_view value, size_t maximum, bool allowEmpty) {
  if ((!allowEmpty && value.empty()) || value.size() > maximum) return false;
  for (const unsigned char byte : value) {
    if (byte == 0 || byte == '\r' || byte == '\n' ||
        (byte < 0x20U && byte != '\t')) {
      return false;
    }
  }
  return true;
}

bool requiredString(ArduinoJson::JsonObjectConst object, const char* key,
                    size_t maximum, std::string& output,
                    bool allowEmpty = false) {
  const ArduinoJson::JsonVariantConst value = object[key];
  if (!value.is<const char*>()) return false;
  const char* raw = value.as<const char*>();
  if (raw == nullptr) return false;
  const std::string_view view(raw);
  if (!validText(view, maximum, allowEmpty)) return false;
  output.assign(view);
  return true;
}

bool optionalString(ArduinoJson::JsonObjectConst object, const char* key,
                    size_t maximum, std::string& output) {
  if (object[key].isNull()) {
    output.clear();
    return true;
  }
  return requiredString(object, key, maximum, output, true);
}

bool requiredBool(ArduinoJson::JsonObjectConst object, const char* key,
                  bool& output) {
  const ArduinoJson::JsonVariantConst value = object[key];
  if (!value.is<bool>()) return false;
  output = value.as<bool>();
  return true;
}

bool requiredUnsigned(ArduinoJson::JsonObjectConst object, const char* key,
                      uint32_t maximum, uint32_t& output) {
  const ArduinoJson::JsonVariantConst value = object[key];
  uint64_t parsed = 0;
  if (value.is<uint64_t>()) {
    parsed = value.as<uint64_t>();
  } else if (value.is<int64_t>()) {
    const int64_t signedValue = value.as<int64_t>();
    if (signedValue < 0) return false;
    parsed = static_cast<uint64_t>(signedValue);
  } else {
    return false;
  }
  if (parsed > maximum) return false;
  output = static_cast<uint32_t>(parsed);
  return true;
}

bool requiredSigned(ArduinoJson::JsonObjectConst object, const char* key,
                    int32_t minimum, int32_t maximum, int32_t& output) {
  const ArduinoJson::JsonVariantConst value = object[key];
  if (!value.is<int64_t>() && !value.is<uint64_t>()) return false;
  const int64_t parsed = value.as<int64_t>();
  if (parsed < minimum || parsed > maximum) return false;
  output = static_cast<int32_t>(parsed);
  return true;
}

bool parseCommand(std::string_view value, Command& output) {
  if (value == "clock_in") output = Command::ClockIn;
  else if (value == "break_start") output = Command::BreakStart;
  else if (value == "break_end") output = Command::BreakEnd;
  else if (value == "clock_out") output = Command::ClockOut;
  else return false;
  return true;
}

ApiErrorCode parseErrorCode(std::string_view value) {
  if (value == "authentication_required") return ApiErrorCode::AuthenticationRequired;
  if (value == "terminal_revoked") return ApiErrorCode::TerminalRevoked;
  if (value == "admin_session_required") return ApiErrorCode::AdminSessionRequired;
  if (value == "admin_session_expired") return ApiErrorCode::AdminSessionExpired;
  if (value == "pin_rate_limited") return ApiErrorCode::PinRateLimited;
  if (value == "pin_invalid") return ApiErrorCode::PinInvalid;
  if (value == "pin_not_configured") return ApiErrorCode::PinNotConfigured;
  if (value == "replacement_required") return ApiErrorCode::ReplacementRequired;
  if (value == "uid_in_use") return ApiErrorCode::UidInUse;
  if (value == "rfid_capacity_reached") return ApiErrorCode::RfidCapacityReached;
  if (value == "unknown_tag") return ApiErrorCode::UnknownTag;
  if (value == "uid_revoked") return ApiErrorCode::UidRevoked;
  if (value == "inactive_employee") return ApiErrorCode::InactiveEmployee;
  if (value == "state_conflict") return ApiErrorCode::StateConflict;
  if (value == "clock_untrusted") return ApiErrorCode::ClockUntrusted;
  if (value == "protocol_incompatible") return ApiErrorCode::ProtocolIncompatible;
  if (value == "invalid_signature") return ApiErrorCode::InvalidSignature;
  if (value == "incident_failed") return ApiErrorCode::IncidentFailed;
  if (value == "scan_context_expired") return ApiErrorCode::ScanContextExpired;
  return ApiErrorCode::HttpFailure;
}

bool parseWorkState(ArduinoJson::JsonVariantConst value, ApiWorkState& output) {
  if (!value.is<ArduinoJson::JsonObjectConst>()) return false;
  const auto object = value.as<ArduinoJson::JsonObjectConst>();
  std::string kind;
  if (!requiredString(object, "kind", 16, kind)) return false;
  if (kind == "idle") output.kind = WorkKind::Idle;
  else if (kind == "working") output.kind = WorkKind::Working;
  else if (kind == "on_break") output.kind = WorkKind::OnBreak;
  else return false;

  const auto since = object["since"];
  if (since.isNull()) {
    output.since.clear();
  } else if (!requiredString(object, "since", kMaxTimestamp, output.since)) {
    return false;
  }
  if (!requiredSigned(object, "workedSeconds", 0,
                      std::numeric_limits<int32_t>::max(),
                      output.workedSeconds) ||
      !requiredSigned(object, "breakSeconds", 0,
                      std::numeric_limits<int32_t>::max(),
                      output.breakSeconds) ||
      !requiredBool(object, "longShift", output.longShift) ||
      !requiredBool(object, "staleBreak", output.staleBreak)) {
    return false;
  }

  const auto actionsValue = object["actions"];
  if (!actionsValue.is<ArduinoJson::JsonArrayConst>()) return false;
  const auto actions = actionsValue.as<ArduinoJson::JsonArrayConst>();
  if (actions.size() > kMaxApiActions) return false;
  output.actionCount = 0;
  for (const auto itemValue : actions) {
    if (!itemValue.is<ArduinoJson::JsonObjectConst>()) return false;
    const auto item = itemValue.as<ArduinoJson::JsonObjectConst>();
    ActionChoice choice;
    std::string command;
    std::string mode;
    if (!requiredString(item, "command", 16, command) ||
        !parseCommand(command, choice.command) ||
        !requiredString(item, "label", kMaxLabel, choice.label) ||
        !requiredString(item, "mode", 24, mode) ||
        !requiredBool(item, "highlighted", choice.highlighted)) {
      return false;
    }
    if (mode == "now") choice.mode = ActionMode::Now;
    else if (mode == "choose_time") choice.mode = ActionMode::ChooseTime;
    else if (mode == "close_from_break") choice.mode = ActionMode::CloseFromBreak;
    else return false;
    output.actions[output.actionCount++] = std::move(choice);
  }
  return true;
}

bool parseTerminal(ArduinoJson::JsonVariantConst value, TerminalInfo& output) {
  if (!value.is<ArduinoJson::JsonObjectConst>()) return false;
  const auto object = value.as<ArduinoJson::JsonObjectConst>();
  uint32_t protocol = 0;
  return requiredString(object, "id", kMaxId, output.id) &&
         requiredString(object, "organization", kMaxId, output.organization) &&
         requiredString(object, "name", kMaxTerminalName, output.name) &&
         requiredString(object, "prefix", 32, output.prefix) &&
         requiredUnsigned(object, "protocolVersion", 255, protocol) &&
         (output.protocolVersion = static_cast<uint8_t>(protocol), true) &&
         requiredString(object, "clientVersion", kMaxVersion,
                        output.clientVersion, true) &&
         requiredUnsigned(object, "cacheRevision",
                          std::numeric_limits<uint32_t>::max(),
                          output.cacheRevision) &&
         requiredString(object, "lastSeenAt", kMaxTimestamp,
                        output.lastSeenAt, true) &&
         requiredUnsigned(object, "lastPendingCount", OutboxCodec::kCapacity,
                          output.lastPendingCount) &&
         requiredString(object, "revokedAt", kMaxTimestamp,
                        output.revokedAt, true) &&
         requiredString(object, "createdBy", kMaxId, output.createdBy, true) &&
         requiredString(object, "created", kMaxTimestamp, output.created,
                        true) &&
         requiredBool(object, "pendingQueueWarning",
                      output.pendingQueueWarning);
}

bool parseActionResultObject(ArduinoJson::JsonObjectConst object,
                             ActionResult& output) {
  std::string status;
  std::string error;
  if (!requiredString(object, "clientRequestId", kMaxId,
                      output.clientRequestId) ||
      !requiredString(object, "status", 16, status) ||
      !optionalString(object, "workEventId", kMaxId, output.workEventId) ||
      !optionalString(object, "incidentId", kMaxId, output.incidentId) ||
      !optionalString(object, "errorCode", 48, error) ||
      !parseWorkState(object["state"], output.state)) {
    return false;
  }
  if (status == "accepted") output.status = ActionStatus::Accepted;
  else if (status == "duplicate") output.status = ActionStatus::Duplicate;
  else if (status == "incident") output.status = ActionStatus::Incident;
  else if (status == "rejected") output.status = ActionStatus::Rejected;
  else return false;
  output.errorCode = error.empty() ? ApiErrorCode::None : parseErrorCode(error);
  return true;
}

bool validUid(std::string_view uid) {
  if (uid.empty() || uid.size() > kMaxUid || uid.size() % 2U != 0) return false;
  return std::all_of(uid.begin(), uid.end(), [](unsigned char byte) {
    return std::isdigit(byte) || (byte >= 'A' && byte <= 'F');
  });
}

template <size_t Capacity>
bool serializeDocument(ArduinoJson::JsonDocument& document,
                       BoundedAllocator<Capacity>& allocator,
                       std::string& output) {
  (void)allocator;
  std::string candidate;
  const size_t measured = ArduinoJson::measureJson(document);
  if (measured == 0 || measured > ApiCodec::kMaxRequestBytes) return false;
  candidate.reserve(measured);
  if (ArduinoJson::serializeJson(document, candidate) != measured ||
      candidate.size() != measured) {
    return false;
  }
  output = std::move(candidate);
  return true;
}

bool validActionRequest(const ActionRequest& request) {
  return validText(request.clientRequestId, kMaxId, false) &&
         validText(request.scanContext, kMaxScanContext, false) &&
         commandApiValue(request.command) != nullptr &&
         validText(request.deviceCapturedAt, kMaxTimestamp, false) &&
         validText(request.appliedAt, kMaxTimestamp, true) &&
         validText(request.clockSyncedAt, kMaxTimestamp, false) &&
         request.deviceSequence > 0;
}

}  // namespace

const char* safeApiErrorMessage(ApiErrorCode code) {
  switch (code) {
    case ApiErrorCode::None: return "";
    case ApiErrorCode::AuthenticationRequired:
      return "La credencial del terminal no es válida.";
    case ApiErrorCode::TerminalRevoked:
      return "Este terminal ha sido desactivado.";
    case ApiErrorCode::AdminSessionRequired:
      return "Abre el modo administración con el PIN.";
    case ApiErrorCode::AdminSessionExpired:
      return "La sesión de administración ha caducado.";
    case ApiErrorCode::PinRateLimited:
      return "Espera antes de volver a intentar el PIN.";
    case ApiErrorCode::PinInvalid:
      return "El PIN no es correcto.";
    case ApiErrorCode::PinNotConfigured:
      return "Configura primero el PIN del terminal en OpenJornada.";
    case ApiErrorCode::ReplacementRequired:
      return "Esta persona ya tiene un tag; confirma que quieres sustituirlo.";
    case ApiErrorCode::UidInUse:
      return "Este tag ya está asignado a otra persona.";
    case ApiErrorCode::RfidCapacityReached:
      return "Se ha alcanzado el máximo de personas con RFID.";
    case ApiErrorCode::UnknownTag:
      return "Tag no asignado; avisa a un responsable.";
    case ApiErrorCode::UidRevoked:
      return "El tag se revocó antes de sincronizarse; avisa a un responsable.";
    case ApiErrorCode::InactiveEmployee:
      return "La persona no está activa.";
    case ApiErrorCode::StateConflict:
      return "El estado de la jornada ha cambiado; acerca de nuevo el tag.";
    case ApiErrorCode::ClockUntrusted:
      return "La hora del terminal necesita sincronizarse.";
    case ApiErrorCode::ProtocolIncompatible:
      return "Este terminal necesita una actualización por USB.";
    case ApiErrorCode::InvalidSignature:
      return "La cola local no supera la comprobación de integridad.";
    case ApiErrorCode::IncidentFailed:
      return "No se pudo registrar la incidencia; avisa a un responsable.";
    case ApiErrorCode::ScanContextExpired:
      return "Vuelve a acercar el tag.";
    case ApiErrorCode::InvalidResponse:
      return "El servidor devolvió una respuesta no válida.";
    case ApiErrorCode::Transport:
      return "No se pudo conectar con OpenJornada.";
    case ApiErrorCode::Timeout:
      return "OpenJornada tardó demasiado en responder.";
    case ApiErrorCode::QueueFull:
      return "El terminal está ocupado; inténtalo de nuevo.";
    case ApiErrorCode::UnsupportedScheme:
      return "La URL no está permitida en esta versión.";
    case ApiErrorCode::HttpFailure:
      return "OpenJornada no pudo completar la operación.";
  }
  return "OpenJornada no pudo completar la operación.";
}

const char* commandApiValue(Command command) {
  switch (command) {
    case Command::ClockIn: return "clock_in";
    case Command::BreakStart: return "break_start";
    case Command::BreakEnd: return "break_end";
    case Command::ClockOut: return "clock_out";
  }
  return nullptr;
}

bool ApiCodec::decodeBootstrap(std::string_view json,
                               BootstrapResponse& output,
                               ApiFailure& failure) {
  BoundedDocument<kMaxBootstrapResponseBytes * 2U> bounded;
  if (!parseJson<kMaxBootstrapResponseBytes>(json, bounded, failure)) return false;
  const auto root = bounded.document.as<ArduinoJson::JsonObjectConst>();
  const auto protocolValue = root["protocol"];
  if (!protocolValue.is<ArduinoJson::JsonObjectConst>()) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  const auto protocol = protocolValue.as<ArduinoJson::JsonObjectConst>();
  BootstrapResponse candidate;
  uint32_t current = 0, minimum = 0, maximum = 0;
  if (!requiredUnsigned(protocol, "current", 255, current) ||
      !requiredUnsigned(protocol, "min", 255, minimum) ||
      !requiredUnsigned(protocol, "max", 255, maximum)) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  candidate.protocol = {static_cast<uint8_t>(current),
                        static_cast<uint8_t>(minimum),
                        static_cast<uint8_t>(maximum)};
  if (current != kTerminalProtocolVersion || minimum > kTerminalProtocolVersion ||
      maximum < kTerminalProtocolVersion) {
    setFailure(failure, ApiErrorCode::ProtocolIncompatible);
    return false;
  }
  if (!requiredString(root, "serverTime", kMaxTimestamp,
                      candidate.serverTime) ||
      !requiredString(root, "timezone", kMaxTimezone, candidate.timezone) ||
      !parseTerminal(root["terminal"], candidate.terminal) ||
      !requiredUnsigned(root, "cacheRevision",
                        std::numeric_limits<uint32_t>::max(),
                        candidate.cacheRevision) ||
      !requiredUnsigned(root, "maxOfflineSeconds", 7U * 24U * 60U * 60U,
                        candidate.maxOfflineSeconds) ||
      !requiredUnsigned(root, "maxQueuedActions", OutboxCodec::kCapacity,
                        candidate.maxQueuedActions) ||
      candidate.maxOfflineSeconds != 86400 ||
      candidate.maxQueuedActions != OutboxCodec::kCapacity) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  output = std::move(candidate);
  failure = {};
  return true;
}

bool ApiCodec::decodeResolve(std::string_view json, ResolveResponse& output,
                             ApiFailure& failure) {
  BoundedDocument<kMaxResolveResponseBytes * 2U> bounded;
  if (!parseJson<kMaxResolveResponseBytes>(json, bounded, failure)) return false;
  const auto root = bounded.document.as<ArduinoJson::JsonObjectConst>();
  const auto employeeValue = root["employee"];
  if (!employeeValue.is<ArduinoJson::JsonObjectConst>()) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  const auto employee = employeeValue.as<ArduinoJson::JsonObjectConst>();
  ResolveResponse candidate;
  if (!requiredString(root, "scanContext", kMaxScanContext,
                      candidate.scanContext) ||
      !requiredString(root, "expiresAt", kMaxTimestamp, candidate.expiresAt) ||
      !requiredString(employee, "id", kMaxId, candidate.employee.id) ||
      !requiredString(employee, "displayName", kMaxDisplayName,
                      candidate.employee.displayName) ||
      !parseWorkState(root["state"], candidate.state)) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  output = std::move(candidate);
  failure = {};
  return true;
}

bool ApiCodec::decodeActionResult(std::string_view json, ActionResult& output,
                                  ApiFailure& failure) {
  BoundedDocument<kMaxActionResponseBytes * 2U> bounded;
  if (!parseJson<kMaxActionResponseBytes>(json, bounded, failure)) return false;
  ActionResult candidate;
  if (!parseActionResultObject(
          bounded.document.as<ArduinoJson::JsonObjectConst>(), candidate)) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  output = std::move(candidate);
  failure = {};
  return true;
}

bool ApiCodec::decodeCache(std::string_view json, CacheResponse& output,
                           ApiFailure& failure) {
  BoundedDocument<kMaxCacheResponseBytes * 2U> bounded;
  if (!parseJson<kMaxCacheResponseBytes>(json, bounded, failure)) return false;
  const auto root = bounded.document.as<ArduinoJson::JsonObjectConst>();
  CacheResponse candidate;
  if (!requiredUnsigned(root, "revision", std::numeric_limits<uint32_t>::max(),
                        candidate.revision) ||
      !requiredBool(root, "unchanged", candidate.unchanged) ||
      !root["items"].is<ArduinoJson::JsonArrayConst>()) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  const auto items = root["items"].as<ArduinoJson::JsonArrayConst>();
  if (items.size() > kMaxApiCacheEntries ||
      (candidate.unchanged && !items.isNull() && items.size() != 0)) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  for (const auto itemValue : items) {
    if (!itemValue.is<ArduinoJson::JsonObjectConst>()) {
      setFailure(failure, ApiErrorCode::InvalidResponse);
      return false;
    }
    const auto item = itemValue.as<ArduinoJson::JsonObjectConst>();
    CacheItem parsed;
    if (!requiredString(item, "employeeId", kMaxId, parsed.employeeId) ||
        !requiredString(item, "displayName", kMaxDisplayName,
                        parsed.displayName) ||
        !requiredString(item, "uid", kMaxUid, parsed.uid) ||
        !validUid(parsed.uid) || !parseWorkState(item["state"], parsed.state)) {
      setFailure(failure, ApiErrorCode::InvalidResponse);
      return false;
    }
    candidate.items[candidate.itemCount++] = std::move(parsed);
  }
  output = std::move(candidate);
  failure = {};
  return true;
}

bool ApiCodec::decodeAdminSession(std::string_view json,
                                  AdminSessionResponse& output,
                                  ApiFailure& failure) {
  BoundedDocument<kMaxAdminResponseBytes * 4U> bounded;
  if (!parseJson<kMaxAdminResponseBytes>(json, bounded, failure)) return false;
  const auto root = bounded.document.as<ArduinoJson::JsonObjectConst>();
  AdminSessionResponse candidate;
  if (!requiredString(root, "token", kMaxAdminToken, candidate.token) ||
      candidate.token.rfind("ojtadmin_", 0) != 0 ||
      !requiredString(root, "idleExpiresAt", kMaxTimestamp,
                      candidate.idleExpiresAt)) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  output = std::move(candidate);
  failure = {};
  return true;
}

bool ApiCodec::decodeEmployees(std::string_view json,
                               EmployeeListResponse& output,
                               ApiFailure& failure) {
  BoundedDocument<kMaxEmployeeResponseBytes * 2U> bounded;
  if (!parseJson<kMaxEmployeeResponseBytes>(json, bounded, failure)) return false;
  const auto root = bounded.document.as<ArduinoJson::JsonObjectConst>();
  if (!root["items"].is<ArduinoJson::JsonArrayConst>()) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  const auto items = root["items"].as<ArduinoJson::JsonArrayConst>();
  if (items.size() > kMaxApiEmployees) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  EmployeeListResponse candidate;
  for (const auto itemValue : items) {
    if (!itemValue.is<ArduinoJson::JsonObjectConst>()) {
      setFailure(failure, ApiErrorCode::InvalidResponse);
      return false;
    }
    const auto item = itemValue.as<ArduinoJson::JsonObjectConst>();
    TerminalEmployee parsed;
    if (!requiredString(item, "id", kMaxId, parsed.id) ||
        !requiredString(item, "name", kMaxEmployeeName, parsed.name) ||
        !requiredString(item, "displayName", kMaxDisplayName,
                        parsed.displayName) ||
        !requiredBool(item, "hasRfidTag", parsed.hasRfidTag)) {
      setFailure(failure, ApiErrorCode::InvalidResponse);
      return false;
    }
    candidate.items[candidate.itemCount++] = std::move(parsed);
  }
  output = std::move(candidate);
  failure = {};
  return true;
}

bool ApiCodec::decodeSync(std::string_view json, SyncResponse& output,
                          ApiFailure& failure) {
  BoundedDocument<kMaxSyncResponseBytes * 2U> bounded;
  if (!parseJson<kMaxSyncResponseBytes>(json, bounded, failure)) return false;
  const auto root = bounded.document.as<ArduinoJson::JsonObjectConst>();
  if (!root["items"].is<ArduinoJson::JsonArrayConst>()) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  const auto items = root["items"].as<ArduinoJson::JsonArrayConst>();
  if (items.size() > kMaxApiSyncItems) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  SyncResponse candidate;
  if (!requiredString(root, "serverTime", kMaxTimestamp,
                      candidate.serverTime)) {
    setFailure(failure, ApiErrorCode::InvalidResponse);
    return false;
  }
  for (const auto itemValue : items) {
    if (!itemValue.is<ArduinoJson::JsonObjectConst>()) {
      setFailure(failure, ApiErrorCode::InvalidResponse);
      return false;
    }
    ActionResult parsed;
    if (!parseActionResultObject(itemValue.as<ArduinoJson::JsonObjectConst>(),
                                 parsed)) {
      setFailure(failure, ApiErrorCode::InvalidResponse);
      return false;
    }
    candidate.items[candidate.itemCount++] = std::move(parsed);
  }
  output = std::move(candidate);
  failure = {};
  return true;
}

bool ApiCodec::decodeError(std::string_view json, int httpStatus,
                           ApiFailure& failure) {
  BoundedDocument<kMaxErrorResponseBytes * 4U> bounded;
  ApiFailure parseFailure;
  if (!parseJson<kMaxErrorResponseBytes>(json, bounded, parseFailure)) {
    return false;
  }
  const auto root = bounded.document.as<ArduinoJson::JsonObjectConst>();
  std::string code;
  if (!requiredString(root, "code", 48, code)) {
    return false;
  }
  const ApiErrorCode parsed = parseErrorCode(code);
  ApiFailure candidate;
  setFailure(candidate, parsed, httpStatus,
             httpStatus >= 500 || httpStatus == 408 || httpStatus == 429);
  if (parsed == ApiErrorCode::StateConflict) {
    ApiWorkState state;
    if (httpStatus != 409 || !parseWorkState(root["state"], state)) {
      return false;
    }
    candidate.authoritativeState = std::move(state);
  }
  uint32_t retry = 0;
  if (!root["retryAfterSeconds"].isNull()) {
    if (!requiredUnsigned(root, "retryAfterSeconds", 24U * 60U * 60U,
                          retry)) {
      return false;
    }
    candidate.retryAfterSeconds = retry;
  }
  failure = std::move(candidate);
  return true;
}

bool ApiCodec::encodeBootstrap(const BootstrapRequest& request,
                               std::string& output) {
  if (request.protocolVersion != kTerminalProtocolVersion ||
      !validText(request.clientVersion, kMaxVersion, false) ||
      request.pendingCount > OutboxCodec::kCapacity) {
    return false;
  }
  BoundedDocument<8192> bounded;
  auto root = bounded.document.to<ArduinoJson::JsonObject>();
  root["protocolVersion"] = request.protocolVersion;
  root["clientVersion"] = request.clientVersion;
  root["pendingCount"] = request.pendingCount;
  return serializeDocument(bounded.document, bounded.allocator, output);
}

bool ApiCodec::encodeResolveUid(std::string_view uid, std::string& output) {
  if (!validUid(uid)) return false;
  BoundedDocument<8192> bounded;
  bounded.document["uid"] = uid;
  return serializeDocument(bounded.document, bounded.allocator, output);
}

bool ApiCodec::encodeAction(const ActionRequest& request,
                            std::string& output) {
  if (!validActionRequest(request)) return false;
  BoundedDocument<8192> bounded;
  auto root = bounded.document.to<ArduinoJson::JsonObject>();
  root["clientRequestId"] = request.clientRequestId;
  root["scanContext"] = request.scanContext;
  root["command"] = commandApiValue(request.command);
  root["deviceCapturedAt"] = request.deviceCapturedAt;
  if (!request.appliedAt.empty()) root["appliedAt"] = request.appliedAt;
  root["clockSyncedAt"] = request.clockSyncedAt;
  root["deviceSequence"] = request.deviceSequence;
  return serializeDocument(bounded.document, bounded.allocator, output);
}

bool ApiCodec::encodeAdminPin(std::string_view pin, std::string& output) {
  if (pin.size() != 4 || !std::all_of(pin.begin(), pin.end(), [](char byte) {
        return byte >= '0' && byte <= '9';
      })) {
    return false;
  }
  BoundedDocument<8192> bounded;
  bounded.document["pin"] = pin;
  return serializeDocument(bounded.document, bounded.allocator, output);
}

bool ApiCodec::encodeAssignEmployee(std::string_view uid, bool replace,
                                    std::string& output) {
  if (!validUid(uid)) return false;
  BoundedDocument<8192> bounded;
  bounded.document["uid"] = uid;
  bounded.document["replace"] = replace;
  return serializeDocument(bounded.document, bounded.allocator, output);
}

bool ApiCodec::encodeSync(const SyncRequest& request, std::string& output) {
  if (request.actions.empty() || request.actions.size() > kMaxApiSyncItems ||
      request.pendingCount > OutboxCodec::kCapacity) {
    return false;
  }
  BoundedDocument<kMaxRequestBytes * 2U> bounded;
  auto root = bounded.document.to<ArduinoJson::JsonObject>();
  auto actions = root["actions"].to<ArduinoJson::JsonArray>();
  for (const auto& action : request.actions) {
    const char* command = commandApiValue(action.command);
    if (!validText(action.clientRequestId, kMaxId, false) ||
        !validUid(action.uid) || command == nullptr ||
        !validText(action.deviceCapturedAt, kMaxTimestamp, false) ||
        !validText(action.appliedAt, kMaxTimestamp, true) ||
        !validText(action.clockSyncedAt, kMaxTimestamp, false) ||
        action.deviceSequence == 0 ||
        !validText(action.rebootId, kMaxId, false) ||
        !validText(action.previousLocalHash, kMaxHash, true) ||
        !validText(action.signature, kMaxHash, false)) {
      return false;
    }
    auto item = actions.add<ArduinoJson::JsonObject>();
    item["clientRequestId"] = action.clientRequestId;
    item["uid"] = action.uid;
    item["command"] = command;
    item["deviceCapturedAt"] = action.deviceCapturedAt;
    if (!action.appliedAt.empty()) item["appliedAt"] = action.appliedAt;
    item["clockSyncedAt"] = action.clockSyncedAt;
    item["deviceSequence"] = action.deviceSequence;
    item["rebootId"] = action.rebootId;
    item["previousLocalHash"] = action.previousLocalHash;
    item["signature"] = action.signature;
  }
  root["pendingCount"] = request.pendingCount;
  return serializeDocument(bounded.document, bounded.allocator, output);
}

}  // namespace openjornada
