/**
 * Restrained elevation. Cards are carried by a 1px border and at most a 1–2px
 * shadow; only elements that genuinely float above the page (a sheet, a sticky
 * bar) get a soft one. Nothing in Navy Slate is heavy, and every shadow is
 * cast from the ink rather than from grey so it sits on the slate ground
 * instead of smudging it.
 */
const INK = '#0F172A';

export const elevation = {
  none: {
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  card: {
    shadowColor: INK,
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  floating: {
    shadowColor: INK,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  overlay: {
    shadowColor: INK,
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;

export const webShadow = {
  none: 'none',
  card: '0 1px 2px rgba(15,23,42,0.04)',
  floating: '0 4px 12px rgba(15,23,42,0.08)',
  overlay: '0 8px 24px rgba(15,23,42,0.12)',
} as const;
