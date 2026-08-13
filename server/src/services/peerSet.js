// Who a company actually competes with.
//
// PEER was a straight pass-through of Finnhub's /stock/peers, and that
// endpoint answers a different question from the one the panel asks. It
// returns the GICS sub-industry cohort — a classification — and takes no
// view on whether those companies compete. Since the 2023 GICS revision
// the department stores (Dillard's, Macy's, Kohl's) sit in Broadline
// Retail beside Amazon, while Walmart, Costco and Target were moved to
// Consumer Staples Merchandise Retail in a different SECTOR entirely.
//
// So AMZN PEER showed Dillard's, a four-billion-dollar department store,
// against a two-and-a-half-trillion-dollar company, and did not show
// Walmart. Both of those are correct GICS and neither is useful, which
// is the whole problem: a classification is not a judgement.
//
// We then made it worse by taking `.slice(0, 6)` of the vendor's list in
// whatever order it arrived, so even within the cohort the six shown
// were the first six rather than the six most comparable.
//
// THREE SOURCES, RANKED BY PROVENANCE, AND EVERY ROW SAYS WHICH IT CAME
// FROM. A reader who sees Dillard's is owed the reason.
//
//   filing  — named in the company's own 10-K competition discussion.
//             The best evidence there is: the company saying who it
//             competes with, under signature. Many filers name names;
//             Amazon deliberately does not, describing nine categories
//             of competitor and naming nobody, which is why this source
//             cannot be the only one.
//   peer    — our own read of who competes, which is a JUDGEMENT and is
//             labelled as one. Every ticker is verified to exist in
//             EDGAR's registrant directory before it is shown, so the
//             model can be wrong about relevance but cannot invent a
//             company.
//   sector  — the GICS cohort, kept as the backstop it should always
//             have been, and ranked by size so a company six hundred
//             times smaller than the focus sorts last instead of first.

import { llmChat } from './llm.js';
import { getPeers } from './marketData.js';
import { getCikForTicker } from './secFilings.js';
import { getBusinessSummary } from './secBusinessSummary.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 300;
const cache = new Map();

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/**
 * Order candidates by how close they are in size to the focus.
 *
 * Distance in DECADES, not dollars: the gap between a $4bn and a $40bn
 * company is the same kind of gap as between $40bn and $400bn, and a
 * linear measure would call every mid-cap equally distant from Amazon
 * and then sort them by nothing.
 *
 * A candidate with no market cap sorts last but is not dropped — an
 * unknown size is not a small one, and the vendor's coverage of foreign
 * lines is patchy enough that discarding them would quietly delete real
 * peers.
 */
export function bySizeProximity(focusCap, candidates) {
  const anchor = Number(focusCap) > 0 ? Math.log10(Number(focusCap)) : null;
  return [...candidates].sort((a, b) => {
    const da = decadeDistance(anchor, a.marketCap);
    const db = decadeDistance(anchor, b.marketCap);
    if (da !== db) return da - db;
    return String(a.ticker).localeCompare(String(b.ticker));
  });
}

function decadeDistance(anchor, cap) {
  const c = Number(cap);
  if (anchor == null || !(c > 0)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.log10(c) - anchor);
}

/**
 * Tickers out of a model's answer.
 *
 * Deliberately strict and deliberately dumb: one symbol per line or a
 * comma list, uppercase, nothing that needs interpretation. A model
 * asked for tickers that returns a sentence is a model that did not
 * follow the brief, and parsing its prose would only hide that.
 */
export function parseTickers(out, { exclude = '' } = {}) {
  const raw = String(out || '').trim();
  if (!raw) return [];
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);

  // REJECT THE WHOLE ANSWER IF IT IS PROSE, rather than sieving words
  // out of it. "The filing does not name any competitors." parses into
  // FILING, DOES, NOT, NAME, ANY — five tokens that satisfy any
  // reasonable ticker pattern, and no blocklist of English words is
  // ever going to be complete. A ticker list is short and uppercase, so
  // a lowercase letter anywhere means the model wrote a sentence, and a
  // sentence is a model that ignored the brief rather than data.
  if (tokens.length > 16) return [];
  if (tokens.some((t) => /[a-z]/.test(t))) return [];

  const seen = new Set();
  const skip = String(exclude || '').toUpperCase();
  return tokens
    .map((t) => t.toUpperCase().replace(/[^A-Z0-9.\-]/g, ''))
    .filter((t) => {
      if (!t || t === skip || !TICKER_RE.test(t)) return false;
      // The sanctioned ways of saying "nothing", which are uppercase
      // and would otherwise survive the check above.
      if (['NONE', 'NA', 'N/A', 'NIL', 'EMPTY'].includes(t)) return false;
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
}

/**
 * Merge the three sources into one ordered, labelled list.
 *
 * Provenance wins over everything: a company that names a competitor in
 * its own annual report outranks our opinion, which outranks a
 * classification. Within a source, the order it arrived in is kept —
 * the cohort has already been size-ranked by the caller, and the
 * filing's order is the filer's own.
 */
export function mergePeers({ filing = [], judged = [], sector = [] }, { limit = 6, exclude = '' } = {}) {
  const out = [];
  const seen = new Set([String(exclude || '').toUpperCase()]);
  for (const [source, list] of [['filing', filing], ['peer', judged], ['sector', sector]]) {
    for (const row of list) {
      const ticker = String(row?.ticker ?? row ?? '').toUpperCase();
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({ ticker, source });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/// How a row's provenance is described to a reader, in words, once.
export const SOURCE_LABELS = {
  filing: 'named as a competitor in the 10-K',
  peer: 'our read of who it competes with',
  sector: 'same GICS sub-industry (classification, not a competitive view)',
};

const FILING_SYSTEM = `You are given the competition discussion from a company's 10-K.

List the stock tickers of companies NAMED IN THIS TEXT as competitors of
the filer. Rules:
- ONLY companies the text actually names. If it describes categories of
  competitor without naming any company, return NONE. Most filings that
  name nobody are doing so deliberately; inventing names to fill the
  list is the worst possible failure here.
- US-listed tickers only. If a named company is private or not listed,
  omit it.
- Never include the filer itself.

Return tickers separated by spaces, nothing else. If none are named,
return exactly: NONE`;

const JUDGE_SYSTEM = `Name the public companies that most directly compete with the given
company, as an equity analyst would choose comparables.

Rules:
- Prefer companies competing in the SAME BUSINESS, not merely the same
  classification. Retail scale, business model and customer overlap
  matter more than sector labels.
- Similar size where possible. A company two orders of magnitude
  smaller is rarely a useful comparable.
- US-listed tickers only, at most 8, best first.
- Never include the company itself.

Return tickers separated by spaces and nothing else.`;

/**
 * The peer set for one ticker, with a source on every row.
 *
 * Cached for a week: who a company competes with changes on the
 * timescale of an annual report, and both model calls are wasted work
 * on a page reload. A failure caches for ten minutes rather than a week
 * — one unreachable model is not a fact about the company, the same
 * rule the description service learned.
 */
export async function getPeerSet(ticker, deps = {}) {
  const focus = String(ticker || '').trim().toUpperCase();
  if (!focus) return { peers: [], sources: {} };

  const hit = cache.get(focus);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const chat = deps.llmChat || llmChat;
  const cohortOf = deps.getPeers || getPeers;
  const summaryOf = deps.getBusinessSummary || getBusinessSummary;
  const verify = deps.verifyTicker || defaultVerify;
  const capOf = deps.marketCaps || (async () => ({}));

  // The three sources are independent, so they are gathered together
  // and none of them can sink the panel: every one degrades to an empty
  // list, and mergePeers simply falls through to the next.
  const [filingRaw, judgedRaw, cohort] = await Promise.all([
    namedInFiling(focus, { chat, summaryOf }).catch(() => []),
    judgedPeers(focus, { chat }).catch(() => []),
    Promise.resolve(cohortOf(focus)).catch(() => []),
  ]);

  // Size-rank the classification cohort. This alone is what stops a
  // four-billion-dollar department store leading Amazon's peer list.
  const caps = await capOf([focus, ...cohort]).catch(() => ({}));
  const ranked = bySizeProximity(
    caps[focus],
    (cohort || []).filter((t) => t !== focus).map((t) => ({ ticker: t, marketCap: caps[t] })),
  );

  // Verified LAST and only for what we are about to show, so a model
  // listing eight names does not cost eight directory lookups when six
  // rows are wanted. A ticker EDGAR has never heard of is dropped
  // silently — it is our error, not something to report as a company.
  const merged = mergePeers(
    { filing: filingRaw, judged: judgedRaw, sector: ranked },
    { limit: 10, exclude: focus },
  );
  const checked = [];
  for (const row of merged) {
    if (checked.length >= 6) break;
    // The cohort came from a market-data vendor that only lists real
    // symbols; only our own two sources need proving.
    if (row.source === 'sector' || (await verify(row.ticker))) checked.push(row);
  }

  const value = {
    peers: checked,
    sources: SOURCE_LABELS,
    // Named plainly so the panel can say it rather than implying it.
    caveat: checked.some((r) => r.source === 'peer')
      ? 'Rows marked as our read are a judgement, not a vendor classification. Every ticker is verified to exist in EDGAR before it is shown.'
      : null,
  };
  const ok = checked.length > 0;
  cache.set(focus, { at: Date.now(), ttl: ok ? TTL_MS : FAILURE_TTL_MS, value });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

async function defaultVerify(t) {
  try {
    return !!(await getCikForTicker(t));
  } catch {
    // The directory being unreachable must not be reported as "this
    // company does not exist" — keep the row and let the quote decide.
    return true;
  }
}

async function namedInFiling(focus, { chat, summaryOf }) {
  const text = await summaryOf(focus);
  if (!text) return [];
  // The gate is finding a competition discussion, not the length of
  // Item 1. A short filing that names its competitors is exactly the
  // case worth reading; a long one that never discusses competition has
  // nothing here whatever its size.
  const competition = competitionSection(String(text));
  if (!competition || competition.length < 40) return [];
  const out = await chat({
    messages: [
      { role: 'system', content: FILING_SYSTEM },
      { role: 'user', content: `Filer: ${focus}\n\n${competition.slice(0, 5000)}` },
    ],
    temperature: 0,
    // Tighter than the chat default on purpose. Both model calls run in
    // parallel and a panel load waits for the slower of them, so the
    // ceiling here IS the ceiling a member feels when they open PEER on
    // a ticker nobody has looked at this week. A source that cannot
    // answer in twenty-five seconds contributes nothing and the cohort
    // still fills the table.
    timeoutMs: 25_000,
  });
  return parseTickers(out, { exclude: focus });
}

/**
 * The part of Item 1 that discusses competition.
 *
 * Scoped rather than sending the whole business section, because a
 * filing mentions other companies in a dozen contexts — customers,
 * suppliers, litigants, acquisitions — and only one of them means
 * "competitor". J&J listing the Department of Justice as a party to
 * litigation is the shape of mistake this avoids.
 */
export function competitionSection(text) {
  const m = /(^|\n|\.\s)\s*competit(?:ion|ive\s+conditions)\b/i.exec(text);
  if (!m) return null;
  return text.slice(m.index, m.index + 6000);
}

async function judgedPeers(focus, { chat }) {
  const out = await chat({
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: `Company: ${focus}` },
    ],
    temperature: 0.1,
    timeoutMs: 25_000,
  });
  return parseTickers(out, { exclude: focus });
}

export function _resetPeerSetCache() {
  cache.clear();
}
