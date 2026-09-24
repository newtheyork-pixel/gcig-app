import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE,
  MEMBER_STATUSES,
  NOTE_MAX,
  isActive,
  statusLabel,
  parseStatusUpdate,
} from './memberStatus.js';

test('rows written before the column existed count as on the roster', () => {
  assert.equal(isActive(undefined), true);
  assert.equal(isActive(null), true);
  assert.equal(isActive(ACTIVE), true);
  assert.equal(isActive('Alumni'), false);
});

test('labels come from the one list, with a readable fallback', () => {
  assert.equal(statusLabel('OnLeave'), 'On leave');
  assert.equal(statusLabel('Advisory'), 'Advisory capacity');
  assert.equal(statusLabel(null), 'Active');
  assert.equal(statusLabel('Retired'), 'Retired');
});

test('every standing in the list is accepted', () => {
  for (const { value } of MEMBER_STATUSES) {
    const note = value === 'Other' ? 'exchange semester' : undefined;
    assert.equal(parseStatusUpdate({ status: value, note }).status, value);
  }
});

test('an unknown or missing standing is refused', () => {
  assert.match(parseStatusUpdate({ status: 'Banned' }).error, /status must be one of/);
  assert.match(parseStatusUpdate({}).error, /status must be one of/);
  assert.match(parseStatusUpdate(null).error, /status must be one of/);
});

test('notes are trimmed, and blank means none', () => {
  assert.deepEqual(parseStatusUpdate({ status: 'Alumni', note: '  Class of 2026  ' }), {
    status: 'Alumni',
    note: 'Class of 2026',
  });
  assert.deepEqual(parseStatusUpdate({ status: 'Alumni', note: '   ' }), {
    status: 'Alumni',
    note: null,
  });
});

test('Other needs a note, the rest do not', () => {
  assert.match(parseStatusUpdate({ status: 'Other' }).error, /Other/);
  assert.match(parseStatusUpdate({ status: 'Other', note: '  ' }).error, /Other/);
  assert.equal(parseStatusUpdate({ status: 'OnLeave' }).note, null);
});

test('overlong or non-text notes are refused', () => {
  const long = 'x'.repeat(NOTE_MAX + 1);
  assert.match(parseStatusUpdate({ status: 'Alumni', note: long }).error, /characters or fewer/);
  assert.match(parseStatusUpdate({ status: 'Alumni', note: 42 }).error, /note must be text/);
});

test('restoring to Active clears whatever note came with it', () => {
  assert.deepEqual(parseStatusUpdate({ status: ACTIVE, note: 'back from leave' }), {
    status: ACTIVE,
    note: null,
  });
});
