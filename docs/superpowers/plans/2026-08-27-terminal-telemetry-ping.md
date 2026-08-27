# Terminal Telemetry and Ping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar telemetría útil y disponibilidad de cada terminal RFID en Integraciones y permitir que administración o responsables ejecuten un ping silencioso con IP efímera.

**Architecture:** PocketBase persiste únicamente telemetría no sensible recibida por heartbeats de 15 segundos y coordina cada ping mediante un reto en memoria con TTL de 20 segundos. El M5Stack usa un worker de telemetría independiente y de una sola ranura para que un heartbeat en vuelo no ocupe el worker de fichajes. Angular refresca las tarjetas cada 30 segundos y conserva el resultado sensible del ping solo en memoria durante 10 minutos.

**Tech Stack:** Go 1.25, PocketBase 0.39.10, migraciones JavaScript, Angular 22 standalone y signals, Tailwind CSS 4, Vitest 4, Playwright 1.62, PlatformIO, ESP32 Arduino/C++17 y Unity.

**Spec:** `docs/superpowers/specs/2026-08-27-terminal-telemetry-ping-design.md`

## Global Constraints

- El heartbeat se intenta cada 15 segundos y `online` significa `lastHeartbeatAt < 45 segundos`; a partir de 45 segundos es `offline`.
- El ping administrativo espera como máximo 20 segundos y solo puede existir uno simultáneo por terminal.
- Las IP local y pública solo existen en el acuse, la respuesta administrativa y una signal Angular; nunca se guardan en PocketBase, logs, auditoría, Web Storage, IndexedDB o analítica.
- El resultado con IP desaparece 10 minutos después de recibirse, al recargar o al abandonar Integraciones.
- El ping es silencioso: no cambia pantalla, sonido, estado RFID, outbox ni feedback del dispositivo.
- Un terminal revocado no acepta heartbeat ni acuse, no puede responder a ping y siempre aparece `revoked`.
- `admin` y `manager` pueden listar diagnóstico y hacer ping dentro de su empresa; solo `admin` conserva rotación, renombrado y revocación.
- Las acciones, la sincronización de fichajes, la caché y la administración local no esperan al worker de telemetría.
- La señal Wi-Fi se etiqueta `Buena` desde −67 dBm, `Aceptable` entre −68 y −79 dBm y `Débil` desde −80 dBm.
- Todos los textos visibles, mensajes de error, documentación y etiquetas accesibles permanecen en español.
- Cada cambio de esquema usa una migración nueva; no se modifica `1787047200_rfid_terminals.js`.
- No leer, mostrar, modificar ni añadir `.env`; no registrar tokens, API keys, UIDs o IP.
- Conservar cambios ajenos, revisar `git diff --check` y el diff completo antes de cada commit.

---

### Task 1: Esquema de telemetría y estado derivado del terminal

**Files:**
- Create: `backend/pb_migrations/1787824800_terminal_telemetry.js`
- Modify: `internal/terminal/admin.go`
- Modify: `internal/terminal/events.go`
- Create: `internal/terminal/telemetry_test.go`

**Interfaces:**
- Consumes: colección `attendance_terminals`, `terminalRecordView(record, raw)` y `syncActions(e)` existentes.
- Produces: campos `lastHeartbeatAt`, `lastAttendanceSyncAt`, `lastClockStatus`, `lastNtpSyncAt`, `lastWifiRssiDbm`, `lastUptimeSeconds`; tipo JSON `connectionStatus`; función `terminalConnectionStatus(record *core.Record, now time.Time) string`.

- [ ] **Step 1: Escribir las pruebas fallidas del límite online y de la vista JSON**

Create `internal/terminal/telemetry_test.go` with a focused record factory and these assertions:

```go
func TestTerminalConnectionStatus(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name, heartbeat, revoked, want string
	}{
		{"fresh at 44 seconds", now.Add(-44 * time.Second).Format(time.RFC3339Nano), "", "online"},
		{"offline at exact boundary", now.Add(-45 * time.Second).Format(time.RFC3339Nano), "", "offline"},
		{"offline without heartbeat", "", "", "offline"},
		{"revoked overrides fresh heartbeat", now.Add(-time.Second).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), "revoked"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			record := telemetryTerminalRecord(t, tt.heartbeat, tt.revoked)
			if got := terminalConnectionStatus(record, now); got != tt.want {
				t.Fatalf("terminalConnectionStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTerminalRecordViewIncludesNonSensitiveTelemetry(t *testing.T) {
	record := telemetryTerminalRecord(t, "2026-08-27T11:59:50Z", "")
	record.Set("lastAttendanceSyncAt", "2026-08-27T11:58:00Z")
	record.Set("lastClockStatus", "synced")
	record.Set("lastNtpSyncAt", "2026-08-27T11:57:00Z")
	record.Set("lastWifiRssiDbm", -61)
	record.Set("lastUptimeSeconds", 7200)
	view := terminalRecordViewAt(record, "", time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC))
	if view.ConnectionStatus != "online" || view.LastWifiRssiDbm == nil || *view.LastWifiRssiDbm != -61 || view.LastUptimeSeconds == nil || *view.LastUptimeSeconds != 7200 {
		t.Fatalf("unexpected telemetry view: %#v", view)
	}
}
```

The helper must create an in-memory base collection containing every field read by `terminalRecordViewAt`; it must not include any IP field.

- [ ] **Step 2: Ejecutar las pruebas para verificar el fallo inicial**

Run:

```bash
go test ./internal/terminal -run 'TestTerminal(ConnectionStatus|RecordViewIncludes)' -count=1
```

Expected: FAIL because `terminalConnectionStatus`, `terminalRecordViewAt` and the telemetry fields do not exist.

- [ ] **Step 3: Crear la migración reversible**

Create `1787824800_terminal_telemetry.js` with exactly these schema additions:

```js
migrate((app) => {
  const terminals = app.findCollectionByNameOrId("attendance_terminals")
  terminals.fields.add(new DateField({ name: "lastHeartbeatAt" }))
  terminals.fields.add(new DateField({ name: "lastAttendanceSyncAt" }))
  terminals.fields.add(new SelectField({
    name: "lastClockStatus",
    maxSelect: 1,
    values: ["synced", "stale", "unsynced"],
  }))
  terminals.fields.add(new DateField({ name: "lastNtpSyncAt" }))
  terminals.fields.add(new NumberField({ name: "lastWifiRssiDbm", min: -127, max: 0 }))
  terminals.fields.add(new NumberField({ name: "lastUptimeSeconds", min: 0, max: 4294967295 }))
  app.save(terminals)
}, (app) => {
  const terminals = app.findCollectionByNameOrId("attendance_terminals")
  for (const name of [
    "lastUptimeSeconds",
    "lastWifiRssiDbm",
    "lastNtpSyncAt",
    "lastClockStatus",
    "lastAttendanceSyncAt",
    "lastHeartbeatAt",
  ]) terminals.fields.removeByName(name)
  app.save(terminals)
})
```

- [ ] **Step 4: Ampliar la vista administrativa con estado derivado**

Add fields to `terminalView` and keep the current `terminalRecordView` wrapper for existing callers:

```go
const terminalOnlineWindow = 45 * time.Second

type terminalView struct {
	ConnectionStatus     string `json:"connectionStatus"`
	LastHeartbeatAt      string `json:"lastHeartbeatAt"`
	LastAttendanceSyncAt string `json:"lastAttendanceSyncAt"`
	LastClockStatus      string `json:"lastClockStatus"`
	LastNtpSyncAt        string `json:"lastNtpSyncAt"`
	LastWifiRssiDbm      *int   `json:"lastWifiRssiDbm"`
	LastUptimeSeconds    *int   `json:"lastUptimeSeconds"`
}

func terminalConnectionStatus(record *core.Record, now time.Time) string {
	if record.GetString("revokedAt") != "" { return "revoked" }
	heartbeat := record.GetDateTime("lastHeartbeatAt").Time()
	if heartbeat.IsZero() || !heartbeat.After(now.Add(-terminalOnlineWindow)) { return "offline" }
	return "online"
}

func terminalRecordView(record *core.Record, raw string) terminalView {
	return terminalRecordViewAt(record, raw, time.Now())
}
```

`terminalRecordViewAt` must copy all six telemetry fields plus existing metadata and must not expose `tokenHash`, `signingMaterial` or any IP. It returns `nil` for both numeric pointers until `lastHeartbeatAt` exists; after the first valid heartbeat it returns the stored numbers, including a legitimate uptime of zero.

- [ ] **Step 5: Marcar una sincronización únicamente después de una respuesta completa**

In `syncActions`, replace the ignored save with an authoritative save before returning `200`:

```go
completedAt := time.Now()
principal.Terminal.Set("lastSeenAt", completedAt)
principal.Terminal.Set("lastAttendanceSyncAt", completedAt)
principal.Terminal.Set("lastPendingCount", maxInt(0, body.PendingCount-len(results)))
if err := e.App.Save(principal.Terminal); err != nil {
	return e.InternalServerError("No se pudo actualizar la sincronización del terminal.", err)
}
return e.JSON(http.StatusOK, map[string]any{
	"items": results,
	"serverTime": completedAt.UTC().Format(time.RFC3339Nano),
})
```

- [ ] **Step 6: Verificar migración, pruebas y diff**

Run:

```bash
node --check backend/pb_migrations/1787824800_terminal_telemetry.js
gofmt -w internal/terminal/admin.go internal/terminal/events.go internal/terminal/telemetry_test.go
go test ./internal/terminal -count=1
git diff --check
```

Expected: PASS; the migration contains no field named `ip`, `localIp` or `publicIp`.

- [ ] **Step 7: Commit**

```bash
git add backend/pb_migrations/1787824800_terminal_telemetry.js internal/terminal/admin.go internal/terminal/events.go internal/terminal/telemetry_test.go
git commit -m "feat(terminal): persist operational telemetry"
```

---

### Task 2: Heartbeat, coordinador en memoria y ping administrativo

**Files:**
- Modify: `internal/terminal/service.go`
- Modify: `internal/terminal/admin.go`
- Create: `internal/terminal/telemetry.go`
- Create: `internal/terminal/ping_broker.go`
- Create: `internal/terminal/ping_broker_test.go`
- Modify: `internal/terminal/telemetry_test.go`

**Interfaces:**
- Consumes: `Service`, `terminalOrUnauthorized`, `requireRFIDManager`, `findOwnedTerminal` and telemetry schema from Task 1.
- Produces: `POST /api/openjornada/terminal/v1/heartbeat`, `POST /api/openjornada/terminal/v1/ping-ack`, `POST /api/openjornada/terminals/{id}/ping`; `newPingBroker(ttl time.Duration) *pingBroker`; `begin`, `challenge`, `acknowledge`, `cancel` broker operations; `findTerminalForOrganization(app, terminalID, organizationID)` tenant-safe lookup.

- [ ] **Step 1: Escribir pruebas fallidas del coordinador concurrente**

Create `ping_broker_test.go` with deterministic injected times:

```go
func TestPingBrokerRoundTripAndOneTimeChallenge(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil { t.Fatal(err) }
	if _, err := broker.begin("terminal-a", now); !errors.Is(err, errPingInProgress) {
		t.Fatalf("second begin error = %v", err)
	}
	challenge, ok := broker.challenge("terminal-a", now.Add(5*time.Second))
	if !ok || challenge == "" { t.Fatal("missing challenge") }
	result, err := broker.acknowledge("terminal-a", challenge, pingDeviceResult{
		LocalIP: "192.168.1.44", PublicIP: "203.0.113.9", WifiRSSIDbm: -62, UptimeSeconds: 81,
	}, now.Add(6*time.Second))
	if err != nil { t.Fatal(err) }
	if result.WaitForHeartbeatMs != 5000 || result.ResponseMs != 1000 || result.TotalLatencyMs != 6000 {
		t.Fatalf("unexpected timings: %#v", result)
	}
	if got := <-waiter.Completion; got.Err != nil || got.Result.LocalIP != "192.168.1.44" { t.Fatalf("unexpected completion: %#v", got) }
	if _, err := broker.acknowledge("terminal-a", challenge, pingDeviceResult{}, now.Add(7*time.Second)); !errors.Is(err, errPingNotPending) {
		t.Fatalf("challenge must be one-time: %v", err)
	}
}
```

Add separate tests for wrong terminal, wrong challenge, expiry at 20 seconds, cancel, and a repeated `challenge()` that preserves the original delivery time.

- [ ] **Step 2: Ejecutar el test del broker y confirmar el fallo**

```bash
go test ./internal/terminal -run TestPingBroker -count=1
```

Expected: FAIL because the broker types and methods are absent.

- [ ] **Step 3: Implementar el broker sin persistencia ni goroutines huérfanas**

Use one mutex and a buffered result channel of capacity one:

```go
var (
	errPingInProgress = errors.New("ping already in progress")
	errPingNotPending = errors.New("ping not pending")
	errPingExpired = errors.New("ping expired")
)

type pingDeviceResult struct {
	LocalIP string
	PublicIP string
	WifiRSSIDbm int
	UptimeSeconds uint64
}

type pingResult struct {
	pingDeviceResult
	WaitForHeartbeatMs int64
	ResponseMs int64
	TotalLatencyMs int64
	CheckedAt time.Time
}

type pingCompletion struct { Result pingResult; Err error }

type pingWaiter struct {
	Challenge string
	Completion <-chan pingCompletion
}

type pendingPing struct {
	challenge string
	createdAt time.Time
	deliveredAt time.Time
	result chan pingCompletion
}

type pingBroker struct {
	mu sync.Mutex
	ttl time.Duration
	pending map[string]*pendingPing
}
```

Generate the challenge from 24 random bytes using `base64.RawURLEncoding`. `begin` returns `pingWaiter` with its challenge and receive-only completion channel; every cleanup deletes the same pending pointer under the mutex before notifying exactly once. `challenge` records `deliveredAt` only on its first delivery. `acknowledge` validates terminal and challenge with `subtle.ConstantTimeCompare`, computes milliseconds from server timestamps, deletes the entry, and performs a non-blocking success send to the buffered channel. `cancel(terminalID, challenge, err)` only removes that exact generation, preventing an old HTTP timeout from cancelling a newer ping. `cancelTerminal(terminalID, err)` is reserved for revocation and cancels whichever generation is active. Both send a completion error, so a waiter can never interpret cancellation as a zero-valued successful ping.

- [ ] **Step 4: Escribir pruebas fallidas de validación y persistencia del heartbeat**

Extend `telemetry_test.go` with a table for `heartbeatRequest.validate(now)`:

```go
func TestHeartbeatRequestValidation(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	valid := heartbeatRequest{ProtocolVersion: 1, ClientVersion: "m5stack-1.1.0", CacheRevision: 2, PendingCount: 0, WifiRSSIDbm: -61, UptimeSeconds: 90, ClockStatus: "synced", LastNtpSyncAt: "2026-08-27T11:59:00Z"}
	if err := valid.validate(now); err != nil { t.Fatal(err) }
	for name, mutate := range map[string]func(*heartbeatRequest){
		"protocol": func(v *heartbeatRequest) { v.ProtocolVersion = 2 },
		"pending": func(v *heartbeatRequest) { v.PendingCount = 10001 },
		"rssi": func(v *heartbeatRequest) { v.WifiRSSIDbm = 1 },
		"clock": func(v *heartbeatRequest) { v.ClockStatus = "invented" },
		"ntp missing": func(v *heartbeatRequest) { v.LastNtpSyncAt = "" },
	} {
		t.Run(name, func(t *testing.T) { candidate := valid; mutate(&candidate); if candidate.validate(now) == nil { t.Fatal("expected validation error") } })
	}
}
```

Also test `canonicalIP` with IPv4, IPv6 and invalid/oversized text, and `applyHeartbeat(record, request, serverNow)` to prove it writes only the six approved fields plus existing version/cache/pending/lastSeen fields.

Add an in-memory tenant test using two terminal records:

```go
func TestFindTerminalForOrganizationHidesForeignTerminal(t *testing.T) {
	app, terminalA, terminalB := telemetryTenantFixture(t)
	if got, err := findTerminalForOrganization(app, terminalA.Id, "organization-a"); err != nil || got.Id != terminalA.Id {
		t.Fatalf("own terminal lookup = (%v, %v)", got, err)
	}
	if got, err := findTerminalForOrganization(app, terminalB.Id, "organization-a"); err == nil || got != nil {
		t.Fatalf("foreign terminal must be hidden, got (%v, %v)", got, err)
	}
}
```

- [ ] **Step 5: Implementar modelos, validación y handlers de dispositivo**

Create `telemetry.go` with exact request types:

```go
type heartbeatRequest struct {
	ProtocolVersion int `json:"protocolVersion"`
	ClientVersion string `json:"clientVersion"`
	CacheRevision int `json:"cacheRevision"`
	PendingCount int `json:"pendingCount"`
	WifiRSSIDbm int `json:"wifiRssiDbm"`
	UptimeSeconds uint64 `json:"uptimeSeconds"`
	ClockStatus string `json:"clockStatus"`
	LastNtpSyncAt string `json:"lastNtpSyncAt"`
}

type pingAckRequest struct {
	PingChallenge string `json:"pingChallenge"`
	LocalIP string `json:"localIp"`
	WifiRSSIDbm int `json:"wifiRssiDbm"`
	UptimeSeconds uint64 `json:"uptimeSeconds"`
}
```

Validation must enforce protocol `1`, client version at most 40 trimmed bytes, cache revision and pending count `0..10000`, RSSI `-127..0`, uptime `<=4294967295`, one of the three clock states, and RFC3339 NTP evidence for `synced`/`stale`. `unsynced` requires empty `lastNtpSyncAt`; accepted NTP dates cannot be more than five minutes in the future.

`heartbeat` authenticates, validates fully, updates the record with server time, saves once, then returns:

```go
map[string]any{
	"serverTime": now.UTC().Format(time.RFC3339Nano),
	"pingChallenge": challenge, // empty string when no ping is pending
}
```

`ackPing` authenticates first, canonicalizes `localIp` with `net.ParseIP`, obtains `publicIp := e.RealIP()`, calls `s.pings.acknowledge`, and returns `{ "acknowledged": true }`. Do not include IP in any error value or message.

- [ ] **Step 6: Implementar el handler administrativo bloqueante y las rutas**

Add to `Service`:

```go
const terminalPingTimeout = 20 * time.Second

type Service struct {
	pings *pingBroker
}

func New(app core.App) *Service {
	return &Service{
		app: app,
		demoEnabled: enabledEnvironmentVariable("PB_DEMO_ENABLED"),
		allowPrivateHTTP: enabledEnvironmentVariable("PB_TERMINAL_DEV_INSECURE_HTTP"),
		pings: newPingBroker(terminalPingTimeout),
	}
}
```

Register all three routes with `apis.SkipSuccessActivityLog()`. Extract `findTerminalForOrganization` and make the existing `findOwnedTerminal` delegate to it while preserving the same `404` response. The admin handler must call `requireRFIDManager`, use `findOwnedTerminal`, reject revoked terminals with `409 terminal_revoked`, start the broker, and select among result, `time.NewTimer(20*time.Second)` and `e.Request.Context().Done()`. Map broker concurrency to `409 ping_in_progress` and timeout to `504 terminal_ping_timeout` through `apiError`.

After saving `revokedAt` successfully in `revokeTerminal`, call `s.pings.cancelTerminal(record.Id, errTerminalRevoked)` so a waiter cannot succeed after revocation. If saving fails, leave the pending ping intact because the terminal is still active. On request timeout or client cancellation, the ping handler calls `s.pings.cancel(record.Id, waiter.Challenge, cause)` before returning.

- [ ] **Step 7: Ejecutar pruebas backend completas**

```bash
gofmt -w internal/terminal/service.go internal/terminal/admin.go internal/terminal/telemetry.go internal/terminal/ping_broker.go internal/terminal/ping_broker_test.go internal/terminal/telemetry_test.go
go test ./internal/terminal -count=1
go test ./... -count=1
git diff --check
```

Expected: PASS under the race-safe broker tests; `rg -n 'Set\(".*[Ii]p|slog.*[Ii]p' internal/terminal` finds no new persistence or log statement.

- [ ] **Step 8: Commit**

```bash
git add internal/terminal
git commit -m "feat(terminal): add heartbeat and silent ping API"
```

---

### Task 3: Contrato C++ y worker aislado de telemetría

**Files:**
- Modify: `firmware/terminal/include/openjornada/api_models.hpp`
- Modify: `firmware/terminal/include/openjornada/api_client.hpp`
- Create: `firmware/terminal/include/openjornada/telemetry_worker.hpp`
- Modify: `firmware/terminal/src/network/api_codec.cpp`
- Modify: `firmware/terminal/src/network/esp32_api_client.cpp`
- Create: `firmware/terminal/src/network/telemetry_worker.cpp`
- Modify: `firmware/terminal/test/test_api_codec/test_main.cpp`
- Create: `firmware/terminal/test/test_telemetry_worker/test_main.cpp`

**Interfaces:**
- Consumes: `ApiCallResult`, `ApiCredentials`, bounded ArduinoJson codec and the existing HTTP request helper.
- Produces: `HeartbeatRequest`, `HeartbeatResponse`, `PingAckRequest`; `TelemetryClient`; `TelemetryWorker::begin/enqueue/poll/busy/processOne`; a single `TelemetryJob` that may perform heartbeat followed by ack.

- [ ] **Step 1: Añadir pruebas fallidas del JSON acotado**

Extend `test_api_codec/test_main.cpp`:

```cpp
void test_heartbeat_contract_round_trip() {
  HeartbeatRequest request{1, "m5stack-1.1.0", 7, 2, -63, 3600,
                           "synced", "2026-08-27T11:59:00Z"};
  std::string encoded;
  TEST_ASSERT_TRUE(ApiCodec::encodeHeartbeat(request, encoded));
  TEST_ASSERT_EQUAL_STRING(
      "{\"protocolVersion\":1,\"clientVersion\":\"m5stack-1.1.0\",\"cacheRevision\":7,\"pendingCount\":2,\"wifiRssiDbm\":-63,\"uptimeSeconds\":3600,\"clockStatus\":\"synced\",\"lastNtpSyncAt\":\"2026-08-27T11:59:00Z\"}",
      encoded.c_str());
  HeartbeatResponse response;
  ApiFailure failure;
  TEST_ASSERT_TRUE(ApiCodec::decodeHeartbeat(
      "{\"serverTime\":\"2026-08-27T12:00:00Z\",\"pingChallenge\":\"challenge\"}", response, failure));
  TEST_ASSERT_EQUAL_STRING("challenge", response.pingChallenge.c_str());
}

void test_ping_ack_rejects_invalid_ip_and_challenge() {
  std::string output;
  TEST_ASSERT_FALSE(ApiCodec::encodePingAck({"", "192.168.1.2", -60, 9}, output));
  TEST_ASSERT_FALSE(ApiCodec::encodePingAck({"challenge", "not-an-ip", -60, 9}, output));
  TEST_ASSERT_TRUE(ApiCodec::encodePingAck({"challenge", "192.168.1.2", -60, 9}, output));
}
```

- [ ] **Step 2: Ejecutar el codec test y verificar que falla**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native -f test_api_codec
```

Expected: compilation FAIL because the telemetry models and codec methods are missing.

- [ ] **Step 3: Definir modelos y una interfaz separada del fichaje**

Add these public contracts without adding pure virtual methods to `ApiClient`, so existing fakes do not change:

```cpp
struct HeartbeatRequest {
  uint8_t protocolVersion = 1;
  std::string clientVersion;
  uint32_t cacheRevision = 0;
  uint32_t pendingCount = 0;
  int16_t wifiRssiDbm = -127;
  uint64_t uptimeSeconds = 0;
  std::string clockStatus;
  std::string lastNtpSyncAt;
};

struct HeartbeatResponse { std::string serverTime; std::string pingChallenge; };
struct PingAckRequest { std::string pingChallenge; std::string localIp; int16_t wifiRssiDbm = -127; uint64_t uptimeSeconds = 0; };

class TelemetryClient {
 public:
  virtual ~TelemetryClient() = default;
  virtual ApiCallResult heartbeat(const ApiCredentials&, const HeartbeatRequest&, HeartbeatResponse&, uint32_t timeoutMs) = 0;
  virtual ApiCallResult pingAck(const ApiCredentials&, const PingAckRequest&, uint32_t timeoutMs) = 0;
};
```

Make `Esp32ApiClient final : public ApiClient, public TelemetryClient` and declare both overrides. Bound each telemetry response to 2048 bytes and validate challenge length `1..128`, IP syntax, RSSI, uptime, clock state and string lengths before serialization.

- [ ] **Step 4: Implementar los dos métodos HTTP exactos**

In `Esp32ApiClient`, call the existing request helper:

```cpp
auto call = request(profile_, credentials, "POST", "/heartbeat", payload, {},
                    timeoutMs, ApiCodec::kMaxTelemetryResponseBytes, response);
return decodeSuccess(call, response, output, ApiCodec::decodeHeartbeat);
```

`pingAck` uses `POST /ping-ack`, an empty success body decoder is unnecessary, and it returns the `ApiCallResult` from `request`. Neither method prints payloads or IP.

- [ ] **Step 5: Escribir primero las pruebas del worker de una ranura**

Create `test_telemetry_worker/test_main.cpp` with a fake `TelemetryClient` and these cases:

```cpp
void test_worker_acks_challenge_in_same_cycle() {
  FakeTelemetryClient api;
  api.heartbeatResponse.pingChallenge = "challenge-1";
  TelemetryWorker worker{api};
  TelemetryJob job;
  job.credentials = {"https://jornada.example.com", "ojterm_test_token"};
  job.heartbeat = validHeartbeat();
  job.localIp = "192.168.1.44";
  TEST_ASSERT_TRUE(worker.enqueue(std::move(job)));
  TEST_ASSERT_FALSE(worker.enqueue(TelemetryJob{}));
  TEST_ASSERT_TRUE(worker.processOne());
  TelemetryResult result;
  TEST_ASSERT_TRUE(worker.poll(result));
  TEST_ASSERT_TRUE(result.heartbeat.ok);
  TEST_ASSERT_TRUE(result.ackAttempted);
  TEST_ASSERT_TRUE(result.ack.ok);
  TEST_ASSERT_EQUAL_STRING("challenge-1", api.lastAck.pingChallenge.c_str());
}
```

Add cases for heartbeat without challenge, heartbeat failure without ack, ack failure without retry, `busy()` lifecycle and malformed job rejection.

- [ ] **Step 6: Implementar `TelemetryWorker` como transporte sin estado de UI**

The public types are:

```cpp
struct TelemetryJob { ApiCredentials credentials; HeartbeatRequest heartbeat; std::string localIp; };
struct TelemetryResult { ApiCallResult heartbeat; bool ackAttempted = false; ApiCallResult ack; };

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
  void execute(const TelemetryJob&, TelemetryResult&);
#ifdef ARDUINO
  QueueHandle_t pendingQueue_ = nullptr;
  QueueHandle_t resultQueue_ = nullptr;
  TaskHandle_t task_ = nullptr;
#else
  std::optional<TelemetryJob> pending_;
  std::optional<TelemetryResult> result_;
#endif
  std::atomic<bool> busy_{false};
  TelemetryClient& client_;
};
```

Use `5000U` for each HTTP timeout. `execute` calls heartbeat once and, only when successful with a non-empty challenge, constructs `PingAckRequest` from that challenge plus the job's local IP/RSSI/uptime and calls ack once. It never retries or writes durable storage.

- [ ] **Step 7: Ejecutar pruebas de contrato y worker**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native -f test_api_codec -f test_telemetry_worker
```

Expected: PASS and no changes required in existing `FakeApiClient` classes.

- [ ] **Step 8: Commit**

```bash
git add firmware/terminal/include/openjornada/api_models.hpp firmware/terminal/include/openjornada/api_client.hpp firmware/terminal/include/openjornada/telemetry_worker.hpp firmware/terminal/src/network/api_codec.cpp firmware/terminal/src/network/esp32_api_client.cpp firmware/terminal/src/network/telemetry_worker.cpp firmware/terminal/test/test_api_codec/test_main.cpp firmware/terminal/test/test_telemetry_worker/test_main.cpp
git commit -m "feat(firmware): add isolated telemetry transport"
```

---

### Task 4: Planificación del heartbeat sin bloquear fichajes

**Files:**
- Create: `firmware/terminal/include/openjornada/telemetry_scheduler.hpp`
- Create: `firmware/terminal/src/domain/telemetry_scheduler.cpp`
- Modify: `firmware/terminal/include/openjornada/network_worker.hpp`
- Modify: `firmware/terminal/src/network/network_worker.cpp`
- Modify: `firmware/terminal/include/openjornada/app_controller.hpp`
- Modify: `firmware/terminal/src/app/app_controller.cpp`
- Modify: `firmware/terminal/src/main.cpp`
- Create: `firmware/terminal/test/test_telemetry_scheduler/test_main.cpp`
- Modify: `firmware/terminal/test/test_worker_policy/test_main.cpp`
- Modify: `firmware/terminal/test/test_app_online/test_main.cpp`

**Interfaces:**
- Consumes: telemetry worker from Task 3 and current `AppController` runtime state.
- Produces: `TelemetryScheduler::due/markEnqueued`, `NetworkWorker::busy() const`, `AppController::heartbeatRequest(wifiRssiDbm, uptimeSeconds) const`; 15-second, non-accumulating heartbeat lifecycle in `main.cpp`.

- [ ] **Step 1: Escribir pruebas fallidas de planificación y prioridad**

Create `test_telemetry_scheduler/test_main.cpp`:

```cpp
void test_scheduler_never_accumulates_or_starts_while_primary_is_busy() {
  TelemetryScheduler scheduler{15000};
  TEST_ASSERT_FALSE(scheduler.due(0, false, false, false));
  TEST_ASSERT_FALSE(scheduler.due(0, true, true, false));
  TEST_ASSERT_TRUE(scheduler.due(0, true, false, false));
  scheduler.markEnqueued(0);
  TEST_ASSERT_FALSE(scheduler.due(14999, true, false, false));
  TEST_ASSERT_FALSE(scheduler.due(15000, true, false, true));
  TEST_ASSERT_TRUE(scheduler.due(15000, true, false, false));
}
```

Add a `uint32_t` wraparound case. Extend `test_worker_policy` so `busy()` is false initially, true after enqueue, and false only after polling the completed result. Extend `test_app_online` to assert that `heartbeatRequest` reports protocol/client/cache/pending and `synced`, `stale`, `unsynced` correctly without modifying `screen()` or feedback.

- [ ] **Step 2: Ejecutar las pruebas y comprobar el fallo**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native -f test_telemetry_scheduler -f test_worker_policy -f test_app_online
```

Expected: compilation FAIL for the missing scheduler, busy state and snapshot method.

- [ ] **Step 3: Implementar scheduler y ocupación observable**

Use this exact scheduler contract:

```cpp
class TelemetryScheduler {
 public:
  explicit TelemetryScheduler(uint32_t intervalMs = 15000U) : intervalMs_(intervalMs) {}
  bool due(uint32_t nowMs, bool connected, bool primaryBusy, bool telemetryBusy) const;
  void markEnqueued(uint32_t nowMs);
 private:
  uint32_t intervalMs_;
  uint32_t nextAtMs_ = 0;
  bool scheduledOnce_ = false;
};
```

`due` is true immediately on the first connected/idle opportunity and later uses signed subtraction for wrap-safe deadlines. It never mutates state. `markEnqueued` advances one interval from the actual enqueue time, so missed cycles do not accumulate.

Add an atomic outstanding count to `NetworkWorker`; increment only after a successful enqueue and decrement only when its result is polled. `busy()` returns whether outstanding is nonzero in both Arduino and native builds.

- [ ] **Step 4: Exponer un snapshot sin datos sensibles desde el controlador**

Implement:

```cpp
HeartbeatRequest AppController::heartbeatRequest(int16_t wifiRssiDbm,
                                                 uint64_t uptimeSeconds) const {
  HeartbeatRequest value;
  value.protocolVersion = kTerminalProtocolVersion;
  value.clientVersion = config_.clientVersion;
  value.cacheRevision = cache_.revision;
  value.pendingCount = static_cast<uint32_t>(screen_.pendingCount);
  value.wifiRssiDbm = wifiRssiDbm;
  value.uptimeSeconds = uptimeSeconds;
  value.clockStatus = clockTrust_.synchronizedThisBoot()
      ? "synced" : (clockTrust_.lastNtpEpochSeconds() > 0 ? "stale" : "unsynced");
  value.lastNtpSyncAt = value.clockStatus == "unsynced"
      ? "" : isoUtc(clockTrust_.lastNtpEpochSeconds());
  return value;
}
```

This method is const, does not touch `activeJobId_`, screen, outbox or feedback.

- [ ] **Step 5: Integrar el worker secundario en `main.cpp`**

Create a second `Esp32ApiClient`, then `TelemetryWorker` and `TelemetryScheduler` globals after the primary worker. A separate client instance avoids assuming that the Arduino HTTP adapter is safe for concurrent calls. Start the telemetry worker after the primary worker succeeds; if startup fails, reset only the telemetry client/worker pointers. In each loop, when those pointers are non-null, drain telemetry results without displaying them and enqueue only when connected and both workers satisfy the scheduler:

```cpp
TelemetryResult ignoredTelemetry;
while (telemetryWorker->poll(ignoredTelemetry)) ignoredTelemetry = {};

const uint32_t nowMs = millis();
if (telemetryScheduler.due(nowMs, WiFi.status() == WL_CONNECTED,
                           networkWorker->busy(), telemetryWorker->busy())) {
  TelemetryJob job;
  job.credentials = {deviceConfig->baseUrl, deviceConfig->terminalToken};
  job.heartbeat = app->heartbeatRequest(
      static_cast<int16_t>(WiFi.RSSI()),
      static_cast<uint64_t>(esp_timer_get_time()) / 1000000ULL);
  job.localIp = WiFi.localIP().toString().c_str();
  if (telemetryWorker->enqueue(std::move(job))) telemetryScheduler.markEnqueued(nowMs);
}
```

Do not call `renderer`, `hardware.tone*`, `showMessage`, `Outbox` or `ConfigStore` from this path. If starting the telemetry worker fails, continue normal terminal operation without telemetry instead of entering a blocked state.

- [ ] **Step 6: Ejecutar toda la matriz de firmware**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
```

Expected: all native suites PASS and both ESP32 profiles build. Existing action, offline, admin and time-picker tests remain green.

- [ ] **Step 7: Commit**

```bash
git add firmware/terminal
git commit -m "feat(firmware): schedule silent heartbeats"
```

---

### Task 5: Tarjetas Angular, refresco y resultado efímero

**Files:**
- Modify: `web/src/app/core/terminal.models.ts`
- Modify: `web/src/app/core/terminal.models.spec.ts`
- Modify: `web/src/app/core/terminal.service.ts`
- Modify: `web/src/app/core/terminal.service.spec.ts`
- Create: `web/src/app/features/integrations/terminal-diagnostics.ts`
- Create: `web/src/app/features/integrations/terminal-diagnostics.spec.ts`
- Create: `web/src/app/features/integrations/terminal-diagnostics-card.component.ts`
- Create: `web/src/app/features/integrations/terminal-diagnostics-card.component.html`
- Create: `web/src/app/features/integrations/terminal-diagnostics-card.component.spec.ts`
- Modify: `web/src/app/features/integrations/integrations.component.ts`
- Modify: `web/src/app/features/integrations/integrations.component.html`
- Modify: `web/src/app/features/integrations/terminal-provisioning-card.component.spec.ts`

**Interfaces:**
- Consumes: terminal list and role handling in `IntegrationsComponent`.
- Produces: `TerminalConnectionStatus`, expanded `TerminalRecord`, `TerminalPingResult`, `TerminalService.pingTerminal(id)`, pure formatting helpers and the attribute component `<li app-terminal-diagnostics-card>`.

- [ ] **Step 1: Escribir pruebas fallidas de tipos, servicio y formatos**

Add to `terminal.service.spec.ts`:

```ts
it('uses the scoped administrative ping route', async () => {
  await service.pingTerminal('terminal-1');
  expect(send).toHaveBeenLastCalledWith(
    '/api/openjornada/terminals/terminal-1/ping',
    { method: 'POST', requestKey: null },
  );
});
```

Create `terminal-diagnostics.spec.ts`:

```ts
describe('terminal diagnostics formatting', () => {
  it.each([[-67, 'Buena'], [-68, 'Aceptable'], [-79, 'Aceptable'], [-80, 'Débil']])(
    'maps %i dBm to %s', (rssi, label) => expect(wifiQuality(rssi)).toBe(label),
  );
  it('formats uptime without treating missing data as zero', () => {
    expect(formatTerminalUptime(null)).toBe('Sin datos');
    expect(formatTerminalUptime(90061)).toBe('1 d 1 h 1 min');
  });
  it('uses Spanish relative time and exposes an exact title', () => {
    const result = terminalDatePresentation('2026-08-27T11:59:30Z', Date.parse('2026-08-27T12:00:00Z'));
    expect(result.relative).toBe('hace 30 segundos');
    expect(result.exact).toContain('27 ago 2026');
  });
});
```

- [ ] **Step 2: Ejecutar las pruebas focalizadas y confirmar el fallo**

```bash
cd web
pnpm exec ng test --watch=false --include='src/app/core/terminal.service.spec.ts' --include='src/app/features/integrations/terminal-diagnostics.spec.ts'
```

Expected: FAIL because `pingTerminal` and diagnostics helpers do not exist.

- [ ] **Step 3: Ampliar contratos TypeScript y servicio**

Define the exact interfaces:

```ts
export type TerminalConnectionStatus = 'online' | 'offline' | 'revoked';

export interface TerminalRecord extends RecordModel {
  connectionStatus: TerminalConnectionStatus;
  lastHeartbeatAt: string;
  lastAttendanceSyncAt: string;
  lastClockStatus: '' | 'synced' | 'stale' | 'unsynced';
  lastNtpSyncAt: string;
  lastWifiRssiDbm: number | null;
  lastUptimeSeconds: number | null;
}

export interface TerminalPingResult {
  terminalId: string;
  localIp: string;
  publicIp: string;
  wifiRssiDbm: number;
  uptimeSeconds: number;
  waitForHeartbeatMs: number;
  responseMs: number;
  totalLatencyMs: number;
  checkedAt: string;
}
```

`pingTerminal` calls `pb.send` with `requestKey: null` so PocketBase does not auto-cancel one terminal's wait when another terminal is checked.

- [ ] **Step 4: Implementar helpers de presentación puros**

`terminal-diagnostics.ts` exports:

```ts
export function wifiQuality(rssi: number | null): 'Buena' | 'Aceptable' | 'Débil' | 'Sin datos';
export function formatTerminalUptime(seconds: number | null): string;
export function formatLatency(milliseconds: number): string;
export function terminalDatePresentation(value: string, now = Date.now()): { relative: string; exact: string };
export function clockStatusLabel(value: TerminalRecord['lastClockStatus']): string;
```

Clamp negative latency to zero, use `Intl.RelativeTimeFormat('es-ES', { numeric: 'always' })`, and select seconds/minutes/hours/days by the largest useful unit. Invalid or empty dates return `{ relative: 'Sin datos', exact: 'Sin datos' }`.

- [ ] **Step 5: Escribir pruebas fallidas del componente y caducidad sensible**

Create `terminal-diagnostics-card.component.spec.ts` using `vi.useFakeTimers()` and a fake `TerminalService`:

```ts
it('shows live telemetry and clears both IPs after ten minutes', async () => {
  pingTerminal.mockResolvedValue(pingResult());
  fixture.componentRef.setInput('terminal', terminalRecord({ connectionStatus: 'online' }));
  fixture.componentRef.setInput('canManage', true);
  fixture.detectChanges();
  clickButton('Comprobar conexión');
  await fixture.whenStable();
  fixture.detectChanges();
  expect(host.textContent).toContain('192.168.1.44');
  expect(host.textContent).toContain('203.0.113.9');
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  fixture.detectChanges();
  expect(host.textContent).not.toContain('192.168.1.44');
  expect(host.textContent).not.toContain('203.0.113.9');
});
```

Add cases for `Esperando respuesta…`, disabled concurrent click, `El terminal no respondió`, revoked button absence, `manager`-compatible `canPing`, destroy-before-response, and no screen/browser storage writes.

- [ ] **Step 6: Implementar la tarjeta standalone**

Use selector `li[app-terminal-diagnostics-card]`, required inputs and admin-only outputs:

```ts
export class TerminalDiagnosticsCardComponent implements OnDestroy {
  readonly terminal = input.required<TerminalRecord>();
  readonly canManage = input(false);
  readonly renameRequested = output<TerminalRecord>();
  readonly rotateRequested = output<TerminalRecord>();
  readonly revokeRequested = output<TerminalRecord>();
  protected readonly pingPending = signal(false);
  protected readonly pingResult = signal<TerminalPingResult | null>(null);
  protected readonly pingError = signal('');
  private pingGeneration = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
}
```

The component always shows diagnostic fields, lets every routed `admin` or `manager` ping, and only renders rename/rotate/revoke when `canManage` is true. `checkConnection` invalidates previous state, awaits `TerminalService.pingTerminal`, sets a timer for exactly `600_000` ms, and maps status/code `504`/`terminal_ping_timeout`, `409 terminal_revoked`, and `409 ping_in_progress` to Spanish. `ngOnDestroy` increments `pingGeneration`, clears the timer and nulls the result synchronously.

The component host itself is the `<li>` so pagination accessibility and existing direct-child selectors remain valid. Render status badges with both text and color, exact dates in `title`, Wi-Fi label plus dBm, and a temporary `<section aria-label="Resultado de la comprobación">` for IP and timings.

- [ ] **Step 7: Sustituir la fila inline y añadir refresco en segundo plano**

Import the new standalone component in `IntegrationsComponent`. Replace each inline `<li>` with:

```html
<li
  app-terminal-diagnostics-card
  [terminal]="terminal"
  [canManage]="auth.user()?.role === 'admin'"
  (renameRequested)="renameTerminal($event)"
  (rotateRequested)="rotateTerminal($event)"
  (revokeRequested)="revokeTerminal($event)"
></li>
```

Start one 30-second interval in the constructor after the initial load:

```ts
private readonly terminalRefreshTimer = window.setInterval(() => {
  if (!this.terminalBusy() && !this.terminalsLoading()) {
    void this.loadTerminals(this.terminalPage(), false, true);
  }
}, 30_000);
```

Add `background = false` to `loadTerminals`; background refreshes update records without setting the visible loading state or stealing paginator focus. `ngOnDestroy` clears this interval before invalidating credential operations. Child identity remains keyed by terminal ID, preserving an in-progress or visible ping result across list refreshes.

- [ ] **Step 8: Actualizar fixtures y ejecutar pruebas Angular**

Every `terminalRecord()` fixture must include the new fields with explicit empty/null values. Add parent tests using fake timers to prove one refresh at 30 seconds, no overlapping refresh, current page preservation and no refresh after `ngOnDestroy`.

Run:

```bash
cd web
pnpm run test:ci
pnpm run build
```

Expected: PASS; no template diagnostics and existing pagination/credential tests remain green.

- [ ] **Step 9: Commit**

```bash
git add web/src/app/core/terminal.models.ts web/src/app/core/terminal.models.spec.ts web/src/app/core/terminal.service.ts web/src/app/core/terminal.service.spec.ts web/src/app/features/integrations
git commit -m "feat(web): show terminal diagnostics and ping"
```

---

### Task 6: Recorridos E2E, privacidad y documentación

**Files:**
- Create: `web/e2e/terminal-telemetry.spec.ts`
- Modify: `web/e2e/terminal-pagination.spec.ts`
- Modify: `docs/FEATURES.md`
- Modify: `firmware/terminal/README.md`
- Modify: `web/README.md`

**Interfaces:**
- Consumes: the three API routes, firmware contract and Angular card completed in Tasks 1–5.
- Produces: executable proof of admin/manager isolation, end-to-end challenge flow, UI states, no persisted IP, and user-facing documentation.

- [ ] **Step 1: Escribir el E2E API del reto completo antes de darlo por cerrado**

Create `terminal-telemetry.spec.ts`. Reuse the retrying API login pattern from `rfid-terminal.spec.ts`, create a uniquely named terminal as admin, and run the concurrent flow:

```ts
const pingPromise = request.post(
  `${apiBase}/openjornada/terminals/${terminal.id}/ping`,
  { headers: { Authorization: manager.token }, timeout: 25_000 },
);
let pingChallenge = '';
await expect.poll(async () => {
  const heartbeat = await request.post(`${apiBase}/openjornada/terminal/v1/heartbeat`, {
    headers: { Authorization: `Bearer ${terminal.token}` },
    data: {
      protocolVersion: 1,
      clientVersion: 'e2e-telemetry-1.0.0',
      cacheRevision: 3,
      pendingCount: 0,
      wifiRssiDbm: -62,
      uptimeSeconds: 7200,
      clockStatus: 'synced',
      lastNtpSyncAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  expect(heartbeat.ok(), await heartbeat.text()).toBeTruthy();
  pingChallenge = ((await heartbeat.json()) as { pingChallenge: string }).pingChallenge;
  return pingChallenge;
}, { timeout: 5_000 }).not.toBe('');
expect(pingChallenge).not.toBe('');
const ack = await request.post(`${apiBase}/openjornada/terminal/v1/ping-ack`, {
  headers: { Authorization: `Bearer ${terminal.token}` },
  data: { pingChallenge, localIp: '192.168.1.44', wifiRssiDbm: -62, uptimeSeconds: 7200 },
});
expect(ack.ok(), await ack.text()).toBeTruthy();
const ping = await pingPromise;
expect(await ping.json()).toMatchObject({ terminalId: terminal.id, localIp: '192.168.1.44', wifiRssiDbm: -62 });
```

The polling heartbeat in the preceding snippet proves that the manager request has registered without using a fixed sleep. The same E2E must assert manager access, employee `403`, unknown opaque ID `404`, revoked heartbeat `401`, timeout `504`, and list JSON containing telemetry but no `localIp`/`publicIp` keys. Tenant isolation for a real foreign terminal is covered by the Go test in Task 2. Revoke created terminals and deactivate created users in `finally`.

- [ ] **Step 2: Añadir el recorrido visual con red interceptada**

In the same file, sign in through the browser, mock the terminal list with all telemetry fields, and mock ping success. Assert:

```ts
await expect(card.getByText('En línea', { exact: true })).toBeVisible();
await expect(card.getByText('Buena · −62 dBm')).toBeVisible();
await card.getByRole('button', { name: 'Comprobar conexión' }).click();
await expect(card.getByRole('region', { name: 'Resultado de la comprobación' })).toContainText('192.168.1.44');
await expect(card.getByRole('region', { name: 'Resultado de la comprobación' })).toContainText('203.0.113.9');
```

Add separate mocked cards for offline and revoked; revoked must lack the ping button. Update `terminal-pagination.spec.ts` fixtures with the expanded record contract and retain its current order, focus and mobile-boundary assertions.

- [ ] **Step 3: Ejecutar E2E focalizados contra el servidor real**

```bash
cd web
pnpm exec playwright test e2e/terminal-telemetry.spec.ts e2e/terminal-pagination.spec.ts --project=desktop-chromium
```

Expected: PASS with actual PocketBase migration applied by the E2E server; teardown succeeds even when an assertion fails.

- [ ] **Step 4: Actualizar documentación funcional y técnica**

Document exact behavior:

```md
- El terminal envía un heartbeat silencioso cada 15 s desde un worker separado.
- La tarjeta pasa a «Sin conexión» tras 45 s sin heartbeat.
- «Comprobar conexión» espera hasta 20 s y no muestra nada en el M5Stack.
- Las IP del resultado no se guardan y desaparecen de la web a los 10 min.
```

In `firmware/terminal/README.md`, include the two routes, telemetry fields, worker isolation and the fact that no heartbeat/ack enters LittleFS. In `web/README.md`, explain status, refresh every 30 seconds, admin/manager permissions and ephemeral IP. In `docs/FEATURES.md`, mark telemetry and silent ping as implemented without claiming monitoring history or alerts.

- [ ] **Step 5: Ejecutar verificaciones de privacidad y diff**

```bash
rg -n 'localIp|publicIp' backend/pb_migrations internal/terminal web/src/app firmware/terminal/src firmware/terminal/include
rg -n 'localStorage|sessionStorage|indexedDB' web/src/app/features/integrations/terminal-diagnostics-card.component.*
git diff --check
git diff -- docs/FEATURES.md firmware/terminal/README.md web/README.md
```

Expected: IP names occur only in transport models and transient rendering; no migration field, record `Set`, logger call or browser storage call stores them.

- [ ] **Step 6: Commit**

```bash
git add web/e2e/terminal-telemetry.spec.ts web/e2e/terminal-pagination.spec.ts docs/FEATURES.md firmware/terminal/README.md web/README.md
git commit -m "test(terminal): cover telemetry and silent ping"
```

---

### Task 7: Verificación integral, revisión y entrega

**Files:**
- Verify only: whole repository
- Modify only when a failing check exposes a defect in one of the files listed in Tasks 1–6.

**Interfaces:**
- Consumes: all committed tasks and repository quality commands.
- Produces: reviewed, reproducible branch ready to push; no uncommitted generated artifacts.

- [ ] **Step 1: Aplicar el stack real y ejecutar toda la batería**

Run from repository root:

```bash
go test ./... -count=1
cd web && pnpm run test:ci && pnpm run build && pnpm run e2e && cd ..
cd firmware/terminal && uv tool run --from platformio platformio test -e native && uv tool run --from platformio platformio run -e m5stack_dev && uv tool run --from platformio platformio run -e m5stack_release && cd ../..
docker compose -f docker-compose.production.yml config --quiet
docker build -t openjornada .
```

Expected: every command exits 0. Do not flash hardware automatically; firmware upload remains an explicit USB action after review.

- [ ] **Step 2: Probar manualmente el recorrido local de mayor riesgo**

With the local stack on `127.0.0.1:8090`, open Integraciones as admin, confirm automatic status refresh, click ping while the USB terminal is connected, verify both IP values, scan a tag while a later heartbeat is in flight, and verify the attendance action remains responsive and synchronized. Revoke only a disposable test terminal and confirm its ping button disappears.

- [ ] **Step 3: Solicitar revisión de código**

Invoke the repository `requesting-code-review` skill. The reviewer must compare the implementation against `docs/superpowers/specs/2026-08-27-terminal-telemetry-ping-design.md`, inspect organization isolation, broker cleanup, IP non-persistence, firmware concurrency and Angular timer teardown. Resolve every confirmed blocking or important finding and rerun the narrow test before the full gate.

- [ ] **Step 4: Revisar el diff final y el estado Git**

```bash
git diff --check
git status --short
git log --oneline --decorate -8
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Expected: only scoped source, tests, migration and docs appear; `.env`, `pb_data`, `.pio`, `dist`, reports and credentials are absent.

- [ ] **Step 5: Crear un commit correctivo solo si la revisión produjo cambios**

```bash
git add -u internal/terminal firmware/terminal web/src/app web/e2e docs
git commit -m "fix(terminal): address telemetry review findings"
```

Skip this step when the worktree is clean; never create an empty commit.

- [ ] **Step 6: Push y Actions**

```bash
git push origin main
oj_run_id="$(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$oj_run_id" --exit-status
```

Confirm that `oj_run_id` belongs to the pushed HEAD with `gh run view "$oj_run_id" --json headSha,url,status,conclusion`. Delivery is complete only when GitHub Actions succeeds; if it fails, inspect `gh run view "$oj_run_id" --log-failed`, fix the scoped cause, rerun local checks, commit and push again.
