# Business Source Licensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** License OpenJornada under BSL 1.1 with free production use for groups of at most ten workers, document the commercial path, and show a non-blocking warning to administrators and managers when the UI detects eleven active accounts.

**Architecture:** Legal terms live in canonical root documents and remain independent from application enforcement. Angular gets a small pure licensing domain module plus a standalone presentational component; Team and Settings provide their existing member data to it without adding backend fields, routes, telemetry, or license keys.

**Tech Stack:** Business Source License 1.1, Markdown, Angular 22 standalone components and signals, Tailwind CSS 4, Vitest through Angular CLI, Playwright, PocketBase SDK.

**Spec:** `docs/superpowers/specs/2026-08-24-business-source-license-design.md`

## Global Constraints

- Licensor and copyright holder: `Rubén Cid Lara`.
- Commercial contact: `rubencidlara@gmail.com`.
- Free production use applies only when the licensee and all entities under common control collectively have at most ten workers.
- Control means the direct or indirect power to direct an entity's management or policies through ownership, voting rights, contract, or another arrangement.
- A worker is every employee or independent contractor serving any entity in that group, whether or not they have an OpenJornada account.
- Eleven or more workers require a commercial license or prior written permission.
- Initial Change Date: `2030-08-24`; Change License: `AGPL-3.0-or-later`.
- Preserve the official BSL 1.1 body verbatim; customization is limited to its declared parameters and Additional Use Grant.
- The software must be described as source-available, not open source, before the Change Date.
- The UI warning is informational only: no blocked accounts, features, requests, or self-hosted deployments.
- Do not add migrations, endpoints, telemetry, external dependencies, license keys, pricing, or a commercial contract.
- Preserve every third-party license and notice, including `firmware/terminal/LICENSES/`.
- Do not read, print, modify, or stage `.env`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `LICENSE` | Canonical BSL 1.1 parameters and unmodified standard terms. |
| `NOTICE` | OpenJornada copyright scope and third-party-license exception. |
| `COMMERCIAL-LICENSE.md` | Plain-Spanish operational explanation and commercial contact. |
| `CONTRIBUTING.md` | Contribution policy requiring an accepted relicensing CLA before merge. |
| `README.md` | Public licensing summary and links to canonical terms. |
| `docs/DEPLOYMENT.md` | Release checklist for each version's BSL Change Date. |
| `docs/FEATURES.md` | Product behavior of the informational warning. |
| `web/package.json` | SPDX package metadata (`BUSL-1.1`). |
| `web/README.md` | Frontend-specific licensing-warning behavior and its non-enforcement boundary. |
| `web/src/app/core/licensing.ts` | Pure threshold constants and active-account count functions. |
| `web/src/app/core/licensing.spec.ts` | Boundary and inactive-account unit tests. |
| `web/src/app/shared/commercial-license-notice.component.ts` | Shared standalone, accessible, non-blocking warning. |
| `web/src/app/shared/commercial-license-notice.component.spec.ts` | Component visibility, copy, count and mail-link tests. |
| `web/src/app/features/team/team.component.ts` | Supplies live active-account count and management permission. |
| `web/src/app/features/team/team.component.html` | Places the warning after page feedback. |
| `web/src/app/features/settings/settings.component.ts` | Loads `active`, computes count and supplies admin permission. |
| `web/src/app/features/settings/settings.component.html` | Places the warning before the settings form. |
| `web/e2e/licensing.spec.ts` | Browser acceptance for the admin warning and employee guard. |

---

### Task 1: Add the canonical licensing and contribution documents

**Files:**
- Create: `LICENSE`
- Create: `NOTICE`
- Create: `COMMERCIAL-LICENSE.md`
- Create: `CONTRIBUTING.md`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `web/package.json`

**Interfaces:**
- Consumes: the approved parameters in `docs/superpowers/specs/2026-08-24-business-source-license-design.md`.
- Produces: canonical `BUSL-1.1` terms, a commercial-contact path, contribution rules, and package metadata used by all later tasks.

- [ ] **Step 1: Verify the current unlicensed baseline and third-party notices**

Run from the repository root:

```bash
test ! -e LICENSE
rg -n 'todavía no incluye un archivo `LICENSE`' README.md
find firmware/terminal/LICENSES -maxdepth 2 -type f -print | sort
node -e "const p=require('./web/package.json'); if (p.license) process.exit(1)"
```

Expected: every command succeeds; no root license or package license is currently declared, and the firmware third-party notices are listed for preservation.

- [ ] **Step 2: Create `LICENSE` with the approved BSL parameters**

Place this parameter block before the canonical, verbatim BSL 1.1 body obtained from `https://mariadb.com/bsl11/`:

```text
Business Source License 1.1

Parameters

Licensor: Rubén Cid Lara

Licensed Work: OpenJornada. Third-party components remain subject to their
respective licenses and are not relicensed under these terms.

Additional Use Grant: You may make Production Use of the Licensed Work if you
and all entities that control, are controlled by, or are under common control
with you collectively have no more than ten (10) Workers. A "Worker" is each
employee and independent contractor who provides services to any such entity,
whether or not that person has an account in the Licensed Work. Any other
Production Use requires a commercial license or prior written permission from
the Licensor. "Control" means the direct or indirect power to direct an
entity's management or policies through ownership, voting rights, contract, or
another arrangement. Contact: rubencidlara@gmail.com.

Change Date: 2030-08-24

Change License: GNU Affero General Public License version 3 or any later
version (AGPL-3.0-or-later)
```

Append the standard text beginning with `Terms` and ending with covenant 4,
without translating, deleting, or rewriting any sentence. Retain MariaDB's
license-text copyright and Business Source License trademark notice.

- [ ] **Step 3: Create the copyright and third-party notice**

Create `NOTICE` with exactly this project-level scope:

```text
OpenJornada
Copyright (C) 2026 Rubén Cid Lara

OpenJornada is licensed under the Business Source License 1.1 as described in
LICENSE. Components and dependencies identified as third-party software remain
subject to their own license terms. In particular, notices shipped under
firmware/terminal/LICENSES/ are not replaced or modified by the OpenJornada
license.
```

- [ ] **Step 4: Create the commercial-use explanation**

Create `COMMERCIAL-LICENSE.md` in Spanish with these exact sections and rules:

```markdown
# Licencias de OpenJornada

OpenJornada está disponible bajo Business Source License 1.1. No es software
open source antes de su fecha de cambio.

## Uso productivo gratuito

Una persona, empresa o grupo bajo control común puede usar OpenJornada gratis
en producción cuando, en conjunto, tenga como máximo diez trabajadores. Se
cuentan empleados y contratistas, aunque no tengan cuenta en OpenJornada.

## Cuándo necesitas una licencia comercial

Con once o más trabajadores necesitas una licencia comercial o permiso previo
por escrito. OpenJornada no bloquea técnicamente la aplicación al alcanzar el
límite; el cumplimiento es responsabilidad del licenciatario.

Ejemplos:

- Ocho empleados y dos contratistas: uso productivo gratuito.
- Nueve empleados y dos contratistas: requiere licencia o permiso.
- Una matriz con seis trabajadores y una filial con cinco: requiere licencia o
  permiso porque el grupo suma once.
- Cinco cuentas activas en una empresa de cincuenta trabajadores: requiere
  licencia; el número de cuentas de la aplicación no sustituye el criterio
  contractual.

## Solicitar licencia o permiso

Escribe a [rubencidlara@gmail.com](mailto:rubencidlara@gmail.com?subject=Licencia%20comercial%20de%20OpenJornada).
Este documento explica el modelo, pero no es un contrato comercial ni sustituye
las condiciones que se acuerden por escrito.

## Conversión futura a open source

Cada versión pasa a AGPL-3.0-or-later en su fecha de cambio indicada en
`LICENSE`, o antes si así lo exige BSL 1.1.
```

- [ ] **Step 5: Create the contribution policy**

Create `CONTRIBUTING.md` with an explicit no-merge boundary:

```markdown
# Contribuir a OpenJornada

Puedes abrir incidencias para informar de errores y proponer mejoras.

OpenJornada se ofrece bajo BSL 1.1 y licencias comerciales separadas. Para
preservar esa capacidad de licencia dual, no se fusionará ninguna contribución
con contenido sujeto a copyright —código, documentación, diseños o pruebas—
hasta que su autor haya aceptado expresamente un Contributor License Agreement
(CLA) que permita su uso y relicenciamiento.

El proyecto todavía no dispone de aceptación automatizada del CLA. Antes de
preparar un pull request con cambios, contacta con
[rubencidlara@gmail.com](mailto:rubencidlara@gmail.com?subject=CLA%20de%20OpenJornada).
Una confirmación en un issue, un DCO o la mera apertura del pull request no
sustituyen el CLA aceptado.

Para trabajar en el repositorio, sigue además las instrucciones de `AGENTS.md`.
Nunca incluyas secretos, `.env`, datos de producción ni artefactos generados.
```

- [ ] **Step 6: Replace the README's unlicensed warning and declare package metadata**

Replace the final README paragraph that says no `LICENSE` exists with a
`## Licencia` section that links to `LICENSE` and `COMMERCIAL-LICENSE.md`, uses
the phrase `software con código disponible`, states the ten-worker group rule,
states the eleven-worker commercial rule, names the 2030-08-24 AGPL change, and
links the contact address. State that the terms apply to revisions and releases
that include `LICENSE`, without rewriting historical tags. Do not call the
current release open source.

Add this top-level property to `web/package.json` next to `version`:

```json
"license": "BUSL-1.1"
```

- [ ] **Step 7: Add the release-date check to deployment documentation**

In `docs/DEPLOYMENT.md`, immediately before the existing release/tag process,
add this mandatory checklist:

```markdown
Antes de publicar cada versión:

1. fija en `LICENSE` una `Change Date` que no supere cuatro años desde la fecha
   de publicación de esa versión;
2. conserva `AGPL-3.0-or-later` como `Change License`, salvo una decisión legal
   documentada compatible con las condiciones de BSL 1.1;
3. verifica que la etiqueta publicada contiene `LICENSE`, `NOTICE` y los avisos
   de terceros.
```

- [ ] **Step 8: Verify exact legal markers and preserved notices**

Run:

```bash
rg -n "Business Source License 1.1|Rubén Cid Lara|Additional Use Grant|2030-08-24|AGPL-3.0-or-later" LICENSE
rg -n "Copyright \(C\) 2026 Rubén Cid Lara|firmware/terminal/LICENSES" NOTICE
rg -n "máximo diez|once o más|rubencidlara@gmail.com" COMMERCIAL-LICENSE.md
rg -n "CLA|no se fusionará|relicenciamiento" CONTRIBUTING.md
node -e "const p=require('./web/package.json'); if(p.license!=='BUSL-1.1') process.exit(1)"
test -d firmware/terminal/LICENSES
git diff --check
```

Expected: all required markers are found, metadata matches, third-party notices
still exist, and the diff has no whitespace errors.

- [ ] **Step 9: Commit the licensing foundation**

```bash
git add LICENSE NOTICE COMMERCIAL-LICENSE.md CONTRIBUTING.md README.md docs/DEPLOYMENT.md web/package.json
git commit -m "docs: license OpenJornada under BSL 1.1"
```

---

### Task 2: Add the tested licensing threshold domain

**Files:**
- Create: `web/src/app/core/licensing.ts`
- Create: `web/src/app/core/licensing.spec.ts`

**Interfaces:**
- Consumes: `UserRecord.active` from `web/src/app/core/models.ts`.
- Produces: `COMMUNITY_LICENSE_MAX_WORKERS: 10`, `COMMERCIAL_LICENSE_EMAIL`, `activeLicenseAccountCount(members): number`, and `requiresCommercialLicenseNotice(members): boolean`.

- [ ] **Step 1: Write the failing threshold tests**

Create `web/src/app/core/licensing.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  activeLicenseAccountCount,
  COMMUNITY_LICENSE_MAX_WORKERS,
  requiresCommercialLicenseNotice,
} from './licensing';

const accounts = (active: number, inactive = 0) => [
  ...Array.from({ length: active }, () => ({ active: true })),
  ...Array.from({ length: inactive }, () => ({ active: false })),
];

describe('commercial licensing threshold', () => {
  it('keeps zero and ten active accounts below the warning threshold', () => {
    expect(COMMUNITY_LICENSE_MAX_WORKERS).toBe(10);
    expect(activeLicenseAccountCount(accounts(0))).toBe(0);
    expect(requiresCommercialLicenseNotice(accounts(10))).toBe(false);
  });

  it('shows the warning from eleven active accounts', () => {
    expect(activeLicenseAccountCount(accounts(11))).toBe(11);
    expect(requiresCommercialLicenseNotice(accounts(11))).toBe(true);
  });

  it('does not count inactive accounts', () => {
    expect(activeLicenseAccountCount(accounts(10, 5))).toBe(10);
    expect(requiresCommercialLicenseNotice(accounts(10, 5))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the unit test and verify the missing module failure**

Run:

```bash
cd web
pnpm exec ng test --watch=false --include src/app/core/licensing.spec.ts
```

Expected: FAIL because `./licensing` does not exist.

- [ ] **Step 3: Implement the pure threshold module**

Create `web/src/app/core/licensing.ts`:

```typescript
import type { UserRecord } from './models';

export const COMMUNITY_LICENSE_MAX_WORKERS = 10;
export const COMMERCIAL_LICENSE_EMAIL = 'rubencidlara@gmail.com';

type LicenseAccount = Pick<UserRecord, 'active'>;

export function activeLicenseAccountCount(members: readonly LicenseAccount[]): number {
  return members.filter((member) => member.active).length;
}

export function requiresCommercialLicenseNotice(
  members: readonly LicenseAccount[],
): boolean {
  return activeLicenseAccountCount(members) > COMMUNITY_LICENSE_MAX_WORKERS;
}
```

- [ ] **Step 4: Run the focused unit test**

```bash
cd web
pnpm exec ng test --watch=false --include src/app/core/licensing.spec.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the domain boundary**

```bash
git add web/src/app/core/licensing.ts web/src/app/core/licensing.spec.ts
git commit -m "feat: calculate commercial license threshold"
```

---

### Task 3: Build the accessible shared warning component

**Files:**
- Create: `web/src/app/shared/commercial-license-notice.component.ts`
- Create: `web/src/app/shared/commercial-license-notice.component.spec.ts`

**Interfaces:**
- Consumes: `COMMERCIAL_LICENSE_EMAIL` and `COMMUNITY_LICENSE_MAX_WORKERS` from Task 2; required signal inputs `activeAccounts: number` and `canManage: boolean`.
- Produces: selector `app-commercial-license-notice` and test id `commercial-license-notice`.

- [ ] **Step 1: Write failing component tests**

Create `web/src/app/shared/commercial-license-notice.component.spec.ts`:

```typescript
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CommercialLicenseNoticeComponent } from './commercial-license-notice.component';

describe('CommercialLicenseNoticeComponent', () => {
  let fixture: ComponentFixture<CommercialLicenseNoticeComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CommercialLicenseNoticeComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CommercialLicenseNoticeComponent);
  });

  function render(activeAccounts: number, canManage: boolean): HTMLElement {
    fixture.componentRef.setInput('activeAccounts', activeAccounts);
    fixture.componentRef.setInput('canManage', canManage);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('stays hidden at ten active accounts', () => {
    expect(render(10, true).querySelector('[data-testid="commercial-license-notice"]')).toBeNull();
  });

  it('stays hidden from a non-manager', () => {
    expect(render(11, false).querySelector('[data-testid="commercial-license-notice"]')).toBeNull();
  });

  it('explains the detected count and commercial path to a manager', () => {
    const element = render(11, true);
    const notice = element.querySelector<HTMLElement>('[data-testid="commercial-license-notice"]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('11 cuentas activas');
    expect(notice?.textContent).toContain('empleados y contratistas');
    expect(notice?.textContent).toContain('no estén dados de alta');
    expect(notice?.querySelector<HTMLAnchorElement>('a')?.href).toContain(
      'mailto:rubencidlara@gmail.com?subject=Licencia%20comercial%20de%20OpenJornada',
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the missing component failure**

```bash
cd web
pnpm exec ng test --watch=false --include src/app/shared/commercial-license-notice.component.spec.ts
```

Expected: FAIL because the component module does not exist.

- [ ] **Step 3: Implement the standalone component**

Create `web/src/app/shared/commercial-license-notice.component.ts`:

```typescript
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  COMMERCIAL_LICENSE_EMAIL,
  COMMUNITY_LICENSE_MAX_WORKERS,
} from '../core/licensing';

@Component({
  selector: 'app-commercial-license-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <section
        data-testid="commercial-license-notice"
        role="status"
        aria-labelledby="commercial-license-title"
        class="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950"
      >
        <h2 id="commercial-license-title" class="font-display text-lg font-bold">
          Revisa la licencia de uso
        </h2>
        <p class="mt-1 text-sm leading-6">
          Detectamos {{ activeAccounts() }} cuentas activas. El uso productivo gratuito cubre
          grupos de hasta {{ freeLimit }} trabajadores. La licencia cuenta empleados y
          contratistas de todo el grupo, aunque no estén dados de alta en OpenJornada.
        </p>
        <a
          class="mt-3 inline-flex font-bold text-amber-900 underline underline-offset-4"
          [href]="contactHref"
        >
          Solicitar licencia comercial o permiso
        </a>
      </section>
    }
  `,
})
export class CommercialLicenseNoticeComponent {
  readonly activeAccounts = input.required<number>();
  readonly canManage = input.required<boolean>();
  protected readonly freeLimit = COMMUNITY_LICENSE_MAX_WORKERS;
  protected readonly contactHref =
    `mailto:${COMMERCIAL_LICENSE_EMAIL}?subject=Licencia%20comercial%20de%20OpenJornada`;
  protected readonly visible = computed(
    () => this.canManage() && this.activeAccounts() > COMMUNITY_LICENSE_MAX_WORKERS,
  );
}
```

- [ ] **Step 4: Run the component and domain tests**

```bash
cd web
pnpm exec ng test --watch=false \
  --include src/app/core/licensing.spec.ts \
  --include src/app/shared/commercial-license-notice.component.spec.ts
```

Expected: 6 tests pass and Angular reports no required-input or template errors.

- [ ] **Step 5: Commit the shared UI unit**

```bash
git add web/src/app/shared/commercial-license-notice.component.ts web/src/app/shared/commercial-license-notice.component.spec.ts
git commit -m "feat: add commercial license notice"
```

---

### Task 4: Integrate the warning into Team and Settings

**Files:**
- Modify: `web/src/app/features/team/team.component.ts`
- Modify: `web/src/app/features/team/team.component.html`
- Modify: `web/src/app/features/settings/settings.component.ts`
- Modify: `web/src/app/features/settings/settings.component.html`
- Modify: `docs/FEATURES.md`
- Modify: `web/README.md`

**Interfaces:**
- Consumes: `activeLicenseAccountCount()` and `CommercialLicenseNoticeComponent` from Tasks 2 and 3; `AuthService.canManageTeam()` already returns true for `admin` and `manager`.
- Produces: a live warning in Team for admin/manager and in Settings for its authorized admin, driven only by the existing `members` signals.

- [ ] **Step 1: Add compile-time references before imports to establish the failing state**

In both page templates, directly after the existing error/success feedback,
temporarily add:

```html
<app-commercial-license-notice
  [activeAccounts]="activeLicenseAccounts()"
  [canManage]="auth.canManageTeam()"
/>
```

Run:

```bash
cd web
pnpm run build
```

Expected: FAIL because neither page imports the component or exposes
`activeLicenseAccounts`; Settings also keeps `auth` private.

- [ ] **Step 2: Wire Team to the shared component**

In `team.component.ts`:

```typescript
import { Component, computed, inject, signal } from '@angular/core';
import { activeLicenseAccountCount } from '../../core/licensing';
import { CommercialLicenseNoticeComponent } from '../../shared/commercial-license-notice.component';
```

Add `CommercialLicenseNoticeComponent` to the component `imports`, and add:

```typescript
protected readonly activeLicenseAccounts = computed(() =>
  activeLicenseAccountCount(this.members()),
);
```

Keep the template element after success/error feedback so creation,
activation and deactivation updates are reflected immediately by the existing
`members` signal.

- [ ] **Step 3: Wire Settings and request the `active` field**

In `settings.component.ts`, import `computed`, the domain function and shared
component exactly as in Team. Change:

```typescript
private readonly auth = inject(AuthService);
```

to:

```typescript
protected readonly auth = inject(AuthService);
```

Add `CommercialLicenseNoticeComponent` to `imports`, add the same
`activeLicenseAccounts` computed signal, and change the user field selection
inside `load()` to:

```typescript
fields: 'id,name,employeeCode,active',
```

Keep the Settings template element after feedback and before the loading/form
branches. The existing `adminGuard` remains unchanged; managers receive the
same notice through Team, whose route uses `teamManagerGuard`.

- [ ] **Step 4: Document the exact informational behavior**

Add to `docs/FEATURES.md`:

```markdown
Administración y responsables reciben en Equipo —y administración también en
Ajustes— un aviso no bloqueante cuando OpenJornada detecta once o más cuentas
activas. El aviso no valida el tamaño legal del grupo: recuerda que BSL cuenta
también empleados y contratistas no registrados y enlaza la solicitud de una
licencia comercial o permiso escrito. No se envía telemetría ni se limita
ninguna función.
```

Add a `Licencia y aviso de uso comercial` subsection to `web/README.md` that
names `CommercialLicenseNoticeComponent`, states the eleven-active-account UI
trigger, explains that only management roles see it, and explicitly says the
frontend does not enforce, report, or persist licensing status.

- [ ] **Step 5: Run focused tests and build**

```bash
cd web
pnpm exec ng test --watch=false \
  --include src/app/core/licensing.spec.ts \
  --include src/app/shared/commercial-license-notice.component.spec.ts
pnpm run build
```

Expected: 6 focused tests pass and the production Angular build succeeds.

- [ ] **Step 6: Commit page integration and feature documentation**

```bash
git add web/src/app/features/team/team.component.ts \
  web/src/app/features/team/team.component.html \
  web/src/app/features/settings/settings.component.ts \
  web/src/app/features/settings/settings.component.html \
  docs/FEATURES.md web/README.md
git commit -m "feat: warn teams above the free license threshold"
```

---

### Task 5: Add browser acceptance for visibility and permissions

**Files:**
- Create: `web/e2e/licensing.spec.ts`

**Interfaces:**
- Consumes: route `/equipo`, existing `teamManagerGuard`, seeded credentials `admin@example.com` / `TestPassword123!` and `empleada@example.com` / `DemoPassword123!`, test id `commercial-license-notice`.
- Produces: E2E evidence that an admin sees the warning with eleven active accounts and an employee cannot reach the management page or warning.

- [ ] **Step 1: Write the E2E test with a bounded PocketBase list response**

Create `web/e2e/licensing.spec.ts`:

```typescript
import { expect, test, type Page } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(/\/$/);
  await acknowledgePrivacyNotice(page);
}

function activeMember(index: number) {
  return {
    id: `license-member-${index}`,
    collectionId: 'users',
    collectionName: 'users',
    created: '2026-08-24 00:00:00.000Z',
    updated: '2026-08-24 00:00:00.000Z',
    email: `license-${index}@example.com`,
    name: `Persona licencia ${index}`,
    organization: 'test-organization',
    role: index === 0 ? 'admin' : 'employee',
    active: true,
    employeeCode: `LIC-${index}`,
    weeklyHours: 40,
    employmentType: 'full_time',
    contractedWeeklyMinutes: 2400,
    complementaryHoursAgreement: false,
    scheduleMode: 'scheduled',
    flexibleWeekdays: [1, 2, 3, 4, 5],
    jobTitle: 'Pruebas',
    privacyNoticeAcknowledgedVersion: '',
    privacyNoticeAcknowledgedAt: '',
    invitationStatus: '',
    invitationSentAt: '',
    invitationExpiresAt: '',
    invitationAcceptedAt: '',
  };
}

test('administration sees the commercial notice with eleven active accounts', async ({ page }) => {
  await signIn(page, 'admin@example.com', 'TestPassword123!');
  await page.route('**/api/collections/users/records?*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const items = Array.from({ length: 11 }, (_, index) => activeMember(index));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ page: 1, perPage: 500, totalItems: 11, totalPages: 1, items }),
    });
  });
  await page.goto('/equipo');
  const notice = page.getByTestId('commercial-license-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('11 cuentas activas');
  await expect(notice.getByRole('link', { name: 'Solicitar licencia comercial o permiso' }))
    .toHaveAttribute('href', /mailto:rubencidlara@gmail\.com/);
});

test('an employee cannot reach the team license notice', async ({ page }) => {
  await signIn(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/equipo');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('commercial-license-notice')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the new browser test**

```bash
cd web
pnpm exec playwright test e2e/licensing.spec.ts
```

Expected: the test passes in every configured Playwright project. If the SDK's
actual list query differs, inspect the failed request URL and narrow only the
GET route pattern; do not create persistent users or relax PocketBase rules.

- [ ] **Step 3: Commit browser acceptance**

```bash
git add web/e2e/licensing.spec.ts
git commit -m "test: cover commercial license notice"
```

---

### Task 6: Complete verification, legal-text audit and independent review

**Files:**
- Review: `LICENSE`
- Review: `NOTICE`
- Review: `COMMERCIAL-LICENSE.md`
- Review: `CONTRIBUTING.md`
- Review: `README.md`
- Review: `docs/DEPLOYMENT.md`
- Review: `docs/FEATURES.md`
- Review: `web/package.json`
- Review: `web/README.md`
- Review: `web/src/app/core/licensing.ts`
- Review: `web/src/app/shared/commercial-license-notice.component.ts`
- Review: `web/src/app/features/team/`
- Review: `web/src/app/features/settings/`
- Review: `web/e2e/licensing.spec.ts`

**Interfaces:**
- Consumes: all deliverables from Tasks 1–5.
- Produces: a clean, reviewed branch with verified tests and no unrelated or secret files.

- [ ] **Step 1: Run the complete required frontend matrix**

```bash
cd web
pnpm run test:ci
pnpm run build
pnpm run e2e
```

Expected: all unit tests, production build and Playwright projects pass.

- [ ] **Step 2: Audit canonical terms and project language**

```bash
cd ..
rg -n "Business Source License 1.1|Additional Use Grant|2030-08-24|AGPL-3.0-or-later" LICENSE
rg -n "BUSL-1.1" web/package.json README.md
rg -n "software libre|open source" README.md COMMERCIAL-LICENSE.md docs/FEATURES.md
rg -n "rubencidlara@gmail.com" LICENSE COMMERCIAL-LICENSE.md CONTRIBUTING.md web/src/app
find firmware/terminal/LICENSES -maxdepth 2 -type f -print | sort
git diff --check
git status --short
```

Expected: current licensing language never labels the BSL phase as open source;
any `open source` occurrence refers only to the future Change License or clearly
says the current version is not open source. Third-party notices remain present,
the diff is clean, and status contains only the planned files.

- [ ] **Step 3: Compare the BSL body with the authoritative source**

Open `https://mariadb.com/bsl11/` and compare every paragraph from `Terms`
through `Covenants of Licensor` with `LICENSE`. Differences are permitted only
in the parameter block above `Terms`; correct punctuation or whitespace
wrapping is acceptable, but no word in the legal body may be translated,
removed or replaced.

Expected: the body is verbatim and the Additional Use Grant only expands
production use for the approved group.

- [ ] **Step 4: Request independent code and compliance review**

Use the repository's `requesting-code-review` skill. Ask the reviewer to check:

```text
- exact alignment with the approved licensing spec;
- BSL body integrity and parameter consistency;
- no accidental relicensing of third-party components;
- threshold boundaries and inactive-account behavior;
- admin/manager visibility and employee exclusion;
- no enforcement, telemetry, migrations or backend weakening;
- accessible Spanish copy and a correct mailto contact;
- complete unit, build and E2E evidence.
```

Expected: no Critical or Important issue remains. Fix every valid Critical or
Important finding, rerun the affected checks, and request a focused re-review.

- [ ] **Step 5: Review and commit any final fixes**

```bash
git diff --check
git diff
git status --short
```

If review produced changes, stage only their exact files and commit:

```bash
git add LICENSE NOTICE COMMERCIAL-LICENSE.md CONTRIBUTING.md README.md \
  docs/DEPLOYMENT.md docs/FEATURES.md web/package.json web/src/app web/e2e/licensing.spec.ts
git commit -m "fix: close business license review findings"
```

If review produced no changes, do not create an empty commit.

- [ ] **Step 6: Confirm final history and publish the focused commits**

```bash
git status --short
git log --oneline --decorate -8
git push origin main
```

Expected: the worktree is clean and `origin/main` contains only the focused
license, domain, UI, test and any review-fix commits. Publishing a GitHub
release is not part of this plan.
