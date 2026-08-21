#include <unity.h>

#include <string>

#include "openjornada/api_models.hpp"

using namespace openjornada;

namespace {

const char* kIdleState = R"json({
  "kind":"idle","since":null,"workedSeconds":0,"breakSeconds":0,
  "longShift":false,"staleBreak":false,
  "actions":[{"command":"clock_in","label":"Comenzar jornada","mode":"now","highlighted":false}]
})json";

void test_bootstrap_contract_is_decoded() {
  const std::string json = R"json({
    "protocol":{"current":1,"min":1,"max":1},
    "serverTime":"2026-08-21T14:00:00.123Z",
    "timezone":"Europe/Madrid",
    "terminal":{"id":"terminal123","organization":"org123","name":"Recepción","prefix":"ABCD1234","protocolVersion":1,"clientVersion":"firmware-1","cacheRevision":7,"lastSeenAt":"2026-08-21T14:00:00Z","lastPendingCount":0,"revokedAt":"","createdBy":"admin","created":"2026-08-20T10:00:00Z","pendingQueueWarning":false},
    "cacheRevision":7,"maxOfflineSeconds":86400,"maxQueuedActions":10000
  })json";
  BootstrapResponse output;
  ApiFailure failure;
  TEST_ASSERT_TRUE(ApiCodec::decodeBootstrap(json, output, failure));
  TEST_ASSERT_EQUAL_UINT8(1, output.protocol.current);
  TEST_ASSERT_EQUAL_UINT32(7, output.cacheRevision);
  TEST_ASSERT_EQUAL_STRING("Europe/Madrid", output.timezone.c_str());
}

void test_protocol_mismatch_does_not_mutate_output() {
  BootstrapResponse output;
  output.cacheRevision = 91;
  ApiFailure failure;
  const std::string json = R"json({"protocol":{"current":2,"min":2,"max":2},"serverTime":"2026-08-21T14:00:00Z","timezone":"Europe/Madrid","terminal":{"id":"t","organization":"o","name":"n","prefix":"p","protocolVersion":2,"clientVersion":"v","cacheRevision":1,"lastSeenAt":"","lastPendingCount":0,"revokedAt":"","createdBy":"a","created":"","pendingQueueWarning":false},"cacheRevision":1,"maxOfflineSeconds":86400,"maxQueuedActions":10000})json";
  TEST_ASSERT_FALSE(ApiCodec::decodeBootstrap(json, output, failure));
  TEST_ASSERT_EQUAL(ApiErrorCode::ProtocolIncompatible, failure.code);
  TEST_ASSERT_EQUAL_UINT32(91, output.cacheRevision);
}

void test_missing_required_field_is_rejected_without_mutation() {
  ResolveResponse output;
  output.employee.displayName = "Conservar";
  ApiFailure failure;
  const std::string json = R"json({"scanContext":"ctx","expiresAt":"2026-08-21T14:00:10Z","employee":{"id":"employee"},"state":{"kind":"idle","since":null,"workedSeconds":0,"breakSeconds":0,"longShift":false,"staleBreak":false,"actions":[]}})json";
  TEST_ASSERT_FALSE(ApiCodec::decodeResolve(json, output, failure));
  TEST_ASSERT_EQUAL(ApiErrorCode::InvalidResponse, failure.code);
  TEST_ASSERT_EQUAL_STRING("Conservar", output.employee.displayName.c_str());
}

void test_resolve_contract_is_decoded() {
  std::string json = R"json({"scanContext":"ctx.123","expiresAt":"2026-08-21T14:00:10Z","employee":{"id":"employee","displayName":"Marina R."},"state":)json";
  json += kIdleState;
  json += "}";
  ResolveResponse output;
  ApiFailure failure;
  TEST_ASSERT_TRUE(ApiCodec::decodeResolve(json, output, failure));
  TEST_ASSERT_EQUAL_STRING("Marina R.", output.employee.displayName.c_str());
  TEST_ASSERT_EQUAL_UINT8(1, output.state.actionCount);
}

void test_cache_over_thirty_is_rejected_without_mutation() {
  std::string json = R"json({"revision":8,"unchanged":false,"items":[)json";
  for (int index = 0; index < 31; ++index) {
    if (index) json += ',';
    json += R"json({"employeeId":"e)json" + std::to_string(index) +
            R"json(","displayName":"P.","uid":"04AABB)json" +
            (index < 10 ? "0" : "") + std::to_string(index) +
            R"json(","state":)json" + kIdleState + "}";
  }
  json += "]}";
  CacheResponse output;
  output.revision = 44;
  ApiFailure failure;
  TEST_ASSERT_FALSE(ApiCodec::decodeCache(json, output, failure));
  TEST_ASSERT_EQUAL(ApiErrorCode::InvalidResponse, failure.code);
  TEST_ASSERT_EQUAL_UINT32(44, output.revision);
}

void test_unknown_action_status_is_rejected() {
  std::string json = R"json({"clientRequestId":"req-1","status":"maybe","state":)json";
  json += kIdleState;
  json += "}";
  ActionResult output;
  ApiFailure failure;
  TEST_ASSERT_FALSE(ApiCodec::decodeActionResult(json, output, failure));
  TEST_ASSERT_EQUAL(ApiErrorCode::InvalidResponse, failure.code);
}

void test_error_codes_use_safe_spanish_messages() {
  struct Fixture { const char* code; ApiErrorCode expected; };
  const Fixture fixtures[] = {
      {"authentication_required", ApiErrorCode::AuthenticationRequired},
      {"terminal_revoked", ApiErrorCode::TerminalRevoked},
      {"clock_untrusted", ApiErrorCode::ClockUntrusted},
      {"pin_rate_limited", ApiErrorCode::PinRateLimited},
      {"pin_invalid", ApiErrorCode::PinInvalid},
      {"pin_not_configured", ApiErrorCode::PinNotConfigured},
      {"replacement_required", ApiErrorCode::ReplacementRequired},
      {"uid_in_use", ApiErrorCode::UidInUse},
      {"admin_session_required", ApiErrorCode::AdminSessionRequired},
      {"admin_session_expired", ApiErrorCode::AdminSessionExpired},
      {"rfid_capacity_reached", ApiErrorCode::RfidCapacityReached},
      {"unknown_tag", ApiErrorCode::UnknownTag},
      {"uid_revoked", ApiErrorCode::UidRevoked},
      {"scan_context_expired", ApiErrorCode::ScanContextExpired},
      {"protocol_incompatible", ApiErrorCode::ProtocolIncompatible},
      {"invalid_signature", ApiErrorCode::InvalidSignature},
      {"incident_failed", ApiErrorCode::IncidentFailed},
  };
  for (const auto& fixture : fixtures) {
    const std::string json = std::string{"{\"status\":400,\"code\":\""} +
                             fixture.code +
                             "\",\"message\":\"mensaje controlado por servidor\",\"data\":{}}";
    ApiFailure failure;
    TEST_ASSERT_TRUE(ApiCodec::decodeError(json, 400, failure));
    TEST_ASSERT_EQUAL(fixture.expected, failure.code);
    TEST_ASSERT_NOT_EQUAL(0, failure.safeMessage.size());
    TEST_ASSERT_EQUAL_STRING(safeApiErrorMessage(fixture.expected),
                             failure.safeMessage.c_str());
  }
}

void test_state_conflict_preserves_authoritative_work_state() {
  // Exact shape returned by internal/terminal/events.go for HTTP 409.
  const std::string json = R"json({"status":409,"code":"state_conflict","message":"El estado de la jornada ha cambiado.","state":{"kind":"on_break","since":"2026-08-21T13:00:00Z","workedSeconds":14400,"breakSeconds":600,"longShift":true,"staleBreak":false,"actions":[{"command":"break_end","label":"Terminar pausa","mode":"now","highlighted":true},{"command":"clock_out","label":"Terminar jornada","mode":"close_from_break","highlighted":false}]}})json";
  ApiFailure failure;
  TEST_ASSERT_TRUE(ApiCodec::decodeError(json, 409, failure));
  TEST_ASSERT_EQUAL(ApiErrorCode::StateConflict, failure.code);
  TEST_ASSERT_TRUE(failure.authoritativeState.has_value());
  TEST_ASSERT_EQUAL(WorkKind::OnBreak, failure.authoritativeState->kind);
  TEST_ASSERT_EQUAL_INT32(14400, failure.authoritativeState->workedSeconds);
  TEST_ASSERT_EQUAL_UINT8(2, failure.authoritativeState->actionCount);
  TEST_ASSERT_EQUAL(Command::BreakEnd,
                    failure.authoritativeState->actions[0].command);
}

void test_malformed_state_conflict_does_not_mutate_failure() {
  ApiFailure failure;
  failure.code = ApiErrorCode::AuthenticationRequired;
  failure.httpStatus = 401;
  ApiWorkState previous;
  previous.kind = WorkKind::Working;
  previous.workedSeconds = 99;
  failure.authoritativeState = previous;

  const std::string malformed =
      R"json({"status":409,"code":"state_conflict","message":"no usar","state":{"kind":"working","workedSeconds":120}})json";
  TEST_ASSERT_FALSE(ApiCodec::decodeError(malformed, 409, failure));
  TEST_ASSERT_EQUAL(ApiErrorCode::AuthenticationRequired, failure.code);
  TEST_ASSERT_EQUAL_INT(401, failure.httpStatus);
  TEST_ASSERT_TRUE(failure.authoritativeState.has_value());
  TEST_ASSERT_EQUAL_INT32(99, failure.authoritativeState->workedSeconds);
}

void test_requests_are_serialized_with_protocol_field_names() {
  std::string json;
  TEST_ASSERT_TRUE(ApiCodec::encodeBootstrap(
      BootstrapRequest{1, "m5stack-1.0.0", 3}, json));
  TEST_ASSERT_NOT_EQUAL(std::string::npos, json.find("\"protocolVersion\":1"));
  TEST_ASSERT_NOT_EQUAL(std::string::npos, json.find("\"pendingCount\":3"));

  ActionRequest action;
  action.clientRequestId = "req-1";
  action.scanContext = "ctx";
  action.command = Command::ClockIn;
  action.deviceCapturedAt = "2026-08-21T14:00:00Z";
  action.clockSyncedAt = "2026-08-21T14:00:00Z";
  action.deviceSequence = 1;
  TEST_ASSERT_TRUE(ApiCodec::encodeAction(action, json));
  TEST_ASSERT_NOT_EQUAL(std::string::npos, json.find("\"command\":\"clock_in\""));
}

void test_admin_and_employee_contracts_are_bounded() {
  AdminSessionResponse session;
  ApiFailure failure;
  TEST_ASSERT_TRUE(ApiCodec::decodeAdminSession(
      R"json({"token":"ojtadmin_abcdefghijklmnopqrstuvwxyz","idleExpiresAt":"2026-08-21T14:05:00Z"})json",
      session, failure));
  TEST_ASSERT_EQUAL_STRING("ojtadmin_abcdefghijklmnopqrstuvwxyz",
                           session.token.c_str());

  EmployeeListResponse employees;
  TEST_ASSERT_TRUE(ApiCodec::decodeEmployees(
      R"json({"items":[{"id":"employee1","name":"Marina Ruiz","displayName":"Marina R.","hasRfidTag":true}]})json",
      employees, failure));
  TEST_ASSERT_EQUAL_UINT8(1, employees.itemCount);
  TEST_ASSERT_TRUE(employees.items[0].hasRfidTag);
}

void test_sync_contract_and_request_are_bounded() {
  TEST_ASSERT_EQUAL_UINT32(500, kProtocolMaxSyncItems);
  TEST_ASSERT_EQUAL_UINT32(50, kMaxApiSyncItems);
  TEST_ASSERT_TRUE(kMaxApiSyncItems < kProtocolMaxSyncItems);
  std::string response =
      R"json({"items":[{"clientRequestId":"req-1","status":"accepted","workEventId":"event1","state":)json";
  response += kIdleState;
  response += R"json(}],"serverTime":"2026-08-21T14:00:01Z"})json";
  SyncResponse sync;
  ApiFailure failure;
  TEST_ASSERT_TRUE(ApiCodec::decodeSync(response, sync, failure));
  TEST_ASSERT_EQUAL_UINT8(1, sync.itemCount);
  TEST_ASSERT_EQUAL(ActionStatus::Accepted, sync.items[0].status);

  SyncRequest request;
  QueuedAction action;
  action.clientRequestId = "req-1";
  action.uid = "04AABBCC";
  action.command = Command::ClockIn;
  action.deviceCapturedAt = "2026-08-21T14:00:00Z";
  action.clockSyncedAt = "2026-08-21T14:00:00Z";
  action.deviceSequence = 1;
  action.rebootId = "boot-1";
  action.signature = std::string(64, 'A');
  request.actions.push_back(action);
  request.pendingCount = 1;
  std::string encoded;
  TEST_ASSERT_TRUE(ApiCodec::encodeSync(request, encoded));
  TEST_ASSERT_NOT_EQUAL(std::string::npos,
                        encoded.find("\"previousLocalHash\":\"\""));

  request.actions.resize(kMaxApiSyncItems + 1, action);
  TEST_ASSERT_FALSE(ApiCodec::encodeSync(request, encoded));
}

void test_oversized_json_is_rejected_before_parse() {
  BootstrapResponse output;
  output.cacheRevision = 17;
  ApiFailure failure;
  const std::string oversized(ApiCodec::kMaxBootstrapResponseBytes + 1, ' ');
  TEST_ASSERT_FALSE(ApiCodec::decodeBootstrap(oversized, output, failure));
  TEST_ASSERT_EQUAL(ApiErrorCode::InvalidResponse, failure.code);
  TEST_ASSERT_EQUAL_UINT32(17, output.cacheRevision);
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_bootstrap_contract_is_decoded);
  RUN_TEST(test_protocol_mismatch_does_not_mutate_output);
  RUN_TEST(test_missing_required_field_is_rejected_without_mutation);
  RUN_TEST(test_resolve_contract_is_decoded);
  RUN_TEST(test_cache_over_thirty_is_rejected_without_mutation);
  RUN_TEST(test_unknown_action_status_is_rejected);
  RUN_TEST(test_error_codes_use_safe_spanish_messages);
  RUN_TEST(test_state_conflict_preserves_authoritative_work_state);
  RUN_TEST(test_malformed_state_conflict_does_not_mutate_failure);
  RUN_TEST(test_requests_are_serialized_with_protocol_field_names);
  RUN_TEST(test_admin_and_employee_contracts_are_bounded);
  RUN_TEST(test_sync_contract_and_request_are_bounded);
  RUN_TEST(test_oversized_json_is_rejected_before_parse);
  return UNITY_END();
}
