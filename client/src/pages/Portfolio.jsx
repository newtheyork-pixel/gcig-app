import { Fragment, useEffect, useMemo, useState } from 'react';
import { GOLD, NAVY } from '../theme';
import { format, subDays, subMonths, subYears, startOfYear } from 'date-fns';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { RefreshCw, ExternalLink } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import HoldingDetailModal from '../components/HoldingDetailModal.jsx';
import RiskPanel from '../components/RiskPanel.jsx';
import CashInterestCard from '../components/CashInterestCard.jsx';
import CashLedgerCard from '../components/CashLedgerCard.jsx';
import AddPositionButton from '../components/AddPositionButton.jsx';
import TradeButton from '../components/TradeButton.jsx';
import BulkTradeButton from '../components/BulkTradeButton.jsx';
import ImportBookBanner from '../components/ImportBookBanner.jsx';
import SnapshotReconcileButton from '../components/SnapshotReconcileButton.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { adjustedReturn as fullyInvestedReturn } from '../utils/portfolioReturns.js';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Operational ranks for the client-side PM+ gate. Mirrors server ROLE_RANK;
// the server is still the source of truth (betas endpoint requires the role).
const CLIENT_ROLE_RANK = {
  President: 11,
  DirectorOfResearch: 10,
  CIO: 9,
  SeniorPortfolioManager: 8,
  PortfolioManager: 7,
  SeniorAnalyst: 6,
  Analyst: 5,
  JuniorAnalyst: 4,
  ChiefOfCommunication: 2,
  DirectorOfPublicRelations: 2,
  AdvisoryBoardMember: 1,
  FacultyAdvisory: 1,
};

const RANGES = [
  { key: '1W', label: '1W', days: 7 },
  { key: '1M', label: '1M', days: 30 },
  { key: '3M', label: '3M', days: 90 },
  { key: '6M', label: '6M', days: 180 },
  { key: 'YTD', label: 'YTD' },
  { key: '1Y', label: '1Y', days: 365 },
  { key: 'ALL', label: 'All' },
];

// Timeframes for the per-equity return column in the Holdings table. 1D and
// 'purchase' come off the sheet directly; 1W/1M/1Y are joined in from
// /holdings/period-returns (which prices each ticker off the same PriceBar
// cache the terminal chart uses). Default 'purchase' preserves the table's
// original since-purchase column.
const RETURN_RANGES = [
  { key: '1D', label: 'Daily' },
  { key: '1W', label: 'Weekly' },
  { key: '1M', label: 'Monthly' },
  { key: '1Y', label: 'Yearly' },
  { key: 'purchase', label: 'Since Buy' },
];

// Resolve one holding's { pct, usd } return for the selected timeframe.
// Prefers the server's period-returns payload (keyed by ticker); falls back
// to the sheet's own columns for 1D and purchase so the table still reads
// correctly before that request lands or when a ticker is absent from it.
// Anything genuinely unavailable (a young position with no 1Y history)
// comes back as nulls, which the cells render as "—".
function returnForRange(h, rangeKey, periodReturns) {
  const pr = periodReturns?.[String(h.ticker || '').toUpperCase()];
  const cell = pr?.[rangeKey];
  if (cell && (cell.pct != null || cell.usd != null)) {
    return { pct: cell.pct ?? null, usd: cell.usd ?? null };
  }
  if (rangeKey === 'purchase') {
    return { pct: h.percentReturn ?? null, usd: h.dollarReturn ?? null };
  }
  if (rangeKey === '1D') {
    const prior =
      h.price != null && h.dayChange != null ? h.price - h.dayChange : null;
    return {
      pct: prior > 0 ? (h.dayChange / prior) * 100 : null,
      usd: h.dayChange != null && h.shares != null ? h.dayChange * h.shares : null,
    };
  }
  return { pct: null, usd: null };
}

// Starting capital the club was founded with. The sheet's per-position cost
// basis sometimes drifts by a few dollars from rounding — anchoring Total
// Gain/Loss to the actual dollar amount we began with avoids that error.
const INITIAL_CAPITAL = 100000;

// Capital infusions/withdrawals — subtracted from performance calcs so the
// return % reflects actual market movement, not money added.
// Positive = money in, negative = money out.
const CASH_FLOWS = [
  { date: new Date('2026-01-29T12:00:00Z'), amount: 25000, label: 'Capital infusion' },
];

// Everything we've put in: the starting $100k + every cash flow since.
// Used as the denominator for the Total Gain/Loss card.
const TOTAL_INVESTED =
  INITIAL_CAPITAL + CASH_FLOWS.reduce((sum, cf) => sum + cf.amount, 0);

// Annualized risk-free rate used in the Sharpe calculation.
// Currently set to the 3-month US Treasury yield (~4.25% as of Apr 2026).
// Update this constant if T-bill rates shift meaningfully.
const RISK_FREE_RATE = 0.0425;

function fmtMoney(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function fmtPct(n) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export default function Portfolio() {
  const { user, isPmOrAbove, isSuperAdmin } = useAuth();
  // Ledger, treasury sleeves, and the risk tab are the investment-officer
  // book: Portfolio Manager and above. Chief of Communication and
  // Director of Public Relations share rank 2, under every analyst, so
  // both get the simple book. isPmOrAbove is that same set.
  const canSeeTreasury = (CLIENT_ROLE_RANK[user?.role] || 0) >= CLIENT_ROLE_RANK.PortfolioManager;
  const canSeeRisk = canSeeTreasury;
  // Two pages on one route. The book is what we own; Risk is the
  // limits, beta, and flags. Junior analysts never see the switch.
  const [view, setView] = useState('book');
  const onRisk = canSeeRisk && view === 'risk';
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  /// SPY's daily closes, for the benchmark line. Null while loading and
  /// after a failure alike — the chart says which.
  const [benchmark, setBenchmark] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // YTD cash-interest simulation (BDA + FGTXX). Fetched alongside the
  // holdings so we can show the per-sleeve breakdown inline when the
  // user clicks the CASH row, plus the summary card below the table.
  const [cashYield, setCashYield] = useState(null);
  const [cashExpanded, setCashExpanded] = useState(false);
  // Per-ticker returns across timeframes (1W/1M/1Y computed server-side from
  // the price-history cache; 1D/purchase echoed from the sheet). Fetched
  // independently of the main quotes so a slow or failed price-history pass
  // never blocks the book from rendering — the column just falls back to the
  // sheet's own numbers until it lands.
  const [periodReturns, setPeriodReturns] = useState(null);
  // Which timeframe the Holdings return column shows. 'purchase' matches the
  // table's original behavior.
  const [returnRange, setReturnRange] = useState('purchase');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [quotes, hist] = await Promise.all([
        api.get('/holdings/quotes'),
        api.get('/holdings/history'),
      ]);
      setData(quotes.data);
      setHistory(hist.data);
      // Fetched separately and never awaited alongside the two above:
      // the benchmark is a comparison, and a comparison being
      // unavailable is not a reason to withhold the portfolio. The
      // chart draws our line alone and says the comparison is missing.
      api
        .get('/holdings/benchmark')
        .then((r) => setBenchmark(r.data))
        .catch(() => setBenchmark(null));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load portfolio');
      // Preserve the prior source so a transient failure doesn't flip db-mode
      // copy back to "Google Sheets" or hide the cash ledger card mid-session.
      setData((prev) => ({ holdings: [], totals: {}, source: prev?.source }));
    } finally {
      setLoading(false);
    }
  }

  function reloadCashYield() {
    return api
      .get('/holdings/cash-yield')
      .then((r) => setCashYield(r.data))
      .catch(() => setCashYield(null));
  }

  function reloadPeriodReturns() {
    return api
      .get('/holdings/period-returns')
      .then((r) => setPeriodReturns(r.data || {}))
      .catch(() => setPeriodReturns(null));
  }

  useEffect(() => {
    load();
    // Sleeve interest and the multi-window return column are the
    // officer book. The simple book reads the quote payload only.
    if (canSeeTreasury) {
      reloadCashYield();
      reloadPeriodReturns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeTreasury]);

  const totals = data?.totals || {};
  const holdings = data?.holdings || [];

  // Estimated interest the BDA + FGTXX sleeves threw off while funded.
  // Per the treasurer's instruction this is added on top of the sheet
  // total for the headline figures, so the club gets explicit credit
  // for the cash yield. (Note: economically the sheet already carries
  // most of this — reinvested FGTXX dividends and interest that was
  // spent on the stocks the sheet prices — so this deliberately leans
  // optimistic. It's a single, consistent add applied everywhere the
  // headline value/return is shown.)
  const estimatedCashInterest = Number(cashYield?.estimatedInterestEarned) || 0;

  // The displayed fund value: live sheet total + the cash-interest
  // estimate. Used for the hero and the risk-page return figures.
  const displayedTotal =
    totals.totalValue != null
      ? totals.totalValue + estimatedCashInterest
      : null;

  // Total Gain/Loss against the actual capital invested (starting $100k
  // + every infusion) so per-position cost-basis rounding in the sheet
  // doesn't throw off the top-line number.
  const equityGainLoss =
    displayedTotal != null ? displayedTotal - TOTAL_INVESTED : null;
  const lifetimeGainLoss = equityGainLoss;
  const lifetimeGainLossPct =
    lifetimeGainLoss != null ? (lifetimeGainLoss / TOTAL_INVESTED) * 100 : null;

  // Equity-only return: how the stock picks themselves are doing,
  // completely ignoring cash drag. Computed from per-holding shares ×
  // avg cost basis vs market value, summed across non-cash rows.
  const equityReturn = useMemo(() => {
    const nonCash = holdings.filter((h) => !h.isCash);
    if (nonCash.length === 0) return null;
    let mv = 0;
    let cost = 0;
    for (const h of nonCash) {
      if (h.marketValue != null) mv += h.marketValue;
      if (h.shares != null && h.costBasis != null) {
        cost += h.shares * h.costBasis;
      }
    }
    if (cost <= 0) return null;
    const dollarChange = mv - cost;
    return {
      marketValue: mv,
      cost,
      dollarChange,
      pct: (dollarChange / cost) * 100,
    };
  }, [holdings]);

  // Totals-row return for the selected timeframe. 'purchase' keeps the exact
  // since-inception figure the table has always shown (anchored to capital
  // invested). For any other window we roll the book up from the per-holding
  // period returns: sum the dollar moves and divide by the summed
  // start-of-period value, over just the positions that have data for that
  // window (a young name with no 1Y history drops out rather than distorting
  // the total).
  const holdingsReturnTotal = useMemo(() => {
    if (returnRange === 'purchase') {
      return { usd: lifetimeGainLoss, pct: lifetimeGainLossPct };
    }
    let sumUsd = 0;
    let sumBase = 0;
    let any = false;
    for (const h of holdings) {
      if (h.isCash) continue;
      const r = returnForRange(h, returnRange, periodReturns);
      if (r.usd == null) continue;
      const mv =
        h.marketValue ??
        (h.shares != null && h.price != null ? h.shares * h.price : null);
      if (mv == null) continue;
      const base = mv - r.usd; // position value at the start of the window
      if (!(base > 0)) continue;
      sumUsd += r.usd;
      sumBase += base;
      any = true;
    }
    if (!any || sumBase <= 0) return { usd: null, pct: null };
    return { usd: sumUsd, pct: (sumUsd / sumBase) * 100 };
  }, [returnRange, holdings, periodReturns, lifetimeGainLoss, lifetimeGainLossPct]);

  const [range, setRange] = useState('6M');
  const [selectedHolding, setSelectedHolding] = useState(null);

  // The book as it stands right now, shaped like a snapshot.
  //
  // Snapshots are written by a scheduled job, so the newest row in the
  // table is yesterday. Every card on this page reads live. The chart
  // read the table — which is why it drew +14.4% underneath a header
  // saying +15.7%, and why the benchmark badge reported a gap that was
  // a full trading day stale. The line now ends on today.
  //
  // Raw sheet total, deliberately. The snapshots carry no simulated cash
  // interest (the server stopped overlaying it), so adding it to this
  // one point would draw a step of roughly a year's accrual across the
  // last segment. The interest lives on the cards, where it is labelled
  // an estimate.
  const livePoint = useMemo(() => {
    const total = data?.totals?.totalValue;
    if (total == null) return null;
    const value = Number(Number(total).toFixed(2));
    const cash = Number(Number(data.totals.cashValue ?? 0).toFixed(2));
    return {
      date: new Date(),
      value,
      cash,
      equity: Math.max(value - cash, 0),
      live: true,
    };
  }, [data]);

  // Normalize history (with real Date objects) once, then extend it to now.
  // equity = totalValue - cashValue (falls back to total if cash is unknown).
  //
  // A snapshot already written for today is SUPERSEDED rather than kept:
  // two points on one date give the chart a vertical tick and Sharpe a
  // same-day pair whose return is meaningless.
  const fullHistory = useMemo(() => {
    const rows = history.map((s) => {
      const total = Number(s.totalValue.toFixed(2));
      const cash = s.cashValue != null ? Number(s.cashValue.toFixed(2)) : 0;
      return {
        date: new Date(s.date),
        value: total,
        cash,
        equity: Math.max(total - cash, 0),
      };
    });
    if (!livePoint) return rows;
    const todayIso = livePoint.date.toISOString().slice(0, 10);
    return [
      ...rows.filter((r) => r.date.toISOString().slice(0, 10) !== todayIso),
      livePoint,
    ];
  }, [history, livePoint]);

  // Average cash sleeve we've actually carried, day by day. The club only
  // meets weekly, so the book usually holds a meaningful idle balance — this
  // measures it instead of pretending we run a 5%-cash target.
  //
  // Skip snapshots without a recorded cashValue (older rows predate the
  // cash-tracking column); fullHistory coerces those to 0, which would
  // drag the average toward zero and lie about how heavy the cash sleeve
  // actually runs.
  const avgCashRatio = useMemo(() => {
    if (history.length === 0) return null;
    let sum = 0;
    let count = 0;
    for (const snap of history) {
      if (snap.cashValue == null) continue;
      const total = Number(snap.totalValue);
      const cash = Number(snap.cashValue);
      if (!(total > 0)) continue;
      sum += cash / total;
      count++;
    }
    return count > 0 ? sum / count : null;
  }, [history]);

  // Adjusted return: the fully-invested counterfactual. If cash had
  // earned the equity rate, the book earns the equity rate — so this
  // is the equity sleeve, and it cannot sit above it.
  //
  // We used to add avgCashRatio × equityReturn on top of the book %.
  // That only reconstructs the sleeve when cash returned nothing. The
  // pile now yields, and Total Gain/Loss already credits estimated
  // interest, so the mix printed above equity-only (15.92 vs 14.59)
  // on a tile whose job was to remove cash drag.
  const adjustedReturn = useMemo(
    () =>
      fullyInvestedReturn({
        equityPct: equityReturn?.pct,
        cashRatio: avgCashRatio,
      }),
    [equityReturn, avgCashRatio]
  );

  // Filter by selected range.
  const chartData = useMemo(() => {
    if (fullHistory.length === 0) return [];
    const now = new Date();
    let cutoff;
    if (range === 'ALL') return fullHistory;
    if (range === 'YTD') cutoff = startOfYear(now);
    else {
      const r = RANGES.find((x) => x.key === range);
      cutoff = r?.days ? subDays(now, r.days) : null;
    }
    return cutoff ? fullHistory.filter((d) => d.date >= cutoff) : fullHistory;
  }, [fullHistory, range]);

  // Chart series.
  //
  // For the ALL range we anchor to TOTAL_INVESTED (starting capital + all
  // infusions to date) so the right edge of the chart matches the Total
  // Gain/Loss card exactly. At each point:
  //     running_invested(t) = INITIAL_CAPITAL + sum of infusions ≤ t
  //     pct(t) = (value(t) - running_invested(t)) / running_invested(t)
  //
  // For every other range (1W, 1M, YTD, …) we keep the "change since start of
  // range" model, subtracting infusions that landed inside the range so they
  // don't fake-inflate the return.
  const percentSeries = useMemo(() => {
    if (chartData.length === 0) return [];

    if (range === 'ALL') {
      return chartData.map((d) => {
        const runningInvested =
          INITIAL_CAPITAL +
          CASH_FLOWS.filter((cf) => cf.date <= d.date).reduce(
            (s, cf) => s + cf.amount,
            0
          );
        const dollarDelta = d.value - runningInvested;
        const percent = runningInvested > 0 ? (dollarDelta / runningInvested) * 100 : 0;
        return { ...d, dollarDelta, percent };
      });
    }

    const start = chartData[0];
    const base = start.equity > 0 ? start.equity : start.value;
    if (base <= 0) return [];
    return chartData.map((d) => {
      const cfSoFar = CASH_FLOWS.filter(
        (cf) => cf.date > start.date && cf.date <= d.date
      ).reduce((s, cf) => s + cf.amount, 0);
      const dollarDelta = d.value - cfSoFar - start.value;
      const percent = (dollarDelta / base) * 100;
      return { ...d, dollarDelta, percent };
    });
  }, [chartData, range]);

  // Tight y-axis domain in percent — pad slightly so the line doesn't kiss
  // the top / bottom of the chart.
  const yDomain = useMemo(() => {
    if (percentSeries.length === 0) return [0, 1];
    const values = percentSeries.map((d) => d.percent);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const pad = Math.max(range * 0.1, 0.5);
    return [Number((min - pad).toFixed(2)), Number((max + pad).toFixed(2))];
  }, [percentSeries]);

  // Daily change on equity (invested capital) — cash parked isn't "performance."
  // Dollar change = total change (cash contributes ~0 to day-over-day movement).
  // Percent = dollar change / yesterday's equity base.
  //
  // Both sides are raw sheet totals and nothing is layered on either.
  // This used to add the whole lifetime cash-interest estimate to today
  // and compare it against a snapshot carrying none, so a flat market
  // still printed a gain of about a year's accrual — every day, and the
  // comment directly above it asserted the two were comparable. That add
  // was a leftover from when the server overlaid interest on the history
  // as well; the server stopped, this did not.
  const dailyChange = useMemo(() => {
    if (fullHistory.length < 2) return null;
    const today = fullHistory[fullHistory.length - 1];
    if (!today.live) return null;
    const todayIso = today.date.toISOString().slice(0, 10);
    for (let i = fullHistory.length - 2; i >= 0; i--) {
      const snap = fullHistory[i];
      if (snap.date.toISOString().slice(0, 10) === todayIso) continue;
      const day = snap.date.getDay();
      if (day === 0 || day === 6) continue;
      const diff = today.value - snap.value;
      const base = snap.equity;
      const pct = base > 0 ? (diff / base) * 100 : 0;
      return { diff, pct };
    }
    return null;
  }, [fullHistory]);

  // Annualized Sharpe. Numerator comes from the adjusted return
  // (the equity sleeve, annualized by trading days in the sample) so
  // the headline return on the risk page matches what's in the Sharpe.
  // Volatility is measured off equity-base daily returns. Cash flows
  // are subtracted from the daily Δ so infusions don't masquerade as
  // performance.
  const sharpe = useMemo(() => {
    if (fullHistory.length < 20 || !adjustedReturn) return null;
    const dailyReturns = [];
    for (let i = 1; i < fullHistory.length; i++) {
      const prev = fullHistory[i - 1];
      const curr = fullHistory[i];
      const day = curr.date.getDay();
      if (day === 0 || day === 6) continue;
      if (prev.equity <= 0) continue;
      const cfOnDay = CASH_FLOWS.filter(
        (cf) => cf.date.toISOString().slice(0, 10) === curr.date.toISOString().slice(0, 10)
      ).reduce((s, cf) => s + cf.amount, 0);
      const dollarChange = curr.value - cfOnDay - prev.value;
      dailyReturns.push(dollarChange / prev.equity);
    }
    if (dailyReturns.length < 10) return null;
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) /
      dailyReturns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    const annualReturn =
      (adjustedReturn.pct / 100) * (252 / dailyReturns.length);
    const annualStd = std * Math.sqrt(252);
    return (annualReturn - RISK_FREE_RATE) / annualStd;
  }, [fullHistory, adjustedReturn]);

  // Change between first and last point in the visible range, on equity base.
  // Dollar change = total change minus any capital infusions in range.
  // Percent = dollar change / equity at start of range.
  const rangeChange = useMemo(() => {
    if (chartData.length < 2) return null;
    const end = chartData[chartData.length - 1];

    // ALL range: measured against capital invested, like the Total
    // Gain/Loss card. It lands slightly below that card because the line
    // is drawn on marked value alone and the card adds the simulated
    // cash interest on top. That difference is deliberate and is named
    // in the footnote under this figure rather than reconciled away.
    if (range === 'ALL') {
      const diff = end.value - TOTAL_INVESTED;
      const pct = TOTAL_INVESTED > 0 ? (diff / TOTAL_INVESTED) * 100 : 0;
      return { diff, pct, cashFlowInRange: 0 };
    }

    const start = chartData[0];
    const cashFlowInRange = CASH_FLOWS.filter(
      (cf) => cf.date > start.date && cf.date <= end.date
    ).reduce((sum, cf) => sum + cf.amount, 0);
    const rawDiff = end.value - start.value;
    const diff = rawDiff - cashFlowInRange;
    const base = start.equity > 0 ? start.equity : start.value;
    const pct = base > 0 ? (diff / base) * 100 : 0;
    return { diff, pct, cashFlowInRange };
  }, [chartData, range]);

  // The S&P 500 over the same window, indexed to the same zero.
  //
  // "Up 11%" is a good year or a bad one depending entirely on this
  // line, and the chart had no way to tell a reader which. Both series
  // are rebased to the FIRST DAY OF THE VISIBLE RANGE, so switching to
  // 1M asks "how have we done this month against the index" and not
  // "how have we done since inception, redrawn".
  //
  // The benchmark is matched to our own snapshot dates by taking its
  // last close on or before each one, rather than by zipping two arrays
  // — the club's snapshots skip days the market was open and the market
  // has days we took no snapshot, and zipping would slide the index by
  // however many days the two calendars had drifted apart.
  const benchSeries = useMemo(() => {
    if (!benchmark?.bars?.length || percentSeries.length === 0) return null;
    const bars = benchmark.bars;
    let cursor = 0;
    let base = null;
    const out = new Map();
    for (const point of percentSeries) {
      const iso = format(point.date, 'yyyy-MM-dd');
      while (cursor + 1 < bars.length && bars[cursor + 1].date <= iso) cursor += 1;
      const bar = bars[cursor];
      if (!bar || bar.date > iso) continue; // benchmark history starts later
      if (base == null) base = bar.close;
      if (!(base > 0)) continue;
      out.set(+point.date, ((bar.close - base) / base) * 100);
    }
    return out.size > 1 ? out : null;
  }, [benchmark, percentSeries]);

  // Build display data with a short date label. For long ranges we thin labels out.
  const displayData = percentSeries.map((d) => ({
    ...d,
    benchmark: benchSeries?.get(+d.date) ?? null,
    label: format(d.date, percentSeries.length > 90 ? 'MMM yyyy' : 'MMM d'),
    tooltipLabel: format(d.date, 'MMM d, yyyy'),
  }));

  // How far ahead or behind we finished the window. The single number
  // the whole chart exists to produce.
  const versusBenchmark = useMemo(() => {
    if (!benchSeries) return null;
    const last = displayData[displayData.length - 1];
    if (!last || last.benchmark == null) return null;
    return { ours: last.percent, theirs: last.benchmark, gap: last.percent - last.benchmark };
  }, [benchSeries, displayData]);

  if (!canSeeTreasury) {
    return (
      <SimplePortfolio
        data={data}
        loading={loading}
        error={error}
        onRefresh={load}
      />
    );
  }

  return (
    <>
      <PageHeader
        kicker={onRisk ? 'Portfolio' : 'The Live Book'}
        title={onRisk ? 'Risk' : 'Portfolio'}
        subtitle={
          onRisk
            ? 'Position limits, beta, and what sits outside the targets.'
            : (data?.source === 'db'
                ? 'Live · holdings from the database, prices from Google'
                : 'Live from Google Sheets') +
              (data?.fetchedAt
                ? ` · fetched ${format(new Date(data.fetchedAt), 'h:mm:ss a')}`
                : '')
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canSeeRisk && (
              <div className="mr-2 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setView('book')}
                  className={`px-2 py-1 text-sm font-medium transition ${
                    !onRisk
                      ? 'text-navy underline decoration-gold decoration-2 underline-offset-4'
                      : 'text-navy-400 hover:text-navy'
                  }`}
                >
                  Portfolio
                </button>
                <button
                  type="button"
                  onClick={() => setView('risk')}
                  className={`px-2 py-1 text-sm font-medium transition ${
                    onRisk
                      ? 'text-navy underline decoration-gold decoration-2 underline-offset-4'
                      : 'text-navy-400 hover:text-navy'
                  }`}
                >
                  Risk
                </button>
              </div>
            )}
            <a
              href={`https://docs.google.com/spreadsheets/d/${import.meta.env.VITE_SHEET_ID || '10b43Ry4YBfY_Uk_8nIlJLjmfNgzzjAm6BjN7UewSdRQ'}/edit`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-navy-100 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-navy-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open Sheet
            </a>
            <Button onClick={load} variant="gold" disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        }
      />

      {isSuperAdmin && data?.source === 'db-empty' && (
        <ImportBookBanner onImported={load} />
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <strong>Couldn't load the sheet.</strong> {error}
          <div className="mt-2 text-xs">
            Make sure the sheet is shared as "Anyone with the link can view".
          </div>
        </div>
      )}

      {onRisk ? (
        <>
          <RiskPanel
            holdings={holdings}
            totals={totals}
            history={fullHistory}
            cashFlows={CASH_FLOWS}
            headline={[
              {
                label: 'Sharpe',
                value: sharpe != null ? sharpe.toFixed(2) : '—',
                sub:
                  sharpe != null
                    ? `Equity sleeve · Rf = ${(RISK_FREE_RATE * 100).toFixed(2)}%`
                    : null,
                tone: sharpe == null ? 'neutral' : sharpe >= 1 ? 'good' : sharpe >= 0 ? 'neutral' : 'bad',
              },
              {
                label: 'Adjusted return',
                value: adjustedReturn ? fmtPct(adjustedReturn.pct) : '—',
                sub: adjustedReturn
                  ? `${equityReturn ? fmtMoney(equityReturn.dollarChange) + ' · ' : ''}${(adjustedReturn.cashRatio * 100).toFixed(1)}% avg cash excluded`
                  : 'Equity sleeve · cash excluded',
                tone:
                  adjustedReturn == null
                    ? 'neutral'
                    : adjustedReturn.pct >= 0
                      ? 'good'
                      : 'bad',
              },
              {
                label: 'Real return',
                value: lifetimeGainLossPct != null ? fmtPct(lifetimeGainLossPct) : '—',
                sub: 'Cash included',
                tone:
                  lifetimeGainLoss == null
                    ? 'neutral'
                    : lifetimeGainLoss >= 0
                      ? 'good'
                      : 'bad',
              },
            ]}
          />
        </>
      ) : (
        <>
      <PortfolioHero
        totalValue={displayedTotal}
        lifetimeGainLoss={lifetimeGainLoss}
        lifetimeGainLossPct={lifetimeGainLossPct}
        cashValue={totals.cashValue}
        holdingsCount={holdings.filter((h) => !h.isCash).length}
        history={fullHistory}
        today={dailyChange}
      />

      <div className="mt-6">
        <Card>
          {/* Header row: title + perf summary on left, range selector on right */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-serif text-2xl font-medium tracking-tight text-navy">Performance</div>
              {rangeChange && (
                <>
                  <div
                    className={`mt-1 font-serif text-xl tabular-nums ${
                      rangeChange.diff >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {rangeChange.diff >= 0 ? '+' : ''}
                    {fmtMoney(rangeChange.diff)}
                    <span className="font-sans text-sm text-navy-400">
                      {' '}
                      {rangeChange.pct >= 0 ? '+' : ''}
                      {rangeChange.pct.toFixed(2)}% in {RANGES.find((r) => r.key === range)?.label}
                    </span>
                  </div>
                  {range === 'ALL' ? (
                    <div className="mt-0.5 text-[11px] text-navy-400">
                      vs. {fmtMoney(TOTAL_INVESTED)} invested
                      {estimatedCashInterest > 0
                        ? `, marked value only (Total Gain/Loss adds ${fmtMoney(
                            estimatedCashInterest
                          )} estimated cash interest)`
                        : ''}
                    </div>
                  ) : rangeChange.cashFlowInRange > 0 ? (
                    <div className="mt-0.5 text-[11px] text-navy-400">
                      Excludes {fmtMoney(rangeChange.cashFlowInRange)} capital infusion
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`px-2 py-1 text-[11px] font-medium tracking-wide transition ${
                    range === r.key
                      ? 'text-navy underline decoration-gold decoration-2 underline-offset-4'
                      : 'text-navy-400 hover:text-navy'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {/* The answer, in words, above the picture of it. A reader
              should not have to measure the gap between two lines with
              their eye to learn whether the club beat the index. */}
          <div className="mb-4 mt-3 flex items-center gap-3 text-xs">
            {versusBenchmark ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-4 rounded bg-navy" />
                  <span className="font-semibold text-navy">The Griffin Fund</span>
                  <span className="text-navy-400">
                    {versusBenchmark.ours >= 0 ? '+' : ''}
                    {versusBenchmark.ours.toFixed(1)}%
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-0 w-4 border-t-2 border-dashed"
                    style={{ borderColor: '#8C99BB' }}
                  />
                  <span className="font-semibold text-navy-400">S&P 500</span>
                  <span className="text-navy-400">
                    {versusBenchmark.theirs >= 0 ? '+' : ''}
                    {versusBenchmark.theirs.toFixed(1)}%
                  </span>
                </span>
                <span
                  className={`font-medium ${
                    versusBenchmark.gap >= 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {versusBenchmark.gap >= 0 ? 'Ahead by ' : 'Behind by '}
                  {Math.abs(versusBenchmark.gap).toFixed(1)} pts
                </span>
              </>
            ) : (
              // Not silence. A chart that quietly drops the comparison
              // looks like a chart that never had one.
              <span className="text-navy-400">
                {benchmark === null
                  ? 'S&P 500 comparison unavailable right now.'
                  : 'S&P 500 comparison loading…'}
              </span>
            )}
          </div>

          {displayData.length > 1 ? (
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <AreaChart data={displayData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="navyFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={NAVY.DEFAULT} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={NAVY.DEFAULT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#E8EBF2" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    stroke="#8C99BB"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#8C99BB"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    domain={yDomain}
                    tickFormatter={(v) =>
                      `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 1 ? 2 : 1)}%`
                    }
                    width={55}
                  />
                  <Tooltip
                    formatter={(v, name, entry) =>
                      name === 'S&P 500'
                        ? [`${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`, 'S&P 500']
                        : [
                            `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}% (${fmtMoney(entry?.payload?.dollarDelta)})`,
                            'The Griffin Fund',
                          ]
                    }
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.tooltipLabel || ''}
                    contentStyle={{
                      borderRadius: 8,
                      borderColor: GOLD.DEFAULT,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="percent"
                    name="The Griffin Fund"
                    stroke={NAVY.DEFAULT}
                    strokeWidth={2.5}
                    fill="url(#navyFill)"
                    dot={false}
                    activeDot={{ r: 5, fill: GOLD.DEFAULT, stroke: NAVY.DEFAULT, strokeWidth: 2 }}
                  />
                  {benchSeries ? (
                    // Drawn as a thin dashed line with no fill, and
                    // second, so it reads as the reference it is rather
                    // than as a second portfolio. `connectNulls` because
                    // the index has no close on days we snapshotted and
                    // the market was shut — a gap there is a calendar
                    // artefact, not missing data.
                    <Area
                      type="monotone"
                      dataKey="benchmark"
                      name="S&P 500"
                      stroke="#8C99BB"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      fill="none"
                      dot={false}
                      connectNulls
                      activeDot={{ r: 4, fill: '#8C99BB' }}
                    />
                  ) : null}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-navy-400">
              Not enough data in this range.
            </div>
          )}
        </Card>
        {isSuperAdmin && (
          <div className="mt-2 flex justify-end">
            <SnapshotReconcileButton onDone={load} />
          </div>
        )}
      </div>

      <SectorAllocation holdings={holdings} totalValue={totals.totalValue} />

      {data?.source === 'db' && <CashLedgerCard onReset={load} />}

      <div className="mt-6">
        <Card
          title="Holdings"
          action={
            isSuperAdmin && data?.source === 'db' ? (
              <div className="flex flex-wrap gap-2">
                <TradeButton holdings={holdings} cash={totals?.cashValue ?? 0} onDone={load} />
                <BulkTradeButton onDone={load} />
                <AddPositionButton onAdded={load} cash={totals?.cashValue ?? 0} />
              </div>
            ) : null
          }
        >
          {loading && !holdings.length ? (
            <div className="py-8 text-center text-navy-400">Loading the book…</div>
          ) : holdings.length === 0 ? (
            <div className="py-8 text-center text-navy-400">
              No positions found.
            </div>
          ) : (
            <>
            {/* Return timeframe toggle — drives the return column below in both
                the desktop table and the mobile cards. Same segmented-control
                look as the performance chart's range picker. */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-navy-400">
                Return shown:{' '}
                <span className="font-semibold text-navy">
                  {RETURN_RANGES.find((r) => r.key === returnRange)?.label}
                </span>
              </div>
              <div className="flex items-center gap-0.5">
                {RETURN_RANGES.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setReturnRange(r.key)}
                    className={`px-2 py-1 text-[11px] font-medium tracking-wide transition ${
                      returnRange === r.key
                        ? 'text-navy underline decoration-gold decoration-2 underline-offset-4'
                        : 'text-navy-400 hover:text-navy'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Mobile: stacked cards */}
            <div className="space-y-2 md:hidden">
              {holdings.map((h) => {
                const ret = returnForRange(h, returnRange, periodReturns);
                const up = (ret.pct ?? ret.usd ?? 0) >= 0;
                const marketValue =
                  h.marketValue ??
                  (h.shares != null && h.price != null ? h.shares * h.price : null);
                const hasCashBreakdown = h.isCash && cashYield;
                return (
                  <Fragment key={h.ticker}>
                  <button
                    onClick={() => {
                      if (h.isCash) {
                        if (hasCashBreakdown) setCashExpanded((v) => !v);
                      } else {
                        setSelectedHolding(h);
                      }
                    }}
                    disabled={h.isCash && !hasCashBreakdown}
                    className={`w-full rounded-lg border border-navy-100 px-3 py-3 text-left transition ${
                      h.isCash
                        ? hasCashBreakdown
                          ? 'bg-gold-100/40 active:bg-gold-100/70'
                          : 'bg-gold-100/40 cursor-default'
                        : 'bg-white active:bg-navy-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="font-bold text-navy">{h.ticker}</span>
                          {h.portfolioPct != null && (
                            <span className="text-[10px] font-semibold text-navy-400">
                              {h.portfolioPct.toFixed(1)}%
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-navy-400">{h.name}</div>
                        {h.sector && !h.isCash && (
                          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-navy-400">
                            {h.sector}
                          </div>
                        )}
                      </div>
                      <div className="text-right tabular-nums">
                        <div className="font-bold text-navy">{fmtMoney(marketValue)}</div>
                        {!h.isCash && (
                          <div
                            className={`text-xs font-semibold ${
                              ret.pct == null
                                ? 'text-navy-400'
                                : up
                                  ? 'text-emerald-600'
                                  : 'text-red-600'
                            }`}
                          >
                            {fmtPct(ret.pct)}
                          </div>
                        )}
                      </div>
                    </div>
                    {!h.isCash && (
                      <div className="mt-2 flex justify-between gap-2 border-t border-navy-50 pt-2 text-[11px] text-navy-400">
                        <span>
                          {h.shares ?? '—'} sh @ {fmtMoney(h.costBasis)}
                        </span>
                        <span
                          className={
                            ret.usd == null
                              ? 'text-navy-400'
                              : up
                                ? 'text-emerald-600'
                                : 'text-red-600'
                          }
                        >
                          {fmtMoney(ret.usd)}
                        </span>
                      </div>
                    )}
                    {hasCashBreakdown && (
                      <div className="mt-2 text-[10px] uppercase tracking-wider text-navy-400">
                        {cashExpanded ? 'Hide breakdown' : 'Tap to show breakdown'}
                      </div>
                    )}
                  </button>
                  {hasCashBreakdown && cashExpanded && (
                    <>
                      <CashSubCard
                        ticker="BDA"
                        name="GS Bank USA Deposit"
                        balance={cashYield.bdaEndingBalance}
                        interest={cashYield.bdaTotalInterest}
                        rate={
                          cashYield.bdaApy != null
                            ? `${(cashYield.bdaApy * 100).toFixed(2)}%`
                            : '—'
                        }
                      />
                      <CashSubCard
                        ticker="FGTXX"
                        name="GS FS Government MMF"
                        balance={cashYield.fgtxxEndingBalance}
                        interest={cashYield.fgtxxTotalInterest}
                        rate={
                          cashYield.fgtxxLatestYield != null
                            ? `${cashYield.fgtxxLatestYield.toFixed(2)}%`
                            : '—'
                        }
                      />
                    </>
                  )}
                  </Fragment>
                );
              })}
              <div className="mt-3 flex items-center justify-between rounded-lg border-2 border-navy-100 px-3 py-3 text-sm">
                <span className="font-bold text-navy">
                  Total ({holdings.length})
                </span>
                <div className="text-right">
                  <div className="font-bold text-navy tabular-nums">
                    {fmtMoney(displayedTotal)}
                  </div>
                  <div
                    className={`text-xs font-semibold ${
                      holdingsReturnTotal.pct == null
                        ? 'text-navy-400'
                        : holdingsReturnTotal.pct >= 0
                          ? 'text-emerald-600'
                          : 'text-red-600'
                    }`}
                  >
                    {fmtPct(holdingsReturnTotal.pct)}
                  </div>
                </div>
              </div>
            </div>

            {/* Desktop: full table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy/10 text-left text-[11px] uppercase tracking-[0.12em] text-navy-400">
                    <th className="py-2 pr-4">Ticker</th>
                    <th className="py-2 pr-4">Sector</th>
                    <th className="py-2 pr-4 text-right">Shares</th>
                    <th className="py-2 pr-4 text-right">Avg Cost</th>
                    <th className="py-2 pr-4 text-right">Price</th>
                    <th className="py-2 pr-4 text-right">Value</th>
                    <th className="py-2 pr-4 text-right">Weight</th>
                    <th className="py-2 pr-4 text-right">
                      {RETURN_RANGES.find((r) => r.key === returnRange)?.label} $
                    </th>
                    <th className="py-2 pr-4 text-right">
                      {RETURN_RANGES.find((r) => r.key === returnRange)?.label} %
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {holdings.map((h) => {
                    const ret = returnForRange(h, returnRange, periodReturns);
                    const up = (ret.pct ?? ret.usd ?? 0) >= 0;
                    const marketValue =
                      h.marketValue ??
                      (h.shares != null && h.price != null ? h.shares * h.price : null);
                    const hasCashBreakdown = h.isCash && cashYield;
                    return (
                      <Fragment key={h.ticker}>
                        <tr
                          onClick={() => {
                            if (h.isCash) {
                              if (hasCashBreakdown) setCashExpanded((v) => !v);
                            } else {
                              setSelectedHolding(h);
                            }
                          }}
                          className={`${
                            h.isCash
                              ? hasCashBreakdown
                                ? 'bg-gold-100/40 cursor-pointer hover:bg-gold-100/70'
                                : 'bg-gold-100/40'
                              : 'cursor-pointer hover:bg-navy-50/60'
                          }`}
                        >
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-1 font-medium text-navy">
                              {hasCashBreakdown && (
                                cashExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5 text-navy-400" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 text-navy-400" />
                                )
                              )}
                              {h.ticker}
                            </div>
                            <div className="text-xs text-navy-400 truncate max-w-[220px]">
                              {h.name}
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-xs text-navy-400">
                            {h.sector || '—'}
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums">
                            {h.isCash ? '—' : h.shares ?? '—'}
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums">
                            {h.isCash ? '—' : fmtMoney(h.costBasis)}
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums">
                            {h.isCash ? '—' : fmtMoney(h.price)}
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums font-semibold">
                            {fmtMoney(marketValue)}
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums text-navy-400">
                            {h.portfolioPct != null ? `${h.portfolioPct.toFixed(2)}%` : '—'}
                          </td>
                          <td
                            className={`py-3 pr-4 text-right tabular-nums font-semibold ${
                              h.isCash || ret.usd == null
                                ? 'text-navy-400'
                                : up
                                ? 'text-emerald-600'
                                : 'text-red-600'
                            }`}
                          >
                            {h.isCash ? '—' : fmtMoney(ret.usd)}
                          </td>
                          <td
                            className={`py-3 pr-4 text-right tabular-nums font-semibold ${
                              h.isCash || ret.pct == null
                                ? 'text-navy-400'
                                : up
                                ? 'text-emerald-600'
                                : 'text-red-600'
                            }`}
                          >
                            {h.isCash ? '—' : fmtPct(ret.pct)}
                          </td>
                        </tr>
                        {hasCashBreakdown && cashExpanded && (
                          <>
                            <CashSubRow
                              ticker="BDA"
                              name="GS Bank USA Deposit"
                              sector="Cash and Cash Equivalents"
                              balance={cashYield.bdaEndingBalance}
                              interest={cashYield.bdaTotalInterest}
                              rate={
                                cashYield.bdaApy != null
                                  ? `${(cashYield.bdaApy * 100).toFixed(2)}%`
                                  : '—'
                              }
                            />
                            <CashSubRow
                              ticker="FGTXX"
                              name="GS FS Government MMF — Institutional"
                              sector="Cash and Cash Equivalents"
                              balance={cashYield.fgtxxEndingBalance}
                              interest={cashYield.fgtxxTotalInterest}
                              rate={
                                cashYield.fgtxxLatestYield != null
                                  ? `${cashYield.fgtxxLatestYield.toFixed(2)}%`
                                  : '—'
                              }
                            />
                          </>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-navy-100">
                    <td colSpan={5} className="py-3 pr-4 font-bold text-navy">
                      Total ({holdings.length} positions)
                    </td>
                    <td className="py-3 pr-4 text-right font-bold text-navy tabular-nums">
                      {fmtMoney(displayedTotal)}
                    </td>
                    <td />
                    <td
                      className={`py-3 pr-4 text-right font-bold tabular-nums ${
                        holdingsReturnTotal.usd == null
                          ? 'text-navy-400'
                          : holdingsReturnTotal.usd >= 0
                            ? 'text-emerald-600'
                            : 'text-red-600'
                      }`}
                    >
                      {fmtMoney(holdingsReturnTotal.usd)}
                    </td>
                    <td
                      className={`py-3 pr-4 text-right font-bold tabular-nums ${
                        holdingsReturnTotal.pct == null
                          ? 'text-navy-400'
                          : holdingsReturnTotal.pct >= 0
                            ? 'text-emerald-600'
                            : 'text-red-600'
                      }`}
                    >
                      {fmtPct(holdingsReturnTotal.pct)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            </>
          )}
          <div className="mt-4 text-xs text-navy-400">
            {data?.source === 'db' ? (
              <>
                Holdings and cash live in the database — buy and sell on the
                Trade Approval page and they post to the book when an exec marks
                the trade filled. Prices are live from Google. Tap any holding
                to see company details. The CASH line is the FGTXX money-market
                balance.
              </>
            ) : (
              <>
                Positions and prices are read live from the fund's Google Sheet.
                To add or remove a position, edit the sheet directly. Tap any
                holding to see company details. The sheet's CASH line is the
                leftover FGTXX money-market balance; BDA was drawn down to zero
                buying the positions above.
              </>
            )}
            {estimatedCashInterest > 0 && (
              <>
                {' '}An estimated{' '}
                <span className="font-semibold text-navy">
                  ≈{fmtMoney(estimatedCashInterest, { cents: true })}
                </span>{' '}
                of cash-sleeve interest is added on top of the sheet
                total for the headline figures (see card below).
              </>
            )}
          </div>
        </Card>

        {cashYield && cashYield.daysSimulated > 0 && (
          <CashInterestCard
            data={cashYield}
            canRefresh={isPmOrAbove}
            canBackfill={isSuperAdmin}
            onReload={reloadCashYield}
          />
        )}
      </div>
        </>
      )}

      <HoldingDetailModal
        holding={selectedHolding}
        onClose={() => {
          setSelectedHolding(null);
          load();
        }}
        onChanged={load}
      />
    </>
  );
}

// The book an analyst sees. Officers keep the chart, the ledger, and
// the treasury sleeves; this is holdings, one cash figure, and the total.
function SimplePortfolio({ data, loading, error, onRefresh }) {
  const [selected, setSelected] = useState(null);
  const holdings = data?.holdings || [];
  const equities = holdings.filter((h) => !h.isCash);
  const cashRow = holdings.find((h) => h.isCash);
  const total = data?.totals?.totalValue ?? null;
  const cash = data?.totals?.cashValue ?? cashRow?.marketValue ?? null;

  return (
    <>
      <PageHeader
        kicker="The Live Book"
        title="Portfolio"
        subtitle="Holdings, weight, and return."
        actions={
          <Button onClick={onRefresh} variant="gold" disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-navy-400">
            Total value
          </div>
          <div className="mt-2 font-serif text-4xl font-medium tabular-nums text-navy">
            {total != null ? fmtMoney(total) : '—'}
          </div>
        </Card>
        <Card>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-navy-400">
            Cash
          </div>
          <div className="mt-2 font-serif text-4xl font-medium tabular-nums text-navy">
            {cash != null ? fmtMoney(cash) : '—'}
          </div>
        </Card>
      </div>
      <div className="mt-6">
        <Card title="Holdings">
          {loading && equities.length === 0 ? (
            <div className="py-8 text-center text-navy-400">Loading the book…</div>
          ) : equities.length === 0 ? (
            <div className="py-8 text-center text-navy-400">No positions found.</div>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {equities.map((h) => (
                  <button
                    key={h.ticker}
                    type="button"
                    onClick={() => setSelected(h)}
                    className="w-full rounded-lg border border-navy-100 bg-white px-3 py-3 text-left"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold text-navy">{h.ticker}</div>
                        <div className="truncate text-xs text-navy-400">{h.name}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs tabular-nums text-navy-400">
                          {h.portfolioPct != null ? `${h.portfolioPct.toFixed(1)}%` : '—'}
                        </div>
                        <ReturnText value={h.percentReturn} />
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-navy/10 text-left text-[11px] uppercase tracking-[0.12em] text-navy-400">
                      <th className="py-2 pr-4">Ticker</th>
                      <th className="py-2 pr-4">Name</th>
                      <th className="py-2 pr-4 text-right">Weight</th>
                      <th className="py-2 pr-4 text-right">Return</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-navy-50">
                    {equities.map((h) => (
                      <tr
                        key={h.ticker}
                        onClick={() => setSelected(h)}
                        className="cursor-pointer hover:bg-navy-50/60"
                      >
                        <td className="py-3 pr-4 font-medium text-navy">{h.ticker}</td>
                        <td className="py-3 pr-4 text-navy-400">{h.name}</td>
                        <td className="py-3 pr-4 text-right tabular-nums text-navy-400">
                          {h.portfolioPct != null ? `${h.portfolioPct.toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-3 text-right">
                          <ReturnText value={h.percentReturn} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>
      <HoldingDetailModal
        holding={selected}
        onClose={() => setSelected(null)}
        onChanged={onRefresh}
      />
    </>
  );
}

function ReturnText({ value }) {
  if (value == null || !Number.isFinite(Number(value))) {
    return <span className="tabular-nums text-navy-400">—</span>;
  }
  const n = Number(value);
  return (
    <span className={`font-semibold tabular-nums ${n >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
      {fmtPct(n)}
    </span>
  );
}

// Inline sub-row rendered under the CASH row when the user expands it.
// Sits inside the same <tbody> as the rest of the holdings table, so it
// inherits the column widths and divider styling — the only deltas are
// a slightly lighter background and the indented ticker chevron.
function CashSubRow({ ticker, name, sector, balance, interest, rate }) {
  return (
    <tr className="bg-gold-100/15">
      <td className="py-2 pr-4 pl-6">
        <div className="font-semibold text-navy">↳ {ticker}</div>
        <div className="text-xs text-navy-400 truncate max-w-[220px]">{name}</div>
      </td>
      <td className="py-2 pr-4 text-xs text-navy-400">{sector || '—'}</td>
      <td className="py-2 pr-4 text-right tabular-nums">—</td>
      <td className="py-2 pr-4 text-right tabular-nums">—</td>
      <td className="py-2 pr-4 text-right tabular-nums">—</td>
      <td className="py-2 pr-4 text-right tabular-nums font-semibold">
        {fmtMoney(balance, { cents: true })}
      </td>
      <td className="py-2 pr-4 text-right tabular-nums text-navy-400">—</td>
      <td className="py-2 pr-4 text-right tabular-nums text-navy-400">
        {interest != null ? `≈${fmtMoney(interest, { cents: true })}` : '—'}
      </td>
      <td className="py-2 pr-4 text-right tabular-nums text-navy-400">{rate}</td>
    </tr>
  );
}

// Mobile equivalent — compact card with the same fields the sub-row
// shows on desktop.
function CashSubCard({ ticker, name, balance, interest, rate }) {
  return (
    <div className="ml-3 rounded-lg border border-navy-100 bg-gold-100/15 px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-navy">↳ {ticker}</div>
          <div className="truncate text-[11px] text-navy-400">{name}</div>
        </div>
        <div className="text-right tabular-nums">
          <div className="font-semibold text-navy">
            {fmtMoney(balance, { cents: true })}
          </div>
          <div className="text-[10px] text-navy-400">{rate}</div>
        </div>
      </div>
      <div className="mt-1 text-[11px] text-navy-400">
        est. interest ≈{fmtMoney(interest, { cents: true })}
      </div>
    </div>
  );
}

function SectorAllocation({ holdings, totalValue }) {
  // Aggregate market value by sector. Cash is counted as its own slice so the
  // chart sums to 100% of the portfolio.
  const slices = useMemo(() => {
    if (!holdings || holdings.length === 0 || !totalValue) return [];
    const bySector = new Map();
    for (const h of holdings) {
      const mv =
        h.marketValue ??
        (h.shares != null && h.price != null ? h.shares * h.price : 0);
      if (!mv) continue;
      const key = h.isCash ? 'Cash' : h.sector && h.sector.trim() ? h.sector.trim() : 'Unclassified';
      bySector.set(key, (bySector.get(key) || 0) + mv);
    }
    return [...bySector.entries()]
      .map(([name, value]) => ({
        name,
        value,
        pct: (value / totalValue) * 100,
      }))
      .sort((a, b) => b.value - a.value);
  }, [holdings, totalValue]);

  if (slices.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">
        Allocation
      </h2>
      <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
        {slices.map((s) => (
          <div key={s.name}>
            <div className="text-[11px] text-navy-400">{s.name}</div>
            <div className="mt-0.5 font-serif text-2xl font-medium tabular-nums text-navy">
              {s.pct.toFixed(0)}%
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Portfolio hero ────────────────────────────────────────────────────
// Fund value, since-inception and week-over-week deltas, a 90-day
// sparkline, and cash / positions / capital. Matches the dashboard hero.
function PortfolioHero({
  totalValue,
  lifetimeGainLoss,
  lifetimeGainLossPct,
  cashValue,
  holdingsCount,
  history,
  today,
}) {
  const isUp = (lifetimeGainLoss ?? 0) >= 0;
  const cashPct = totalValue > 0 ? (cashValue / totalValue) * 100 : null;

  // WoW delta — same logic as Dashboard: subtract cash flows inside the window.
  const weekPct = useMemo(() => {
    if (!history || history.length < 2 || totalValue == null) return null;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from =
      [...history].reverse().find((h) => h.date <= weekAgo) || history[0];
    if (!from || from.value <= 0) return null;
    const cfInWindow = CASH_FLOWS.filter(
      (cf) => cf.date > weekAgo && cf.date <= now
    ).reduce((s, cf) => s + cf.amount, 0);
    return ((totalValue - cfInWindow - from.value) / from.value) * 100;
  }, [history, totalValue]);

  // 90-day sparkline series.
  const sparkData = useMemo(() => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return (history || [])
      .filter((h) => h.date >= cutoff)
      .map((h) => ({ ts: h.date.getTime(), value: h.value }));
  }, [history]);

  if (totalValue == null) return null;

  return (
    <div className="rounded-2xl bg-white px-6 py-7 md:px-8 md:py-8">
      <div className="grid items-end gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
        <div className="min-w-0">
          <div className="font-serif text-5xl font-medium leading-none tracking-tight tabular-nums text-navy md:text-6xl">
            {fmtMoney(totalValue)}
          </div>
          <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <div className="text-[11px] text-navy-400">Since inception</div>
              <div className={`mt-0.5 font-serif text-xl tabular-nums ${isUp ? 'text-emerald-700' : 'text-red-700'}`}>
                {fmtPct(lifetimeGainLossPct)}
              </div>
            </div>
            {today && (
              <div>
                <div className="text-[11px] text-navy-400">Today</div>
                <div className={`mt-0.5 font-serif text-xl tabular-nums ${today.diff >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {fmtPct(today.pct)}
                </div>
              </div>
            )}
            {weekPct != null && (
              <div>
                <div className="text-[11px] text-navy-400">This week</div>
                <div className={`mt-0.5 font-serif text-xl tabular-nums ${weekPct >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {fmtPct(weekPct)}
                </div>
              </div>
            )}
          </div>
          <div className="mt-8 flex flex-wrap gap-8 border-t border-navy/10 pt-5">
            <HeroStat label="Cash" value={cashPct != null ? `${cashPct.toFixed(0)}%` : '—'} />
            <HeroStat label="Positions" value={holdingsCount} />
            <HeroStat label="Capital" value={fmtMoney(TOTAL_INVESTED)} />
          </div>
        </div>

        <div className="flex flex-col justify-center">
          <div className="mb-1 text-[11px] text-navy-400">Last 90 days</div>
          {sparkData.length > 1 ? (
            <div className="h-28 -mx-1 md:h-36">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={sparkData}
                  margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
                >
                  <defs>
                    <linearGradient id="heroSparkNavy" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={NAVY.DEFAULT} stopOpacity={0.18} />
                      <stop offset="100%" stopColor={NAVY.DEFAULT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="ts" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid rgba(13,22,38,0.08)',
                      background: 'white',
                      color: '#0D1626',
                      fontSize: 12,
                      boxShadow: '0 8px 24px rgba(13,22,38,0.08)',
                    }}
                    labelFormatter={(ts) => format(new Date(ts), 'MMM d')}
                    formatter={(v) => [fmtMoney(v), 'Value']}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={NAVY.DEFAULT}
                    strokeWidth={1.75}
                    fill="url(#heroSparkNavy)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-28 items-center justify-center text-xs text-navy-400 md:h-36">
              Collecting snapshots…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HeroStat({ label, value }) {
  return (
    <div>
      <div className="text-[11px] text-navy-400">{label}</div>
      <div className="mt-1 font-serif text-2xl font-medium tabular-nums tracking-tight text-navy">
        {value}
      </div>
    </div>
  );
}
