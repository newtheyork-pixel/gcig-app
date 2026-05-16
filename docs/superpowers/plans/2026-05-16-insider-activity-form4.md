# INSDR Insider Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `INSDR`, a terminal function that overlays insider open-market Form 4 buys/sells on the price chart with a transaction table and AI brief.

**Architecture:** A never-throwing server service `insiderTx.js` (pure helpers + an orchestrator that tries Finnhub then falls back to parsing SEC EDGAR Form 4 XML, with a 20-min cache), exposed via one auth-gated terminal route, consumed by a Recharts `ComposedChart` client panel.

**Tech Stack:** Node ESM, `node:test`/`node:assert/strict`, Express (existing `routes/terminal.js`), React + Recharts (already deps), Vite build for client verification.

---

## File Structure

- **Create** `server/src/services/insiderTx.js` — Form 4 fetch + normalize. Pure helpers (`classifyCode`, `normalizeFinnhub`, `parseForm4Xml`, `roleFromRelationship`) plus orchestrator `getInsiderTransactions` with injectable fetchers + cache.
- **Create** `server/src/services/insiderTx.test.js` — unit tests for the pure helpers and the fallback orchestration (no network — injected fake fetchers).
- **Modify** `server/src/routes/terminal.js` — add `INSDR` to `KNOWN_FUNCTIONS`; add `GET /api/terminal/insiders/:ticker`.
- **Create** `client/src/terminal/functions/InsiderActivity.jsx` — the panel.
- **Modify** `client/src/terminal/registry.js` — import + register `INSDR`.
- **Modify** `client/src/terminal/theme.css` — scoped marker legend / table styles.

Conventions (from existing code): server tests are colocated `*.test.js`, run by `node --test`. Comments are editorial, explain *why*. The service must never throw (same contract as `services/worldIndices.js`).

---

## Task 1: Pure helpers — code classification + Finnhub normalizer

**Files:**
- Create: `server/src/services/insiderTx.js`
- Test: `server/src/services/insiderTx.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/insiderTx.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCode, normalizeFinnhub } from './insiderTx.js';

test('classifyCode flags only open-market P and S', () => {
  assert.deepEqual(classifyCode('P'), { isBuy: true, isSell: false });
  assert.deepEqual(classifyCode('S'), { isBuy: false, isSell: true });
  for (const c of ['A', 'M', 'F', 'G', 'D', '', null, undefined]) {
    assert.deepEqual(classifyCode(c), { isBuy: false, isSell: false });
  }
});

test('normalizeFinnhub maps rows, derives value, sorts date-desc', () => {
  const rows = normalizeFinnhub([
    { name: 'Old Buyer', transactionDate: '2025-01-02', transactionCode: 'P', change: 100, transactionPrice: 10 },
    { name: 'New Seller', transactionDate: '2026-03-04', transactionCode: 'S', change: -50, transactionPrice: 20 },
    { name: 'No Price', transactionDate: '2026-02-01', transactionCode: 'P', change: 5, transactionPrice: 0 },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'New Seller');           // newest first
  assert.equal(rows[0].isSell, true);
  assert.equal(rows[0].shares, 50);                   // abs(change)
  assert.equal(rows[0].value, 1000);                  // 50 * 20
  assert.equal(rows[2].name, 'Old Buyer');
  assert.equal(rows[1].value, null);                  // price 0 -> null value
  assert.equal(rows[0].role, null);                   // Finnhub has no relationship
});

test('normalizeFinnhub tolerates empty / non-array', () => {
  assert.deepEqual(normalizeFinnhub(null), []);
  assert.deepEqual(normalizeFinnhub(undefined), []);
  assert.deepEqual(normalizeFinnhub([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/insiderTx.test.js`
Expected: FAIL — `Cannot find module './insiderTx.js'` / export not found.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/insiderTx.js`:

```js
// INSDR data — insider Form 4 activity. Finnhub is the primary feed
// (structured, already wired); SEC EDGAR Form 4 XML is the fallback so
// a missing/throttled Finnhub ticker still resolves. Best-effort and
// never throws — same contract as services/worldIndices.js.

// Form 4 transaction codes: only open-market Purchase / Sale carry the
// signal we plot. Everything else (M exercise, A grant, F tax, G gift,
// …) is fetched and tabled but never charted.
export function classifyCode(code) {
  const c = String(code || '').toUpperCase();
  return { isBuy: c === 'P', isSell: c === 'S' };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Finnhub /stock/insider-transactions rows: { name, transactionDate,
// filingDate, transactionCode, change (signed share delta),
// transactionPrice }. No relationship block, so role is null here.
export function normalizeFinnhub(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      const code = String(r?.transactionCode || '').toUpperCase();
      const { isBuy, isSell } = classifyCode(code);
      const shares = r?.change == null ? null : Math.abs(num(r.change));
      const price = num(r?.transactionPrice) || null;
      const value = shares != null && price ? shares * price : null;
      return {
        date: r?.transactionDate || r?.filingDate || null,
        name: r?.name || 'Unknown',
        role: null,
        code,
        isBuy,
        isSell,
        shares,
        price,
        value,
      };
    })
    .filter((t) => t.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/insiderTx.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/insiderTx.js server/src/services/insiderTx.test.js
git commit -m "feat(insider): Form 4 code classification + Finnhub normalizer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SEC Form 4 XML parser

**Files:**
- Modify: `server/src/services/insiderTx.js`
- Test: `server/src/services/insiderTx.test.js`

- [ ] **Step 1: Write the failing test** (append to `insiderTx.test.js`)

```js
import { parseForm4Xml, roleFromRelationship } from './insiderTx.js';

const FORM4_FIXTURE = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Huang Jen-Hsun</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>President and CEO</officerTitle>
      <isTenPercentOwner>0</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-14</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100000</value></transactionShares>
        <transactionPricePerShare><value>123.45</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>2000</value></transactionShares>
        <transactionPricePerShare><value>120.00</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

test('roleFromRelationship prefers officer title, then director, then 10%', () => {
  assert.equal(
    roleFromRelationship('<isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle>'),
    'CFO'
  );
  assert.equal(roleFromRelationship('<isDirector>1</isDirector><isOfficer>0</isOfficer>'), 'Director');
  assert.equal(roleFromRelationship('<isTenPercentOwner>1</isTenPercentOwner>'), '10% Owner');
  assert.equal(roleFromRelationship('<isOfficer>1</isOfficer>'), 'Officer');
  assert.equal(roleFromRelationship(''), null);
});

test('parseForm4Xml extracts owner, role, and each transaction', () => {
  const rows = parseForm4Xml(FORM4_FIXTURE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Huang Jen-Hsun');
  assert.equal(rows[0].role, 'President and CEO');
  assert.equal(rows[0].date, '2026-05-14');
  assert.equal(rows[0].code, 'S');
  assert.equal(rows[0].isSell, true);
  assert.equal(rows[0].shares, 100000);
  assert.equal(rows[0].price, 123.45);
  assert.equal(rows[0].value, 12345000);
  assert.equal(rows[1].code, 'P');
  assert.equal(rows[1].isBuy, true);
});

test('parseForm4Xml returns [] on garbage', () => {
  assert.deepEqual(parseForm4Xml('not xml'), []);
  assert.deepEqual(parseForm4Xml(''), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/insiderTx.test.js`
Expected: FAIL — `parseForm4Xml`/`roleFromRelationship` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `insiderTx.js`)

```js
// SEC Form 4 ownership XML is small and schema-stable; targeted regex
// extraction avoids adding an XML-parser dependency. We only need a
// handful of fields and treat anything missing as absent.
function tagVal(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

// <foo><value>X</value></foo> — SEC wraps transaction fields in <value>.
function valueOf(block, tag) {
  const outer = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!outer) return null;
  const inner = outer[1].match(/<value>([\s\S]*?)<\/value>/i);
  return (inner ? inner[1] : outer[1]).trim() || null;
}

export function roleFromRelationship(relXml) {
  const x = String(relXml || '');
  const title = (x.match(/<officerTitle>([\s\S]*?)<\/officerTitle>/i) || [])[1];
  if (title && title.trim()) return title.trim();
  if (/<isDirector>\s*(1|true)\s*<\/isDirector>/i.test(x)) return 'Director';
  if (/<isTenPercentOwner>\s*(1|true)\s*<\/isTenPercentOwner>/i.test(x)) return '10% Owner';
  if (/<isOfficer>\s*(1|true)\s*<\/isOfficer>/i.test(x)) return 'Officer';
  return null;
}

export function parseForm4Xml(xml) {
  const doc = String(xml || '');
  if (!/<ownershipDocument/i.test(doc)) return [];
  const name =
    (doc.match(/<rptOwnerName>([\s\S]*?)<\/rptOwnerName>/i) || [])[1]?.trim() ||
    'Unknown';
  const rel = (doc.match(/<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/i) || [])[1] || '';
  const role = roleFromRelationship(rel);

  const out = [];
  const txBlocks = doc.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || [];
  for (const block of txBlocks) {
    const date = valueOf(block, 'transactionDate');
    const code = String(tagVal(block, 'transactionCode') || '').toUpperCase();
    const sharesRaw = valueOf(block, 'transactionShares');
    const priceRaw = valueOf(block, 'transactionPricePerShare');
    if (!date) continue;
    const shares = Number.isFinite(Number(sharesRaw)) ? Number(sharesRaw) : null;
    const price = Number.isFinite(Number(priceRaw)) && Number(priceRaw) > 0 ? Number(priceRaw) : null;
    const { isBuy, isSell } = classifyCode(code);
    out.push({
      date,
      name,
      role,
      code,
      isBuy,
      isSell,
      shares,
      price,
      value: shares != null && price ? shares * price : null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/insiderTx.test.js`
Expected: PASS — all Task 1 + Task 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/insiderTx.js server/src/services/insiderTx.test.js
git commit -m "feat(insider): SEC Form 4 XML parser + role extraction

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Orchestrator — Finnhub→SEC fallback + cache (injectable, no network in tests)

**Files:**
- Modify: `server/src/services/insiderTx.js`
- Test: `server/src/services/insiderTx.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { getInsiderTransactions, _resetInsiderCache } from './insiderTx.js';

test('getInsiderTransactions returns Finnhub data when present', async () => {
  _resetInsiderCache();
  const res = await getInsiderTransactions('NVDA', {
    finnhubFetch: async () => [
      { name: 'A', transactionDate: '2026-05-01', transactionCode: 'P', change: 10, transactionPrice: 5 },
    ],
    secFetch: async () => { throw new Error('should not be called'); },
  });
  assert.equal(res._source, 'finnhub');
  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].name, 'A');
});

test('getInsiderTransactions falls back to SEC when Finnhub empty', async () => {
  _resetInsiderCache();
  const res = await getInsiderTransactions('NVDA', {
    finnhubFetch: async () => [],
    secFetch: async () => [
      { date: '2026-04-01', name: 'B', role: 'CEO', code: 'S', isBuy: false, isSell: true, shares: 1, price: 2, value: 2 },
    ],
  });
  assert.equal(res._source, 'sec');
  assert.equal(res.transactions[0].name, 'B');
});

test('getInsiderTransactions returns empty (never throws) when both fail', async () => {
  _resetInsiderCache();
  const res = await getInsiderTransactions('NVDA', {
    finnhubFetch: async () => { throw new Error('finnhub down'); },
    secFetch: async () => { throw new Error('sec down'); },
  });
  assert.equal(res._source, null);
  assert.deepEqual(res.transactions, []);
});

test('getInsiderTransactions caches within TTL', async () => {
  _resetInsiderCache();
  let calls = 0;
  const opts = {
    finnhubFetch: async () => { calls++; return [{ name: 'C', transactionDate: '2026-01-01', transactionCode: 'P', change: 1, transactionPrice: 1 }]; },
    secFetch: async () => [],
  };
  await getInsiderTransactions('AAPL', opts);
  await getInsiderTransactions('AAPL', opts);
  assert.equal(calls, 1); // second call served from cache
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/insiderTx.test.js`
Expected: FAIL — `getInsiderTransactions`/`_resetInsiderCache` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `insiderTx.js`)

```js
import { getRecentFilings } from './secFilings.js';

const CACHE_TTL_MS = 20 * 60 * 1000;
const cache = new Map(); // TICKER -> { at, payload }

export function _resetInsiderCache() {
  cache.clear();
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ~24 months back, ISO yyyy-mm-dd, the window Finnhub wants.
function windowDates() {
  const to = new Date();
  const from = new Date(to.getTime() - 730 * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

async function defaultFinnhubFetch(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];
  const { from, to } = windowDates();
  const url =
    `https://finnhub.io/api/v1/stock/insider-transactions` +
    `?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${key}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.data) ? j.data : [];
}

// Best-effort SEC backfill: list recent filings, keep Form 4s, fetch
// and parse each ownership doc. Capped by getRecentFilings' own ceiling
// (25) — fine for a fallback; Finnhub covers depth on the hot path.
async function defaultSecFetch(ticker) {
  const filings = await getRecentFilings(ticker, { limit: 25 });
  const form4 = filings.filter((f) => String(f.form) === '4' && f.url);
  const all = [];
  for (const f of form4) {
    try {
      const r = await fetch(f.url, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' } });
      if (!r.ok) continue;
      all.push(...parseForm4Xml(await r.text()));
    } catch {
      // skip a bad doc; the rest still render
    }
  }
  return all;
}

// Returns { ticker, transactions: [...desc], _source: 'finnhub'|'sec'|null }.
// Never throws. `deps` lets tests inject fetchers (no network).
export async function getInsiderTransactions(ticker, deps = {}) {
  const sym = String(ticker || '').toUpperCase();
  if (!sym) return { ticker: sym, transactions: [], _source: null };

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const finnhubFetch = deps.finnhubFetch || defaultFinnhubFetch;
  const secFetch = deps.secFetch || defaultSecFetch;

  let transactions = [];
  let source = null;

  try {
    const raw = await finnhubFetch(sym);
    const norm = normalizeFinnhub(raw);
    if (norm.length > 0) {
      transactions = norm;
      source = 'finnhub';
    }
  } catch (err) {
    console.warn(`insiderTx finnhub(${sym}) failed:`, err.message);
  }

  if (source === null) {
    try {
      const sec = await secFetch(sym);
      const norm = Array.isArray(sec)
        ? sec
            .filter((t) => t && t.date)
            .sort((a, b) => new Date(b.date) - new Date(a.date))
        : [];
      if (norm.length > 0) {
        transactions = norm;
        source = 'sec';
      }
    } catch (err) {
      console.warn(`insiderTx sec(${sym}) failed:`, err.message);
    }
  }

  const payload = { ticker: sym, transactions, _source: source };
  cache.set(sym, { at: Date.now(), payload });
  return payload;
}
```

Note: the `import { getRecentFilings }` line must sit with the other imports at the top of the file when implementing — move it up rather than mid-file. (`classifyCode` is already defined above; reused here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/insiderTx.test.js`
Expected: PASS — all tests across Tasks 1–3.

- [ ] **Step 5: Run the full server test suite (no regressions)**

Run: `cd server && npm test`
Expected: PASS — existing `auth.test.js` plus the new `insiderTx.test.js`.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/insiderTx.js server/src/services/insiderTx.test.js
git commit -m "feat(insider): orchestrator with Finnhub->SEC fallback and cache

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Server route + KNOWN_FUNCTIONS

**Files:**
- Modify: `server/src/routes/terminal.js` (imports near top; `KNOWN_FUNCTIONS` array; new route beside `GET /chart/:ticker`)

- [ ] **Step 1: Add the import**

At the top of `server/src/routes/terminal.js`, with the other service imports, add:

```js
import { getInsiderTransactions } from '../services/insiderTx.js';
```

- [ ] **Step 2: Register the function for the AI layer**

In the `KNOWN_FUNCTIONS` array in `server/src/routes/terminal.js`, add this entry (place it after the `PEER` entry):

```js
  { id: 'INSDR', label: 'Insider Activity', summary: 'Form 4 insider buys/sells overlaid on the price chart.' },
```

- [ ] **Step 3: Add the route**

Immediately after the existing `router.get('/chart/:ticker', …)` handler in `server/src/routes/terminal.js`, add:

```js
// INSDR — insider Form 4 activity for a ticker. Service is best-effort
// (Finnhub primary, SEC EDGAR fallback) and never throws; an empty
// result is a normal 200 so the panel can say "no activity".
router.get('/insiders/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const data = await getInsiderTransactions(raw);
    res.json(data);
  } catch (err) {
    console.error(`terminal/insiders(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Insider data unavailable' });
  }
});
```

- [ ] **Step 4: Verify syntax and no test regressions**

Run: `cd server && node --check src/routes/terminal.js && npm test`
Expected: `node --check` silent (exit 0); `npm test` PASS (auth + insiderTx suites).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/terminal.js
git commit -m "feat(insider): GET /api/terminal/insiders/:ticker + INSDR in KNOWN_FUNCTIONS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Client panel + registry + styles

**Files:**
- Create: `client/src/terminal/functions/InsiderActivity.jsx`
- Modify: `client/src/terminal/registry.js`
- Modify: `client/src/terminal/theme.css`

- [ ] **Step 1: Create the panel**

Create `client/src/terminal/functions/InsiderActivity.jsx`:

```jsx
import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import api from '../../api/client.js';

// INSDR — insider Form 4 activity overlaid on the 1y price line.
// Only open-market P (buy) / S (sell) are plotted; the table can show
// every code via the toggle. Reuses /terminal/chart for the price line.

const fmtMoney = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtNum = (v) =>
  v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString();
const fmtDate = (d) => {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime())
    ? '—'
    : `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${String(dt.getFullYear()).slice(2)}`;
};

// Snap a transaction date to the close of the nearest prior trading
// day in the price series so the marker sits on the line.
function priceAt(points, ts) {
  if (!points.length) return null;
  let best = null;
  for (const p of points) {
    if (p.t <= ts) best = p;
    else break;
  }
  return (best || points[0]).close;
}

const Triangle = ({ cx, cy, fill, up }) => {
  if (cx == null || cy == null) return null;
  const s = 5;
  const pts = up
    ? `${cx},${cy - s} ${cx - s},${cy + s} ${cx + s},${cy + s}`
    : `${cx},${cy + s} ${cx - s},${cy - s} ${cx + s},${cy - s}`;
  return <polygon points={pts} fill={fill} stroke="#000" strokeWidth={0.5} />;
};

export default function InsiderActivity({ ticker }) {
  const [points, setPoints] = useState([]);
  const [tx, setTx] = useState([]);
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setPoints([]);
    setTx([]);
    setBrief('');
    Promise.allSettled([
      api.get(`/terminal/chart/${encodeURIComponent(ticker)}`, {
        params: { range: '1y', interval: '1d' },
      }),
      api.get(`/terminal/insiders/${encodeURIComponent(ticker)}`),
    ])
      .then(([chartRes, insRes]) => {
        if (cancelled) return;
        if (chartRes.status === 'fulfilled') {
          setPoints(
            Array.isArray(chartRes.value.data?.points)
              ? chartRes.value.data.points
              : []
          );
        }
        if (insRes.status === 'fulfilled') {
          setTx(insRes.value.data?.transactions || []);
          setSource(insRes.value.data?._source || null);
        } else {
          setErr('Insider data unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const { buys, sells } = useMemo(() => {
    const b = [];
    const s = [];
    for (const t of tx) {
      const ts = new Date(t.date).getTime();
      if (Number.isNaN(ts)) continue;
      const y = priceAt(points, ts);
      if (y == null) continue;
      if (t.isBuy) b.push({ t: ts, y, _tx: t });
      else if (t.isSell) s.push({ t: ts, y, _tx: t });
    }
    return { buys: b, sells: s };
  }, [tx, points]);

  const tableRows = useMemo(
    () => (openOnly ? tx.filter((t) => t.isBuy || t.isSell) : tx),
    [tx, openOnly]
  );

  useEffect(() => {
    if (!ticker || tx.length === 0) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = tx
      .slice(0, 15)
      .map(
        (t) =>
          `${fmtDate(t.date)} ${t.name} (${t.role || '—'}) ${t.code} ` +
          `${fmtNum(t.shares)} @ ${t.price ?? '—'} = ${fmtMoney(t.value)}`
      )
      .join('\n');
    api
      .post('/terminal/annotate', { ticker, function: 'INSDR', context })
      .then(({ data }) => {
        if (!cancelled) setBrief(data.brief || '');
      })
      .catch(() => {
        if (!cancelled) setBrief('');
      })
      .finally(() => {
        if (!cancelled) setBriefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tx, ticker]);

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load insider activity.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading insider activity…</div>
      </div>
    );
  }

  const TxTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const t = payload[0]?.payload?._tx;
    if (!t) return null;
    return (
      <div
        style={{
          background: 'var(--term-bg-panel)',
          border: '1px solid var(--term-border)',
          color: 'var(--term-fg)',
          fontSize: 11,
          padding: '6px 8px',
        }}
      >
        <div>{fmtDate(t.date)} · {t.code} {t.isBuy ? 'BUY' : 'SELL'}</div>
        <div>{t.name}{t.role ? ` · ${t.role}` : ''}</div>
        <div>{fmtNum(t.shares)} @ {t.price ?? '—'} = {fmtMoney(t.value)}</div>
      </div>
    );
  };

  return (
    <div className="term-panel" style={{ height: '100%' }}>
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Insider Activity · Form 4</span>
        {source && (
          <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
            {source === 'sec' ? 'SEC EDGAR' : 'Finnhub'}
          </span>
        )}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {points.length === 0 ? (
        <div className="term-loading">Price history unavailable — table only.</div>
      ) : (
        <div className="term-chart" style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) => new Date(t).toLocaleString('en', { month: 'short' })}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
                width={48}
              />
              <Tooltip content={<TxTooltip />} />
              <Line
                type="monotone"
                dataKey="close"
                stroke="var(--term-fg)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Scatter
                data={buys}
                dataKey="y"
                isAnimationActive={false}
                shape={(p) => <Triangle {...p} up fill="var(--term-positive)" />}
              />
              <Scatter
                data={sells}
                dataKey="y"
                isAnimationActive={false}
                shape={(p) => <Triangle {...p} fill="var(--term-negative)" />}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11 }}>
        <span style={{ color: 'var(--term-positive)' }}>▲ buy</span>
        <span style={{ color: 'var(--term-negative)' }}>▼ sell</span>
        <button
          onClick={() => setOpenOnly((v) => !v)}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            color: 'var(--term-fg-dim)',
            border: '1px solid var(--term-border)',
            font: 'inherit',
            fontSize: 11,
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {openOnly ? 'Open-market only' : 'All codes'}
        </button>
      </div>

      {tableRows.length === 0 ? (
        <div className="term-loading">No Form 4 activity in the last 24 months.</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Insider</th>
              <th>Role</th>
              <th>TX</th>
              <th className="num">Shares</th>
              <th className="num">Price</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((t, i) => (
              <tr key={`${t.date}-${t.name}-${i}`}>
                <td>{fmtDate(t.date)}</td>
                <td className="sym">{t.name}</td>
                <td>{t.role || '—'}</td>
                <td className={t.isBuy ? 'num pos' : t.isSell ? 'num neg' : 'num'}>
                  {t.code}
                </td>
                <td className="num">{fmtNum(t.shares)}</td>
                <td className="num">{t.price == null ? '—' : Number(t.price).toFixed(2)}</td>
                <td className="num">{fmtMoney(t.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Open-market P/S plotted; M/A/F/G shown in the table only. 20-min cache.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the function**

In `client/src/terminal/registry.js`, add the import beside the other function imports:

```js
import InsiderActivity from './functions/InsiderActivity.jsx';
```

And add this entry to the `FUNCTIONS` array (after the `PEER` entry):

```js
  { id: 'INSDR', label: 'Insider Activity', help: 'Form 4 insider buys/sells on the price chart.', requires: 'ticker', component: InsiderActivity },
```

- [ ] **Step 3: Add scoped styles**

Append to `client/src/terminal/theme.css` (before the `/* BI (chat) panel */` block, alongside the other table styles):

```css
/* INSDR — keep the marker legend tidy; table reuses .term-table */
[data-theme='terminal'] .term-chart polygon {
  pointer-events: all;
}
```

- [ ] **Step 4: Verify the client builds**

Run: `cd client && npm run build`
Expected: `✓ built` with no errors (warnings about chunk size are pre-existing and acceptable).

- [ ] **Step 5: Commit**

```bash
git add client/src/terminal/functions/InsiderActivity.jsx client/src/terminal/registry.js client/src/terminal/theme.css
git commit -m "feat(insider): INSDR panel — Form 4 markers on price chart + table

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Integration verification + honest caveats

**Files:** none (verification only)

- [ ] **Step 1: Full server suite + syntax**

Run: `cd server && npm test && node --check src/routes/terminal.js && node --check src/services/insiderTx.js`
Expected: all tests PASS, both `node --check` exit 0.

- [ ] **Step 2: SEC fallback smoke test (no key needed)**

Run:
```bash
cd server && node -e "import('./src/services/insiderTx.js').then(async m=>{const r=await m.getInsiderTransactions('AAPL');console.log(r._source, r.transactions.length, r.transactions[0]||'(none)')})"
```
Expected: `_source` is `sec` (no `FINNHUB_API_KEY` locally → Finnhub returns []) with a non-zero transaction count for a liquid name like AAPL, or `null`/0 if SEC EDGAR rate-limited the run (acceptable — log it honestly, do not claim success if 0).

- [ ] **Step 3: Client build**

Run: `cd client && npm run build`
Expected: `✓ built`.

- [ ] **Step 4: Record the honest verification status**

In the final summary to the user, state plainly: server unit tests pass; SEC-fallback path verified locally; **the Finnhub primary path requires `FINNHUB_API_KEY` and is only verifiable on Render** (same limitation pattern as the WEI work) — do not assert it works end-to-end without that evidence.

- [ ] **Step 5: Final commit (if any verification tweaks were needed)**

```bash
git add -A
git commit -m "test(insider): verification pass for INSDR

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(Skip if nothing changed in this task.)

---

## Self-Review

**1. Spec coverage:**
- Standalone `INSDR`, requires ticker → Task 5 registry entry. ✓
- Markers on price chart (reuse chart endpoint, Recharts) → Task 5 `ComposedChart`. ✓
- Only P/S plotted; M/A/F/G in table behind toggle → Task 5 `buys/sells` filter + `openOnly`. ✓
- Finnhub primary + SEC fallback, never throws → Tasks 1–3. ✓
- 20-min cache → Task 3. ✓
- Route `GET /api/terminal/insiders/:ticker`, auth/regex/502 → Task 4. ✓
- `INSDR` in `KNOWN_FUNCTIONS` → Task 4. ✓
- AI brief block → Task 5 annotate effect. ✓
- Graceful degrade (chart fails, table only) → Task 5 `points.length === 0` branch + `Promise.allSettled`. ✓
- Marker y = nearest prior trading-day close → Task 5 `priceAt`. ✓
- Honest Finnhub/Render limitation → Task 6 Step 4. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**3. Type consistency:** Normalized transaction shape `{ date, name, role, code, isBuy, isSell, shares, price, value }` is identical across `normalizeFinnhub` (Task 1), `parseForm4Xml` (Task 2), the orchestrator (Task 3), and consumed unchanged by the client (Task 5). Route payload `{ ticker, transactions, _source }` defined in Task 3, consumed in Task 5. `classifyCode` defined Task 1, reused Task 2. `getRecentFilings` import matches the real `secFilings.js` export and `{ form, url }` row shape. ✓

No issues found.
