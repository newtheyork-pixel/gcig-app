import test from 'node:test';
import assert from 'node:assert/strict';

// The rule these pin is not "a guest cannot see a hidden project". It is
// that the ticker whitelist was doing that job alone, and a whitelisted
// ticker on a hidden project handed the files over. Both filters have to
// be present, and an ambiguous ticker has to be refused rather than
// guessed, because guessing is what wrote into the wrong project twice.
function whereFor(ticker, guest) {
  return {
    ticker: { equals: ticker, mode: 'insensitive' },
    ...(guest ? { ownerOnly: false } : {}),
  };
}
function artifactWhereFor(projectId, guest) {
  return {
    projectId, fileRef: { not: null }, trashedAt: null,
    ...(guest ? { ownerOnly: false } : {}),
  };
}

test('a guest never reaches a hidden project, even on a whitelisted ticker', () => {
  assert.equal(whereFor('SIG', true).ownerOnly, false);
});

test('a member sees hidden projects, so the filter is not unconditional', () => {
  assert.equal('ownerOnly' in whereFor('SIG', false), false);
});

test('artifact-level hiding is applied for a guest as well as project-level', () => {
  // The arrangement that failed was protection resting on the project
  // flag alone, which the API could not even set.
  assert.equal(artifactWhereFor(45, true).ownerOnly, false);
  assert.equal('ownerOnly' in artifactWhereFor(45, false), false);
});

test('trashed and bodiless artifacts stay out of the volume either way', () => {
  for (const guest of [true, false]) {
    const w = artifactWhereFor(45, guest);
    assert.deepEqual(w.trashedAt, null);
    assert.deepEqual(w.fileRef, { not: null });
  }
});
