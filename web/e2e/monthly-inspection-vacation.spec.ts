import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type TestInfo,
} from '@playwright/test';
import readExcelFile from 'read-excel-file/node';
import writeExcelFile from 'write-excel-file/node';
import { buildInspectionWorkbook } from '../src/app/core/inspection-workbook';
import type {
  LeaveBalanceRecord,
  LeaveRequestRecord,
  MonthlyTimeStatement,
  TimesheetResponse,
  UserRecord,
} from '../src/app/core/models';
import { buildMonthlyStatementCsv } from '../src/app/core/monthly-statement-csv';

const apiBase = process.env['OPENJORNADA_E2E_API_URL'] ?? 'http://127.0.0.1:8090/api';
const adminEmail = process.env['OPENJORNADA_E2E_ADMIN_EMAIL'] ?? 'admin@example.com';
const adminPassword = process.env['OPENJORNADA_E2E_ADMIN_PASSWORD'] ?? 'TestPassword123!';
const employeePassword = 'MonthlySimulationPassword123!';
const rateLimitWindowMs = 5_200;

type Authentication = {
  token: string;
  record: { id: string; organization: string };
};

type EmployeeProfile = {
  token: string;
  record: UserRecord;
};

type Scenario = {
  label: string;
  name: string;
  employmentType: 'full_time' | 'part_time';
  contractedWeeklyMinutes: number;
  complementaryHoursAgreement: boolean;
  weekdays: number[];
  start: string;
  end: string;
  extraWeekday?: number;
  allowance: number;
  vacationDays: number;
  vacationPart: LeaveRequestRecord['dayPart'];
};

type ScenarioResult = {
  scenario: Scenario;
  employee: EmployeeProfile;
  statement: MonthlyTimeStatement;
  plannedMinutes: number;
  workedMinutes: number;
  ordinaryMinutes: number;
  complementaryMinutes: number;
  overtimeMinutes: number;
  workedDates: string[];
};

async function postWithRateLimit(
  request: APIRequestContext,
  url: string,
  options?: Parameters<APIRequestContext['post']>[1],
): Promise<APIResponse> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await request.post(url, options);
    if (response.status() !== 429) return response;
    if (attempt === 11) {
      throw new Error(
        `El límite de peticiones siguió activo para ${url}: ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, rateLimitWindowMs));
  }
  throw new Error(`No se pudo completar POST ${url}`);
}

const scenarios: Scenario[] = [
  {
    label: 'completa',
    name: 'Ana Jornada Completa',
    employmentType: 'full_time',
    contractedWeeklyMinutes: 2400,
    complementaryHoursAgreement: false,
    weekdays: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '17:00',
    allowance: 22,
    vacationDays: 2,
    vacationPart: 'full',
  },
  {
    label: 'completa-extra',
    name: 'Bruno Completa con Extra',
    employmentType: 'full_time',
    contractedWeeklyMinutes: 2400,
    complementaryHoursAgreement: false,
    weekdays: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '17:00',
    extraWeekday: 3,
    allowance: 24,
    vacationDays: 1,
    vacationPart: 'full',
  },
  {
    label: 'parcial',
    name: 'Carla Media Jornada',
    employmentType: 'part_time',
    contractedWeeklyMinutes: 1200,
    complementaryHoursAgreement: false,
    weekdays: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '13:00',
    allowance: 20.5,
    vacationDays: 1,
    vacationPart: 'morning',
  },
  {
    label: 'parcial-complementaria',
    name: 'Diego Parcial Complementaria',
    employmentType: 'part_time',
    contractedWeeklyMinutes: 1200,
    complementaryHoursAgreement: true,
    weekdays: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '13:00',
    extraWeekday: 4,
    allowance: 25,
    vacationDays: 1,
    vacationPart: 'full',
  },
  {
    label: 'parcial-sabado',
    name: 'Eva Parcial con Sábados',
    employmentType: 'part_time',
    contractedWeeklyMinutes: 1200,
    complementaryHoursAgreement: false,
    weekdays: [2, 3, 4, 5, 6],
    start: '09:00',
    end: '13:00',
    allowance: 18,
    vacationDays: 1,
    vacationPart: 'full',
  },
];

async function signIn(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<Authentication> {
  const response = await postWithRateLimit(
    request,
    `${apiBase}/collections/users/auth-with-password`,
    {
      data: { identity: email, password },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as Authentication;
}

function monthBeforeCurrent(): { period: string; first: string; last: string; dates: string[] } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 12));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
  return {
    period: first.toISOString().slice(0, 7),
    first: first.toISOString().slice(0, 10),
    last: last.toISOString().slice(0, 10),
    dates: datesBetween(first, last),
  };
}

function datesBetween(first: Date, last: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(first);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function minutesBetween(start: string, end: string): number {
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  return endHour * 60 + endMinute - startHour * 60 - startMinute;
}

function plusMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function createEmployee(
  request: APIRequestContext,
  admin: Authentication,
  scenario: Scenario,
  suffix: string,
): Promise<EmployeeProfile> {
  const email = `mes-${scenario.label}-${suffix}@example.com`;
  const response = await postWithRateLimit(request, `${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name: `${scenario.name} ${suffix}`,
      email,
      password: employeePassword,
      passwordConfirm: employeePassword,
      employeeCode: `MES-${scenario.label}-${suffix}`,
      weeklyHours: scenario.contractedWeeklyMinutes / 60,
      employmentType: scenario.employmentType,
      contractedWeeklyMinutes: scenario.contractedWeeklyMinutes,
      complementaryHoursAgreement: scenario.complementaryHoursAgreement,
      role: 'employee',
      active: true,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const employee = (await response.json()) as UserRecord;
  const auth = await signIn(request, email, employeePassword);
  return { token: auth.token, record: employee };
}

async function assignSchedule(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  scenario: Scenario,
  validFrom: string,
  validUntil: string,
): Promise<void> {
  const response = await postWithRateLimit(request, `${apiBase}/openjornada/work-schedules/bulk`, {
    headers: { Authorization: admin.token },
    data: {
      employeeIds: [employee.record.id],
      name: `Horario mensual ${scenario.label}`,
      validFrom,
      validUntil,
      weekdays: scenario.weekdays,
      startTime: scenario.start,
      endTime: scenario.end,
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
  const response = await postWithRateLimit(request, `${apiBase}/openjornada/manual-time-requests`, {
    headers: { Authorization: employee.token },
    data: {
      workDate: date,
      intervals: [{ kind: 'work', start, end, startNextDay: false, breakType: '' }],
      reason: 'Simulación mensual E2E para inspección',
    },
  });
  const body = await response.text();
  expect(response.status(), body).toBe(201);
  const created = JSON.parse(body) as { id: string; status: string };
  if (created.status === 'pending') {
    const resolution = await postWithRateLimit(
      request,
      `${apiBase}/openjornada/manual-time-requests/${created.id}/resolve`,
      {
        headers: { Authorization: admin.token },
        data: {
          status: 'approved',
          resolutionNote: 'Jornada mensual aprobada para simulación E2E.',
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
): Promise<MonthlyTimeStatement> {
  const close = await postWithRateLimit(
    request,
    `${apiBase}/openjornada/monthly-statements/close`,
    {
      headers: { Authorization: admin.token },
      data: { employee: employee.record.id, period },
    },
  );
  const closeBody = await close.text();
  expect(close.status(), closeBody).toBe(201);
  const closed = JSON.parse(closeBody) as { id: string };
  const response = await request.get(
    `${apiBase}/collections/monthly_time_statements/records/${closed.id}?expand=employee`,
    { headers: { Authorization: admin.token } },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as MonthlyTimeStatement;
}

async function loadTimesheet(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  from: string,
  to: string,
): Promise<TimesheetResponse> {
  const response = await request.get(`${apiBase}/openjornada/timesheet`, {
    headers: { Authorization: admin.token },
    params: { employee: employee.record.id, from, to },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as TimesheetResponse;
}

function futureDatesFor(weekdays: number[], count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date();
  cursor.setUTCHours(12, 0, 0, 0);
  cursor.setUTCDate(cursor.getUTCDate() + 14);
  while (dates.length < count) {
    if (weekdays.includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function vacationBalance(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  leaveType: string,
  year: number,
  allowance: number,
): Promise<LeaveBalanceRecord> {
  const list = await request.get(`${apiBase}/collections/leave_balances/records`, {
    headers: { Authorization: admin.token },
    params: {
      page: 1,
      perPage: 1,
      filter: `employee = '${employee.record.id}' && leaveType = '${leaveType}' && year = ${year}`,
    },
  });
  expect(list.ok(), await list.text()).toBeTruthy();
  const existing = (await list.json()) as { items: LeaveBalanceRecord[] };
  if (existing.items[0]) {
    const update = await request.patch(
      `${apiBase}/collections/leave_balances/records/${existing.items[0].id}`,
      {
        headers: { Authorization: admin.token },
        data: { allowance },
      },
    );
    expect(update.ok(), await update.text()).toBeTruthy();
    return (await update.json()) as LeaveBalanceRecord;
  }

  const create = await postWithRateLimit(request, `${apiBase}/collections/leave_balances/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      employee: employee.record.id,
      leaveType,
      year,
      allowance,
      carriedOver: 0,
      adjustment: 0,
    },
  });
  expect(create.ok(), await create.text()).toBeTruthy();
  return (await create.json()) as LeaveBalanceRecord;
}

async function requestAndApproveVacation(
  request: APIRequestContext,
  admin: Authentication,
  employee: EmployeeProfile,
  leaveType: string,
  scenario: Scenario,
): Promise<LeaveRequestRecord> {
  const requestedDates = futureDatesFor(
    scenario.label === 'parcial-sabado' ? [6] : scenario.weekdays,
    scenario.vacationDays,
  );
  const create = await postWithRateLimit(request, `${apiBase}/collections/leave_requests/records`, {
    headers: { Authorization: employee.token },
    data: {
      organization: admin.record.organization,
      employee: employee.record.id,
      type: 'vacation',
      leaveType,
      startDate: `${requestedDates[0]} 00:00:00.000Z`,
      endDate: `${requestedDates.at(-1)} 23:59:59.999Z`,
      dayPart: scenario.vacationPart,
      requestedDays: 99,
      reason: `Vacaciones después de inspección: ${scenario.label}`,
      status: 'approved',
    },
  });
  const createBody = await create.text();
  expect(create.ok(), createBody).toBeTruthy();
  const pending = JSON.parse(createBody) as LeaveRequestRecord;
  expect(pending.status).toBe('pending');
  const expectedDays = scenario.vacationPart === 'full' ? scenario.vacationDays : 0.5;
  expect(pending.requestedDays).toBe(expectedDays);

  const approve = await request.patch(
    `${apiBase}/collections/leave_requests/records/${pending.id}`,
    {
      headers: { Authorization: admin.token },
      data: { status: 'approved', response: 'Vacaciones aprobadas tras la inspección.' },
    },
  );
  expect(approve.ok(), await approve.text()).toBeTruthy();
  const approved = (await approve.json()) as LeaveRequestRecord;
  expect(approved).toMatchObject({
    status: 'approved',
    requestedDays: expectedDays,
    reviewedBy: admin.record.id,
  });
  expect(approved.reviewedAt).not.toBe('');
  return approved;
}

async function attachReport(
  testInfo: TestInfo,
  period: string,
  results: ScenarioResult[],
  vacations: LeaveRequestRecord[],
  inspectionBuffer: Buffer,
): Promise<void> {
  await testInfo.attach(`inspeccion-${period}.xlsx`, {
    body: inspectionBuffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await testInfo.attach('resultado-simulacion.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          period,
          employees: results.map((result, index) => ({
            name: result.employee.record.name,
            employmentType: result.scenario.employmentType,
            schedule: result.scenario.weekdays,
            plannedMinutes: result.plannedMinutes,
            workedMinutes: result.workedMinutes,
            complementaryMinutes: result.complementaryMinutes,
            overtimeMinutes: result.overtimeMinutes,
            vacationStatus: vacations[index].status,
            vacationDays: vacations[index].requestedDays,
            vacationAllowance: result.scenario.allowance,
            vacationAvailable: result.scenario.allowance - vacations[index].requestedDays,
          })),
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
}

test('simula un mes de cinco personas, una inspección y sus vacaciones posteriores', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'La simulación de negocio completa sólo necesita una ejecución.',
  );
  test.setTimeout(180_000);

  const admin = await signIn(request, adminEmail, adminPassword);
  const suffix = String(Date.now());
  const month = monthBeforeCurrent();
  const vacationYear = Number(futureDatesFor([1, 2, 3, 4, 5], 1)[0].slice(0, 4));
  const scheduleValidUntil = `${vacationYear}-12-31`;
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const employee = await createEmployee(request, admin, scenario, suffix);
    await assignSchedule(request, admin, employee, scenario, month.first, scheduleValidUntil);
    const workedDates = month.dates.filter((date) => scenario.weekdays.includes(weekday(date)));
    const dailyMinutes = minutesBetween(scenario.start, scenario.end);
    const extraDates = workedDates.filter((date) => weekday(date) === scenario.extraWeekday);
    for (const date of workedDates) {
      await addWorkedDay(
        request,
        admin,
        employee,
        date,
        scenario.start,
        plusMinutes(scenario.end, scenario.extraWeekday === weekday(date) ? 60 : 0),
      );
    }

    const plannedMinutes = workedDates.length * dailyMinutes;
    const excessMinutes = extraDates.length * 60;
    const workedMinutes = plannedMinutes + excessMinutes;
    const statement = await closeMonth(request, admin, employee, month.period);
    const complementaryMinutes = scenario.employmentType === 'part_time' ? excessMinutes : 0;
    const overtimeMinutes = scenario.employmentType === 'full_time' ? excessMinutes : 0;
    expect(statement).toMatchObject({
      employee: employee.record.id,
      period: month.period,
      employmentType: scenario.employmentType,
      contractedMinutes: plannedMinutes,
      ordinaryMinutes: plannedMinutes,
      complementaryMinutes,
      overtimeMinutes,
      totalMinutes: workedMinutes,
    });
    expect(statement.dailyRecords).toHaveLength(month.dates.length);
    expect(statement.integrityHash).toMatch(/^[a-f0-9]{64}$/);

    const csv = buildMonthlyStatementCsv(statement);
    expect(csv).toContain(`"Minutos planificados","${plannedMinutes}"`);
    expect(csv).toContain(`"Minutos complementarios","${complementaryMinutes}"`);
    expect(csv).toContain(`"Minutos extraordinarios","${overtimeMinutes}"`);
    expect(csv).toContain(`"Minutos totales","${workedMinutes}"`);
    expect(csv.split('\r\n')).toHaveLength(month.dates.length + 12);

    results.push({
      scenario,
      employee,
      statement,
      plannedMinutes,
      workedMinutes,
      ordinaryMinutes: plannedMinutes,
      complementaryMinutes,
      overtimeMinutes,
      workedDates,
    });
  }

  const inspectionData = await Promise.all(
    results.map(async (result) => ({
      employee: result.employee.record,
      timesheets: [await loadTimesheet(request, admin, result.employee, month.first, month.last)],
    })),
  );
  const workbook = buildInspectionWorkbook(
    inspectionData,
    month.first,
    month.last,
    new Date(`${month.last}T18:00:00Z`),
  );
  const inspectionBuffer = await writeExcelFile(workbook, {
    fontFamily: 'Arial',
    fontSize: 10,
  }).toBuffer();
  const reopened = await readExcelFile(inspectionBuffer);
  expect(reopened).toHaveLength(results.length + 1);
  expect(reopened[0].sheet).toBe('Resumen');

  for (const result of results) {
    const employeeSheet = reopened.find((sheet) =>
      sheet.data.some(
        (row) => row[0] === 'Código' && row[1] === result.employee.record.employeeCode,
      ),
    );
    expect(employeeSheet).toBeDefined();
    expect(
      reopened[0].data.some(
        (row) =>
          row[0] === result.employee.record.name &&
          row[1] === result.employee.record.employeeCode &&
          row[4] === result.plannedMinutes &&
          row[5] === result.workedMinutes &&
          row[7] === result.complementaryMinutes &&
          row[8] === result.overtimeMinutes &&
          row[9] === result.workedDates.length,
      ),
    ).toBe(true);
  }

  const saturdayResult = results.find((result) => result.scenario.label === 'parcial-sabado')!;
  const saturdaySheet = reopened.find((sheet) =>
    sheet.data.some(
      (row) => row[0] === 'Código' && row[1] === saturdayResult.employee.record.employeeCode,
    ),
  )!;
  const firstSaturday = saturdayResult.workedDates.find((date) => weekday(date) === 6)!;
  expect(
    saturdaySheet.data
      .find((row) => row[0] instanceof Date && row[0].toISOString().slice(0, 10) === firstSaturday)
      ?.slice(2, 7),
  ).toEqual([240, 240, 0, 0, 0]);

  const leaveTypesResponse = await request.get(`${apiBase}/collections/leave_types/records`, {
    headers: { Authorization: admin.token },
    params: { page: 1, perPage: 10, filter: "code = 'vacation'" },
  });
  expect(leaveTypesResponse.ok(), await leaveTypesResponse.text()).toBeTruthy();
  const leaveTypes = (await leaveTypesResponse.json()) as { items: Array<{ id: string }> };
  const vacationType = leaveTypes.items[0];
  expect(vacationType).toBeDefined();

  const vacations: LeaveRequestRecord[] = [];
  for (const result of results) {
    const balance = await vacationBalance(
      request,
      admin,
      result.employee,
      vacationType.id,
      vacationYear,
      result.scenario.allowance,
    );
    expect(balance.allowance).toBe(result.scenario.allowance);
    const vacation = await requestAndApproveVacation(
      request,
      admin,
      result.employee,
      vacationType.id,
      result.scenario,
    );
    vacations.push(vacation);
    expect(result.scenario.allowance - vacation.requestedDays).toBeGreaterThanOrEqual(0);
  }

  const saturdayVacation = vacations.find(
    (_vacation, index) => results[index].scenario.label === 'parcial-sabado',
  );
  expect(saturdayVacation).toBeDefined();
  expect(weekday(saturdayVacation!.startDate.slice(0, 10))).toBe(6);
  expect(vacations.map((vacation) => vacation.status)).toEqual([
    'approved',
    'approved',
    'approved',
    'approved',
    'approved',
  ]);

  await attachReport(testInfo, month.period, results, vacations, inspectionBuffer);
});
