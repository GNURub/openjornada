import { WorkEventRecord, WorkStatus } from './models';

export function applyCorrections(
  events: readonly WorkEventRecord[],
): WorkEventRecord[] {
  const corrections = [...events]
    .filter(
      (event) =>
        event.kind === 'correction' &&
        Boolean(event.corrects) &&
        Boolean(event.correctedKind),
    )
    .sort(
      (left, right) =>
        new Date(left.created || left.occurredAt).getTime() -
        new Date(right.created || right.occurredAt).getTime(),
    );
  const latestByTarget = new Map<string, WorkEventRecord>();
  for (const correction of corrections) {
    latestByTarget.set(correction.corrects, correction);
  }

  return events
    .filter((event) => event.kind !== 'correction')
    .map((event) => {
      const correction = latestByTarget.get(event.id);
      if (!correction) return event;
      return {
        ...event,
        kind: correction.correctedKind || event.kind,
        occurredAt: correction.occurredAt,
        note: correction.note,
      };
    });
}

export function deriveStatus(events: readonly WorkEventRecord[]): WorkStatus {
  const latest = applyCorrections(events)
    .sort(
      (left, right) =>
        new Date(right.occurredAt).getTime() -
        new Date(left.occurredAt).getTime(),
    )[0];
  if (!latest || latest.kind === 'clock_out') {
    return 'off';
  }
  return latest.kind === 'break_start' ? 'paused' : 'working';
}

export function calculateWorkedMs(
  events: readonly WorkEventRecord[],
  now = new Date(),
): number {
  const ordered = applyCorrections(events)
    .sort(
      (left, right) =>
        new Date(left.occurredAt).getTime() -
        new Date(right.occurredAt).getTime(),
    );

  let total = 0;
  let activeSince: number | null = null;

  for (const event of ordered) {
    const at = new Date(event.occurredAt).getTime();
    if (
      event.kind === 'clock_in' ||
      (event.kind === 'break_end' && !event.breakPaid)
    ) {
      activeSince ??= at;
    }
    if (
      ((event.kind === 'break_start' && !event.breakPaid) ||
        event.kind === 'clock_out') &&
      activeSince !== null
    ) {
      total += Math.max(0, at - activeSince);
      activeSince = null;
    }
  }

  if (activeSince !== null) {
    total += Math.max(0, now.getTime() - activeSince);
  }
  return total;
}

export function calculateDailyProgress(
  workedMilliseconds: number,
  plannedMinutes: number,
): number {
  if (plannedMinutes <= 0) return 0;
  const workedMinutes = workedMilliseconds / 60_000;
  return Math.min(100, Math.max(0, (workedMinutes / plannedMinutes) * 100));
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function formatDurationWithSeconds(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return [
    String(hours).padStart(2, '0'),
    String(minutes % 60).padStart(2, '0'),
    String(seconds % 60).padStart(2, '0'),
  ].join(':');
}

export function eventLabel(kind: WorkEventRecord['kind']): string {
  return (
    {
      clock_in: 'Entrada',
      break_start: 'Inicio de pausa',
      break_end: 'Fin de pausa',
      clock_out: 'Salida',
      correction: 'Corrección',
    } as const
  )[kind];
}
