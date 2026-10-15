// An approved pitch request is a pitch. The vote form, the pitches
// calendar and the "you've been assigned" popup all read Pitch, and a
// request that only flipped to Approved never appeared in any of them.
// Scheduling one by hand for a member did, which is why those showed
// up and a request the President had already said yes to did not.
//
// The clock is the lunch the requester picked, in New York. The stored
// proposedDate is a UTC midnight of the calendar day they typed (an
// <input type="date">), and reading that instant in Eastern time lands
// on the previous evening. The day has to come from the UTC calendar
// fields, the same way the .ics invite already builds the meeting.

import prisma from '../db.js';
import { easternDateKey, easternInstant } from './easternTime.js';
import { ROOM_LABELS } from '../lib/lunchSlots.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

// The calendar day the requester picked, as YYYY-MM-DD. Null when the
// request has no usable date. UTC fields on purpose — see the note above.
export function requestDayKey(proposedDate) {
  if (!proposedDate) return null;
  const day = new Date(proposedDate);
  if (Number.isNaN(day.getTime())) return null;
  return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
}

function parseHHMM(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [hh, mm] = value.split(':').map(Number);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

// The Pitch columns (plus who presents) an approved request should
// become. `now` is only the fallback clock when the request carries
// no date of its own.
export function pitchFieldsFromRequest(request, now = new Date()) {
  const ticker = String(request.ticker || '').trim().toUpperCase();
  const pitcherName = (request.requester?.name || '').trim() || 'TBD';
  const location = request.room
    ? ROOM_LABELS[request.room] || request.room
    : null;
  const slideshowUrl = request.deckRef || null;
  const industryId = request.industryId || null;
  const presenterIds = [];
  if (request.requesterId) presenterIds.push(request.requesterId);
  if (request.pmId && request.pmId !== request.requesterId) {
    presenterIds.push(request.pmId);
  }

  const key = requestDayKey(request.proposedDate);
  const time = parseHHMM(request.proposedStartTime);
  let date;
  if (key && time) {
    date = easternInstant(key, time.hh, time.mm);
  } else if (key) {
    // A day with no clock still has to land during the school day.
    // Midnight UTC is the previous evening in New York, and the pitch
    // would show up on the wrong date.
    date = easternInstant(key, 12, 0);
  } else {
    const fallback = request.presidentDecidedAt || request.createdAt || now;
    date = new Date(fallback);
  }

  return {
    pitcherName,
    ticker,
    date,
    location,
    slideshowUrl,
    industryId,
    presenterIds,
    dayKey: key,
  };
}

export function shouldMaterialize(request) {
  return request?.status === 'Approved' && !request.pitchId;
}

// An unlinked pitch of the same ticker on the same New York day is the
// meeting somebody already typed in by hand. Reuse it so the request
// and the hand-scheduled pitch are not two rows the vote form offers
// separately. The closest start time wins; id breaks a tie.
export function pickExistingPitch(target, dayKey, candidates) {
  if (!dayKey || !target) return null;
  const targetMs = new Date(target).getTime();
  const sameDay = (candidates || []).filter(
    (c) => c && !c.linked && c.date && easternDateKey(c.date) === dayKey
  );
  sameDay.sort((a, b) => {
    const da = Math.abs(new Date(a.date).getTime() - targetMs);
    const db = Math.abs(new Date(b.date).getTime() - targetMs);
    return da - db || a.id - b.id;
  });
  return sameDay[0] || null;
}

// Write the Pitch for one approved request and point the request at
// it. `markSeen` is for the boot backfill: those meetings were already
// approved, and a popup announcing each of them on the next login
// would read as a new assignment. A decision happening now leaves
// seenAt null so the requester gets the same popup a hand-scheduled
// pitch gives its presenter.
export async function ensurePitchForApprovedRequest(
  db,
  request,
  { markSeen = false } = {}
) {
  if (!shouldMaterialize(request)) return request?.pitchId || null;
  const fields = pitchFieldsFromRequest(request);

  const candidates = fields.dayKey
    ? await db.pitch.findMany({
        where: { ticker: fields.ticker },
        select: {
          id: true,
          date: true,
          sourceRequest: { select: { id: true } },
        },
      })
    : [];
  const match = pickExistingPitch(
    fields.date,
    fields.dayKey,
    candidates.map((c) => ({
      id: c.id,
      date: c.date,
      linked: !!c.sourceRequest,
    }))
  );

  let pitchId = match?.id || null;
  if (!pitchId) {
    const created = await db.pitch.create({
      data: {
        pitcherName: fields.pitcherName,
        ticker: fields.ticker,
        date: fields.date,
        location: fields.location,
        slideshowUrl: fields.slideshowUrl,
        industryId: fields.industryId,
        presenters: fields.presenterIds.length
          ? {
              create: fields.presenterIds.map((userId) => ({
                userId,
                ...(markSeen ? { seenAt: new Date() } : {}),
              })),
            }
          : undefined,
      },
    });
    pitchId = created.id;
  } else if (!markSeen && fields.presenterIds.length) {
    // Linked onto a pitch that was already on the calendar. The
    // requester still needs the assignment popup if they were not
    // already a presenter; skipDuplicates leaves an existing row,
    // including one already dismissed, alone.
    await db.pitchPresenter.createMany({
      data: fields.presenterIds.map((userId) => ({
        pitchId,
        userId,
      })),
      skipDuplicates: true,
    });
  }

  await db.pitchRequest.update({
    where: { id: request.id },
    data: { pitchId },
  });
  return pitchId;
}

// Requests approved before this link existed. Idempotent: a request
// that already points at a pitch is not in the query. A meeting that
// is still ahead announces itself, the same way scheduling a pitch
// for a member does. One that already happened is marked seen, so a
// lunch from last month does not pop up as a new assignment.
export async function ensureApprovedRequestPitches(db = prisma, now = new Date()) {
  const rows = await db.pitchRequest.findMany({
    where: { status: 'Approved', pitchId: null },
    include: { requester: { select: { id: true, name: true } } },
  });
  for (const row of rows) {
    const fields = pitchFieldsFromRequest(row, now);
    const alreadyMet = fields.date.getTime() < now.getTime();
    await ensurePitchForApprovedRequest(db, row, { markSeen: alreadyMet });
  }
  return { ensured: rows.length };
}
