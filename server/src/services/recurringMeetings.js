import prisma from '../db.js';
import { easternDateKey, easternInstant, addDaysToKey, weekdayOfKey } from './easternTime.js';

// Weekly club meetings, generated from the schedule presidents keep on
// the Attendance page (EventSeries). Each occurrence is a real Event row
// with `recurring: true`, so it is on the calendar and markable for
// attendance like any other meeting.
//
// The schedule shapes the future only. A meeting that has started is
// history, whatever the schedule now says: it is never moved, never
// removed, and its day never gets a second meeting. That rule is paid
// for. The first version of this file deleted every recurring row
// outside a window reaching three months back, on every server start,
// and the cascade on Attendance took the marks with them; a deploy
// erased another week of the record each time, until #123.
//
// A week the club does not meet is CANCELLED (Event.cancelledAt), not
// removed from the schedule, so the calendar can say so and a restore
// puts the meeting back as it was.

// How far ahead occurrences exist, so the calendar and the attendance
// grid can show what is coming.
const DAYS_FORWARD = 366;

/** The occurrences of a series between two date keys, inclusive. */
export function seriesOccurrences(series, fromKey, untilKey) {
  const first = series.startsOn > fromKey ? series.startsOn : fromKey;
  const last = series.endsOn && series.endsOn < untilKey ? series.endsOn : untilKey;
  const out = [];
  let key = addDaysToKey(first, (series.dayOfWeek - weekdayOfKey(first) + 7) % 7);
  for (; key <= last; key = addDaysToKey(key, 7)) {
    out.push({ key, date: easternInstant(key, series.startHour, series.startMinute) });
  }
  return out;
}

function occurrenceFields(series, date) {
  return {
    title: series.title,
    date,
    location: series.location ?? null,
    description: series.description ?? null,
    durationMinutes: series.durationMinutes,
  };
}

function differs(row, fields) {
  return (
    new Date(row.date).getTime() !== fields.date.getTime() ||
    row.title !== fields.title ||
    (row.location ?? null) !== fields.location ||
    (row.description ?? null) !== fields.description ||
    row.durationMinutes !== fields.durationMinutes
  );
}

/**
 * The writes that bring a series' occurrences, from today on, into line
 * with the series. `existing` holds its rows from the start of today in
 * New York. Pure, so the rules above are tested rather than trusted.
 *
 * A future row keeps its id when only its time, title or place changes,
 * so attendance marked ahead of time and a cancellation both survive an
 * edit. Rows that have already started are never in any list returned.
 *
 * `records` on a row counts what people have attached to it: marks,
 * roster changes, a video room. Where one day holds two rows, the one
 * carrying the most records is the meeting, then the older. A second
 * row is removed only while it is upcoming and bare; one that carries a
 * record stays for a person to cancel, since deleting it takes the
 * record too.
 */
export function planSeries(series, existing, now = new Date()) {
  const todayKey = easternDateKey(now);
  const wanted = seriesOccurrences(series, todayKey, addDaysToKey(todayKey, DAYS_FORWARD));
  const isFuture = (row) => new Date(row.date) > now;
  const records = (row) => row.records ?? 0;

  const byKey = new Map();
  const remove = [];
  const ranked = [...existing].sort((a, b) => records(b) - records(a) || a.id - b.id);
  for (const row of ranked) {
    const key = easternDateKey(row.date);
    if (!byKey.has(key)) byKey.set(key, row);
    else if (isFuture(row) && !records(row)) remove.push(row.id); // a second occurrence on one day
  }

  const create = [];
  const update = [];
  const kept = new Set();
  for (const o of wanted) {
    const row = byKey.get(o.key);
    const fields = occurrenceFields(series, o.date);
    if (row) {
      kept.add(o.key);
      if (isFuture(row) && differs(row, fields)) update.push({ id: row.id, data: fields });
    } else if (o.date > now) {
      create.push({ ...fields, seriesId: series.id, recurring: true, audience: 'all' });
    }
  }
  for (const [key, row] of byKey) {
    if (!kept.has(key) && isFuture(row)) remove.push(row.id);
  }
  return { create, update, remove };
}

/**
 * Brings every series (or one) into line. Runs at server start and after
 * any change to the schedule. Removing a future occurrence cascades to
 * attendance marked ahead for it, which is right: that meeting is gone.
 */
export async function ensureRecurringMeetings({ seriesId } = {}) {
  const now = new Date();
  const startOfToday = easternInstant(easternDateKey(now), 0, 0);
  const list = await prisma.eventSeries.findMany(seriesId ? { where: { id: seriesId } } : {});
  const totals = { created: 0, updated: 0, removed: 0 };

  for (const series of list) {
    const rows = await prisma.event.findMany({
      where: { seriesId: series.id, date: { gte: startOfToday } },
      select: {
        id: true,
        date: true,
        title: true,
        location: true,
        description: true,
        durationMinutes: true,
        _count: { select: { attendance: true, rosterOverrides: true, meetings: true } },
      },
    });
    const existing = rows.map(({ _count, ...row }) => ({
      ...row,
      records: _count.attendance + _count.rosterOverrides + _count.meetings,
    }));
    const plan = planSeries(series, existing, now);
    const ops = [];
    if (plan.remove.length) ops.push(prisma.event.deleteMany({ where: { id: { in: plan.remove } } }));
    for (const u of plan.update) ops.push(prisma.event.update({ where: { id: u.id }, data: u.data }));
    if (plan.create.length) ops.push(prisma.event.createMany({ data: plan.create }));
    if (ops.length) await prisma.$transaction(ops);
    totals.created += plan.create.length;
    totals.updated += plan.update.length;
    totals.removed += plan.remove.length;
  }

  if (totals.created || totals.updated || totals.removed) {
    console.log(
      `Weekly meetings: ${totals.created} added, ${totals.updated} updated, ` +
        `${totals.removed} removed (upcoming only).`
    );
  }
  return totals;
}
