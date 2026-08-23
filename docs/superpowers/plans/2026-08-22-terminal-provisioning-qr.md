# Terminal Provisioning QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un QR efímero generado en Integraciones que permita a la cámara nativa de un móvil abrir el portal cautivo del M5Stack y autocompletar Wi-Fi, URL y API key, conservando siempre el formulario manual y las validaciones finales del firmware.

**Architecture:** Un codec TypeScript puro genera el contrato QR v1 y una tarjeta standalone mantiene todos los secretos únicamente en memoria del navegador. El portal sirve un JavaScript local embebido en el binario que valida estrictamente el fragmento, rellena el formulario sin enviarlo y lo elimina del historial; el POST, CSRF, `bootstrap` y persistencia C++ existentes no cambian. No se modifica PocketBase, ninguna migración ni ningún endpoint.

**Tech Stack:** Angular 22 standalone, signals, Tailwind CSS 4, `qrcode@1.5.4`, `@types/qrcode@1.5.6`, Vitest 4, Playwright 1.62, PlatformIO, ESP32 Arduino/C++17, Unity.

**Spec:** `docs/superpowers/specs/2026-08-22-terminal-provisioning-qr-design.md`

## Global Constraints

- El contrato exacto es `http://192.168.4.1/#ojp=<base64url-sin-padding>` sobre JSON UTF-8 compacto con propiedades en orden `v,s,p,u,t`.
- `v` debe ser `1`; `s` es obligatorio y admite hasta 32 bytes; `p` admite hasta 63 bytes y puede estar vacío; `u` es obligatorio, ASCII visible y admite hasta 255 bytes; `t` es obligatorio, ASCII, admite hasta 96 bytes y empieza por `ojterm_`.
- La URL QR completa admite como máximo 600 bytes ASCII; el símbolo usa corrección `M`, margen `4` y anchura `320` píxeles.
- SSID, contraseña, API key, payload y SVG QR no se envían a PocketBase, analítica o logs, ni se escriben en `localStorage`, `sessionStorage`, cookies, IndexedDB o cachés propias.
- El QR sólo existe mientras se muestra la API key recién creada o rotada; cerrar, navegar o recibir otra key limpia el estado local y no existe recuperación posterior.
- El formulario manual, CSRF, validación C++, conexión Wi-Fi, `bootstrap` y `ConfigStore::save` continúan siendo la única ruta de confirmación y persistencia.
- El portal nunca abre la cámara ni envía automáticamente el formulario; el móvil usa su cámara nativa después de conectarse al AP del M5Stack.
- El recurso `/provisioning.js` es local, sólo admite `GET`, usa `no-store`, no tiene dependencias remotas y no registra datos.
- La CSP exacta es `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action http://192.168.4.1; base-uri 'none'; frame-ancestors 'none'`.
- Los secretos están enmascarados por defecto; cada ojo es `type="button"`, tiene `aria-pressed` y una etiqueta accesible dinámica.
- La UI, errores, documentación y etiquetas accesibles permanecen en español.
- La versión release sólo admite HTTPS; la excepción HTTP privada sigue limitada al perfil development y a la demo autorizada existente.
- No leer, imprimir, modificar ni añadir `.env`; preservar todos los cambios previos del worktree y revisar cada staged diff antes de confirmar.

---

### Task 1: Codec canónico y renderizado QR en cliente

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/src/app/core/terminal-provisioning-qr.ts`
- Create: `web/src/app/core/terminal-provisioning-qr.fixture.ts`
- Test: `web/src/app/core/terminal-provisioning-qr.spec.ts`

**Interfaces:**
- Consumes: APIs estándar `TextEncoder`, `btoa` y `URL`; `qrcode@1.5.4` sólo se usa para renderizar después de validar.
- Produces: `TerminalProvisioningInput`, `TerminalProvisioningQrErrorCode`, `TerminalProvisioningQrResult`, `buildTerminalProvisioningUrl(input)`, `isProvisioningQrUrlWithinLimit(value)`, `renderTerminalProvisioningQr(url)` y el vector fijo `TERMINAL_PROVISIONING_V1_VECTOR`.

- [ ] **Step 1: Instalar versiones exactas y dejar el lockfile reproducible**

Run from `web/`:

```bash
pnpm add --save-exact qrcode@1.5.4
pnpm add --save-dev --save-exact @types/qrcode@1.5.6
```

Expected: `package.json` contiene versiones sin `^` y `pnpm-lock.yaml` resuelve exactamente `qrcode@1.5.4` y `@types/qrcode@1.5.6`.

- [ ] **Step 2: Escribir primero el vector compartido y las pruebas fallidas del codec**

Create `terminal-provisioning-qr.fixture.ts` with an exact oracle independent of the implementation:

```ts
import type { TerminalProvisioningInput } from './terminal-provisioning-qr';

export const TERMINAL_PROVISIONING_V1_VECTOR: Readonly<{
  input: TerminalProvisioningInput;
  canonicalJson: string;
  url: string;
}> = Object.freeze({
  input: Object.freeze({
    ssid: 'Red Demo',
    wifiPassword: 'Clave WiFi 123!',
    baseUrl: 'https://jornada.example.com',
    terminalToken: 'ojterm_demo_1234567890',
  }),
  canonicalJson:
    '{"v":1,"s":"Red Demo","p":"Clave WiFi 123!","u":"https://jornada.example.com","t":"ojterm_demo_1234567890"}',
  url: 'http://192.168.4.1/#ojp=eyJ2IjoxLCJzIjoiUmVkIERlbW8iLCJwIjoiQ2xhdmUgV2lGaSAxMjMhIiwidSI6Imh0dHBzOi8vam9ybmFkYS5leGFtcGxlLmNvbSIsInQiOiJvanRlcm1fZGVtb18xMjM0NTY3ODkwIn0',
});
```

Create `terminal-provisioning-qr.spec.ts` with these explicit cases:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildTerminalProvisioningUrl,
  isProvisioningQrUrlWithinLimit,
  renderTerminalProvisioningQr,
} from './terminal-provisioning-qr';
import { TERMINAL_PROVISIONING_V1_VECTOR } from './terminal-provisioning-qr.fixture';

describe('terminal provisioning QR v1', () => {
  it('matches the exact canonical vector', () => {
    expect(buildTerminalProvisioningUrl(TERMINAL_PROVISIONING_V1_VECTOR.input)).toEqual({
      ok: true,
      url: TERMINAL_PROVISIONING_V1_VECTOR.url,
      byteLength: 167,
    });
  });

  it('uses UTF-8 byte limits rather than JavaScript character counts', () => {
    expect(buildTerminalProvisioningUrl({
      ...TERMINAL_PROVISIONING_V1_VECTOR.input,
      ssid: 'ñ'.repeat(16),
      wifiPassword: '🔐'.repeat(15) + 'abc',
    }).ok).toBe(true);
    expect(buildTerminalProvisioningUrl({
      ...TERMINAL_PROVISIONING_V1_VECTOR.input,
      ssid: 'ñ'.repeat(17),
    })).toEqual({ ok: false, error: 'ssid_too_long' });
    expect(buildTerminalProvisioningUrl({
      ...TERMINAL_PROVISIONING_V1_VECTOR.input,
      wifiPassword: '🔐'.repeat(16),
    })).toEqual({ ok: false, error: 'wifi_password_too_long' });
  });

  it.each([
    [{ ssid: '' }, 'ssid_required'],
    [{ baseUrl: '' }, 'base_url_required'],
    [{ baseUrl: 'ftp://jornada.example.com' }, 'base_url_invalid'],
    [{ baseUrl: 'https://user:pass@jornada.example.com' }, 'base_url_invalid'],
    [{ baseUrl: 'https://jornada.example.com?token=x' }, 'base_url_invalid'],
    [{ baseUrl: 'https://jornada.example.com/#secret' }, 'base_url_invalid'],
    [{ terminalToken: 'incorrecta' }, 'terminal_token_invalid'],
    [{ terminalToken: `ojterm_${'x'.repeat(90)}` }, 'terminal_token_too_long'],
  ] as const)('rejects invalid input %o', (patch, error) => {
    expect(buildTerminalProvisioningUrl({
      ...TERMINAL_PROVISIONING_V1_VECTOR.input,
      ...patch,
    })).toEqual({ ok: false, error });
  });

  it('enforces the full URL boundary at 600 bytes', () => {
    expect(isProvisioningQrUrlWithinLimit('x'.repeat(600))).toBe(true);
    expect(isProvisioningQrUrlWithinLimit('x'.repeat(601))).toBe(false);
    const exactly600 = buildTerminalProvisioningUrl({
      ssid: 's',
      wifiPassword: 'p'.repeat(60),
      baseUrl: `https://example.com/${'u'.repeat(220)}`,
      terminalToken: `ojterm_${'t'.repeat(89)}`,
    });
    expect(exactly600).toMatchObject({ ok: true, byteLength: 600 });
    expect(buildTerminalProvisioningUrl({
      ssid: 's',
      wifiPassword: 'p'.repeat(60),
      baseUrl: `https://example.com/${'u'.repeat(221)}`,
      terminalToken: `ojterm_${'t'.repeat(89)}`,
    })).toEqual({ ok: false, error: 'qr_url_too_long' });
  });

  it('uses URL-safe Base64 without padding', () => {
    const result = buildTerminalProvisioningUrl(TERMINAL_PROVISIONING_V1_VECTOR.input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.url.split('#ojp=', 2)[1];
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(payload).not.toContain('=');
  });

  it('renders an SVG with the fixed production QR options', async () => {
    const dataUrl = await renderTerminalProvisioningQr(TERMINAL_PROVISIONING_V1_VECTOR.url);
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = atob(dataUrl.split(',', 2)[1]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="320"');
  });
});
```

- [ ] **Step 3: Ejecutar las pruebas para verificar el fallo inicial**

Run from `web/`:

```bash
pnpm exec ng test --watch=false --include='src/app/core/terminal-provisioning-qr.spec.ts'
```

Expected: FAIL because `terminal-provisioning-qr.ts` and its exports do not exist.

- [ ] **Step 4: Implementar el codec puro y el renderizador SVG**

Create `terminal-provisioning-qr.ts` with the following public contract and validation order:

```ts
import QRCode from 'qrcode';

export const TERMINAL_PROVISIONING_QR_MAX_BYTES = 600;
const QR_PREFIX = 'http://192.168.4.1/#ojp=';
const encoder = new TextEncoder();

export interface TerminalProvisioningInput {
  ssid: string;
  wifiPassword: string;
  baseUrl: string;
  terminalToken: string;
}

export type TerminalProvisioningQrErrorCode =
  | 'ssid_required'
  | 'ssid_too_long'
  | 'wifi_password_too_long'
  | 'base_url_required'
  | 'base_url_too_long'
  | 'base_url_invalid'
  | 'terminal_token_required'
  | 'terminal_token_too_long'
  | 'terminal_token_invalid'
  | 'invalid_text'
  | 'qr_url_too_long';

export type TerminalProvisioningQrResult =
  | { ok: true; url: string; byteLength: number }
  | { ok: false; error: TerminalProvisioningQrErrorCode };

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function hasForbiddenText(value: string): boolean {
  return value.includes('\0') || value.includes('\r') || value.includes('\n');
}

function isVisibleAscii(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x21 && code <= 0x7e;
  });
}

function isEarlyValidBaseUrl(value: string): boolean {
  if (!isVisibleAscii(value) || value.includes('\\') || value.includes('?') || value.includes('#')) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function isProvisioningQrUrlWithinLimit(value: string): boolean {
  return byteLength(value) <= TERMINAL_PROVISIONING_QR_MAX_BYTES;
}

export function buildTerminalProvisioningUrl(
  input: TerminalProvisioningInput,
): TerminalProvisioningQrResult {
  if (input.ssid.length === 0) return { ok: false, error: 'ssid_required' };
  if (byteLength(input.ssid) > 32) return { ok: false, error: 'ssid_too_long' };
  if (byteLength(input.wifiPassword) > 63) {
    return { ok: false, error: 'wifi_password_too_long' };
  }
  if (input.baseUrl.length === 0) return { ok: false, error: 'base_url_required' };
  if (byteLength(input.baseUrl) > 255) return { ok: false, error: 'base_url_too_long' };
  if (!isEarlyValidBaseUrl(input.baseUrl)) return { ok: false, error: 'base_url_invalid' };
  if (input.terminalToken.length === 0) {
    return { ok: false, error: 'terminal_token_required' };
  }
  if (byteLength(input.terminalToken) > 96) {
    return { ok: false, error: 'terminal_token_too_long' };
  }
  if (!isVisibleAscii(input.terminalToken) || !input.terminalToken.startsWith('ojterm_')) {
    return { ok: false, error: 'terminal_token_invalid' };
  }
  if ([input.ssid, input.wifiPassword, input.baseUrl, input.terminalToken].some(hasForbiddenText)) {
    return { ok: false, error: 'invalid_text' };
  }

  const canonicalJson = JSON.stringify({
    v: 1,
    s: input.ssid,
    p: input.wifiPassword,
    u: input.baseUrl,
    t: input.terminalToken,
  });
  const url = `${QR_PREFIX}${base64Url(encoder.encode(canonicalJson))}`;
  if (!isProvisioningQrUrlWithinLimit(url)) return { ok: false, error: 'qr_url_too_long' };
  return { ok: true, url, byteLength: byteLength(url) };
}

export async function renderTerminalProvisioningQr(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 320,
  });
  return `data:image/svg+xml;base64,${base64UrlForDataUri(encoder.encode(svg))}`;
}

function base64UrlForDataUri(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
```

The data URI helper deliberately keeps standard Base64 padding; only the provisioning payload uses URL-safe Base64 without padding.

- [ ] **Step 5: Ejecutar codec, typecheck y auditoría de la nueva dependencia**

Run from `web/`:

```bash
pnpm exec ng test --watch=false --include='src/app/core/terminal-provisioning-qr.spec.ts'
pnpm exec tsc -p tsconfig.app.json --noEmit
pnpm audit --prod
```

Expected: all exit 0; the exact vector, UTF-8 limits, 600/601 guard and SVG assertions pass; the production dependency audit reports no high or critical vulnerability.

- [ ] **Step 6: Commit the isolated codec**

```bash
git add web/package.json web/pnpm-lock.yaml \
  web/src/app/core/terminal-provisioning-qr.ts \
  web/src/app/core/terminal-provisioning-qr.fixture.ts \
  web/src/app/core/terminal-provisioning-qr.spec.ts
git diff --cached --check
git commit -m "feat: add terminal provisioning QR codec"
```

---

### Task 2: Tarjeta efímera de aprovisionamiento en Integraciones

**Files:**
- Create: `web/src/app/features/integrations/terminal-provisioning-card.component.ts`
- Create: `web/src/app/features/integrations/terminal-provisioning-card.component.html`
- Test: `web/src/app/features/integrations/terminal-provisioning-card.component.spec.ts`
- Modify: `web/src/app/features/integrations/integrations.component.ts`
- Modify: `web/src/app/features/integrations/integrations.component.html`

**Interfaces:**
- Consumes: `buildTerminalProvisioningUrl(input)` and `renderTerminalProvisioningQr(url)` from Task 1; a required signal input `terminalToken` containing only the just-issued credential.
- Produces: standalone `TerminalProvisioningCardComponent`, output events `copyToken` and `dismissed`, explicit `clearEphemeralState()`, and parent method `dismissTerminalProvisioning()`.

- [ ] **Step 1: Escribir pruebas fallidas del ciclo efímero y de accesibilidad**

Create the component spec with a small DOM helper and these assertions:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TerminalProvisioningCardComponent } from './terminal-provisioning-card.component';

describe('TerminalProvisioningCardComponent', () => {
  let fixture: ComponentFixture<TerminalProvisioningCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TerminalProvisioningCardComponent] }).compileComponents();
    fixture = TestBed.createComponent(TerminalProvisioningCardComponent);
    fixture.componentRef.setInput('terminalToken', 'ojterm_test_1234567890');
    fixture.detectChanges();
  });

  it('starts masked, preloads the browser origin and never submits from an eye button', () => {
    const host = fixture.nativeElement as HTMLElement;
    const password = host.querySelector<HTMLInputElement>('#provisioning_wifi_password')!;
    const token = host.querySelector<HTMLInputElement>('#provisioning_terminal_token')!;
    const eyes = [...host.querySelectorAll<HTMLButtonElement>('[data-secret-toggle]')];
    expect(password.type).toBe('password');
    expect(token.type).toBe('password');
    expect(eyes.map((button) => button.type)).toEqual(['button', 'button']);
    expect(eyes.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(host.querySelector<HTMLInputElement>('#provisioning_base_url')!.value).toBe(location.origin);
    eyes[0].click();
    fixture.detectChanges();
    expect(password.type).toBe('text');
    expect(eyes[0].getAttribute('aria-pressed')).toBe('true');
    expect(eyes[0].getAttribute('aria-label')).toBe('Ocultar contraseña Wi-Fi');
  });

  it('clears Wi-Fi, token-derived QR and reveal state before dismissing', async () => {
    const component = fixture.componentInstance;
    component.setSsid('Red Demo');
    component.setWifiPassword('Clave WiFi 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();
    component.toggleWifiPassword();
    expect(component.qrDataUrl()).not.toBe('');
    component.clearEphemeralState();
    expect(component.ssid()).toBe('');
    expect(component.wifiPassword()).toBe('');
    expect(component.baseUrl()).toBe(location.origin);
    expect(component.qrDataUrl()).toBe('');
    expect(component.wifiPasswordVisible()).toBe(false);
    expect(component.tokenVisible()).toBe(false);
  });

  it('invalidates a generated QR whenever an editable field changes', async () => {
    const component = fixture.componentInstance;
    component.setSsid('Red Demo');
    component.setWifiPassword('Clave WiFi 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();
    component.setSsid('Otra red');
    expect(component.qrDataUrl()).toBe('');
    expect(component.expanded()).toBe(false);
  });
});
```

Add this host regression to the same spec; it proves both replacement and destruction clear the child state:

```ts
import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';

@Component({
  imports: [TerminalProvisioningCardComponent],
  template: `
    @if (token()) {
      <app-terminal-provisioning-card [terminalToken]="token()" />
    }
  `,
})
class HostComponent {
  readonly token = signal('ojterm_first_1234567890');
}

it('resets local state when the one-time key changes and removes it on destroy', async () => {
  const hostFixture = TestBed.createComponent(HostComponent);
  hostFixture.detectChanges();
  const child = hostFixture.debugElement.query(By.directive(TerminalProvisioningCardComponent))
    .componentInstance as TerminalProvisioningCardComponent;
  child.setSsid('Red efímera');
  child.setWifiPassword('Clave efímera 123!');
  child.setBaseUrl('https://jornada.example.com');
  await child.generateQr();

  hostFixture.componentInstance.token.set('ojterm_second_1234567890');
  hostFixture.detectChanges();
  expect(child.ssid()).toBe('');
  expect(child.wifiPassword()).toBe('');
  expect(child.qrDataUrl()).toBe('');

  hostFixture.componentInstance.token.set('');
  hostFixture.detectChanges();
  expect(hostFixture.nativeElement.querySelector('app-terminal-provisioning-card')).toBeNull();
  expect((hostFixture.nativeElement as HTMLElement).textContent).not.toContain('ojterm_second_1234567890');
});
```

- [ ] **Step 2: Ejecutar la prueba para verificar que falla por componente ausente**

```bash
cd web
pnpm exec ng test --watch=false --include='src/app/features/integrations/terminal-provisioning-card.component.spec.ts'
```

Expected: FAIL because the standalone component has not been created.

- [ ] **Step 3: Implementar el estado de la tarjeta y su limpieza explícita**

Implement the component with required signal input/output and no service or storage injection:

```ts
import { Component, ElementRef, HostListener, OnDestroy, effect, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  TerminalProvisioningQrErrorCode,
  buildTerminalProvisioningUrl,
  renderTerminalProvisioningQr,
} from '../../core/terminal-provisioning-qr';

@Component({
  selector: 'app-terminal-provisioning-card',
  imports: [FormsModule],
  templateUrl: './terminal-provisioning-card.component.html',
})
export class TerminalProvisioningCardComponent implements OnDestroy {
  readonly terminalToken = input.required<string>();
  readonly copyToken = output<void>();
  readonly dismissed = output<void>();
  private readonly defaultBaseUrl = globalThis.location?.origin ?? 'https://tu-dominio.example';
  readonly ssid = signal('');
  readonly wifiPassword = signal('');
  readonly baseUrl = signal(this.defaultBaseUrl);
  readonly wifiPasswordVisible = signal(false);
  readonly tokenVisible = signal(false);
  readonly qrDataUrl = signal('');
  readonly qrError = signal('');
  readonly rendering = signal(false);
  readonly expanded = signal(false);
  private readonly expandButton = viewChild<ElementRef<HTMLButtonElement>>('expandButton');
  private generation = 0;

  constructor() {
    let previousToken = '';
    effect(() => {
      const nextToken = this.terminalToken();
      if (previousToken && previousToken !== nextToken) this.clearEphemeralState();
      previousToken = nextToken;
    });
  }

  setSsid(value: string): void { this.ssid.set(value); this.invalidateQr(); }
  setWifiPassword(value: string): void { this.wifiPassword.set(value); this.invalidateQr(); }
  setBaseUrl(value: string): void { this.baseUrl.set(value); this.invalidateQr(); }
  toggleWifiPassword(): void { this.wifiPasswordVisible.update((visible) => !visible); }
  toggleToken(): void { this.tokenVisible.update((visible) => !visible); }

  async generateQr(): Promise<void> {
    const request = ++this.generation;
    this.qrDataUrl.set('');
    this.qrError.set('');
    const result = buildTerminalProvisioningUrl({
      ssid: this.ssid(),
      wifiPassword: this.wifiPassword(),
      baseUrl: this.baseUrl(),
      terminalToken: this.terminalToken(),
    });
    if (!result.ok) { this.qrError.set(this.errorMessage(result.error)); return; }
    this.rendering.set(true);
    try {
      const image = await renderTerminalProvisioningQr(result.url);
      if (request === this.generation) this.qrDataUrl.set(image);
    } catch {
      if (request === this.generation) this.qrError.set('No se pudo generar el QR. Introduce los datos manualmente.');
    } finally {
      if (request === this.generation) this.rendering.set(false);
    }
  }

  openExpanded(): void { if (this.qrDataUrl()) this.expanded.set(true); }
  closeExpanded(): void {
    if (!this.expanded()) return;
    this.expanded.set(false);
    queueMicrotask(() => this.expandButton()?.nativeElement.focus());
  }
  @HostListener('document:keydown.escape') onEscape(): void { this.closeExpanded(); }
  dismiss(): void { this.clearEphemeralState(); this.dismissed.emit(); }
  clearEphemeralState(): void {
    this.generation += 1;
    this.ssid.set('');
    this.wifiPassword.set('');
    this.baseUrl.set(this.defaultBaseUrl);
    this.qrDataUrl.set('');
    this.qrError.set('');
    this.rendering.set(false);
    this.expanded.set(false);
    this.wifiPasswordVisible.set(false);
    this.tokenVisible.set(false);
  }
  ngOnDestroy(): void { this.clearEphemeralState(); }
  private invalidateQr(): void { this.generation += 1; this.qrDataUrl.set(''); this.qrError.set(''); this.expanded.set(false); }
  private errorMessage(error: TerminalProvisioningQrErrorCode): string {
    const messages: Record<TerminalProvisioningQrErrorCode, string> = {
      ssid_required: 'Introduce el nombre de la red Wi-Fi.',
      ssid_too_long: 'El nombre de la red supera 32 bytes.',
      wifi_password_too_long: 'La contraseña Wi-Fi supera 63 bytes.',
      base_url_required: 'Introduce la URL de OpenJornada.',
      base_url_too_long: 'La URL de OpenJornada supera 255 bytes.',
      base_url_invalid: 'Introduce una URL HTTP o HTTPS válida, sin credenciales, consulta ni fragmento.',
      terminal_token_required: 'La API key ya no está disponible. Rótala para generar otro QR.',
      terminal_token_too_long: 'La API key supera 96 bytes.',
      terminal_token_invalid: 'La API key debe empezar por ojterm_.',
      invalid_text: 'Los campos contienen caracteres no permitidos.',
      qr_url_too_long: 'Los datos son válidos, pero no caben en un QR seguro. Usa la entrada manual.',
    };
    return messages[error];
  }
}
```

- [ ] **Step 4: Construir la plantilla accesible y el diálogo ampliado**

The template must contain one semantic section headed `Aprovisionar terminal con QR`, a visible warning that the QR exposes complete credentials, and these exact controls:

```html
<section aria-labelledby="terminal-provisioning-heading" class="mt-7 rounded-[2rem] border-2 border-coral-200 bg-white p-6 shadow-xl shadow-stone-200/50">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <p class="text-xs font-bold uppercase tracking-[0.18em] text-coral-600">Terminal RFID</p>
      <h2 id="terminal-provisioning-heading" class="mt-2 font-display text-2xl font-bold">Aprovisionar terminal con QR</h2>
      <p class="mt-1 text-sm text-stone-500">La API key sólo se muestra en esta vista.</p>
    </div>
    <button type="button" (click)="dismiss()" class="btn-secondary">Ya la he guardado</button>
  </div>

  <p class="mt-5 rounded-2xl bg-amber-50 px-5 py-4 text-sm text-amber-900">
    <strong>Secreto:</strong> el QR contiene la contraseña Wi-Fi y la API key completas. No lo fotografíes ni lo compartas.
  </p>

  <div class="mt-5 grid gap-4 lg:grid-cols-2">
    <label><span class="field-label">Nombre de la red Wi-Fi</span><input id="provisioning_ssid" class="field-input" required maxlength="32" [ngModel]="ssid()" (ngModelChange)="setSsid($event)" /></label>
    <label><span class="field-label">URL de OpenJornada</span><input id="provisioning_base_url" class="field-input" type="url" required maxlength="255" [ngModel]="baseUrl()" (ngModelChange)="setBaseUrl($event)" /></label>
    <div>
      <label for="provisioning_wifi_password" class="field-label">Contraseña de la red Wi-Fi</label>
      <div class="relative">
        <input id="provisioning_wifi_password" class="field-input pr-14" [type]="wifiPasswordVisible() ? 'text' : 'password'" maxlength="63" autocomplete="new-password" [ngModel]="wifiPassword()" (ngModelChange)="setWifiPassword($event)" />
        <button data-secret-toggle type="button" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-coral-600" [attr.aria-label]="wifiPasswordVisible() ? 'Ocultar contraseña Wi-Fi' : 'Mostrar contraseña Wi-Fi'" [attr.aria-pressed]="wifiPasswordVisible()" (click)="toggleWifiPassword()"><span aria-hidden="true">&#128065;</span></button>
      </div>
    </div>
    <div>
      <label for="provisioning_terminal_token" class="field-label">API key del terminal recién emitida</label>
      <div class="relative">
        <input id="provisioning_terminal_token" class="field-input pr-14 font-mono text-xs" readonly [type]="tokenVisible() ? 'text' : 'password'" [value]="terminalToken()" />
        <button data-secret-toggle type="button" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-coral-600" [attr.aria-label]="tokenVisible() ? 'Ocultar API key del terminal' : 'Mostrar API key del terminal'" [attr.aria-pressed]="tokenVisible()" (click)="toggleToken()"><span aria-hidden="true">&#128065;</span></button>
      </div>
      <button type="button" (click)="copyToken.emit()" class="btn-secondary mt-3">Copiar API key</button>
    </div>
  </div>

  <button type="button" class="btn-primary mt-5" [disabled]="rendering()" (click)="generateQr()">{{ rendering() ? 'Generando QR' : 'Generar QR' }}</button>
  @if (qrError()) { <p role="alert" class="mt-4 text-sm font-medium text-red-700">{{ qrError() }}</p> }
  @if (qrDataUrl()) {
    <div class="mt-5 flex flex-col items-center gap-3 rounded-2xl bg-stone-50 p-5">
      <img class="h-80 w-80 max-w-full" [src]="qrDataUrl()" alt="Código QR para configurar el terminal OpenJornada" />
      <button #expandButton type="button" class="btn-secondary" (click)="openExpanded()">Ampliar código QR</button>
      <p class="text-center text-sm text-stone-600">Conecta primero el móvil al AP del M5Stack y escanea este QR con la cámara nativa. Revisa los datos antes de guardar.</p>
    </div>
  }
</section>

@if (expanded()) {
  <div class="fixed inset-0 z-50 grid place-items-center bg-stone-950/80 p-4" role="dialog" aria-modal="true" aria-label="Código QR ampliado">
    <div class="rounded-3xl bg-white p-5">
      <img class="h-[min(80vw,34rem)] w-[min(80vw,34rem)]" [src]="qrDataUrl()" alt="Código QR ampliado para configurar el terminal OpenJornada" />
      <button type="button" class="btn-secondary mt-4 w-full" autofocus (click)="closeExpanded()">Cerrar QR ampliado</button>
    </div>
  </div>
}
```

Use CSS/Tailwind already present; do not place the raw token, password, SSID or URL in `aria-label`, `alt`, title, status copy or logging.

- [ ] **Step 5: Sustituir el bloque de key actual por la tarjeta sin cambiar las llamadas API**

In `integrations.component.ts`, import the child, add it to `imports`, and add the parent clear method:

```ts
import { TerminalProvisioningCardComponent } from './terminal-provisioning-card.component';

// @Component
imports: [FormsModule, TerminalProvisioningCardComponent],

protected dismissTerminalProvisioning(): void {
  this.generatedTerminalToken.set('');
}
```

Keep `createTerminal()`, `rotateTerminal()` and `copyTerminalToken()` APIs intact. Change their success copy to mention the QR option, and render the child in `integrations.component.html`:

```html
@if (generatedTerminalToken()) {
  <app-terminal-provisioning-card
    [terminalToken]="generatedTerminalToken()"
    (copyToken)="copyTerminalToken()"
    (dismissed)="dismissTerminalProvisioning()"
  />
}
```

Before assigning a new successful create/rotate response, call `generatedTerminalToken.set('')` so Angular destroys the prior child; then assign only `terminal.token ?? ''`. Do not add SSID or password properties to `TerminalRecord`, `TerminalService` request bodies or PocketBase models.

- [ ] **Step 6: Ejecutar pruebas de tarjeta, toda la suite unitaria y build web**

```bash
cd web
pnpm exec ng test --watch=false --include='src/app/features/integrations/terminal-provisioning-card.component.spec.ts'
pnpm run test:ci
pnpm run build
```

Expected: all exit 0; the card is masked by default, clears state, invalidates stale QR and the lazy Integraciones route builds.

- [ ] **Step 7: Commit the web UI slice**

```bash
git add web/src/app/features/integrations/terminal-provisioning-card.component.ts \
  web/src/app/features/integrations/terminal-provisioning-card.component.html \
  web/src/app/features/integrations/terminal-provisioning-card.component.spec.ts \
  web/src/app/features/integrations/integrations.component.ts \
  web/src/app/features/integrations/integrations.component.html
git diff --cached --check
git commit -m "feat: add ephemeral terminal provisioning card"
```

---

### Task 3: Decoder auditable del fragmento en el navegador cautivo

**Files:**
- Create: `firmware/terminal/assets/provisioning.js`
- Create: `web/e2e/terminal-provisioning-portal.spec.ts`

**Interfaces:**
- Consumes: fragmento `#ojp=`, el vector `TERMINAL_PROVISIONING_V1_VECTOR` de Task 1 y los IDs de formulario `ssid`, `wifi_password`, `base_url`, `terminal_token`, `qr_status`, `toggle_wifi_password`, `toggle_terminal_token`.
- Produces: asset sin dependencias `provisioning.js`; API de prueba inmutable `window.OpenJornadaProvisioning.decodeProvisioningHash(hash)` e inicializador automático `init()`.

- [ ] **Step 1: Escribir el harness Playwright contra el archivo real todavía ausente**

Create `terminal-provisioning-portal.spec.ts`. Route the local portal address so the fragment is retained without contacting a device:

```ts
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { TERMINAL_PROVISIONING_V1_VECTOR } from '../src/app/core/terminal-provisioning-qr.fixture';

const scriptPath = resolve(process.cwd(), '../firmware/terminal/assets/provisioning.js');
const portalHtml = `<!doctype html><html lang="es"><body>
  <form id="provisioning_form">
    <input id="ssid" value="manual-ssid">
    <input id="wifi_password" type="password" value="manual-password">
    <input id="base_url" value="https://manual.example.com">
    <input id="terminal_token" type="password" value="ojterm_manual_token">
    <button id="toggle_wifi_password" data-target="wifi_password" type="button" aria-label="Mostrar contraseña Wi-Fi" aria-pressed="false">ojo</button>
    <button id="toggle_terminal_token" data-target="terminal_token" type="button" aria-label="Mostrar API key del terminal" aria-pressed="false">ojo</button>
    <button type="submit">Comprobar y guardar</button>
  </form>
  <p id="qr_status" hidden></p>
</body></html>`;

async function openPortal(page: import('@playwright/test').Page, hash: string): Promise<void> {
  await page.route('http://192.168.4.1/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: portalHtml,
  }));
  await page.goto(`http://192.168.4.1/${hash}`);
  await page.addScriptTag({ path: scriptPath });
}
```

Add these concrete helpers and tests below the harness:

```ts
function hashFromJson(json: string): string {
  return `#ojp=${Buffer.from(json, 'utf8').toString('base64url')}`;
}

test('applies the exact vector atomically, clears the fragment and never submits', async ({ page }) => {
  await page.route('http://192.168.4.1/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: portalHtml,
  }));
  await page.goto(TERMINAL_PROVISIONING_V1_VECTOR.url);
  await page.evaluate(() => {
    (window as typeof window & { submitCount: number }).submitCount = 0;
    document.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      (window as typeof window & { submitCount: number }).submitCount += 1;
    });
  });
  const requests: string[] = [];
  const logs: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('console', (message) => logs.push(message.text()));
  await page.addScriptTag({ path: scriptPath });

  await expect(page.locator('#ssid')).toHaveValue('Red Demo');
  await expect(page.locator('#wifi_password')).toHaveValue('Clave WiFi 123!');
  await expect(page.locator('#base_url')).toHaveValue('https://jornada.example.com');
  await expect(page.locator('#terminal_token')).toHaveValue('ojterm_demo_1234567890');
  await expect(page).toHaveURL('http://192.168.4.1/');
  await expect(page.locator('#qr_status')).toHaveText(
    'Configuración leída. Revisa los datos y pulsa Comprobar y guardar.',
  );
  expect(await page.evaluate(() => (window as typeof window & { submitCount: number }).submitCount)).toBe(0);
  expect(requests).toEqual([]);
  expect(logs).toEqual([]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
  expect(await page.context().cookies()).toEqual([]);
});

const invalidHashes = [
  ['Base64 inválido', '#ojp=%%%'],
  ['URL QR excedida', `#ojp=${'A'.repeat(577)}`],
  ['UTF-8 inválido', `#ojp=${Buffer.from([0xc3, 0x28]).toString('base64url')}`],
  ['JSON array', hashFromJson('[1,2,3]')],
  ['claves reordenadas', hashFromJson('{"s":"Red","v":1,"p":"","u":"https://jornada.example.com","t":"ojterm_test"}')],
  ['clave duplicada', hashFromJson('{"v":1,"s":"Red","s":"Otra","p":"","u":"https://jornada.example.com","t":"ojterm_test"}')],
  ['clave extra', hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com","t":"ojterm_test","x":1}')],
  ['versión desconocida', hashFromJson('{"v":2,"s":"Red","p":"","u":"https://jornada.example.com","t":"ojterm_test"}')],
  ['tipo incorrecto', hashFromJson('{"v":1,"s":7,"p":"","u":"https://jornada.example.com","t":"ojterm_test"}')],
  ['SSID excedido', hashFromJson(JSON.stringify({ v: 1, s: 'x'.repeat(33), p: '', u: 'https://jornada.example.com', t: 'ojterm_test' }))],
  ['contraseña excedida', hashFromJson(JSON.stringify({ v: 1, s: 'Red', p: 'x'.repeat(64), u: 'https://jornada.example.com', t: 'ojterm_test' }))],
  ['URL excedida', hashFromJson(JSON.stringify({ v: 1, s: 'Red', p: '', u: `https://example.com/${'x'.repeat(236)}`, t: 'ojterm_test' }))],
  ['token excedido', hashFromJson(JSON.stringify({ v: 1, s: 'Red', p: '', u: 'https://jornada.example.com', t: `ojterm_${'x'.repeat(90)}` }))],
  ['URL inválida', hashFromJson('{"v":1,"s":"Red","p":"","u":"ftp://jornada.example.com","t":"ojterm_test"}')],
  ['URL con credenciales', hashFromJson('{"v":1,"s":"Red","p":"","u":"https://user:pass@jornada.example.com","t":"ojterm_test"}')],
  ['URL con consulta', hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com?x=1","t":"ojterm_test"}')],
  ['token inválido', hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com","t":"incorrecto"}')],
] as const;

for (const [name, hash] of invalidHashes) {
  test(`rejects ${name} without partially changing manual fields`, async ({ page }) => {
    await openPortal(page, hash);
    await expect(page.locator('#ssid')).toHaveValue('manual-ssid');
    await expect(page.locator('#wifi_password')).toHaveValue('manual-password');
    await expect(page.locator('#base_url')).toHaveValue('https://manual.example.com');
    await expect(page.locator('#terminal_token')).toHaveValue('ojterm_manual_token');
    await expect(page.locator('#qr_status')).toHaveText(
      'No se pudo leer la configuración del QR. Introduce los datos manualmente.',
    );
    await expect(page).toHaveURL('http://192.168.4.1/');
  });
}

test('toggles both secrets accessibly without submitting', async ({ page }) => {
  await openPortal(page, '');
  await expect(page.locator('#qr_status')).toBeHidden();
  let submissions = 0;
  await page.locator('form').evaluate((form) => form.addEventListener('submit', (event) => event.preventDefault()));
  page.on('request', () => { submissions += 1; });
  for (const [buttonId, fieldId, shown, hidden] of [
    ['toggle_wifi_password', 'wifi_password', 'Mostrar contraseña Wi-Fi', 'Ocultar contraseña Wi-Fi'],
    ['toggle_terminal_token', 'terminal_token', 'Mostrar API key del terminal', 'Ocultar API key del terminal'],
  ] as const) {
    const button = page.locator(`#${buttonId}`);
    const field = page.locator(`#${fieldId}`);
    await expect(button).toHaveAttribute('type', 'button');
    await expect(button).toHaveAttribute('aria-label', shown);
    await button.click();
    await expect(field).toHaveAttribute('type', 'text');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveAttribute('aria-label', hidden);
    await button.click();
    await expect(field).toHaveAttribute('type', 'password');
  }
  expect(submissions).toBe(0);
});
```

- [ ] **Step 2: Ejecutar el E2E contractual para confirmar el fallo por asset ausente**

```bash
cd web
pnpm exec playwright test e2e/terminal-provisioning-portal.spec.ts --project=desktop-chromium
```

Expected: FAIL because `firmware/terminal/assets/provisioning.js` does not exist.

- [ ] **Step 3: Implementar decodificación estricta, aplicación atómica y ojos**

Create the asset as an IIFE with no imports and no logging. Its validation core must follow this exact sequence:

```js
(() => {
  'use strict';
  const ERROR = 'No se pudo leer la configuración del QR. Introduce los datos manualmente.';
  const REVIEW = 'Configuración leída. Revisa los datos y pulsa Comprobar y guardar.';
  const encoder = new TextEncoder();

  function bytes(value) { return encoder.encode(value).byteLength; }
  function visibleAscii(value) {
    return Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return code >= 0x21 && code <= 0x7e;
    });
  }
  function forbiddenText(value) {
    return value.includes('\0') || value.includes('\r') || value.includes('\n');
  }
  function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error('invalid');
    const standard = value.replace(/-/gu, '+').replace(/_/gu, '/');
    const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  function sameBytes(left, right) {
    return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
  }
  function validUrl(value) {
    if (!visibleAscii(value) || value.includes('\\') || value.includes('?') || value.includes('#')) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.hostname.length > 0 && parsed.username === '' && parsed.password === '';
    } catch { return false; }
  }
  function decodeProvisioningHash(hash) {
    if (!hash.startsWith('#ojp=')) return null;
    if (bytes(`http://192.168.4.1/${hash}`) > 600) throw new Error('invalid');
    const rawBytes = decodeBase64Url(hash.slice(5));
    const json = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
    const value = JSON.parse(json);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    if (Object.keys(value).join(',') !== 'v,s,p,u,t') throw new Error('invalid');
    if (value.v !== 1 || typeof value.s !== 'string' || typeof value.p !== 'string' ||
        typeof value.u !== 'string' || typeof value.t !== 'string') throw new Error('invalid');
    const canonical = JSON.stringify({ v: 1, s: value.s, p: value.p, u: value.u, t: value.t });
    if (!sameBytes(rawBytes, encoder.encode(canonical))) throw new Error('invalid');
    if (value.s.length === 0 || bytes(value.s) > 32 || bytes(value.p) > 63 ||
        value.u.length === 0 || bytes(value.u) > 255 || value.t.length === 0 || bytes(value.t) > 96 ||
        [value.s, value.p, value.u, value.t].some(forbiddenText) || !validUrl(value.u) ||
        !visibleAscii(value.t) || !value.t.startsWith('ojterm_')) throw new Error('invalid');
    return { ssid: value.s, wifiPassword: value.p, baseUrl: value.u, terminalToken: value.t };
  }
```

Complete the IIFE with atomic DOM application and fragment cleanup only after successful validation:

```js
  function setStatus(message, error) {
    const status = document.getElementById('qr_status');
    if (!status) return;
    status.hidden = false;
    status.textContent = message;
    status.className = error ? 'error' : 'success';
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function applyHash() {
    if (!location.hash.startsWith('#ojp=')) return;
    try {
      const decoded = decodeProvisioningHash(location.hash);
      if (!decoded) return;
      const fields = ['ssid', 'wifi_password', 'base_url', 'terminal_token']
        .map((id) => document.getElementById(id));
      if (fields.some((field) => !(field instanceof HTMLInputElement))) throw new Error('invalid');
      fields[0].value = decoded.ssid;
      fields[1].value = decoded.wifiPassword;
      fields[2].value = decoded.baseUrl;
      fields[3].value = decoded.terminalToken;
      setStatus(REVIEW, false);
    } catch {
      setStatus(ERROR, true);
    } finally {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
  }
  function installToggle(buttonId, shownLabel, hiddenLabel) {
    const button = document.getElementById(buttonId);
    if (!(button instanceof HTMLButtonElement)) return;
    const field = document.getElementById(button.dataset.target || '');
    if (!(field instanceof HTMLInputElement)) return;
    button.addEventListener('click', () => {
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', show ? hiddenLabel : shownLabel);
    });
  }
  function init() {
    installToggle('toggle_wifi_password', 'Mostrar contraseña Wi-Fi', 'Ocultar contraseña Wi-Fi');
    installToggle('toggle_terminal_token', 'Mostrar API key del terminal', 'Ocultar API key del terminal');
    applyHash();
  }
  window.OpenJornadaProvisioning = Object.freeze({ decodeProvisioningHash, init });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
```

Declare the test-only global type inside the Playwright spec instead of changing production Angular typings.

- [ ] **Step 4: Ejecutar el contrato real y revisar el asset en busca de efectos prohibidos**

```bash
cd web
pnpm exec playwright test e2e/terminal-provisioning-portal.spec.ts --project=desktop-chromium
if rg -n "console\.|fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie" ../firmware/terminal/assets/provisioning.js; then
  exit 1
fi
```

Expected: Playwright passes; `rg` returns no matches and therefore exits 1, which is the expected result of the inspection command.

- [ ] **Step 5: Commit the independently browser-tested decoder**

```bash
git add firmware/terminal/assets/provisioning.js web/e2e/terminal-provisioning-portal.spec.ts
git diff --cached --check
git commit -m "feat: decode terminal provisioning QR in captive portal"
```

---

### Task 4: Embebido y servido seguro del asset en el firmware

**Files:**
- Modify: `firmware/terminal/platformio.ini`
- Modify: `firmware/terminal/include/openjornada/provisioning.hpp`
- Modify: `firmware/terminal/src/provisioning/captive_portal.cpp`
- Test: `firmware/terminal/test/test_provisioning_http/test_main.cpp`

**Interfaces:**
- Consumes: `firmware/terminal/assets/provisioning.js` and existing bounded HTTP parser/form flow.
- Produces: `kProvisioningScriptPath`, `kProvisioningContentSecurityPolicy`, `isProvisioningScriptRequest(request)`, embedded linker symbols, raw response route for `GET /provisioning.js`, and portal markup IDs used by Task 3.

- [ ] **Step 1: Añadir primero pruebas nativas de ruta y política exactas**

Append these tests and register them in `main()`:

```cpp
void test_provisioning_script_route_only_accepts_exact_get() {
  CaptiveHttpRequest request;
  request.method = "GET";
  request.target = "/provisioning.js";
  TEST_ASSERT_TRUE(isProvisioningScriptRequest(request));
  request.method = "POST";
  TEST_ASSERT_FALSE(isProvisioningScriptRequest(request));
  request.method = "GET";
  request.target = "/provisioning.js?x=1";
  TEST_ASSERT_FALSE(isProvisioningScriptRequest(request));
}

void test_provisioning_csp_allows_only_the_local_script() {
  TEST_ASSERT_EQUAL_STRING(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; "
      "form-action http://192.168.4.1; base-uri 'none'; "
      "frame-ancestors 'none'",
      kProvisioningContentSecurityPolicy);
}
```

- [ ] **Step 2: Ejecutar native para comprobar que faltan los símbolos**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native -f test_provisioning_http
```

Expected: compilation FAIL because the route predicate and CSP constant are not defined.

- [ ] **Step 3: Definir las constantes portables y el predicado probado**

Add to `provisioning.hpp`:

```cpp
inline constexpr char kProvisioningScriptPath[] = "/provisioning.js";
inline constexpr char kProvisioningContentSecurityPolicy[] =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; "
    "form-action http://192.168.4.1; base-uri 'none'; "
    "frame-ancestors 'none'";

bool isProvisioningScriptRequest(const CaptiveHttpRequest& request);
```

Implement outside the `#ifdef ARDUINO` section so native tests exercise the same predicate used on-device:

```cpp
bool isProvisioningScriptRequest(const CaptiveHttpRequest& request) {
  return request.method == "GET" &&
         request.target == kProvisioningScriptPath;
}
```

- [ ] **Step 4: Embebir el archivo y servirlo antes de la redirección cautiva**

Under `[m5stack_base]` add:

```ini
board_build.embed_txtfiles = assets/provisioning.js
```

Under the Arduino-only anonymous namespace declare the generated symbols:

```cpp
extern const uint8_t provisioningJsStart[]
    asm("_binary_assets_provisioning_js_start");
extern const uint8_t provisioningJsEnd[]
    asm("_binary_assets_provisioning_js_end");
```

Refactor response headers into one `sendHeaders` helper so HTML and JavaScript both receive exact `Content-Length`, `Connection: close`, `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and the value of `kProvisioningContentSecurityPolicy`. Implement it as:

```cpp
void sendHeaders(WiFiClient& client, int status, const char* contentType,
                 size_t contentLength, const char* location = nullptr) {
  client.print(F("HTTP/1.1 "));
  client.print(status);
  client.print(' ');
  client.print(reasonPhrase(status));
  client.print(F("\r\nContent-Type: "));
  client.print(contentType);
  client.print(F("\r\nContent-Length: "));
  client.print(contentLength);
  client.print(F("\r\nConnection: close\r\nCache-Control: no-store, max-age=0"
                 "\r\nPragma: no-cache\r\nX-Content-Type-Options: nosniff"
                 "\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: "));
  client.print(kProvisioningContentSecurityPolicy);
  client.print(F("\r\n"));
  if (location != nullptr) {
    client.print(F("Location: "));
    client.print(location);
    client.print(F("\r\n"));
  }
  client.print(F("\r\n"));
}
```

Then add:

```cpp
void sendProvisioningScript(WiFiClient& client) {
  size_t length = static_cast<size_t>(provisioningJsEnd - provisioningJsStart);
  if (length > 0 && provisioningJsStart[length - 1] == 0) --length;
  sendHeaders(client, 200, "application/javascript; charset=utf-8", length);
  client.write(provisioningJsStart, length);
}
```

Resolve it immediately after `GET /` and before `/save` or the catch-all redirect:

```cpp
if (request.method == "GET" && request.target == "/") {
  sendResponse(client, 200, "text/html; charset=utf-8", portalPage(csrf, activeConfig_, {}));
} else if (isProvisioningScriptRequest(request)) {
  sendProvisioningScript(client);
} else if (request.method == "POST" && request.target == "/save") {
  // Keep the complete existing CSRF, validation, bootstrap and save branch unchanged.
} else {
  sendResponse(client, 302, "text/plain; charset=utf-8", "Abriendo configuración...", "http://192.168.4.1/");
}
```

Do not copy the JavaScript into an Arduino `String`; stream the embedded bytes with the linker-provided length.

- [ ] **Step 5: Añadir al HTML el estado QR, el script defer y ambos ojos sin alterar nombres POST**

Keep input names `ssid`, `wifi_password`, `base_url`, `terminal_token` and the hidden `csrf`. Add:

```html
<p id="qr_status" hidden></p>
<div class="secret-field">
  <input id="wifi_password" name="wifi_password" type="password">
  <button id="toggle_wifi_password" data-target="wifi_password" type="button" aria-label="Mostrar contraseña Wi-Fi" aria-pressed="false"><span aria-hidden="true">&#128065;</span></button>
</div>
<div class="secret-field">
  <input id="terminal_token" name="terminal_token" type="password">
  <button id="toggle_terminal_token" data-target="terminal_token" type="button" aria-label="Mostrar API key del terminal" aria-pressed="false"><span aria-hidden="true">&#128065;</span></button>
</div>
<script src="/provisioning.js" defer></script>
```

Add local CSS for `.secret-field`, right input padding, `.secret-field button`, `.success` and `.error`; preserve a visible focus outline. The only `<script>` is the external local asset. Increase `page.reserve` based on the final measured HTML size rather than truncating output.

- [ ] **Step 6: Ejecutar native, builds ESP32 y verificar que el asset está realmente enlazado**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native -f test_provisioning_http
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
nm .pio/build/m5stack_dev/firmware.elf | rg '_binary_assets_provisioning_js_(start|end)'
nm .pio/build/m5stack_release/firmware.elf | rg '_binary_assets_provisioning_js_(start|end)'
```

Expected: all tests/builds exit 0 and both ELF files expose start/end symbols.

- [ ] **Step 7: Review the overlapping firmware diff without staging prior work accidentally**

```bash
git diff --check -- firmware/terminal/platformio.ini \
  firmware/terminal/include/openjornada/provisioning.hpp \
  firmware/terminal/src/provisioning/captive_portal.cpp \
  firmware/terminal/test/test_provisioning_http/test_main.cpp
git diff -- firmware/terminal/platformio.ini \
  firmware/terminal/include/openjornada/provisioning.hpp \
  firmware/terminal/src/provisioning/captive_portal.cpp \
  firmware/terminal/test/test_provisioning_http/test_main.cpp
```

Expected: no whitespace errors. These files already contain uncommitted work from the prior firmware delivery, so do not run `git add` on the whole files. Leave this slice uncommitted unless the existing hunks have first been separated or the user explicitly authorizes committing the combined firmware work.

---

### Task 5: Recorrido E2E de Integraciones y documentación de custodia

**Files:**
- Create: `web/e2e/terminal-provisioning-qr.spec.ts`
- Modify: `README.md`
- Modify: `docs/FEATURES.md`
- Modify: `docs/COMPLIANCE_ES.md`
- Modify: `firmware/terminal/README.md`

**Interfaces:**
- Consumes: UI labels from Task 2, existing `/integraciones` route and terminal creation/rotation endpoints.
- Produces: regression E2E for one-time secrets, QR/modal/keyboard flow and documentation matching the shipped workflow.

- [ ] **Step 1: Escribir el E2E completo de creación, cierre y rotación**

Create a desktop-only test using the existing demo admin and privacy helper:

```ts
import { expect, test } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@example.com');
  await page.getByLabel('Contraseña').fill('TestPassword123!');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await acknowledgePrivacyNotice(page);
}

test('an admin provisions a terminal by QR without losing the manual fallback', async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto('/integraciones');
  const name = `QR E2E ${testInfo.project.name} ${Date.now()}`;
  await page.getByLabel('Nombre del nuevo terminal').fill(name);
  await page.getByRole('button', { name: 'Crear terminal' }).click();

  const card = page.getByRole('region', { name: 'Aprovisionar terminal con QR' });
  await expect(card).toBeVisible();
  await expect(card.getByText('el QR contiene la contraseña Wi-Fi y la API key completas')).toBeVisible();
  const tokenInput = card.getByLabel('API key del terminal recién emitida');
  const token = await tokenInput.inputValue();
  expect(token).toMatch(/^ojterm_[A-Za-z0-9_-]+$/u);
  await expect(tokenInput).toHaveAttribute('type', 'password');

  const localRequests: string[] = [];
  page.on('request', (request) => localRequests.push(request.url()));
  const storageBefore = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
  }));
  await card.getByLabel('Nombre de la red Wi-Fi').fill('Red demo efímera');
  await card.getByLabel('Contraseña de la red Wi-Fi').fill('Clave demo efímera 123!');
  await card.getByLabel('URL de OpenJornada').fill('https://jornada.example.com');
  await card.getByRole('button', { name: 'Generar QR' }).click();
  const qr = card.getByAltText('Código QR para configurar el terminal OpenJornada');
  await expect(qr).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/u);
  expect(localRequests).toEqual([]);
  expect(await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
  }))).toEqual(storageBefore);

  const expand = card.getByRole('button', { name: 'Ampliar código QR' });
  await expand.click();
  await expect(page.getByRole('dialog', { name: 'Código QR ampliado' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Código QR ampliado' })).toHaveCount(0);
  await expect(expand).toBeFocused();

  await card.getByRole('button', { name: 'Ya la he guardado' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByDisplayValue(token)).toHaveCount(0);
  await expect(page.getByDisplayValue('Clave demo efímera 123!')).toHaveCount(0);

  const row = page.locator('li').filter({ hasText: name }).first();
  await expect(row).not.toContainText(token);
  await expect(row).not.toContainText('Red demo efímera');
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Rotar key' }).click();
  await expect(page.getByRole('region', { name: 'Aprovisionar terminal con QR' })).toBeVisible();
  const rotated = await page.getByLabel('API key del terminal recién emitida').inputValue();
  expect(rotated).not.toBe(token);
  await expect(page.getByLabel('Nombre de la red Wi-Fi')).toHaveValue('');

  await page.getByRole('button', { name: 'Ya la he guardado' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Revocar' }).click();
  await expect(row.getByText('Revocado')).toBeVisible();
});
```

The `aria-labelledby="terminal-provisioning-heading"` relationship from Task 2 exposes the section as the named Playwright region. Keep the request listener after the create response and before the local fills so the zero-request assertion is deterministic.

- [ ] **Step 2: Ejecutar el E2E afectado en los tres viewports**

```bash
cd web
pnpm exec playwright test e2e/terminal-provisioning-qr.spec.ts
```

Expected: PASS on desktop, tablet and mobile. Each run revokes its own uniquely named terminal, and no secret appears after dismiss or in the terminal row.

- [ ] **Step 3: Actualizar documentación funcional, de seguridad y de puesta en servicio**

Make these exact content changes:

- `README.md`, terminal section: after explaining the one-time API key, say Integraciones can generate a local one-time QR with SSID, Wi-Fi password, current/editable OpenJornada URL and the just-issued key; the data is not saved; manual entry remains available.
- `docs/FEATURES.md`, Integraciones row: include native-camera QR autofill, one-time client-only generation, manual fallback, and the unchanged server-side validation/bootstrap path.
- `docs/COMPLIANCE_ES.md`, RFID control: state that Base64 is not encryption, anyone viewing the QR can recover Wi-Fi and terminal credentials, administrators must prevent photographs/sharing and rotate or revoke after exposure, and OpenJornada does not persist Wi-Fi data.
- `firmware/terminal/README.md`, Puesta en servicio: document both numbered paths: native camera QR after joining `OpenJornada-XXXX`, and direct manual typing; explain that scanning only fills fields and **Comprobar y guardar** still performs validation. Retain the ten-minute display sleep behavior and the dev/release HTTP/HTTPS distinction.

Do not claim secure RAM erasure or that QR scanning authenticates the administrator.

- [ ] **Step 4: Verificar documentación y E2E together**

```bash
git diff --check -- README.md docs/FEATURES.md docs/COMPLIANCE_ES.md firmware/terminal/README.md web/e2e/terminal-provisioning-qr.spec.ts
cd web
pnpm exec playwright test e2e/terminal-provisioning-portal.spec.ts e2e/terminal-provisioning-qr.spec.ts
```

Expected: no whitespace errors and both the isolated portal contract and the Angular lifecycle pass.

- [ ] **Step 5: Commit only new/non-overlapping files, preserving prior documentation work**

`README.md`, `docs/FEATURES.md`, `docs/COMPLIANCE_ES.md` and `firmware/terminal/README.md` already contain prior uncommitted firmware changes. Review their combined diffs and leave them unstaged unless the prior work is deliberately included. The E2E file is safe to commit independently:

```bash
git add web/e2e/terminal-provisioning-qr.spec.ts
git diff --cached --check
git commit -m "test: cover terminal QR provisioning lifecycle"
```

---

### Task 6: Matriz production-ready, demo efímera y aceptación física

**Files:**
- Modify if results/status need recording: `docs/superpowers/plans/2026-08-22-terminal-provisioning-qr.md`
- Verify only: entire repository and attached M5Stack

**Interfaces:**
- Consumes: all preceding deliverables, the stable device path `/dev/serial/by-id/usb-1a86_USB_Single_Serial_5B21222177-if00`, isolated demo backend and a separate HTTPS production-like endpoint.
- Produces: green automated matrix, verified release artifact hash, physical acceptance evidence and no surviving demo credential page.

- [ ] **Step 1: Ejecutar la matriz web obligatoria desde instalación bloqueada**

```bash
cd web
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:ci
pnpm run e2e
pnpm audit --prod
```

Expected: every command exits 0. Inspect failures rather than reducing coverage, changing access rules or skipping the new desktop contract.

- [ ] **Step 2: Ejecutar toda la matriz firmware y reproducir ambos binarios**

```bash
cd firmware/terminal
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_release
sha256sum .pio/build/m5stack_dev/firmware.bin .pio/build/m5stack_release/firmware.bin
```

Expected: native and both builds exit 0; record the two new SHA-256 values in the delivery report without printing credentials.

- [ ] **Step 3: Ejecutar las comprobaciones de empaquetado de producción**

From repository root:

```bash
docker compose -f docker-compose.production.yml config --quiet
docker build -t openjornada .
git diff --check
```

Expected: production Compose is valid, the unified container builds and the whole worktree has no whitespace errors. Do not inspect `.env`.

- [ ] **Step 4: Flashear development por el enlace serie estable y comprobar cabeceras reales**

```bash
cd firmware/terminal
uv tool run --from platformio platformio run -e m5stack_dev --target upload \
  --upload-port /dev/serial/by-id/usb-1a86_USB_Single_Serial_5B21222177-if00
```

If host serial permissions still reject upload, use the already-established ephemeral container/esptool route with only that exact character device exposed; do not change global permissions. While joined to the M5Stack AP, run:

```bash
curl --fail --silent --show-error --dump-header /tmp/openjornada-portal-headers.txt \
  --output /tmp/openjornada-portal.html http://192.168.4.1/
curl --fail --silent --show-error --dump-header /tmp/openjornada-script-headers.txt \
  --output /tmp/openjornada-provisioning.js http://192.168.4.1/provisioning.js
rg -n "^Content-Type: application/javascript; charset=utf-8|^Cache-Control: no-store, max-age=0|^X-Content-Type-Options: nosniff|^Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action http://192.168.4.1; base-uri 'none'; frame-ancestors 'none'" /tmp/openjornada-script-headers.txt
cmp assets/provisioning.js /tmp/openjornada-provisioning.js
```

Expected: the script response is 200, all exact security headers are present, the HTML has no inline script and unknown paths still return 302 to `/`.

- [ ] **Step 5: Probar el recorrido development completo con datos efímeros**

Use a newly created demo terminal key and a disposable demo Wi-Fi credential. On two screens:

1. In Integraciones create a terminal, enter the disposable SSID/password and the private demo URL, generate and expand the QR.
2. Boot the M5Stack into provisioning, join its displayed WPA2 AP from the phone, then scan the Integraciones QR with the native camera.
3. Verify all four fields autofill, the address bar loses `#ojp=`, neither eye submits, and the user can edit the values.
4. Press **Comprobar y guardar**, verify the development `bootstrap`, and perform one harmless demo tag flow.
5. Re-enter provisioning, open an invalid QR fragment, verify all manual fields remain unchanged, then finish successfully through manual entry.
6. Wait ten minutes or temporarily instrument the interval only in a test build: screen sleeps, portal remains reachable, and A/B/C wakes it for a fresh ten-minute interval.

Do not photograph, paste into chat or record the demo password/key in the plan or terminal output.

- [ ] **Step 6: Repetir la aceptación con release y HTTPS**

```bash
cd firmware/terminal
uv tool run --from platformio platformio run -e m5stack_release --target upload \
  --upload-port /dev/serial/by-id/usb-1a86_USB_Single_Serial_5B21222177-if00
```

Generate a new terminal key, provision only against an HTTPS OpenJornada origin with a valid CA chain, verify `bootstrap`, one online action and reboot recovery. Confirm a private HTTP URL is rejected by release even if the QR decoder accepts it for early autofill; C++ remains authoritative.

- [ ] **Step 7: Revocar demo secrets and remove temporary exposure**

From the authenticated Integraciones UI, revoke every terminal credential created by Tasks 5-6. Stop/remove only the explicitly isolated demo and handoff containers/files created for this test after recording non-secret results; do not touch normal PocketBase data. Confirm no temporary page serving credentials is listening and clear only the named captures because the downloaded JavaScript is non-secret but the HTML may include current SSID/base URL values:

```bash
docker inspect openjornada-rfid-demo openjornada-rfid-handoff >/dev/null
test -d /tmp/openjornada-rfid-demo.TmxwgH
docker rm -f openjornada-rfid-demo openjornada-rfid-handoff
rm -rf -- /tmp/openjornada-rfid-demo.TmxwgH
rm -f /tmp/openjornada-portal.html /tmp/openjornada-provisioning.js \
  /tmp/openjornada-portal-headers.txt /tmp/openjornada-script-headers.txt
```

- [ ] **Step 8: Final diff review and delivery report**

```bash
git status --short
git diff --check
git diff --stat
git diff -- web/package.json web/src/app/core/terminal-provisioning-qr.ts \
  web/src/app/features/integrations firmware/terminal/assets/provisioning.js \
  firmware/terminal/src/provisioning/captive_portal.cpp \
  firmware/terminal/include/openjornada/provisioning.hpp \
  firmware/terminal/platformio.ini web/e2e/terminal-provisioning-portal.spec.ts \
  web/e2e/terminal-provisioning-qr.spec.ts README.md docs/FEATURES.md \
  docs/COMPLIANCE_ES.md firmware/terminal/README.md
```

Expected: no secret or `.env` content, no unrelated file staged, no placeholder text, all requested manual/QR paths documented, and the report lists automated commands, hardware results, new release/dev hashes and any remaining limitation.
