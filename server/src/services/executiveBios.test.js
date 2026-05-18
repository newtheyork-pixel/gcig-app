import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pickLatest10K,
  getExecutiveBios,
  _resetExecBiosCache,
} from './executiveBios.js';

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__'
);
const fixture = (tk) =>
  fs.readFileSync(path.join(dir, `${tk}-10k.html`), 'utf8');

// Mirrors proxyStatement.test.js's pickLatestDef14A case: newest 10-K
// only, never an amendment, and the SEC xsl viewer segment stripped so
// the raw primary document is fetched (a browser-style viewer URL would
// hand back the HTML wrapper, not the filing).
const FILINGS = [
  { accessionNumber: 'a3', form: '10-K/A', filingDate: '2026-04-02', primaryDocument: 'amend.htm', url: 'https://x/amend.htm' },
  { accessionNumber: 'a2', form: '10-K', filingDate: '2026-02-06', primaryDocument: 'k.htm', url: 'https://www.sec.gov/Archives/edgar/data/1/000/xslF345X09/k-2026.htm' },
  { accessionNumber: 'a1', form: '10-K', filingDate: '2025-02-01', primaryDocument: 'k.htm', url: 'https://x/k-2025.htm' },
  { accessionNumber: 'a0', form: '8-K', filingDate: '2026-05-01', primaryDocument: 'e.htm', url: 'https://x/e.htm' },
];

test('pickLatest10K: newest 10-K, never an amendment, xsl stripped', () => {
  const f = pickLatest10K(FILINGS);
  assert.equal(f.filingDate, '2026-02-06');
  assert.equal(f.url, 'https://www.sec.gov/Archives/edgar/data/1/000/k-2026.htm');
  assert.equal(pickLatest10K(FILINGS.filter((x) => x.form !== '10-K')), null);
  assert.equal(pickLatest10K(null), null);
});

// AMZN ships the section as a Name/Age/Position summary table followed
// by one bold-name prose paragraph per officer — the prose IS the bio.
// The trailing Board-of-Directors table (trimmed in as a real sibling)
// also carries Name/Age/Position cells, so the non-executive director
// Keith B. Alexander is the canonical leak the section bound must
// exclude. Ground-truth phrases are verbatim from the SEC-filed prose.
test('AMZN: per-officer prose bios, directors excluded', async () => {
  _resetExecBiosCache();
  const r = await getExecutiveBios('AMZN', {
    filingsFetch: async () => [
      { form: '10-K', filingDate: '2026-02-06', url: 'https://x/amzn.htm' },
    ],
    docFetch: async () => fixture('AMZN'),
  });
  assert.equal(r.ticker, 'AMZN');
  assert.equal(r.source, 'https://x/amzn.htm');
  assert.equal(r.asOf, '2026-02-06');
  const by = (nm) => r.officers.find((o) => o.name === nm);

  const jassy = by('Andrew R. Jassy');
  assert.ok(jassy, `AMZN: Andrew R. Jassy missing (${JSON.stringify(r.officers.map((o) => o.name))})`);
  assert.equal(typeof jassy.bio, 'string');
  assert.ok(
    jassy.bio.includes(
      'Mr. Jassy has served as President and Chief Executive Officer since July 2021'
    ),
    `AMZN: Jassy bio wrong (got ${JSON.stringify(jassy.bio)})`
  );

  const olsavsky = by('Brian T. Olsavsky');
  assert.ok(olsavsky, 'AMZN: Brian T. Olsavsky missing');
  assert.ok(
    olsavsky.bio.includes(
      'Mr. Olsavsky has served as Senior Vice President and Chief Financial Officer since June 2015'
    ),
    `AMZN: Olsavsky bio wrong (got ${JSON.stringify(olsavsky.bio)})`
  );

  const bezos = by('Jeffrey P. Bezos');
  assert.ok(bezos, 'AMZN: Jeffrey P. Bezos missing');
  assert.ok(
    bezos.bio.includes('Mr. Bezos founded Amazon.com in 1994'),
    `AMZN: Bezos bio wrong (got ${JSON.stringify(bezos.bio)})`
  );

  // The Board-of-Directors table sits right after the officers and
  // carries the same Name/Age/Position columns; a non-executive
  // director must never surface as an officer.
  assert.ok(
    !r.officers.some((o) => o.name === 'Keith B. Alexander'),
    `AMZN: director Keith B. Alexander leaked (${JSON.stringify(r.officers.map((o) => o.name))})`
  );
  assert.ok(
    r.officers.length >= 7,
    `AMZN: expected >=7 officers, got ${r.officers.length}`
  );
});

// KO ships every officer as a single <tr> [Name, Age, career-narrative]
// and the narrative cell IS the bio. The table is split across a page
// break into two <table>s (3 + 8 officers); both must be read. Quincey
// is the CEO, Murphy the CFO/President, Braun the incoming CEO.
test('KO: narrative-cell bios across the page-split table', async () => {
  _resetExecBiosCache();
  const r = await getExecutiveBios('KO', {
    filingsFetch: async () => [
      { form: '10-K', filingDate: '2026-02-20', url: 'https://x/ko.htm' },
    ],
    docFetch: async () => fixture('KO'),
  });
  assert.equal(r.ticker, 'KO');
  assert.equal(r.asOf, '2026-02-20');
  const by = (nm) => r.officers.find((o) => o.name === nm);

  const quincey = by('James Quincey');
  assert.ok(quincey, `KO: James Quincey missing (${JSON.stringify(r.officers.map((o) => o.name))})`);
  assert.ok(
    quincey.bio.includes(
      'Chairman of the Board of Directors since April 2019 and Chief Executive Officer since May 2017'
    ),
    `KO: Quincey bio wrong (got ${JSON.stringify(quincey.bio)})`
  );

  const murphy = by('John Murphy');
  assert.ok(murphy, 'KO: John Murphy missing');
  assert.ok(
    murphy.bio.includes(
      'President since October 2022 and Chief Financial Officer since March 2019'
    ),
    `KO: Murphy bio wrong (got ${JSON.stringify(murphy.bio)})`
  );

  const braun = by('Henrique Braun');
  assert.ok(braun, 'KO: Henrique Braun missing (second-page table)');
  assert.ok(
    braun.bio.includes('Chief Operating Officer since January 2025'),
    `KO: Braun bio wrong (got ${JSON.stringify(braun.bio)})`
  );
  assert.ok(
    r.officers.length >= 11,
    `KO: expected >=11 officers across both tables, got ${r.officers.length}`
  );
});

// CAT is the conventional substitute (MLAB and AAPL both incorporate
// Item 10 by reference to the proxy and carry no 10-K officer section —
// see __fixtures__/README.md). Its section is one table with the name
// carrying a parenthetical age and two position columns; the bio is
// those columns. Creed is CEO, Bonfield CFO.
test('CAT: conventional officer table, age stripped from name', async () => {
  _resetExecBiosCache();
  const r = await getExecutiveBios('CAT', {
    filingsFetch: async () => [
      { form: '10-K', filingDate: '2026-02-13', url: 'https://x/cat.htm' },
    ],
    docFetch: async () => fixture('CAT'),
  });
  assert.equal(r.ticker, 'CAT');
  const by = (nm) => r.officers.find((o) => o.name === nm);

  const creed = by('Joseph E. Creed');
  assert.ok(creed, `CAT: Joseph E. Creed missing (${JSON.stringify(r.officers.map((o) => o.name))})`);
  assert.ok(
    creed.bio.includes('Chief Executive Officer') &&
      creed.bio.includes(
        'Chief Operating Officer (2023-2025), Group President (2021-2023)'
      ),
    `CAT: Creed bio wrong (got ${JSON.stringify(creed.bio)})`
  );

  const bonfield = by('Andrew R.J. Bonfield');
  assert.ok(bonfield, 'CAT: Andrew R.J. Bonfield missing');
  assert.ok(
    bonfield.bio.includes(
      'Group Chief Financial Officer for a multinational electricity and gas utility company (2010-2018)'
    ),
    `CAT: Bonfield bio wrong (got ${JSON.stringify(bonfield.bio)})`
  );
  // The age rides the name cell as "(50)"; it must be cleaned off the
  // name, never left dangling.
  assert.ok(
    r.officers.every((o) => !/\(\d{2}\)/.test(o.name)),
    `CAT: a name still carries a parenthetical age (${JSON.stringify(r.officers.map((o) => o.name))})`
  );
  assert.ok(
    r.officers.length >= 11,
    `CAT: expected >=11 officers, got ${r.officers.length}`
  );
});

// The never-throws contract, same shape proxyStatement.test.js asserts:
// every failure mode degrades to the empty stub, not an exception.
test('getExecutiveBios: empty stub (never throws) on every failure mode', async () => {
  _resetExecBiosCache();
  const empty = { ticker: '', source: null, asOf: null, officers: [] };

  // Empty / junk ticker — no lookup attempted.
  assert.deepEqual(await getExecutiveBios(''), empty);
  assert.deepEqual(await getExecutiveBios(null), empty);
  assert.deepEqual(await getExecutiveBios(undefined), empty);

  // filingsFetch throwing.
  _resetExecBiosCache();
  const a = await getExecutiveBios('AAA', {
    filingsFetch: async () => {
      throw new Error('sec submissions down');
    },
  });
  assert.deepEqual(a, { ticker: 'AAA', source: null, asOf: null, officers: [] });

  // docFetch throwing.
  _resetExecBiosCache();
  const b = await getExecutiveBios('BBB', {
    filingsFetch: async () => [
      { form: '10-K', filingDate: '2026-01-01', url: 'https://x/k.htm' },
    ],
    docFetch: async () => {
      throw new Error('sec doc 403');
    },
  });
  assert.deepEqual(b, { ticker: 'BBB', source: null, asOf: null, officers: [] });

  // No 10-K in the feed.
  _resetExecBiosCache();
  const c = await getExecutiveBios('CCC', { filingsFetch: async () => [] });
  assert.deepEqual(c, { ticker: 'CCC', source: null, asOf: null, officers: [] });

  // A 10-K with no exec-officers section at all — found and fetched,
  // but the section locate misses. Honest empty officers, never throw,
  // never fabricate.
  _resetExecBiosCache();
  const d = await getExecutiveBios('DDD', {
    filingsFetch: async () => [
      { form: '10-K', filingDate: '2026-03-01', url: 'https://x/k.htm' },
    ],
    docFetch: async () =>
      '<html><body><h1>Item 1. Business</h1><p>We make widgets. Item 10 is incorporated by reference to the proxy.</p></body></html>',
  });
  assert.equal(d.officers.length, 0);
  assert.equal(Array.isArray(d.officers), true);
});

// Same 24h cache discipline proxyStatement.test.js asserts: a warm
// ticker is served from cache (docFetch called once), and the cached
// object is returned by identity.
test('getExecutiveBios: 24h cache keyed by ticker', async () => {
  _resetExecBiosCache();
  let docCalls = 0;
  const opts = {
    filingsFetch: async () => [
      { form: '10-K', filingDate: '2026-02-06', url: 'https://x/amzn.htm' },
    ],
    docFetch: async () => {
      docCalls++;
      return fixture('AMZN');
    },
  };
  const a = await getExecutiveBios('AMZN', opts);
  const b = await getExecutiveBios('AMZN', opts);
  assert.equal(docCalls, 1);
  assert.strictEqual(b, a);
  _resetExecBiosCache();
  const c = await getExecutiveBios('AMZN', opts);
  assert.equal(docCalls, 2);
  assert.notStrictEqual(c, a);
});

// 10-Ks are tens of MB; the size cap must fire before parsing so a
// pathological filing can't blow memory. Mirrors proxyStatement's cap
// test: an over-cap input is truncated, the call still succeeds.
test('getExecutiveBios: caps html size at 12 MB', async () => {
  _resetExecBiosCache();
  // A real section embedded at the very front, then megabytes of pad
  // past the 12 MB cap. The officer must still parse (it's before the
  // cut); the call must not throw on the giant input.
  const head = fixture('AMZN');
  const big = head + 'x'.repeat(13 * 1024 * 1024);
  const r = await getExecutiveBios('BIG', {
    filingsFetch: async () => [
      { form: '10-K', filingDate: '2026-02-06', url: 'https://x/k.htm' },
    ],
    docFetch: async () => big,
  });
  assert.equal(r.source, 'https://x/k.htm');
  assert.ok(
    r.officers.some((o) => o.name === 'Andrew R. Jassy'),
    'size-cap: officer before the cut should still parse'
  );
});
