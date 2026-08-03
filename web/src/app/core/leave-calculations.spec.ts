import {
  availableLeaveDays,
  countBusinessDays,
  countRequestedDays,
  countScheduledDays,
  findLeaveConflicts,
  hasConfiguredLeaveDays,
  normalizeLeaveAllowance,
} from './leave-calculations';
import type { LeaveRequestRecord, WorkScheduleRecord } from './models';

function leaveRequest(overrides: Partial<LeaveRequestRecord> = {}): LeaveRequestRecord {
  return {
    id: 'target',
    created: '2026-07-01T10:00:00.000Z',
    updated: '2026-07-01T10:00:00.000Z',
    organization: 'organization',
    employee: 'employee-a',
    type: 'vacation',
    startDate: '2026-08-10T00:00:00.000Z',
    endDate: '2026-08-12T23:59:59.999Z',
    dayPart: 'full',
    reason: '',
    status: 'pending',
    reviewedBy: '',
    reviewedAt: '',
    response: '',
    leaveType: 'vacation-type',
    requestedDays: 3,
    assignedBy: '',
    attachment: '',
    collectionId: 'leave_requests',
    collectionName: 'leave_requests',
    expand: {},
    ...overrides,
  };
}

function schedule(overrides: Partial<WorkScheduleRecord> = {}): WorkScheduleRecord {
  return {
    id: 'schedule',
    created: '2026-07-01T10:00:00.000Z',
    updated: '2026-07-01T10:00:00.000Z',
    organization: 'organization',
    employee: 'employee-a',
    name: 'Martes a sábado',
    validFrom: '2026-01-01',
    validUntil: '2026-12-31',
    weekdays: [2, 3, 4, 5, 6],
    startTime: '09:00',
    endTime: '13:00',
    breakMinutes: 0,
    active: true,
    createdBy: 'admin',
    collectionId: 'work_schedules',
    collectionName: 'work_schedules',
    ...overrides,
  };
}

describe('leave calculations', () => {
  it('counts weekdays in an inclusive interval', () => {
    expect(countBusinessDays('2026-07-27', '2026-07-31')).toBe(5);
  });

  it('excludes weekends', () => {
    expect(countBusinessDays('2026-07-31', '2026-08-03')).toBe(2);
  });

  it('returns zero for invalid or reversed intervals', () => {
    expect(countBusinessDays('2026-08-03', '2026-07-31')).toBe(0);
    expect(countBusinessDays('', '')).toBe(0);
  });

  it('excludes configured public holidays', () => {
    expect(countBusinessDays('2026-12-21', '2026-12-25', ['2026-12-25'])).toBe(4);
  });

  it('supports half-day requests', () => {
    expect(countRequestedDays('2026-07-29', '2026-07-29', 'morning')).toBe(0.5);
  });

  it('uses the employee schedule for Saturday work and a free Monday', () => {
    const workSchedule = schedule();
    expect(countScheduledDays('2026-08-15', '2026-08-17', [], [workSchedule], 'employee-a')).toBe(
      1,
    );
    expect(
      countRequestedDays('2026-08-15', '2026-08-15', 'full', [], [workSchedule], 'employee-a'),
    ).toBe(1);
  });

  it('uses the most recent schedule that covers each requested date', () => {
    const oldSchedule = schedule({ id: 'old', weekdays: [1, 2, 3, 4, 5] });
    const newSchedule = schedule({
      id: 'new',
      validFrom: '2026-08-01',
      weekdays: [2, 3, 4, 5, 6],
    });
    expect(
      countScheduledDays('2026-08-15', '2026-08-17', [], [oldSchedule, newSchedule], 'employee-a'),
    ).toBe(1);
  });

  it('uses reference weekdays for weekly flexible employees without fixed schedules', () => {
    expect(
      countScheduledDays(
        '2026-08-15',
        '2026-08-17',
        [],
        [],
        'employee-a',
        'weekly_flexible',
        [1, 6],
      ),
    ).toBe(2);
  });

  it('calculates the available balance with carry-over and adjustments', () => {
    expect(availableLeaveDays(22, 3, -1, 8.5)).toBe(15.5);
    expect(availableLeaveDays(2, 0, 0, 5)).toBe(0);
  });

  it('accepts annual allowances in whole or half days', () => {
    expect(normalizeLeaveAllowance(22)).toBe(22);
    expect(normalizeLeaveAllowance('22.5')).toBe(22.5);
    expect(normalizeLeaveAllowance('22,5')).toBe(22.5);
    expect(normalizeLeaveAllowance('')).toBeNull();
    expect(normalizeLeaveAllowance(-0.5)).toBeNull();
    expect(normalizeLeaveAllowance(22.25)).toBeNull();
    expect(normalizeLeaveAllowance(366.5)).toBeNull();
  });

  it('only exposes balances with configured leave days', () => {
    expect(hasConfiguredLeaveDays(0, 0, 0)).toBe(false);
    expect(hasConfiguredLeaveDays(2, 0, 0)).toBe(true);
    expect(hasConfiguredLeaveDays(0, 1, 0)).toBe(true);
    expect(hasConfiguredLeaveDays(0, 0, 0.5)).toBe(true);
    expect(hasConfiguredLeaveDays(1, 0, -1)).toBe(false);
  });

  it('classifies approved and pending conflicts from other employees', () => {
    const target = leaveRequest();
    const approved = leaveRequest({
      id: 'approved',
      employee: 'employee-b',
      type: 'medical',
      status: 'approved',
      startDate: '2026-08-12T00:00:00.000Z',
      endDate: '2026-08-14T23:59:59.999Z',
    });
    const pending = leaveRequest({
      id: 'pending',
      employee: 'employee-c',
      status: 'pending',
      startDate: '2026-08-09T00:00:00.000Z',
      endDate: '2026-08-10T23:59:59.999Z',
    });

    expect(findLeaveConflicts(target, [target, approved, pending])).toEqual([
      {
        request: pending,
        status: 'pending',
        overlapStart: '2026-08-10',
        overlapEnd: '2026-08-10',
      },
      {
        request: approved,
        status: 'approved',
        overlapStart: '2026-08-12',
        overlapEnd: '2026-08-12',
      },
    ]);
  });

  it('ignores the same employee and resolved requests without active absence', () => {
    const target = leaveRequest();
    const sameEmployee = leaveRequest({ id: 'same-employee' });
    const rejected = leaveRequest({
      id: 'rejected',
      employee: 'employee-b',
      status: 'rejected',
    });
    const cancelled = leaveRequest({
      id: 'cancelled',
      employee: 'employee-c',
      status: 'cancelled',
    });

    expect(findLeaveConflicts(target, [sameEmployee, rejected, cancelled])).toEqual([]);
  });

  it('counts overlapping calendar dates even on weekends', () => {
    const target = leaveRequest({
      startDate: '2026-08-15T00:00:00.000Z',
      endDate: '2026-08-15T23:59:59.999Z',
    });
    const weekendConflict = leaveRequest({
      id: 'weekend',
      employee: 'employee-b',
      status: 'approved',
      startDate: '2026-08-15T00:00:00.000Z',
      endDate: '2026-08-16T23:59:59.999Z',
    });

    expect(findLeaveConflicts(target, [weekendConflict])).toHaveLength(1);
  });

  it('does not flag adjacent ranges without a shared date', () => {
    const target = leaveRequest();
    const nextDay = leaveRequest({
      id: 'next-day',
      employee: 'employee-b',
      status: 'approved',
      startDate: '2026-08-13T00:00:00.000Z',
      endDate: '2026-08-13T23:59:59.999Z',
    });

    expect(findLeaveConflicts(target, [nextDay])).toEqual([]);
  });

  it('respects half-day periods for single-day requests', () => {
    const target = leaveRequest({
      startDate: '2026-08-10T00:00:00.000Z',
      endDate: '2026-08-10T23:59:59.999Z',
      dayPart: 'morning',
    });
    const afternoon = leaveRequest({
      id: 'afternoon',
      employee: 'employee-b',
      dayPart: 'afternoon',
      startDate: target.startDate,
      endDate: target.endDate,
    });
    const morning = leaveRequest({
      id: 'morning',
      employee: 'employee-c',
      dayPart: 'morning',
      startDate: target.startDate,
      endDate: target.endDate,
    });
    const full = leaveRequest({
      id: 'full',
      employee: 'employee-d',
      dayPart: 'full',
      startDate: target.startDate,
      endDate: target.endDate,
    });

    expect(
      findLeaveConflicts(target, [afternoon, morning, full]).map((conflict) => conflict.request.id),
    ).toEqual(['morning', 'full']);
  });

  it('treats multi-day requests as full days when comparing periods', () => {
    const target = leaveRequest({ dayPart: 'morning' });
    const lastAfternoon = leaveRequest({
      id: 'last-afternoon',
      employee: 'employee-b',
      dayPart: 'afternoon',
      startDate: '2026-08-12T00:00:00.000Z',
      endDate: '2026-08-12T23:59:59.999Z',
    });

    expect(findLeaveConflicts(target, [lastAfternoon])).toHaveLength(1);
  });
});
