export function countBusinessDays(
  startValue: string,
  endValue: string,
  holidays: readonly string[] = [],
): number {
  const start = new Date(`${startValue.slice(0, 10)}T12:00:00`);
  const end = new Date(`${endValue.slice(0, 10)}T12:00:00`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end
  ) {
    return 0;
  }
  const holidaySet = new Set(holidays.map((date) => date.slice(0, 10)));
  let total = 0;
  for (
    const current = new Date(start);
    current <= end;
    current.setDate(current.getDate() + 1)
  ) {
    const weekday = current.getDay();
    const key = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, '0'),
      String(current.getDate()).padStart(2, '0'),
    ].join('-');
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(key)) total += 1;
  }
  return total;
}

export function countRequestedDays(
  startValue: string,
  endValue: string,
  dayPart: 'full' | 'morning' | 'afternoon',
  holidays: readonly string[] = [],
): number {
  const days = countBusinessDays(startValue, endValue, holidays);
  return days === 1 && dayPart !== 'full' ? 0.5 : days;
}

export function availableLeaveDays(
  allowance: number,
  carriedOver: number,
  adjustment: number,
  approvedDays: number,
): number {
  return Math.max(0, allowance + carriedOver + adjustment - approvedDays);
}
