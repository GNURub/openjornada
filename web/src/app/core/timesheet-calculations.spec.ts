import {
  formatMinutes,
  manualTimeDraftError,
  monthRange,
  shiftDate,
  shiftMonth,
} from './timesheet-calculations';

describe('timesheet calculations', () => {
  it('formats positive and negative minute balances', () => {
    expect(formatMinutes(450)).toBe('7h 30m');
    expect(formatMinutes(75, true)).toBe('+1h 15m');
    expect(formatMinutes(-30, true)).toBe('−0h 30m');
  });

  it('returns complete month ranges including leap years', () => {
    expect(monthRange('2028-02')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('moves dates and months without local timezone drift', () => {
    expect(shiftDate('2026-07-30', -1)).toBe('2026-07-29');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('allows a replacement to remove every existing interval', () => {
    expect(manualTimeDraftError([], true)).toBe('');
    expect(manualTimeDraftError([], false)).toBe('Añade al menos un tramo de trabajo.');
  });

  it('rejects zero-duration and overlapping intervals before submission', () => {
    expect(
      manualTimeDraftError(
        [
          {
            kind: 'work',
            start: '11:51',
            end: '11:51',
            startNextDay: false,
            breakType: '',
          },
        ],
        true,
      ),
    ).toContain('inicio y fin distintas');

    expect(
      manualTimeDraftError(
        [
          {
            kind: 'work',
            start: '08:00',
            end: '12:00',
            startNextDay: false,
            breakType: '',
          },
          {
            kind: 'work',
            start: '11:00',
            end: '13:00',
            startNextDay: false,
            breakType: '',
          },
        ],
        true,
      ),
    ).toBe('Los tramos de la jornada no pueden solaparse.');
  });

  it('validates a linked work-break-work correction', () => {
    expect(
      manualTimeDraftError(
        [
          {
            kind: 'work',
            start: '08:30',
            end: '11:00',
            startNextDay: false,
            breakType: '',
          },
          {
            kind: 'break',
            start: '11:00',
            end: '11:30',
            startNextDay: false,
            breakType: 'lunch',
          },
          {
            kind: 'work',
            start: '11:30',
            end: '16:00',
            startNextDay: false,
            breakType: '',
          },
        ],
        true,
      ),
    ).toBe('');
  });
});
