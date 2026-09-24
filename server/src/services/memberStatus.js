// A member's standing in the club, kept deliberately separate from their
// role. Role answers "what can this person open and decide"; standing
// answers "do we expect them at the weekly meeting". An alum who still
// advises on a sector keeps their access and their pitch history — they
// just leave the weekly attendance list, and stop counting against the
// club's rate.
//
// Stored as a plain string, like Event.audience, so adding a standing is
// one line here rather than an enum migration. This list is the only
// definition: the server validates against it and ships it to the
// Attendance page, so the options a president sees are exactly the ones
// the API accepts.

export const ACTIVE = 'Active';

export const MEMBER_STATUSES = [
  { value: ACTIVE, label: 'Active' },
  { value: 'Advisory', label: 'Advisory capacity' },
  { value: 'Alumni', label: 'Alumni' },
  { value: 'OnLeave', label: 'On leave' },
  { value: 'Other', label: 'Other' },
];

export const NOTE_MAX = 200;

const BY_VALUE = new Map(MEMBER_STATUSES.map((s) => [s.value, s]));

// A missing value reads as Active: every member was on the roster until
// somebody said otherwise.
export function isActive(status) {
  return (status ?? ACTIVE) === ACTIVE;
}

export function statusLabel(status) {
  return BY_VALUE.get(status ?? ACTIVE)?.label ?? String(status);
}

// Validate a president's roster change. Returns { status, note } or
// { error }. "Other" needs a note, because a bare "Other" tells the next
// president nothing, and being readable later is the point of recording
// a standing at all. Restoring someone to Active drops the note: it
// described an absence that has ended.
export function parseStatusUpdate(body) {
  const status = typeof body?.status === 'string' ? body.status.trim() : '';
  if (!BY_VALUE.has(status)) {
    const allowed = MEMBER_STATUSES.map((s) => s.value).join(', ');
    return { error: `status must be one of: ${allowed}` };
  }
  if (status === ACTIVE) return { status, note: null };

  if (body?.note != null && typeof body.note !== 'string') {
    return { error: 'note must be text' };
  }
  const note = (body?.note ?? '').trim();
  if (note.length > NOTE_MAX) {
    return { error: `note must be ${NOTE_MAX} characters or fewer` };
  }
  if (status === 'Other' && !note) {
    return { error: 'Add a short note saying what "Other" means' };
  }
  return { status, note: note || null };
}
