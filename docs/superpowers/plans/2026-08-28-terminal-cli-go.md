# OpenJornada Terminal Go CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the installable `openjornada-terminal` Go CLI that discovers M5Stack terminals, speaks OJUSB/1, provisions with OJP, performs maintenance, verifies releases and transfers official or custom firmware.

**Architecture:** A separate Go module keeps serial dependencies out of the backend. Commands depend on interfaces for ports, transport, GitHub releases, filesystem and process replacement so all behavior can be tested without a physical terminal; the real adapter uses `go.bug.st/serial` and the exact protocol delivered by the firmware plan.

**Tech Stack:** Go 1.25, Cobra v1.10.2, go.bug.st/serial v1.8.0, golang.org/x/term v0.45.0, standard crypto/ed25519 and net/http.

**Spec:** `docs/superpowers/specs/2026-08-28-terminal-usb-cli-design.md`

## Global Constraints

- The binary name is exactly `openjornada-terminal`.
- The CLI is a separate module at `cli/openjornada-terminal`.
- Supported targets are linux/darwin/windows on amd64/arm64 with `CGO_ENABLED=0`.
- OJP is accepted only interactively without echo or through `--ojp-stdin`; never through a value-bearing command argument.
- Secrets, OJP, UIDs, IP addresses and firmware bytes never appear in output or errors.
- `--port auto` selects exactly one successful OJUSB/1 handshake and fails closed for zero or multiple terminals.
- All network downloads have explicit deadlines, size limits and HTTPS-only GitHub URLs.
- Official firmware is verified locally before transmission; the terminal remains the final authority.
- Every task ends with `go test ./...`, `go vet ./...` and a focused commit.

---

### Task 1: Module, command root and strict OJP input

**Files:**
- Create: `cli/openjornada-terminal/go.mod`
- Create: `cli/openjornada-terminal/cmd/openjornada-terminal/main.go`
- Create: `cli/openjornada-terminal/internal/app/root.go`
- Create: `cli/openjornada-terminal/internal/app/version.go`
- Create: `cli/openjornada-terminal/internal/ojp/ojp.go`
- Create: `cli/openjornada-terminal/internal/ojp/ojp_test.go`

**Interfaces:**
- Produces: `ojp.Parse([]byte) (ojp.Payload, error)`.
- Produces: `app.NewRoot(app.Dependencies) *cobra.Command`.
- Produces: build variables `version`, `commit`, `buildDate` set through ldflags.

- [ ] **Step 1: Create the module and failing OJP tests**

Use module path:

```go
module github.com/GNURub/openjornada/cli/openjornada-terminal

go 1.25.0

require (
    github.com/spf13/cobra v1.10.2
    go.bug.st/serial v1.8.0
    golang.org/x/term v0.45.0
)
```

Test the shared canonical vector plus wrappers and failures:

```go
func TestParseAcceptsSupportedForms(t *testing.T) {
    for _, value := range []string{fullURL, "#ojp=" + encoded, "ojp=" + encoded, encoded} {
        got, err := Parse([]byte(value))
        if err != nil { t.Fatalf("Parse() error = %v", err) }
        if got.SSID != "Red Demo" { t.Fatalf("SSID = %q", got.SSID) }
    }
}

func TestParseNeverReflectsSecretOnFailure(t *testing.T) {
    _, err := Parse([]byte("ojp=" + secretMarker))
    if strings.Contains(err.Error(), secretMarker) { t.Fatal("secret reflected") }
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
cd cli/openjornada-terminal
go test ./internal/ojp
```

Expected: package or `Parse` is missing.

- [ ] **Step 3: Implement strict parsing**

```go
type Payload struct {
    Version      int
    SSID         string
    WiFiPassword string
    BaseURL      string
    TerminalToken string
    Encoded      []byte
}
```

Cap input at 600 bytes, strip only the four approved wrappers, use
`base64.RawURLEncoding.Strict()`, reject duplicate/unknown/reordered keys by
comparing canonical JSON bytes and apply the exact byte limits from the spec.
Return sentinel errors such as `ErrEncoding` and `ErrContract` with safe
Spanish presentation text owned by the command layer.

- [ ] **Step 4: Add the Cobra root and version command**

The root command sets `SilenceUsage: true`, sends normal output to stdout and
errors to stderr. `version` prints only version, commit and build date. It must
not inspect environment variables or create configuration files.

- [ ] **Step 5: Test and commit**

```bash
cd cli/openjornada-terminal
go test ./...
go vet ./...
git add cli/openjornada-terminal
git commit -m "feat(cli): scaffold terminal command"
```

### Task 2: Cross-platform serial discovery and OJUSB transport

**Files:**
- Create: `cli/openjornada-terminal/internal/serialport/ports.go`
- Create: `cli/openjornada-terminal/internal/serialport/ports_test.go`
- Create: `cli/openjornada-terminal/internal/protocol/messages.go`
- Create: `cli/openjornada-terminal/internal/protocol/client.go`
- Create: `cli/openjornada-terminal/internal/protocol/client_test.go`
- Modify: `cli/openjornada-terminal/go.mod`
- Modify: `cli/openjornada-terminal/go.sum`

**Interfaces:**
- Produces: `serialport.Discover(ctx, requested string) (serialport.Port, error)`.
- Produces: `protocol.Client.Call(ctx, command string, payload any, result any) error`.
- Produces: `protocol.Client.Events() <-chan protocol.Event` and `Close() error`.

- [ ] **Step 1: Add dependencies and fake-port tests**

Add `go.bug.st/serial v1.8.0` and model the dependency:

```go
type Port interface {
    io.ReadWriteCloser
    SetReadTimeout(time.Duration) error
    SetDTR(bool) error
    SetRTS(bool) error
    ResetInputBuffer() error
}
```

Tests must fragment the prefix one byte at a time, inject unrelated boot lines,
return malformed JSON, time out, correlate out-of-order IDs and cancel context.

- [ ] **Step 2: Run tests and observe missing implementations**

```bash
cd cli/openjornada-terminal
go test ./internal/serialport ./internal/protocol
```

- [ ] **Step 3: Implement bounded protocol IO**

Generate request IDs from 16 random bytes with `base64.RawURLEncoding`. Write
exactly one line:

```go
type Request struct {
    Version int         `json:"v"`
    ID      string      `json:"id"`
    Command string      `json:"command"`
    Payload interface{} `json:"payload"`
}
```

Read with a reusable 4096-byte bound rather than `bufio.Scanner` defaults.
Ignore non-prefixed lines, reject unknown response fields with
`json.Decoder.DisallowUnknownFields`, and never include the rejected line in an
error.

- [ ] **Step 4: Implement discovery by handshake, not VID/PID**

Enumerate names with `serial.GetPortsList()`, open each without asserting
DTR/RTS, flush stale input and send `hello` with a 750 ms timeout. Do not import
`go.bug.st/serial/enumerator`: its macOS implementation requires CGO and would
break the required cross-compilation. A requested path must still pass the
handshake. Return `ErrNoTerminal` or `ErrMultipleTerminals` with safe port names
only.

- [ ] **Step 5: Run race-enabled tests and cross-compile probes**

```bash
cd cli/openjornada-terminal
go test -race ./internal/serialport ./internal/protocol
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./cmd/openjornada-terminal
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build ./cmd/openjornada-terminal
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./cmd/openjornada-terminal
```

Expected: tests and all builds succeed.

- [ ] **Step 6: Commit transport support**

```bash
git add cli/openjornada-terminal
git commit -m "feat(cli): discover terminals over USB"
```

### Task 3: Status, doctor, logs, provisioning, reboot and reset commands

**Files:**
- Create: `cli/openjornada-terminal/internal/app/device_commands.go`
- Create: `cli/openjornada-terminal/internal/app/device_commands_test.go`
- Create: `cli/openjornada-terminal/internal/app/provision.go`
- Create: `cli/openjornada-terminal/internal/app/provision_test.go`
- Create: `cli/openjornada-terminal/internal/app/reset.go`
- Modify: `cli/openjornada-terminal/internal/app/root.go`

**Interfaces:**
- Consumes: `serialport.Discover`, `protocol.Client`, `ojp.Parse`.
- Produces: the exact public commands `ports`, `status`, `doctor`, `logs`, `provision`, `reboot`, `factory-reset`.

- [ ] **Step 1: Write command tests with injected dependencies**

```go
func TestProvisionReadsOJPFromStdinWithoutEchoingIt(t *testing.T) {
    deps := fakeDependencies(validOJP)
    cmd := NewRoot(deps)
    cmd.SetArgs([]string{"provision", "--ojp-stdin"})
    if err := cmd.Execute(); err != nil { t.Fatal(err) }
    if strings.Contains(deps.stdout.String(), validOJP) { t.Fatal("OJP leaked") }
    if deps.protocol.lastCommand != "provision" { t.Fatal("command not sent") }
}
```

Add golden-free assertions for stable fields rather than complete prose. Cover
zero/multiple ports, terminal in wrong mode, pending-action refusal, cancelled
physical confirmation and interrupted logs.

- [ ] **Step 2: Implement public status and doctor output**

Use a stable text table by default and `--json` only for non-secret fields.
`doctor` exits non-zero if handshake, board or protocol is incompatible. Never
print the raw response object.

- [ ] **Step 3: Implement safe OJP input and provisioning progress**

Interactive input uses `term.ReadPassword`; stdin mode reads at most 601 bytes
and rejects trailing non-whitespace. After local validation, transmit only the
normalized raw payload. Render the device events `accepted`, `connecting`,
`validating`, `saved` and safe failures.

- [ ] **Step 4: Implement reboot, logs and factory-reset UX**

`factory-reset` first calls `status`, prints the pending count, sends the
request, then waits up to 35 seconds for `confirmation_required`, `cancelled`
or `rebooting`. The CLI does not offer `--yes` because physical confirmation is
mandatory.

- [ ] **Step 5: Run all tests and commit**

```bash
cd cli/openjornada-terminal
go test -race ./...
go vet ./...
git add cli/openjornada-terminal
git commit -m "feat(cli): add terminal maintenance commands"
```

### Task 4: Official release discovery and cryptographic verification

**Files:**
- Create: `cli/openjornada-terminal/internal/release/client.go`
- Create: `cli/openjornada-terminal/internal/release/client_test.go`
- Create: `cli/openjornada-terminal/internal/release/verify.go`
- Create: `cli/openjornada-terminal/internal/release/verify_test.go`
- Create: `cli/openjornada-terminal/internal/release/production-ed25519-public.pem`
- Modify: `cli/openjornada-terminal/internal/app/root.go`

**Interfaces:**
- Produces: `release.LatestStable(ctx) (release.Bundle, error)`.
- Produces: `release.VerifyBundle(bundle Bundle, current DeviceInfo) (VerifiedFirmware, error)`.
- Consumes: GitHub release assets and the firmware production public key.

- [ ] **Step 1: Write HTTP and verification tests**

Use `httptest.Server` with redirects to an allowlisted GitHub host abstraction.
Cover non-2xx, timeout, oversized manifest/signature/binary, prerelease,
malformed SemVer, wrong board/protocol, unknown key ID, invalid Ed25519 and hash
mismatch.

- [ ] **Step 2: Add the exact public key and consistency test**

Embed the PEM with `//go:embed`. A repository test reads
`firmware/terminal/keys/production-ed25519-public.pem` through a path derived
from `runtime.Caller` and asserts byte equality; never maintain two unrelated
keys.

- [ ] **Step 3: Implement bounded GitHub downloads**

Use a 30-second request context, HTTPS only, redirect validation, manifest cap
2048 bytes, signature cap 256 bytes and binary cap equal to the OTA slot. Write
the binary to a mode-0600 temporary file while hashing; do not retain it in RAM.

- [ ] **Step 4: Verify with standard-library crypto**

Parse PKIX Ed25519 PEM, verify the exact manifest bytes, decode the strict JSON
contract and compare SHA-256 and file size. Return a `VerifiedFirmware` only
after every gate:

```go
type VerifiedFirmware struct {
    Path      string
    Size      uint32
    SHA256    [32]byte
    Version   string
    Manifest []byte
    Signature []byte
    Official  bool
}
```

- [ ] **Step 5: Test and commit**

```bash
cd cli/openjornada-terminal
go test -race ./internal/release
go vet ./...
git add cli/openjornada-terminal
git commit -m "feat(cli): verify official firmware releases"
```

### Task 5: Firmware check, update and custom installation

**Files:**
- Create: `cli/openjornada-terminal/internal/update/transfer.go`
- Create: `cli/openjornada-terminal/internal/update/transfer_test.go`
- Create: `cli/openjornada-terminal/internal/update/custom.go`
- Create: `cli/openjornada-terminal/internal/update/custom_test.go`
- Create: `cli/openjornada-terminal/internal/app/firmware.go`
- Create: `cli/openjornada-terminal/internal/app/firmware_test.go`
- Modify: `cli/openjornada-terminal/internal/app/root.go`

**Interfaces:**
- Consumes: `release.VerifiedFirmware`, `protocol.Client` and OJFW binary framing.
- Produces: `update.Transfer(ctx, client, firmware, progress) error`.
- Produces: `update.InspectCustom(path string) (release.VerifiedFirmware, error)`.

- [ ] **Step 1: Write transfer retry and abort tests**

Use an in-memory fake port. Assert 2048-byte frames, little-endian fields,
CRC-32, exact offsets, three retries, five-second progress timeout, context
cancellation and a final `firmware_commit`. Ensure errors never contain frame
data or hash.

- [ ] **Step 2: Implement negotiated baud and frames**

Start at 115200, send `set_baud`, wait for acknowledgement, change both sides
to 460800 and send `baud_ready`. Fall back once to 115200. Use `io.ReadFull` for
acks, reopen the source file for retry safety and render percentage at most ten
times per second.

- [ ] **Step 3: Implement custom metadata inspection**

Read at most the first 256 KiB to find exactly one `OJFW_META_V1:` marker,
validate board/protocol/SemVer, stat the complete file and calculate SHA-256.
Mark `Official: false`; never infer official status from metadata.

- [ ] **Step 4: Implement command policy**

`firmware check` never opens a transfer. `firmware update` refuses downgrade or
same version unless the terminal reports a failed/rolled-back state that the
firmware policy explicitly permits. `firmware install` prints the custom
warning and waits for the device's physical-confirmation event before sending
bytes.

- [ ] **Step 5: Run tests and commit**

```bash
cd cli/openjornada-terminal
go test -race ./...
go vet ./...
git add cli/openjornada-terminal
git commit -m "feat(cli): transfer firmware over USB"
```

### Task 6: Self-update, shell completion and operator documentation

**Files:**
- Create: `cli/openjornada-terminal/internal/update/self.go`
- Create: `cli/openjornada-terminal/internal/update/self_test.go`
- Create: `cli/openjornada-terminal/internal/update/replace_unix.go`
- Create: `cli/openjornada-terminal/internal/update/replace_windows.go`
- Create: `cli/openjornada-terminal/README.md`
- Create: `cli/openjornada-terminal/THIRD_PARTY_NOTICES`
- Modify: `cli/openjornada-terminal/internal/app/root.go`
- Modify: `README.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/COMPLIANCE_ES.md`

**Interfaces:**
- Consumes: release archives and `checksums.txt` from the distribution plan.
- Produces: `self-update` and `completion bash|zsh|fish|powershell`.

- [ ] **Step 1: Write platform replacement tests**

Inject executable path, filesystem and process launcher. Unix must write mode
0755 in the same directory and rename atomically. Windows must write `.new`,
generate a temporary PowerShell command that waits for the current PID, moves
the file and deletes only its own temporary script.

- [ ] **Step 2: Implement checksum-bound self-update**

Resolve the current `runtime.GOOS/GOARCH` asset, download it and
`checksums.txt`, require exactly one matching checksum line, verify before
extraction, reject symlinks/path traversal and confirm the extracted archive
contains exactly the expected binary plus license files.

- [ ] **Step 3: Add Cobra completion commands**

Use Cobra's generators and disable the autogenerated timestamp so output is
reproducible. Completion must never inspect devices or network.

- [ ] **Step 4: Document commands and security boundaries**

Document interactive/stdin OJP usage, USB permissions on Linux, macOS/Windows
unsigned-binary warnings, physical confirmations, pending-action behavior and
esptool recovery. State explicitly that Go memory is not cryptographically
erased.

- [ ] **Step 5: Run complete CLI verification**

```bash
cd cli/openjornada-terminal
go test -race ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/openjornada-terminal
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./cmd/openjornada-terminal
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build ./cmd/openjornada-terminal
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build ./cmd/openjornada-terminal
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./cmd/openjornada-terminal
CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build ./cmd/openjornada-terminal
```

- [ ] **Step 6: Review and commit**

```bash
git diff --check
git add cli/openjornada-terminal README.md docs/FEATURES.md docs/COMPLIANCE_ES.md
git commit -m "docs: deliver terminal USB CLI"
```
