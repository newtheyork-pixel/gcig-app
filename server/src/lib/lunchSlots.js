// Lunch-block schedule + helpers for the Request-a-Pitch feature.
// Identical copy lives at client/src/lib/lunchSlots.js — keep them in
// sync (small enough that a shared module isn't worth the build setup).
//
// Schedule:
//   Mon/Tue/Thu/Fri  First  12:00–13:00  (selectable start 12:00–12:45)
//                    Second 13:00–14:00  (selectable start 13:00–13:45)
//   Wed              First  11:50–12:50  (selectable start 11:50–12:35)
//                    Second 12:50–13:50  (selectable start 12:50–13:35)
//                    Club   13:50–14:15  (start at 13:50 — the block is
//                           25 min, so a later start doesn't leave room)
//
// Members can't pick a start time more than 45 minutes into a lunch
// block — anything later doesn't leave room for a meaningful meeting.
// Club block is Wednesday only. Leaving the period blank offers lunch
// slots plus that Wednesday club start.

const SLOT_INCREMENT_MIN = 5;
const MAX_OFFSET_MIN = 45;

// { weekday: { First: 'HH:MM', Second: 'HH:MM' } } — block start times.
const BLOCK_STARTS = {
  mon: { First: '12:00', Second: '13:00' },
  tue: { First: '12:00', Second: '13:00' },
  wed: { First: '11:50', Second: '12:50' },
  thu: { First: '12:00', Second: '13:00' },
  fri: { First: '12:00', Second: '13:00' },
};

// Wednesday club block starts when second lunch ends. One start time:
// the block is 25 minutes.
const CLUB_START = { wed: '13:50' };

export const PERIOD_VALUES = ['First', 'Second', 'Both', 'Club'];

export const ROOM_VALUES = ['LIBRARY', 'LOWER_COMMONS', 'ATHLETIC_COMMONS'];
export const ROOM_LABELS = {
  LIBRARY: 'Library (near smart board / printers)',
  LOWER_COMMONS: 'Lower Commons',
  ATHLETIC_COMMONS: 'Athletic Commons',
};

// Returns the weekday key (mon..fri) for a "YYYY-MM-DD" or ISO date
// string. Uses UTC accessors so a "2026-04-29" string from a
// <input type="date"> always resolves to Wednesday regardless of the
// caller's local timezone (the input parses as UTC midnight; in ET
// that's 8 PM the day before, which would otherwise flip the weekday).
// Null on invalid input or a weekend.
export function weekdayKeyFor(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay();
  const key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day];
  return key in BLOCK_STARTS ? key : null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function slotsFrom(startStr) {
  const startMin = toMinutes(startStr);
  const slots = [];
  for (let m = 0; m <= MAX_OFFSET_MIN; m += SLOT_INCREMENT_MIN) {
    slots.push(fromMinutes(startMin + m));
  }
  return slots;
}

// lunch:
//   'First' | 'Second' — that lunch block
//   'Both'             — either lunch
//   'Club'             — Wednesday club block (empty on other days)
//   '' / null          — lunches, plus club block when that day has one
export function generateLunchSlots(weekday, lunch) {
  if (!weekday || !BLOCK_STARTS[weekday]) return [];
  if (lunch === 'Club') {
    const start = CLUB_START[weekday];
    return start ? [start] : [];
  }
  if (lunch === 'Both' || !lunch) {
    const set = new Set([
      ...generateLunchSlots(weekday, 'First'),
      ...generateLunchSlots(weekday, 'Second'),
    ]);
    if (!lunch) {
      for (const slot of generateLunchSlots(weekday, 'Club')) set.add(slot);
    }
    return [...set].sort();
  }
  const startStr = BLOCK_STARTS[weekday][lunch];
  if (!startStr) return [];
  return slotsFrom(startStr);
}

export function periodLabel(v) {
  if (v === 'Both') return 'either lunch';
  if (v === 'First') return 'first lunch';
  if (v === 'Second') return 'second lunch';
  if (v === 'Club') return 'club block';
  return null;
}

export function isValidSlot(weekday, lunch, hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return false;
  return generateLunchSlots(weekday, lunch).includes(hhmm);
}

// Pretty-print a 24h "HH:MM" string as "12:15 PM". Returns the input
// unchanged if it doesn't match the expected format.
export function formatStartTime(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return hhmm || '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function isValidRoom(room) {
  return ROOM_VALUES.includes(room);
}
