# MGMT Structure-Aware DEF 14A Parser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MGMT's flatten-then-regex parsing with `node-html-parser`-based structure-aware extraction so the Comp/Board/Network tabs populate for real large-cap proxies (AMZN/AAPL/KO).

**Architecture:** `proxyStatement.js` stops flattening and returns the raw DEF 14A HTML. `governanceParsers.js` parses that HTML with `node-html-parser` and finds the Summary Compensation Table and director table by their **column-header signature anywhere in the DOM** (TOC-proof); Leadership DOM-locates the exec-officers block and prose-parses it (best-effort tier). Route payload and the client are unchanged.

**Tech Stack:** Node ESM, `node-html-parser` (new dep), `node:test`/`node:assert/strict`, existing `secFilings.js` (`SEC_UA`, CIK), Express `terminal.js`. Server-only; client untouched.

---

## File Structure

- **Modify** `server/package.json` — add `node-html-parser` dependency.
- **Modify** `server/src/services/proxyStatement.js` — drop `htmlToText`/`splitSections`/`ANCHORS`/`ENTITIES`; `getProxyStatement` returns `{ ticker, filedAt, url, html, _source }` (raw, size-capped). Keep CIK/`pickLatestDef14A`/`SEC_UA`/cache/never-throws.
- **Modify** `server/src/services/proxyStatement.test.js` — replace the htmlToText/splitSections/sections tests with html-returning tests.
- **Create** `server/src/services/htmlExtract.js` — small pure DOM helpers: `parseHtml`, `cellText`, `tableRows`, `findTableBySignature`, `headerMap`, `locateSectionText`.
- **Create** `server/src/services/htmlExtract.test.js`.
- **Rewrite** `server/src/services/governanceParsers.js` — `parseComp(html)`, `parseBoard(html)`, `parseLeadership(html)` structure-aware; `buildNetwork` unchanged.
- **Modify** `server/src/services/governanceParsers.test.js` — tests now feed realistic HTML; `buildNetwork` tests unchanged.
- **Create** `server/src/services/__fixtures__/` — captured real DEF 14A HTML excerpts (added by the capture task).
- **Modify** `server/src/routes/terminal.js` — pass `proxy.html` to the parsers (was `proxy.sections`).

Conventions: server tests colocated `*.test.js`, `node --test`. Never-throws/best-effort contract (mirrors `worldIndices.js`). Editorial comments (why, not what). `node-html-parser` API used: `parse(html)` → root; `root.querySelectorAll('table'|'tr'|'th,td')`; `el.text` (entity-decoded text, tags stripped); `el.tagName`; `el.nextElementSibling`.

---

## Task 1: Add node-html-parser; proxyStatement returns raw HTML

**Files:**
- Modify: `server/package.json`, `server/src/services/proxyStatement.js`
- Test: `server/src/services/proxyStatement.test.js`

- [ ] **Step 1: Install the dependency**

Run: `cd server && npm install node-html-parser@^7`
Expected: `node-html-parser` appears under `dependencies` in `server/package.json`; `npm test` still green afterward.

- [ ] **Step 2: Rewrite the proxyStatement tests (TDD — these will fail first)**

Replace the ENTIRE body of `server/src/services/proxyStatement.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLatestDef14A,
  getProxyStatement,
  _resetProxyCache,
} from './proxyStatement.js';

const FILINGS = [
  { accessionNumber: 'a2', form: 'DEFA14A', filingDate: '2026-04-02', primaryDocument: 'extra.htm', url: 'https://x/extra.htm' },
  { accessionNumber: 'a1', form: 'DEF 14A', filingDate: '2026-03-15', primaryDocument: 'p.htm', url: 'https://www.sec.gov/Archives/edgar/data/1/000/xslF345X09/p2026.htm' },
  { accessionNumber: 'a0', form: 'DEF 14A', filingDate: '2025-03-10', primaryDocument: 'p.htm', url: 'https://x/p2025.htm' },
  { accessionNumber: 'a9', form: '4', filingDate: '2026-05-01', primaryDocument: 'f4.xml', url: 'https://x/f4.xml' },
];

test('pickLatestDef14A: newest DEF 14A, never DEFA14A, xsl stripped', () => {
  const f = pickLatestDef14A(FILINGS);
  assert.equal(f.filingDate, '2026-03-15');
  assert.equal(f.url, 'https://www.sec.gov/Archives/edgar/data/1/000/p2026.htm');
  assert.equal(pickLatestDef14A(FILINGS.filter((x) => x.form !== 'DEF 14A')), null);
  assert.equal(pickLatestDef14A(null), null);
});

test('getProxyStatement returns raw html (no sections) on a found proxy', async () => {
  _resetProxyCache();
  let docCalls = 0;
  const opts = {
    filingsFetch: async () => [{ form: 'DEF 14A', filingDate: '2026-03-15', url: 'https://x/p.htm' }],
    docFetch: async () => { docCalls++; return '<html><body><table><tr><th>Salary</th><th>Total</th></tr></table></body></html>'; },
  };
  const a = await getProxyStatement('AAA', opts);
  const b = await getProxyStatement('AAA', opts);
  assert.equal(a._source, 'sec');
  assert.equal(a.filedAt, '2026-03-15');
  assert.match(a.html, /<table>/);
  assert.equal('sections' in a, false);
  assert.equal(docCalls, 1); // cached
  assert.strictEqual(b, a);
});

test('getProxyStatement stub (never throws) when no DEF 14A / on error', async () => {
  _resetProxyCache();
  const none = await getProxyStatement('NOPE', { filingsFetch: async () => [] });
  assert.equal(none._source, null);
  assert.equal(none.html, '');
  _resetProxyCache();
  const errd = await getProxyStatement('ERR', {
    filingsFetch: async () => [{ form: 'DEF 14A', filingDate: '2026-01-01', url: 'https://x/p.htm' }],
    docFetch: async () => { throw new Error('sec down'); },
  });
  assert.equal(errd._source, null);
  assert.equal(errd.html, '');
});

test('getProxyStatement caps html size', async () => {
  _resetProxyCache();
  const big = 'x'.repeat(6 * 1024 * 1024);
  const r = await getProxyStatement('BIG', {
    filingsFetch: async () => [{ form: 'DEF 14A', filingDate: '2026-01-01', url: 'https://x/p.htm' }],
    docFetch: async () => big,
  });
  assert.equal(r._source, 'sec');
  assert.ok(r.html.length <= 4 * 1024 * 1024);
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `cd server && node --test src/services/proxyStatement.test.js`
Expected: FAIL (current code exports `htmlToText`/`splitSections`, returns `sections`, no size cap).

- [ ] **Step 4: Rewrite proxyStatement.js**

Replace the ENTIRE contents of `server/src/services/proxyStatement.js` with:

```js
// MGMT spine. Retrieves a company's latest DEF 14A and returns the RAW
// HTML — structure-aware parsing happens in governanceParsers.js, which
// needs the real <table> structure (flattening it destroyed the Summary
// Compensation Table and board roster, which is why MGMT was empty for
// large-caps). Best-effort, never throws (same contract as
// services/worldIndices.js): a missing/failed proxy yields an empty stub.
import { getRecentFilings, SEC_UA } from './secFilings.js';

// SEC hands back the XSL viewer URL (.../xslF…/doc.htm → HTML wrapper).
// The raw primary document sits at the same path without that segment.
function toRawUrl(url) {
  return String(url || '').replace(/\/xsl[^/]+\//, '/');
}

// DEFA14A is supplementary soliciting material and usually lacks the
// bio/comp tables — never fall back to it. Newest DEF 14A only.
export function pickLatestDef14A(filings) {
  if (!Array.isArray(filings)) return null;
  const def = filings
    .filter((f) => f && String(f.form) === 'DEF 14A' && f.url)
    .sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
  if (def.length === 0) return null;
  return { ...def[0], url: toRawUrl(def[0].url) };
}

// Real proxies are 0.3–2 MB. Cap defensively so a pathological response
// can't blow memory; node-html-parser handles a few MB cheaply.
const MAX_HTML = 4 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
export function _resetProxyCache() {
  cache.clear();
}

async function defaultFilingsFetch(ticker) {
  return getRecentFilings(ticker, { limit: 150 });
}
async function defaultDocFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`sec doc ${r.status}`);
  return r.text();
}

// { ticker, filedAt, url, html, _source }. Never throws.
export async function getProxyStatement(ticker, deps = {}) {
  const sym = String(ticker || '').toUpperCase();
  const empty = { ticker: sym, filedAt: null, url: null, html: '', _source: null };
  if (!sym) return empty;

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const filingsFetch = deps.filingsFetch || defaultFilingsFetch;
  const docFetch = deps.docFetch || defaultDocFetch;

  let payload = empty;
  try {
    const filing = pickLatestDef14A(await filingsFetch(sym));
    if (filing) {
      const raw = await docFetch(filing.url);
      payload = {
        ticker: sym,
        filedAt: filing.filingDate || null,
        url: filing.url,
        html: String(raw || '').slice(0, MAX_HTML),
        _source: 'sec',
      };
    }
  } catch (err) {
    console.warn(`proxyStatement(${sym}) failed:`, err.message);
    payload = empty;
  }

  cache.set(sym, { at: Date.now(), payload });
  return payload;
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd server && node --test src/services/proxyStatement.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/thomasseirer/Desktop/gcig-app
git add server/package.json server/package-lock.json server/src/services/proxyStatement.js server/src/services/proxyStatement.test.js
git commit -m "feat(mgmt): proxyStatement returns raw html; add node-html-parser

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: DOM helpers (`htmlExtract.js`)

**Files:**
- Create: `server/src/services/htmlExtract.js`
- Test: `server/src/services/htmlExtract.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/htmlExtract.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHtml,
  cellText,
  tableRows,
  findTableBySignature,
  headerMap,
  locateSectionText,
} from './htmlExtract.js';

const HTML = `
<html><body>
<div>TABLE OF CONTENTS Summary Compensation Table .... 64</div>
<h2>Summary Compensation Table</h2>
<table>
  <tr><th>Name and Principal Position</th><th>Year</th><th>Salary&nbsp;($)</th><th>Bonus ($)</th><th>Stock Awards ($)</th><th>Option Awards ($)</th><th>Total ($)</th></tr>
  <tr><td>Jane A. Doe, CEO</td><td>2025</td><td>1,000,000</td><td>0</td><td>5,000,000</td><td>3,000,000</td><td>10,000,000</td></tr>
</table>
<h2>Information about our Executive Officers</h2>
<p>Jane A. Doe, 54, has served as Chief Executive Officer since 2018.</p>
<h2>Next Section</h2>
</body></html>`;

test('cellText decodes entities, strips tags, collapses space', () => {
  const root = parseHtml('<td>Salary&nbsp;($)<b> x</b></td>');
  assert.equal(cellText(root.querySelector('td')), 'Salary ($) x');
});

test('findTableBySignature finds the SCT by header cells', () => {
  const root = parseHtml(HTML);
  const t = findTableBySignature(root, (cells) => {
    const j = cells.join(' | ').toLowerCase();
    return /salary/.test(j) && /total/.test(j);
  });
  assert.ok(t, 'SCT table found');
  const rows = tableRows(t);
  assert.equal(rows.length, 2);
  const hm = headerMap(rows[0]);
  assert.equal(hm.total >= 0, true);
  assert.equal(rows[1][hm.total], '10,000,000');
  assert.equal(rows[1][hm.salary], '1,000,000');
});

test('locateSectionText returns text after a heading up to the next heading', () => {
  const root = parseHtml(HTML);
  const txt = locateSectionText(root, /executive officers/i);
  assert.match(txt, /Jane A\. Doe, 54, has served as Chief Executive Officer since 2018/);
  assert.doesNotMatch(txt, /Next Section/);
});

test('helpers never throw on garbage', () => {
  assert.doesNotThrow(() => findTableBySignature(parseHtml(''), () => true));
  assert.equal(findTableBySignature(parseHtml('<p>x</p>'), () => true), null);
  assert.equal(locateSectionText(parseHtml('<p>x</p>'), /nope/), '');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && node --test src/services/htmlExtract.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `server/src/services/htmlExtract.js`:

```js
// Small pure DOM helpers over node-html-parser, shared by the
// governance parsers. The whole point of the MGMT rebuild: find the
// Summary Compensation Table / director table by their header-cell
// SIGNATURE anywhere in the document, so the table-of-contents and
// cross-references (which broke the old flatten-regex approach) are
// irrelevant. Nothing here throws.
import { parse } from 'node-html-parser';

export function parseHtml(html) {
  try {
    return parse(String(html || ''), { lowerCaseTagName: true });
  } catch {
    return parse('');
  }
}

// Decoded, tag-stripped, whitespace-collapsed text of a node.
export function cellText(node) {
  if (!node) return '';
  return String(node.text || '').replace(/\s+/g, ' ').trim();
}

// All rows of a table as arrays of cell text (th or td).
export function tableRows(table) {
  if (!table) return [];
  return table.querySelectorAll('tr').map((tr) =>
    tr.querySelectorAll('th,td').map((c) => cellText(c))
  );
}

// First <table> whose ANY row's cell-text array satisfies `predicate`.
// (SCT/board header rows sometimes use <td>, and may be the 2nd row
// under a group-header row — so we test every row, not just the first.)
export function findTableBySignature(root, predicate) {
  if (!root) return null;
  for (const t of root.querySelectorAll('table')) {
    const rows = tableRows(t);
    if (rows.some((cells) => { try { return predicate(cells); } catch { return false; } })) {
      return t;
    }
  }
  return null;
}

// Given a header row (array of cell text), map logical column → index by
// loose label match. Returns { name, year, salary, bonus, stock,
// option, nonequity, total, age, since, committees, otherboards } with
// any found index (others undefined).
const COL_PATTERNS = {
  name: /name|principal position|director|nominee/i,
  year: /^year$/i,
  salary: /salary/i,
  bonus: /^bonus/i,
  stock: /stock award/i,
  option: /option award/i,
  nonequity: /non-?equity/i,
  total: /^total/i,
  age: /^age$/i,
  since: /director since|^since$|since\b/i,
  committees: /committee/i,
  otherboards: /other.*(public|director|board)|public.*director/i,
};
export function headerMap(headerCells) {
  const out = {};
  (headerCells || []).forEach((txt, i) => {
    for (const [key, re] of Object.entries(COL_PATTERNS)) {
      if (out[key] === undefined && re.test(txt)) out[key] = i;
    }
  });
  return out;
}

// Text content that follows the first heading-ish node matching `re`,
// up to the next heading-ish node. Heading-ish = h1..h6, or a <b>/
// <strong>/<p> whose entire text is short and matches. Best-effort.
export function locateSectionText(root, re) {
  if (!root) return '';
  const HEAD = /^h[1-6]$/;
  const nodes = root.querySelectorAll('*');
  let startIdx = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = String(n.tagName || '').toLowerCase();
    const txt = cellText(n);
    const headish = HEAD.test(tag) || ((tag === 'b' || tag === 'strong' || tag === 'p') && txt.length <= 90);
    if (headish && re.test(txt)) { startIdx = i; break; }
  }
  if (startIdx < 0) return '';
  const parts = [];
  for (let i = startIdx + 1; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = String(n.tagName || '').toLowerCase();
    const txt = cellText(n);
    const headish = HEAD.test(tag) || ((tag === 'b' || tag === 'strong') && txt.length <= 90 && /officers|directors|compensation|proposal|ownership/i.test(txt));
    if (headish && i > startIdx + 1) break;
    if (txt) parts.push(txt);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && node --test src/services/htmlExtract.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasseirer/Desktop/gcig-app
git add server/src/services/htmlExtract.js server/src/services/htmlExtract.test.js
git commit -m "feat(mgmt): node-html-parser DOM helpers (signature table find, section locate)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `parseComp` structure-aware

**Files:**
- Modify: `server/src/services/governanceParsers.js`, `server/src/services/governanceParsers.test.js`

- [ ] **Step 1: Replace the parseComp section of the test file**

In `server/src/services/governanceParsers.test.js`, the import line currently imports the parsers from `./governanceParsers.js`. Keep `buildNetwork` tests as-is. Replace the `parseComp` tests (the `COMP_SECTION` const and its two `test(...)` blocks) with:

```js
const COMP_HTML = `<html><body>
<div>TABLE OF CONTENTS Executive Compensation ... 50 Summary Compensation Table ... 64</div>
<h3>Summary Compensation Table</h3>
<table>
 <tr><td>Name and Principal Position</td><td>Year</td><td>Salary ($)</td><td>Bonus ($)</td><td>Stock Awards ($)</td><td>Option Awards ($)</td><td>Non-Equity ($)</td><td>Total ($)</td></tr>
 <tr><td>Jane A. Doe<br>Chief Executive Officer</td><td>2025</td><td>1,000,000</td><td>0</td><td>5,000,000</td><td>3,000,000</td><td>1,000,000</td><td>10,000,000</td></tr>
 <tr><td>John B. Smith<br>Chief Financial Officer</td><td>2025</td><td>600,000</td><td>0</td><td>1,400,000</td><td>0</td><td>0</td><td>2,000,000</td></tr>
</table></body></html>`;

test('parseComp finds the SCT by header signature and derives pay mix', () => {
  const { rows } = parseComp(COMP_HTML);
  const jane = rows.find((r) => /Jane A\. Doe/.test(r.name));
  assert.ok(jane, 'Jane row parsed');
  assert.equal(jane.total, 10000000);
  assert.equal(jane.salaryPct, 10);
  assert.equal(jane.stockPct, 50);
  assert.equal(jane.optionPct, 30);
  assert.equal(jane.otherPct, 10);
  assert.match(jane.title, /Chief Executive Officer/);
});

test('parseComp empty/garbage → { rows: [] } (never throws)', () => {
  assert.deepEqual(parseComp(''), { rows: [] });
  assert.deepEqual(parseComp('<p>no table here</p>'), { rows: [] });
  assert.deepEqual(parseComp(null), { rows: [] });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: FAIL (parseComp signature changed / not yet structure-aware).

- [ ] **Step 3: Rewrite parseComp in `governanceParsers.js`**

At the top of `server/src/services/governanceParsers.js` add the import (with any existing imports):

```js
import { parseHtml, tableRows, findTableBySignature, headerMap, locateSectionText } from './htmlExtract.js';
```

Replace the existing `parseComp` (and its `NUM`/`COMP_ROW_RE` helpers) with:

```js
const toNum = (s) => {
  const n = Number(String(s == null ? '' : s).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Summary Compensation Table, found by header signature anywhere in the
// DOM (TOC-proof). Columns are read by header index, not position, so
// extra/blank columns don't misalign the mix.
export function parseComp(html) {
  const root = parseHtml(html);
  const table = findTableBySignature(root, (cells) => {
    const j = cells.join(' | ').toLowerCase();
    return /salary/.test(j) && /\btotal\b/.test(j) &&
      [/bonus/, /stock award/, /option award/, /non-?equity/].filter((re) => re.test(j)).length >= 2;
  });
  if (!table) return { rows: [] };
  const all = tableRows(table);
  const hIdx = all.findIndex((cells) => {
    const j = cells.join(' | ').toLowerCase();
    return /salary/.test(j) && /\btotal\b/.test(j);
  });
  if (hIdx < 0) return { rows: [] };
  const h = headerMap(all[hIdx]);
  if (h.name === undefined || h.total === undefined) return { rows: [] };

  const rows = [];
  const seen = new Set();
  for (let i = hIdx + 1; i < all.length; i++) {
    const c = all[i];
    const nameCell = (c[h.name] || '').trim();
    if (!nameCell || /^name|director|^total$/i.test(nameCell)) continue;
    const total = toNum(c[h.total]);
    if (!total) continue;
    // "Jane A. Doe Chief Executive Officer" → name + title split.
    const m = nameCell.match(/^(.*?)(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman|Chief Executive Officer)\b.*$/);
    const name = (m ? m[1] : nameCell).replace(/\s+/g, ' ').trim().replace(/[,;]$/, '');
    const title = m ? m[2].trim() : '';
    if (seen.has(name)) continue; // first (latest year) row per officer
    seen.add(name);
    const salary = h.salary !== undefined ? toNum(c[h.salary]) : null;
    const stock = h.stock !== undefined ? toNum(c[h.stock]) : null;
    const option = h.option !== undefined ? toNum(c[h.option]) : null;
    const haveCols = [salary, stock, option].filter((v) => v != null).length >= 2;
    const pct = (v) => (haveCols && v != null ? Math.round((v / total) * 100) : null);
    const otherPct = haveCols
      ? Math.max(0, Math.round(((total - (salary || 0) - (stock || 0) - (option || 0)) / total) * 100))
      : null;
    rows.push({
      name,
      title,
      total,
      salaryPct: pct(salary),
      stockPct: pct(stock),
      optionPct: pct(option),
      otherPct,
    });
  }
  return { rows };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: the two new `parseComp` tests PASS and the unchanged `buildNetwork` tests PASS. (`parseBoard`/`parseLeadership` tests will fail until Tasks 4–5 — that is expected; if the runner aborts on them, temporarily run only the parseComp+buildNetwork tests with `--test-name-pattern` and confirm, then proceed.)

Run (scoped): `cd server && node --test --test-name-pattern="parseComp|buildNetwork" src/services/governanceParsers.test.js`
Expected: those PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasseirer/Desktop/gcig-app
git add server/src/services/governanceParsers.js server/src/services/governanceParsers.test.js
git commit -m "feat(mgmt): structure-aware parseComp (SCT by header signature)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `parseBoard` structure-aware

**Files:**
- Modify: `server/src/services/governanceParsers.js`, `server/src/services/governanceParsers.test.js`

- [ ] **Step 1: Replace the parseBoard tests**

Replace the `BOARD_SECTION` const + its `parseBoard` tests (keep the Irish-name and connector tests' INTENT by folding them into HTML form) with:

```js
const BOARD_HTML = `<html><body>
<div>TABLE OF CONTENTS Election of Directors .... 10</div>
<h2>Election of Directors</h2>
<table>
 <tr><th>Name</th><th>Age</th><th>Director Since</th><th>Committees</th><th>Other Public Company Directorships</th></tr>
 <tr><td>Maria Lopez</td><td>61</td><td>2015</td><td>Audit; Compensation</td><td>Globex Corporation; Initech Inc</td></tr>
 <tr><td>Patrick O'Brien</td><td>58</td><td>2019</td><td>Nominating</td><td>Soylent Corp</td></tr>
</table></body></html>`;

test('parseBoard reads the director table (age, since, committees, other boards)', () => {
  const b = parseBoard(BOARD_HTML);
  const m = b.find((d) => d.name === 'Maria Lopez');
  assert.ok(m);
  assert.equal(m.age, 61);
  assert.equal(m.since, 2015);
  assert.deepEqual(m.committees.sort(), ['Audit', 'Compensation'].sort());
  assert.deepEqual(m.otherBoards.sort(), ['Globex Corporation', 'Initech Inc'].sort());
  const o = b.find((d) => d.name === "Patrick O'Brien");
  assert.ok(o, "Irish surname row parsed");
  assert.equal(o.since, 2019);
});

test('parseBoard empty/garbage → [] (never throws)', () => {
  assert.deepEqual(parseBoard(''), []);
  assert.deepEqual(parseBoard('<p>no table</p>'), []);
  assert.deepEqual(parseBoard(null), []);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && node --test --test-name-pattern="parseBoard" src/services/governanceParsers.test.js`
Expected: FAIL.

- [ ] **Step 3: Rewrite parseBoard**

Replace the existing `parseBoard` (and `COMMITTEES`/`DIR_HEAD_RE`) with:

```js
const COMMITTEE_NAMES = ['Audit', 'Compensation', 'Nominating', 'Governance', 'Risk', 'Finance'];

// Director roster from the nominee/director table, found by a header
// that has Age + a "since"/"director since" column. otherBoards prefers
// a dedicated column; committees from its column or row text. If no
// such table exists, fall back to per-director record blocks in text.
export function parseBoard(html) {
  const root = parseHtml(html);
  const table = findTableBySignature(root, (cells) => {
    const j = cells.join(' | ').toLowerCase();
    return /\bage\b/.test(j) && /(director since|\bsince\b)/.test(j) && /name|director|nominee/.test(j);
  });
  const out = [];
  if (table) {
    const all = tableRows(table);
    const hIdx = all.findIndex((cells) => {
      const j = cells.join(' | ').toLowerCase();
      return /\bage\b/.test(j) && /(director since|\bsince\b)/.test(j);
    });
    if (hIdx < 0) return [];
    const h = headerMap(all[hIdx]);
    if (h.name === undefined || h.age === undefined) return [];
    for (let i = hIdx + 1; i < all.length; i++) {
      const c = all[i];
      const name = (c[h.name] || '').replace(/\s+/g, ' ').trim();
      const age = Number(String(c[h.age] || '').replace(/[^0-9]/g, ''));
      if (!name || !Number.isFinite(age) || age < 18 || age > 100) continue;
      const since =
        h.since !== undefined
          ? Number((String(c[h.since] || '').match(/\b(19|20)\d{2}\b/) || [])[0]) || null
          : null;
      const committees =
        h.committees !== undefined
          ? COMMITTEE_NAMES.filter((cm) => new RegExp(cm, 'i').test(c[h.committees] || ''))
          : COMMITTEE_NAMES.filter((cm) => new RegExp(`${cm}\\s+Committee`, 'i').test(c.join(' ')));
      const otherBoards =
        h.otherboards !== undefined
          ? (c[h.otherboards] || '')
              .split(/;|\band\b|,(?![^()]*\))/)
              .map((s) => s.replace(/\s+/g, ' ').trim().replace(/[.;]$/, ''))
              .filter((s) => s.length > 2 && /^[A-Z]/.test(s) && !/committee|none\b/i.test(s))
          : [];
      out.push({ name, age, since, committees, otherBoards: [...new Set(otherBoards)] });
    }
    if (out.length) return out;
  }
  // Fallback: record blocks in located section text.
  const txt = locateSectionText(root, /election of directors|nominees? for director|board of directors/i) || cellText(root);
  const TOKEN = "[A-Z](?:[a-z][A-Za-z'-]*|'[A-Z][a-z][A-Za-z'-]*)";
  const HEAD = new RegExp(`(${TOKEN}(?:\\s+${TOKEN}){1,3}),\\s*age\\s*(\\d{2})`, 'g');
  const heads = [];
  let m;
  while ((m = HEAD.exec(txt)) !== null) heads.push({ name: m[1].trim(), age: Number(m[2]), at: m.index });
  return heads.map((hd, i) => {
    const w = txt.slice(hd.at, i + 1 < heads.length ? heads[i + 1].at : txt.length);
    const since = (w.match(/(?:director since|since)\s+(?:[A-Za-z]+\s+){0,2}(?:\d{1,2},?\s*)?((?:19|20)\d{2})/i) || [])[1];
    return {
      name: hd.name,
      age: hd.age,
      since: since ? Number(since) : null,
      committees: COMMITTEE_NAMES.filter((cm) => new RegExp(`${cm}\\s+Committee`, 'i').test(w)),
      otherBoards: [],
    };
  });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && node --test --test-name-pattern="parseBoard|buildNetwork" src/services/governanceParsers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasseirer/Desktop/gcig-app
git add server/src/services/governanceParsers.js server/src/services/governanceParsers.test.js
git commit -m "feat(mgmt): structure-aware parseBoard (director table by signature)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `parseLeadership` (DOM-locate + prose, best-effort tier)

**Files:**
- Modify: `server/src/services/governanceParsers.js`, `server/src/services/governanceParsers.test.js`

- [ ] **Step 1: Replace the parseLeadership tests**

Replace the `SECTIONS`/`parseLeadership` tests with:

```js
const LEAD_HTML = `<html><body>
<div>TABLE OF CONTENTS Information about our Executive Officers .... 40</div>
<h2>Information about our Executive Officers</h2>
<p>Jane A. Doe, 54, has served as Chief Executive Officer since 2018. Previously, Ms. Doe was President of Acme Corp.</p>
<p>John B. Smith, 47, has served as Chief Financial Officer since 2021.</p>
<h2>Corporate Governance</h2>
<p>unrelated</p>
</body></html>`;

test('parseLeadership DOM-locates the exec block and parses officers', () => {
  const { ceo, execs } = parseLeadership(LEAD_HTML);
  assert.equal(ceo.name, 'Jane A. Doe');
  assert.match(ceo.title, /Chief Executive Officer/);
  assert.equal(ceo.age, 54);
  assert.equal(ceo.since, 2018);
  assert.ok(execs.some((e) => e.name === 'John B. Smith' && /Chief Financial Officer/.test(e.title)));
  assert.doesNotMatch(JSON.stringify(execs), /unrelated/);
});

test('parseLeadership empty/garbage → {ceo:null,execs:[]} (never throws)', () => {
  assert.deepEqual(parseLeadership(''), { ceo: null, execs: [] });
  assert.deepEqual(parseLeadership('<p>nothing</p>'), { ceo: null, execs: [] });
  assert.deepEqual(parseLeadership(null), { ceo: null, execs: [] });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd server && node --test --test-name-pattern="parseLeadership" src/services/governanceParsers.test.js`
Expected: FAIL.

- [ ] **Step 3: Rewrite parseLeadership**

Replace the existing `parseLeadership` (and its `TITLES`/`TITLE_RE`/`EXEC_RE`/`priorRoles`/`TOKEN` if duplicated — keep ONE shared `TOKEN`) with:

```js
const NAME_TOKEN = "[A-Z](?:[a-z][A-Za-z'-]*|'[A-Z][a-z][A-Za-z'-]*)";
const EXEC_RE = new RegExp(
  `(${NAME_TOKEN}(?:\\s+(?:[A-Z]\\.|${NAME_TOKEN})){1,3}),\\s*(\\d{2}),[^.]*?\\b(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman)\\b(?:[^.]*?since\\s+(?:[A-Za-z]+\\s+){0,2}(?:\\d{1,2},?\\s*)?((?:19|20)\\d{2})|[^.]*)`,
  'g'
);

function priorRoles(text, name) {
  const i = text.indexOf(name);
  if (i < 0) return [];
  const after = text.slice(i, i + 600);
  const out = [];
  const re = /\b(?:prior(?:\sto)?|previously|formerly)\b(?:(?:Ms|Mr|Dr|Jr|Sr)\.|[^.])*?\b(President|Chief [A-Za-z ]+Officer|Partner|Director)\b[^.]*?\bof\s+([A-Z][A-Za-z.,& ]{2,40}?)[.,]/gi;
  let r;
  while ((r = re.exec(after)) !== null && out.length < 3) out.push(`${r[1].trim()}, ${r[2].trim()}`);
  return out;
}

// Best-effort tier: DOM-locate the exec-officers block, prose-parse it.
// (Exec bios are narrative even in well-structured proxies — this is
// inherently lower recall than the table tiers; that is stated in the
// spec and the UI footer, not hidden.)
export function parseLeadership(html) {
  const root = parseHtml(html);
  const text =
    locateSectionText(root, /information about (?:our )?executive officers|executive officers of the (?:company|registrant)|^executive officers$/i) ||
    '';
  const execs = [];
  EXEC_RE.lastIndex = 0;
  let m;
  while ((m = EXEC_RE.exec(text)) !== null) {
    const title = m[3].replace(/\s+/g, ' ').trim();
    execs.push({
      name: m[1].replace(/\s+/g, ' ').trim(),
      title,
      age: m[2] ? Number(m[2]) : null,
      since: m[4] ? Number(m[4]) : null,
      priorRoles: priorRoles(text, m[1]),
      totalComp: null,
    });
  }
  const ceo = execs.find((e) => /chief executive officer/i.test(e.title)) || execs[0] || null;
  return { ceo: ceo || null, execs };
}
```

- [ ] **Step 4: Run — verify pass (whole governanceParsers suite now green)**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: PASS — all parseComp/parseBoard/parseLeadership/buildNetwork tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasseirer/Desktop/gcig-app
git add server/src/services/governanceParsers.js server/src/services/governanceParsers.test.js
git commit -m "feat(mgmt): parseLeadership DOM-locates exec block (best-effort tier)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Route rewire (`html` not `sections`)

**Files:**
- Modify: `server/src/routes/terminal.js`

- [ ] **Step 1: Update the governance handler**

In `server/src/routes/terminal.js`, the `/governance/:ticker` handler currently does `const proxy = await getProxyStatement(raw);` then `parseLeadership(proxy.sections)` / `parseBoard(proxy.sections)` / `parseComp(proxy.sections)`. Change those three calls to pass `proxy.html`:

```js
    const proxy = await getProxyStatement(raw);
    const { ceo, execs } = parseLeadership(proxy.html);
    const board = parseBoard(proxy.html);
    const comp = parseComp(proxy.html);
```

Leave everything else in the handler (holdings fetch, `buildNetwork(raw, board, holdings)`, the `res.json({ ticker: raw, asOf: proxy.filedAt, source: proxy._source, ceo, execs, board, comp, network })`, 400/502, try/catch) exactly as-is. No other route changes.

- [ ] **Step 2: Verify**

Run: `cd server && node --check src/routes/terminal.js && npm test`
Expected: `node --check` exit 0; full suite PASS (proxyStatement + htmlExtract + governanceParsers + insiderTx + auth).

- [ ] **Step 3: Commit**

```bash
cd /Users/thomasseirer/Desktop/gcig-app
git add server/src/routes/terminal.js
git commit -m "feat(mgmt): route passes raw proxy html to the structured parsers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Real-fixture capture + honest live verification

**Files:**
- Create: `server/src/services/__fixtures__/README.md` (provenance note)
- Create: `server/src/services/governanceParsers.realfixture.test.js`

- [ ] **Step 1: Capture real DEF 14A excerpts (run once, commit the output)**

Run this capture script (writes trimmed real HTML — the SCT + director table + exec block — for three structurally different filers):

```bash
cd /Users/thomasseirer/Desktop/gcig-app/server && node -e "
import('./src/services/proxyStatement.js').then(async (m) => {
  const { parseHtml } = await import('./src/services/htmlExtract.js');
  const fs = await import('node:fs');
  fs.mkdirSync('src/services/__fixtures__', { recursive: true });
  for (const t of ['AAPL','AMZN','KO']) {
    const p = await m.getProxyStatement(t);
    if (p._source !== 'sec' || !p.html) { console.log(t,'NO PROXY (SEC throttle?) — skip'); continue; }
    // Keep raw html but trim to <= 2MB to bound repo size; structure preserved.
    const html = p.html.slice(0, 2 * 1024 * 1024);
    fs.writeFileSync('src/services/__fixtures__/'+t+'-def14a.html', html);
    console.log(t, 'fixture', html.length, 'bytes, filed', p.filedAt);
  }
});
"
```
Expected: writes `AAPL-def14a.html` / `AMZN-def14a.html` / `KO-def14a.html` (each filer that SEC served). If SEC throttles a filer this run, re-run ≤2×; commit whichever captured. At least ONE large-cap fixture is required to proceed.

Create `server/src/services/__fixtures__/README.md`:
```
Real SEC DEF 14A HTML excerpts (raw primary doc, trimmed to <=2MB),
captured via getProxyStatement for regression tests. Provenance: SEC
EDGAR, public filings. Regenerate with the Task 7 capture script.
```

- [ ] **Step 2: Write the real-fixture regression test**

Create `server/src/services/governanceParsers.realfixture.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComp, parseBoard, parseLeadership } from './governanceParsers.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('-def14a.html')) : [];

test('real fixtures exist (at least one large-cap)', () => {
  assert.ok(files.length >= 1, 'capture at least one real DEF 14A fixture (Task 7 Step 1)');
});

for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  test(`${f}: structure-aware extractors return plausible data, never throw`, () => {
    const comp = parseComp(html);
    const board = parseBoard(html);
    const lead = parseLeadership(html);
    // Comp + Board are the high-confidence tiers — at least ONE must
    // yield real rows for a major-filer proxy, or the structure-aware
    // approach has not actually solved the problem.
    const compOk = comp.rows.length > 0 && comp.rows.every((r) => r.total > 0);
    const boardOk = board.length > 0 && board.every((d) => d.age >= 18 && d.age <= 100);
    assert.ok(
      compOk || boardOk,
      `${f}: expected real Comp rows or Board directors (comp=${comp.rows.length}, board=${board.length})`
    );
    // Never-throws / shape sanity for all three.
    assert.equal(typeof (lead.ceo === null || lead.ceo.name), lead.ceo === null ? 'boolean' : 'string');
    assert.ok(Array.isArray(lead.execs) && Array.isArray(board));
  });
}
```

- [ ] **Step 3: Run the real-fixture test**

Run: `cd server && node --test src/services/governanceParsers.realfixture.test.js`
Expected: PASS. If it FAILS (Comp and Board both empty on a real large-cap fixture), the structure-aware approach has not solved the problem on that filer — **STOP, do not paper over it**, report the fixture + the actual `comp.rows`/`board` output for diagnosis (this is the honest go/no-go gate for the whole rebuild).

- [ ] **Step 4: Full suite + live smoke (honest)**

Run: `cd server && npm test`
Expected: ALL pass.

Run the live smoke and report raw output honestly:
```bash
cd /Users/thomasseirer/Desktop/gcig-app/server && node -e "
import('./src/services/proxyStatement.js').then(async(pm)=>{const gp=await import('./src/services/governanceParsers.js');for(const t of ['AAPL','AMZN','KO']){const p=await pm.getProxyStatement(t);const C=gp.parseComp(p.html);const B=gp.parseBoard(p.html);const L=gp.parseLeadership(p.html);console.log(t,JSON.stringify({src:p._source,filedAt:p.filedAt,compRows:C.rows.length,compSample:C.rows[0]||null,board:B.length,boardSample:B[0]||null,ceo:L.ceo&&L.ceo.name}))}})"
```
Report the raw JSON. Honest interpretation: `compRows>0`/`board>0` for AAPL/AMZN/KO ⇒ the rebuild works on real large-caps (the whole point). `src:null` for a ticker ⇒ SEC throttled that run (note it; the committed fixtures still prove the parsers). State plainly which tiers populated vs. empty; Leadership is best-effort and may be sparse — do not overclaim.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasseirer/Desktop/gcig-app
git add server/src/services/__fixtures__ server/src/services/governanceParsers.realfixture.test.js
git commit -m "test(mgmt): real DEF 14A fixtures + structure-aware recall gate

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- node-html-parser dep added → Task 1. ✓
- proxyStatement returns raw html, drops htmlToText/splitSections, size cap, never-throws, cache, SEC_UA, pickLatestDef14A → Task 1. ✓
- DOM helpers (signature table find, header map, section locate) → Task 2. ✓
- parseComp structure-aware (SCT by header signature, header-indexed columns, residual otherPct, null-on-uncertain) → Task 3. ✓
- parseBoard structure-aware (director table by Age+Since signature; otherBoards column-preferred; committees; text-record fallback incl. Irish-name token) → Task 4. ✓
- parseLeadership DOM-locate + prose best-effort tier → Task 5. ✓
- buildNetwork unchanged (its tests untouched in Tasks 3–5) ✓; route payload/client unchanged → Task 6. ✓
- Real-fixture capture + honest recall gate + live smoke + honest caveat → Task 7. ✓
- Never-throws across all parsers: explicit empty/garbage/null tests in Tasks 3/4/5; `parseHtml`/helpers guarded in Task 2. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step has complete code; commands have expected output. Task 7's fixture *content* is real-data captured at build (not embeddable verbatim by definition) — the capture script + structural (not value-specific) assertions are complete and deterministic against the committed file; this is the correct way to test real HTML and is not a placeholder.

**3. Type consistency:** `parse*(html: string)` signatures consistent across Tasks 3–6 and the route. Payload `{ticker,asOf,source,ceo,execs,board,comp,network}` unchanged (Task 6) and matches the existing client. Helper names (`parseHtml`,`cellText`,`tableRows`,`findTableBySignature`,`headerMap`,`locateSectionText`) defined in Task 2 and used identically in Tasks 3–5. `comp.rows[]` shape `{name,title,total,salaryPct,stockPct,optionPct,otherPct}` and `board[]` `{name,age,since,committees,otherBoards}` match what the shipped `Governance.jsx` renders. `getProxyStatement` returns `.html` (Task 1) consumed in Task 6. No drift.

No issues found.
