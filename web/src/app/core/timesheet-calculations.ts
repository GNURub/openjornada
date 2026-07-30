import type { ManualTimeInterval } from './models';

export function formatMinutes(minutes: number, signed = false): string {
  const sign = minutes < 0 ? '−' : signed && minutes > 0 ? '+' : '';
  const absolute = Math.abs(Math.round(minutes));
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return `${sign}${hours}h ${String(remainder).padStart(2, '0')}m`;
}

export function monthRange(value: string): { from: string; to: string } {
  const [year, month] = value.slice(0, 7).split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${String(month).padStart(2, '0')}-01`,
    to: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  };
}

export function shiftDate(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function shiftMonth(value: string, amount: number): string {
  const date = new Date(`${value.slice(0, 7)}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
}

function timeMinutes(value: string): number {
  if (!/^\d{2}:\d{2}$/.test(value)) return -1;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours > 23 || minutes > 59) return -1;
  return hours * 60 + minutes;
}

export function manualTimeDraftError(
  intervals: ManualTimeInterval[],
  replacement: boolean,
): string {
  if (intervals.length === 0) {
    return replacement ? '' : 'Añade al menos un tramo de trabajo.';
  }
  if (intervals.length > 24) return 'La jornada no puede contener más de veinticuatro tramos.';

  const normalized = intervals
    .map((interval, index) => {
      const start = timeMinutes(interval.start);
      const end = timeMinutes(interval.end);
      if (start < 0 || end < 0) {
        return { interval, index, start: -1, end: -1, absoluteStart: -1, absoluteEnd: -1 };
      }
      const nextDayOffset = interval.startNextDay ? 1440 : 0;
      const overnightOffset = end < start ? 1440 : 0;
      return {
        interval,
        index,
        start,
        end,
        absoluteStart: start + nextDayOffset,
        absoluteEnd: end + nextDayOffset + overnightOffset,
      };
    })
    .sort((left, right) => left.absoluteStart - right.absoluteStart);

  for (const item of normalized) {
    if (item.start < 0 || item.end < 0) {
      return `Completa correctamente las horas del tramo ${item.index + 1}.`;
    }
    if (item.start === item.end) {
      return `El tramo ${item.index + 1} debe tener horas de inicio y fin distintas.`;
    }
    if (item.interval.startNextDay && item.end < item.start) {
      return `El tramo ${item.index + 1} no puede terminar dos días después.`;
    }
    if (item.absoluteEnd - item.absoluteStart > 16 * 60) {
      return `El tramo ${item.index + 1} no puede superar dieciséis horas.`;
    }
  }

  if (
    normalized[0].interval.kind !== 'work' ||
    normalized[normalized.length - 1].interval.kind !== 'work'
  ) {
    return 'La jornada debe comenzar y terminar con un tramo de trabajo.';
  }

  let workedMinutes = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index];
    const previous = normalized[index - 1];
    const next = normalized[index + 1];
    if (previous && item.absoluteStart < previous.absoluteEnd) {
      return 'Los tramos de la jornada no pueden solaparse.';
    }
    if (item.interval.kind === 'work') {
      workedMinutes += item.absoluteEnd - item.absoluteStart;
      continue;
    }
    if (
      !item.interval.breakType ||
      previous?.interval.kind !== 'work' ||
      next?.interval.kind !== 'work' ||
      previous.absoluteEnd !== item.absoluteStart ||
      item.absoluteEnd !== next.absoluteStart
    ) {
      return 'Cada pausa debe estar unida a los tramos de trabajo anterior y posterior.';
    }
  }
  return workedMinutes > 24 * 60
    ? 'La jornada no puede contener más de veinticuatro horas de trabajo.'
    : '';
}
