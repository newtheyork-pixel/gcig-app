import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPitchMeetingIcs } from './email.js';

const base = {
  uid: 'pitch-request-8@griffinfund',
  proposedDate: '2026-12-02T00:00:00.000Z',
  proposedStartTime: '13:50',
  ticker: 'TEST',
  organizerEmail: 'president@example.org',
  organizerName: 'President',
  attendeeEmails: ['member@example.org'],
};
const field = (ics, name) => ics.match(new RegExp(`^${name}[^:\\r\\n]*:(.*)$`, 'm'))?.[1]?.trim();

test('an approval sends a plain invite', () => {
  const ics = buildPitchMeetingIcs(base);
  assert.equal(field(ics.content, 'METHOD'), 'REQUEST');
  assert.equal(field(ics.content, 'SEQUENCE'), undefined);
  assert.equal(field(ics.content, 'STATUS'), undefined);
  assert.match(ics.contentType, /method=REQUEST/);
  assert.equal(ics.filename, 'pitch-meeting.ics');
});

test('a withdrawal cancels that same invite, and outranks it', () => {
  const invite = buildPitchMeetingIcs(base).content;
  const cancel = buildPitchMeetingIcs({ ...base, method: 'CANCEL' });
  assert.equal(field(cancel.content, 'METHOD'), 'CANCEL');
  assert.equal(field(cancel.content, 'STATUS'), 'CANCELLED');
  // The invite carried no SEQUENCE, which reads as zero.
  assert.equal(field(cancel.content, 'SEQUENCE'), '1');
  assert.match(cancel.contentType, /method=CANCEL/);
  // Calendars find the meeting to remove by UID.
  assert.equal(field(cancel.content, 'UID'), field(invite, 'UID'));
  assert.equal(field(cancel.content, 'DTSTART'), '20261202T135000');
  assert.equal(field(cancel.content, 'DTSTART'), field(invite, 'DTSTART'));
  assert.equal(field(cancel.content, 'ORGANIZER'), field(invite, 'ORGANIZER'));
});
