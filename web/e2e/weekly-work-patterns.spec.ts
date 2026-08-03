import { expect, test, type APIRequestContext } from '@playwright/test';
import readExcelFile from 'read-excel-file/node';
import writeExcelFile from 'write-excel-file/node';
import { buildInspectionWorkbook } from '../src/app/core/inspection-workbook';
import type {
  LeaveRequestRecord,
  MonthlyTimeStatement,
  TimesheetResponse,
  UserRecord,
} from '../src/app/core/models';
import {
  buildMonthlyStatementCsv,
  monthlyStatementCsvFilename,
} from '../src/app/core/monthly-statement-csv';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const apiBase = process.env['OPENJORNADA_E2E_API_URL'] ?? 'http://127.0.0.1:8090/api';
const appBase = process.env['OPENJORNADA_E2E_APP_URL'] ?? 'http://127.0.0.1:4217';
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
  name: string;
  token: string;
  record: UserRecord;
};

type DailyRecord = MonthlyTimeStatement['dailyRecords'][number];

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
  scheduleMode: UserRecord['scheduleMode'] = 'scheduled',
  flexibleWeekdays: number[] = [1, 2, 3, 4, 5],
): Promise<EmployeeProfile> {
  const email = `semana-${label}-${suffix}@example.com`;
  const name = `Semana ${label}`;
  const response = await request.post(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name,
      email,
      password: employeePassword,
      passwordConfirm: employeePassword,
      employeeCode: `SEM-${label}-${suffix}`,
      weeklyHours: contractedWeeklyMinutes / 60,
      employmentType,
      contractedWeeklyMinutes,
      complementaryHoursAgreement,
      scheduleMode,
      flexibleWeekdays,
      role: 'employee',
      active: true,
    },
  });
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  const employee = JSON.parse(body) as UserRecord;
  const auth = await signIn(request, email, employeePassword);
  return { id: employee.id, email, name, token: auth.token, record: employee };
}

function flexiblePlannedMinutes(period: string, weeklyMinutes: number, weekdays: number[]): number {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const ordered = [1, 2, 3, 4, 5, 6, 0].filter((weekday) => weekdays.includes(weekday));
  const base = Math.floor(weeklyMinutes / ordered.length);
  return Array.from({ length: lastDay }, (_, index) => {
    const weekday = new Date(Date.UTC(year, month - 1, index + 1, 12)).getUTCDay();
    const position = ordered.indexOf(weekday);
    return position < 0 ? 0 : base + (position < weeklyMinutes % ordered.length ? 1 : 0);
  }).reduce((total, minutes) => total + minutes, 0);
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
  statement?: MonthlyTimeStatement;
}> {
  const close = await request.post(`${apiBase}/openjornada/monthly-statements/close`, {
    headers: { Authorization: admin.token },
    data: { employee: employee.id, period },
  });
  const text = await close.text();
  if (!close.ok()) return { status: close.status(), text };
  const closed = JSON.parse(text) as { id: string };
  const statement = await request.get(
    `${apiBase}/collections/monthly_time_statements/records/${closed.id}?expand=employee`,
    { headers: { Authorization: admin.token } },
  );
  expect(statement.ok(), await statement.text()).toBeTruthy();
  return {
    status: close.status(),
    text,
    statement: (await statement.json()) as MonthlyTimeStatement,
  };
}

function recordsForWeek(
  statement: NonNullable<Awaited<ReturnType<typeof closeMonth>>['statement']>,
  week: ReturnType<typeof testWeek>,
): DailyRecord[] {
  return statement.dailyRecords.filter((day) => day.date >= week.monday && day.date <= week.sunday);
}

function csvLine(...cells: Array<string | number>): string {
  return cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',');
}

function verifySummaryAndCsv(
  statement: MonthlyTimeStatement,
  employee: EmployeeProfile,
  period: string,
  expected: {
    employmentType: 'full_time' | 'part_time';
    contractedMinutes: number;
    ordinaryMinutes: number;
    complementaryMinutes: number;
    overtimeMinutes: number;
    totalMinutes: number;
  },
): string[] {
  expect(statement).toMatchObject({
    employee: employee.id,
    period,
    version: 1,
    ...expected,
  });
  expect(statement.expand?.employee?.name).toBe(employee.name);
  expect(statement.integrityHash).toMatch(/^[a-f0-9]{64}$/);
  const [year, month] = period.split('-').map(Number);
  expect(statement.dailyRecords).toHaveLength(new Date(Date.UTC(year, month, 0)).getUTCDate());
  expect(statement.dailyRecords.reduce((total, day) => total + day.plannedMinutes, 0)).toBe(
    expected.contractedMinutes,
  );
  expect(statement.dailyRecords.reduce((total, day) => total + day.workedMinutes, 0)).toBe(
    expected.totalMinutes,
  );
  expect(statement.dailyRecords.reduce((total, day) => total + day.ordinaryMinutes, 0)).toBe(
    expected.ordinaryMinutes,
  );
  expect(statement.dailyRecords.reduce((total, day) => total + day.complementaryMinutes, 0)).toBe(
    expected.complementaryMinutes,
  );
  expect(statement.dailyRecords.reduce((total, day) => total + day.overtimeMinutes, 0)).toBe(
    expected.overtimeMinutes,
  );

  const csv = buildMonthlyStatementCsv(statement);
  const lines = csv.split('\r\n');
  expect(monthlyStatementCsvFilename(statement)).toBe(`resumen-jornada-${period}-v1.csv`);
  expect(lines.slice(0, 10)).toEqual([
    `\uFEFF${csvLine('Persona', employee.name)}`,
    csvLine('Periodo', period),
    csvLine('Versión', 1),
    csvLine('Tipo de contrato', expected.employmentType),
    csvLine('Minutos planificados', expected.contractedMinutes),
    csvLine('Minutos ordinarios', expected.ordinaryMinutes),
    csvLine('Minutos complementarios', expected.complementaryMinutes),
    csvLine('Minutos extraordinarios', expected.overtimeMinutes),
    csvLine('Minutos totales', expected.totalMinutes),
    csvLine('Huella', statement.integrityHash),
  ]);
  expect(lines[10]).toBe('');
  expect(lines[11]).toBe(
    csvLine(
      'Fecha',
      'Planificados',
      'Trabajados',
      'Ordinarios',
      'Complementarios',
      'Extraordinarios',
    ),
  );
  expect(lines.slice(12)).toEqual(
    statement.dailyRecords.map((day) =>
      csvLine(
        day.date,
        day.plannedMinutes,
        day.workedMinutes,
        day.ordinaryMinutes,
        day.complementaryMinutes,
        day.overtimeMinutes,
      ),
    ),
  );
  return lines;
}

async function expectNoStatement(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  period: string,
): Promise<void> {
  const response = await request.get(`${apiBase}/collections/monthly_time_statements/records`, {
    headers: { Authorization: admin.token },
    params: {
      page: 1,
      perPage: 1,
      filter: `employee = '${employee.id}' && period = '${period}'`,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { totalItems: number };
  expect(body.totalItems).toBe(0);
}

async function loadInspectionTimesheet(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  from: string,
  to: string,
): Promise<TimesheetResponse> {
  const response = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: { employee: employee.id, from, to },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as TimesheetResponse;
}

test('full-time and part-time weekly patterns classify overtime and complementary hours correctly', async ({
  page,
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
  const fullTimeCsv = verifySummaryAndCsv(fullTimeClose.statement!, fullTime, week.period, {
    employmentType: 'full_time',
    contractedMinutes: 2400,
    ordinaryMinutes: 2400,
    complementaryMinutes: 0,
    overtimeMinutes: 0,
    totalMinutes: 2400,
  });
  expect(fullTimeCsv).toContain(csvLine(week.dates[0], 480, 480, 480, 0, 0));
  expect(fullTimeCsv).toContain(csvLine(week.dates[5], 0, 0, 0, 0, 0));
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

  const fullTimeOvertime = await createEmployee(
    request,
    admin,
    suffix,
    'completa-extra',
    'full_time',
    2400,
    false,
  );
  await assignSchedule(request, admin, fullTimeOvertime, week, [1, 2, 3, 4, 5], '09:00', '17:00');
  const fullTimeOvertimeDays = [
    ['09:00', '17:00'],
    ['09:00', '18:00'],
    ['09:00', '16:00'],
    ['09:00', '19:00'],
    ['09:00', '17:00'],
    ['09:00', '11:00'],
  ] as const;
  for (let index = 0; index < fullTimeOvertimeDays.length; index += 1) {
    await addWorkedDay(
      request,
      admin,
      fullTimeOvertime,
      week.dates[index],
      fullTimeOvertimeDays[index][0],
      fullTimeOvertimeDays[index][1],
    );
  }
  const fullTimeOvertimeClose = await closeMonth(request, admin, fullTimeOvertime, week.period);
  expect(fullTimeOvertimeClose.status, fullTimeOvertimeClose.text).toBe(201);
  const fullTimeOvertimeCsv = verifySummaryAndCsv(
    fullTimeOvertimeClose.statement!,
    fullTimeOvertime,
    week.period,
    {
      employmentType: 'full_time',
      contractedMinutes: 2400,
      ordinaryMinutes: 2340,
      complementaryMinutes: 0,
      overtimeMinutes: 300,
      totalMinutes: 2640,
    },
  );
  expect(fullTimeOvertimeCsv).toContain(csvLine(week.dates[1], 480, 540, 480, 0, 60));
  expect(fullTimeOvertimeCsv).toContain(csvLine(week.dates[2], 480, 420, 420, 0, 0));
  expect(fullTimeOvertimeCsv).toContain(csvLine(week.dates[3], 480, 600, 480, 0, 120));
  expect(fullTimeOvertimeCsv).toContain(csvLine(week.dates[5], 0, 120, 0, 0, 120));

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
  const partTimeCsv = verifySummaryAndCsv(
    partTimeClose.statement!,
    partTimeWithAgreement,
    week.period,
    {
      employmentType: 'part_time',
      contractedMinutes: 1200,
      ordinaryMinutes: 1140,
      complementaryMinutes: 300,
      overtimeMinutes: 0,
      totalMinutes: 1440,
    },
  );
  expect(partTimeCsv).toContain(csvLine(week.dates[1], 240, 300, 240, 60, 0));
  expect(partTimeCsv).toContain(csvLine(week.dates[2], 240, 180, 180, 0, 0));
  expect(partTimeCsv).toContain(csvLine(week.dates[3], 240, 360, 240, 120, 0));
  expect(partTimeCsv).toContain(csvLine(week.dates[5], 0, 120, 0, 120, 0));
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
  await expectNoStatement(request, admin, partTimeWithoutAgreement, week.period);

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
  const saturdayCsv = verifySummaryAndCsv(saturdayClose.statement!, partTimeSaturday, week.period, {
    employmentType: 'part_time',
    contractedMinutes: 1200,
    ordinaryMinutes: 1200,
    complementaryMinutes: 0,
    overtimeMinutes: 0,
    totalMinutes: 1200,
  });
  expect(saturdayCsv).toContain(csvLine(week.dates[0], 0, 0, 0, 0, 0));
  expect(saturdayCsv).toContain(csvLine(week.dates[5], 240, 240, 240, 0, 0));
  expect(saturdayCsv).toContain(csvLine(week.dates[6], 0, 0, 0, 0, 0));
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

  const inspectionEmployees = [
    fullTime,
    fullTimeOvertime,
    partTimeWithAgreement,
    partTimeWithoutAgreement,
    partTimeSaturday,
  ];
  const inspectionData = await Promise.all(
    inspectionEmployees.map(async (employee) => ({
      employee: employee.record,
      timesheets: [
        await loadInspectionTimesheet(request, admin, employee, week.monday, week.sunday),
      ],
    })),
  );
  const inspectionWorkbook = buildInspectionWorkbook(
    inspectionData,
    week.monday,
    week.sunday,
    new Date(`${week.sunday}T18:00:00Z`),
  );
  const inspectionBuffer = await writeExcelFile(inspectionWorkbook, {
    fontFamily: 'Arial',
    fontSize: 10,
  }).toBuffer();
  const reopenedInspection = await readExcelFile(inspectionBuffer);

  expect(reopenedInspection).toHaveLength(inspectionEmployees.length + 1);
  expect(reopenedInspection[0].sheet).toBe('Resumen');
  for (const employee of inspectionEmployees) {
    expect(
      reopenedInspection.some(
        (sheet) =>
          sheet.sheet !== 'Resumen' &&
          sheet.data.some((row) => row[0] === 'Código' && row[1] === employee.record.employeeCode),
      ),
    ).toBe(true);
  }

  const overtimeInspection = reopenedInspection.find((sheet) =>
    sheet.data.some(
      (row) => row[0] === 'Código' && row[1] === fullTimeOvertime.record.employeeCode,
    ),
  );
  const complementaryInspection = reopenedInspection.find((sheet) =>
    sheet.data.some(
      (row) => row[0] === 'Código' && row[1] === partTimeWithAgreement.record.employeeCode,
    ),
  );
  const saturdayInspection = reopenedInspection.find((sheet) =>
    sheet.data.some(
      (row) => row[0] === 'Código' && row[1] === partTimeSaturday.record.employeeCode,
    ),
  );
  expect(overtimeInspection).toBeDefined();
  expect(complementaryInspection).toBeDefined();
  expect(saturdayInspection).toBeDefined();
  expect(
    overtimeInspection!.data
      .find((row) => row[0] instanceof Date && row[0].toISOString().slice(0, 10) === week.dates[1])
      ?.slice(2, 7),
  ).toEqual([480, 540, 60, 0, 60]);
  expect(
    complementaryInspection!.data
      .find((row) => row[0] instanceof Date && row[0].toISOString().slice(0, 10) === week.dates[1])
      ?.slice(2, 7),
  ).toEqual([240, 300, 60, 60, 0]);
  expect(
    saturdayInspection!.data
      .find((row) => row[0] instanceof Date && row[0].toISOString().slice(0, 10) === week.dates[5])
      ?.slice(2, 7),
  ).toEqual([240, 240, 0, 0, 0]);

  const companyEmployeesResponse = await request.get(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    params: {
      page: 1,
      perPage: 500,
      sort: 'name',
      filter: "role = 'employee'",
    },
  });
  expect(companyEmployeesResponse.ok(), await companyEmployeesResponse.text()).toBeTruthy();
  const companyEmployees = (await companyEmployeesResponse.json()) as { items: UserRecord[] };

  await page.addInitScript(({ token, record }) => {
    localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }));
  }, admin);
  await page.goto(`${appBase}/informes`);
  await expect(page.getByRole('heading', { name: 'Excel por empleado' })).toBeVisible();
  await acknowledgePrivacyNotice(page);
  await page.getByLabel('Desde').fill(week.monday);
  await page.getByLabel('Hasta').fill(week.sunday);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar Excel' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    `inspeccion-jornada-${week.monday}-${week.sunday}.xlsx`,
  );
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const downloadedWorkbook = await readExcelFile(downloadedPath!);
  expect(downloadedWorkbook).toHaveLength(companyEmployees.items.length + 1);
  for (const employee of companyEmployees.items) {
    expect(
      downloadedWorkbook.some((sheet) =>
        sheet.data.some((row) => row[0] === 'Código' && row[1] === employee.employeeCode),
      ),
    ).toBe(true);
  }
  await expect(
    page.getByText(
      `Excel de inspección generado con ${companyEmployees.items.length} hojas de personal y una hoja resumen.`,
    ),
  ).toBeVisible();
});

test('weekly flexible computation closes variable weeks without fixed time bands', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución cubre el cómputo semanal flexible.',
  );

  const admin = await signIn(request, adminEmail, adminPassword);
  const suffix = `${Date.now()}`;
  const week = testWeek();
  const referenceWeekdays = [1, 2, 3, 4, 5];

  const fullTime = await createEmployee(
    request,
    admin,
    suffix,
    'flexible-completa',
    'full_time',
    2400,
    false,
    'weekly_flexible',
    referenceWeekdays,
  );
  const variableDays = [
    ['09:00', '17:00'],
    ['08:00', '17:00'],
    ['10:00', '18:00'],
    ['07:00', '15:00'],
    ['08:00', '17:00'],
  ] as const;
  for (let index = 0; index < variableDays.length; index += 1) {
    await addWorkedDay(
      request,
      admin,
      fullTime,
      week.dates[index],
      variableDays[index][0],
      variableDays[index][1],
    );
  }
  const fullTimeClose = await closeMonth(request, admin, fullTime, week.period);
  expect(fullTimeClose.status, fullTimeClose.text).toBe(201);
  verifySummaryAndCsv(fullTimeClose.statement!, fullTime, week.period, {
    employmentType: 'full_time',
    contractedMinutes: flexiblePlannedMinutes(week.period, 2400, referenceWeekdays),
    ordinaryMinutes: 2400,
    complementaryMinutes: 0,
    overtimeMinutes: 120,
    totalMinutes: 2520,
  });
  expect(recordsForWeek(fullTimeClose.statement!, week)[4]).toMatchObject({
    workedMinutes: 540,
    ordinaryMinutes: 420,
    overtimeMinutes: 120,
  });

  const partTime = await createEmployee(
    request,
    admin,
    suffix,
    'flexible-parcial',
    'part_time',
    1200,
    false,
    'weekly_flexible',
    referenceWeekdays,
  );
  await addWorkedDay(request, admin, partTime, week.dates[0], '08:00', '18:00');
  await addWorkedDay(request, admin, partTime, week.dates[3], '09:00', '19:00');
  const partTimeClose = await closeMonth(request, admin, partTime, week.period);
  expect(partTimeClose.status, partTimeClose.text).toBe(201);
  verifySummaryAndCsv(partTimeClose.statement!, partTime, week.period, {
    employmentType: 'part_time',
    contractedMinutes: flexiblePlannedMinutes(week.period, 1200, referenceWeekdays),
    ordinaryMinutes: 1200,
    complementaryMinutes: 0,
    overtimeMinutes: 0,
    totalMinutes: 1200,
  });

  const scheduled = await createEmployee(
    request,
    admin,
    suffix,
    'sin-plan-periodo',
    'part_time',
    1200,
    false,
  );
  await addWorkedDay(request, admin, scheduled, week.dates[0], '09:00', '13:00');
  const rejectedClose = await closeMonth(request, admin, scheduled, week.period);
  expect(rejectedClose.status).toBe(400);
  expect(rejectedClose.text).toContain(`No existe una planificación aplicable a ${week.period}`);
  expect(rejectedClose.text).not.toContain('sin pacto de horas complementarias');

  await page.addInitScript(({ token, record }) => {
    localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }));
  }, admin);
  await page.goto(`${appBase}/equipo`);
  await acknowledgePrivacyNotice(page);
  const flexibleMember = page.locator(`[data-member-email="${fullTime.email}"]`);
  await expect(flexibleMember).toContainText('Cómputo flexible');
  await expect(flexibleMember.getByLabel(`Cómputo de jornada de ${fullTime.name}`)).toHaveValue(
    'weekly_flexible',
  );
  await expect(flexibleMember.getByText('Días laborables de referencia')).toBeVisible();
});

test('a flexible part-time schedule keeps every archived week in the monthly close', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'El cálculo histórico sólo necesita una ejecución de navegador.',
  );

  const admin = await signIn(request, adminEmail, adminPassword);
  const suffix = `${Date.now()}`;
  const baseWeek = testWeek();
  const employee = await createEmployee(
    request,
    admin,
    suffix,
    'flexible',
    'part_time',
    1200,
    false,
  );
  const employeeName = `A · Jornada flexible ${suffix}`;
  const rename = await request.patch(`${apiBase}/collections/users/records/${employee.id}`, {
    headers: { Authorization: admin.token },
    data: { name: employeeName },
  });
  expect(rename.ok(), await rename.text()).toBeTruthy();
  employee.name = employeeName;
  employee.record.name = employeeName;

  const patterns = [
    { weekdays: [1, 2, 3, 4], start: '09:00', end: '14:00', dailyMinutes: 300 },
    { weekdays: [2, 3, 4, 5], start: '10:00', end: '15:00', dailyMinutes: 300 },
    { weekdays: [1, 3, 5], start: '09:00', end: '15:40', dailyMinutes: 400 },
    { weekdays: [2, 4, 6], start: '08:20', end: '15:00', dailyMinutes: 400 },
  ];
  let expectedPlannedMinutes = 0;

  for (let index = 0; index < patterns.length; index += 1) {
    const monday = addDays(baseWeek.monday, index * 7);
    const dates = Array.from({ length: 7 }, (_, day) => addDays(monday, day));
    const week = {
      period: baseWeek.period,
      monday,
      sunday: dates[6],
      dates,
    };
    const pattern = patterns[index];
    await assignSchedule(
      request,
      admin,
      employee,
      week,
      pattern.weekdays,
      pattern.start,
      pattern.end,
    );
    expectedPlannedMinutes +=
      dates.filter(
        (date) =>
          date.startsWith(`${baseWeek.period}-`) &&
          pattern.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()),
      ).length * pattern.dailyMinutes;
  }

  const scheduleList = await request.get(`${apiBase}/collections/work_schedules/records`, {
    headers: { Authorization: admin.token },
    params: { perPage: 100, filter: `employee = '${employee.id}'` },
  });
  expect(scheduleList.ok(), await scheduleList.text()).toBeTruthy();
  const schedules = (await scheduleList.json()) as { items: Array<{ id: string }> };
  expect(schedules.items).toHaveLength(patterns.length);
  for (const schedule of schedules.items) {
    const archived = await request.patch(
      `${apiBase}/collections/work_schedules/records/${schedule.id}`,
      {
        headers: { Authorization: admin.token },
        data: { active: false },
      },
    );
    expect(archived.ok(), await archived.text()).toBeTruthy();
  }

  const leaveTypesResponse = await request.get(`${apiBase}/collections/leave_types/records`, {
    headers: { Authorization: admin.token },
    params: {
      perPage: 1,
      filter: `organization = '${admin.record.organization}' && code = 'vacation'`,
    },
  });
  expect(leaveTypesResponse.ok(), await leaveTypesResponse.text()).toBeTruthy();
  const leaveTypes = (await leaveTypesResponse.json()) as { items: Array<{ id: string }> };
  expect(leaveTypes.items).toHaveLength(1);
  const leaveTypeId = leaveTypes.items[0]!.id;
  const balance = await request.get(`${apiBase}/collections/leave_balances/records`, {
    headers: { Authorization: admin.token },
    params: {
      perPage: 1,
      filter: `employee = '${employee.id}' && leaveType = '${leaveTypeId}' && year = ${Number(baseWeek.period.slice(0, 4))}`,
    },
  });
  expect(balance.ok(), await balance.text()).toBeTruthy();
  expect(((await balance.json()) as { totalItems: number }).totalItems).toBe(1);
  const archivedWorkday = baseWeek.monday;
  const leave = await request.post(`${apiBase}/collections/leave_requests/records`, {
    headers: { Authorization: employee.token },
    data: {
      organization: admin.record.organization,
      employee: employee.id,
      type: 'vacation',
      leaveType: leaveTypeId,
      startDate: `${archivedWorkday} 00:00:00.000Z`,
      endDate: `${archivedWorkday} 23:59:59.999Z`,
      dayPart: 'full',
      requestedDays: 99,
      reason: 'Comprobación de planificación semanal archivada',
      status: 'pending',
    },
  });
  expect(leave.ok(), await leave.text()).toBeTruthy();
  const pendingLeave = (await leave.json()) as LeaveRequestRecord;
  expect(pendingLeave).toMatchObject({ status: 'pending', requestedDays: 1 });
  const cancelLeave = await request.patch(
    `${apiBase}/collections/leave_requests/records/${pendingLeave.id}`,
    {
      headers: { Authorization: employee.token },
      data: { status: 'cancelled' },
    },
  );
  expect(cancelLeave.ok(), await cancelLeave.text()).toBeTruthy();

  await page.addInitScript(({ token, record }) => {
    localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }));
  }, admin);
  await page.goto(`${appBase}/resumenes`);
  await acknowledgePrivacyNotice(page);
  await expect(page.getByRole('heading', { name: 'Resúmenes mensuales' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Persona' })).toHaveValue(employee.id);
  await page.getByLabel('Mes terminado').fill(baseWeek.period);
  await page.getByRole('button', { name: 'Cerrar y entregar' }).click();
  await expect(
    page.getByText('Periodo cerrado y resumen puesto a disposición de la persona.'),
  ).toBeVisible();

  const statementResponse = await request.get(
    `${apiBase}/collections/monthly_time_statements/records`,
    {
      headers: { Authorization: admin.token },
      params: {
        page: 1,
        perPage: 1,
        sort: '-version',
        filter: `employee = '${employee.id}' && period = '${baseWeek.period}'`,
      },
    },
  );
  expect(statementResponse.ok(), await statementResponse.text()).toBeTruthy();
  const statements = (await statementResponse.json()) as { items: MonthlyTimeStatement[] };
  expect(statements.items).toHaveLength(1);
  expect(statements.items[0]).toMatchObject({
    employee: employee.id,
    employmentType: 'part_time',
    contractedMinutes: expectedPlannedMinutes,
    totalMinutes: 0,
    ordinaryMinutes: 0,
    complementaryMinutes: 0,
    overtimeMinutes: 0,
  });
  expect(
    statements.items[0].dailyRecords.reduce((total, day) => total + day.plannedMinutes, 0),
  ).toBe(expectedPlannedMinutes);

  const reactivatePastSchedule = await request.patch(
    `${apiBase}/collections/work_schedules/records/${schedules.items[0]!.id}`,
    {
      headers: { Authorization: admin.token },
      data: { active: true },
    },
  );
  expect(reactivatePastSchedule.ok(), await reactivatePastSchedule.text()).toBeTruthy();

  const employeeContext = await page.context().browser()!.newContext();
  await employeeContext.addInitScript(({ token, record }) => {
    localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record }));
  }, employee);
  const employeePage = await employeeContext.newPage();
  await employeePage.goto(`${appBase}/horarios`);
  await acknowledgePrivacyNotice(employeePage);
  await expect(employeePage.locator('article')).toHaveCount(patterns.length);
  await expect(employeePage.getByText('Finalizado', { exact: true })).toHaveCount(1);
  await expect(employeePage.getByText('Archivado', { exact: true })).toHaveCount(
    patterns.length - 1,
  );

  await employeePage.goto(appBase);
  await expect(employeePage.getByText('Objetivo diario')).toBeVisible();
  await expect(employeePage.getByText('Sin planificación', { exact: true })).toBeVisible();
  await employeeContext.close();
});
