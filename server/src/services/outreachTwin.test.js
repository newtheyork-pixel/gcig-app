import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldClaimTwin } from './outreachTwin.js';

const first = { id: 86, gmailMessageId: 'g-first', subject: 'Grace Church School Investment Club: twenty minutes on polished prices?' };
const chase = { id: 900, subject: 'Re: Grace Church School Investment Club: twenty minutes on polished prices?' };

test('a letter pasted into Gmail claims the draft it was', () => {
  // Never seen by the ledger, same person, same subject under the Re:.
  const m = { gmailMessageId: 'g-new', subject: 'Re: Grace Church School Investment Club: twenty minutes on polished prices?' };
  assert.equal(shouldClaimTwin({ freshlyRecorded: true, message: m, readingDraft: first, twin: chase }), true);
});

test('re-reading the first letter never claims the chase staged under it', () => {
  // The sweep sees the first letter on every tick. Its ledger row already
  // exists (the send wrote it), so the create came back P2002 and the
  // letter is not new. That alone must be enough.
  const m = { gmailMessageId: 'g-first', subject: first.subject };
  assert.equal(shouldClaimTwin({ freshlyRecorded: false, message: m, readingDraft: first, twin: chase }), false);
});

test('the letter being read is never its own twin, even if it looked new', () => {
  const m = { gmailMessageId: 'g-first', subject: first.subject };
  assert.equal(shouldClaimTwin({ freshlyRecorded: true, message: m, readingDraft: first, twin: chase }), false);
});

test('a different subject is a different letter', () => {
  const m = { gmailMessageId: 'g-new', subject: 'Re: How many weddings, and is the number turning?' };
  assert.equal(shouldClaimTwin({ freshlyRecorded: true, message: m, readingDraft: first, twin: chase }), false);
});

test('nothing to claim without a candidate', () => {
  const m = { gmailMessageId: 'g-new', subject: chase.subject };
  assert.equal(shouldClaimTwin({ freshlyRecorded: true, message: m, readingDraft: first, twin: null }), false);
});
