# M5Stack RFID Firmware v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and flash a reliable OpenJornada RFID attendance terminal for M5Stack Basic Core v2.7 and Unit RFID2, with mobile provisioning, online/offline clocking and local tag administration.

**Architecture:** A PlatformIO Arduino project isolates portable domain and persistence logic from M5Stack hardware adapters. The UI/RFID loop remains responsive while a FreeRTOS worker performs API operations; every selected action enters a durable LittleFS outbox before transmission, so retries are idempotent after network or power failure.

**Tech Stack:** PlatformIO `espressif32@6.7.0`, Arduino framework, C++17, M5Unified 0.2.8, M5GFX 0.2.11, MFRC522_I2C pinned at commit `8152dddc93cf743397ac225e34bf268698326664`, ArduinoJson 7.4.2, LittleFS, Preferences/NVS, mbedTLS, Unity, PocketBase/Go tests.

**Spec:** `docs/superpowers/specs/2026-08-21-m5stack-firmware-design.md`

## Global Constraints

- Target hardware is M5Stack Basic Core v2.7 plus Unit RFID2 on Grove A, I²C address `0x28`, SDA GPIO 21 and SCL GPIO 22.
- The physical screen is 320×240 and has no touch input; all device interaction uses A/B/C.
- PocketBase remains authoritative for organization, employee, state, effective time and immutable `work_events`.
- Protocol version is exactly `1`; the device never accesses PocketBase collections directly.
- UID values, API keys and Wi-Fi passwords must never appear in logs or post-provisioning screens.
- Configuration and local cache remain unencrypted for this explicitly designated development board.
- No OTA, Secure Boot, flash encryption, eFuse writes or microSD support belongs in v1.
- New offline actions require NTP after each reboot and stop after 24 hours without another trusted sync.
- The cache limit is 30 tags, queue limit is 10.000 actions and sync batch limit is 500.
- `m5stack_release` accepts HTTPS only; private HTTP requires both the `m5stack_dev` build and explicit backend development configuration.
- Every action is persisted before network transmission and uses the same `clientRequestId` for every retry.
- Preserve unrelated worktree changes and keep commits focused per task.

---

### Task 1: Scaffold PlatformIO and the portable domain

**Files:**
- Create: `firmware/terminal/platformio.ini`
- Create: `firmware/terminal/partitions.csv`
- Create: `firmware/terminal/.gitignore`
- Create: `firmware/terminal/include/openjornada/domain.hpp`
- Create: `firmware/terminal/src/domain/domain.cpp`
- Create: `firmware/terminal/src/main.cpp`
- Create: `firmware/terminal/test/test_domain/test_main.cpp`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `WorkKind`, `Command`, `WorkState`, `Button`, `ButtonLabels`, `visibleButtons(const WorkState&)`, `nextKind(WorkKind, Command)`, `adjustedMinutes(int, Button, bool)` and `offlineClockTrusted(int64_t, int64_t, bool)`.
- Produces: PlatformIO environments `native`, `m5stack_dev` and `m5stack_release`.

- [ ] **Step 1: Add the failing domain tests**

```cpp
#include <unity.h>
#include "openjornada/domain.hpp"

using namespace openjornada;

void test_long_shift_buttons() {
  WorkState state{WorkKind::Working, 14'400, 0, true, false};
  const auto labels = visibleButtons(state);
  TEST_ASSERT_EQUAL_STRING("Pausa", labels.a);
  TEST_ASSERT_EQUAL_STRING("Terminar", labels.b);
  TEST_ASSERT_EQUAL_STRING("Antes", labels.c);
}

void test_clock_trust() {
  TEST_ASSERT_TRUE(offlineClockTrusted(1'000, 87'400, false));
  TEST_ASSERT_FALSE(offlineClockTrusted(1'000, 87'401, false));
  TEST_ASSERT_FALSE(offlineClockTrusted(1'000, 1'100, true));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_long_shift_buttons);
  RUN_TEST(test_clock_trust);
  return UNITY_END();
}
```

- [ ] **Step 2: Add the three PlatformIO environments and verify the tests fail**

Use this dependency block for both ESP32 environments:

```ini
platform = espressif32@6.7.0
board = m5stack-core-esp32
framework = arduino
board_build.partitions = partitions.csv
board_build.filesystem = littlefs
monitor_speed = 115200
build_flags = -std=gnu++17
lib_deps =
  m5stack/M5Unified@0.2.8
  m5stack/M5GFX@0.2.11
  bblanchon/ArduinoJson@7.4.2
  https://github.com/kkloesener/MFRC522_I2C.git#8152dddc93cf743397ac225e34bf268698326664
```

Run: `cd firmware/terminal && uv tool run --from platformio platformio test -e native`

Expected: FAIL because `openjornada/domain.hpp` and its functions do not exist.

- [ ] **Step 3: Implement the pure domain contract**

```cpp
namespace openjornada {
enum class WorkKind { Idle, Working, OnBreak };
enum class Command { ClockIn, BreakStart, BreakEnd, ClockOut };
enum class Button { A, B, C };

struct WorkState {
  WorkKind kind;
  int32_t workedSeconds;
  int32_t breakSeconds;
  bool longShift;
  bool staleBreak;
};

struct ButtonLabels { const char* a; const char* b; const char* c; };
ButtonLabels visibleButtons(const WorkState& state);
WorkKind nextKind(WorkKind current, Command command);
int adjustedMinutes(int current, Button button, bool held);
bool offlineClockTrusted(int64_t syncedAt, int64_t now, bool rebooted);
}
```

Match the simulator exactly: ±5 minutes, ±30 while held, four-hour long-shift threshold and 25-minute stale-break threshold.

- [ ] **Step 4: Add the no-OTA 16 MiB partition table and minimal firmware entry point**

```csv
# Name, Type, SubType, Offset, Size, Flags
nvs,data,nvs,0x9000,0x6000,
phy_init,data,phy,0xf000,0x1000,
factory,app,factory,0x10000,0x400000,
littlefs,data,spiffs,0x410000,0xbf0000,
```

`src/main.cpp` initializes M5Unified and displays `OpenJornada · diagnóstico` without initializing SD.

- [ ] **Step 5: Run native tests and both ESP32 builds**

Run:

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
```

Expected: all three commands exit 0.

- [ ] **Step 6: Add firmware commands to CI and commit**

Add native tests and both builds after Go and Angular unit tests. Cache `~/.platformio` by the hash of `firmware/terminal/platformio.ini`.

```bash
git add firmware/terminal .github/workflows/ci.yml
git commit -m "feat: scaffold M5Stack terminal firmware"
```

---

### Task 2: Prove display, buttons, speaker and RFID2 on the real board

**Files:**
- Create: `firmware/terminal/include/openjornada/hardware.hpp`
- Create: `firmware/terminal/src/hardware/m5_hardware.cpp`
- Create: `firmware/terminal/include/openjornada/uid_gate.hpp`
- Create: `firmware/terminal/src/domain/uid_gate.cpp`
- Create: `firmware/terminal/test/test_uid_gate/test_main.cpp`
- Modify: `firmware/terminal/src/main.cpp`
- Create: `firmware/terminal/scripts/hardware-smoke.sh`

**Interfaces:**
- Consumes: `Button` from Task 1.
- Produces: `Hardware::begin()`, `Hardware::update()`, `Hardware::pressed(Button)`, `Hardware::held(Button, uint32_t)`, `Hardware::pollUid()`, `Hardware::tagPresent()`, `Hardware::toneSuccess()` and `Hardware::toneError()`.
- Produces: `UidGate::accept(std::string_view uid, bool present, uint32_t nowMs)`.

- [ ] **Step 1: Test removal-based UID debouncing**

```cpp
void test_uid_requires_removal() {
  UidGate gate{300};
  TEST_ASSERT_TRUE(gate.accept("04A1B2C3", true, 0));
  TEST_ASSERT_FALSE(gate.accept("04A1B2C3", true, 500));
  TEST_ASSERT_FALSE(gate.accept("", false, 600));
  TEST_ASSERT_TRUE(gate.accept("04A1B2C3", true, 901));
}
```

Run: `uv tool run --from platformio platformio test -e native -f test_uid_gate`

Expected: FAIL because `UidGate` does not exist.

- [ ] **Step 2: Implement the hardware-independent gate and pass its test**

The gate clears the last UID only after the reader reports no card continuously for 300 ms. It never logs the UID.

Run: `uv tool run --from platformio platformio test -e native -f test_uid_gate`

Expected: PASS.

- [ ] **Step 3: Implement the M5Stack hardware adapter**

Initialize M5Unified without SD, call `Wire.begin(21, 22)`, construct
`MFRC522_I2C reader(0x28, -1)`, call `PCD_Init()`, and normalize UID bytes with
two uppercase hexadecimal characters per byte. Use `M5.BtnA/B/C` and
`M5.Speaker.tone()` behind the adapter.

```cpp
class Hardware {
 public:
  bool begin();
  void update();
  bool pressed(Button button) const;
  bool held(Button button, uint32_t milliseconds) const;
  std::optional<std::string> pollUid();
  bool tagPresent() const;
  void toneSuccess();
  void toneError();
};
```

- [ ] **Step 4: Build and flash the diagnostic firmware**

Run:

```bash
cd firmware/terminal
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_dev --target upload --upload-port /dev/ttyACM0
uv tool run --from platformio platformio device monitor --port /dev/ttyACM0 --baud 115200
```

Expected screen: display test, A/B/C state, speaker test and `RFID2: OK (0x28)`. Presenting a tag increments a counter and shows only UID length plus a masked suffix, never the full UID or token.

- [ ] **Step 5: Add a repeatable smoke script and commit**

The script verifies `/dev/ttyACM0`, builds, uploads and opens the monitor; it exits before upload with a clear message if the device is absent.

```bash
git add firmware/terminal
git commit -m "feat: add M5Stack RFID hardware diagnostics"
```

---

### Task 3: Persist configuration and cache safely

**Files:**
- Create: `firmware/terminal/include/openjornada/config.hpp`
- Create: `firmware/terminal/include/openjornada/url_policy.hpp`
- Create: `firmware/terminal/src/storage/config_store.cpp`
- Create: `firmware/terminal/src/domain/url_policy.cpp`
- Create: `firmware/terminal/include/openjornada/cache_store.hpp`
- Create: `firmware/terminal/src/storage/cache_store.cpp`
- Create: `firmware/terminal/test/test_url_policy/test_main.cpp`
- Create: `firmware/terminal/test/test_cache_codec/test_main.cpp`

**Interfaces:**
- Produces: `DeviceConfig { ssid, wifiPassword, baseUrl, terminalToken, soundEnabled }`.
- Produces: `UrlDecision validateBaseUrl(std::string_view, BuildProfile)`.
- Produces: `CacheEntry`, `CacheSnapshot`, `CacheCodec::encode/decode` and ESP32 `CacheStore::load/replaceAtomically`.

- [ ] **Step 1: Test development and release URL rules**

```cpp
TEST_ASSERT_TRUE(validateBaseUrl("https://jornada.example.com", BuildProfile::Release).allowed);
TEST_ASSERT_FALSE(validateBaseUrl("http://192.168.1.20:8090", BuildProfile::Release).allowed);
TEST_ASSERT_TRUE(validateBaseUrl("http://192.168.1.20:8090", BuildProfile::Development).allowed);
TEST_ASSERT_FALSE(validateBaseUrl("http://203.0.113.10", BuildProfile::Development).allowed);
TEST_ASSERT_FALSE(validateBaseUrl("http://127.0.0.1:8090", BuildProfile::Development).allowed);
```

Run: `uv tool run --from platformio platformio test -e native -f test_url_policy`

Expected: FAIL before `validateBaseUrl` exists.

- [ ] **Step 2: Implement strict URL parsing and config validation**

Accept only `https` in release. Development additionally accepts RFC1918 IPv4 hosts; reject credentials, fragments, path traversal, loopback and non-HTTP schemes. Require token prefix `ojterm_`, non-empty SSID and maximum lengths of 32/63/255/96 bytes for SSID/password/URL/token.

- [ ] **Step 3: Test cache snapshot corruption and revision handling**

Create a two-entry fixture, encode/decode it, flip one payload byte and assert `CacheError::Checksum`; assert more than 30 entries returns `CacheError::Capacity`.

Run: `uv tool run --from platformio platformio test -e native -f test_cache_codec`

Expected: FAIL before `CacheCodec` exists.

- [ ] **Step 4: Implement portable cache encoding plus ESP32 A/B slots**

```cpp
struct CacheEntry {
  std::string employeeId;
  std::string displayName;
  std::string uid;
  WorkState state;
};
struct CacheSnapshot { uint32_t revision; std::vector<CacheEntry> entries; };
```

Encode magic `OJCA`, format version `1`, revision, payload length, entries and CRC32. Write `/cache-a.bin` or `/cache-b.bin`, read it back, then update NVS key `cache_slot`; never overwrite the active slot first.

- [ ] **Step 5: Run tests/builds and commit**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
git add firmware/terminal
git commit -m "feat: persist terminal configuration and cache"
```

---

### Task 4: Build the durable outbox and server-compatible HMAC chain

**Files:**
- Create: `firmware/terminal/include/openjornada/outbox.hpp`
- Create: `firmware/terminal/src/storage/outbox_codec.cpp`
- Create: `firmware/terminal/src/storage/littlefs_outbox.cpp`
- Create: `firmware/terminal/include/openjornada/signature.hpp`
- Create: `firmware/terminal/src/domain/signature.cpp`
- Create: `firmware/terminal/test/test_outbox/test_main.cpp`
- Create: `firmware/terminal/test/test_signature/test_main.cpp`
- Modify: `internal/terminal/service_test.go`

**Interfaces:**
- Produces: `QueuedAction`, `OutboxCodec::encode/decode`, `Outbox::append/list/complete/compact`.
- Produces: `deriveSigningKey(token)`, `canonicalAction(terminalId, action)` and `signAction(key, canonical)`.

- [ ] **Step 1: Add one shared canonical signature vector to Go**

Use terminal `terminal-a`, token
`ojterm_abcdefghijkl_secret0123456789012345678901234567890123456789` and this
exact canonical payload:

```text
terminal-a|req-1|04A1B2C3|clock_in|2026-08-21T08:00:00.000Z||2026-08-21T07:59:59.000Z|1|boot-1|
```

Assert the lowercase HMAC-SHA256 result:

```text
f6d92375cab26283b16c1174a19c60cdaff19ac4c646f6e34f6748a90fc6b118
```

Run: `go test ./internal/terminal -run TestFirmwareSignatureVector -v`

Expected: PASS, establishing the server as the reference implementation.

- [ ] **Step 2: Add failing native signature and journal tests**

Test that C++ produces the Go hex exactly. Test append/reopen, truncated final record recovery, CRC corruption rejection, maximum 10.000 entries, completion and atomic compaction.

Run: `uv tool run --from platformio platformio test -e native -f test_signature -f test_outbox`

Expected: FAIL because the codecs do not exist.

- [ ] **Step 3: Implement portable canonicalization and HMAC**

```cpp
struct QueuedAction {
  std::string clientRequestId;
  std::string uid;
  Command command;
  std::string deviceCapturedAt;
  std::string appliedAt;
  std::string clockSyncedAt;
  uint32_t deviceSequence;
  std::string rebootId;
  std::string previousLocalHash;
  std::string signature;
};
```

Use mbedTLS SHA-256/HMAC on ESP32 and a host implementation with the same byte contract. Canonical field order must match `internal/terminal/events.go` exactly.

- [ ] **Step 4: Implement append-before-send storage**

Use records `OJAC + version + length + payload + CRC32`. `append()` calls `flush()` before returning success. `complete()` records final IDs in a side journal; `compact()` writes and verifies `/outbox.new`, renames the current file to `/outbox.old`, activates the new file and removes the old one only after reopen succeeds.

- [ ] **Step 5: Run Go/native/ESP32 verification and commit**

```bash
go test ./internal/terminal
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
git add internal/terminal/service_test.go firmware/terminal
git commit -m "feat: add durable signed terminal outbox"
```

---

### Task 5: Permit explicitly gated private HTTP development traffic

**Files:**
- Modify: `internal/terminal/service.go`
- Modify: `internal/terminal/service_test.go`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/COMPLIANCE_ES.md`

**Interfaces:**
- Consumes: firmware development URL policy from Task 3.
- Produces: backend variable `PB_TERMINAL_DEV_INSECURE_HTTP`, default `false`.
- Produces: `secureTerminalRequest(request, demoEnabled, allowPrivateHTTP)` or an equivalent dependency-injected policy with deterministic tests.

- [ ] **Step 1: Add failing private-network policy tests**

Cover these exact cases:

```text
TLS public host                                      -> allow
HTTP localhost                                      -> allow
HTTP 192.168 host + private peer + both flags true  -> allow
HTTP 192.168 host + either flag false               -> deny
HTTP public host + both flags true                   -> deny
HTTP private host + public peer                      -> deny
spoofed X-Forwarded-Proto from public peer           -> deny
```

Run: `go test ./internal/terminal -run TestSecureTerminalRequest -v`

Expected: FAIL for the approved private HTTP development case.

- [ ] **Step 2: Implement the triple-gated exception**

Require `PB_TERMINAL_DEV_INSECURE_HTTP=true`, `PB_DEMO_ENABLED=true`, a private request host and a private/loopback remote peer. Preserve current trusted-proxy HTTPS behavior. Do not read these environment variables inside the pure predicate; pass booleans from registration/authentication code.

- [ ] **Step 3: Document the variable and production prohibition**

Add `PB_TERMINAL_DEV_INSECURE_HTTP=false` to `.env.example`. Document that it must remain false in production and that the M5Stack uses the computer's LAN IP, never `127.0.0.1`.

- [ ] **Step 4: Verify backend and commit**

```bash
go test ./...
git diff --check
git add internal/terminal .env.example README.md docs/DEPLOYMENT.md docs/COMPLIANCE_ES.md
git commit -m "feat: gate private HTTP terminal development"
```

---

### Task 6: Implement captive provisioning and recovery entry

**Files:**
- Create: `firmware/terminal/include/openjornada/provisioning.hpp`
- Create: `firmware/terminal/src/provisioning/captive_portal.cpp`
- Create: `firmware/terminal/src/ui/provisioning_screen.cpp`
- Create: `firmware/terminal/include/openjornada/gesture.hpp`
- Create: `firmware/terminal/src/domain/gesture.cpp`
- Create: `firmware/terminal/test/test_gesture/test_main.cpp`
- Modify: `firmware/terminal/src/main.cpp`

**Interfaces:**
- Consumes: `DeviceConfig`, `validateBaseUrl`, `Hardware`.
- Produces: `BootGestureDetector::update(buttons, elapsedMs)` returning `None`, `Provisioning` or `FactoryReset`.
- Produces: `ProvisioningPortal::run(candidateValidator)` and `ProvisioningResult`.

- [ ] **Step 1: Test exact boot gestures**

Assert A+B for 4.999 seconds does nothing, A+B at 5 seconds opens provisioning, and A+B+C requires ten seconds plus a separate five-second C confirmation. Releasing any required button resets progress.

Run: `uv tool run --from platformio platformio test -e native -f test_gesture`

Expected: FAIL because `BootGestureDetector` does not exist.

- [ ] **Step 2: Implement gestures and recovery guards**

`FactoryReset` carries `pendingCount`; refuse the reset while nonzero until the second explicit confirmation screen. Provisioning never erases cache or outbox and refuses a token change while `pendingCount > 0`.

- [ ] **Step 3: Implement the WPA2 captive portal**

Use `WiFi.softAP`, `DNSServer` wildcard DNS and `WebServer`. Generate an eight-character password from `esp_random()`. Render SSID/password plus a Wi-Fi QR on the M5 display. The HTML form uses password inputs, maximum lengths from Task 3 and Spanish validation messages.

```cpp
struct ProvisioningResult {
  bool saved;
  DeviceConfig config;
  std::string displayError;
};
```

Candidate validation connects with a 20-second Wi-Fi timeout and calls bootstrap before `ConfigStore::save`. Stop AP/DNS after success or ten minutes idle.

- [ ] **Step 4: Flash and validate with a phone**

Build/upload `m5stack_dev`, hold A+B during boot, join the displayed network, open the portal, submit intentionally invalid then valid values, reboot and confirm the configuration persists. Verify the serial monitor contains neither form values nor UID/token text.

- [ ] **Step 5: Run tests/builds and commit**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
git add firmware/terminal
git commit -m "feat: provision M5Stack terminals over Wi-Fi"
```

---

### Task 7: Add the protocol-v1 client and non-blocking network worker

**Files:**
- Create: `firmware/terminal/include/openjornada/api_models.hpp`
- Create: `firmware/terminal/include/openjornada/api_client.hpp`
- Create: `firmware/terminal/src/network/api_codec.cpp`
- Create: `firmware/terminal/src/network/esp32_api_client.cpp`
- Create: `firmware/terminal/include/openjornada/network_worker.hpp`
- Create: `firmware/terminal/src/network/network_worker.cpp`
- Create: `firmware/terminal/test/test_api_codec/test_main.cpp`
- Create: `firmware/terminal/test/test_worker_policy/test_main.cpp`

**Interfaces:**
- Produces: typed `BootstrapResponse`, `ResolveResponse`, `ActionRequest`, `ActionResult`, `CacheResponse`, `AdminSessionResponse`, `EmployeeListResponse` and `SyncResponse`.
- Produces: `ApiClient` methods matching every `/terminal/v1` route.
- Produces: `NetworkJob`, `NetworkResult` and a single worker task with bounded queues.

- [ ] **Step 1: Add failing JSON contract fixtures**

Copy representative successful/error payloads from `web/src/app/core/terminal.models.spec.ts` and `web/e2e/rfid-terminal.spec.ts`. Assert protocol mismatch, missing fields, over-30 cache and unknown status are rejected without partial state mutation.

Run: `uv tool run --from platformio platformio test -e native -f test_api_codec`

Expected: FAIL because the protocol codec does not exist.

- [ ] **Step 2: Implement bounded API models and codecs**

Use fixed maximum JSON document capacities and explicit length checks. Map `authentication_required`, `terminal_revoked`, `state_conflict`, `clock_untrusted`, `pin_rate_limited` and `invalid_signature` to typed errors plus Spanish safe messages.

- [ ] **Step 3: Test worker serialization and timeout policy**

With a fake `ApiClient`, assert only one job runs at once, UI polling remains possible, bootstrap/action timeouts are 10 seconds, sync timeout is 30 seconds and retry backoff is 2/4/8/16/30 seconds.

- [ ] **Step 4: Implement ESP32 transport and worker**

Use `HTTPClient`, `WiFiClientSecure` in release and `WiFiClient` only after Task 3 policy approval in development. Set `Authorization: Bearer …`, optional `X-Terminal-Admin-Session`, `Content-Type: application/json` and no request logging. The worker communicates only through FreeRTOS queues; it never writes UI/domain state directly.

- [ ] **Step 5: Verify bootstrap against local API and commit**

Configure the local backend with both development flags, enter the computer's private IP in the portal, and confirm screen/serial show protocol `1`, server time and cache revision without secrets.

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
git add firmware/terminal
git commit -m "feat: connect firmware to terminal API v1"
```

---

### Task 8: Reproduce the simulator UI and online fichaje flow

**Files:**
- Create: `firmware/terminal/include/openjornada/screen.hpp`
- Create: `firmware/terminal/include/openjornada/app_controller.hpp`
- Create: `firmware/terminal/src/ui/screen_renderer.cpp`
- Create: `firmware/terminal/src/app/app_controller.cpp`
- Create: `firmware/terminal/test/test_app_online/test_main.cpp`
- Modify: `firmware/terminal/src/main.cpp`

**Interfaces:**
- Consumes: `Hardware`, `UidGate`, `ApiClient` worker, `Outbox`, domain functions.
- Produces: `ScreenState` variants and `AppController::tick(AppEvent)`.
- Produces: append-before-send online action behavior.

- [ ] **Step 1: Add failing online-flow tests with fake hardware/network**

Cover idle→clock-in, working→break, working→clock-out, four-hour three-button layout, stale pause, ten-second action timeout, ±5/30-minute selector and break-end-then-close confirmation. Assert each command appends to the outbox before the fake client observes it.

Run: `uv tool run --from platformio platformio test -e native -f test_app_online`

Expected: FAIL because `AppController` does not exist.

- [ ] **Step 2: Implement explicit screen states**

```cpp
enum class ScreenKind {
  Boot, Idle, Message, Actions, TimePicker, CloseConfirm,
  AdminPin, AdminEmployees, AdminScan, Provisioning, Fatal
};
```

Store deadlines in state instead of `delay()`. Render network, NTP and pending icons on every operational screen. Render current A/B/C labels along the bottom.

- [ ] **Step 3: Implement append-before-send online actions**

On selection, create one ID, sequence and HMAC record; append/flush; send `/actions`; complete the outbox on accepted/duplicate or definitive rejection. On transport ambiguity keep it queued and display `Guardado; se sincronizará`.

- [ ] **Step 4: Flash and execute the online physical flow**

Using one employee and assigned test tag, verify start, pause, end pause, four-hour simulated correction and finish. Remove/re-present the tag between actions. Compare labels and messages with `/terminal-simulator`.

- [ ] **Step 5: Run verification and commit**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
git add firmware/terminal
git commit -m "feat: clock in from the physical RFID terminal"
```

---

### Task 9: Complete offline operation, clock trust and synchronization

**Files:**
- Create: `firmware/terminal/include/openjornada/sync_engine.hpp`
- Create: `firmware/terminal/src/app/sync_engine.cpp`
- Create: `firmware/terminal/include/openjornada/clock_trust.hpp`
- Create: `firmware/terminal/src/domain/clock_trust.cpp`
- Create: `firmware/terminal/test/test_offline_flow/test_main.cpp`
- Create: `firmware/terminal/test/test_sync_engine/test_main.cpp`
- Modify: `firmware/terminal/src/app/app_controller.cpp`

**Interfaces:**
- Consumes: cache/outbox/API/domain from Tasks 1–8.
- Produces: `ClockTrust::onNtpSync/onBoot/canCreateOffline`.
- Produces: `SyncEngine::nextBatch/applyResults/backoffUntil`.

- [ ] **Step 1: Add failing clock and offline transition tests**

Assert reboot without NTP rejects a new offline action, exact 24 hours remains trusted, 24 hours plus one second rejects, and old queued records remain syncable in all cases. Assert local states advance only after durable append.

- [ ] **Step 2: Add failing sync result tests**

Feed 501 actions and assert batches 500+1 in capture order. Assert accepted/duplicate/incident complete records, rejected blocks later compaction, transport errors retain the entire batch and an already-accepted lost response returns duplicate safely.

- [ ] **Step 3: Implement clock trust and sync engine**

Persist last NTP evidence but mark the current boot untrusted until a fresh sync. Generate a random `rebootId`, reset sequence, maintain `previousLocalHash`, and rehydrate employee states by replaying pending actions over the active cache after reboot.

- [ ] **Step 4: Integrate cache refresh and automatic sync**

After bootstrap, request `/cache?revision=…`; replace only after full validation. Sync pending records before accepting a new online action for the same employee, preventing a later action from overtaking an ambiguous earlier action.

- [ ] **Step 5: Flash destructive-network tests and commit**

Start a journey, disable Wi-Fi, record pause/end-pause, power-cycle, verify no new offline action before NTP, restore Wi-Fi and verify exactly one event per confirmed action plus visible incidents where the server state conflicts.

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
git add firmware/terminal
git commit -m "feat: synchronize durable offline RFID actions"
```

---

### Task 10: Add PIN administration, tag assignment and safe reset

**Files:**
- Create: `firmware/terminal/include/openjornada/admin_flow.hpp`
- Create: `firmware/terminal/src/app/admin_flow.cpp`
- Create: `firmware/terminal/test/test_admin_flow/test_main.cpp`
- Modify: `firmware/terminal/src/app/app_controller.cpp`
- Modify: `firmware/terminal/src/ui/screen_renderer.cpp`
- Modify: `firmware/terminal/src/storage/config_store.cpp`

**Interfaces:**
- Consumes: admin API routes and screen states.
- Produces: `AdminFlow::holdCombo/updatePin/selectEmployee/assignTag/expire`.
- Produces: recovery and explicit destructive reset screens.

- [ ] **Step 1: Add failing admin and reset tests**

Cover A+C cancellation at 2.999 seconds, activation at 3 seconds, PIN wrap 0↔9, four B confirmations, five-minute inactivity, online-only employee listing/assignment, replacement confirmation and local token deletion on exit. Cover A+B recovery preserving files and A+B+C reset requiring 10+5 seconds.

- [ ] **Step 2: Implement session capability handling**

Keep the `ojtadmin_…` capability only in RAM. Clear it on timeout, exit, Wi-Fi loss or reboot. Call `DELETE /admin-sessions/current` opportunistically on explicit exit, but never persist the capability.

- [ ] **Step 3: Implement employee/tag screens**

Fetch at most 30 employees, navigate with A/C, select with B and scan one tag. If `hasRfidTag` is true, show a replacement confirmation before PUT with `replace: true`. Refresh the cache after success.

- [ ] **Step 4: Implement safe configuration/factory reset**

A+B opens provisioning without data deletion. A+B+C shows pending count and warnings. Normal confirmation refuses when pending; the second explicit five-second C hold erases NVS, both cache slots and outbox, then reboots into provisioning.

- [ ] **Step 5: Flash the complete admin flow and commit**

Use the configured four-digit organization PIN, assign an empty tag, replace it, verify normal fichaje, let the session expire and prove assignment then requires the PIN again.

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
git add firmware/terminal
git commit -m "feat: administer RFID tags from M5Stack"
```

---

### Task 11: Harden, document and deliver the USB firmware workflow

**Files:**
- Modify: `firmware/terminal/platformio.ini`
- Modify: `firmware/terminal/scripts/hardware-smoke.sh`
- Create: `firmware/terminal/README.md`
- Modify: `README.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/COMPLIANCE_ES.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `web/e2e/rfid-terminal.spec.ts`

**Interfaces:**
- Produces: documented build, flash, monitor, provisioning, recovery and production build commands.
- Produces: a release firmware artifact from `m5stack_release` without OTA or private HTTP.

- [ ] **Step 1: Add API contract E2E assertions needed by physical firmware**

Extend the RFID E2E to assert the firmware signature vector, cache limit/revision, ambiguous duplicate action, 500-action sync boundary, admin expiry and development HTTP gating. Keep UID/token values out of failure messages.

- [ ] **Step 2: Audit logs, buffers and failure states**

Search firmware for `Serial`, `printf`, token/UID fields and ensure every call uses redacted status. Verify all JSON sizes are bounded, task queues reject overflow visibly, watchdog remains serviced and fatal LittleFS/RFID errors produce recovery screens rather than reboot loops.

- [ ] **Step 3: Write operator and developer documentation**

Document these exact commands:

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev --target upload --upload-port /dev/ttyACM0
uv tool run --from platformio platformio device monitor --port /dev/ttyACM0 --baud 115200
uv tool run --from platformio platformio run -e m5stack_release
```

Include Grove wiring, portal steps, A+B recovery, A+C administration, A+B+C reset, local LAN URL, USB-only updates, no microSD and the warning that this development board stores configuration unencrypted.

- [ ] **Step 4: Run the complete verification matrix**

```bash
go test ./...
cd web
pnpm run test:ci
pnpm run build
pnpm exec playwright test e2e/rfid-terminal.spec.ts --project=desktop-chromium
pnpm audit --prod
cd ../firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
cd ../..
docker build -t openjornada .
git diff --check
```

Expected: all commands exit 0; hardware smoke then passes on `/dev/ttyACM0`.

- [ ] **Step 5: Review, flash final development build and commit**

Request code review of all firmware/backend changes, fix every Critical or Important finding, rerun the matrix, flash `m5stack_dev`, and execute the physical acceptance flow once more.

```bash
git add firmware/terminal internal/terminal .env.example README.md docs .github/workflows/ci.yml web/e2e/rfid-terminal.spec.ts
git commit -m "docs: deliver M5Stack terminal firmware"
git push origin main
```
