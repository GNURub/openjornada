import {
  availableLeaveDays,
  countBusinessDays,
  countRequestedDays,
} from './leave-calculations';

describe('leave calculations', () => {
  it('counts weekdays in an inclusive interval', () => {
    expect(countBusinessDays('2026-07-27', '2026-07-31')).toBe(5);
  });

  it('excludes weekends', () => {
    expect(countBusinessDays('2026-07-31', '2026-08-03')).toBe(2);
  });

  it('returns zero for invalid or reversed intervals', () => {
    expect(countBusinessDays('2026-08-03', '2026-07-31')).toBe(0);
    expect(countBusinessDays('', '')).toBe(0);
  });

  it('excludes configured public holidays', () => {
    expect(
      countBusinessDays('2026-12-21', '2026-12-25', ['2026-12-25']),
    ).toBe(4);
  });

  it('supports half-day requests', () => {
    expect(countRequestedDays('2026-07-29', '2026-07-29', 'morning')).toBe(
      0.5,
    );
  });

  it('calculates the available balance with carry-over and adjustments', () => {
    expect(availableLeaveDays(22, 3, -1, 8.5)).toBe(15.5);
    expect(availableLeaveDays(2, 0, 0, 5)).toBe(0);
  });
});
