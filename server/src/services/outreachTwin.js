/**
 * Is this unsent draft the letter that just left from Gmail?
 *
 * The sweep records our own side of every thread it reads, and when it
 * finds a letter of ours that the terminal never sent it looks for the
 * draft that must have been pasted into Gmail: the newest unsent draft to
 * the same person with the same subject. Marking it stops the terminal
 * offering to send the letter twice. Shane McMurray, 20 Aug 2026, was the
 * case that earned it.
 *
 * What it must never do is claim a chase that has not gone yet. A chase is
 * staged as "Re: <the first letter's subject>", and the sweep re-reads the
 * first letter on every tick, so subject-matching alone would mark every
 * follow-up in the campaign sent the moment it was written, dated to the
 * letter it was following up, and the scheduler would then skip all of
 * them. The letter we are looking at has to be NEW to the ledger: one the
 * terminal sent was written to the ledger in the same transaction that
 * sent it, and one the sweep has already recorded has already had its
 * chance to claim. Both checks are cheap, and the second one alone would
 * have been enough; the first is there so the reasoning survives a
 * refactor of the ledger.
 */
const norm = (v) => String(v || '').replace(/^\s*re:\s*/i, '').trim().toLowerCase();

export function shouldClaimTwin({ freshlyRecorded, message, readingDraft, twin }) {
  if (!freshlyRecorded) return false;
  if (!twin || !message) return false;
  if (readingDraft?.gmailMessageId && message.gmailMessageId === readingDraft.gmailMessageId) return false;
  if (readingDraft?.id && twin.id === readingDraft.id) return false;
  return norm(twin.subject) === norm(message.subject);
}

export { norm as normSubject };
