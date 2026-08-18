import { expect, test } from '@playwright/test';
import { createHash, createHmac } from 'node:crypto';

const apiBase = 'http://127.0.0.1:8090/api';

function signOfflineAction(
  token: string,
  terminalId: string,
  action: Record<string, unknown>,
): string {
  const key = createHash('sha256').update(`openjornada-terminal-signing-v1|${token}`).digest();
  const canonical = [
    terminalId,
    action['clientRequestId'],
    action['uid'],
    action['command'],
    action['deviceCapturedAt'],
    action['appliedAt'] ?? '',
    action['clockSyncedAt'],
    action['deviceSequence'],
    action['rebootId'],
    action['previousLocalHash'],
  ].join('|');
  return createHmac('sha256', key).update(canonical).digest('hex');
}

async function signIn(
  request: import('@playwright/test').APIRequestContext,
  identity = 'admin@example.com',
  password = 'TestPassword123!',
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity, password },
    });
    if (response.ok()) {
      return (await response.json()) as {
        token: string;
        record: { id: string; organization: string };
      };
    }
    if (attempt === 3 || response.status() !== 429) {
      throw new Error(
        `No se pudo autenticar el admin: ${response.status()} ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error('No se pudo autenticar el admin');
}

test('RFID terminal creates, assigns and records an idempotent work event', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'El contrato API se valida una vez.');
  const admin = await signIn(request);
  const suffix = Date.now().toString(36);
  const password = 'RfidEmployeePassword123!';
  const employeeResponse = await request.post(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name: `Marina RFID ${suffix}`,
      email: `rfid-${suffix}@example.com`,
      password,
      passwordConfirm: password,
      employeeCode: `RFID-${suffix}`,
      jobTitle: 'Pruebas RFID',
      weeklyHours: 40,
      contractedWeeklyMinutes: 2400,
      employmentType: 'full_time',
      scheduleMode: 'scheduled',
      flexibleWeekdays: [1, 2, 3, 4, 5],
      role: 'employee',
      active: true,
    },
  });
  expect(employeeResponse.ok(), await employeeResponse.text()).toBeTruthy();
  const employee = (await employeeResponse.json()) as { id: string };

  const terminalResponse = await request.post(`${apiBase}/openjornada/terminals`, {
    headers: { Authorization: admin.token },
    data: { name: `Recepción ${suffix}` },
  });
  expect(terminalResponse.ok(), await terminalResponse.text()).toBeTruthy();
  const terminal = (await terminalResponse.json()) as { id: string; token: string; prefix: string };
  expect(terminal.token).toMatch(/^ojterm_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{40,}$/);

  const pinResponse = await request.put(`${apiBase}/openjornada/terminals/admin-pin`, {
    headers: { Authorization: admin.token },
    data: { pin: '9669' },
  });
  expect(pinResponse.ok(), await pinResponse.text()).toBeTruthy();

  const uid = `04A1${suffix
    .slice(-4)
    .padStart(4, '0')
    .replaceAll(/[^0-9A-F]/gi, 'A')}B2`;
  const assignResponse = await request.put(`${apiBase}/openjornada/employees/${employee.id}/rfid`, {
    headers: { Authorization: admin.token },
    data: { uid, replace: false },
  });
  expect(assignResponse.ok(), await assignResponse.text()).toBeTruthy();

  const deviceHeaders = { Authorization: `Bearer ${terminal.token}` };
  const bootstrapResponse = await request.post(`${apiBase}/openjornada/terminal/v1/bootstrap`, {
    headers: deviceHeaders,
    data: { protocolVersion: 1, clientVersion: 'e2e-1.0.0', pendingCount: 0 },
  });
  expect(bootstrapResponse.ok(), await bootstrapResponse.text()).toBeTruthy();
  const bootstrap = (await bootstrapResponse.json()) as {
    serverTime: string;
    maxOfflineSeconds: number;
  };
  expect(bootstrap.maxOfflineSeconds).toBe(86_400);

  const unknown = await request.post(`${apiBase}/openjornada/terminal/v1/resolve`, {
    headers: deviceHeaders,
    data: { uid: '04112233' },
  });
  expect(unknown.status()).toBe(404);
  expect((await unknown.json()).code).toBe('unknown_tag');

  const resolveResponse = await request.post(`${apiBase}/openjornada/terminal/v1/resolve`, {
    headers: deviceHeaders,
    data: { uid },
  });
  expect(resolveResponse.ok(), await resolveResponse.text()).toBeTruthy();
  const resolved = (await resolveResponse.json()) as {
    scanContext: string;
    employee: { displayName: string };
    state: { kind: string; actions: Array<{ command: string }> };
  };
  expect(resolved.employee.displayName).toMatch(/^Marina R\.$/);
  expect(resolved.state.kind).toBe('idle');
  expect(resolved.state.actions.map((action) => action.command)).toEqual(['clock_in']);

  const requestId = `rfid-${suffix}-1`;
  const actionBody = {
    clientRequestId: requestId,
    scanContext: resolved.scanContext,
    command: 'clock_in',
    deviceCapturedAt: bootstrap.serverTime,
    clockSyncedAt: bootstrap.serverTime,
    deviceSequence: 1,
  };
  const actionResponse = await request.post(`${apiBase}/openjornada/terminal/v1/actions`, {
    headers: deviceHeaders,
    data: actionBody,
  });
  expect(actionResponse.ok(), await actionResponse.text()).toBeTruthy();
  const action = (await actionResponse.json()) as {
    status: string;
    workEventId: string;
    state: { kind: string };
  };
  expect(action.status).toBe('accepted');
  expect(action.state.kind).toBe('working');

  const duplicateResponse = await request.post(`${apiBase}/openjornada/terminal/v1/actions`, {
    headers: deviceHeaders,
    data: actionBody,
  });
  expect(duplicateResponse.ok(), await duplicateResponse.text()).toBeTruthy();
  expect((await duplicateResponse.json()).status).toBe('duplicate');

  const eventResponse = await request.get(
    `${apiBase}/collections/work_events/records/${action.workEventId}`,
    { headers: { Authorization: admin.token } },
  );
  expect(eventResponse.ok(), await eventResponse.text()).toBeTruthy();
  const event = (await eventResponse.json()) as {
    source: string;
    terminal: string;
    employee: string;
    deviceCapturedAt: string;
    integrityVersion: string;
  };
  expect(event).toMatchObject({ source: 'terminal', terminal: terminal.id, employee: employee.id });
  expect(event.deviceCapturedAt).not.toBe('');
  expect(event.integrityVersion).toBe('v3');

  const adminSessionResponse = await request.post(
    `${apiBase}/openjornada/terminal/v1/admin-sessions`,
    { headers: deviceHeaders, data: { pin: '9669' } },
  );
  expect(adminSessionResponse.ok(), await adminSessionResponse.text()).toBeTruthy();
  const adminSession = (await adminSessionResponse.json()) as { token: string };
  const employeesResponse = await request.get(`${apiBase}/openjornada/terminal/v1/employees`, {
    headers: { ...deviceHeaders, 'X-Terminal-Admin-Session': adminSession.token },
  });
  expect(employeesResponse.ok(), await employeesResponse.text()).toBeTruthy();
  const employees = (await employeesResponse.json()) as { items: Array<{ id: string }> };
  expect(employees.items.map((item) => item.id)).toContain(employee.id);

  const offlineAction: Record<string, unknown> = {
    clientRequestId: `rfid-${suffix}-2`,
    uid,
    command: 'break_start',
    deviceCapturedAt: new Date().toISOString(),
    appliedAt: '',
    clockSyncedAt: bootstrap.serverTime,
    deviceSequence: 2,
    rebootId: 'e2e-boot',
    previousLocalHash: '',
  };
  offlineAction['signature'] = signOfflineAction(terminal.token, terminal.id, offlineAction);
  const syncResponse = await request.post(`${apiBase}/openjornada/terminal/v1/sync`, {
    headers: deviceHeaders,
    data: { actions: [offlineAction], pendingCount: 1 },
  });
  expect(syncResponse.ok(), await syncResponse.text()).toBeTruthy();
  expect((await syncResponse.json()).items[0].status).toBe('accepted');

  const duplicateSync = await request.post(`${apiBase}/openjornada/terminal/v1/sync`, {
    headers: deviceHeaders,
    data: { actions: [offlineAction], pendingCount: 1 },
  });
  expect(duplicateSync.ok(), await duplicateSync.text()).toBeTruthy();
  expect((await duplicateSync.json()).items[0].status).toBe('duplicate');

  const evidenceResponse = await request.get(`${apiBase}/openjornada/work-events/export`, {
    headers: { Authorization: admin.token },
    params: {
      employee: employee.id,
      from: bootstrap.serverTime.slice(0, 10),
      to: bootstrap.serverTime.slice(0, 10),
    },
  });
  expect(evidenceResponse.ok(), await evidenceResponse.text()).toBeTruthy();
  const evidence = (await evidenceResponse.json()) as {
    verification: { status: string; cryptographicallyVerified: number };
    events: Array<{ terminal: string; deviceSequence: number; queuedOffline: boolean }>;
  };
  expect(evidence.verification).toMatchObject({
    status: 'valid',
    cryptographicallyVerified: 2,
  });
  expect(evidence.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ terminal: terminal.id, deviceSequence: 1, queuedOffline: false }),
      expect.objectContaining({ terminal: terminal.id, deviceSequence: 2, queuedOffline: true }),
    ]),
  );

  const conflictAction: Record<string, unknown> = {
    ...offlineAction,
    clientRequestId: `rfid-${suffix}-3`,
    deviceCapturedAt: new Date(
      new Date(String(offlineAction['deviceCapturedAt'])).getTime() + 1,
    ).toISOString(),
    deviceSequence: 3,
    previousLocalHash: offlineAction['signature'],
  };
  conflictAction['signature'] = signOfflineAction(terminal.token, terminal.id, conflictAction);
  const conflictSync = await request.post(`${apiBase}/openjornada/terminal/v1/sync`, {
    headers: deviceHeaders,
    data: { actions: [conflictAction], pendingCount: 1 },
  });
  expect(conflictSync.ok(), await conflictSync.text()).toBeTruthy();
  const conflict = (await conflictSync.json()).items[0] as {
    status: string;
    errorCode: string;
    incidentId: string;
  };
  expect(conflict).toMatchObject({ status: 'incident', errorCode: 'state_conflict' });
  expect(conflict.incidentId).not.toBe('');

  const prematureResolution = await request.post(
    `${apiBase}/openjornada/terminal-incidents/${conflict.incidentId}/resolve`,
    {
      headers: { Authorization: admin.token },
      data: { note: 'Revisión todavía sin corrección' },
    },
  );
  expect(prematureResolution.status()).toBe(409);
  expect((await prematureResolution.json()).code).toBe('correction_required');

  await page.goto('/terminal-simulator');
  await page.getByLabel('API key del terminal').fill(terminal.token);
  await page.getByRole('button', { name: 'Conectar' }).click();
  await expect(page.getByText('Terminal conectado')).toBeVisible();
  await page.getByLabel('UID simulado').fill(uid);
  await page.getByRole('button', { name: 'Acercar tag' }).click();
  await expect(page.getByText('En pausa')).toBeVisible();

  await page.getByRole('button', { name: 'C', exact: true }).click();
  await expect(page.getByText('¿A qué hora terminaste la pausa?')).toBeVisible();
  await page.getByRole('button', { name: 'B', exact: true }).click();
  await expect(page.getByText('¿Deseas cerrar ahora la jornada?')).toBeVisible();
  await page.getByRole('button', { name: 'A', exact: true }).click();

  await page.getByRole('button', { name: 'Acercar tag' }).click();
  await expect(page.getByText('Trabajando')).toBeVisible();
  await page.getByRole('button', { name: 'A', exact: true }).click();
  await page.getByRole('button', { name: 'Acercar tag' }).click();
  await expect(page.getByText('En pausa')).toBeVisible();
  await page.getByRole('button', { name: 'C', exact: true }).click();
  await page.getByRole('button', { name: 'B', exact: true }).click();
  await expect(page.getByText('¿Deseas cerrar ahora la jornada?')).toBeVisible();
  await page.getByRole('button', { name: 'C', exact: true }).click();
  await expect(page.getByText('Jornada terminada')).toBeVisible();

  const policy = await request.patch(
    `${apiBase}/collections/organizations/records/${admin.record.organization}`,
    {
      headers: { Authorization: admin.token },
      data: { timeCorrectionApprovalRequired: false },
    },
  );
  expect(policy.ok(), await policy.text()).toBeTruthy();
  const employeeAuth = await signIn(request, `rfid-${suffix}@example.com`, password);
  const workDate = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const correction = await request.post(`${apiBase}/openjornada/timesheet-corrections`, {
    headers: { Authorization: employeeAuth.token },
    data: {
      workDate,
      intervals: [],
      reason: 'Corrección de la incidencia RFID durante la prueba',
    },
  });
  expect(correction.status(), await correction.text()).toBe(201);

  const resolvedIncident = await request.post(
    `${apiBase}/openjornada/terminal-incidents/${conflict.incidentId}/resolve`,
    {
      headers: { Authorization: admin.token },
      data: { note: 'Jornada corregida y comprobada' },
    },
  );
  expect(resolvedIncident.ok(), await resolvedIncident.text()).toBeTruthy();
  expect((await resolvedIncident.json()).status).toBe('resolved');
});
