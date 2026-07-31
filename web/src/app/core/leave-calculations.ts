import type { LeaveRequestRecord, WorkScheduleRecord } from './models';

export type LeaveConflictStatus = 'approved' | 'pending';

export interface LeaveConflict {
  request: LeaveRequestRecord;
  status: LeaveConflictStatus;
  overlapStart: string;
  overlapEnd: string;
}

export function countBusinessDays(
  startValue: string,
  endValue: string,
  holidays: readonly string[] = [],
): number {
  const start = new Date(`${startValue.slice(0, 10)}T12:00:00`);
  const end = new Date(`${endValue.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return 0;
  }
  const holidaySet = new Set(holidays.map((date) => date.slice(0, 10)));
  let total = 0;
  for (const current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
    const weekday = current.getDay();
    const key = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, '0'),
      String(current.getDate()).padStart(2, '0'),
    ].join('-');
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(key)) total += 1;
  }
  return total;
}

export function countRequestedDays(
  startValue: string,
  endValue: string,
  dayPart: 'full' | 'morning' | 'afternoon',
  holidays: readonly string[] = [],
  schedules: readonly WorkScheduleRecord[] = [],
  employee = '',
): number {
  const days = countScheduledDays(startValue, endValue, holidays, schedules, employee);
  return days === 1 && dayPart !== 'full' ? 0.5 : days;
}

export function countScheduledDays(
  startValue: string,
  endValue: string,
  holidays: readonly string[] = [],
  schedules: readonly WorkScheduleRecord[] = [],
  employee = '',
): number {
  const start = new Date(`${startValue.slice(0, 10)}T12:00:00`);
  const end = new Date(`${endValue.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return 0;
  }

  const holidaySet = new Set(holidays.map((date) => date.slice(0, 10)));
  const applicableSchedules = schedules
    .filter((schedule) => schedule.active && (!employee || schedule.employee === employee))
    .sort((left, right) => right.validFrom.localeCompare(left.validFrom));
  let total = 0;
  for (const current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
    const key = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, '0'),
      String(current.getDate()).padStart(2, '0'),
    ].join('-');
    if (holidaySet.has(key)) continue;

    const schedule = applicableSchedules.find(
      (item) =>
        item.validFrom.slice(0, 10) <= key &&
        (!item.validUntil || item.validUntil.slice(0, 10) >= key),
    );
    const weekday = current.getDay();
    const isWorkingDay = schedule
      ? schedule.weekdays.includes(weekday)
      : weekday !== 0 && weekday !== 6;
    if (isWorkingDay) total += 1;
  }
  return total;
}

export function availableLeaveDays(
  allowance: number,
  carriedOver: number,
  adjustment: number,
  approvedDays: number,
): number {
  return Math.max(0, allowance + carriedOver + adjustment - approvedDays);
}

export function hasConfiguredLeaveDays(
  allowance: number,
  carriedOver: number,
  adjustment: number,
): boolean {
  return allowance + carriedOver + adjustment > 0;
}

export function normalizeLeaveAllowance(value: number | string): number | null {
  if (typeof value === 'string' && !value.trim()) return null;
  const allowance = typeof value === 'number' ? value : Number(value.replace(',', '.'));
  if (
    !Number.isFinite(allowance) ||
    allowance < 0 ||
    allowance > 366 ||
    !Number.isInteger(allowance * 2)
  ) {
    return null;
  }
  return allowance;
}

export function findLeaveConflicts(
  target: LeaveRequestRecord,
  requests: readonly LeaveRequestRecord[],
): LeaveConflict[] {
  const targetStart = dateKey(target.startDate);
  const targetEnd = dateKey(target.endDate);
  if (!targetStart || !targetEnd || targetStart > targetEnd) return [];

  return requests
    .filter(
      (
        request,
      ): request is LeaveRequestRecord & {
        status: LeaveConflictStatus;
      } =>
        request.id !== target.id &&
        request.employee !== target.employee &&
        (request.status === 'approved' || request.status === 'pending'),
    )
    .flatMap((request) => {
      const requestStart = dateKey(request.startDate);
      const requestEnd = dateKey(request.endDate);
      if (!requestStart || !requestEnd || requestStart > requestEnd) return [];

      const overlapStart = targetStart > requestStart ? targetStart : requestStart;
      const overlapEnd = targetEnd < requestEnd ? targetEnd : requestEnd;
      if (overlapStart > overlapEnd || !dayPartsOverlap(target, request)) {
        return [];
      }

      return [
        {
          request,
          status: request.status,
          overlapStart,
          overlapEnd,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.overlapStart.localeCompare(right.overlapStart) ||
        left.overlapEnd.localeCompare(right.overlapEnd) ||
        left.request.created.localeCompare(right.request.created),
    );
}

function dateKey(value: string): string {
  return value.slice(0, 10);
}

function dayPartsOverlap(left: LeaveRequestRecord, right: LeaveRequestRecord): boolean {
  const leftPart = dateKey(left.startDate) === dateKey(left.endDate) ? left.dayPart : 'full';
  const rightPart = dateKey(right.startDate) === dateKey(right.endDate) ? right.dayPart : 'full';
  return leftPart === 'full' || rightPart === 'full' || leftPart === rightPart;
}
