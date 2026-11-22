// A pitch request's proposedDate is the calendar day the member typed
// into a date input, which the server stores as UTC midnight. Read as
// an instant in New York that is the evening before, so formatting it
// directly put every request a day early on the Pitch Requests page: a
// Wednesday club block read as Tuesday, for the requester and for the
// President approving it. Take the day from the UTC fields and hand
// back local midnight of it, which every formatter then reads as the
// day that was picked.
export function requestDay(proposedDate) {
  if (!proposedDate) return null;
  const d = new Date(proposedDate);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
