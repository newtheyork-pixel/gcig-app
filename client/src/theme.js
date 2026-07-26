// The brand palette, for the places Tailwind classes cannot reach.
//
// Charts, inline SVG and canvas need literal colour values, so the navy
// and the gold were written out by hand wherever those appear — 57 times
// across the pages. That is fine until the brand moves, at which point
// it is 57 edits and the two or three that get missed are the ones on a
// chart nobody opened that week.
//
// These MUST stay in step with tailwind.config.js. The Tailwind classes
// remain the right tool for anything that takes a className; this is
// only for props like `stroke`, `fill` and `backgroundColor` that take a
// value.

export const NAVY = {
  50: '#E8EBF2',
  100: '#C6CDDD',
  200: '#8C99BB',
  400: '#3A4D78',
  500: '#253B66',
  DEFAULT: '#1B2A4A',
  600: '#1B2A4A',
  700: '#142038',
  800: '#0D1626',
};

export const GOLD = {
  100: '#F4E9C6',
  200: '#E8D391',
  300: '#E3CA7A',
  400: '#D6B863',
  DEFAULT: '#C9A84C',
  500: '#C9A84C',
  600: '#A8893B',
  700: '#9B7F2E',
  800: '#6F5A20',
};

// Gain and loss are deliberately NOT the brand gold and navy. A chart
// that renders a loss in the house colour reads as decoration; these
// have to be unambiguous at a glance and legible to the roughly one in
// twelve men who cannot separate red from green, hence the blue rather
// than a second green.
export const POSITIVE = '#15803D';
export const NEGATIVE = '#B91C1C';
export const NEUTRAL = '#64748B';

// Ordered series colours for multi-line charts, gold first because the
// first series is usually the fund.
export const SERIES = [
  GOLD.DEFAULT,
  NAVY.DEFAULT,
  NAVY[200],
  GOLD[600],
  NAVY[400],
  GOLD[300],
];
