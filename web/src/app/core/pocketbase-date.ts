export function pocketBaseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ');
}
