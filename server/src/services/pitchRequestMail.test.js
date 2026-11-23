import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DECK_ATTACHMENT_BYTES,
  deckFitsInEmail,
  deckForEmail,
  newRequestRecipients,
} from './pitchRequestMail.js';

const thomas = { id: 1, name: 'Thomas', email: 'thomas@example.org' };
const sander = { id: 2, name: 'Sander', email: 'sander@example.org' };
const dana = { id: 3, name: 'Dana', email: 'dana@example.org' };
const maya = { id: 4, name: 'Maya', email: 'maya@example.org' };
const roles = (list) => list.map((r) => `${r.name}:${r.role}`);

test('every President is told about a request, not just the first', () => {
  const out = newRequestRecipients({ presidents: [thomas, sander], requester: maya, pm: dana });
  assert.deepEqual(roles(out), ['Thomas:President', 'Sander:President', 'Maya:Requester', 'Dana:PM']);
});

test('nobody is emailed twice', () => {
  // A President filing a request has the President's copy already.
  const byPresident = newRequestRecipients({ presidents: [thomas, sander], requester: sander, pm: dana });
  assert.deepEqual(roles(byPresident), ['Thomas:President', 'Sander:President', 'Dana:PM']);
  // A PM filing for their own pod hears as the requester, not as the
  // PM being told about one of their members.
  const byPm = newRequestRecipients({ presidents: [thomas], requester: dana, pm: dana });
  assert.deepEqual(roles(byPm), ['Thomas:President', 'Dana:Requester']);
});

test('an account with no email is skipped, not sent to undefined', () => {
  const out = newRequestRecipients({
    presidents: [{ id: 9, name: 'No Email', email: null }, sander],
    requester: maya,
    pm: null,
  });
  assert.deepEqual(roles(out), ['Sander:President', 'Maya:Requester']);
});

test('a deck is attached only while the message stays under Gmail’s limit', () => {
  assert.equal(deckFitsInEmail(2 * 1024 * 1024), true);
  assert.equal(deckFitsInEmail(MAX_DECK_ATTACHMENT_BYTES), true);
  assert.equal(deckFitsInEmail(MAX_DECK_ATTACHMENT_BYTES + 1), false);
  // Base64 makes a file a third bigger; whatever fits must stay under
  // 25 MB once encoded.
  assert.ok((MAX_DECK_ATTACHMENT_BYTES * 4) / 3 < 25 * 1024 * 1024);
  assert.equal(deckFitsInEmail(Number.NaN), false);
});

test('a deck that was not attached is still linked', () => {
  const inboxUrl = 'https://thegriffinfund.org/pitch-requests';
  assert.deepEqual(
    deckForEmail({ deckRef: 'onedrive:ABC', attachment: { filename: 'AIT.pdf' }, inboxUrl }),
    { deckUrl: null, deckFileName: 'AIT.pdf' }
  );
  assert.deepEqual(
    deckForEmail({ deckRef: 'https://docs.google.com/presentation/d/x', attachment: null, inboxUrl }),
    { deckUrl: 'https://docs.google.com/presentation/d/x', deckFileName: null }
  );
  // Too big, or OneDrive unreachable: the email used to say nothing at
  // all about the deck.
  assert.deepEqual(deckForEmail({ deckRef: 'onedrive:ABC', attachment: null, inboxUrl }), {
    deckUrl: inboxUrl,
    deckFileName: 'Open it on the Griffin Fund',
  });
});
