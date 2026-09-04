/**
 * May this draft be sent by hand, right now?
 *
 * The batch send answers this in its query: it selects only drafts with
 * scheduledFor and queuedAt both null, so a queued letter never appears in
 * it. The single Send button had no such rule, and the only thing standing
 * between a scheduled draft and going out twice was the scheduler's own
 * sentAt filter.
 *
 * That filter is not enough on its own. The scheduler reads up to forty due
 * drafts in one tick and then works through them at 1200ms apiece, so for
 * the better part of a minute it is sending from a list it has already
 * read. A hand-send inside that window lands the same letter in the same
 * inbox twice, over the club's name, and an email cannot be recalled.
 *
 * Refusing rather than silently unscheduling is deliberate. Someone who
 * wants it gone now can unschedule it in one click, and that click is a
 * decision somebody made rather than a side effect of pressing Send.
 */
export function sendBlockReason(draft) {
  if (!draft) return 'No such draft';
  if (draft.sentAt) return 'Already sent.';
  if (draft.rejectedAt) return 'That draft was rejected. Edit it and it re-screens.';
  if (!draft.screenedAt) return 'Nothing has screened this draft yet. Edit it to trigger a screen.';
  if (draft.screenRisk === 'prohibited') return 'The compliance screen will not pass this.';
  if (draft.scheduledFor) {
    const when = draft.scheduledFor instanceof Date
      ? draft.scheduledFor.toISOString()
      : String(draft.scheduledFor);
    return `That draft is scheduled for ${when}. Unschedule it before sending by hand.`;
  }
  if (draft.queuedAt) return 'That draft is already queued to send. Take it out of the queue first.';
  return null;
}
