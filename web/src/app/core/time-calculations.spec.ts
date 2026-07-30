import { WorkEventRecord } from './models';
import {
  calculateWorkedMs,
  deriveStatus,
  eventLabel,
  formatDuration,
} from './time-calculations';

function event(
  kind: WorkEventRecord['kind'],
  occurredAt: string,
): WorkEventRecord {
  return { id: `${kind}-${occurredAt}`, kind, occurredAt } as WorkEventRecord;
}

describe('time calculations', () => {
  it('derives each valid work status from the latest event', () => {
    expect(deriveStatus([])).toBe('off');
    expect(deriveStatus([event('clock_in', '2026-07-29T08:00:00Z')])).toBe(
      'working',
    );
    expect(
      deriveStatus([
        event('clock_in', '2026-07-29T08:00:00Z'),
        event('break_start', '2026-07-29T10:00:00Z'),
      ]),
    ).toBe('paused');
    expect(
      deriveStatus([
        event('clock_in', '2026-07-29T08:00:00Z'),
        event('clock_out', '2026-07-29T16:00:00Z'),
      ]),
    ).toBe('off');
  });

  it('subtracts pauses from effective worked time', () => {
    const result = calculateWorkedMs(
      [
        event('clock_in', '2026-07-29T08:00:00Z'),
        event('break_start', '2026-07-29T10:00:00Z'),
        event('break_end', '2026-07-29T10:30:00Z'),
        event('clock_out', '2026-07-29T16:30:00Z'),
      ],
      new Date('2026-07-29T18:00:00Z'),
    );
    expect(result).toBe(8 * 60 * 60 * 1_000);
  });

  it('counts a paid pause as worked time', () => {
    const paidBreakStart = {
      ...event('break_start', '2026-07-29T10:00:00Z'),
      breakPaid: true,
    } as WorkEventRecord;
    const paidBreakEnd = {
      ...event('break_end', '2026-07-29T10:30:00Z'),
      breakPaid: true,
    } as WorkEventRecord;
    const result = calculateWorkedMs(
      [
        event('clock_in', '2026-07-29T08:00:00Z'),
        paidBreakStart,
        paidBreakEnd,
        event('clock_out', '2026-07-29T16:00:00Z'),
      ],
      new Date('2026-07-29T18:00:00Z'),
    );
    expect(result).toBe(8 * 60 * 60 * 1_000);
  });

  it('keeps counting an open work interval up to now', () => {
    const result = calculateWorkedMs(
      [event('clock_in', '2026-07-29T08:00:00Z')],
      new Date('2026-07-29T09:45:00Z'),
    );
    expect(formatDuration(result)).toBe('01:45');
  });

  it('ignores correction audit markers in status calculations', () => {
    expect(
      deriveStatus([
        event('clock_in', '2026-07-29T08:00:00Z'),
        event('correction', '2026-07-29T09:00:00Z'),
      ]),
    ).toBe('working');
    expect(eventLabel('correction')).toBe('Corrección');
  });

  it('applies an approved correction without counting the original twice', () => {
    const original = event('clock_out', '2026-07-29T16:00:00Z');
    const correction = {
      ...event('correction', '2026-07-29T17:00:00Z'),
      corrects: original.id,
      correctedKind: 'clock_out',
      created: '2026-07-30T09:00:00Z',
    } as WorkEventRecord;
    const result = calculateWorkedMs(
      [
        event('clock_in', '2026-07-29T08:00:00Z'),
        original,
        correction,
      ],
      new Date('2026-07-30T10:00:00Z'),
    );
    expect(formatDuration(result)).toBe('09:00');
  });
});
