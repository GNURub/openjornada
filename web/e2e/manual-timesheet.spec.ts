import { expect, test } from '@playwright/test';

const apiBase = 'http://127.0.0.1:8090/api';
const employeeEmail = 'empleada@example.com';
const employeePassword = 'DemoPassword123!';
const adminEmail = 'admin@example.com';
const adminPassword = 'TestPassword123!';

type Authentication = {
  token: string;
  record: { id: string; organization: string };
};

function madridNow(): { date: string; minutes: number } {
  const value = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  const [date, time] = value.split(' ');
  const [hours, minutes] = time.split(':').map(Number);
  return { date, minutes: hours * 60 + minutes };
}

function timeFromMinutes(value: number): string {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(
    normalized % 60,
  ).padStart(2, '0')}`;
}

function previousDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    try {
      await expect(page).toHaveURL(/\/$/, { timeout: 2_500 });
      return;
    } catch {
      if (attempt === 2) throw new Error(`No se pudo iniciar sesión como ${email}`);
      await page.waitForTimeout(3_200);
    }
  }
}

async function changeAccount(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.evaluate(() => localStorage.clear());
  await signIn(page, email, password);
}

async function apiSignIn(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<Authentication> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity: email, password },
    });
    if (response.ok()) return (await response.json()) as Authentication;
    if (attempt === 2) {
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${email}`);
}

async function apiCreateTimesheetEmployee(
  request: import('@playwright/test').APIRequestContext,
  admin: Authentication,
): Promise<{ email: string; password: string }> {
  const suffix = Date.now().toString(36);
  const email = `jornada-hoy-${suffix}@example.com`;
  const password = 'EmployeePassword123!';
  const response = await request.post(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name: 'Empleada jornada actual',
      email,
      password,
      passwordConfirm: password,
      employeeCode: `TIME-${suffix}`,
      jobTitle: 'Pruebas',
      weeklyHours: 40,
      role: 'employee',
      active: true,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { email, password };
}

async function selectDay(page: import('@playwright/test').Page, date: string): Promise<void> {
  await page.getByLabel('Día de la hoja').fill(date);
  await page.getByLabel('Día de la hoja').press('Tab');
  await expect(page.locator(`[data-timesheet-date="${date}"]`)).toBeVisible();
}

async function submitWorkday(
  page: import('@playwright/test').Page,
  reason: string,
  withBreak: boolean,
): Promise<void> {
  await page.getByRole('button', { name: '+ Añadir tiempo' }).click();
  const popover = page.getByRole('dialog', { name: /Añadir tiempo/ });
  await expect(popover).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Aplicar' })).toBeDisabled();
  await popover.getByLabel('Inicio del tramo 1').fill('09:00');
  await popover.getByLabel('Fin del tramo 1').fill(withBreak ? '13:00' : '17:00');
  if (withBreak) {
    await popover.getByRole('button', { name: '+ Pausa' }).click();
    await popover.getByRole('button', { name: '+ Trabajo' }).click();
  }
  await popover.getByLabel('Motivo de la incorporación').fill(reason);
  await popover.getByRole('button', { name: 'Aplicar' }).click();
}

test('employee completes a past workday and the approval policy is enforced', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución cubre el flujo funcional; el shell responsive se prueba por separado.',
  );

  const automaticDate = '2026-01-15';
  const cancelledDate = '2026-01-16';
  const approvedDate = '2026-01-19';
  const automaticReason = 'Olvido de fichaje E2E con pausa';
  const correctionReason = 'La salida real de la jornada fue una hora antes';
  const cancelledReason = 'Solicitud E2E que será cancelada';
  const approvedReason = 'Solicitud E2E pendiente de revisión';

  const admin = await apiSignIn(request, adminEmail, adminPassword);
  const employee = await apiSignIn(request, employeeEmail, employeePassword);

  await signIn(page, employeeEmail, employeePassword);
  await page.goto('/registros');
  await expect(page.getByRole('heading', { name: 'Mi control horario' })).toBeVisible();
  await selectDay(page, automaticDate);
  await submitWorkday(page, automaticReason, true);
  await expect(page.getByText('La jornada se ha incorporado con trazabilidad.')).toBeVisible();

  const automaticDay = page.locator(`[data-timesheet-date="${automaticDate}"]`);
  await expect(automaticDay.getByText('7h 30m', { exact: true }).first()).toBeVisible();

  await automaticDay.getByRole('button', { name: 'Corregir jornada' }).click();
  const correctionPopover = page.getByRole('dialog', {
    name: /Corregir jornada/,
  });
  await expect(correctionPopover).toBeVisible();
  await expect(correctionPopover.getByLabel('Inicio del tramo 1')).toHaveValue('09:00');
  await expect(correctionPopover.getByLabel('Fin del tramo 3')).toHaveValue('17:00');
  await correctionPopover.getByLabel('Fin del tramo 3').fill('16:00');
  await correctionPopover.getByRole('button', { name: '+ Trabajo' }).click();
  await expect(correctionPopover.getByLabel('Inicio del tramo 4')).toHaveValue('16:00');
  await correctionPopover.getByLabel('Fin del tramo 4').fill('16:30');
  await correctionPopover.getByLabel('Motivo de la corrección').fill(correctionReason);
  await correctionPopover.getByRole('button', { name: 'Enviar corrección' }).click();
  await expect(page.getByText('La corrección se ha enviado para aprobación.')).toBeVisible();
  await expect(automaticDay.getByRole('button', { name: 'Corrección pendiente' })).toBeDisabled();
  await expect(automaticDay.getByText('7h 30m', { exact: true }).first()).toBeVisible();

  const overlap = await request.post(`${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: automaticDate,
      intervals: [
        {
          kind: 'work',
          start: '10:00',
          end: '11:00',
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Este tramo E2E se solapa con horas existentes',
    },
  });
  expect(overlap.status()).toBe(400);
  expect(await overlap.text()).toContain('coincide con horas de trabajo');

  const overnightDate = '2026-01-20';
  const overnight = await request.post(`${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: overnightDate,
      intervals: [
        {
          kind: 'work',
          start: '22:00',
          end: '06:00',
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Turno nocturno E2E terminado al día siguiente',
    },
  });
  expect(overnight.status(), await overnight.text()).toBe(201);
  expect(((await overnight.json()) as { status: string }).status).toBe('approved');

  const overnightSheet = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: employee.token },
    params: { from: overnightDate, to: '2026-01-21' },
  });
  expect(overnightSheet.ok(), await overnightSheet.text()).toBeTruthy();
  expect(
    (
      (await overnightSheet.json()) as {
        days: Array<{ workedMinutes: number; anomaly: boolean }>;
      }
    ).days,
  ).toEqual([
    expect.objectContaining({ workedMinutes: 120, anomaly: false }),
    expect.objectContaining({ workedMinutes: 360, anomaly: false }),
  ]);

  await changeAccount(page, adminEmail, adminPassword);
  await page.goto('/registros');
  const correctionCard = page.locator('li').filter({ hasText: correctionReason });
  await expect(correctionCard).toBeVisible();
  await expect(correctionCard.getByText('Antes', { exact: true })).toBeVisible();
  await expect(correctionCard.getByText('Propuesta', { exact: true })).toBeVisible();
  await correctionCard.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByText('Corrección aprobada e incorporada.')).toBeVisible();

  const correctedSheet = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: {
      from: automaticDate,
      to: automaticDate,
      employee: employee.record.id,
    },
  });
  expect(correctedSheet.ok(), await correctedSheet.text()).toBeTruthy();
  expect(
    (
      (await correctedSheet.json()) as {
        days: Array<{ workedMinutes: number; editableIntervals: unknown[] }>;
      }
    ).days[0],
  ).toEqual(
    expect.objectContaining({
      workedMinutes: 420,
      editableIntervals: expect.arrayContaining([
        expect.objectContaining({ start: '13:30', end: '16:00' }),
        expect.objectContaining({ start: '16:00', end: '16:30' }),
      ]),
    }),
  );

  await page.goto('/ajustes');
  await expect(
    page.getByRole('heading', {
      name: 'Jornadas manuales, correcciones y pausas',
    }),
  ).toBeVisible();
  await page.getByLabel(/Exigir aprobación para jornadas introducidas/).check();
  await expect(page.getByLabel(/Exigir aprobación para corregir jornadas/)).toBeChecked();
  await page.getByLabel(/Exigir aprobación para corregir jornadas/).uncheck();
  await page.getByLabel('Nuevo tipo de pausa').fill('Descanso E2E');
  await page.getByLabel('Remunerada').first().check();
  await page.getByRole('button', { name: 'Añadir pausa' }).click();
  await expect(page.getByText('Tipo de pausa creado.')).toBeVisible();
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(page.getByText(/Configuración guardada/)).toBeVisible();

  const automaticCorrection = await request.post(`${apiBase}/openjornada/timesheet-corrections`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: overnightDate,
      intervals: [
        {
          kind: 'work',
          start: '22:00',
          end: '05:00',
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Corrección automática E2E con aprobación desactivada',
    },
  });
  expect(automaticCorrection.status(), await automaticCorrection.text()).toBe(201);
  expect(
    (await automaticCorrection.json()) as {
      status: string;
      requestType: string;
    },
  ).toEqual(
    expect.objectContaining({
      status: 'approved',
      requestType: 'replacement',
    }),
  );

  await changeAccount(page, employeeEmail, employeePassword);
  await page.goto('/registros');
  await selectDay(page, cancelledDate);
  await submitWorkday(page, cancelledReason, false);
  await expect(page.getByText('La jornada se ha enviado para aprobación.')).toBeVisible();
  await expect(
    page.locator(`[data-timesheet-date="${cancelledDate}"]`).getByText('Pendiente'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar solicitud' }).click();
  await expect(page.getByText('Solicitud cancelada.')).toBeVisible();

  await selectDay(page, approvedDate);
  await submitWorkday(page, approvedReason, false);
  await expect(page.getByText('La jornada se ha enviado para aprobación.')).toBeVisible();

  await changeAccount(page, adminEmail, adminPassword);
  await page.goto('/registros');
  const pendingCard = page.locator('li').filter({ hasText: approvedReason });
  await expect(pendingCard).toBeVisible();
  await pendingCard.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByText('Jornada aprobada e incorporada.')).toBeVisible();

  const sheet = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: {
      from: approvedDate,
      to: approvedDate,
      employee: employee.record.id,
    },
  });
  expect(sheet.ok(), await sheet.text()).toBeTruthy();
  expect(
    ((await sheet.json()) as { days: Array<{ workedMinutes: number }> }).days[0].workedMinutes,
  ).toBe(480);

  const annulled = await request.post(`${apiBase}/openjornada/timesheet-corrections`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: approvedDate,
      intervals: [],
      reason: 'Anulación completa E2E de una jornada duplicada',
    },
  });
  expect(annulled.status(), await annulled.text()).toBe(201);
  expect(((await annulled.json()) as { status: string }).status).toBe('approved');

  const annulledSheet = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: {
      from: approvedDate,
      to: approvedDate,
      employee: employee.record.id,
    },
  });
  expect(annulledSheet.ok(), await annulledSheet.text()).toBeTruthy();
  expect(
    (
      (await annulledSheet.json()) as {
        days: Array<{ workedMinutes: number; editableIntervals: unknown[] }>;
      }
    ).days[0],
  ).toEqual(
    expect.objectContaining({
      workedMinutes: 0,
      editableIntervals: [],
    }),
  );

  const historyResponse = await request.get(`${apiBase}/collections/work_events/records`, {
    headers: { Authorization: admin.token },
    params: {
      filter: `employee = '${employee.record.id}'`,
      perPage: 500,
      fields: 'id,kind,corrects,voidsTarget',
    },
  });
  expect(historyResponse.ok(), await historyResponse.text()).toBeTruthy();
  const history = (
    (await historyResponse.json()) as {
      items: Array<{
        id: string;
        kind: string;
        corrects: string;
        voidsTarget: boolean;
      }>;
    }
  ).items;
  const voidMarkers = history.filter((event) => event.kind === 'correction' && event.voidsTarget);
  expect(voidMarkers.length).toBeGreaterThan(0);
  for (const marker of voidMarkers) {
    expect(history.some((event) => event.id === marker.corrects)).toBe(true);
  }

  const future = await request.post(`${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: '2099-01-01',
      intervals: [
        {
          kind: 'work',
          start: '09:00',
          end: '10:00',
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Una jornada E2E futura no debe aceptarse',
    },
  });
  expect(future.status()).toBe(400);

  const resetPolicy = await request.patch(
    `${apiBase}/collections/organizations/records/${admin.record.organization}`,
    {
      headers: { Authorization: admin.token },
      data: {
        manualTimeApprovalRequired: false,
        timeCorrectionApprovalRequired: true,
      },
    },
  );
  expect(resetPolicy.ok(), await resetPolicy.text()).toBeTruthy();
});

test('employee corrects completed time today and keeps a corrected pause linked', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución cubre el flujo temporal y la continuidad de los tramos.',
  );

  const now = madridNow();
  test.skip(
    now.minutes < 130,
    'La prueba necesita al menos dos horas ya transcurridas en la fecha actual.',
  );

  const requestedExactCase = now.date === '2026-07-30' && now.minutes >= 13 * 60;
  const initialStart = requestedExactCase ? '08:00' : timeFromMinutes(now.minutes - 120);
  const initialEnd = requestedExactCase ? '13:00' : timeFromMinutes(now.minutes - 30);
  const correctedStart = requestedExactCase ? '08:31' : timeFromMinutes(now.minutes - 110);
  const correctedEnd = requestedExactCase ? '12:00' : timeFromMinutes(now.minutes - 45);
  const yesterday = previousDate(now.date);
  const todayReason = 'Jornada de hoy completada para la prueba E2E';
  const todayCorrectionReason = 'Corrección de la jornada de hoy solicitada por la empleada';
  const pauseCorrectionReason = 'La pausa terminó realmente a las once y media';

  const admin = await apiSignIn(request, adminEmail, adminPassword);
  const employeeAccess = await apiCreateTimesheetEmployee(request, admin);
  const employee = await apiSignIn(request, employeeAccess.email, employeeAccess.password);

  await signIn(page, employeeAccess.email, employeeAccess.password);
  await page.goto('/registros');
  await selectDay(page, now.date);
  await page.getByRole('button', { name: '+ Añadir tiempo' }).click();
  let popover = page.getByRole('dialog', { name: /Añadir tiempo/ });
  await expect(
    popover.getByText('Hoy solo puedes guardar tramos que ya hayan terminado.'),
  ).toBeVisible();
  await popover.getByLabel('Inicio del tramo 1').fill(initialStart);
  await popover.getByLabel('Fin del tramo 1').fill(initialEnd);
  await popover.getByLabel('Motivo de la incorporación').fill(todayReason);
  await popover.getByRole('button', { name: 'Aplicar' }).click();
  await expect(page.getByText('La jornada se ha incorporado con trazabilidad.')).toBeVisible();

  const todayDay = page.locator(`[data-timesheet-date="${now.date}"]`);
  await todayDay.getByRole('button', { name: 'Corregir jornada' }).click();
  popover = page.getByRole('dialog', { name: /Corregir jornada/ });
  await popover.getByLabel('Inicio del tramo 1').fill(correctedStart);
  await popover.getByLabel('Fin del tramo 1').fill(correctedEnd);
  await popover.getByLabel('Motivo de la corrección').fill(todayCorrectionReason);
  await popover.getByRole('button', { name: 'Enviar corrección' }).click();
  await expect(page.getByText('La corrección se ha enviado para aprobación.')).toBeVisible();

  const futureStart = timeFromMinutes(now.minutes - 60);
  const futureEnd = timeFromMinutes(now.minutes + 65);
  const future = await request.post(`${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: now.date,
      intervals: [
        {
          kind: 'work',
          start: futureStart,
          end: futureEnd,
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Este tramo futuro E2E debe quedar bloqueado',
    },
  });
  expect(future.status()).toBe(400);
  expect(await future.text()).toContain('todavía no ha terminado');

  await selectDay(page, yesterday);
  await page.getByRole('button', { name: '+ Añadir tiempo' }).click();
  popover = page.getByRole('dialog', { name: /Añadir tiempo/ });
  await popover.getByLabel('Inicio del tramo 1').fill('08:30');
  await popover.getByLabel('Fin del tramo 1').fill('11:00');
  await popover.getByRole('button', { name: '+ Pausa' }).click();
  await popover.getByLabel('Fin del tramo 2').fill('11:31');
  await popover.getByRole('button', { name: '+ Trabajo' }).click();
  await expect(popover.getByLabel('Inicio del tramo 3')).toHaveValue('11:31');
  await popover.getByLabel('Fin del tramo 3').fill('16:00');
  await popover
    .getByLabel('Motivo de la incorporación')
    .fill('Jornada con pausa exacta solicitada para la prueba E2E');
  await popover.getByRole('button', { name: 'Aplicar' }).click();

  const yesterdayDay = page.locator(`[data-timesheet-date="${yesterday}"]`);
  await expect(yesterdayDay.getByText('6h 59m', { exact: true }).first()).toBeVisible();
  await yesterdayDay.getByRole('button', { name: 'Corregir jornada' }).click();
  popover = page.getByRole('dialog', { name: /Corregir jornada/ });
  await popover.getByLabel('Fin del tramo 2').fill('11:30');
  await expect(popover.getByLabel('Inicio del tramo 3')).toHaveValue('11:30');
  await popover.getByLabel('Motivo de la corrección').fill(pauseCorrectionReason);
  await popover.getByRole('button', { name: 'Enviar corrección' }).click();

  await changeAccount(page, adminEmail, adminPassword);
  await page.goto('/registros');
  for (const reason of [todayCorrectionReason, pauseCorrectionReason]) {
    const card = page.locator('li').filter({ hasText: reason });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Aprobar' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText('Corrección aprobada e incorporada.')).toBeVisible();
  }

  const todaySheet = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: {
      from: now.date,
      to: now.date,
      employee: employee.record.id,
    },
  });
  expect(todaySheet.ok(), await todaySheet.text()).toBeTruthy();
  const correctedStartMinutes =
    Number(correctedStart.slice(0, 2)) * 60 + Number(correctedStart.slice(3));
  const correctedEndMinutes = Number(correctedEnd.slice(0, 2)) * 60 + Number(correctedEnd.slice(3));
  expect(
    (
      (await todaySheet.json()) as {
        days: Array<{ workedMinutes: number; editableIntervals: unknown[] }>;
      }
    ).days[0],
  ).toEqual(
    expect.objectContaining({
      workedMinutes: correctedEndMinutes - correctedStartMinutes,
      editableIntervals: [
        expect.objectContaining({
          start: correctedStart,
          end: correctedEnd,
        }),
      ],
    }),
  );

  const yesterdaySheet = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: {
      from: yesterday,
      to: yesterday,
      employee: employee.record.id,
    },
  });
  expect(yesterdaySheet.ok(), await yesterdaySheet.text()).toBeTruthy();
  expect(
    (
      (await yesterdaySheet.json()) as {
        days: Array<{ workedMinutes: number; editableIntervals: unknown[] }>;
      }
    ).days[0],
  ).toEqual(
    expect.objectContaining({
      workedMinutes: 420,
      editableIntervals: [
        expect.objectContaining({ start: '08:30', end: '11:00' }),
        expect.objectContaining({ start: '11:00', end: '11:30' }),
        expect.objectContaining({ start: '11:30', end: '16:00' }),
      ],
    }),
  );
});

test('employee can remove an existing interval and sees why correction submission is blocked', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución cubre la eliminación y sus validaciones.',
  );

  const workDate = previousDate(madridNow().date);
  const correctionReason = 'Eliminar el segundo tramo duplicado';
  const admin = await apiSignIn(request, adminEmail, adminPassword);
  const employeeAccess = await apiCreateTimesheetEmployee(request, admin);
  const employee = await apiSignIn(request, employeeAccess.email, employeeAccess.password);

  const policy = await request.patch(
    `${apiBase}/collections/organizations/records/${admin.record.organization}`,
    {
      headers: { Authorization: admin.token },
      data: {
        manualTimeApprovalRequired: false,
        timeCorrectionApprovalRequired: true,
      },
    },
  );
  expect(policy.ok(), await policy.text()).toBeTruthy();

  const zeroDuration = await request.post(`${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate,
      intervals: [
        {
          kind: 'work',
          start: '11:51',
          end: '11:51',
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Un tramo sin duración debe rechazarse',
    },
  });
  expect(zeroDuration.status()).toBe(400);
  expect(await zeroDuration.text()).toContain('más de cero');

  const initial = await request.post(`${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate,
      intervals: [
        {
          kind: 'work',
          start: '08:00',
          end: '10:00',
          startNextDay: false,
          breakType: '',
        },
        {
          kind: 'work',
          start: '13:00',
          end: '15:00',
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Jornada dividida para probar la eliminación',
    },
  });
  expect(initial.ok(), await initial.text()).toBeTruthy();

  await signIn(page, employeeAccess.email, employeeAccess.password);
  await page.goto('/registros');
  await selectDay(page, workDate);
  const day = page.locator(`[data-timesheet-date="${workDate}"]`);
  await day.getByRole('button', { name: 'Corregir jornada' }).click();
  const popover = page.getByRole('dialog', { name: /Corregir jornada/ });
  await popover.getByRole('button', { name: 'Eliminar tramo 2' }).click();
  await popover.getByLabel('Motivo de la corrección').fill('Quitar');
  await expect(popover.getByText('Añade 2 caracteres más para explicar el motivo.')).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Enviar corrección' })).toBeDisabled();

  await popover.getByLabel('Motivo de la corrección').fill(correctionReason);
  await expect(popover.getByRole('button', { name: 'Enviar corrección' })).toBeEnabled();
  await popover.getByRole('button', { name: 'Enviar corrección' }).click();
  await expect(page.getByText('La corrección se ha enviado para aprobación.')).toBeVisible();

  await changeAccount(page, adminEmail, adminPassword);
  await page.goto('/registros');
  const card = page.locator('li').filter({ hasText: correctionReason });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByText('Corrección aprobada e incorporada.')).toBeVisible();

  const sheet = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: {
      from: workDate,
      to: workDate,
      employee: employee.record.id,
    },
  });
  expect(sheet.ok(), await sheet.text()).toBeTruthy();
  expect(
    (
      (await sheet.json()) as {
        days: Array<{ workedMinutes: number; editableIntervals: unknown[] }>;
      }
    ).days[0],
  ).toEqual(
    expect.objectContaining({
      workedMinutes: 120,
      editableIntervals: [
        expect.objectContaining({
          start: '08:00',
          end: '10:00',
        }),
      ],
    }),
  );
});
