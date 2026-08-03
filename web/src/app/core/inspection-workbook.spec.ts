import readExcelFile from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import writeExcelFile from 'write-excel-file/node';
import type { TimesheetResponse, UserRecord } from './models';
import {
  buildInspectionWorkbook,
  defaultInspectionRange,
  inspectionRangeError,
  inspectionWorkbookFilename,
  splitInspectionRange,
} from './inspection-workbook';

function employee(id: string): UserRecord {
  const partTime = id === 'employee-2';
  return {
    id,
    collectionId: 'users',
    collectionName: 'users',
    created: '2022-01-01 00:00:00.000Z',
    updated: '2026-01-01 00:00:00.000Z',
    email: `${id}@example.com`,
    name: 'Ana/Prueba',
    organization: 'organization-id',
    role: 'employee',
    active: id === 'employee-1',
    employeeCode: 'EMP:01',
    weeklyHours: partTime ? 20 : 40,
    employmentType: partTime ? 'part_time' : 'full_time',
    contractedWeeklyMinutes: partTime ? 1200 : 2400,
    complementaryHoursAgreement: partTime,
    scheduleMode: 'scheduled',
    flexibleWeekdays: [1, 2, 3, 4, 5],
    jobTitle: 'Técnica',
    privacyNoticeAcknowledgedVersion: '',
    privacyNoticeAcknowledgedAt: '',
    invitationStatus: 'accepted',
    invitationSentAt: '',
    invitationExpiresAt: '',
    invitationAcceptedAt: '',
  };
}

function timesheet(id: string): TimesheetResponse {
  return {
    employee: {
      id,
      name: 'Ana/Prueba',
      employeeCode: 'EMP:01',
      employmentType: id === 'employee-2' ? 'part_time' : 'full_time',
      scheduleMode: 'scheduled',
      contractedWeeklyMinutes: id === 'employee-2' ? 1200 : 2400,
      flexibleWeekdays: [1, 2, 3, 4, 5],
    },
    timezone: 'Europe/Madrid',
    from: '2026-06-01',
    to: '2026-06-02',
    approvalRequired: false,
    correctionApprovalRequired: true,
    totals: {
      workedMinutes: 540,
      plannedMinutes: 960,
      balanceMinutes: -420,
      overtimeMinutes: 60,
    },
    days: [
      {
        date: '2026-06-01',
        plannedMinutes: 480,
        workedMinutes: 540,
        balanceMinutes: 60,
        overtimeMinutes: 60,
        holiday: '',
        absences: [],
        events: [
          {
            id: 'event-in',
            kind: 'clock_in',
            occurredAt: '2026-06-01T07:00:00.000Z',
            source: 'manual',
            note: '',
            manualRequest: 'request-id',
            breakType: '',
            breakPaid: false,
            integrityHash: 'a'.repeat(64),
          },
          {
            id: 'event-out',
            kind: 'clock_out',
            occurredAt: '2026-06-01T16:00:00.000Z',
            source: 'manual',
            note: '',
            manualRequest: 'request-id',
            breakType: '',
            breakPaid: false,
            integrityHash: 'b'.repeat(64),
          },
        ],
        editableIntervals: [],
        requests: [],
        anomaly: false,
        canAddManualTime: false,
        canCorrectTime: true,
      },
      {
        date: '2026-06-02',
        plannedMinutes: 480,
        workedMinutes: 0,
        balanceMinutes: -480,
        overtimeMinutes: 0,
        holiday: '',
        absences: [{ name: 'Vacaciones', dayPart: 'full' }],
        events: [],
        editableIntervals: [],
        requests: [],
        anomaly: true,
        canAddManualTime: false,
        canCorrectTime: false,
      },
    ],
  };
}

describe('inspection workbook', () => {
  it('defaults to four years and validates the editable interval', () => {
    expect(defaultInspectionRange(new Date('2026-07-30T12:00:00Z'))).toEqual({
      from: '2022-07-30',
      to: '2026-07-30',
    });
    expect(inspectionRangeError('2022-07-30', '2026-07-30', '2026-07-30')).toBe('');
    expect(inspectionRangeError('2022-07-29', '2026-07-30', '2026-07-30')).toContain(
      'máximo cuatro años',
    );
    expect(inspectionRangeError('2026-07-31', '2026-07-30', '2026-07-30')).toContain('posterior');
    expect(inspectionRangeError('2026-07-30', '2026-07-31', '2026-07-30')).toContain('futuro');
  });

  it('splits four years into API-compatible contiguous ranges', () => {
    const ranges = splitInspectionRange('2022-07-30', '2026-07-30');

    expect(ranges).toHaveLength(4);
    expect(ranges[0]).toEqual({ from: '2022-07-30', to: '2023-07-30' });
    expect(ranges[3].to).toBe('2026-07-30');
    for (let index = 1; index < ranges.length; index += 1) {
      const previousEnd = new Date(`${ranges[index - 1].to}T12:00:00Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
      expect(ranges[index].from).toBe(previousEnd.toISOString().slice(0, 10));
    }
  });

  it('creates a summary and one valid, unique sheet per employee', () => {
    const workbook = buildInspectionWorkbook(
      [
        { employee: employee('employee-1'), timesheets: [timesheet('employee-1')] },
        { employee: employee('employee-2'), timesheets: [timesheet('employee-2')] },
      ],
      '2026-06-01',
      '2026-06-02',
      new Date('2026-07-01T10:00:00Z'),
    );

    expect(workbook.map((sheet) => sheet.sheet)).toEqual([
      'Resumen',
      'EMP-01 Ana-Prueba',
      'EMP-01 Ana-Prueba (2)',
    ]);
    expect(workbook.every((sheet) => sheet.sheet.length <= 31)).toBe(true);
    expect(workbook[0].data[5]).toEqual([
      'Ana/Prueba',
      'EMP:01',
      'Activo',
      'Tiempo completo',
      960,
      540,
      -420,
      0,
      60,
      1,
      1,
    ]);
    expect(workbook[0].data[6].slice(6, 9)).toEqual([-420, 60, 0]);
    expect(workbook[1].data[8][7]).toMatchObject({ value: '09:00:00' });
    expect(workbook[1].data[8][8]).toMatchObject({ value: '18:00:00' });
    expect(workbook[1].data[8][13]).toMatchObject({
      value: `event-in: ${'a'.repeat(64)}\nevent-out: ${'b'.repeat(64)}`,
    });
    expect(workbook[1].data[9][11]).toMatchObject({
      value: 'Vacaciones (día completo)',
    });
    expect(workbook[1].data[9][12]).toMatchObject({ value: 'Revisar secuencia' });
    expect(inspectionWorkbookFilename('2022-07-30', '2026-07-30')).toBe(
      'inspeccion-jornada-2022-07-30-2026-07-30.xlsx',
    );
  });

  it('writes an XLSX that can be reopened with every employee sheet', async () => {
    const workbook = buildInspectionWorkbook(
      [
        { employee: employee('employee-1'), timesheets: [timesheet('employee-1')] },
        { employee: employee('employee-2'), timesheets: [timesheet('employee-2')] },
      ],
      '2026-06-01',
      '2026-06-02',
      new Date('2026-07-01T10:00:00Z'),
    );
    const buffer = await writeExcelFile(workbook, {
      fontFamily: 'Arial',
      fontSize: 10,
    }).toBuffer();
    const reopened = await readExcelFile(buffer);

    expect(reopened.map((sheet) => sheet.sheet)).toEqual([
      'Resumen',
      'EMP-01 Ana-Prueba',
      'EMP-01 Ana-Prueba (2)',
    ]);
    expect(reopened[0].data[4]).toEqual([
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
    ]);
    expect(reopened[1].data[7][0]).toBe('Fecha');
    expect(reopened[1].data[8].slice(1, 7)).toEqual(['Lunes', 480, 540, 60, 0, 60]);
    expect(reopened[2].data[8].slice(4, 7)).toEqual([60, 60, 0]);
  });
});
