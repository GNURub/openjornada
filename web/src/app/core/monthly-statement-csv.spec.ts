import { describe, expect, it } from 'vitest';
import type { MonthlyTimeStatement } from './models';
import { buildMonthlyStatementCsv, monthlyStatementCsvFilename } from './monthly-statement-csv';

function statement(): MonthlyTimeStatement {
  return {
    id: 'statement-id',
    collectionId: 'monthly_time_statements',
    collectionName: 'monthly_time_statements',
    created: '2026-07-01 00:00:00.000Z',
    updated: '2026-07-01 00:00:00.000Z',
    organization: 'organization-id',
    employee: 'employee-id',
    period: '2026-06',
    version: 2,
    employmentType: 'part_time',
    contractedMinutes: 1200,
    ordinaryMinutes: 1140,
    complementaryMinutes: 300,
    overtimeMinutes: 0,
    totalMinutes: 1440,
    dailyRecords: [
      {
        date: '2026-06-02',
        plannedMinutes: 240,
        workedMinutes: 300,
        ordinaryMinutes: 240,
        complementaryMinutes: 60,
        overtimeMinutes: 0,
        events: [],
      },
    ],
    generatedBy: 'admin-id',
    generatedAt: '2026-07-01 00:00:00.000Z',
    deliveredAt: '2026-07-01 00:00:00.000Z',
    previousStatement: '',
    previousHash: '',
    integrityHash: 'sha256-value',
    expand: {
      employee: {
        id: 'employee-id',
        collectionId: 'users',
        collectionName: 'users',
        created: '2026-01-01 00:00:00.000Z',
        updated: '2026-01-01 00:00:00.000Z',
        organization: 'organization-id',
        name: 'Persona "CSV", prueba',
        email: 'persona@example.com',
        employeeCode: 'CSV-1',
        role: 'employee',
        active: true,
        weeklyHours: 20,
        employmentType: 'part_time',
        contractedWeeklyMinutes: 1200,
        complementaryHoursAgreement: true,
        scheduleMode: 'scheduled',
        flexibleWeekdays: [1, 2, 3, 4, 5],
        jobTitle: '',
        privacyNoticeAcknowledgedVersion: '',
        privacyNoticeAcknowledgedAt: '',
        invitationStatus: 'accepted',
        invitationSentAt: '',
        invitationExpiresAt: '',
        invitationAcceptedAt: '',
      },
    },
  };
}

describe('monthly statement CSV', () => {
  it('exports every summary total, daily classification and integrity hash', () => {
    const csv = buildMonthlyStatementCsv(statement());

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.split('\r\n')).toEqual([
      '\uFEFF"Persona","Persona ""CSV"", prueba"',
      '"Periodo","2026-06"',
      '"Versión","2"',
      '"Tipo de contrato","part_time"',
      '"Minutos planificados","1200"',
      '"Minutos ordinarios","1140"',
      '"Minutos complementarios","300"',
      '"Minutos extraordinarios","0"',
      '"Minutos totales","1440"',
      '"Huella","sha256-value"',
      '',
      '"Fecha","Planificados","Trabajados","Ordinarios","Complementarios","Extraordinarios"',
      '"2026-06-02","240","300","240","60","0"',
    ]);
  });

  it('uses a deterministic filename and falls back to the employee id', () => {
    const value = statement();
    delete value.expand;

    expect(monthlyStatementCsvFilename(value)).toBe('resumen-jornada-2026-06-v2.csv');
    expect(buildMonthlyStatementCsv(value)).toContain('\uFEFF"Persona","employee-id"');
  });
});
