# Terminal CLI Cross-Platform Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test, package, attest and publish the Go terminal CLI for Windows, macOS and Linux, with checksum-verifying user-level installers and self-update-compatible release assets.

**Architecture:** CI tests the independent Go module and cross-compiles every supported target with CGO disabled. A release workflow builds deterministic archives from the published tag, generates one checksum inventory, attests the assets and uploads them alongside portable shell and PowerShell installers.

**Tech Stack:** GitHub Actions, Go 1.25, Python 3 standard library for deterministic packaging tests, POSIX shell, PowerShell 7, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-28-terminal-usb-cli-design.md`

## Global Constraints

- Release assets are named `openjornada-terminal_<os>_<arch>.tar.gz` or `.zip` without a version in the filename.
- Supported pairs are linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64 and windows/arm64.
- Every binary is built with `CGO_ENABLED=0` from the exact published tag.
- Version, commit and build date are injected through ldflags and `version` must match the release.
- Archives contain only the binary, `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES`.
- Installers verify the exact SHA-256 line before extraction and never use administrator privileges implicitly.
- Actions are pinned by immutable commit SHA and use minimum permissions.
- Stable and prerelease assets may be published, but `latest/download` and installers resolve only the latest stable release.
- No workflow, installer or artifact contains OJP values, API keys, Wi-Fi credentials or signing private keys.

---

### Task 1: Deterministic packaging and checksum tooling

**Files:**
- Create: `cli/openjornada-terminal/scripts/package_release.py`
- Create: `cli/openjornada-terminal/scripts/test_package_release.py`
- Create: `cli/openjornada-terminal/scripts/checksums.py`
- Create: `cli/openjornada-terminal/scripts/test_checksums.py`
- Modify: `cli/openjornada-terminal/README.md`

**Interfaces:**
- Consumes: one compiled binary, root `LICENSE`, root `NOTICE`, CLI `THIRD_PARTY_NOTICES`.
- Produces: one deterministic archive per OS/architecture and sorted `checksums.txt`.

- [ ] **Step 1: Write failing archive-layout tests**

```python
def test_linux_archive_is_reproducible_and_bounded(self):
    first = package(self.fixture, "linux", "amd64")
    second = package(self.fixture, "linux", "amd64")
    self.assertEqual(first.read_bytes(), second.read_bytes())
    self.assertEqual(
        archive_names(first),
        ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES", "openjornada-terminal"],
    )
```

Add Windows `.exe`, executable mode 0755, fixed timestamp, sorted entries,
rejection of symlinks and rejection of any unexpected input file.

- [ ] **Step 2: Run tests and observe failure**

```bash
cd cli/openjornada-terminal
python3 -m unittest scripts/test_package_release.py scripts/test_checksums.py
```

Expected: modules are missing.

- [ ] **Step 3: Implement deterministic archives**

Use `tarfile` with uid/gid 0, empty owner names, mode 0755/0644 and mtime 0.
Use `zipfile.ZipInfo` with `1980-01-01T00:00:00`, explicit Unix permission bits
and `ZIP_DEFLATED`. Never follow symlinks.

CLI:

```text
package_release.py --binary PATH --os linux --arch amd64 \
  --license ../../../LICENSE --notice ../../../NOTICE \
  --third-party THIRD_PARTY_NOTICES --output DIST
```

- [ ] **Step 4: Implement sorted checksums**

`checksums.py DIST/*.tar.gz DIST/*.zip --output DIST/checksums.txt` writes
lowercase SHA-256, two spaces and basename, sorted bytewise. It rejects duplicate
basenames and refuses to include `checksums.txt` itself.

- [ ] **Step 5: Test and commit**

```bash
cd cli/openjornada-terminal
python3 -m unittest scripts/test_package_release.py scripts/test_checksums.py
git add cli/openjornada-terminal/scripts cli/openjornada-terminal/README.md
git commit -m "build(cli): add deterministic release packaging"
```

### Task 2: Add CLI tests and cross-compilation to main CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `cli/openjornada-terminal/README.md`

**Interfaces:**
- Consumes: the completed Go CLI module.
- Produces: required CI evidence for unit tests, vet and all six target builds.

- [ ] **Step 1: Add a dedicated `terminal-cli` job**

Use the existing pinned checkout/setup-go Actions and `go-version-file` pointing
to `cli/openjornada-terminal/go.mod`. Set `working-directory` for every Go
command so the backend module cache remains independent.

- [ ] **Step 2: Add test, vet and packaging-contract steps**

```yaml
- name: Probar CLI del terminal
  working-directory: cli/openjornada-terminal
  run: go test -race ./...

- name: Analizar CLI del terminal
  working-directory: cli/openjornada-terminal
  run: go vet ./...

- name: Probar empaquetado
  working-directory: cli/openjornada-terminal
  run: python3 -m unittest scripts/test_package_release.py scripts/test_checksums.py
```

- [ ] **Step 3: Add explicit cross-build commands**

Build into `dist-ci/` with `-trimpath` and
`-ldflags "-s -w -X github.com/GNURub/openjornada/cli/openjornada-terminal/internal/app.version=ci"`.
Name each output uniquely;
use `.exe` only for Windows. Assert all six files are non-empty and run the
native Linux amd64 binary's `version` command.

- [ ] **Step 4: Validate workflow and run local equivalents**

```bash
cd cli/openjornada-terminal
go test -race ./...
go vet ./...
python3 -m unittest scripts/test_package_release.py scripts/test_checksums.py
cd ../..
git diff --check .github/workflows/ci.yml
```

- [ ] **Step 5: Commit CI coverage**

```bash
git add .github/workflows/ci.yml cli/openjornada-terminal/README.md
git commit -m "ci: verify terminal CLI targets"
```

### Task 3: Build and publish CLI assets on GitHub Release

**Files:**
- Create: `.github/workflows/publish-terminal-cli.yml`
- Create: `cli/openjornada-terminal/scripts/verify_release_assets.py`
- Create: `cli/openjornada-terminal/scripts/test_verify_release_assets.py`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: a published GitHub Release and the packaging scripts from Task 1.
- Produces: six archives, `checksums.txt`, `install.sh` and `install.ps1` attached to that release.

- [ ] **Step 1: Write the release-inventory contract test**

```python
EXPECTED = {
    "openjornada-terminal_linux_amd64.tar.gz",
    "openjornada-terminal_linux_arm64.tar.gz",
    "openjornada-terminal_darwin_amd64.tar.gz",
    "openjornada-terminal_darwin_arm64.tar.gz",
    "openjornada-terminal_windows_amd64.zip",
    "openjornada-terminal_windows_arm64.zip",
    "checksums.txt",
    "install.sh",
    "install.ps1",
}
```

The verifier rejects missing, extra, empty or duplicate assets and asserts that
the checksum inventory names exactly the six archives.

- [ ] **Step 2: Create a least-privilege build job**

Trigger on `release: types: [published]`, checkout the release tag, set up Go
from the CLI module, test/vet, then build six binaries with:

```bash
CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
  go build -trimpath -ldflags "-s -w \
  -X github.com/GNURub/openjornada/cli/openjornada-terminal/internal/app.version=$RELEASE_TAG \
  -X github.com/GNURub/openjornada/cli/openjornada-terminal/internal/app.commit=$GITHUB_SHA \
  -X github.com/GNURub/openjornada/cli/openjornada-terminal/internal/app.buildDate=$PUBLISHED_AT" \
  -o "$output" ./cmd/openjornada-terminal
```

The build job has `contents: read`, packages the outputs and uploads one
short-lived Actions artifact.

- [ ] **Step 3: Create an isolated publish job**

The publish job has `contents: write`, `attestations: write` and
`id-token: write`. It downloads the artifact, generates checksums, copies the
two installers, runs `verify_release_assets.py`, attests the six archives plus
checksum inventory with the repository's pinned attestation Action, and uploads
all nine files with `gh release upload --clobber`.

- [ ] **Step 4: Verify uploaded assets server-side**

After upload, fetch `.assets[].name` with `gh release view`, pass the names and
sizes to `verify_release_assets.py`, and fail the workflow if any contract item
is absent or zero bytes.

- [ ] **Step 5: Test, document and commit**

```bash
cd cli/openjornada-terminal
python3 -m unittest scripts/test_verify_release_assets.py
cd ../..
git diff --check .github/workflows/publish-terminal-cli.yml docs/DEPLOYMENT.md
git add .github/workflows/publish-terminal-cli.yml \
  cli/openjornada-terminal/scripts/verify_release_assets.py \
  cli/openjornada-terminal/scripts/test_verify_release_assets.py \
  docs/DEPLOYMENT.md
git commit -m "ci: publish terminal CLI releases"
```

### Task 4: Checksum-verifying Unix installer

**Files:**
- Create: `cli/openjornada-terminal/install.sh`
- Create: `cli/openjornada-terminal/scripts/test_install_sh.sh`
- Modify: `cli/openjornada-terminal/README.md`

**Interfaces:**
- Consumes: latest stable unversioned archive and `checksums.txt`.
- Produces: user-level installation on Linux and macOS.

- [ ] **Step 1: Write a local-fixture installer test**

The test creates tiny valid archives/checksums in a temporary fixture, stubs
`uname` and `curl` without changing the production download base, installs into a temporary
`OPENJORNADA_INSTALL_DIR`, executes `openjornada-terminal version`, then alters
one byte and asserts checksum failure leaves the old binary untouched.

- [ ] **Step 2: Implement strict platform mapping**

Map only `Linux -> linux`, `Darwin -> darwin`, `x86_64|amd64 -> amd64` and
`arm64|aarch64 -> arm64`. Reject every other value before downloading.

- [ ] **Step 3: Implement download, verification and atomic install**

Use `set -eu`, `umask 077`, `mktemp -d` and a trap scoped to that exact
directory. Download from the constant GitHub `releases/latest/download` base.
Select `sha256sum` or `shasum -a 256`, require one exact checksum line, extract
only the expected four filenames and install the binary atomically at mode
0755. Default destination is `${OPENJORNADA_INSTALL_DIR:-$HOME/.local/bin}`.

- [ ] **Step 4: Test syntax and behavior**

```bash
sh -n cli/openjornada-terminal/install.sh
sh cli/openjornada-terminal/scripts/test_install_sh.sh
```

- [ ] **Step 5: Commit the Unix installer**

```bash
git add cli/openjornada-terminal/install.sh \
  cli/openjornada-terminal/scripts/test_install_sh.sh \
  cli/openjornada-terminal/README.md
git commit -m "feat(cli): add verified Unix installer"
```

### Task 5: Checksum-verifying Windows installer

**Files:**
- Create: `cli/openjornada-terminal/install.ps1`
- Create: `cli/openjornada-terminal/scripts/test_install_ps1.ps1`
- Modify: `cli/openjornada-terminal/README.md`

**Interfaces:**
- Consumes: latest stable Windows archive and `checksums.txt`.
- Produces: per-user Windows installation and user PATH entry.

- [ ] **Step 1: Write Pester-free PowerShell tests**

Use a plain script that creates a fixture ZIP/checksum, invokes the installer
functions with injected download paths, verifies amd64/arm64 mapping, executes
the installed `.exe`, corrupts the ZIP and asserts the previous executable is
unchanged. Exit non-zero on any assertion.

- [ ] **Step 2: Implement strict PowerShell behavior**

Set `$ErrorActionPreference = 'Stop'`, derive architecture only from
`[Runtime.InteropServices.RuntimeInformation]::OSArchitecture`, use a unique
directory under `[IO.Path]::GetTempPath()` and remove only that directory in
`finally`.

- [ ] **Step 3: Verify and install atomically**

Download through `Invoke-WebRequest`, parse exactly one checksum line for the
selected ZIP, compare lowercase `Get-FileHash -Algorithm SHA256`, expand into
the temporary directory and move the expected executable into
`$env:LOCALAPPDATA\Programs\OpenJornada\bin`. Add that exact directory to the
current-user PATH only if absent; never modify machine PATH or request elevation.

- [ ] **Step 4: Run on a Windows Actions runner**

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  'cli/openjornada-terminal/install.ps1', [ref]$null, [ref]$errors
) | Out-Null
if ($errors.Count -ne 0) { throw $errors }
pwsh -File cli/openjornada-terminal/scripts/test_install_ps1.ps1
```

Add this exact smoke test to the CLI release workflow before publication.

- [ ] **Step 5: Commit the Windows installer**

```bash
git add cli/openjornada-terminal/install.ps1 \
  cli/openjornada-terminal/scripts/test_install_ps1.ps1 \
  cli/openjornada-terminal/README.md \
  .github/workflows/publish-terminal-cli.yml
git commit -m "feat(cli): add verified Windows installer"
```

### Task 6: Release dry run and final documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/COMPLIANCE_ES.md`
- Modify: `cli/openjornada-terminal/README.md`

**Interfaces:**
- Consumes: complete CLI, firmware protocol and release workflows.
- Produces: end-user installation and release-operation documentation.

- [ ] **Step 1: Document exact installation and upgrade commands**

Include the stable `curl` and PowerShell commands, manual checksum verification,
PATH locations, `self-update`, unsigned macOS/Windows warnings and uninstall
steps that remove only the installed binary/directory.

- [ ] **Step 2: Document release behavior**

State that publishing one GitHub Release independently triggers container,
firmware and CLI workflows; firmware remains stable-only for OTA, while CLI
prerelease assets do not become `latest` installer targets.

- [ ] **Step 3: Execute the complete local verification matrix**

```bash
cd cli/openjornada-terminal
go test -race ./...
go vet ./...
python3 -m unittest scripts/test_package_release.py scripts/test_checksums.py \
  scripts/test_verify_release_assets.py
sh -n install.sh
sh scripts/test_install_sh.sh
cd ../..
git diff --check
```

Also run the PowerShell test in a Windows Actions workflow and require it before
publishing assets.

- [ ] **Step 4: Create a draft release dry run**

Create a prerelease tag from a clean commit, confirm all six archives,
checksums, installers and attestations are present, install the CLI on one
Linux, one macOS and one Windows host, and verify `version`, `ports` and
`doctor`. Delete only the draft/prerelease created for this test after recording
the run URL and results.

- [ ] **Step 5: Review and commit documentation**

```bash
git diff --check
git add README.md docs/DEPLOYMENT.md docs/FEATURES.md docs/COMPLIANCE_ES.md \
  cli/openjornada-terminal/README.md
git commit -m "docs: publish terminal CLI installation guide"
```
