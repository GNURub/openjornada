import type { SheetData } from 'write-excel-file/browser';
import type { TimesheetDay, TimesheetResponse, UserRecord } from './models';

const HEADER_STYLE = {
  backgroundColor: '#1c1917',
  textColor: '#ffffff',
  fontWeight: 'bold' as const,
  alignVertical: 'center' as const,
  wrap: true,
  borderColor: '#d6d3d1',
  borderStyle: 'thin' as const,
};

const LABEL_STYLE = {
  backgroundColor: '#f5f5f4',
  fontWeight: 'bold' as const,
  textColor: '#57534e',
};

export interface InspectionEmployeeData {
  employee: UserRecord;
  timesheets: TimesheetResponse[];
}

export interface InspectionWorkbookSheet {
  data: SheetData;
  sheet: string;
  columns: Array<{ width: number }>;
  stickyRowsCount: number;
  stickyColumnsCount?: number;
  orientation: 'landscape';
  showGridLines: boolean;
  zoomScale: number;
  dateFormat: string;
}

export function defaultInspectionRange(now = new Date()): { from: string; to: string } {
  const to = localDate(now);
  return { from: subtractYears(to, 4), to };
}

export function inspectionRangeError(
  from: string,
  to: string,
  today = localDate(new Date()),
): string {
  if (!validDate(from) || !validDate(to)) {
    return 'Indica un intervalo de inspección válido.';
  }
  if (from > to) {
    return 'La fecha inicial no puede ser posterior a la final.';
  }
  if (to > today) {
    return 'El intervalo de inspección no puede terminar en el futuro.';
  }
  if (from < subtractYears(to, 4)) {
    return 'Cada Excel de inspección puede abarcar como máximo cuatro años.';
  }
  return '';
}

export function splitInspectionRange(
  from: string,
  to: string,
): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = from;
  while (cursor <= to) {
    const chunkTo = minDate(addDays(cursor, 365), to);
    chunks.push({ from: cursor, to: chunkTo });
    cursor = addDays(chunkTo, 1);
  }
  return chunks;
}

export function inspectionWorkbookFilename(from: string, to: string): string {
  return `inspeccion-jornada-${from}-${to}.xlsx`;
}

export function buildInspectionWorkbook(
  employees: InspectionEmployeeData[],
  from: string,
  to: string,
  generatedAt = new Date(),
): InspectionWorkbookSheet[] {
  const sorted = [...employees].sort((left, right) =>
    left.employee.name.localeCompare(right.employee.name, 'es'),
  );
  const usedNames = new Set<string>(['resumen']);
  const employeeSheets = sorted.map((item) => {
    const days = mergedDays(item.timesheets);
    return employeeSheet(
      item.employee,
      days,
      item.timesheets[0]?.timezone ?? 'Europe/Madrid',
      from,
      to,
      uniqueSheetName(item.employee, usedNames),
    );
  });

  return [summarySheet(sorted, from, to, generatedAt), ...employeeSheets];
}

function summarySheet(
  employees: InspectionEmployeeData[],
  from: string,
  to: string,
  generatedAt: Date,
): InspectionWorkbookSheet {
  const data: SheetData = [
    [
      {
        value: 'OpenJornada · Libro de inspección',
        fontSize: 18,
        fontWeight: 'bold',
        textColor: '#ef4d32',
      },
    ],
    [{ value: 'Periodo', ...LABEL_STYLE }, from, { value: 'Hasta', ...LABEL_STYLE }, to],
    [
      { value: 'Generado', ...LABEL_STYLE },
      generatedAt,
      { value: 'Personas', ...LABEL_STYLE },
      employees.length,
    ],
    [],
    [
      'Persona',
      'Código',
      'Estado',
      'Tipo de contrato',
      'Planificado (min)',
      'Trabajado (min)',
      'Balance (min)',
      'Complementario (min)',
      'Extraordinario (min)',
      'Días trabajados',
      'Incidencias',
    ].map((value) => ({ value, ...HEADER_STYLE })),
  ];

  for (const item of employees) {
    const days = mergedDays(item.timesheets);
    const totals = days.reduce(
      (value, day) => ({
        planned: value.planned + day.plannedMinutes,
        worked: value.worked + day.workedMinutes,
        excess: value.excess + day.overtimeMinutes,
        workedDays: value.workedDays + (day.workedMinutes > 0 ? 1 : 0),
        anomalies: value.anomalies + (day.anomaly ? 1 : 0),
      }),
      { planned: 0, worked: 0, excess: 0, workedDays: 0, anomalies: 0 },
    );
    data.push([
      item.employee.name,
      item.employee.employeeCode,
      item.employee.active ? 'Activo' : 'Inactivo',
      contractLabel(item.employee.employmentType),
      totals.planned,
      totals.worked,
      totals.worked - totals.planned,
      item.employee.employmentType === 'part_time' ? totals.excess : 0,
      item.employee.employmentType === 'full_time' ? totals.excess : 0,
      totals.workedDays,
      totals.anomalies,
    ]);
  }

  return {
    data,
    sheet: 'Resumen',
    columns: [
      { width: 28 },
      { width: 16 },
      { width: 12 },
      { width: 18 },
      { width: 18 },
      { width: 18 },
      { width: 16 },
      { width: 21 },
      { width: 21 },
      { width: 16 },
      { width: 14 },
    ],
    stickyRowsCount: 5,
    stickyColumnsCount: 2,
    orientation: 'landscape',
    showGridLines: false,
    zoomScale: 0.9,
    dateFormat: 'yyyy-mm-dd',
  };
}

function employeeSheet(
  employee: UserRecord,
  days: TimesheetDay[],
  timezone: string,
  from: string,
  to: string,
  sheet: string,
): InspectionWorkbookSheet {
  const data: SheetData = [
    [
      {
        value: `Registro de jornada · ${employee.name}`,
        fontSize: 16,
        fontWeight: 'bold',
        textColor: '#ef4d32',
      },
    ],
    [{ value: 'Código', ...LABEL_STYLE }, employee.employeeCode],
    [{ value: 'Periodo', ...LABEL_STYLE }, from, { value: 'Hasta', ...LABEL_STYLE }, to],
    [{ value: 'Zona horaria', ...LABEL_STYLE }, timezone],
    [{ value: 'Estado', ...LABEL_STYLE }, employee.active ? 'Activo' : 'Inactivo'],
    [
      { value: 'Contrato', ...LABEL_STYLE },
      contractLabel(employee.employmentType),
      { value: 'Minutos semanales', ...LABEL_STYLE },
      employee.contractedWeeklyMinutes,
    ],
    [],
    [
      'Fecha',
      'Día',
      'Planificado (min)',
      'Trabajado (min)',
      'Balance (min)',
      'Complementario (min)',
      'Extraordinario (min)',
      'Entradas',
      'Salidas',
      'Pausas',
      'Festivo',
      'Ausencias',
      'Incidencia',
      'Huellas de integridad',
    ].map((value) => ({ value, ...HEADER_STYLE })),
  ];

  for (const day of days) {
    const rowStyle = day.anomaly ? { backgroundColor: '#fef3c7' } : {};
    data.push([
      { value: new Date(`${day.date}T12:00:00Z`), format: 'yyyy-mm-dd', ...rowStyle },
      { value: weekday(day.date), ...rowStyle },
      { value: day.plannedMinutes, format: '0', ...rowStyle },
      { value: day.workedMinutes, format: '0', ...rowStyle },
      {
        value: day.balanceMinutes,
        format: '0',
        textColor: day.balanceMinutes < 0 ? '#b91c1c' : '#1c1917',
        ...rowStyle,
      },
      {
        value: employee.employmentType === 'part_time' ? day.overtimeMinutes : 0,
        format: '0',
        textColor:
          employee.employmentType === 'part_time' && day.overtimeMinutes > 0
            ? '#c2410c'
            : '#1c1917',
        fontWeight:
          employee.employmentType === 'part_time' && day.overtimeMinutes > 0
            ? ('bold' as const)
            : undefined,
        ...rowStyle,
      },
      {
        value: employee.employmentType === 'full_time' ? day.overtimeMinutes : 0,
        format: '0',
        textColor:
          employee.employmentType === 'full_time' && day.overtimeMinutes > 0
            ? '#c2410c'
            : '#1c1917',
        fontWeight:
          employee.employmentType === 'full_time' && day.overtimeMinutes > 0
            ? ('bold' as const)
            : undefined,
        ...rowStyle,
      },
      { value: eventTimes(day, 'clock_in', timezone), wrap: true, ...rowStyle },
      { value: eventTimes(day, 'clock_out', timezone), wrap: true, ...rowStyle },
      { value: breakTimes(day, timezone), wrap: true, ...rowStyle },
      { value: day.holiday, wrap: true, ...rowStyle },
      {
        value: day.absences
          .map((absence) => `${absence.name} (${dayPart(absence.dayPart)})`)
          .join(' · '),
        wrap: true,
        ...rowStyle,
      },
      { value: day.anomaly ? 'Revisar secuencia' : '', wrap: true, ...rowStyle },
      {
        value: day.events.map((event) => `${event.id}: ${event.integrityHash}`).join('\n'),
        wrap: true,
        fontSize: 8,
        ...rowStyle,
      },
    ]);
  }

  return {
    data,
    sheet,
    columns: [
      { width: 13 },
      { width: 12 },
      { width: 18 },
      { width: 17 },
      { width: 15 },
      { width: 21 },
      { width: 21 },
      { width: 18 },
      { width: 18 },
      { width: 28 },
      { width: 22 },
      { width: 30 },
      { width: 20 },
      { width: 58 },
    ],
    stickyRowsCount: 8,
    stickyColumnsCount: 2,
    orientation: 'landscape',
    showGridLines: false,
    zoomScale: 0.85,
    dateFormat: 'yyyy-mm-dd',
  };
}

function mergedDays(timesheets: TimesheetResponse[]): TimesheetDay[] {
  const days = new Map<string, TimesheetDay>();
  for (const timesheet of timesheets) {
    for (const day of timesheet.days) days.set(day.date, day);
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function eventTimes(day: TimesheetDay, kind: 'clock_in' | 'clock_out', timezone: string): string {
  return day.events
    .filter((event) => event.kind === kind)
    .map((event) => formatEventTime(event.occurredAt, timezone))
    .join(' · ');
}

function breakTimes(day: TimesheetDay, timezone: string): string {
  return day.events
    .filter((event) => event.kind === 'break_start' || event.kind === 'break_end')
    .map(
      (event) =>
        `${event.kind === 'break_start' ? 'Inicio' : 'Fin'} ${formatEventTime(event.occurredAt, timezone)}`,
    )
    .join(' · ');
}

function formatEventTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function weekday(value: string): string {
  const name = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function dayPart(value: 'full' | 'morning' | 'afternoon'): string {
  return { full: 'día completo', morning: 'mañana', afternoon: 'tarde' }[value];
}

function contractLabel(value: UserRecord['employmentType']): string {
  return {
    full_time: 'Tiempo completo',
    part_time: 'Tiempo parcial',
    unknown: 'Sin clasificar',
  }[value];
}

function uniqueSheetName(employee: UserRecord, used: Set<string>): string {
  const raw =
    `${employee.employeeCode || 'Empleado'} ${employee.name}`
      .replace(/[\u0000-\u001f[\]:*?/\\]/g, '-')
      .replace(/^'+|'+$/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Empleado';
  let suffix = '';
  let attempt = 1;
  while (true) {
    const candidate = `${raw.slice(0, 31 - suffix.length)}${suffix}`;
    const key = candidate.toLocaleLowerCase('es');
    if (!used.has(key)) {
      used.add(key);
      return candidate;
    }
    attempt += 1;
    suffix = ` (${attempt})`;
  }
}

function localDate(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function subtractYears(value: string, years: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const targetYear = year - years;
  const maxDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return `${targetYear}-${String(month).padStart(2, '0')}-${String(Math.min(day, maxDay)).padStart(2, '0')}`;
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
