import { describe, expect, it } from 'vitest';
import {
  actionConfirmation,
  adjustedTime,
  hourInTimezone,
  offlineClockTrusted,
  pinDigit,
  refreshedLocalState,
  visibleButtonLabels,
} from './terminal-simulator.state';

describe('M5Stack simulator controls', () => {
  it('moves the time in five-minute steps and accelerates on hold', () => {
    const time = new Date('2026-08-18T15:55:00Z');
    expect(adjustedTime(time, 'A').toISOString()).toBe('2026-08-18T15:50:00.000Z');
    expect(adjustedTime(time, 'C', true).toISOString()).toBe('2026-08-18T16:25:00.000Z');
  });

  it('wraps PIN digits', () => {
    expect(pinDigit(0, 'A')).toBe(9);
    expect(pinDigit(9, 'C')).toBe(0);
  });

  it('shows the approved three actions after four hours', () => {
    expect(
      visibleButtonLabels({
        kind: 'working',
        since: '',
        workedSeconds: 14_400,
        breakSeconds: 0,
        longShift: true,
        staleBreak: false,
        actions: [],
      }),
    ).toEqual({
      A: 'Comenzar pausa',
      B: 'Terminar ahora',
      C: 'Ya terminé antes',
    });
  });

  it('personalizes clock-in and clock-out confirmations', () => {
    expect(actionConfirmation('clock_in', 'Marina', 8)).toBe(
      'Buenos días, Marina · Jornada iniciada',
    );
    expect(actionConfirmation('clock_in', 'Marina', 16)).toBe(
      'Buenas tardes, Marina · Jornada iniciada',
    );
    expect(actionConfirmation('clock_in', 'Marina', 23)).toBe(
      'Buenas noches, Marina · Jornada iniciada',
    );
    expect(actionConfirmation('clock_out', 'Marina', 23)).toBe(
      'Hasta luego, Marina · Jornada finalizada',
    );
  });

  it('uses the terminal timezone for greeting boundaries', () => {
    const instant = new Date('2026-08-27T12:00:00.000Z');
    expect(hourInTimezone(instant, 'Europe/Madrid')).toBe(14);
    expect(hourInTimezone(instant, 'Atlantic/Canary')).toBe(13);
  });

  it('expires offline clock trust at 24 hours and after reboot', () => {
    const synced = new Date('2026-08-18T10:00:00Z');
    expect(offlineClockTrusted(synced, new Date('2026-08-19T10:00:00Z'), false)).toBe(true);
    expect(offlineClockTrusted(synced, new Date('2026-08-19T10:00:01Z'), false)).toBe(false);
    expect(offlineClockTrusted(synced, new Date('2026-08-18T10:01:00Z'), true)).toBe(false);
  });

  it('refreshes four-hour and stale-break warnings against the simulated clock', () => {
    const working = refreshedLocalState(
      {
        kind: 'working',
        since: '2026-08-18T10:00:00.000Z',
        workedSeconds: 0,
        breakSeconds: 0,
        longShift: false,
        staleBreak: false,
        actions: [],
      },
      new Date('2026-08-18T14:00:00.000Z'),
    );
    expect(working.longShift).toBe(true);
    expect(working.workedSeconds).toBe(14_400);

    const paused = refreshedLocalState(
      { ...working, kind: 'on_break', since: '2026-08-18T14:00:00.000Z', longShift: false },
      new Date('2026-08-18T14:25:01.000Z'),
    );
    expect(paused.staleBreak).toBe(true);
    expect(paused.breakSeconds).toBe(1_501);
  });
});
