// Who is told about a new pitch request, and how its deck travels with
// the email. Kept out of the route so these rules are tested rather
// than trusted: both of them failed silently, and a missing email
// reads exactly like a quiet week.

// Gmail refuses a message over 25 MB, and an attachment travels as
// base64, a third larger than the file. Deck uploads are allowed up to
// 25 MB, so a big deck made the whole message bounce: the President and
// the PM got nothing at all, while the requester's own copy, which
// carries no attachment, arrived and said the request had gone through.
// Past this size the email links to the request instead.
export const MAX_DECK_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export function deckFitsInEmail(bytes) {
  return Number.isFinite(bytes) && bytes <= MAX_DECK_ATTACHMENT_BYTES;
}

// Every President hears about a request. The club runs co-presidents,
// and only the account created first used to be emailed, so the other
// never learned that one was waiting. Then the requester, unless they
// are a President and already have that copy; then the pod PM, unless
// already on the list. A PM requesting for their own pod gets the
// requester's copy, not one telling them about themselves.
export function newRequestRecipients({ presidents = [], requester = null, pm = null }) {
  const out = [];
  const seen = new Set();
  const add = (person, role) => {
    if (!person?.email || seen.has(person.id)) return;
    seen.add(person.id);
    out.push({ id: person.id, name: person.name, email: person.email, role });
  };
  for (const p of presidents) add(p, 'President');
  add(requester, 'Requester');
  add(pm, 'PM');
  return out;
}

// How the deck appears in the email: attached when it fit, otherwise
// linked. A pasted link is used as it is. An upload that could not be
// attached points at the request on the site, where its deck opens;
// that case used to leave the deck out of the email altogether.
export function deckForEmail({ deckRef, attachment, inboxUrl }) {
  if (attachment) return { deckUrl: null, deckFileName: attachment.filename };
  if (deckRef && !deckRef.startsWith('onedrive:')) {
    return { deckUrl: deckRef, deckFileName: null };
  }
  return { deckUrl: inboxUrl, deckFileName: 'Open it on the Griffin Fund' };
}
