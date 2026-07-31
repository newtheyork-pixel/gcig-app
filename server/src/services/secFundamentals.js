import { getCikForTicker, SEC_UA, tickerDirectoryLoaded } from './secFilings.js';
import { secFetchJson } from './secFetch.js';

// SEC XBRL companyfacts — the structured financial-statement numbers a
// company tags in its filings, the same source Bloomberg's GF graphs.
// One fetch per CIK returns every us-gaap concept it has ever reported;
// we lift a handful (revenue → operating cash flow, plus diluted EPS),
// normalize them into per-period rows, and derive the margins. Free, no
// key — SEC only wants the identifying User-Agent.
//
// Two XBRL gotchas this service exists to absorb:
//   1. Concept names drift. "Revenue" has been Revenues, then
//      SalesRevenueNet, now RevenueFromContractWithCustomerExcluding-
//      AssessedTax; we try the candidates in order and take the first
//      tag the filer actually used.
//   2. A 10-K carries the full-year figure *and* the trailing quarters
//      for the same line. We keep annual points by period duration
//      (~a year) and dedupe each fiscal year to its latest filing, so a
//      restatement supersedes the original number.

const FACTS_URL = (cik) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — fundamentals move quarterly
const cache = new Map(); // CIK → { at, value: { annual, quarterly } }

// Metric → ordered concept candidates. The first one the filer reports
// wins. EPS carries the per-share unit; the rest are plain USD.
const METRICS = [
  {
    key: 'revenue',
    label: 'Revenue',
    unit: 'USD',
    concepts: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
    ],
  },
  { key: 'grossProfit', label: 'Gross Profit', unit: 'USD', concepts: ['GrossProfit'] },
  {
    key: 'operatingIncome',
    label: 'Operating Income',
    unit: 'USD',
    concepts: ['OperatingIncomeLoss'],
  },
  { key: 'netIncome', label: 'Net Income', unit: 'USD', concepts: ['NetIncomeLoss'] },
  {
    key: 'cfo',
    label: 'Operating Cash Flow',
    unit: 'USD',
    concepts: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
  },
  {
    key: 'epsDiluted',
    label: 'Diluted EPS',
    unit: 'USD/shares',
    concepts: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  },
];

function daysBetween(start, end) {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}

// Pull one metric's points for a frequency, keyed by fiscal period. The
// duration test does the heavy lifting: a year-long span is annual, a
// quarter-long span is quarterly, and the embedded sub-periods a 10-K
// also tags fall outside both windows. Each period is deduped to its
// most recently filed value so restatements win.
export function extractConcept(facts, candidates, { unit, freq, instant = false }) {
  const root = facts?.facts?.['us-gaap'] || {};
  // Every candidate, not the first one that has rows.
  //
  // Concept names drift, and a filer that changed tag mid-history has its
  // years split across two of them. Taking the first and breaking meant
  // C.H. Robinson showed revenue for eight years of seventeen: it moved
  // to RevenueFromContractWithCustomer in 2018 and everything before that
  // sat under Revenues, unread. Earlier candidates still win a period
  // they both cover, so the preference order still means something.
  const tagged = [];
  for (const c of candidates) {
    const u = root[c]?.units?.[unit];
    if (Array.isArray(u) && u.length) tagged.push({ rank: tagged.length, rows: u });
  }
  if (!tagged.length) return new Map();

  const byPeriod = new Map();
  for (const { rank, rows } of tagged) for (const e of rows) {
    if (e.val == null || e.fy == null || !e.end) continue;
    // Income-statement and cash-flow lines are *durations* (a quarter or
    // a year of activity); balance-sheet lines are *instants* (a snapshot
    // at period end, tagged with only an `end`). The duration window
    // separates annual from quarterly flows; instants skip it and lean on
    // the fiscal-period tag alone.
    if (!instant) {
      if (!e.start) continue;
      const d = daysBetween(e.start, e.end);
      if (freq === 'annual' && !(d >= 350 && d <= 380)) continue;
      if (freq === 'quarterly' && !(d >= 80 && d <= 100)) continue;
    }

    const fp = e.fp || (freq === 'annual' ? 'FY' : '');
    // The full-year line is fp 'FY'; a quarter is Q1–Q4. Belt-and-braces
    // alongside the duration test for filers with loose tagging.
    if (freq === 'annual' && fp !== 'FY') continue;
    if (freq === 'quarterly' && fp === 'FY') continue;

    const period = freq === 'annual' ? `FY${e.fy}` : `${e.fy} ${fp}`;
    const filed = e.filed || '';
    const prev = byPeriod.get(period);
    // A better-ranked tag wins outright; within one tag, the most
    // recently filed value wins so restatements replace originals.
    if (!prev || rank < prev.rank || (rank === prev.rank && filed > prev.filed)) {
      byPeriod.set(period, {
        period,
        fy: e.fy,
        fp,
        rank,
        t: Date.parse(e.end),
        val: e.val,
        filed,
      });
    }
  }
  return byPeriod;
}

// Assemble every metric into period rows, oldest→newest, with margins
// derived wherever revenue is present and non-zero.
export function extractFundamentals(facts, freq = 'annual') {
  const perMetric = METRICS.map((m) => ({
    m,
    points: extractConcept(facts, m.concepts, { unit: m.unit, freq }),
  }));

  // Union of every period any metric reported, ordered by period end.
  const periods = new Map();
  for (const { points } of perMetric) {
    for (const [k, p] of points) {
      if (!periods.has(k)) periods.set(k, { period: k, t: p.t });
    }
  }

  return Array.from(periods.values())
    .sort((a, b) => a.t - b.t)
    .map((base) => {
      const row = { period: base.period, t: base.t };
      for (const { m, points } of perMetric) {
        const p = points.get(base.period);
        row[m.key] = p ? p.val : null;
      }
      const rev = row.revenue;
      const margin = (x) => (rev && x != null ? x / rev : null);
      row.grossMargin = margin(row.grossProfit);
      row.operatingMargin = margin(row.operatingIncome);
      row.netMargin = margin(row.netIncome);
      return row;
    });
}

async function fetchFacts(cik) {
  // companyfacts is a fat document (a megabyte-plus for old filers), so
  // a longer leash than the filings feed. Retries and the 404-versus-
  // throttled distinction live in secFetch.
  try {
    return await secFetchJson(FACTS_URL(cik), {
      headers: { 'User-Agent': SEC_UA },
      timeoutMs: 20_000,
    });
  } catch (err) {
    // A trust like QQQ has a CIK and no companyfacts at all, so the
    // ticker resolves and the document 404s. Say what that means rather
    // than handing the panel an API URL to render.
    if (err.status === 404) {
      const e = new Error('No XBRL financial data on file — this is a fund or trust, not an operating company');
      e.status = 404;
      throw e;
    }
    throw err;
  }
}

// Share-class symbols arrive dotted (BRK.B) but EDGAR's map is hyphen
// (BRK-B); try the symbol then both punctuation variants, like the
// filings service does.
export async function resolveCik(ticker) {
  const t = String(ticker || '').toUpperCase();
  for (const v of [t, t.replace(/\./g, '-'), t.replace(/-/g, '.')]) {
    const hit = await getCikForTicker(v);
    if (hit) return hit;
  }
  return null;
}

// Public: normalized fundamentals for a ticker at the requested
// frequency. Both frequencies are built (and cached) from the single
// companyfacts fetch, so flipping annual↔quarterly is free after the
// first call. Throws { status } on a bad ticker or upstream failure; an
// empty rows array is a normal "this filer tags none of these".

/// Why a symbol failed to resolve.
///
/// Two very different reasons, and calling the first one the second is
/// how Mesa Labs, Applied Industrial and General Dynamics all came back
/// "not an SEC operating filer" in the same minute — which was true of
/// none of them. EDGAR was rate-limiting the directory fetch on a fresh
/// boot, so every symbol on earth looked unknown, and the panel reported
/// our outage as a fact about the company.
///
/// A 503 is the honest status for the first: nothing is wrong with the
/// ticker and the answer will differ in a minute.
export function unresolvedError(directoryLoaded) {
  if (!directoryLoaded) {
    const e = new Error("EDGAR's symbol directory is unavailable right now — this is our outage, not a fact about the company. Try again shortly.");
    e.status = 503;
    return e;
  }
  const e = new Error('Not an SEC operating filer — ETFs and funds file no XBRL financial statements');
  e.status = 404;
  return e;
}

export async function getFundamentals(rawTicker, freq = 'annual') {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    const e = new Error('Invalid ticker');
    e.status = 400;
    throw e;
  }
  const wantFreq = freq === 'quarterly' ? 'quarterly' : 'annual';

  const info = await resolveCik(ticker);
  if (!info) throw unresolvedError(tickerDirectoryLoaded());

  const hit = cache.get(info.cik);
  if (hit && Date.now() - hit.at < TTL_MS) return shape(ticker, info, wantFreq, hit.value);

  const facts = await fetchFacts(info.cik);
  const value = {
    annual: extractFundamentals(facts, 'annual'),
    quarterly: extractFundamentals(facts, 'quarterly'),
  };
  cache.set(info.cik, { at: Date.now(), value });
  return shape(ticker, info, wantFreq, value);
}

/// An empty result with no explanation reads as a broken panel.
///
/// Brookfield resolves to a real CIK and returns nothing, because it is
/// a Canadian issuer filing a 40-F: the financial statements are there
/// as a PDF exhibit and none of it is XBRL-tagged us-gaap. That is a
/// fact about the filer, not a gap in the extractor, and the panel can
/// only say so if the payload does.
function shape(ticker, info, wantFreq, value) {
  const rows = value[wantFreq] || [];
  const out = { ticker, cik: info.cik, name: info.name, freq: wantFreq, rows };
  if (!rows.length) {
    out.note = (value.annual || []).length || (value.quarterly || []).length
      ? 'Nothing tagged at this frequency. Try the other one.'
      : 'This filer tags no us-gaap XBRL data. Foreign private issuers (40-F, 20-F) file statements as exhibits rather than tagged data, so there is nothing here to read.';
  }
  return out;
}

// ── FA: the full statements ───────────────────────────────────────────
// GF lifts a handful of headline metrics to graph; FA reproduces the
// three statements line by line, the way Bloomberg's FA lays them out.
// Same companyfacts source, the same concept-drift candidate lists, and
// the instant/duration split extractConcept now understands. The line
// order here is the print order in the panel.

const INCOME_DEFS = [
  { key: 'revenue', label: 'Revenue', concepts: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'InterestAndDividendIncomeOperating'] },
  { key: 'cogs', label: 'COGS', concepts: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'] },
  { key: 'grossProfit', label: 'Gross Profit', concepts: ['GrossProfit'] },
  { key: 'sga', label: 'SG&A Expense', concepts: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense', 'OtherSellingGeneralAndAdministrativeExpense'] },
  { key: 'rnd', label: 'R&D Expense', concepts: ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'] },
  { key: 'opex', label: 'Operating Expenses', concepts: ['OperatingExpenses', 'CostsAndExpenses', 'BenefitsLossesAndExpenses', 'OperatingCostsAndExpenses'] },
  { key: 'operatingIncome', label: 'Operating Income', concepts: ['OperatingIncomeLoss'] },
  { key: 'otherIncome', label: 'Other Income/(Expense)', concepts: ['NonoperatingIncomeExpense', 'OtherNonoperatingIncomeExpense'] },
  { key: 'pretaxIncome', label: 'Pretax Income', concepts: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'] },
  { key: 'incomeTax', label: 'Income Taxes', concepts: ['IncomeTaxExpenseBenefit'] },
  { key: 'netIncome', label: 'Net Income', concepts: ['NetIncomeLoss'] },
  { key: 'epsDiluted', label: 'Diluted EPS', unit: 'USD/shares', derive: false, concepts: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'] },
  { key: 'dilutedShares', label: 'Diluted Shares', unit: 'shares', derive: false, concepts: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'] },
];

const BALANCE_DEFS = [
  { key: 'cash', label: 'Cash & Equivalents', concepts: ['CashAndCashEquivalentsAtCarryingValue'] },
  { key: 'sti', label: 'Short-Term Investments', concepts: ['ShortTermInvestments'] },
  { key: 'receivables', label: 'Receivables', concepts: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent', 'AccountsAndOtherReceivablesNetCurrent'] },
  { key: 'inventory', label: 'Inventory', concepts: ['InventoryNet', 'InventoryFinishedGoods', 'InventoryGross'] },
  { key: 'currentAssets', label: 'Total Current Assets', concepts: ['AssetsCurrent'] },
  { key: 'ppe', label: 'Net PP&E', concepts: ['PropertyPlantAndEquipmentNet'] },
  { key: 'totalAssets', label: 'Total Assets', concepts: ['Assets'] },
  { key: 'currentLiabilities', label: 'Total Current Liabilities', concepts: ['LiabilitiesCurrent'] },
  { key: 'longTermDebt', label: 'Long-Term Debt', concepts: ['LongTermDebtNoncurrent', 'LongTermDebt'] },
  { key: 'totalLiabilities', label: 'Total Liabilities', concepts: ['Liabilities'] },
  { key: 'equity', label: 'Total Equity', concepts: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
];

const CASHFLOW_DEFS = [
  { key: 'cfo', label: 'Operating Cash Flow', concepts: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'] },
  { key: 'capex', label: 'Capital Expenditures', concepts: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'] },
  { key: 'cfi', label: 'Investing Cash Flow', concepts: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'] },
  { key: 'cff', label: 'Financing Cash Flow', concepts: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'] },
  { key: 'depreciation', label: 'D&A', concepts: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization'] },
  { key: 'sbc', label: 'Stock-Based Comp', concepts: ['ShareBasedCompensation'] },
  { key: 'dividends', label: 'Dividends Paid', concepts: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'] },
];

// companyfacts is a megabyte-plus per filer; cache the raw document so FA
// and a later GF call on the same name share one fetch.
const factsCache = new Map(); // CIK → { at, facts }
async function loadFacts(cik) {
  const hit = factsCache.get(cik);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.facts;
  const facts = await fetchFacts(cik);
  factsCache.set(cik, { at: Date.now(), facts });
  return facts;
}

// Most filers tag Q1–Q3 and only the full year, never Q4. For an
// additive flow line we recover Q4 as FY − (Q1+Q2+Q3); for a balance
// snapshot the fiscal-year-end instant *is* the Q4 close, so we carry it
// straight over. Per-share and share-count lines aren't additive, so
// they opt out (derive:false) and simply go blank for Q4.
function pointsWithQ4(facts, def, instant) {
  const q = extractConcept(facts, def.concepts, { unit: def.unit || 'USD', freq: 'quarterly', instant });
  const a = extractConcept(facts, def.concepts, { unit: def.unit || 'USD', freq: 'annual', instant });
  for (const [, ap] of a) {
    const key = `${ap.fy} Q4`;
    if (q.has(key)) continue;
    if (instant) {
      q.set(key, { period: key, fy: ap.fy, fp: 'Q4', t: ap.t, val: ap.val });
    } else if (def.derive !== false) {
      const q1 = q.get(`${ap.fy} Q1`);
      const q2 = q.get(`${ap.fy} Q2`);
      const q3 = q.get(`${ap.fy} Q3`);
      if (q1 && q2 && q3 && [q1, q2, q3, ap].every((p) => p.val != null)) {
        q.set(key, { period: key, fy: ap.fy, fp: 'Q4', t: ap.t, val: ap.val - q1.val - q2.val - q3.val });
      }
    }
  }
  return q;
}

// Public: the three statements for a ticker, line items as rows and
// fiscal periods as columns (oldest→newest), aligned on a shared period
// axis so the columns line up across statements. Values are raw (USD,
// USD/shares, or share count); the panel handles millions/EPS display.
export async function getStatements(rawTicker, freq = 'annual') {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    const e = new Error('Invalid ticker');
    e.status = 400;
    throw e;
  }
  const wantFreq = freq === 'quarterly' ? 'quarterly' : 'annual';

  const info = await resolveCik(ticker);
  if (!info) {
    const e = new Error('Ticker not found in SEC EDGAR');
    e.status = 404;
    throw e;
  }
  const facts = await loadFacts(info.cik);

  const build = (defs, instant) =>
    defs.map((def) => ({
      ...def,
      points:
        wantFreq === 'quarterly'
          ? pointsWithQ4(facts, def, instant)
          : extractConcept(facts, def.concepts, { unit: def.unit || 'USD', freq: 'annual', instant }),
    }));

  const income = build(INCOME_DEFS, false);
  const balance = build(BALANCE_DEFS, true);
  const cashflow = build(CASHFLOW_DEFS, false);

  // Gross profit, where the filer does not report it.
  //
  // Plenty of service companies never tag GrossProfit at all — C.H.
  // Robinson files 411 us-gaap concepts and not one of them is it — so
  // the row rendered empty for every year while revenue and cost sat
  // right above it. Revenue minus cost is the definition, and deriving
  // it beats showing a blank line that looks like missing data.
  const revenue = income.find((r) => r.key === 'revenue')?.points;
  const cogs = income.find((r) => r.key === 'cogs')?.points;
  const gross = income.find((r) => r.key === 'grossProfit');
  if (gross && revenue && cogs) {
    for (const [period, rev] of revenue) {
      if (gross.points.has(period)) continue;
      const c = cogs.get(period);
      if (!c || rev.val == null || c.val == null) continue;
      gross.points.set(period, { ...rev, val: rev.val - c.val, derived: true });
    }
  }

  // Shared period axis: the union of every period any line reported.
  const pmap = new Map();
  for (const grp of [income, balance, cashflow]) {
    for (const item of grp) {
      for (const [k, p] of item.points) {
        if (!pmap.has(k)) pmap.set(k, { period: k, t: p.t, fy: p.fy, fp: p.fp });
      }
    }
  }
  const periods = Array.from(pmap.values())
    .sort((a, b) => a.t - b.t)
    .map((p) => ({
      period: p.period,
      fy: p.fy,
      fp: p.fp,
      label: wantFreq === 'annual' ? `FY ${p.fy}` : `${p.fp} ${p.fy}`,
    }));

  // Drop rows no period filled.
  //
  // Coca-Cola reports no R&D and Goldman Sachs has no inventory or
  // current assets — an unclassified balance sheet is how a bank files,
  // not a gap in ours. Rendering those as empty rows makes a correct
  // statement look broken, which is exactly the complaint. A line that
  // exists shows numbers; a line nobody reports is simply absent.
  const toRows = (grp) =>
    grp
      .filter((item) => periods.some((per) => item.points.get(per.period)?.val != null))
      .map((item) => ({
      key: item.key,
      label: item.label,
      unit: item.unit || 'USD',
      values: periods.map((per) => {
        const pt = item.points.get(per.period);
        return pt ? pt.val : null;
      }),
    }));

  return {
    ticker,
    cik: info.cik,
    name: info.name,
    freq: wantFreq,
    periods,
    income: toRows(income),
    balance: toRows(balance),
    cashflow: toRows(cashflow),
  };
}
