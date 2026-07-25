import test from 'node:test';
import assert from 'node:assert/strict';
import { listResearch, parseRef } from './internalResearch.js';

// The archive is two tables pretending to be one list, so the risks are
// all at the seam: ids that collide across tables, a merged sort that
// only sorts within one source, and pitches losing their presenters.

const REPORTS = [
  {
    id: 12,
    title: 'Applied Industrial: distribution roll-up',
    author: 'M. Chen',
    ticker: 'AIT',
    date: new Date('2026-03-14'),
    description: 'Long thesis on the service mix',
    fileUrl: 'onedrive:REPORT-ITEM-1',
  },
  {
    id: 7,
    title: 'Rate path and the book',
    author: 'S. Patel',
    ticker: null,
    date: new Date('2026-01-05'),
    description: null,
    fileUrl: 'https://example.com/external.pdf',
  },
];

const PITCHES = [
  {
    id: 12, // deliberately the same integer as REPORTS[0]
    pitcherName: 'legacy name',
    ticker: 'AIT',
    date: new Date('2026-02-20'),
    location: 'Library',
    slideshowUrl: 'onedrive:DECK-ITEM-9',
    votedOutcome: 'Buy',
    industry: { name: 'Industrials' },
    presenters: [
      { user: { name: 'M. Chen' } },
      { user: { name: 'R. Alvarez' } },
    ],
  },
  {
    id: 3,
    pitcherName: 'D. Okonkwo',
    ticker: 'SPY',
    date: new Date('2026-05-02'),
    location: null,
    slideshowUrl: null,
    votedOutcome: null,
    industry: null,
    presenters: [],
  },
];

const deps = {
  loadReports: async (symbol) =>
    symbol ? REPORTS.filter((r) => r.ticker === symbol) : REPORTS,
  loadPitches: async (symbol) =>
    symbol ? PITCHES.filter((p) => p.ticker === symbol) : PITCHES,
};

test('merges both tables into one chronology, newest first', async () => {
  const items = await listResearch({}, deps);
  assert.equal(items.length, 4);
  const dates = items.map((i) => new Date(i.date).getTime());
  assert.deepEqual([...dates].sort((a, b) => b - a), dates);
  // The interleave is the point: a pitch must be able to sort between
  // two reports.
  assert.equal(items[0].kind, 'pitch'); // SPY 05-02
  assert.equal(items[1].kind, 'report'); // AIT 03-14
  assert.equal(items[2].kind, 'pitch'); // AIT 02-20
});

test('namespaces ids so equal row numbers stay distinct', async () => {
  const items = await listResearch({}, deps);
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('report:12'));
  assert.ok(ids.includes('pitch:12'));
});

test('pushes the ticker filter down to both loaders', async () => {
  const items = await listResearch({ ticker: 'ait' }, deps);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.ticker === 'AIT'));
});

test('pitch titles carry the industry and presenters replace the legacy name', async () => {
  const [pitch] = await listResearch({ ticker: 'AIT' }, deps).then((r) =>
    r.filter((i) => i.kind === 'pitch')
  );
  assert.equal(pitch.title, 'AIT — Pitch (Industrials)');
  assert.equal(pitch.author, 'M. Chen, R. Alvarez');
  assert.equal(pitch.outcome, 'Buy');
});

test('a pitch with no presenters falls back to pitcherName', async () => {
  const items = await listResearch({ ticker: 'SPY' }, deps);
  assert.equal(items[0].author, 'D. Okonkwo');
  assert.equal(items[0].title, 'SPY — Pitch');
});

test('entries with no uploaded file are still listed, with a null fileRef', async () => {
  const items = await listResearch({ ticker: 'SPY' }, deps);
  assert.equal(items[0].fileRef, null);
});

test('free-text search spans title, author, ticker and industry', async () => {
  assert.equal((await listResearch({ q: 'roll-up' }, deps)).length, 1);
  assert.equal((await listResearch({ q: 'okonkwo' }, deps)).length, 1);
  assert.equal((await listResearch({ q: 'industrials' }, deps)).length, 1);
  assert.equal((await listResearch({ q: 'nothing-matches' }, deps)).length, 0);
});

test('search is case-insensitive', async () => {
  assert.equal((await listResearch({ q: 'APPLIED' }, deps)).length, 1);
});

test('parseRef accepts well-formed references and rejects everything else', () => {
  assert.deepEqual(parseRef('report:12'), { kind: 'report', id: 12 });
  assert.deepEqual(parseRef('pitch:3'), { kind: 'pitch', id: 3 });
  for (const bad of [
    null, undefined, '', 'report', 'report:', ':12', 'report:abc',
    'note:1', 'report:12:extra', 'REPORT:12', 'report:-1',
  ]) {
    assert.equal(parseRef(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});
