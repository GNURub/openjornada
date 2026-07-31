export function pocketBaseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ');
}

export function pocketBaseDateBoundary(
  dateKey: string,
  boundary: 'start' | 'end',
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '';
  return boundary === 'start'
    ? `${dateKey}T00:00:00.000Z`
    : `${dateKey}T23:59:59.999Z`;
}

export function normalizeLeaveDateKey(
  value: string,
  boundary: 'start' | 'end',
): string {
  const rawKey = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawKey)) return '';

  const time = value.slice(11, 19);
  const alreadyUtcBoundary =
    boundary === 'start' ? time === '00:00:00' : time === '23:59:59';
  if (alreadyUtcBoundary) return rawKey;

  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return rawKey;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
