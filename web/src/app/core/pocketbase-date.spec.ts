import { pocketBaseDateTime } from './pocketbase-date';

describe('PocketBase date formatting', () => {
  it('uses the canonical space separator required by date filters', () => {
    expect(pocketBaseDateTime(new Date('2026-07-30T22:00:00.000Z'))).toBe(
      '2026-07-30 22:00:00.000Z',
    );
  });
});
