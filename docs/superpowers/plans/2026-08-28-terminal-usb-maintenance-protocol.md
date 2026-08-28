# Terminal USB Maintenance Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the bounded OJUSB/1 maintenance protocol to the M5Stack firmware, including OJP provisioning, status, reboot, physical factory reset and rollback-safe USB firmware installation.

**Architecture:** A portable domain layer parses control lines, OJP payloads, firmware metadata and binary frames without Arduino dependencies. An Arduino adapter services `Serial` non-blockingly, integrates provisioning into the existing captive-portal attempt state, and streams firmware into the inactive OTA slot through the existing validation and rollback machinery.

**Tech Stack:** C++17, Arduino ESP32, M5Unified, ArduinoJson 7.4.2, Monocypher, ESP-IDF OTA/Update, PlatformIO Unity.

**Spec:** `docs/superpowers/specs/2026-08-28-terminal-usb-cli-design.md`

## Global Constraints

- Protocol name and version are exactly `OJUSB/1`.
- Control lines are at most 4096 bytes including prefix and newline.
- Firmware frames carry at most 2048 payload bytes and use CRC-32 IEEE.
- Initial serial speed is 115200 baud; negotiated firmware transfer speed is 460800 with fallback to 115200.
- Never emit passwords, API keys, UIDs, IP addresses, OJP payloads or firmware bytes in logs or errors.
- Only official Ed25519-signed firmware may install without physical confirmation.
- Custom firmware and factory reset require holding only `C` for five seconds and expire after 30 seconds.
- Firmware installation is refused while any attendance action is pending.
- Existing captive-portal provisioning and OTA rollback must remain operational.
- Every functional task ends with native tests and an independently reviewable commit.

---

### Task 1: Portable OJP decoder and firmware metadata

**Files:**
- Create: `firmware/terminal/include/openjornada/ojp.hpp`
- Create: `firmware/terminal/src/domain/ojp.cpp`
- Create: `firmware/terminal/include/openjornada/firmware_metadata.hpp`
- Create: `firmware/terminal/src/domain/firmware_metadata.cpp`
- Create: `firmware/terminal/test/test_usb_protocol/test_main.cpp`
- Modify: `firmware/terminal/platformio.ini`

**Interfaces:**
- Consumes: `DeviceConfig`, `BuildProfile`, `validateDeviceConfig` from `openjornada/config.hpp`.
- Produces: `OjpDecodeResult decodeOjpPayload(std::string_view input, BuildProfile profile)`.
- Produces: `std::optional<FirmwareBuildMetadata> parseFirmwareBuildMetadata(const uint8_t* image, size_t size)` and `kEmbeddedFirmwareMetadata`.

- [ ] **Step 1: Write failing OJP contract tests**

Add vectors for the complete URL, fragment, `ojp=` form and raw Base64URL. Assert strict key order `v,s,p,u,t`, canonical JSON, UTF-8, maximum lengths and rejection of padding or unknown fields:

```cpp
void test_ojp_accepts_all_supported_wrappers() {
  for (const auto& input : validOjpForms()) {
    const auto result = decodeOjpPayload(input, BuildProfile::Development);
    TEST_ASSERT_EQUAL(OjpError::None, result.error);
    TEST_ASSERT_EQUAL_STRING("Red Demo", result.config->ssid.c_str());
    TEST_ASSERT_EQUAL_STRING("ojterm_demo_1234567890",
                             result.config->terminalToken.c_str());
  }
}

void test_ojp_rejects_noncanonical_or_oversized_payloads() {
  TEST_ASSERT_EQUAL(OjpError::InvalidEncoding,
                    decodeOjpPayload("ojp=%%%", BuildProfile::Development).error);
  TEST_ASSERT_EQUAL(OjpError::InvalidContract,
                    decodeOjpPayload(payloadWithUnknownField(),
                                     BuildProfile::Development).error);
}
```

- [ ] **Step 2: Run the new test and verify the missing symbols fail**

Run:

```bash
cd firmware/terminal
uv tool run --from platformio==6.1.19 platformio test -e native -f test_usb_protocol
```

Expected: compilation fails because `ojp.hpp` and its symbols do not exist.

- [ ] **Step 3: Implement the bounded OJP decoder**

Define explicit errors and never include input in returned messages:

```cpp
enum class OjpError {
  None,
  MissingPayload,
  TooLarge,
  InvalidEncoding,
  InvalidUtf8,
  InvalidContract,
  InvalidConfig,
};

struct OjpDecodeResult {
  OjpError error = OjpError::MissingPayload;
  std::optional<DeviceConfig> config;
};
```

Use a fixed 600-byte input cap, strict Base64URL decoding without padding,
ArduinoJson duplicate-key detection through an explicit token/key scan before
deserialization, canonical reserialization in `v,s,p,u,t` order, and
`validateDeviceConfig` as the final authority.

- [ ] **Step 4: Add firmware metadata tests and implementation**

Embed one bounded marker in every build:

```cpp
inline constexpr std::string_view kFirmwareMetadataPrefix =
    "OJFW_META_V1:";

struct FirmwareBuildMetadata {
  std::string board;
  uint8_t protocolVersion = 0;
  std::string firmwareVersion;
};
```

The embedded canonical value must be:

```json
{"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"1.2.0"}
```

The parser scans at most the first 256 KiB, requires exactly one marker, caps
the JSON at 192 bytes and rejects a board, protocol or SemVer outside the
existing OTA policy.

- [ ] **Step 5: Run the focused tests**

Run the command from Step 2. Expected: all OJP and metadata cases pass.

- [ ] **Step 6: Commit the portable contracts**

```bash
git add firmware/terminal/include/openjornada/ojp.hpp \
  firmware/terminal/include/openjornada/firmware_metadata.hpp \
  firmware/terminal/src/domain/ojp.cpp \
  firmware/terminal/src/domain/firmware_metadata.cpp \
  firmware/terminal/test/test_usb_protocol/test_main.cpp \
  firmware/terminal/platformio.ini
git commit -m "feat(firmware): define USB provisioning contracts"
```

### Task 2: OJUSB/1 control and binary framing

**Files:**
- Create: `firmware/terminal/include/openjornada/usb_protocol.hpp`
- Create: `firmware/terminal/src/domain/usb_protocol.cpp`
- Modify: `firmware/terminal/test/test_usb_protocol/test_main.cpp`

**Interfaces:**
- Consumes: `OjpDecodeResult` and `FirmwareBuildMetadata` from Task 1.
- Produces: `UsbControlParser::consume(char)`, `UsbControlRequest`, `encodeUsbResponse`.
- Produces: `UsbFirmwareFrameParser::consume(const uint8_t* data, size_t size)`, `UsbFirmwareFrame`.

- [ ] **Step 1: Write failing fragmented-control tests**

```cpp
void test_control_parser_accepts_fragmented_exact_request() {
  UsbControlParser parser;
  feed(parser, "OJUSB/1 {\"v\":1,\"id\":\"abc\",\"command\":");
  TEST_ASSERT_EQUAL(UsbParseStatus::NeedMore, parser.status());
  feed(parser, "\"status\",\"payload\":{}}\r\n");
  TEST_ASSERT_EQUAL(UsbParseStatus::Complete, parser.status());
  TEST_ASSERT_EQUAL(UsbCommand::Status, parser.request().command);
}
```

Add rejection cases for NUL, unknown/duplicate fields, invalid IDs, malformed
UTF-8, two messages without reset and the 4097th byte.

- [ ] **Step 2: Run the focused test and observe failure**

Run the Task 1 test command. Expected: missing `usb_protocol.hpp`.

- [ ] **Step 3: Implement exact control types and parser**

```cpp
enum class UsbCommand {
  Hello,
  Status,
  Doctor,
  LogsSubscribe,
  Provision,
  Reboot,
  FactoryReset,
  FirmwareBegin,
  FirmwareCommit,
  Cancel,
};

struct UsbControlRequest {
  std::string id;
  UsbCommand command = UsbCommand::Hello;
  std::string ojp;
  FirmwareTransferIntent firmware;
};
```

Parse incrementally into a bounded string, validate the exact object shape per
command and reset explicitly after the caller consumes a result. Encode
responses with fields in `v,id,type,code,message,data` order and escape all
text through ArduinoJson rather than concatenation.

- [ ] **Step 4: Write binary-frame failure and recovery tests**

Cover one-byte fragmentation, two frames in one buffer, wrong magic, length 0,
length 2049, CRC mismatch, repeated offset and partial payload.

- [ ] **Step 5: Implement the 14-byte header and CRC validation**

```cpp
struct UsbFirmwareFrame {
  uint32_t offset = 0;
  std::vector<uint8_t> payload;
};

inline constexpr size_t kUsbFirmwareHeaderBytes = 14;
inline constexpr size_t kUsbFirmwareChunkBytes = 2048;
```

The parser must never allocate from an unvalidated length and must expose the
next expected byte count so the Arduino adapter can read without blocking.

- [ ] **Step 6: Run tests and commit**

```bash
cd firmware/terminal
uv tool run --from platformio==6.1.19 platformio test -e native -f test_usb_protocol
git add firmware/terminal/include/openjornada/usb_protocol.hpp \
  firmware/terminal/src/domain/usb_protocol.cpp \
  firmware/terminal/test/test_usb_protocol/test_main.cpp
git commit -m "feat(firmware): add bounded OJUSB protocol"
```

Expected: focused suite passes.

### Task 3: Provision through USB without a second persistence path

**Files:**
- Modify: `firmware/terminal/include/openjornada/provisioning.hpp`
- Modify: `firmware/terminal/src/provisioning/captive_portal.cpp`
- Modify: `firmware/terminal/src/main.cpp`
- Modify: `firmware/terminal/test/test_provisioning_http/test_main.cpp`
- Modify: `firmware/terminal/test/test_usb_protocol/test_main.cpp`

**Interfaces:**
- Consumes: `UsbControlParser`, `decodeOjpPayload`.
- Produces: `ProvisioningSerialAdapter::service(Stream&, ProvisioningAttemptState&, uint32_t)`.
- Preserves: the existing `CandidateValidator` and `ConfigStore::save` sequence.

- [ ] **Step 1: Add failing mode and duplicate-submission tests**

```cpp
void test_usb_provision_starts_the_existing_attempt_once() {
  ProvisioningSerialState serial;
  ProvisioningAttemptState attempt;
  const auto first = serial.accept(validProvisionRequest(), attempt, 1000);
  const auto second = serial.accept(validProvisionRequest(), attempt, 1001);
  TEST_ASSERT_EQUAL(UsbProvisionDecision::Started, first.decision);
  TEST_ASSERT_EQUAL(UsbProvisionDecision::Busy, second.decision);
}
```

Also assert that the adapter rejects provisioning outside portal mode and
rejects a token change with `pendingCount > 0` through
`canApplyProvisioningCandidate`.

- [ ] **Step 2: Run focused tests and verify failure**

Run `test_usb_protocol` and `test_provisioning_http`. Expected: missing serial
adapter types.

- [ ] **Step 3: Integrate serial servicing into `ProvisioningPortal::run`**

Service serial alongside DNS, display and HTTP. A valid `provision` request
must call the same sequence already used by form submission:

```cpp
DeviceConfig candidate = *decoded.config;
if (!canApplyProvisioningCandidate(activeConfig_, candidate, pendingCount_)) {
  respond("pending_actions");
} else if (!attempt.begin(candidate, millis())) {
  respond("busy");
} else {
  stationConnectStarted = false;
  respond("accepted");
}
```

All progress (`connecting`, `validating`, `saved`, safe error code) is emitted
as OJUSB events. Never serialize `candidate`.

- [ ] **Step 4: Preserve browser provisioning in regression tests**

Run the full `test_provisioning_http` suite and assert an HTTP submission still
uses the same attempt state while a simultaneous serial request receives
`busy`.

- [ ] **Step 5: Build both firmware profiles**

```bash
cd firmware/terminal
uv tool run --from platformio==6.1.19 platformio run -e m5stack_dev
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
```

Expected: both builds succeed below the existing OTA size limit.

- [ ] **Step 6: Commit provisioning support**

```bash
git add firmware/terminal/include/openjornada/provisioning.hpp \
  firmware/terminal/src/provisioning/captive_portal.cpp \
  firmware/terminal/src/main.cpp \
  firmware/terminal/test/test_provisioning_http/test_main.cpp \
  firmware/terminal/test/test_usb_protocol/test_main.cpp
git commit -m "feat(firmware): provision terminal over USB"
```

### Task 4: Runtime status, logs, reboot and physical factory reset

**Files:**
- Create: `firmware/terminal/include/openjornada/usb_maintenance.hpp`
- Create: `firmware/terminal/src/app/usb_maintenance.cpp`
- Modify: `firmware/terminal/include/openjornada/gesture.hpp`
- Modify: `firmware/terminal/src/domain/gesture.cpp`
- Modify: `firmware/terminal/src/main.cpp`
- Modify: `firmware/terminal/test/test_gesture/test_main.cpp`
- Modify: `firmware/terminal/test/test_usb_protocol/test_main.cpp`

**Interfaces:**
- Produces: `UsbMaintenanceService::tick(const UsbMaintenanceContext&)`.
- Produces: `MaintenanceConfirmationGesture::update(BootButtons, uint32_t)`.
- Consumes: pending count, firmware version, mode and connectivity booleans; no credentials.

- [ ] **Step 1: Write failing policy and confirmation tests**

```cpp
void test_factory_reset_requires_fresh_only_c_hold() {
  MaintenanceConfirmationGesture gesture(5000, 30000);
  TEST_ASSERT_EQUAL(ConfirmationState::Waiting,
                    gesture.update({}, 1000).state);
  TEST_ASSERT_EQUAL(ConfirmationState::Counting,
                    gesture.update({false, false, true}, 2000).state);
  TEST_ASSERT_EQUAL(ConfirmationState::Confirmed,
                    gesture.update({false, false, true}, 7000).state);
}
```

Cover release, another button, exact timeout and `millis()` rollover.

- [ ] **Step 2: Implement read-only status and structured logs**

`status` data is limited to:

```cpp
struct UsbPublicStatus {
  std::string board;
  std::string firmwareVersion;
  uint8_t protocolVersion = 1;
  UsbTerminalMode mode = UsbTerminalMode::Booting;
  bool configured = false;
  bool wifiConnected = false;
  size_t pendingCount = 0;
};
```

Add a fixed `UsbLogCode` enum. Do not offer a free-form logging API. `doctor`
returns capability booleans and safe error codes only.

- [ ] **Step 3: Implement reboot and factory-reset state machines**

`reboot` queues a response, flushes serial for at most 250 ms and calls
`ESP.restart()`. `factory-reset` transitions to `AwaitPhysicalConfirmation`,
draws the warning including `pendingCount`, suppresses attendance input and
calls the existing `performFactoryReset` only after confirmation.

- [ ] **Step 4: Integrate the service before blocked/application early returns**

Call USB servicing immediately after `hardware.update()` so `hello`, `status`,
`doctor`, provisioning recovery and factory reset remain available on blocked
screens. Mutating operations receive the current mode and are denied unless
their policy allows them.

- [ ] **Step 5: Run tests and builds**

```bash
cd firmware/terminal
uv tool run --from platformio==6.1.19 platformio test -e native -f test_gesture
uv tool run --from platformio==6.1.19 platformio test -e native -f test_usb_protocol
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
```

Expected: all pass and firmware remains under the OTA limit.

- [ ] **Step 6: Commit runtime maintenance**

```bash
git add firmware/terminal/include/openjornada/usb_maintenance.hpp \
  firmware/terminal/src/app/usb_maintenance.cpp \
  firmware/terminal/include/openjornada/gesture.hpp \
  firmware/terminal/src/domain/gesture.cpp firmware/terminal/src/main.cpp \
  firmware/terminal/test/test_gesture/test_main.cpp \
  firmware/terminal/test/test_usb_protocol/test_main.cpp
git commit -m "feat(firmware): add USB maintenance commands"
```

### Task 5: Rollback-safe USB firmware receiver

**Files:**
- Create: `firmware/terminal/include/openjornada/usb_firmware_receiver.hpp`
- Create: `firmware/terminal/src/network/usb_firmware_receiver.cpp`
- Modify: `firmware/terminal/include/openjornada/ota_worker.hpp`
- Modify: `firmware/terminal/src/network/ota_worker.cpp`
- Modify: `firmware/terminal/src/domain/ota.cpp`
- Modify: `firmware/terminal/src/main.cpp`
- Modify: `firmware/terminal/test/test_ota_policy/test_main.cpp`
- Modify: `firmware/terminal/test/test_usb_protocol/test_main.cpp`

**Interfaces:**
- Consumes: `FirmwareTransferIntent`, `UsbFirmwareFrame`, OtaStateStore.
- Produces: `UsbFirmwareReceiver::begin`, `writeFrame`, `commit`, `abort`.
- Refactors: reusable `verifyFirmwareManifestSignature` and OTA commit staging.

- [ ] **Step 1: Add failing install-policy tests**

Cover official/custom, pending actions, wrong board/protocol, invalid signature,
size over the OTA slot, physical confirmation, busy application and duplicate
begin. Use a table:

```cpp
UsbFirmwareContext pending;
pending.pendingCount = 1;
pending.official = true;
TEST_ASSERT_EQUAL(UsbFirmwareDecision::RejectPendingActions,
                  decideUsbFirmwareInstall(pending));
UsbFirmwareContext custom;
custom.official = false;
custom.metadataCompatible = true;
TEST_ASSERT_EQUAL(UsbFirmwareDecision::RequirePhysicalConfirmation,
                  decideUsbFirmwareInstall(custom));
```

- [ ] **Step 2: Add a fake writer and failing frame tests**

Define `FirmwareSlotWriter` with `begin(size)`, `write(bytes)`, `finish()` and
`abort()` so native tests can assert ordered offsets, CRC retry, short write,
timeout and hash mismatch without Arduino `Update`.

- [ ] **Step 3: Refactor existing OTA verification for reuse**

Move manifest/signature validation that does not perform HTTP into portable
functions. Keep the production public key unchanged and add a test comparing
its bytes with the PEM used by the future CLI.

- [ ] **Step 4: Implement the Arduino receiver**

Use `Update.begin(size, U_FLASH)`, incremental mbedTLS SHA-256 and exact-offset
frames. On any failure call `Update.abort()` and `OtaStateStore::clearPending()`.
On success:

```cpp
if (computedHash != intent.sha256 || !Update.end(true)) {
  abort(FirmwareUpdateError::Hash);
  return false;
}
if (!stateStore.stageCandidate(intent.version, intent.sha256, checkedAt) ||
    !stateStore.markBootPending()) {
  abort(FirmwareUpdateError::BootValidation);
  return false;
}
```

Only after those operations may the terminal emit `rebooting` and restart.

- [ ] **Step 5: Integrate negotiated speed and transfer UI**

Implement `set_baud` handshake: flush at 115200, emit the accepted baud, wait
100 ms, switch to 460800 and require a `baud_ready` message within two seconds.
On failure return to 115200. During transfer render bytes/percentage without
showing filenames or hashes.

- [ ] **Step 6: Run native matrix and firmware builds**

```bash
cd firmware/terminal
uv tool run --from platformio==6.1.19 platformio test -e native
uv tool run --from platformio==6.1.19 platformio run -e m5stack_dev
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
```

Expected: all native tests pass and all builds remain within limits.

- [ ] **Step 7: Commit the receiver**

```bash
git add firmware/terminal/include/openjornada/usb_firmware_receiver.hpp \
  firmware/terminal/src/network/usb_firmware_receiver.cpp \
  firmware/terminal/include/openjornada/ota_worker.hpp \
  firmware/terminal/src/network/ota_worker.cpp \
  firmware/terminal/src/domain/ota.cpp firmware/terminal/src/main.cpp \
  firmware/terminal/test/test_ota_policy/test_main.cpp \
  firmware/terminal/test/test_usb_protocol/test_main.cpp
git commit -m "feat(firmware): install firmware over USB"
```

### Task 6: Firmware documentation and physical acceptance

**Files:**
- Modify: `firmware/terminal/README.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/COMPLIANCE_ES.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: complete OJUSB/1 firmware behavior from Tasks 1-5.
- Produces: CI coverage and operator documentation consumed by the Go CLI plan.

- [ ] **Step 1: Add CI commands for the new firmware suite**

Keep the existing native matrix and builds; add the metadata consistency test
and ensure `test_usb_protocol` is collected by `platformio test -e native`.

- [ ] **Step 2: Document modes, safety and recovery**

Add exact commands expected from the future CLI, the physical `C` confirmation,
pending-action refusal, custom-firmware compatibility requirement and the
PlatformIO/esptool last-resort recovery boundary.

- [ ] **Step 3: Run the repository-required firmware verification**

```bash
cd firmware/terminal
python3 -m unittest scripts/test_validate_partitions.py scripts/test_release_firmware.py
uv tool run --from platformio==6.1.19 platformio test -e native
uv tool run --from platformio==6.1.19 platformio run -e m5stack_dev
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
```

- [ ] **Step 4: Flash and execute the Linux physical smoke test**

Flash `m5stack_release`, then verify `hello`, `status`, provisioning with a demo
OJP, cancellation of custom install, official update refusal with a synthetic
pending action, interrupted transfer rollback and factory reset. Record only
pass/fail and safe error codes; never copy the OJP or token into the report.

- [ ] **Step 5: Review and commit documentation**

```bash
git diff --check
git add .github/workflows/ci.yml firmware/terminal/README.md \
  docs/FEATURES.md docs/COMPLIANCE_ES.md docs/DEPLOYMENT.md
git commit -m "docs: describe terminal USB maintenance"
```
