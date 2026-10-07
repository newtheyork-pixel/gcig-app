// Wall-clock time in New York, where the club meets, independent of the
// timezone the server runs in. Nothing here sets TZ, and on a UTC host a
// meeting built with setHours(13, 50) lands at 13:50 UTC: 9:50 AM in New
// York for half the year and 8:50 AM for the rest.
//
// Calendar days travel as YYYY-MM-DD strings ("keys"), which compare and
// sort correctly as plain strings and carry no timezone to misread.

const ZONE = 'America/New_York';
const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(date) {
  const p = {};
  for (const { type, value } of FMT.formatToParts(date)) p[type] = value;
  return p;
}

const KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value) {
  if (typeof value !== 'string' || !KEY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The New York calendar day an instant falls on. */
export function easternDateKey(date) {
  const p = parts(new Date(date));
  return `${p.year}-${p.month}-${p.day}`;
}

/** The instant New York's clock reads `hour:minute` on day `key`. */
export function easternInstant(key, hour, minute) {
  const [y, m, d] = key.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour, minute);
  // Start from the same digits read as UTC and correct by the zone's
  // offset at that moment. A second pass settles the days the offset
  // changes (DST), when the first guess lands on the other side of it.
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const p = parts(new Date(guess));
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += target - wall;
  }
  return new Date(guess);
}

export function addDaysToKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday, as Date#getDay. */
export function weekdayOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
