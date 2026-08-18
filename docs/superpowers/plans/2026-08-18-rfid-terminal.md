# RFID Terminal v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a versioned RFID terminal command API, Spanish administration UI, and 320×240 development simulator for reliable online and signed-offline clocking.

**Architecture:** PocketBase remains authoritative. Device routes translate commands into the same immutable `work_events` domain rules used by the SPA; scoped per-terminal credentials protect the API, and idempotent receipts plus incidents reconcile offline queues without inventing events. Angular adds terminal management, employee tag controls, incident resolution, and a development-only M5Stack simulator.

**Tech Stack:** PocketBase 0.39.10 JavaScript hooks and migrations, Angular 22 standalone components/signals, Tailwind CSS 4, Vitest, Playwright, Web Crypto API, future ESP32 SQLite/AES-GCM/HMAC-SHA256 contract.

**Spec:** `docs/superpowers/specs/2026-08-18-rfid-terminal-design.md`

## Global Constraints

- UI and functional documentation are in Spanish.
- The server is authoritative for employee, organization, state, time evidence, integrity, and authorization.
- Every device and data query is restricted to one organization.
- `work_events` and their audits remain immutable.
- Keep server receipt time, device capture time, effective time, adjustment and reason separate.
- The UID is never logged or exposed through normal collection APIs.
- One active UID per employee; replacing it atomically revokes the previous assignment.
- API keys are terminal-specific, do not expire, and are shown only once.
- The organization PIN has exactly four digits and is never returned by an API.
- Offline clock trust expires 24 hours after NTP and immediately after reboot without NTP.
- The first release contains API, web UI and simulator, not physical firmware or OTA.
- Preserve unrelated dirty-worktree changes and create focused commits.

---

### Task 1: Persist the approved schema and public contracts

**Files:**
- Create: `backend/pb_migrations/1787047200_rfid_terminals.js`
- Modify: `web/src/app/core/models.ts`
- Create: `web/src/app/core/terminal.models.ts`
- Test: `web/src/app/core/terminal.models.spec.ts`

**Interfaces:**
- Produces `TerminalRecord`, `TerminalBootstrapResponse`, `TerminalWorkState`, `TerminalAction`, `TerminalQueuedAction`, `TerminalActionResult`, and `TerminalIncidentRecord`.
- Produces protected server fields and indexes consumed by all later tasks.

- [ ] **Step 1: Write the model contract test**

Create compile-time fixtures plus runtime assertions for these exact unions:

```typescript
export type TerminalStateKind = 'idle' | 'working' | 'on_break';
export type TerminalCommand = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';
export type TerminalActionStatus = 'accepted' | 'duplicate' | 'incident' | 'rejected';
export type TerminalErrorCode =
  | 'authentication_required'
  | 'terminal_revoked'
  | 'admin_session_required'
  | 'admin_session_expired'
  | 'pin_rate_limited'
  | 'unknown_tag'
  | 'inactive_employee'
  | 'state_conflict'
  | 'clock_untrusted'
  | 'protocol_incompatible'
  | 'invalid_signature';
```

Assert that a bootstrap fixture uses protocol `1`, `maxOfflineSeconds: 86400`,
and `maxQueuedActions: 10000`.

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `cd web && pnpm exec vitest run src/app/core/terminal.models.spec.ts`
Expected: FAIL because `terminal.models.ts` does not exist.

- [ ] **Step 3: Add the migration**

Create collections with no public collection rules:

```text
attendance_terminals
  organization, name, prefix, tokenHash(hidden), signingMaterial(hidden),
  protocolVersion, clientVersion, cacheRevision, lastSeenAt,
  lastPendingCount, revokedAt, createdBy, created, updated

terminal_admin_sessions
  organization, terminal, tokenHash(hidden), lastUsedAt, revokedAt, created

terminal_pin_attempts
  organization, terminal, failures, blockedUntil, updated

terminal_action_receipts
  organization, terminal, clientRequestId, status, workEvent, incident,
  response, created

terminal_sync_incidents
  organization, terminal, employee, clientRequestId, command,
  deviceCapturedAt, appliedAt, evidence, reasonCode, status,
  resolvedBy, resolvedAt, resolutionNote, created, updated
```

Add hidden `rfidUidFingerprint` and `rfidUidCiphertext` fields to `users`, and
hidden `terminalAdminPinHash` plus `rfidCacheRevision` to `organizations`.
Add `terminal`, `deviceCapturedAt`, `clockSyncedAt`, `deviceSequence`, and
`queuedOffline` to `work_events`; extend `source` with `terminal`.

Create unique indexes for terminal prefix, non-empty RFID fingerprint,
`(terminal, clientRequestId)`, and session token hash. Add organization/status
indexes for list screens. The down migration removes new collections before
removing added fields.

- [ ] **Step 4: Implement the TypeScript contracts**

Define request and response shapes with these required action fields:

```typescript
export interface TerminalActionRequest {
  clientRequestId: string;
  scanContext: string;
  command: TerminalCommand;
  deviceCapturedAt: string;
  appliedAt?: string;
  clockSyncedAt: string;
  deviceSequence: number;
}

export interface TerminalActionResult {
  clientRequestId: string;
  status: TerminalActionStatus;
  workEventId?: string;
  incidentId?: string;
  state: TerminalWorkState;
  errorCode?: TerminalErrorCode;
}

export interface TerminalAction {
  command: TerminalCommand;
  label: string;
  mode: 'now' | 'choose_time' | 'close_from_break';
  highlighted: boolean;
}

export interface TerminalWorkState {
  kind: TerminalStateKind;
  since: string | null;
  workedSeconds: number;
  breakSeconds: number;
  longShift: boolean;
  staleBreak: boolean;
  actions: TerminalAction[];
}

export interface TerminalQueuedAction
  extends Omit<TerminalActionRequest, 'scanContext'> {
  uid: string;
  rebootId: string;
  previousLocalHash: string;
  signature: string;
}

export interface TerminalBootstrapResponse {
  protocol: { current: 1; min: 1; max: 1 };
  serverTime: string;
  timezone: string;
  cacheRevision: number;
  maxOfflineSeconds: 86400;
  maxQueuedActions: 10000;
}
```

`TerminalRecord` contains public terminal metadata and an optional `token`
present only in create/rotate responses. `TerminalIncidentRecord` uses status
`pending | resolved` and exposes employee, terminal, command, captured/applied
times, reason code and resolution metadata, but never UID. Add optional terminal
evidence fields to `WorkEventRecord` and RFID assignment presence to
`UserRecord`; never add a raw UID property to either record.

- [ ] **Step 5: Run the contract test and frontend suite**

Run: `cd web && pnpm exec vitest run src/app/core/terminal.models.spec.ts`
Expected: PASS.

Run: `cd web && pnpm run test:ci`
Expected: all existing tests PASS.

- [ ] **Step 6: Commit the schema and contracts**

```bash
git add backend/pb_migrations/1787047200_rfid_terminals.js \
  web/src/app/core/models.ts web/src/app/core/terminal.models.ts \
  web/src/app/core/terminal.models.spec.ts
git commit -m "feat: add RFID terminal data contracts"
```

### Task 2: Centralize authoritative work-event decisions

**Files:**
- Create: `backend/pb_hooks/work_event_domain.js`
- Create: `backend/pb_hooks/work_event_domain.test.js`
- Modify: `backend/pb_hooks/main.pb.js`
- Modify: `backend/pb_hooks/timesheet_helpers.js`

**Interfaces:**
- Produces `allowedCommands(previousKind)`, `currentTerminalState(events, now)`,
  `prepareWorkEvent(app, record, context)`, and `createWorkEventAudit(app, record)`.
- Consumed by the current collection hook and Task 4 terminal action routes.

- [ ] **Step 1: Write failing state-machine tests**

Cover exact transitions:

```javascript
assert.deepEqual(allowedCommands(""), ["clock_in"])
assert.deepEqual(allowedCommands("clock_out"), ["clock_in"])
assert.deepEqual(allowedCommands("clock_in"), ["break_start", "clock_out"])
assert.deepEqual(allowedCommands("break_start"), ["break_end"])
assert.deepEqual(allowedCommands("break_end"), ["break_start", "clock_out"])
```

Assert `currentTerminalState` returns `longShift: true` at exactly four hours
and `staleBreak: true` only after 25 minutes. Verify effective worked time
excludes completed and active breaks.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test backend/pb_hooks/work_event_domain.test.js`
Expected: FAIL because the domain module does not exist.

- [ ] **Step 3: Implement the pure state functions**

Keep the pure functions free of PocketBase globals so Node can test them.
Return actions in the display order required by the spec and expose warning
flags separately from the state.

- [ ] **Step 4: Move request preparation into the shared helper**

`prepareWorkEvent` must:

1. Resolve employee and organization from trusted context.
2. Validate the command against the latest effective event.
3. Set server `recordedAt` and trusted `occurredAt`.
4. Keep queue delay separate from intentional `appliedAt` adjustment.
5. Require the automatic reason for terminal backdating.
6. Set source, terminal evidence, previous hash and integrity v2 hash.
7. Require a unique client request ID.

Move the audit body to `createWorkEventAudit`. Preserve the existing SPA
behavior byte-for-byte for non-terminal sources.

- [ ] **Step 5: Replace duplicated logic in `main.pb.js`**

The existing `onRecordCreateRequest` supplies an authenticated-user context to
`prepareWorkEvent`; `onRecordAfterCreateSuccess` calls the shared audit
function. Keep admin/manager correction rules unchanged.

- [ ] **Step 6: Run focused and frontend time tests**

Run: `node --test backend/pb_hooks/work_event_domain.test.js`
Expected: PASS.

Run: `cd web && pnpm exec vitest run src/app/core/time-calculations.spec.ts src/app/shared/worktime-review-modal.component.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit the domain extraction**

```bash
git add backend/pb_hooks/work_event_domain.js \
  backend/pb_hooks/work_event_domain.test.js backend/pb_hooks/main.pb.js \
  backend/pb_hooks/timesheet_helpers.js
git commit -m "refactor: share authoritative work event rules"
```

### Task 3: Add terminal administration and PIN authorization

**Files:**
- Create: `backend/pb_hooks/terminal_helpers.js`
- Create: `backend/pb_hooks/terminal.pb.js`
- Create: `backend/pb_hooks/terminal_helpers.test.js`

**Interfaces:**
- Produces web routes under `/api/openjornada/terminals`, employee RFID routes,
  `authenticateTerminal(e)`, and `requireTerminalAdminSession(e, terminal)`.
- Produces bearer tokens `ojterm_<12-char-prefix>_<random-secret>` and opaque
  five-minute admin sessions.

- [ ] **Step 1: Write failing pure helper tests**

Test token parsing without echoing the secret, four-digit PIN validation, and
the delay function:

```javascript
assert.equal(pinDelaySeconds(1), 0)
assert.equal(pinDelaySeconds(2), 0)
assert.equal(pinDelaySeconds(3), 180)
assert.equal(pinDelaySeconds(4), 360)
assert.equal(pinDelaySeconds(12), 1800)
assert.equal(pinDelaySeconds(99), 1800)
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run: `node --test backend/pb_hooks/terminal_helpers.test.js`
Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement terminal key helpers**

Generate the prefix and secret with `$security.randomString`, store only the
SHA-256 token hash for bearer authentication, and encrypt the derived HMAC
material with the configured PocketBase encryption key. Return the complete
key only from create and rotate responses.

Reject missing, malformed, unknown and revoked keys with the same generic
authentication response. Update `lastSeenAt` without logging headers.

- [ ] **Step 4: Implement admin-only terminal routes**

Add list, create, rename, rotate and revoke handlers. Enforce `admin` for all
mutations and organization filtering for every lookup. Return
`pendingQueueWarning: true` when the last reported pending count is non-zero.

- [ ] **Step 5: Implement organization PIN routes and sessions**

Store a password hash, require exactly `/^\d{4}$/`, invalidate all existing
sessions when it changes, and reset attempt records.

`POST /terminal/v1/admin-sessions` takes `{ pin: string }`. On success it
returns `{ token, idleExpiresAt }`; each protected use advances `lastUsedAt`.
`DELETE /admin-sessions/current` revokes it. Apply both per-terminal and
organization-wide progressive delays.

Device authentication uses
`Authorization: Bearer ojterm_<prefix>_<secret>`. Protected local-admin routes
add `X-Terminal-Admin-Session: <opaque-token>`; the admin session never replaces
the bearer key.

- [ ] **Step 6: Implement protected employee RFID routes**

Web routes accept `{ uid, replace: boolean }`; device routes also require an
admin session. Normalize the reader UID, calculate a keyed fingerprint, encrypt
the normalized UID, enforce active same-organization employee and unique UID,
and increment the organization cache revision transactionally.

Return `replacement_required` if an assignment exists and `replace` is false.
Delete clears both protected fields. Do not create a separate assignment
history or include UID values in audit metadata.

- [ ] **Step 7: Run helper tests and smoke-load hooks**

Run: `node --test backend/pb_hooks/terminal_helpers.test.js`
Expected: PASS.

Run: `docker build -t openjornada-rfid-hooks .`
Expected: image builds and PocketBase loads the migration and hooks.

- [ ] **Step 8: Commit terminal administration**

```bash
git add backend/pb_hooks/terminal_helpers.js \
  backend/pb_hooks/terminal_helpers.test.js backend/pb_hooks/terminal.pb.js
git commit -m "feat: add RFID terminal administration API"
```

### Task 4: Implement online resolve and action commands

**Files:**
- Modify: `backend/pb_hooks/terminal.pb.js`
- Modify: `backend/pb_hooks/terminal_helpers.js`
- Test: `web/e2e/rfid-terminal-api.spec.ts`

**Interfaces:**
- Produces `/terminal/v1/bootstrap`, `/resolve`, `/actions`, and `/cache`.
- Consumes the shared domain functions from Task 2 and terminal auth from Task 3.

- [ ] **Step 1: Write failing API E2E cases**

Create one organization, two terminals and two employees. Assert:

- bootstrap reports protocol min/max `1`, server time, timezone, 24-hour clock
  trust, 10.000 queue limit and current cache revision;
- an unknown UID returns `unknown_tag` without employee data;
- a known UID returns only first name plus surname initial;
- a scan context expires after ten seconds;
- a context cannot be used for another tag, terminal or organization;
- duplicate client request IDs return the original response.

- [ ] **Step 2: Run the API spec and verify it fails**

Run: `cd web && pnpm exec playwright test e2e/rfid-terminal-api.spec.ts`
Expected: FAIL with missing terminal v1 routes.

- [ ] **Step 3: Implement bootstrap and minimal cache**

Bootstrap rejects protocol versions outside v1 with
`protocol_incompatible`. Cache responses include only employee ID, abbreviated
display name, encrypted UID lookup material, state revision and active flag.
Never include email, employee code, role or full profile data.

- [ ] **Step 4: Implement resolve**

Resolve UID server-side, require an active same-organization employee, compute
the current effective state and return actions in this exact order:

```text
idle:                 clock_in
working < 4h:         break_start, clock_out
working >= 4h:        break_start, clock_out, adjusted clock_out
on_break <= 25m:      break_end, close-from-break
on_break > 25m:       break_end, highlighted close-from-break
```

Represent `close-from-break` as UI guidance; it still emits `break_end` and,
only after a positive answer, a separate `clock_out`.

- [ ] **Step 5: Implement transactional actions**

Within one transaction, authenticate, consume/validate scan context, check or
create the receipt, re-read current state, prepare the event through the shared
domain helper, save it, create its existing immutable audit and finalize the
receipt.

For a terminal `appliedAt` earlier than capture, set the automatic reason
`Olvido de cierre corregido desde terminal RFID`. Require `appliedAt` between
the latest event and device capture time.

- [ ] **Step 6: Run API E2E and current clocking E2E**

Run: `cd web && pnpm exec playwright test e2e/rfid-terminal-api.spec.ts e2e/clocking.spec.ts`
Expected: PASS, including existing SPA clocking.

- [ ] **Step 7: Commit online commands**

```bash
git add backend/pb_hooks/terminal.pb.js backend/pb_hooks/terminal_helpers.js \
  web/e2e/rfid-terminal-api.spec.ts
git commit -m "feat: add online RFID clocking commands"
```

### Task 5: Reconcile signed offline queues and incidents

**Files:**
- Modify: `backend/pb_hooks/terminal.pb.js`
- Modify: `backend/pb_hooks/terminal_helpers.js`
- Test: `web/e2e/rfid-terminal-offline.spec.ts`

**Interfaces:**
- Produces `/terminal/v1/sync`, `/api/openjornada/terminal-incidents`, and
  `/terminal-incidents/{id}/resolve`.
- Consumes canonical `TerminalQueuedAction` payloads signed with HMAC-SHA256.

- [ ] **Step 1: Write failing offline reconciliation E2E cases**

Cover valid chronological batch, duplicate batch, broken signature, future
clock, NTP age greater than 24 hours, reboot without fresh NTP, two-terminal
state conflict, revoked UID and revoked terminal.

Assert an invalid sequence creates exactly one incident after retries and never
creates a partial `work_event` for that action.

- [ ] **Step 2: Run the offline spec and verify it fails**

Run: `cd web && pnpm exec playwright test e2e/rfid-terminal-offline.spec.ts`
Expected: FAIL with missing sync and incident routes.

- [ ] **Step 3: Implement canonical signatures**

Canonicalize UTF-8 JSON with fixed field order:

```text
terminalId|clientRequestId|uid|command|deviceCapturedAt|appliedAt|
clockSyncedAt|deviceSequence|previousLocalHash
```

Use constant-time HMAC comparison. Reject the entire malformed envelope, but
return per-action results for a valid envelope.

- [ ] **Step 4: Implement ordered batch reconciliation**

Sort by `deviceCapturedAt`, then `deviceSequence`, preserving original response
indices. For each item, use a separate transaction and receipt so one incident
does not prevent later independently valid employees from syncing.

Return a final authoritative state per affected employee. The device may delete
only `accepted`, `duplicate`, or `incident` entries.

- [ ] **Step 5: Implement incident lifecycle**

Create incidents for sequence conflict, revoked UID and irreconcilable clock
evidence. List only same-organization incidents for admin/manager. Resolution
requires the jornada to have been corrected through the existing flow and a
non-empty note of at least eight characters; it records resolver and time but
does not materialize a hidden event.

Notify active admin/manager users through the existing notifications
collection without including UID or token data.

- [ ] **Step 6: Run offline and manual-timesheet E2E**

Run: `cd web && pnpm exec playwright test e2e/rfid-terminal-offline.spec.ts e2e/manual-timesheet.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit offline reconciliation**

```bash
git add backend/pb_hooks/terminal.pb.js backend/pb_hooks/terminal_helpers.js \
  web/e2e/rfid-terminal-offline.spec.ts
git commit -m "feat: reconcile offline RFID clocking"
```

### Task 6: Add terminal, tag and incident administration UI

**Files:**
- Create: `web/src/app/core/terminal.service.ts`
- Create: `web/src/app/core/terminal.service.spec.ts`
- Modify: `web/src/app/features/integrations/integrations.component.ts`
- Modify: `web/src/app/features/integrations/integrations.component.html`
- Modify: `web/src/app/features/team/team.component.ts`
- Modify: `web/src/app/features/team/team.component.html`
- Modify: `web/src/app/features/records/records.component.ts`
- Modify: `web/src/app/features/records/records.component.html`

**Interfaces:**
- Produces typed SPA methods for all web-authenticated terminal routes.
- Consumes Task 1 models and Task 3/5 APIs.

- [ ] **Step 1: Write failing service tests**

Mock `PocketBaseService.client.send` and assert exact methods, paths and bodies
for create, rename, rotate, revoke, PIN change, RFID replace/revoke, incident
list and incident resolution. Verify server error codes map to Spanish messages.

- [ ] **Step 2: Run the service test and verify it fails**

Run: `cd web && pnpm exec vitest run src/app/core/terminal.service.spec.ts`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the typed service**

Keep token values in the component signal only; never persist them to
localStorage. Clear the generated key when dismissed or leaving the component.

- [ ] **Step 4: Add Terminales RFID to Integraciones**

Preserve the existing MCP section. Add an accessible tab or section showing
terminal name, status, protocol/client version, last connection and pending
count. Provide create, rename, rotate and revoke confirmation dialogs. Show the
new key once with copy and dismiss actions. Warn explicitly about pending
offline data before destructive credential changes.

Only admin sees key and PIN controls. Manager may still navigate to
Integraciones for other permitted content but cannot call protected mutations.

- [ ] **Step 5: Add RFID controls to Equipo**

Show `Tag asignado` or `Sin tag` without UID. Admin/manager can open a dialog,
enter a UID for web-assisted testing, confirm replacement and revoke. Preserve
all current invitation, employment and permission behavior.

- [ ] **Step 6: Add Incidencias RFID to Control horario**

Show pending count, person, date, terminal and reason. The primary action opens
the existing employee/day timesheet. After correction, a resolution dialog
requires an eight-character note and refreshes the list.

- [ ] **Step 7: Run unit tests and build**

Run: `cd web && pnpm run test:ci`
Expected: PASS.

Run: `cd web && pnpm run build`
Expected: PASS with lazy routes and production templates compiled.

- [ ] **Step 8: Commit the administration UI**

```bash
git add web/src/app/core/terminal.service.ts \
  web/src/app/core/terminal.service.spec.ts \
  web/src/app/features/integrations/integrations.component.ts \
  web/src/app/features/integrations/integrations.component.html \
  web/src/app/features/team/team.component.ts \
  web/src/app/features/team/team.component.html \
  web/src/app/features/records/records.component.ts \
  web/src/app/features/records/records.component.html
git commit -m "feat: manage RFID terminals and incidents"
```

### Task 7: Build the development-only M5Stack simulator

**Files:**
- Create: `web/src/app/features/terminal-simulator/terminal-simulator.component.ts`
- Create: `web/src/app/features/terminal-simulator/terminal-simulator.component.html`
- Create: `web/src/app/features/terminal-simulator/terminal-simulator.state.ts`
- Create: `web/src/app/features/terminal-simulator/terminal-simulator.state.spec.ts`
- Modify: `web/src/app/app.routes.ts`

**Interfaces:**
- Produces a localhost/development-only `/terminal-simulator` route.
- Consumes the v1 device API and reproduces the future firmware state machine.

- [ ] **Step 1: Write failing simulator-state tests**

Test exact screen durations, button mappings, PIN digits, action countdown,
five-minute admin inactivity, time-picker bounds, held-button acceleration,
midnight date display, local state advancement, 10.000-item full queue, reboot
clock invalidation and 24-hour NTP expiry.

- [ ] **Step 2: Run the simulator test and verify it fails**

Run: `cd web && pnpm exec vitest run src/app/features/terminal-simulator/terminal-simulator.state.spec.ts`
Expected: FAIL because the simulator state module does not exist.

- [ ] **Step 3: Implement the pure simulator state machine**

Model screens as a discriminated union and expose only three input methods:

```typescript
press(button: 'A' | 'B' | 'C'): void;
hold(buttons: readonly ('A' | 'B' | 'C')[], milliseconds: number): void;
scan(uid: string): Promise<void>;
```

Use the approved A/B/C mappings and automatic return timers. Require A+C for
three seconds before the PIN screen.

- [ ] **Step 4: Implement the 320×240 visual simulator**

Render a fixed-aspect device screen, physical button labels, UID input, network
toggle, advance-time control, reboot control, NTP status, queue counter and a
debug drawer for request/result inspection. All user-facing device copy is
Spanish and does not rely on color alone.

Use Web Crypto for AES-GCM/HMAC behavior and IndexedDB as the browser analogue
of future SQLite. Keep API key and decrypted cache material in session memory.

- [ ] **Step 5: Make the route unreachable in production**

Register the lazy route only when Angular `isDevMode()` is true and add a
`canMatch` guard that redirects if a production build somehow contains the
chunk. Do not add a production sidebar link.

- [ ] **Step 6: Run simulator tests and production build**

Run: `cd web && pnpm exec vitest run src/app/features/terminal-simulator/terminal-simulator.state.spec.ts`
Expected: PASS.

Run: `cd web && pnpm run build`
Expected: PASS and `/terminal-simulator` is not reachable in production mode.

- [ ] **Step 7: Commit the simulator**

```bash
git add web/src/app/features/terminal-simulator web/src/app/app.routes.ts
git commit -m "feat: add M5Stack RFID terminal simulator"
```

### Task 8: Complete end-to-end acceptance, documentation and release hygiene

**Files:**
- Create: `web/e2e/rfid-terminal-ui.spec.ts`
- Modify: `README.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/COMPLIANCE_ES.md`
- Modify: `web/README.md`

**Interfaces:**
- Verifies the complete approved design and documents the stable v1 contract.

- [ ] **Step 1: Write the complete UI acceptance test**

Cover:

1. Admin creates a terminal and sees/copies its key once.
2. Admin changes the company PIN.
3. Manager assigns and replaces an employee tag.
4. Simulator clocks in, pauses, ends pause and clocks out.
5. A four-hour open shift exposes `Ya terminé antes`.
6. A 25-minute pause highlights recovery.
7. The paused close flow records `break_end`, asks Sí/No, and closes only on
   Sí.
8. Offline actions remain queued, sync once and never duplicate.
9. A cross-terminal conflict appears as an incident.
10. Manager corrects the day and resolves the incident with a note.

- [ ] **Step 2: Run the acceptance test and fix only contract mismatches**

Run: `cd web && pnpm exec playwright test e2e/rfid-terminal-ui.spec.ts`
Expected: PASS.

- [ ] **Step 3: Update documentation**

Document terminal creation, one-time keys, PIN behavior, UID cloning warning,
online/offline evidence, simulator usage and the fact that no tag memory is
written. State explicitly that RFID identification and acknowledgements are
not advanced or qualified electronic signatures.

- [ ] **Step 4: Run all required verification**

```bash
cd web
pnpm run build
pnpm run test:ci
pnpm run e2e
pnpm audit --prod
cd ..
docker compose -f docker-compose.production.yml config --quiet
docker build -t openjornada .
git diff --check
```

Expected: every command succeeds; audit findings, if any, are reported rather
than hidden or bypassed.

- [ ] **Step 5: Review security and compatibility manually**

Confirm no response or log contains raw UID, PIN, API key, signing material,
email or document data. Confirm every terminal, employee, receipt and incident
lookup includes organization scope. Confirm current SPA clocking, corrections,
monthly statements and immutable audits still work.

- [ ] **Step 6: Review the complete diff and commit documentation/E2E**

```bash
git status --short
git diff --check
git diff -- backend web/src web/e2e README.md docs web/README.md
git add web/e2e/rfid-terminal-ui.spec.ts README.md docs/FEATURES.md \
  docs/COMPLIANCE_ES.md web/README.md
git commit -m "docs: document RFID terminal operations"
```

- [ ] **Step 7: Request code review before merge**

Invoke the repository `requesting-code-review` skill, address verified findings,
rerun affected checks, and only then push the focused branch. Do not stage the
pre-existing skill, lockfile or package-manager changes unless a later user
explicitly brings them into scope.
