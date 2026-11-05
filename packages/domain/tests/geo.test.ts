import { describe, expect, it } from 'vitest';
import { straightLineMeters } from '../src/geo';

describe('straightLineMeters', () => {
  it('returns zero for the same point', () => {
    expect(straightLineMeters({ lat: 28.4512, lng: 77.0211 }, { lat: 28.4512, lng: 77.0211 })).toBe(0);
  });

  it('measures one degree of longitude at the equator as R·π/180', () => {
    // 6 371 000 m × π/180 = 111 194.93 m, which is the definition the helper
    // is built from — if this drifts, every fallback fare is wrong.
    expect(straightLineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBe(111_195);
  });

  it('is symmetric', () => {
    const a = { lat: 28.6315, lng: 77.2167 };
    const b = { lat: 28.4512, lng: 77.0211 };
    expect(straightLineMeters(a, b)).toBe(straightLineMeters(b, a));
  });

  it('shortens Connaught Place to Sector 29 to under 28 km', () => {
    const metres = straightLineMeters({ lat: 28.6315, lng: 77.2167 }, { lat: 28.4512, lng: 77.0211 });
    // Road distance on this corridor is 30–45 km, so a straight line is a floor:
    // pricing off it is only honest while the UI says "as-the-crow-flies".
    expect(metres).toBeGreaterThan(26_000);
    expect(metres).toBeLessThan(28_000);
  });
});
