import { describe, expect, it } from 'vitest';
import { workScheduleStatus } from './schedule-status';

const now = new Date('2026-07-31T12:00:00.000Z').getTime();

describe('workScheduleStatus', () => {
  it('marks a disabled schedule as archived regardless of its dates', () => {
    expect(
      workScheduleStatus(
        { active: false, validFrom: '2026-08-01', validUntil: '' },
        now,
      ),
    ).toBe('archived');
  });

  it('marks a future enabled schedule as upcoming', () => {
    expect(
      workScheduleStatus(
        { active: true, validFrom: '2026-08-01', validUntil: '' },
        now,
      ),
    ).toBe('upcoming');
  });

  it('marks an enabled schedule whose validity ended as finished', () => {
    expect(
      workScheduleStatus(
        {
          active: true,
          validFrom: '2026-07-01',
          validUntil: '2026-07-30T23:59:59.999Z',
        },
        now,
      ),
    ).toBe('finished');
  });

  it('marks a currently applicable enabled schedule as active', () => {
    expect(
      workScheduleStatus(
        {
          active: true,
          validFrom: '2026-07-01',
          validUntil: '2026-08-31T23:59:59.999Z',
        },
        now,
      ),
    ).toBe('active');
  });
});
