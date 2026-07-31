import {
  normalizeLeaveDateKey,
  pocketBaseDateBoundary,
  pocketBaseDateTime,
} from './pocketbase-date';

describe('PocketBase date formatting', () => {
  it('uses the canonical space separator required by date filters', () => {
    expect(pocketBaseDateTime(new Date('2026-07-30T22:00:00.000Z'))).toBe(
      '2026-07-30 22:00:00.000Z',
    );
  });

  it('serializes leave dates as UTC calendar boundaries without shifting the day', () => {
    expect(pocketBaseDateBoundary('2026-07-27', 'start')).toBe(
      '2026-07-27T00:00:00.000Z',
    );
    expect(pocketBaseDateBoundary('2026-07-27', 'end')).toBe(
      '2026-07-27T23:59:59.999Z',
    );
  });

  it('repairs leave dates previously serialized from Europe/Madrid local time', () => {
    expect(normalizeLeaveDateKey('2026-07-26 22:00:00.000Z', 'start')).toBe('2026-07-27');
    expect(normalizeLeaveDateKey('2026-07-27 21:59:59.000Z', 'end')).toBe('2026-07-27');
    expect(normalizeLeaveDateKey('2026-12-14 23:00:00.000Z', 'start')).toBe('2026-12-15');
    expect(normalizeLeaveDateKey('2026-12-15 22:59:59.000Z', 'end')).toBe('2026-12-15');
  });

  it('keeps records already stored at canonical UTC boundaries unchanged', () => {
    expect(normalizeLeaveDateKey('2026-07-27 00:00:00.000Z', 'start')).toBe('2026-07-27');
    expect(normalizeLeaveDateKey('2026-07-27 23:59:59.999Z', 'end')).toBe('2026-07-27');
  });
});
