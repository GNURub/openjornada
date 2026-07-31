import { WorkScheduleRecord } from './models';

export type WorkScheduleStatus =
  | 'active'
  | 'upcoming'
  | 'finished'
  | 'archived';

export function workScheduleStatus(
  schedule: Pick<WorkScheduleRecord, 'active' | 'validFrom' | 'validUntil'>,
  now = Date.now(),
): WorkScheduleStatus {
  if (!schedule.active) return 'archived';
  if (new Date(schedule.validFrom).getTime() > now) return 'upcoming';
  if (schedule.validUntil && new Date(schedule.validUntil).getTime() < now) {
    return 'finished';
  }
  return 'active';
}
