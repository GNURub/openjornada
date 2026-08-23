# M5Stack Provisioning Display Sleep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the terminal provisioning portal available until a valid configuration is saved while sleeping only the display after ten minutes without a physical button press.

**Architecture:** A portable, wrap-safe timer owns the provisioning display state and emits one-shot sleep/wake events. The Arduino portal loop remains active indefinitely, services DNS and HTTP continuously, and maps timer events to M5GFX `sleep()`/`wakeup()` without suspending the ESP32 or Wi-Fi.

**Tech Stack:** C++17, PlatformIO, Unity, Arduino ESP32, M5Unified 0.2.8, M5GFX 0.2.11.

**Spec:** `docs/superpowers/specs/2026-08-21-m5stack-firmware-design.md`

## Global Constraints

- The portal and WPA2 access point remain active until a valid configuration is saved.
- Only A, B or C button presses reset the display inactivity timer.
- The display sleeps after exactly 600.000 ms without a button press.
- A wake-up press is consumed by the provisioning flow and grants another full 600.000 ms.
- Timer comparisons must remain correct across the 32-bit `millis()` rollover.
- Display sleep must not stop DNS, HTTP, Wi-Fi or the ESP32.
- Successful provisioning keeps the existing save, confirmation and reboot behavior.

---

### Task 1: Add a portable provisioning display timer

**Files:**
- Modify: `firmware/terminal/include/openjornada/provisioning.hpp`
- Modify: `firmware/terminal/src/provisioning/captive_portal.cpp`
- Test: `firmware/terminal/test/test_provisioning_http/test_main.cpp`

**Interfaces:**
- Produces: `kProvisioningDisplayIdleMs`, `ProvisioningDisplayEvent` and `ProvisioningDisplayTimer::update(uint32_t nowMs, bool buttonPressed)`.
- Produces: `ProvisioningDisplayTimer::sleeping() const` for deterministic state assertions.

- [x] **Step 1: Write failing timeout, reset, wake and rollover tests**

```cpp
void test_provisioning_display_sleeps_after_ten_minutes() {
  ProvisioningDisplayTimer timer(100);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningDisplayEvent::None),
      static_cast<int>(timer.update(100 + kProvisioningDisplayIdleMs - 1, false)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningDisplayEvent::Sleep),
      static_cast<int>(timer.update(100 + kProvisioningDisplayIdleMs, false)));
  TEST_ASSERT_TRUE(timer.sleeping());
}

void test_provisioning_button_resets_and_wakes_display() {
  ProvisioningDisplayTimer timer(0);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningDisplayEvent::None),
      static_cast<int>(timer.update(kProvisioningDisplayIdleMs - 1, true)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningDisplayEvent::Sleep),
      static_cast<int>(timer.update(2 * kProvisioningDisplayIdleMs - 1, false)));
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningDisplayEvent::Wake),
      static_cast<int>(timer.update(2 * kProvisioningDisplayIdleMs, true)));
  TEST_ASSERT_FALSE(timer.sleeping());
}

void test_provisioning_display_timer_handles_millis_rollover() {
  const uint32_t startedAt = UINT32_MAX - 1000U;
  ProvisioningDisplayTimer timer(startedAt);
  TEST_ASSERT_EQUAL_INT(
      static_cast<int>(ProvisioningDisplayEvent::Sleep),
      static_cast<int>(timer.update(startedAt + kProvisioningDisplayIdleMs,
                                    false)));
}
```

- [x] **Step 2: Run the focused native test and confirm it fails**

Run: `cd firmware/terminal && uv tool run --from platformio platformio test -e native -f test_provisioning_http`

Expected: compilation fails because the timer API does not exist.

- [x] **Step 3: Implement the minimal one-shot state machine**

```cpp
inline constexpr uint32_t kProvisioningDisplayIdleMs =
    10U * 60U * 1000U;

enum class ProvisioningDisplayEvent { None, Sleep, Wake };

class ProvisioningDisplayTimer {
 public:
  explicit ProvisioningDisplayTimer(uint32_t startedAtMs);
  ProvisioningDisplayEvent update(uint32_t nowMs, bool buttonPressed);
  bool sleeping() const;

 private:
  uint32_t lastButtonMs_;
  bool sleeping_ = false;
};
```

Use unsigned subtraction (`nowMs - lastButtonMs_`) so expiry remains correct across `millis()` rollover. Emit `Sleep` and `Wake` only on state transitions; every button press updates `lastButtonMs_`.

- [x] **Step 4: Run the focused native test and confirm it passes**

Run: `cd firmware/terminal && uv tool run --from platformio platformio test -e native -f test_provisioning_http`

Expected: every `test_provisioning_http` case passes.

---

### Task 2: Keep provisioning alive and control the physical display

**Files:**
- Modify: `firmware/terminal/src/provisioning/captive_portal.cpp`
- Modify: `firmware/terminal/src/ui/provisioning_screen.cpp`
- Modify: `firmware/terminal/README.md`
- Modify: `docs/superpowers/specs/2026-08-21-m5stack-firmware-design.md`

**Interfaces:**
- Consumes: `ProvisioningDisplayTimer::update(uint32_t, bool)` from Task 1.
- Consumes: M5GFX `M5.Display.sleep()` and `M5.Display.wakeup()` from the pinned installed dependency.

- [x] **Step 1: Replace portal expiry with continuous servicing**

Change the main portal loop from a ten-minute portal lifetime to `while (!completed)`. Preserve all DNS processing, bounded HTTP parsing, connection timeouts, candidate validation, atomic configuration save and portal teardown after success.

- [x] **Step 2: Service the timer and all three buttons inside portal waits**

After each `M5.update()`, combine `M5.BtnA.wasPressed()`, `M5.BtnB.wasPressed()` and `M5.BtnC.wasPressed()`. Feed the result to the timer. On `Sleep`, call `M5.Display.sleep()`; on `Wake`, call `M5.Display.wakeup()` and redraw `drawProvisioningAccess(apSsid, apPassword)`. Execute bootstrap through the existing `NetworkWorker` and invoke the display service while waiting for NTP and the worker result, so short presses are not lost during blocking TLS or HTTP operations.

- [x] **Step 3: Update Spanish screen copy and documentation**

Replace `Se cierra tras 10 min sin actividad` with `La pantalla se apaga tras 10 min` and document that a button wakes it for another ten minutes while the portal stays available until provisioning succeeds.

- [x] **Step 4: Run all automated firmware verification**

Run:

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
```

Expected: all native tests and both ESP32 builds exit 0. A successful save explicitly wakes the panel before rendering `Configurado`, even if the inactivity timeout elapsed during validation.

- [x] **Step 5: Flash and verify the connected development board**

Upload `m5stack_dev` to the stable serial device, monitor one clean boot, confirm the provisioning AP remains present, and verify no watchdog or reset loop occurs. Confirm the screen can be slept and woken by A, B or C without stopping the AP; never print or capture the temporary password in logs.

- [x] **Step 6: Review the focused diff**

Run `git diff --check` and inspect only the files listed by this plan. Do not commit or publish unless the user explicitly requests it.
