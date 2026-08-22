import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { TERMINAL_PROVISIONING_V1_VECTOR } from '../src/app/core/terminal-provisioning-qr.fixture';

const scriptPath = resolve(process.cwd(), '../firmware/terminal/assets/provisioning.js');
const manualValues = {
  ssid: 'manual-ssid',
  wifiPassword: 'manual-password',
  baseUrl: 'https://manual.example.com',
  terminalToken: 'ojterm_manual_token',
} as const;

const portalHtml = `<!doctype html><html lang="es"><body>
  <form id="provisioning_form">
    <input id="ssid" value="${manualValues.ssid}">
    <input id="wifi_password" type="password" value="${manualValues.wifiPassword}">
    <input id="base_url" value="${manualValues.baseUrl}">
    <input id="terminal_token" type="password" value="${manualValues.terminalToken}">
    <button id="toggle_wifi_password" data-target="wifi_password" type="button" aria-label="Mostrar contraseña Wi-Fi" aria-pressed="false">ojo</button>
    <button id="toggle_terminal_token" data-target="terminal_token" type="button" aria-label="Mostrar API key del terminal" aria-pressed="false">ojo</button>
    <button type="submit">Comprobar y guardar</button>
  </form>
  <p id="qr_status" hidden></p>
</body></html>`;

async function routePortal(page: Page, body = portalHtml): Promise<void> {
  await page.route('http://192.168.4.1/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body,
    }),
  );
}

interface SideEffectObserver {
  requests: string[];
  logs: string[];
  webSockets: string[];
}

async function installSideEffectGuards(page: Page): Promise<SideEffectObserver> {
  const observer: SideEffectObserver = { requests: [], logs: [], webSockets: [] };
  page.on('request', (request) => observer.requests.push(request.url()));
  page.on('console', (message) => observer.logs.push(message.text()));
  page.on('websocket', (socket) => observer.webSockets.push(socket.url()));

  await page.evaluate(() => {
    const state = window as typeof window & {
      forbiddenEffects: string[];
      submitCount: number;
    };
    state.forbiddenEffects = [];
    state.submitCount = 0;
    const record = (effect: string): void => {
      state.forbiddenEffects.push(effect);
    };

    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      state.submitCount += 1;
    });

    window.fetch = () => {
      record('fetch');
      return Promise.reject(new Error('blocked by test'));
    };
    XMLHttpRequest.prototype.open = function () {
      record('XMLHttpRequest.open');
      throw new Error('blocked by test');
    };
    navigator.sendBeacon = () => {
      record('sendBeacon');
      return false;
    };

    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      console[method] = () => record(`console.${method}`);
    }

    Storage.prototype.setItem = function () {
      record(this === localStorage ? 'localStorage.setItem' : 'sessionStorage.setItem');
    };
    Storage.prototype.removeItem = function () {
      record(this === localStorage ? 'localStorage.removeItem' : 'sessionStorage.removeItem');
    };
    Storage.prototype.clear = function () {
      record(this === localStorage ? 'localStorage.clear' : 'sessionStorage.clear');
    };

    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookie?.set) {
      Object.defineProperty(Document.prototype, 'cookie', {
        ...cookie,
        set: () => record('document.cookie'),
      });
    }

    IDBFactory.prototype.open = function () {
      record('indexedDB.open');
      throw new Error('blocked by test');
    };
    IDBFactory.prototype.deleteDatabase = function () {
      record('indexedDB.deleteDatabase');
      throw new Error('blocked by test');
    };

    if (typeof CacheStorage !== 'undefined') {
      CacheStorage.prototype.open = function () {
        record('caches.open');
        return Promise.reject(new Error('blocked by test'));
      };
      CacheStorage.prototype.delete = function () {
        record('caches.delete');
        return Promise.reject(new Error('blocked by test'));
      };
    }
  });

  return observer;
}

async function expectNoForbiddenEffects(page: Page, observer: SideEffectObserver): Promise<void> {
  expect(observer.requests).toEqual([]);
  expect(observer.logs).toEqual([]);
  expect(observer.webSockets).toEqual([]);
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & {
        forbiddenEffects: string[];
        submitCount: number;
      };
      return {
        forbiddenEffects: state.forbiddenEffects,
        submitCount: state.submitCount,
      };
    }),
  ).toEqual({ forbiddenEffects: [], submitCount: 0 });
  expect(await page.context().cookies()).toEqual([]);
}

async function openPortal(
  page: Page,
  hash: string,
  body = portalHtml,
): Promise<SideEffectObserver> {
  await routePortal(page, body);
  await page.goto(`http://192.168.4.1/${hash}`);
  const observer = await installSideEffectGuards(page);
  await page.addScriptTag({ path: scriptPath });
  return observer;
}

function hashFromJson(json: string): string {
  return `#ojp=${Buffer.from(json, 'utf8').toString('base64url')}`;
}

async function expectManualValues(page: Page): Promise<void> {
  await expect(page.locator('#ssid')).toHaveValue(manualValues.ssid);
  await expect(page.locator('#wifi_password')).toHaveValue(manualValues.wifiPassword);
  await expect(page.locator('#base_url')).toHaveValue(manualValues.baseUrl);
  await expect(page.locator('#terminal_token')).toHaveValue(manualValues.terminalToken);
}

test('applies the exact vector atomically, clears the fragment and never submits', async ({
  page,
}) => {
  await routePortal(page);
  await page.goto(TERMINAL_PROVISIONING_V1_VECTOR.url);
  const observer = await installSideEffectGuards(page);
  await page.addScriptTag({ path: scriptPath });

  await expect(page.locator('#ssid')).toHaveValue('Red Demo');
  await expect(page.locator('#wifi_password')).toHaveValue('Clave WiFi 123!');
  await expect(page.locator('#base_url')).toHaveValue('https://jornada.example.com');
  await expect(page.locator('#terminal_token')).toHaveValue('ojterm_demo_1234567890');
  await expect(page).toHaveURL('http://192.168.4.1/');
  await expect(page.locator('#qr_status')).toHaveText(
    'Configuración leída. Revisa los datos y pulsa Comprobar y guardar.',
  );
  await expect(page.locator('#qr_status')).toHaveAttribute('role', 'status');
  await expectNoForbiddenEffects(page, observer);
});

test('accepts a canonical provisioning URL of exactly 600 bytes', async ({ page }) => {
  const hash = hashFromJson(
    JSON.stringify({
      v: 1,
      s: 's',
      p: 'p'.repeat(60),
      u: `https://example.com/${'u'.repeat(220)}`,
      t: `ojterm_${'t'.repeat(89)}`,
    }),
  );
  expect(Buffer.byteLength(`http://192.168.4.1/${hash}`, 'ascii')).toBe(600);

  const observer = await openPortal(page, hash);

  await expect(page.locator('#ssid')).toHaveValue('s');
  await expect(page.locator('#qr_status')).toHaveAttribute('role', 'status');
  await expect(page).toHaveURL('http://192.168.4.1/');
  await expectNoForbiddenEffects(page, observer);
});

const validBoundaryValues = [
  {
    name: 'SSID de 32 bytes',
    value: {
      v: 1,
      s: 's'.repeat(32),
      p: '',
      u: 'https://jornada.example.com',
      t: 'ojterm_test',
    },
  },
  {
    name: 'SSID Unicode de 32 bytes',
    value: {
      v: 1,
      s: 'ñ'.repeat(16),
      p: '',
      u: 'https://jornada.example.com',
      t: 'ojterm_test',
    },
  },
  {
    name: 'contraseña de 63 bytes',
    value: {
      v: 1,
      s: 'Red',
      p: 'p'.repeat(63),
      u: 'https://jornada.example.com',
      t: 'ojterm_test',
    },
  },
  {
    name: 'contraseña Unicode de 63 bytes',
    value: {
      v: 1,
      s: 'Red',
      p: `${'🔐'.repeat(15)}abc`,
      u: 'https://jornada.example.com',
      t: 'ojterm_test',
    },
  },
  {
    name: 'contraseña vacía',
    value: {
      v: 1,
      s: 'Red abierta',
      p: '',
      u: 'https://jornada.example.com',
      t: 'ojterm_test',
    },
  },
  {
    name: 'URL de 255 bytes',
    value: {
      v: 1,
      s: 'Red',
      p: '',
      u: `https://example.com/${'u'.repeat(235)}`,
      t: 'ojterm_test',
    },
  },
] as const;

for (const { name, value } of validBoundaryValues) {
  test(`accepts ${name}`, async ({ page }) => {
    const observer = await openPortal(page, hashFromJson(JSON.stringify(value)));

    await expect(page.locator('#ssid')).toHaveValue(value.s);
    await expect(page.locator('#wifi_password')).toHaveValue(value.p);
    await expect(page.locator('#base_url')).toHaveValue(value.u);
    await expect(page.locator('#terminal_token')).toHaveValue(value.t);
    await expect(page.locator('#qr_status')).toHaveAttribute('role', 'status');
    await expect(page).toHaveURL('http://192.168.4.1/');
    await expectNoForbiddenEffects(page, observer);
  });
}

const invalidHashes = [
  ['payload vacío', '#ojp='],
  ['Base64 inválido', '#ojp=%%%'],
  [
    'Base64 con padding',
    `${TERMINAL_PROVISIONING_V1_VECTOR.url.split('#', 2)[1]}=`.replace(/^/, '#'),
  ],
  [
    'Base64 no canónico',
    `${TERMINAL_PROVISIONING_V1_VECTOR.url.split('#', 2)[1].slice(0, -1)}1`.replace(/^/, '#'),
  ],
  ['URL QR excedida', `#ojp=${'A'.repeat(577)}`],
  ['UTF-8 inválido', `#ojp=${Buffer.from([0xc3, 0x28]).toString('base64url')}`],
  ['JSON inválido', hashFromJson('{')],
  ['JSON array', hashFromJson('[1,2,3]')],
  [
    'claves reordenadas',
    hashFromJson('{"s":"Red","v":1,"p":"","u":"https://jornada.example.com","t":"ojterm_test"}'),
  ],
  [
    'clave duplicada',
    hashFromJson(
      '{"v":1,"s":"Red","s":"Otra","p":"","u":"https://jornada.example.com","t":"ojterm_test"}',
    ),
  ],
  [
    'clave extra',
    hashFromJson(
      '{"v":1,"s":"Red","p":"","u":"https://jornada.example.com","t":"ojterm_test","x":1}',
    ),
  ],
  ['clave ausente', hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com"}')],
  [
    'JSON no canónico con espacios',
    hashFromJson('{"v": 1,"s":"Red","p":"","u":"https://jornada.example.com","t":"ojterm_test"}'),
  ],
  [
    'escape JSON ambiguo',
    hashFromJson(
      '{"v":1,"s":"\\u0052ed","p":"","u":"https://jornada.example.com","t":"ojterm_test"}',
    ),
  ],
  [
    'versión desconocida',
    hashFromJson('{"v":2,"s":"Red","p":"","u":"https://jornada.example.com","t":"ojterm_test"}'),
  ],
  [
    'tipo incorrecto',
    hashFromJson('{"v":1,"s":7,"p":"","u":"https://jornada.example.com","t":"ojterm_test"}'),
  ],
  [
    'SSID vacío',
    hashFromJson('{"v":1,"s":"","p":"","u":"https://jornada.example.com","t":"ojterm_test"}'),
  ],
  [
    'SSID excedido',
    hashFromJson(
      JSON.stringify({
        v: 1,
        s: 'x'.repeat(33),
        p: '',
        u: 'https://jornada.example.com',
        t: 'ojterm_test',
      }),
    ),
  ],
  [
    'SSID UTF-8 excedido',
    hashFromJson(
      JSON.stringify({
        v: 1,
        s: 'ñ'.repeat(17),
        p: '',
        u: 'https://jornada.example.com',
        t: 'ojterm_test',
      }),
    ),
  ],
  [
    'contraseña excedida',
    hashFromJson(
      JSON.stringify({
        v: 1,
        s: 'Red',
        p: 'x'.repeat(64),
        u: 'https://jornada.example.com',
        t: 'ojterm_test',
      }),
    ),
  ],
  [
    'contraseña UTF-8 excedida',
    hashFromJson(
      JSON.stringify({
        v: 1,
        s: 'Red',
        p: '🔐'.repeat(16),
        u: 'https://jornada.example.com',
        t: 'ojterm_test',
      }),
    ),
  ],
  ['URL vacía', hashFromJson('{"v":1,"s":"Red","p":"","u":"","t":"ojterm_test"}')],
  [
    'URL excedida',
    hashFromJson(
      JSON.stringify({
        v: 1,
        s: 'Red',
        p: '',
        u: `https://example.com/${'x'.repeat(236)}`,
        t: 'ojterm_test',
      }),
    ),
  ],
  [
    'token vacío',
    hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com","t":""}'),
  ],
  [
    'token sin sufijo',
    hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com","t":"ojterm_"}'),
  ],
  [
    'token excedido',
    hashFromJson(
      JSON.stringify({
        v: 1,
        s: 'Red',
        p: '',
        u: 'https://jornada.example.com',
        t: `ojterm_${'x'.repeat(90)}`,
      }),
    ),
  ],
  [
    'URL inválida',
    hashFromJson('{"v":1,"s":"Red","p":"","u":"ftp://jornada.example.com","t":"ojterm_test"}'),
  ],
  [
    'URL con credenciales',
    hashFromJson(
      '{"v":1,"s":"Red","p":"","u":"https://user:pass@jornada.example.com","t":"ojterm_test"}',
    ),
  ],
  [
    'URL con consulta',
    hashFromJson(
      '{"v":1,"s":"Red","p":"","u":"https://jornada.example.com?x=1","t":"ojterm_test"}',
    ),
  ],
  [
    'URL con fragmento',
    hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com/#x","t":"ojterm_test"}'),
  ],
  [
    'URL con barra invertida',
    hashFromJson(
      '{"v":1,"s":"Red","p":"","u":"https://jornada.example.com\\\\x","t":"ojterm_test"}',
    ),
  ],
  [
    'token inválido',
    hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com","t":"incorrecto"}'),
  ],
  [
    'token no ASCII',
    hashFromJson('{"v":1,"s":"Red","p":"","u":"https://jornada.example.com","t":"ojterm_ñ"}'),
  ],
  [
    'texto prohibido',
    hashFromJson(
      '{"v":1,"s":"Red\\nDemo","p":"","u":"https://jornada.example.com","t":"ojterm_test"}',
    ),
  ],
] as const;

for (const [name, hash] of invalidHashes) {
  test(`rejects ${name} without partially changing manual fields`, async ({ page }) => {
    const observer = await openPortal(page, hash);
    await expectManualValues(page);
    await expect(page.locator('#qr_status')).toHaveText(
      'No se pudo leer la configuración del QR. Introduce los datos manualmente.',
    );
    await expect(page.locator('#qr_status')).toHaveAttribute('role', 'alert');
    await expect(page).toHaveURL('http://192.168.4.1/');
    await expectNoForbiddenEffects(page, observer);
  });
}

test('keeps all manual fields intact when a required target is missing', async ({ page }) => {
  const observer = await openPortal(
    page,
    new URL(TERMINAL_PROVISIONING_V1_VECTOR.url).hash,
    portalHtml.replace('<input id="base_url" value="https://manual.example.com">', ''),
  );

  await expect(page.locator('#ssid')).toHaveValue(manualValues.ssid);
  await expect(page.locator('#wifi_password')).toHaveValue(manualValues.wifiPassword);
  await expect(page.locator('#terminal_token')).toHaveValue(manualValues.terminalToken);
  await expect(page.locator('#qr_status')).toHaveAttribute('role', 'alert');
  await expect(page).toHaveURL('http://192.168.4.1/');
  await expectNoForbiddenEffects(page, observer);
});

test('leaves an unrelated fragment and the manual form untouched', async ({ page }) => {
  const observer = await openPortal(page, '#otra-cosa');
  await expectManualValues(page);
  await expect(page.locator('#qr_status')).toBeHidden();
  await expect(page).toHaveURL('http://192.168.4.1/#otra-cosa');
  await expectNoForbiddenEffects(page, observer);
});

test('exposes a frozen decoder API without exposing decoded secrets in page text', async ({
  page,
}) => {
  const observer = await openPortal(page, '');

  const result = await page.evaluate((hash) => {
    const api = (
      window as typeof window & {
        OpenJornadaProvisioning: {
          decodeProvisioningHash(value: string): unknown;
          init(): void;
        };
      }
    ).OpenJornadaProvisioning;
    return {
      frozen: Object.isFrozen(api),
      decoded: api.decodeProvisioningHash(hash),
    };
  }, new URL(TERMINAL_PROVISIONING_V1_VECTOR.url).hash);

  expect(result.frozen).toBe(true);
  expect(result.decoded).toEqual(TERMINAL_PROVISIONING_V1_VECTOR.input);
  await expect(page.locator('body')).not.toContainText('Clave WiFi 123!');
  await expect(page.locator('body')).not.toContainText('ojterm_demo_1234567890');
  await expectNoForbiddenEffects(page, observer);
});

test('toggles both secrets once after reinitializing, accessibly and without submitting', async ({
  page,
}) => {
  const observer = await openPortal(page, '');
  await expect(page.locator('#qr_status')).toBeHidden();
  await page.evaluate(() => {
    (
      window as typeof window & {
        OpenJornadaProvisioning: { init(): void };
      }
    ).OpenJornadaProvisioning.init();
  });

  for (const [buttonId, fieldId, shown, hidden] of [
    [
      'toggle_wifi_password',
      'wifi_password',
      'Mostrar contraseña Wi-Fi',
      'Ocultar contraseña Wi-Fi',
    ],
    [
      'toggle_terminal_token',
      'terminal_token',
      'Mostrar API key del terminal',
      'Ocultar API key del terminal',
    ],
  ] as const) {
    const button = page.locator(`#${buttonId}`);
    const field = page.locator(`#${fieldId}`);
    await expect(button).toHaveAttribute('type', 'button');
    await expect(button).toHaveAttribute('aria-label', shown);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(field).toHaveAttribute('type', 'text');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveAttribute('aria-label', hidden);
    await button.click();
    await expect(field).toHaveAttribute('type', 'password');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(button).toHaveAttribute('aria-label', shown);
  }

  await expectNoForbiddenEffects(page, observer);
});
