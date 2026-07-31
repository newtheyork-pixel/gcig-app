// Customer concentration, as the filer tagged it rather than as a model
// read it.
//
// SPLC asks a language model to find named customers in 10-K prose. That
// works when a filer names them and fails silently when it does not, and
// Johnson & Johnson does not: its wholesalers appear nowhere in the
// document as "McKesson" or "Cardinal Health". What they DO appear as is
// inline XBRL —
//
//   <ix:nonFraction name="us-gaap:ConcentrationRiskPercentage"
//                   contextRef="c-972" scale="-2">21.8</ix:nonFraction>
//   <xbrli:context id="c-972">
//     srt:MajorCustomersAxis            = jnj:Wholesaler1Member
//     us-gaap:ConcentrationRiskByTypeAxis    = jnj:WholesalerConcentrationRiskMember
//     us-gaap:ConcentrationRiskByBenchmarkAxis = us-gaap:SalesRevenueNetMember
//
// — three wholesalers at 21.8%, 15.5% and 11.1% of net sales, which is
// 48.4% of the company's revenue through three counterparties. That is
// the single most important fact on the panel and we were showing an
// empty customer list.
//
// It cannot come from the companyfacts API. That endpoint carries only
// the consolidated, NO-DIMENSION values, and concentration is meaningless
// without its dimension — JNJ's newest ConcentrationRiskPercentage1 row
// there is from a filing in 2016. The numbers exist only in the filing
// itself, which is a document we already fetch for SPLC.
//
// What this deliberately does NOT do is name anybody. If the filer wrote
// "Wholesaler 1", the panel says "Wholesaler 1". Supplying McKesson from
// outside knowledge is exactly the move that put three companies in this
// project's notes that were never in the filing.

import { getLatestFilingByForm, SEC_UA } from './secFilings.js';
import { secFetch } from './secFetch.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 2 * 60 * 1000;
const cache = new Map();

export function _resetConcentrationCache() {
  cache.clear();
}

/// Namespace prefixes are a filer's choice, not a rule. Most use
/// `xbrli:context` and `xbrldi:explicitMember`; some emit them bare. Both
/// have to work or the extractor silently returns nothing for a filer
/// whose only sin is a different prefix.
const CONTEXT_RE = /<(?:\w+:)?context\b[^>]*\bid\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/gi;
const MEMBER_RE = /<(?:\w+:)?explicitmember\b[^>]*\bdimension\s*=\s*"([^"]+)"[^>]*>\s*([^<]+?)\s*</gi;
const FACT_RE =
  /<ix:nonfraction\b([^>]*\bname\s*=\s*"[^"]*ConcentrationRiskPercentage\d*"[^>]*)>([\s\S]*?)<\/ix:nonfraction>/gi;

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function localName(qname) {
  const s = String(qname || '');
  const colon = s.indexOf(':');
  return colon >= 0 ? s.slice(colon + 1) : s;
}

/// "Wholesaler1Member" reads like a variable. "Wholesaler 1" reads like
/// a counterparty, which is what it is.
export function humanizeMember(qname) {
  let s = localName(qname).replace(/Member$/i, '');
  s = s
    // An acronym runs into the next word without a case change to split
    // on: "CVSHealthCorporation" is CVS Health Corporation.
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim();
}

/// Which benchmark the percentage is measured against.
///
/// This is the filter that keeps the panel honest. A 10-K tags
/// concentration against several benchmarks, and only revenue answers
/// "how much of this company's sales run through one counterparty".
/// JNJ's filing also carries a 5% product-concentration figure measured
/// against RESEARCH AND DEVELOPMENT EXPENSE — a real disclosure about
/// something else entirely, and one that would sit in a customer table
/// looking like a small customer.
/// Anchored to whole member names rather than matched loosely. The
/// loose form admitted anything containing "revenue" — DeferredRevenue,
/// UnearnedRevenue — and a benchmark that is not the revenue line is not
/// a share of sales.
const REVENUE_BENCHMARK =
  /^(?:[\w-]+:)?(?:SalesRevenueNet|SalesRevenueGoodsNet|SalesRevenueServicesNet|SalesRevenue|Revenues|RevenueFromContractWithCustomer(?:ExcludingAssessedTax|IncludingAssessedTax)?|RevenueBenchmark)Member$/i;

/// Benchmarks that are emphatically NOT revenue, listed so the rejection
/// is deliberate rather than incidental. Palantir tags a customer at 25%
/// of ACCOUNTS RECEIVABLE while its 10-K states plainly that no customer
/// reached 10% of revenue; Apple tags two SUPPLIERS at 46% and 23% of
/// vendor non-trade receivables, on the major-customers axis. Either one
/// printed in a customer table is a fabricated fact with a citation.
const NOT_REVENUE = /Receivable|PropertyPlant|Inventory|Purchases|CostOfGoods|Workforce|Employee|Labor|Deposits|Assets|Payable/i;

/// The risk type has to say customer. Apple's supplier rows sit on
/// srt:MajorCustomersAxis and are only distinguishable by their type
/// member being CreditConcentrationRisk rather than
/// CustomerConcentrationRisk. Where a filer omits the type axis entirely
/// we still accept, because JNJ-shaped filings that carry only the
/// customer axis and a revenue benchmark are unambiguous.
const CUSTOMER_RISK_TYPE = /Customer|Wholesaler|Distributor|Reseller|Client|Payor|Payer/i;
/// The axis that names WHO. Everything else describes the measurement.
const PARTY_AXIS = /MajorCustomersAxis|CustomerAxis|SupplierAxis|CounterpartyNameAxis/i;
const CUSTOMER_AXIS = /MajorCustomersAxis|CustomerAxis|ConcentrationRiskByTypeAxis/i;
const CUSTOMER_TYPE = /Customer|Wholesaler|Distributor|Client|Payor|Payer/i;

function parseContexts(html) {
  const out = new Map();
  CONTEXT_RE.lastIndex = 0;
  let m;
  while ((m = CONTEXT_RE.exec(html)) !== null) {
    const [, id, body] = m;
    const members = [];
    MEMBER_RE.lastIndex = 0;
    let mm;
    while ((mm = MEMBER_RE.exec(body)) !== null) {
      members.push({ axis: mm[1], member: mm[2] });
    }
    const start = (body.match(/<(?:\w+:)?startdate>\s*([^<]+?)\s*</i) || [])[1] || null;
    const end = (body.match(/<(?:\w+:)?enddate>\s*([^<]+?)\s*</i) || [])[1]
      || (body.match(/<(?:\w+:)?instant>\s*([^<]+?)\s*</i) || [])[1] || null;
    out.set(id, { members, start, end });
  }
  return out;
}

/// The displayed number, put back on a percentage scale.
///
/// Inline XBRL separates what is PRINTED from what is MEANT: the
/// document shows 21.8 and carries scale="-2", so the underlying fact is
/// 0.218. We want the human figure back, which is the printed one — but
/// only after honouring scale, because a filer that prints 0.218 with
/// scale="0" means the same thing and would otherwise land as 0.2%.
export function factValue(tag, inner) {
  const raw = String(inner || '').replace(/<[^>]*>/g, '').replace(/[,\s]/g, '');
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const scale = Number(attr(tag, 'scale') ?? 0);
  const sign = attr(tag, 'sign') === '-' ? -1 : 1;
  const value = sign * n * 10 ** (Number.isFinite(scale) ? scale : 0);
  // XBRL states a percentage as a fraction of one. Back to human.
  const pct = value * 100;
  return Number.isFinite(pct) ? Math.round(pct * 100) / 100 : null;
}

/**
 * Every customer-concentration percentage a filing tags, newest period
 * first. Pure over the filing HTML so it can be tested without EDGAR.
 */
export function parseConcentration(html) {
  const doc = String(html || '');
  if (!/ConcentrationRiskPercentage/i.test(doc)) return [];
  const contexts = parseContexts(doc);

  const rows = [];
  const seen = new Set();
  FACT_RE.lastIndex = 0;
  let m;
  while ((m = FACT_RE.exec(doc)) !== null) {
    const [, tag, inner] = m;
    const ctxId = attr(tag, 'contextref');
    const ctx = ctxId ? contexts.get(ctxId) : null;
    if (!ctx) continue;

    // Fails closed on all three counts. A missing benchmark is NOT
    // assumed to be revenue: that assumption is what turns a receivable
    // concentration into a customer nobody has.
    const benchmark = ctx.members.find((x) => /BenchmarkAxis/i.test(x.axis));
    if (!benchmark) continue;
    if (NOT_REVENUE.test(benchmark.member)) continue;
    if (!REVENUE_BENCHMARK.test(benchmark.member)) continue;

    // Where the filer states a risk type, it has to be a customer one.
    const riskType = ctx.members.find((x) => /ConcentrationRiskByTypeAxis/i.test(x.axis));
    if (riskType && !CUSTOMER_RISK_TYPE.test(riskType.member)) continue;

    // The counterparty axis first, always. Applied Digital tags both
    // `MajorCustomersAxis = CustomerAMember` and
    // `ConcentrationRiskByTypeAxis = CustomerConcentrationRiskMember`,
    // and matching the type axis first labelled a real 59%-of-revenue
    // customer as "Customer Concentration Risk" — the name of the
    // category it belongs to rather than the party itself.
    const party = ctx.members.find((x) => PARTY_AXIS.test(x.axis))
      || ctx.members.find(
        (x) => CUSTOMER_AXIS.test(x.axis)
          && CUSTOMER_TYPE.test(x.member)
          // A member that only names the risk type is not a party.
          && !/ConcentrationRiskMember$/i.test(x.member)
      );
    if (!party) continue;

    const pct = factValue(tag, inner);
    if (pct == null || pct <= 0 || pct > 100) continue;

    const key = `${party.member}|${ctx.start || ''}|${ctx.end || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      label: humanizeMember(party.member),
      member: party.member,
      axis: party.axis,
      benchmark: humanizeMember(benchmark.member),
      pct,
      start: ctx.start,
      end: ctx.end,
    });
  }

  // Newest period first, largest share first inside a period.
  rows.sort((a, b) => (b.end || '').localeCompare(a.end || '') || b.pct - a.pct);
  return rows;
}

/// Only the most recent period, which is the one a reader is asking
/// about. Prior years are in the filing and are not what SPLC shows.
export function latestPeriod(rows) {
  if (!rows.length) return { period: null, rows: [], total: null };
  const end = rows[0].end;
  const latest = rows.filter((r) => r.end === end);
  const total = latest.reduce((a, r) => a + r.pct, 0);
  // Members can nest, and nothing in the filing says which do.
  //
  // NVIDIA tags a 76% grouping alongside two 22% and 14% customers that
  // sit inside it, and General Dynamics files its 68% U.S. Government
  // line as a FLAT SIBLING of the 56.7/9.4/1.9 that compose it — the
  // hierarchy exists in the arithmetic and in no linkbase. Summing gives
  // 112% and 168%. So a combined figure is published only when it is
  // arithmetically possible, and withheld with a reason when it is not.
  const rounded = Math.round(total * 100) / 100;
  const overlapping = rounded > 100;
  return {
    period: end,
    start: latest[0]?.start || null,
    rows: latest,
    // Worth stating when it holds: three counterparties at 21.8, 15.5
    // and 11.1 is a different fact from any one of them.
    total: overlapping ? null : rounded,
    overlapping,
    overlapNote: overlapping
      ? `These shares sum to ${rounded}%, so some of them count the same revenue twice — a filer may tag a group and its members side by side. Read each line on its own.`
      : null,
  };
}

/**
 * Tagged customer concentration for a ticker.
 *
 * Returns `{ available, period, rows, total, source }`. `available:false`
 * with a reason rather than an empty array, because "this filer tags no
 * concentration" and "we could not read the filing" are different
 * answers and a caller cannot tell them apart from `[]`.
 */
export async function getCustomerConcentration(ticker, deps = {}) {
  const key = String(ticker || '').trim().toUpperCase();
  if (!key) return { available: false, reason: 'No ticker', rows: [] };

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const fetchFiling = deps.getLatestFilingByForm || getLatestFilingByForm;
  const get = deps.secFetch || secFetch;

  let value;
  try {
    const tenK = await fetchFiling(key, /^10-K(405|SB)?$/i);
    if (!tenK?.url) {
      value = { available: false, reason: 'No US 10-K on file for this ticker.', rows: [] };
    } else {
      const res = await get(tenK.url, {
        headers: { 'User-Agent': SEC_UA, Accept: 'text/html' },
        timeoutMs: 30_000,
      });
      const all = parseConcentration(await res.text());
      const latest = latestPeriod(all);
      value = latest.rows.length
        ? {
          available: true,
          period: latest.period,
          periodStart: latest.start,
          rows: latest.rows,
          total: latest.total,
          source: { form: tenK.form, filedAt: tenK.filingDate || null, url: tenK.url },
        }
        : {
          available: false,
          // Most filers tag nothing here, and that is a real answer: no
          // single customer reaches the 10% disclosure threshold.
          reason: 'This filing tags no customer-concentration percentages. Under SEC rules a customer is only disclosed above 10% of revenue, so most diversified filers have none.',
          rows: [],
          source: { form: tenK.form, filedAt: tenK.filingDate || null, url: tenK.url },
        };
    }
  } catch (err) {
    console.warn(`xbrlConcentration(${key}) failed:`, err.message);
    value = { available: false, reason: `Could not read the filing: ${err.message}`, rows: [], failed: true };
  }

  // A failure is not a week-old fact.
  cache.set(key, {
    at: value.failed ? Date.now() - TTL_MS + FAILURE_TTL_MS : Date.now(),
    value,
  });
  return value;
}
