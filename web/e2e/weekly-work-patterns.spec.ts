import { expect, test, type APIRequestContext } from '@playwright/test';

const apiBase = process.env['OPENJORNADA_E2E_API_URL'] ?? 'http://127.0.0.1:8090/api';
const adminEmail = process.env['OPENJORNADA_E2E_ADMIN_EMAIL'] ?? 'admin@example.com';
const adminPassword = process.env['OPENJORNADA_E2E_ADMIN_PASSWORD'] ?? 'TestPassword123!';
const employeePassword = 'WeeklyPatternPassword123!';

type Authentication = {
  token: string;
  record: { id: string; organization: string };
};

type EmployeeProfile = {
  id: string;
  email: string;
  token: string;
};

type DailyRecord = {
  date: string;
  plannedMinutes: number;
  workedMinutes: number;
  ordinaryMinutes: number;
  complementaryMinutes: number;
  overtimeMinutes: number;
};

async function signIn(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<Authentication> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity: email, password },
    });
    if (response.ok()) return (await response.json()) as Authentication;
    if (attempt === 3) {
      throw new Error(
        `No se pudo autenticar ${email}: ${response.status()} ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${email}`);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function testWeek(): {
  period: string;
  monday: string;
  sunday: string;
  dates: string[];
} {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 12));
  while (monthStart.getUTCDay() !== 1) {
    monthStart.setUTCDate(monthStart.getUTCDate() + 1);
  }
  const monday = monthStart.toISOString().slice(0, 10);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  return {
    period: monday.slice(0, 7),
    monday,
    sunday: dates[6],
    dates,
  };
}

async function createEmployee(
  request: APIRequestContext,
  admin: Authentication,
  suffix: string,
  label: string,
  employmentType: 'full_time' | 'part_time',
  contractedWeeklyMinutes: number,
  complementaryHoursAgreement: boolean,
): Promise<EmployeeProfile> {
  const email = `semana-${label}-${suffix}@example.com`;
  const response = await request.post(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name: `Semana ${label}`,
      email,
      password: employeePassword,
      passwordConfirm: employeePassword,
      employeeCode: `SEM-${label}-${suffix}`,
      weeklyHours: contractedWeeklyMinutes / 60,
      employmentType,
      contractedWeeklyMinutes,
      complementaryHoursAgreement,
      role: 'employee',
      active: true,
    },
  });
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  const employee = JSON.parse(body) as { id: string };
  const auth = await signIn(request, email, employeePassword);
  return { id: employee.id, email, token: auth.token };
}

async function assignSchedule(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  week: ReturnType<typeof testWeek>,
  weekdays: number[],
  startTime: string,
  endTime: string,
): Promise<void> {
  const response = await request.post(`${apiBase}/openjornada/work-schedules/bulk`, {
    headers: { Authorization: admin.token },
    data: {
      employeeIds: [employee.id],
      name: 'Semana completa E2E',
      validFrom: week.monday,
      validUntil: week.sunday,
      weekdays,
      startTime,
      endTime,
      breakMinutes: 0,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function addWorkedDay(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  date: string,
  start: string,
  end: string,
): Promise<void> {
  const response = await request.post(`${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: date,
      intervals: [
        {
          kind: 'work',
          start,
          end,
          startNextDay: false,
          breakType: '',
        },
      ],
      reason: 'Semana laboral completa para prueba E2E',
    },
  });
  const body = await response.text();
  expect(response.status(), body).toBe(201);
  const created = JSON.parse(body) as { id: string; status: string };
  if (created.status === 'pending') {
    const resolution = await request.post(
      `${apiBase}/openjornada/manual-time-requests/${created.id}/resolve`,
      {
        headers: { Authorization: admin.token },
        data: {
          status: 'approved',
          resolutionNote: 'Semana aprobada para prueba E2E.',
        },
      },
    );
    expect(resolution.ok(), await resolution.text()).toBeTruthy();
  } else {
    expect(created.status).toBe('approved');
  }
}

async function closeMonth(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  period: string,
): Promise<{
  status: number;
  text: string;
  statement?: {
    employmentType: 'full_time' | 'part_time';
    contractedMinutes: number;
    ordinaryMinutes: number;
    complementaryMinutes: number;
    overtimeMinutes: number;
    totalMinutes: number;
    dailyRecords: DailyRecord[];
  };
}> {
  const close = await request.post(`${apiBase}/openjornada/monthly-statements/close`, {
    headers: { Authorization: admin.token },
    data: { employee: employee.id, period },
  });
  const text = await close.text();
  if (!close.ok()) return { status: close.status(), text };
  const closed = JSON.parse(text) as { id: string };
  const statement = await request.get(
    `${apiBase}/collections/monthly_time_statements/records/${closed.id}`,
    { headers: { Authorization: admin.token } },
  );
  expect(statement.ok(), await statement.text()).toBeTruthy();
  return {
    status: close.status(),
    text,
    statement: (await statement.json()) as {
      employmentType: 'full_time' | 'part_time';
      contractedMinutes: number;
      ordinaryMinutes: number;
      complementaryMinutes: number;
      overtimeMinutes: number;
      totalMinutes: number;
      dailyRecords: DailyRecord[];
    },
  };
}

function recordsForWeek(
  statement: NonNullable<Awaited<ReturnType<typeof closeMonth>>['statement']>,
  week: ReturnType<typeof testWeek>,
): DailyRecord[] {
  return statement.dailyRecords.filter((day) => day.date >= week.monday && day.date <= week.sunday);
}

test('full-time and part-time weekly patterns classify complementary hours correctly', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución cubre las cuatro casuísticas semanales.',
  );

  const admin = await signIn(request, adminEmail, adminPassword);
  const suffix = `${Date.now()}`;
  const week = testWeek();

  const fullTime = await createEmployee(
    request,
    admin,
    suffix,
    'completa',
    'full_time',
    2400,
    false,
  );
  await assignSchedule(request, admin, fullTime, week, [1, 2, 3, 4, 5], '09:00', '17:00');
  for (const date of week.dates.slice(0, 5)) {
    await addWorkedDay(request, admin, fullTime, date, '09:00', '17:00');
  }
  const fullTimeClose = await closeMonth(request, admin, fullTime, week.period);
  expect(fullTimeClose.status, fullTimeClose.text).toBe(201);
  expect(fullTimeClose.statement).toMatchObject({
    employmentType: 'full_time',
    contractedMinutes: 2400,
    ordinaryMinutes: 2400,
    complementaryMinutes: 0,
    overtimeMinutes: 0,
    totalMinutes: 2400,
  });
  expect(
    recordsForWeek(fullTimeClose.statement!, week).map((day) => ({
      planned: day.plannedMinutes,
      worked: day.workedMinutes,
    })),
  ).toEqual([
    { planned: 480, worked: 480 },
    { planned: 480, worked: 480 },
    { planned: 480, worked: 480 },
    { planned: 480, worked: 480 },
    { planned: 480, worked: 480 },
    { planned: 0, worked: 0 },
    { planned: 0, worked: 0 },
  ]);

  const partTimeWithAgreement = await createEmployee(
    request,
    admin,
    suffix,
    'parcial-pacto',
    'part_time',
    1200,
    true,
  );
  await assignSchedule(
    request,
    admin,
    partTimeWithAgreement,
    week,
    [1, 2, 3, 4, 5],
    '09:00',
    '13:00',
  );
  const partTimeDays = [
    ['09:00', '13:00'],
    ['09:00', '14:00'],
    ['09:00', '12:00'],
    ['09:00', '15:00'],
    ['09:00', '13:00'],
    ['09:00', '11:00'],
  ] as const;
  for (let index = 0; index < partTimeDays.length; index += 1) {
    await addWorkedDay(
      request,
      admin,
      partTimeWithAgreement,
      week.dates[index],
      partTimeDays[index][0],
      partTimeDays[index][1],
    );
  }
  const partTimeClose = await closeMonth(request, admin, partTimeWithAgreement, week.period);
  expect(partTimeClose.status, partTimeClose.text).toBe(201);
  expect(partTimeClose.statement).toMatchObject({
    employmentType: 'part_time',
    contractedMinutes: 1200,
    ordinaryMinutes: 1140,
    complementaryMinutes: 300,
    overtimeMinutes: 0,
    totalMinutes: 1440,
  });
  const partTimeWeek = recordsForWeek(partTimeClose.statement!, week);
  expect(partTimeWeek[1]).toMatchObject({
    plannedMinutes: 240,
    workedMinutes: 300,
    ordinaryMinutes: 240,
    complementaryMinutes: 60,
  });
  expect(partTimeWeek[2]).toMatchObject({
    plannedMinutes: 240,
    workedMinutes: 180,
    ordinaryMinutes: 180,
    complementaryMinutes: 0,
  });
  expect(partTimeWeek[3]).toMatchObject({
    plannedMinutes: 240,
    workedMinutes: 360,
    ordinaryMinutes: 240,
    complementaryMinutes: 120,
  });
  expect(partTimeWeek[5]).toMatchObject({
    plannedMinutes: 0,
    workedMinutes: 120,
    ordinaryMinutes: 0,
    complementaryMinutes: 120,
  });

  const partTimeWithoutAgreement = await createEmployee(
    request,
    admin,
    suffix,
    'parcial-sin-pacto',
    'part_time',
    1200,
    false,
  );
  await assignSchedule(
    request,
    admin,
    partTimeWithoutAgreement,
    week,
    [1, 2, 3, 4, 5],
    '09:00',
    '13:00',
  );
  for (let index = 0; index < 5; index += 1) {
    await addWorkedDay(
      request,
      admin,
      partTimeWithoutAgreement,
      week.dates[index],
      '09:00',
      index === 1 ? '14:00' : '13:00',
    );
  }
  const rejectedClose = await closeMonth(request, admin, partTimeWithoutAgreement, week.period);
  expect(rejectedClose.status).toBe(400);
  expect(rejectedClose.text).toContain('sin pacto de horas complementarias');

  const partTimeSaturday = await createEmployee(
    request,
    admin,
    suffix,
    'parcial-sabado',
    'part_time',
    1200,
    false,
  );
  await assignSchedule(request, admin, partTimeSaturday, week, [2, 3, 4, 5, 6], '09:00', '13:00');
  for (const date of week.dates.slice(1, 6)) {
    await addWorkedDay(request, admin, partTimeSaturday, date, '09:00', '13:00');
  }
  const saturdayClose = await closeMonth(request, admin, partTimeSaturday, week.period);
  expect(saturdayClose.status, saturdayClose.text).toBe(201);
  expect(saturdayClose.statement).toMatchObject({
    employmentType: 'part_time',
    contractedMinutes: 1200,
    ordinaryMinutes: 1200,
    complementaryMinutes: 0,
    overtimeMinutes: 0,
    totalMinutes: 1200,
  });
  const saturdayWeek = recordsForWeek(saturdayClose.statement!, week);
  expect(saturdayWeek[0]).toMatchObject({
    plannedMinutes: 0,
    workedMinutes: 0,
  });
  expect(saturdayWeek[5]).toMatchObject({
    plannedMinutes: 240,
    workedMinutes: 240,
    ordinaryMinutes: 240,
    complementaryMinutes: 0,
  });
  expect(saturdayWeek[6]).toMatchObject({
    plannedMinutes: 0,
    workedMinutes: 0,
  });
});
