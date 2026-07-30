import { expect, test, type APIRequestContext } from '@playwright/test';
import readExcelFile from 'read-excel-file/node';
import writeExcelFile from 'write-excel-file/node';
import { buildInspectionWorkbook } from '../src/app/core/inspection-workbook';
import type { MonthlyTimeStatement, TimesheetResponse, UserRecord } from '../src/app/core/models';
import {
  buildMonthlyStatementCsv,
  monthlyStatementCsvFilename,
} from '../src/app/core/monthly-statement-csv';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const apiBase = process.env['OPENJORNADA_E2E_API_URL'] ?? 'http://127.0.0.1:8090/api';
const appBase = process.env['OPENJORNADA_E2E_APP_URL'] ?? 'http://127.0.0.1:8090';
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
      filter: "role = 'employee' && (employmentType = 'full_time' || employmentType = 'part_time')",
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
