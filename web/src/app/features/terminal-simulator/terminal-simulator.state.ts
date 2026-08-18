import { TerminalWorkState } from '../../core/terminal.models';

export type SimulatorButton = 'A' | 'B' | 'C';

export function adjustedTime(current: Date, button: 'A' | 'C', held = false): Date {
  const minutes = (held ? 30 : 5) * (button === 'A' ? -1 : 1);
  return new Date(current.getTime() + minutes * 60_000);
}

export function visibleButtonLabels(
  state: TerminalWorkState,
): Partial<Record<SimulatorButton, string>> {
  if (state.kind === 'idle') return { B: 'Comenzar' };
  if (state.kind === 'on_break') return { A: 'Fin pausa', C: 'Acabar' };
  return state.longShift
    ? { A: 'Pausa', B: 'Terminar', C: 'Antes' }
    : { A: 'Pausa', C: 'Terminar' };
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
