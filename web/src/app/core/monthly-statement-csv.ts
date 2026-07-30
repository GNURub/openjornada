import type { MonthlyTimeStatement } from './models';

export function monthlyStatementCsvFilename(statement: MonthlyTimeStatement): string {
  return `resumen-jornada-${statement.period}-v${statement.version}.csv`;
}

export function buildMonthlyStatementCsv(statement: MonthlyTimeStatement): string {
  const rows: Array<Array<string | number>> = [
    ['Persona', statement.expand?.employee?.name ?? statement.employee],
    ['Periodo', statement.period],
    ['Versión', statement.version],
    ['Tipo de contrato', statement.employmentType],
    ['Minutos planificados', statement.contractedMinutes],
    ['Minutos ordinarios', statement.ordinaryMinutes],
    ['Minutos complementarios', statement.complementaryMinutes],
    ['Minutos extraordinarios', statement.overtimeMinutes],
    ['Minutos totales', statement.totalMinutes],
    ['Huella', statement.integrityHash],
    [],
    ['Fecha', 'Planificados', 'Trabajados', 'Ordinarios', 'Complementarios', 'Extraordinarios'],
    ...statement.dailyRecords.map((day) => [
      day.date,
      day.plannedMinutes,
      day.workedMinutes,
      day.ordinaryMinutes,
      day.complementaryMinutes,
      day.overtimeMinutes,
    ]),
  ];

  return `\uFEFF${rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\r\n')}`;
}
