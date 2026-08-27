import { TerminalCommand, TerminalWorkState } from '../../core/terminal.models';

export type SimulatorButton = 'A' | 'B' | 'C';

export function adjustedTime(
  current: Date,
  button: 'A' | 'C',
  held = false,
  minimum?: Date,
  maximum?: Date,
): Date {
  const minutes = (held ? 30 : 5) * (button === 'A' ? -1 : 1);
  const requested = current.getTime() + minutes * 60_000;
  const lower = minimum?.getTime() ?? Number.NEGATIVE_INFINITY;
  const upper = maximum?.getTime() ?? Number.POSITIVE_INFINITY;
  return new Date(Math.min(upper, Math.max(lower, requested)));
}

export function visibleButtonLabels(
  state: TerminalWorkState,
): Partial<Record<SimulatorButton, string>> {
  if (state.kind === 'idle') return { B: 'Comenzar jornada' };
  if (state.kind === 'on_break') return { A: 'Terminar pausa', C: 'Acabar jornada' };
  return state.longShift
    ? { A: 'Comenzar pausa', B: 'Terminar ahora', C: 'Ya terminé antes' }
    : { A: 'Comenzar pausa', C: 'Terminar jornada' };
}

export function timeGreeting(hour: number): string {
  if (hour >= 6 && hour < 14) return 'Buenos días';
  if (hour >= 14 && hour < 21) return 'Buenas tardes';
  return 'Buenas noches';
}

export function hourInTimezone(value: Date, timezone: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hourCycle: 'h23',
        timeZone: timezone,
      }).format(value),
    );
  } catch {
    return value.getHours();
  }
}

export function actionConfirmation(
  command: TerminalCommand,
  employee: string,
  localHour: number,
): string {
  if (command === 'clock_in') return `${timeGreeting(localHour)}, ${employee} · Jornada iniciada`;
  if (command === 'clock_out') return `Hasta luego, ${employee} · Jornada finalizada`;
  return command === 'break_start' ? 'Pausa iniciada' : 'Pausa terminada';
}

export function pinDigit(value: number, button: 'A' | 'C'): number {
  return (value + (button === 'A' ? 9 : 1)) % 10;
}

export function offlineClockTrusted(lastNtpAt: Date | null, now: Date, rebooted: boolean): boolean {
  return !!lastNtpAt && !rebooted && now.getTime() - lastNtpAt.getTime() <= 24 * 60 * 60_000;
}

export function refreshedLocalState(state: TerminalWorkState, now: Date): TerminalWorkState {
  if (!state.since || state.kind === 'idle') return { ...state };
  const elapsed = Math.max(
    0,
    Math.floor((now.getTime() - new Date(state.since).getTime()) / 1_000),
  );
  const workedSeconds = state.workedSeconds + (state.kind === 'working' ? elapsed : 0);
  const breakSeconds = state.breakSeconds + (state.kind === 'on_break' ? elapsed : 0);
  return {
    ...state,
    since: now.toISOString(),
    workedSeconds,
    breakSeconds,
    longShift: state.kind === 'working' && workedSeconds >= 4 * 60 * 60,
    staleBreak: state.kind === 'on_break' && elapsed > 25 * 60,
  };
}
