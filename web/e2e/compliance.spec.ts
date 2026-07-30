import { expect, test, type APIRequestContext } from '@playwright/test';

const apiBase = process.env['OPENJORNADA_E2E_API_URL'] ?? 'http://127.0.0.1:8090/api';
const appBase = process.env['OPENJORNADA_E2E_APP_URL'] ?? 'http://127.0.0.1:4217';
const adminEmail = process.env['OPENJORNADA_E2E_ADMIN_EMAIL'] ?? 'admin@example.com';
const adminPassword = process.env['OPENJORNADA_E2E_ADMIN_PASSWORD'] ?? 'TestPassword123!';

type Authentication = {
  token: string;
  record: { id: string; organization: string };
};

async function signIn(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<Authentication> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity: email, password },
    });
    if (response.ok()) return (await response.json()) as Authentication;
    if (attempt === 2) {
      throw new Error(
        `No se pudo autenticar ${email}: ${response.status()} ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${email}`);
}

function previousMonth(): {
  period: string;
  first: string;
  last: string;
} {
  const current = new Date();
  const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
  return {
    period: first.toISOString().slice(0, 7),
    first: first.toISOString().slice(0, 10),
    last: last.toISOString().slice(0, 10),
  };
}

test('critical time-record compliance controls work end to end', async ({
  request,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar los controles de cumplimiento.',
  );

  const admin = await signIn(request, adminEmail, adminPassword);
  const adminHeaders = { Authorization: admin.token };
  const suffix = `${Date.now()}`;
  const email = `cumplimiento-${suffix}@example.com`;
  const password = 'CompliancePassword123!';
  const employeeName = `Prueba Cumplimiento ${suffix}`;
  const employeeResponse = await request.post(`${apiBase}/collections/users/records`, {
    headers: adminHeaders,
    data: {
      organization: admin.record.organization,
      name: employeeName,
      email,
      password,
      passwordConfirm: password,
      employeeCode: `CMP-${suffix}`,
      weeklyHours: 40,
      employmentType: 'full_time',
      contractedWeeklyMinutes: 2400,
      complementaryHoursAgreement: false,
      role: 'employee',
      active: true,
    },
  });
  expect(employeeResponse.ok(), await employeeResponse.text()).toBeTruthy();
  const employee = (await employeeResponse.json()) as {
    id: string;
    organization: string;
  };
  const employeeAuth = await signIn(request, email, password);
  const employeeHeaders = { Authorization: employeeAuth.token };

  const leaveTypesResponse = await request.get(`${apiBase}/collections/leave_types/records`, {
    headers: adminHeaders,
    params: { page: 1, perPage: 10, filter: "code = 'vacation'" },
  });
  expect(leaveTypesResponse.ok(), await leaveTypesResponse.text()).toBeTruthy();
  const leaveTypes = (await leaveTypesResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const vacationType = leaveTypes.items[0];
  expect(vacationType).toBeDefined();
  const currentYear = new Date().getUTCFullYear();
  const balancesResponse = await request.get(`${apiBase}/collections/leave_balances/records`, {
    headers: adminHeaders,
    params: {
      page: 1,
      perPage: 10,
      filter: `employee = '${employee.id}' && leaveType = '${vacationType.id}' && year = ${currentYear}`,
    },
  });
  expect(balancesResponse.ok(), await balancesResponse.text()).toBeTruthy();
  const balanceItems = (await balancesResponse.json()) as {
    items: Array<{
      id: string;
      employee: string;
      year: number;
      allowance: number;
    }>;
  };
  const vacationBalance = balanceItems.items[0];
  expect(vacationBalance).toBeDefined();

  const forbiddenAllowance = await request.patch(
    `${apiBase}/collections/leave_balances/records/${vacationBalance.id}`,
    { headers: employeeHeaders, data: { allowance: 30 } },
  );
  expect([403, 404]).toContain(forbiddenAllowance.status());
  const adminAllowance = await request.patch(
    `${apiBase}/collections/leave_balances/records/${vacationBalance.id}`,
    {
      headers: adminHeaders,
      data: {
        allowance: 22.5,
        employee: admin.record.id,
        year: 2200,
      },
    },
  );
  expect(adminAllowance.ok(), await adminAllowance.text()).toBeTruthy();
  expect(await adminAllowance.json()).toMatchObject({
    employee: employee.id,
    year: currentYear,
    allowance: 22.5,
  });
  const invalidAllowance = await request.patch(
    `${apiBase}/collections/leave_balances/records/${vacationBalance.id}`,
    { headers: adminHeaders, data: { allowance: 22.25 } },
  );
  expect(invalidAllowance.status()).toBe(400);

  const noticeBefore = await request.get(`${apiBase}/openjornada/privacy-notice`, {
    headers: employeeHeaders,
  });
  expect(noticeBefore.ok(), await noticeBefore.text()).toBeTruthy();
  expect((await noticeBefore.json()).acknowledged).toBe(false);
  const acknowledge = await request.post(`${apiBase}/openjornada/privacy-notice/acknowledge`, {
    headers: employeeHeaders,
  });
  expect(acknowledge.ok(), await acknowledge.text()).toBeTruthy();

  const createEvent = async (kind: 'clock_in' | 'clock_out') => {
    const response = await request.post(`${apiBase}/collections/work_events/records`, {
      headers: employeeHeaders,
      data: {
        employee: employee.id,
        organization: employee.organization,
        kind,
        occurredAt: new Date().toISOString(),
        timezone: 'Europe/Madrid',
        source: 'desktop',
        createdBy: employee.id,
        integrityHash: 'server-generated',
        clientRequestId: crypto.randomUUID(),
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  await createEvent('clock_in');
  const clockOut = await createEvent('clock_out');
  expect(clockOut.recordedAt).toBeTruthy();
  expect(clockOut.integrityVersion).toBe('v2');

  const today = new Date().toISOString().slice(0, 10);
  const evidence = await request.get(`${apiBase}/openjornada/work-events/export`, {
    headers: employeeHeaders,
    params: {
      employee: admin.record.id,
      from: today,
      to: today,
    },
  });
  expect(evidence.ok(), await evidence.text()).toBeTruthy();
  const evidenceBody = await evidence.json();
  expect(evidenceBody.employee.id).toBe(employee.id);
  expect(evidenceBody.verification).toMatchObject({
    status: 'valid',
    cryptographicallyVerified: 2,
    roots: 1,
    tips: 1,
  });

  const month = previousMonth();
  const schedule = await request.post(`${apiBase}/openjornada/work-schedules/bulk`, {
    headers: adminHeaders,
    data: {
      employeeIds: [employee.id],
      name: 'Horario de cumplimiento',
      validFrom: month.first,
      validUntil: month.last,
      weekdays: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '17:00',
      breakMinutes: 0,
    },
  });
  expect(schedule.ok(), await schedule.text()).toBeTruthy();
  const close = await request.post(`${apiBase}/openjornada/monthly-statements/close`, {
    headers: adminHeaders,
    data: { employee: employee.id, period: month.period },
  });
  expect(close.ok(), await close.text()).toBeTruthy();
  const closed = await close.json();
  const directMutation = await request.patch(
    `${apiBase}/collections/monthly_time_statements/records/${closed.id}`,
    { headers: employeeHeaders, data: { totalMinutes: 999 } },
  );
  expect(directMutation.status()).toBe(403);
  const receipt = await request.post(
    `${apiBase}/openjornada/monthly-statements/${closed.id}/acknowledge`,
    { headers: employeeHeaders },
  );
  expect(receipt.ok(), await receipt.text()).toBeTruthy();

  const hold = await request.post(`${apiBase}/openjornada/legal-holds`, {
    headers: adminHeaders,
    data: {
      employee: employee.id,
      from: month.first,
      to: month.last,
      reason: 'Prueba de preservación por requerimiento oficial',
    },
  });
  expect(hold.ok(), await hold.text()).toBeTruthy();
  const holdBody = await hold.json();
  expect(holdBody.active).toBe(true);
  const preview = await request.get(`${apiBase}/openjornada/retention-preview`, {
    headers: adminHeaders,
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  expect(await preview.json()).toMatchObject({
    activeLegalHolds: 1,
    destructiveActionExecuted: false,
  });
  const release = await request.post(`${apiBase}/openjornada/legal-holds/${holdBody.id}/release`, {
    headers: adminHeaders,
  });
  expect(release.ok(), await release.text()).toBeTruthy();
  expect((await release.json()).active).toBe(false);

  const acknowledgeAdmin = await request.post(`${apiBase}/openjornada/privacy-notice/acknowledge`, {
    headers: adminHeaders,
  });
  expect(acknowledgeAdmin.ok(), await acknowledgeAdmin.text()).toBeTruthy();
  await page.addInitScript(({ token, record }) => {
    localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }));
  }, admin);
  await page.goto(`${appBase}/ausencias`);
  await page.getByRole('button', { name: 'Políticas y saldos' }).click();
  const allowanceInput = page.getByLabel(
    `Cupo anual de ${employeeName} para Vacaciones en ${currentYear}`,
  );
  await expect(allowanceInput).toHaveValue('22.5');
  await allowanceInput.fill('23.5');
  const balanceCard = page.locator('article').filter({ has: allowanceInput });
  await balanceCard.getByRole('button', { name: 'Guardar cupo' }).click();
  await expect(
    page.getByText(`Cupo anual de ${employeeName} actualizado a 23.5 días.`),
  ).toBeVisible();
  const updatedBalance = await request.get(
    `${apiBase}/collections/leave_balances/records/${vacationBalance.id}`,
    { headers: adminHeaders },
  );
  expect(updatedBalance.ok(), await updatedBalance.text()).toBeTruthy();
  expect((await updatedBalance.json()).allowance).toBe(23.5);
  const auditResponse = await request.get(`${apiBase}/collections/audit_logs/records`, {
    headers: adminHeaders,
    params: {
      page: 1,
      perPage: 10,
      filter: `action = 'leave_balance.updated' && entityId = '${vacationBalance.id}'`,
    },
  });
  expect(auditResponse.ok(), await auditResponse.text()).toBeTruthy();
  const audits = (await auditResponse.json()) as {
    items: Array<{ metadata: { after: { allowance: number } } }>;
  };
  expect(audits.items.some((audit) => audit.metadata.after.allowance === 23.5)).toBe(true);
});
