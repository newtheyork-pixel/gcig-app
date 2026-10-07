import { isDateKey } from './easternTime.js';
import { mentionsSegLabel } from './segLabel.js';

// What a president may send to create or change a weekly meeting, read
// strictly: a schedule that half-parsed would quietly put a meeting on
// the wrong day for a year. Times are wall-clock in New York.

export const LIMITS = { title: 120, location: 200, description: 500 };
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function text(value, max, label, { required = false } = {}) {
  if (value === undefined) return { skip: true };
  const s = value === null ? '' : String(value).trim();
  if (!s) return required ? { error: `${label} is required.` } : { value: null };
  if (s.length > max) return { error: `Keep the ${label.toLowerCase()} under ${max} characters.` };
  if (mentionsSegLabel(s)) return { error: 'That name cannot be shown on the site.' };
  return { value: s };
}

/**
 * Returns `{ data }` for prisma or `{ error }`. With `partial`, absent
 * fields are left alone (an edit); without it, the fields a new series
 * needs are required. `today` is the YYYY-MM-DD a new series defaults to.
 */
export function parseSeriesInput(body = {}, { partial = false, today } = {}) {
  const data = {};

  const title = text(body.title, LIMITS.title, 'Title', { required: !partial });
  if (title.error) return title;
  if (!title.skip) {
    if (title.value === null) return { error: 'Title is required.' };
    data.title = title.value;
  }

  if (body.dayOfWeek !== undefined || !partial) {
    const day = Number(body.dayOfWeek);
    if (!Number.isInteger(day) || day < 0 || day > 6) return { error: 'Pick a day of the week.' };
    data.dayOfWeek = day;
  }

  if (body.time !== undefined || !partial) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.time ?? ''));
    const hour = m ? Number(m[1]) : NaN;
    const minute = m ? Number(m[2]) : NaN;
    if (!m || hour > 23 || minute > 59) return { error: 'Give the start time as HH:MM.' };
    data.startHour = hour;
    data.startMinute = minute;
  }

  if (body.durationMinutes !== undefined || !partial) {
    const d = Number(body.durationMinutes ?? 30);
    if (!Number.isInteger(d) || d < 5 || d > 480) {
      return { error: 'A meeting runs between 5 minutes and 8 hours.' };
    }
    data.durationMinutes = d;
  }

  for (const [key, max, label] of [
    ['location', LIMITS.location, 'Location'],
    ['description', LIMITS.description, 'Description'],
  ]) {
    const t = text(body[key], max, label);
    if (t.error) return t;
    if (!t.skip) data[key] = t.value;
  }

  if (!partial) {
    const startsOn = body.startsOn ?? today;
    if (!isDateKey(startsOn)) return { error: 'Pick the date of the first meeting.' };
    data.startsOn = startsOn;
  }

  if (body.endsOn !== undefined) {
    if (body.endsOn === null || body.endsOn === '') data.endsOn = null;
    else if (!isDateKey(body.endsOn)) return { error: 'Pick the date of the last meeting.' };
    else data.endsOn = body.endsOn;
  }
  if (data.endsOn && data.startsOn && data.endsOn < data.startsOn) {
    return { error: 'The last meeting cannot come before the first.' };
  }

  return { data };
}

/** "Wednesdays, 1:50–2:20 PM" for logs and the audit trail. */
export function describeSeries(s) {
  const fmt = (mins) => {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const start = s.startHour * 60 + s.startMinute;
  return `${DAY_NAMES[s.dayOfWeek]}s, ${fmt(start)}–${fmt(start + s.durationMinutes)}`;
}
