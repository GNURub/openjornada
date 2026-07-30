import {
  createPrimaryPalette,
  DEFAULT_PRIMARY_COLOR,
  normalizeBrandColor,
} from './branding.service';

describe('corporate branding helpers', () => {
  it('normalizes valid hexadecimal colors and rejects unsafe values', () => {
    expect(normalizeBrandColor(' #12ABef ', DEFAULT_PRIMARY_COLOR)).toBe('#12abef');
    expect(normalizeBrandColor('red', DEFAULT_PRIMARY_COLOR)).toBe(DEFAULT_PRIMARY_COLOR);
  });

  it('creates light and dark shades around the primary color', () => {
    const palette = createPrimaryPalette('#2468ac');
    expect(palette['500']).toBe('#2468ac');
    expect(palette['50']).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette['950']).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette['50']).not.toBe(palette['950']);
  });
});
