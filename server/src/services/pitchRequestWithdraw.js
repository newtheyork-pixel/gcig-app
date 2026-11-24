// Taking back an approval. Approve had no undo: one press put a pitch
// on the club calendar, in the vote form and on the dashboard, mailed
// the requester and the PM a calendar invite, and the pitch could not
// be deleted because the request pointed at it. The first time that
// happened it was a test request, approved by accident, and the only
// way out was the database.
//
// Withdrawing turns the request into a decline and takes back what the
// approval made. Kept apart from the route so the three rules below are
// tested rather than trusted.

import { pitchFieldsFromRequest } from './pitchFromRequest.js';

// An approval writes its pitch in the same transaction as the decision,
// so the two timestamps sit milliseconds apart. A minute of slack
// covers the clocks; anything further away is a pitch somebody put on
// the calendar by hand and the approval adopted, or one the boot
// backfill wrote for an approval made before requests became pitches
// (when presidents scheduled those meetings by hand). Withdrawing
// unlinks those and leaves them standing: a pitch we cannot prove the
// approval made is not ours to delete.
export const APPROVAL_CLOCK_SLACK_MS = 60 * 1000;

export function pitchMadeByApproval(pitch, request) {
  if (!pitch?.createdAt || !request?.presidentDecidedAt) return false;
  const made = new Date(pitch.createdAt).getTime();
  const decided = new Date(request.presidentDecidedAt).getTime();
  if (!Number.isFinite(made) || !Number.isFinite(decided)) return false;
  return Math.abs(made - decided) <= APPROVAL_CLOCK_SLACK_MS;
}

// When the meeting is: the pitch's own clock once there is one, since
// a president may have moved it, otherwise the lunch the requester
// picked.
export function meetingTime(request, pitch = request?.pitch) {
  if (pitch?.date) return new Date(pitch.date);
  return pitchFieldsFromRequest(request).date;
}

// Why an approval cannot be withdrawn, or null when it can. A meeting
// that has started is history, the same rule the weekly schedule keeps,
// and a vote opened on the pitch makes it part of the record.
export function withdrawRefusal(request, pitch, now = new Date()) {
  if (!request || request.status !== 'Approved') {
    return 'Only an approved request can have its approval withdrawn.';
  }
  if ((pitch?.votingSessionCount || 0) > 0) {
    return 'A vote has already been opened on this pitch, so its approval stands.';
  }
  const at = meetingTime(request, pitch);
  if (!at || Number.isNaN(at.getTime()) || at.getTime() <= new Date(now).getTime()) {
    return 'This meeting has already happened, so its approval stands.';
  }
  return null;
}
