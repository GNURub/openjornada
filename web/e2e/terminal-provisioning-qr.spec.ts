import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

test.use({ trace: 'off', screenshot: 'off' });

const apiBase = 'http://127.0.0.1:8090/api';

interface BrowserAuditState {
  baseline: string;
  counts: {
    storageSet: number;
    storageRemove: number;
    storageClear: number;
    cookieSet: number;
    indexedDbOpen: number;
    indexedDbDelete: number;
    indexedDbAdd: number;
    indexedDbPut: number;
    cacheOpen: number;
    cacheDelete: number;
    cacheAdd: number;
    cacheAddAll: number;
    cachePut: number;
  };
}

type AuditedWindow = Window & { __openJornadaProvisioningAudit?: BrowserAuditState };

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@example.com');
  await page.getByLabel('Contraseña').fill('TestPassword123!');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    const authenticated = await page
      .waitForURL(/\/$/u, { timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    if (authenticated) {
      await acknowledgePrivacyNotice(page);
      return;
    }
    if (attempt === 3) throw new Error('No se pudo iniciar sesión como administración');
    await page.waitForTimeout(3_200);
  }
}

async function apiSignIn(request: APIRequestContext): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity: 'admin@example.com', password: 'TestPassword123!' },
    });
    if (response.ok()) return ((await response.json()) as { token: string }).token;
    if (attempt === 3 || response.status() !== 429) {
      throw new Error(`No se pudo autenticar para limpiar terminales E2E: ${response.status()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error('No se pudo autenticar para limpiar terminales E2E');
}

async function revokeActiveTerminalsByName(
  request: APIRequestContext,
  name: string,
): Promise<void> {
  const authorization = await apiSignIn(request);
  const response = await request.get(`${apiBase}/openjornada/terminals`, {
    headers: { Authorization: authorization },
  });
  if (!response.ok()) {
    throw new Error(`No se pudieron listar los terminales para limpiar: ${response.status()}`);
  }
  const { items } = (await response.json()) as {
    items: Array<{ id: string; name: string; revokedAt: string }>;
  };
  for (const terminal of items.filter((item) => item.name === name && !item.revokedAt)) {
    const revoked = await request.post(`${apiBase}/openjornada/terminals/${terminal.id}/revoke`, {
      headers: { Authorization: authorization },
    });
    if (!revoked.ok()) {
      throw new Error(`No se pudo revocar un terminal E2E: ${revoked.status()}`);
    }
  }
}

async function installPersistenceAudit(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const counts: BrowserAuditState['counts'] = {
      storageSet: 0,
      storageRemove: 0,
      storageClear: 0,
      cookieSet: 0,
      indexedDbOpen: 0,
      indexedDbDelete: 0,
      indexedDbAdd: 0,
      indexedDbPut: 0,
      cacheOpen: 0,
      cacheDelete: 0,
      cacheAdd: 0,
      cacheAddAll: 0,
      cachePut: 0,
    };
    const fingerprint = async (): Promise<string> => {
      const entries = (storage: Storage) =>
        Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index) ?? '';
          return [key, storage.getItem(key)] as const;
        }).sort(([left], [right]) => left.localeCompare(right));
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          local: entries(localStorage),
          session: entries(sessionStorage),
          cookie: document.cookie,
        }),
      );
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    };

    const storagePrototype = Storage.prototype;
    const originalSetItem = storagePrototype.setItem;
    const originalRemoveItem = storagePrototype.removeItem;
    const originalClear = storagePrototype.clear;
    storagePrototype.setItem = function (key: string, value: string): void {
      counts.storageSet += 1;
      return originalSetItem.call(this, key, value);
    };
    storagePrototype.removeItem = function (key: string): void {
      counts.storageRemove += 1;
      return originalRemoveItem.call(this, key);
    };
    storagePrototype.clear = function (): void {
      counts.storageClear += 1;
      return originalClear.call(this);
    };

    const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookieDescriptor?.get && cookieDescriptor.set) {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => cookieDescriptor.get?.call(document),
        set: (value: string) => {
          counts.cookieSet += 1;
          cookieDescriptor.set?.call(document, value);
        },
      });
    }

    if (globalThis.indexedDB) {
      const originalOpen = indexedDB.open;
      const originalDeleteDatabase = indexedDB.deleteDatabase;
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value(name: string, version?: number) {
          counts.indexedDbOpen += 1;
          return version === undefined
            ? originalOpen.call(indexedDB, name)
            : originalOpen.call(indexedDB, name, version);
        },
      });
      Object.defineProperty(indexedDB, 'deleteDatabase', {
        configurable: true,
        value(name: string) {
          counts.indexedDbDelete += 1;
          return originalDeleteDatabase.call(indexedDB, name);
        },
      });
    }
    if (globalThis.IDBObjectStore) {
      const originalAdd = IDBObjectStore.prototype.add;
      const originalPut = IDBObjectStore.prototype.put;
      Object.defineProperty(IDBObjectStore.prototype, 'add', {
        configurable: true,
        value(value: unknown, key?: IDBValidKey) {
          counts.indexedDbAdd += 1;
          return key === undefined
            ? originalAdd.call(this, value)
            : originalAdd.call(this, value, key);
        },
      });
      Object.defineProperty(IDBObjectStore.prototype, 'put', {
        configurable: true,
        value(value: unknown, key?: IDBValidKey) {
          counts.indexedDbPut += 1;
          return key === undefined
            ? originalPut.call(this, value)
            : originalPut.call(this, value, key);
        },
      });
    }

    if (globalThis.caches) {
      const cacheStoragePrototype = Object.getPrototypeOf(caches) as CacheStorage;
      const originalCacheOpen = cacheStoragePrototype.open;
      const originalCacheDelete = cacheStoragePrototype.delete;
      Object.defineProperty(cacheStoragePrototype, 'open', {
        configurable: true,
        value(name: string) {
          counts.cacheOpen += 1;
          return originalCacheOpen.call(this, name);
        },
      });
      Object.defineProperty(cacheStoragePrototype, 'delete', {
        configurable: true,
        value(name: string) {
          counts.cacheDelete += 1;
          return originalCacheDelete.call(this, name);
        },
      });
    }
    const cacheConstructor = (globalThis as typeof globalThis & { Cache?: { prototype: Cache } })
      .Cache;
    if (cacheConstructor) {
      const originalCacheAdd = cacheConstructor.prototype.add;
      const originalCacheAddAll = cacheConstructor.prototype.addAll;
      const originalCachePut = cacheConstructor.prototype.put;
      Object.defineProperty(cacheConstructor.prototype, 'add', {
        configurable: true,
        value(request: RequestInfo | URL) {
          counts.cacheAdd += 1;
          return originalCacheAdd.call(this, request);
        },
      });
      Object.defineProperty(cacheConstructor.prototype, 'addAll', {
        configurable: true,
        value(requests: RequestInfo[]) {
          counts.cacheAddAll += 1;
          return originalCacheAddAll.call(this, requests);
        },
      });
      Object.defineProperty(cacheConstructor.prototype, 'put', {
        configurable: true,
        value(request: RequestInfo | URL, response: Response) {
          counts.cachePut += 1;
          return originalCachePut.call(this, request, response);
        },
      });
    }

    (window as AuditedWindow).__openJornadaProvisioningAudit = {
      baseline: await fingerprint(),
      counts,
    };
  });
}

async function persistenceMatchesBaseline(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const audit = (window as AuditedWindow).__openJornadaProvisioningAudit;
    if (!audit) return false;
    const entries = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) ?? '';
        return [key, storage.getItem(key)] as const;
      }).sort(([left], [right]) => left.localeCompare(right));
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        local: entries(localStorage),
        session: entries(sessionStorage),
        cookie: document.cookie,
      }),
    );
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const current = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return current === audit.baseline;
  });
}

async function persistenceAttemptCounts(page: Page): Promise<BrowserAuditState['counts'] | null> {
  return page.evaluate(
    () => (window as AuditedWindow).__openJornadaProvisioningAudit?.counts ?? null,
  );
}

async function terminalTokenFingerprint(
  input: Locator,
): Promise<{ valid: boolean; digest: string }> {
  return input.evaluate(async (element) => {
    const value = (element as HTMLInputElement).value;
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    );
    return {
      valid: /^ojterm_[A-Za-z0-9_-]+$/u.test(value),
      digest: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  });
}

async function pageHasFullTokenInInputs(page: Page): Promise<boolean> {
  return page
    .locator('input')
    .evaluateAll((inputs) =>
      inputs.some((input) => /ojterm_[A-Za-z0-9_-]{40,}/u.test((input as HTMLInputElement).value)),
    );
}

async function locatorContainsFullToken(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) =>
    /ojterm_[A-Za-z0-9_-]{40,}/u.test(element.textContent ?? ''),
  );
}

async function locatorHasSvgDataUrl(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) =>
      element instanceof HTMLImageElement && element.src.startsWith('data:image/svg+xml;base64,'),
  );
}

async function dismissProvisioningIfVisible(page: Page): Promise<void> {
  const button = page
    .getByRole('region', { name: 'Aprovisionar terminal con QR' })
    .getByRole('button', { name: 'Ya la he guardado' });
  if (await button.isVisible().catch(() => false)) {
    await button.click({ force: true, timeout: 2_000 });
  }
}

const noPersistenceAttempts: BrowserAuditState['counts'] = {
  storageSet: 0,
  storageRemove: 0,
  storageClear: 0,
  cookieSet: 0,
  indexedDbOpen: 0,
  indexedDbDelete: 0,
  indexedDbAdd: 0,
  indexedDbPut: 0,
  cacheOpen: 0,
  cacheDelete: 0,
  cacheAdd: 0,
  cacheAddAll: 0,
  cachePut: 0,
};

test('administración aprovisiona por QR sin persistir secretos ni perder el flujo manual', async ({
  page,
  request,
}, testInfo) => {
  await signIn(page);
  await page.goto('/integraciones');
  await page.waitForLoadState('networkidle');
  await installPersistenceAudit(page);

  const name = `QR E2E ${testInfo.project.name} ${Date.now()}`;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    let requestCount = 0;
    let creationRequestCount = 0;
    let unexpectedRequest = false;
    const apiOrigin = new URL(apiBase).origin;
    const requestListener = (browserRequest: import('@playwright/test').Request): void => {
      requestCount += 1;
      const requestUrl = new URL(browserRequest.url());
      const isCreation =
        browserRequest.method() === 'POST' &&
        requestUrl.origin === apiOrigin &&
        requestUrl.pathname === '/api/openjornada/terminals';
      if (isCreation) creationRequestCount += 1;
      else unexpectedRequest = true;
    };
    page.on('request', requestListener);
    await page.getByLabel('Nombre del nuevo terminal').fill(name);
    await page.getByRole('button', { name: 'Crear terminal' }).click();

    let card = page.getByRole('region', { name: 'Aprovisionar terminal con QR' });
    await expect(card).toBeVisible();
    await expect(
      card.getByText('el QR contiene la contraseña Wi-Fi y la API key completas'),
    ).toBeVisible();

    const tokenInput = card.getByLabel('API key del terminal recién emitida');
    const initialToken = await terminalTokenFingerprint(tokenInput);
    expect(initialToken.valid).toBe(true);
    await expect(tokenInput).toHaveAttribute('type', 'password');
    await expect(card.getByLabel('Contraseña de la red Wi-Fi')).toHaveAttribute('type', 'password');
    expect(await persistenceAttemptCounts(page)).toEqual(noPersistenceAttempts);
    expect(await persistenceMatchesBaseline(page)).toBe(true);
    expect(requestCount).toBe(1);
    expect(creationRequestCount).toBe(1);
    expect(unexpectedRequest).toBe(false);

    const requestCountAfterCreate = requestCount;
    await card.getByLabel('Nombre de la red Wi-Fi').fill('Red demo efímera');
    await card.getByLabel('Contraseña de la red Wi-Fi').fill('Clave demo efímera 123!');
    await card.getByLabel('URL de OpenJornada').fill('https://jornada.example.com');
    await card.getByRole('button', { name: 'Generar QR' }).click();

    const qr = card.getByAltText('Código QR para configurar el terminal OpenJornada');
    await expect.poll(() => locatorHasSvgDataUrl(qr)).toBe(true);
    expect(requestCount).toBe(requestCountAfterCreate);
    expect(await persistenceMatchesBaseline(page)).toBe(true);
    expect(await persistenceAttemptCounts(page)).toEqual(noPersistenceAttempts);
    page.off('request', requestListener);

    const expand = card.getByRole('button', { name: 'Ampliar código QR' });
    await expand.click();
    const dialog = page.getByRole('dialog', { name: 'Código QR ampliado' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cerrar QR ampliado' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(expand).toBeFocused();

    await card.getByRole('button', { name: 'Ya la he guardado' }).click();
    await expect(card).toHaveCount(0);
    expect(await pageHasFullTokenInInputs(page)).toBe(false);
    expect(await persistenceMatchesBaseline(page)).toBe(true);
    expect(await persistenceAttemptCounts(page)).toEqual(noPersistenceAttempts);

    const row = page.locator('li').filter({ hasText: name }).first();
    await expect(row).toBeVisible();
    expect(await locatorContainsFullToken(row)).toBe(false);
    await expect(row).not.toContainText('Red demo efímera');
    await expect(row).not.toContainText('Clave demo efímera 123!');

    page.once('dialog', (confirmation) => confirmation.accept());
    await row.getByRole('button', { name: 'Rotar key' }).click();
    card = page.getByRole('region', { name: 'Aprovisionar terminal con QR' });
    await expect(card).toBeVisible();

    const rotatedToken = await terminalTokenFingerprint(
      card.getByLabel('API key del terminal recién emitida'),
    );
    expect(rotatedToken.valid).toBe(true);
    expect(rotatedToken.digest === initialToken.digest).toBe(false);
    await expect(card.getByLabel('Nombre de la red Wi-Fi')).toHaveValue('');
    await expect(card.getByLabel('Contraseña de la red Wi-Fi')).toHaveValue('');
    await expect(card.getByLabel('URL de OpenJornada')).toHaveValue('http://127.0.0.1:4217');
    await expect(
      card.getByAltText('Código QR para configurar el terminal OpenJornada'),
    ).toHaveCount(0);
    expect(await locatorContainsFullToken(row)).toBe(false);
    expect(await persistenceMatchesBaseline(page)).toBe(true);
    expect(await persistenceAttemptCounts(page)).toEqual(noPersistenceAttempts);

    await card.getByRole('button', { name: 'Ya la he guardado' }).click();
    await expect(card).toHaveCount(0);
    expect(await pageHasFullTokenInInputs(page)).toBe(false);
    expect(await persistenceMatchesBaseline(page)).toBe(true);
    expect(await persistenceAttemptCounts(page)).toEqual(noPersistenceAttempts);
    page.once('dialog', (confirmation) => confirmation.accept());
    await row.getByRole('button', { name: 'Revocar' }).click();
    await expect(row.getByText('Revocado')).toBeVisible();
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      await dismissProvisioningIfVisible(page);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await revokeActiveTerminalsByName(request, name);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      'Fallaron el recorrido y la limpieza del terminal E2E',
    );
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Falló la limpieza del terminal E2E');
  }
});

test('pagehide elimina el aprovisionamiento antes de una restauración del historial', async ({
  page,
  request,
}, testInfo) => {
  await signIn(page);
  await page.goto('/integraciones');
  await page.waitForLoadState('networkidle');

  const name = `QR BFCache ${testInfo.project.name} ${Date.now()}`;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await page.getByLabel('Nombre del nuevo terminal').fill(name);
    await page.getByRole('button', { name: 'Crear terminal' }).click();

    const card = page.getByRole('region', { name: 'Aprovisionar terminal con QR' });
    await expect(card).toBeVisible();
    expect(
      (await terminalTokenFingerprint(card.getByLabel('API key del terminal recién emitida')))
        .valid,
    ).toBe(true);
    await card.getByLabel('Nombre de la red Wi-Fi').fill('Red BFCache efímera');
    await card.getByLabel('Contraseña de la red Wi-Fi').fill('Clave BFCache efímera 123!');
    await card.getByLabel('URL de OpenJornada').fill('https://jornada.example.com');
    await card.getByRole('button', { name: 'Generar QR' }).click();
    await expect
      .poll(() =>
        locatorHasSvgDataUrl(
          card.getByAltText('Código QR para configurar el terminal OpenJornada'),
        ),
      )
      .toBe(true);

    await page.evaluate(() => {
      window.addEventListener(
        'pagehide',
        () => {
          localStorage.setItem('openjornada:e2e:pagehide', '1');
        },
        { once: true },
      );
    });
    await page.goto(`/manifest.json?terminal-bfcache=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(
      await page.evaluate(() => localStorage.getItem('openjornada:e2e:pagehide') === '1'),
    ).toBe(true);
    await page.evaluate(() => localStorage.removeItem('openjornada:e2e:pagehide'));

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/integraciones$/u);
    await expect(page.getByRole('heading', { name: 'Integraciones', level: 1 })).toBeVisible();

    const restored = await page.evaluate(() => {
      const inputValues = Array.from(
        document.querySelectorAll<HTMLInputElement>('input'),
        (input) => input.value,
      );
      const result = {
        hasProvisioningCard: document.querySelector('app-terminal-provisioning-card') !== null,
        hasFullTerminalToken:
          inputValues.some((value) => /ojterm_[A-Za-z0-9_-]{40,}/u.test(value)) ||
          /ojterm_[A-Za-z0-9_-]{40,}/u.test(document.body.textContent ?? ''),
        hasWifiPassword: inputValues.includes('Clave BFCache efímera 123!'),
        hasSsid: inputValues.includes('Red BFCache efímera'),
        hasProvisioningQr:
          document.querySelector('img[alt="Código QR para configurar el terminal OpenJornada"]') !==
          null,
      };
      return result;
    });
    expect(restored).toEqual({
      hasProvisioningCard: false,
      hasFullTerminalToken: false,
      hasWifiPassword: false,
      hasSsid: false,
      hasProvisioningQr: false,
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    await page
      .evaluate(() => localStorage.removeItem('openjornada:e2e:pagehide'))
      .catch(() => undefined);
    try {
      await dismissProvisioningIfVisible(page);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await revokeActiveTerminalsByName(request, name);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      'Fallaron la navegación segura y la limpieza del terminal E2E',
    );
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Falló la limpieza del terminal E2E');
  }
});
