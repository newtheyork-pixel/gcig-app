import { getRecentFilings, SEC_UA } from './secFilings.js';
import { secFetch as secArchivesFetch } from './secFetch.js';

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
  // Joint filings (multiple reportingOwners) are rare; we take the
  // first owner and apply it to all rows — acceptable for a fallback.
  const name =
    (doc.match(/<rptOwnerName>([\s\S]*?)<\/rptOwnerName>/i) || [])[1]?.trim() ||
    'Unknown';
  const rel = (doc.match(/<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/i) || [])[1] || '';
  const role = roleFromRelationship(rel);

  const out = [];
  const txBlocks = doc.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || [];
  for (const block of txBlocks) {
    const date = valueOf(block, 'transactionDate');
    // transactionCode is nested in <transactionCoding>; tagVal finds it
    // because it's the only <transactionCode> in a transaction block.
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
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
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
      const rawShares = r?.change == null ? null : num(r.change);
      const shares = rawShares != null ? Math.abs(rawShares) : null;
      const rawPrice = num(r?.transactionPrice);
      const price = rawPrice != null && rawPrice > 0 ? rawPrice : null;
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

const CACHE_TTL_MS = 20 * 60 * 1000;
// A miss earned by both vendors failing expires in minutes, not the
// twenty a real answer keeps — the same never-cache-a-failure-under-a-
// success's-TTL rule the SEC services follow.
const FAILURE_TTL_MS = 2 * 60 * 1000;
const cache = new Map(); // TICKER -> { at, payload }

export function _resetInsiderCache() {
  cache.clear();
}

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

// SEC's submissions feed returns the XSL-rendered viewer URL
// (.../xslF345X06/form4.xml → HTML). The raw ownership XML sits at the
// same path with that /xsl…/ segment stripped.
export function toRawForm4Url(url) {
  return String(url || '').replace(/\/xsl[^/]+\//, '/');
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
      // Through secFetch with the declared SEC UA, like every other
      // EDGAR read. The old Chrome-impersonating UA is exactly what
      // SEC blocks from datacenter IPs (secFilings.js:26-29 — the
      // MGMT "no DEF 14A" prod bug), so this fallback silently never
      // worked in production; secFetch also brings the throttle-retry
      // discipline these Archives reads need.
      const r = await secArchivesFetch(toRawForm4Url(f.url), {
        headers: { 'User-Agent': SEC_UA, Accept: 'application/xml,text/xml,*/*' },
      });
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
  let failed = false;

  try {
    const raw = await finnhubFetch(sym);
    const norm = normalizeFinnhub(raw);
    if (norm.length > 0) {
      transactions = norm;
      source = 'finnhub';
    }
  } catch (err) {
    console.warn(`insiderTx finnhub(${sym}) failed:`, err.message);
    failed = true;
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
      failed = true;
    }
  }

  const payload = { ticker: sym, transactions, _source: source };
  // An empty payload tainted by a vendor failure is a condition, not a
  // fact about the ticker — let it expire in minutes. A real answer
  // (or a genuinely quiet insider tape) keeps the twenty.
  cache.set(sym, {
    at: source === null && failed
      ? Date.now() - CACHE_TTL_MS + FAILURE_TTL_MS
      : Date.now(),
    payload,
  });
  return payload;
}
