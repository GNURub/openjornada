import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const apiBase = 'http://127.0.0.1:8090/api';
const adminIdentity = 'admin@example.com';
const adminPassword = 'TestPassword123!';

interface Session {
  token: string;
  record: { id: string; organization: string };
}

interface CreatedTerminal {
  id: string;
  token: string;
}

interface CleanupResponse {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
}

interface CleanupAttempt {
  label: string;
  run(): Promise<CleanupResponse>;
}

const cleanupSecretKey = /authorization|password|secret|token|api.?key/iu;
const cleanupSecretValue = /bearer\s+|ojterm_/iu;

function redactCleanupBody(raw: string): string {
  try {
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      if (typeof value === 'string' && cleanupSecretValue.test(value)) return '[REDACTADO]';
      if (typeof value !== 'object' || value === null) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          cleanupSecretKey.test(key) ? '[REDACTADO]' : redact(nested),
        ]),
      );
    };
    return JSON.stringify(redact(JSON.parse(raw))).slice(0, 2_000);
  } catch {
    return '<cuerpo no JSON omitido por seguridad>';
  }
}

async function cleanupFixtures(attempts: CleanupAttempt[]): Promise<void> {
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const response = await attempt.run();
      if (!response.ok()) {
        let body = '<cuerpo no disponible>';
        try {
          body = redactCleanupBody(await response.text());
        } catch {
          // Conserva el status aunque no pueda leerse la respuesta.
        }
        failures.push(`${attempt.label}: HTTP ${response.status()}; body=${body}`);
      }
    } catch {
      failures.push(`${attempt.label}: error de transporte sin respuesta HTTP`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Falló la limpieza de fixtures de telemetría:\n${failures.join('\n')}`);
  }
}

async function apiSignIn(
  request: APIRequestContext,
  identity: string,
  password: string,
): Promise<Session> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity, password },
    });
    if (response.ok()) return (await response.json()) as Session;
    if (attempt === 3 || response.status() !== 429) {
      throw new Error(
        `No se pudo autenticar ${identity}: ${response.status()} ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${identity}`);
}

async function browserSignIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(adminIdentity);
  await page.getByLabel('Contraseña').fill(adminPassword);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await acknowledgePrivacyNotice(page);
}

async function createUser(
  request: APIRequestContext,
  admin: Session,
  suffix: string,
  role: 'manager' | 'employee',
): Promise<{ id: string; email: string; password: string }> {
  const password = `Telemetry-${role}-Password123!`;
  const email = `telemetry-${role}-${suffix}@example.com`;
  const response = await request.post(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name:
        role === 'manager' ? `Responsable telemetría ${suffix}` : `Empleado telemetría ${suffix}`,
      email,
      password,
      passwordConfirm: password,
      employeeCode: `TEL-${role === 'manager' ? 'M' : 'E'}-${suffix}`,
      jobTitle: role === 'manager' ? 'Responsable' : 'Pruebas',
      weeklyHours: 40,
      contractedWeeklyMinutes: 2400,
      employmentType: 'full_time',
      scheduleMode: 'scheduled',
      flexibleWeekdays: [1, 2, 3, 4, 5],
      role,
      active: true,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const user = (await response.json()) as { id: string };
  return { id: user.id, email, password };
}

async function createTerminal(
  request: APIRequestContext,
  admin: Session,
  name: string,
): Promise<CreatedTerminal> {
  const response = await request.post(`${apiBase}/openjornada/terminals`, {
    headers: { Authorization: admin.token },
    data: { name },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as CreatedTerminal;
}

function heartbeatData() {
  return {
    protocolVersion: 1,
    clientVersion: 'e2e-telemetry-1.0.0',
    cacheRevision: 3,
    pendingCount: 0,
    wifiRssiDbm: -62,
    uptimeSeconds: 7200,
    clockStatus: 'synced',
    lastNtpSyncAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

function terminalFixture(
  id: string,
  name: string,
  connectionStatus: 'online' | 'offline' | 'revoked',
) {
  const hasTelemetry = connectionStatus === 'online';
  return {
    id,
    organization: 'organization-1',
    name,
    prefix: `prefix-${id}`,
    protocolVersion: 1,
    clientVersion: hasTelemetry ? '1.2.3' : '',
    cacheRevision: hasTelemetry ? 7 : 0,
    lastSeenAt: hasTelemetry ? '2026-08-27T10:00:00.000Z' : '',
    lastPendingCount: 0,
    revokedAt: connectionStatus === 'revoked' ? '2026-08-27T10:01:00.000Z' : '',
    connectionStatus,
    lastHeartbeatAt: hasTelemetry ? '2026-08-27T10:00:00.000Z' : '',
    lastAttendanceSyncAt: hasTelemetry ? '2026-08-27T09:59:30.000Z' : '',
    lastClockStatus: hasTelemetry ? 'synced' : '',
    lastNtpSyncAt: hasTelemetry ? '2026-08-27T09:59:00.000Z' : '',
    lastWifiRssiDbm: hasTelemetry ? -62 : null,
    lastUptimeSeconds: hasTelemetry ? 7200 : null,
    createdBy: 'admin-1',
    created: '2026-08-27T09:00:00.000Z',
  };
}

test('intenta toda la limpieza y agrega fallos sin exponer secretos', async () => {
  const attempted: string[] = [];
  const response = (status: number, body: string): CleanupResponse => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: async () => body,
  });
  let cleanupError: unknown;

  try {
    await cleanupFixtures([
      {
        label: 'revocar terminal terminal-a',
        run: async () => {
          attempted.push('terminal-a');
          return response(
            500,
            JSON.stringify({ message: 'fallo controlado', token: 'secreto', data: {} }),
          );
        },
      },
      {
        label: 'desactivar usuario user-a',
        run: async () => {
          attempted.push('user-a');
          throw new Error('fallo de red con otro-secreto');
        },
      },
      {
        label: 'desactivar usuario user-b',
        run: async () => {
          attempted.push('user-b');
          return response(200, '{}');
        },
      },
    ]);
  } catch (error) {
    cleanupError = error;
  }

  const message = cleanupError instanceof Error ? cleanupError.message : '';
  expect(attempted).toEqual(['terminal-a', 'user-a', 'user-b']);
  expect(message).toContain('revocar terminal terminal-a: HTTP 500');
  expect(message).toContain('"message":"fallo controlado"');
  expect(message).toContain('desactivar usuario user-a: error de transporte');
  expect(message).not.toContain('secreto');
});

test('completa el reto de ping y aplica permisos, revocación, timeout y privacidad', async ({
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'El contrato API se valida una vez.');
  test.setTimeout(75_000);

  const admin = await apiSignIn(request, adminIdentity, adminPassword);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const terminalIds: string[] = [];
  const userIds: string[] = [];
  let originalFailure: unknown;
  let hasOriginalFailure = false;

  try {
    const managerUser = await createUser(request, admin, suffix, 'manager');
    userIds.push(managerUser.id);
    const employeeUser = await createUser(request, admin, suffix, 'employee');
    userIds.push(employeeUser.id);
    const manager = await apiSignIn(request, managerUser.email, managerUser.password);
    const employee = await apiSignIn(request, employeeUser.email, employeeUser.password);

    const responsiveTerminal = await createTerminal(
      request,
      admin,
      `Recepción telemetría ${suffix}`,
    );
    terminalIds.push(responsiveTerminal.id);
    const timeoutTerminal = await createTerminal(request, admin, `Almacén telemetría ${suffix}`);
    terminalIds.push(timeoutTerminal.id);

    const forbidden = await request.post(
      `${apiBase}/openjornada/terminals/${responsiveTerminal.id}/ping`,
      { headers: { Authorization: employee.token } },
    );
    expect(forbidden.status()).toBe(403);

    const unknown = await request.post(`${apiBase}/openjornada/terminals/zzzzzzzzzzzzzzz/ping`, {
      headers: { Authorization: manager.token },
    });
    expect(unknown.status()).toBe(404);

    const pingPromise = request.post(
      `${apiBase}/openjornada/terminals/${responsiveTerminal.id}/ping`,
      { headers: { Authorization: manager.token }, timeout: 25_000 },
    );
    let pingChallenge = '';
    await expect
      .poll(
        async () => {
          const heartbeat = await request.post(`${apiBase}/openjornada/terminal/v1/heartbeat`, {
            headers: { Authorization: `Bearer ${responsiveTerminal.token}` },
            data: heartbeatData(),
          });
          expect(heartbeat.ok(), await heartbeat.text()).toBeTruthy();
          pingChallenge = ((await heartbeat.json()) as { pingChallenge: string }).pingChallenge;
          return pingChallenge;
        },
        { timeout: 5_000 },
      )
      .not.toBe('');

    const ack = await request.post(`${apiBase}/openjornada/terminal/v1/ping-ack`, {
      headers: { Authorization: `Bearer ${responsiveTerminal.token}` },
      data: {
        pingChallenge,
        localIp: '192.168.1.44',
        wifiRssiDbm: -62,
        uptimeSeconds: 7200,
      },
    });
    expect(ack.ok(), await ack.text()).toBeTruthy();
    const ping = await pingPromise;
    expect(ping.ok(), await ping.text()).toBeTruthy();
    const pingBody = (await ping.json()) as Record<string, unknown>;
    expect(pingBody).toMatchObject({
      terminalId: responsiveTerminal.id,
      localIp: '192.168.1.44',
      publicIp: '127.0.0.1',
      wifiRssiDbm: -62,
      uptimeSeconds: 7200,
    });

    const list = await request.get(`${apiBase}/openjornada/terminals?page=1`, {
      headers: { Authorization: manager.token },
    });
    expect(list.ok(), await list.text()).toBeTruthy();
    const listBody = (await list.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const listedTerminal = listBody.items.find((item) => item['id'] === responsiveTerminal.id);
    expect(listedTerminal).toMatchObject({
      connectionStatus: 'online',
      clientVersion: 'e2e-telemetry-1.0.0',
      protocolVersion: 1,
      cacheRevision: 3,
      lastPendingCount: 0,
      lastClockStatus: 'synced',
      lastWifiRssiDbm: -62,
      lastUptimeSeconds: 7200,
    });
    expect(listedTerminal?.['lastHeartbeatAt']).not.toBe('');
    expect(listedTerminal?.['lastNtpSyncAt']).not.toBe('');
    expect(listedTerminal).toHaveProperty('lastAttendanceSyncAt');
    expect(JSON.stringify(listBody)).not.toContain('localIp');
    expect(JSON.stringify(listBody)).not.toContain('publicIp');

    const timedOut = await request.post(
      `${apiBase}/openjornada/terminals/${timeoutTerminal.id}/ping`,
      { headers: { Authorization: manager.token }, timeout: 25_000 },
    );
    expect(timedOut.status()).toBe(504);
    expect((await timedOut.json()).code).toBe('terminal_ping_timeout');

    const revoked = await request.post(
      `${apiBase}/openjornada/terminals/${responsiveTerminal.id}/revoke`,
      { headers: { Authorization: admin.token } },
    );
    expect(revoked.ok(), await revoked.text()).toBeTruthy();
    const revokedHeartbeat = await request.post(`${apiBase}/openjornada/terminal/v1/heartbeat`, {
      headers: { Authorization: `Bearer ${responsiveTerminal.token}` },
      data: heartbeatData(),
    });
    expect(revokedHeartbeat.status()).toBe(401);
    expect((await revokedHeartbeat.json()).code).toBe('authentication_required');
  } catch (error) {
    hasOriginalFailure = true;
    originalFailure = error;
  } finally {
    const cleanupAttempts: CleanupAttempt[] = [
      ...[...terminalIds].reverse().map((terminalId) => ({
        label: `revocar terminal ${terminalId}`,
        run: () =>
          request.post(`${apiBase}/openjornada/terminals/${terminalId}/revoke`, {
            headers: { Authorization: admin.token },
          }),
      })),
      ...[...userIds].reverse().map((userId) => ({
        label: `desactivar usuario ${userId}`,
        run: () =>
          request.patch(`${apiBase}/collections/users/records/${userId}`, {
            headers: { Authorization: admin.token },
            data: { active: false },
          }),
      })),
    ];
    try {
      await cleanupFixtures(cleanupAttempts);
    } catch (cleanupFailure) {
      if (hasOriginalFailure) {
        throw new AggregateError(
          [originalFailure, cleanupFailure],
          'La prueba y la limpieza de fixtures de telemetría fallaron.',
        );
      }
      throw cleanupFailure;
    }
  }
  if (hasOriginalFailure) throw originalFailure;
});

test('muestra telemetría y ping efímero para estados online, offline y revocado', async ({
  page,
}) => {
  await browserSignIn(page);

  const items = [
    terminalFixture('terminal-online', 'Recepción online', 'online'),
    terminalFixture('terminal-offline', 'Almacén offline', 'offline'),
    terminalFixture('terminal-revoked', 'Entrada revocada', 'revoked'),
  ];
  await page.route('**/api/openjornada/terminals?page=*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        items,
        adminPinConfigured: true,
        page: 1,
        perPage: 10,
        totalItems: items.length,
        totalPages: 1,
      },
    });
  });
  await page.route('**/api/openjornada/terminals/terminal-online/ping', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        terminalId: 'terminal-online',
        localIp: '192.168.1.44',
        publicIp: '203.0.113.9',
        wifiRssiDbm: -62,
        uptimeSeconds: 7200,
        waitForHeartbeatMs: 320,
        responseMs: 45,
        totalLatencyMs: 365,
        checkedAt: '2026-08-27T10:00:01.000Z',
      },
    });
  });

  await page.goto('/integraciones');
  const section = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Terminales RFID' }),
  });
  const onlineCard = section.locator('li').filter({ hasText: 'Recepción online' });
  const offlineCard = section.locator('li').filter({ hasText: 'Almacén offline' });
  const revokedCard = section.locator('li').filter({ hasText: 'Entrada revocada' });

  await expect(onlineCard.getByText('En línea', { exact: true })).toBeVisible();
  await expect(onlineCard.getByText('Buena · −62 dBm')).toBeVisible();
  await expect(offlineCard.getByText('Sin conexión', { exact: true })).toBeVisible();
  await expect(revokedCard.getByText('Revocado', { exact: true })).toBeVisible();
  await expect(revokedCard.getByRole('button', { name: 'Comprobar conexión' })).toHaveCount(0);

  await onlineCard.getByRole('button', { name: 'Comprobar conexión' }).click();
  const result = onlineCard.getByRole('region', { name: 'Resultado de la comprobación' });
  await expect(result).toContainText('192.168.1.44');
  await expect(result).toContainText('203.0.113.9');
  const storedValues = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  expect(JSON.stringify(storedValues)).not.toContain('192.168.1.44');
  expect(JSON.stringify(storedValues)).not.toContain('203.0.113.9');
});
