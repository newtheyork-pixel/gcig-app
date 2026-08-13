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
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { TrendingUp, TrendingDown, RefreshCw, ExternalLink } from 'lucide-react';
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
import { ChevronDown, ChevronRight } from 'lucide-react';

// Operational ranks for the client-side PM+ gate. Mirrors server ROLE_RANK;
// the server is still the source of truth (betas endpoint requires the role).
const CLIENT_ROLE_RANK = {
  President: 10,
  CIO: 9,
  SeniorPortfolioManager: 8,
  PortfolioManager: 7,
  SeniorAnalyst: 6,
  Analyst: 5,
  JuniorAnalyst: 4,
  ChiefOfCommunication: 2,
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
  const canSeeRisk = (CLIENT_ROLE_RANK[user?.role] || 0) >= 7;
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
    reloadCashYield();
    reloadPeriodReturns();
  }, []);

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
  // estimate. Used for the hero, the totals row, and the return tiles.
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
  const isUp = (lifetimeGainLoss ?? 0) >= 0;

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

  // Normalize history (with real Date objects) once.
  // equity = totalValue - cashValue (falls back to total if cash is unknown).
  const fullHistory = useMemo(
    () =>
      history.map((s) => {
        const total = Number(s.totalValue.toFixed(2));
        const cash = s.cashValue != null ? Number(s.cashValue.toFixed(2)) : 0;
        return {
          date: new Date(s.date),
          value: total,
          cash,
          equity: Math.max(total - cash, 0),
        };
      }),
    [history]
  );

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

  // Adjusted return: the real return with the cash drag added back. The
  // assumption is that the idle cash sleeve, had it actually been deployed,
  // would have earned at the equity sleeve's rate — so we credit
  // avgCashRatio × equityReturn on top of what the book actually did.
  // Answers "what would the headline look like if we hadn't been sitting
  // on cash all year?" — and by construction it lands above the real
  // return whenever the equity sleeve is up.
  const adjustedReturn = useMemo(() => {
    if (!equityReturn || avgCashRatio == null || lifetimeGainLossPct == null)
      return null;
    const pct = lifetimeGainLossPct + avgCashRatio * equityReturn.pct;
    return { pct, cashRatio: avgCashRatio };
  }, [equityReturn, avgCashRatio, lifetimeGainLossPct]);

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
  // Both the historical snapshots and the live /quotes total are raw
  // sheet totals now (the server no longer overlays simulated cash
  // interest), so they're directly comparable day-over-day.
  const dailyChange = useMemo(() => {
    if (!data || fullHistory.length < 2) return null;
    const liveTotal = data.totals?.totalValue;
    if (liveTotal == null) return null;
    const todayTotal = liveTotal + estimatedCashInterest;
    const todayIso = new Date().toISOString().slice(0, 10);
    for (let i = fullHistory.length - 1; i >= 0; i--) {
      const snap = fullHistory[i];
      const snapIso = snap.date.toISOString().slice(0, 10);
      if (snapIso === todayIso) continue;
      const day = snap.date.getDay();
      if (day === 0 || day === 6) continue;
      const diff = todayTotal - snap.value;
      const base = snap.equity;
      const pct = base > 0 ? (diff / base) * 100 : 0;
      return { diff, pct };
    }
    return null;
  }, [data, fullHistory, estimatedCashInterest]);

  // Annualized Sharpe. Numerator comes from the Adjusted Return tile's
  // lifetime % (annualized by trading days in the sample) so the headline
  // return on the page matches what's in the Sharpe ratio. Volatility is
  // measured off equity-base daily returns — drag-free, consistent with
  // the adjusted framing. Cash flows are subtracted from the daily Δ so
  // infusions don't masquerade as performance.
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

    // ALL range: the header should match the Total Gain/Loss card.
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

  return (
    <>
      <PageHeader
        kicker="The Live Book"
        title="Portfolio"
        subtitle={
          (data?.source === 'db'
            ? 'Live · holdings from the database, prices from Google'
            : 'Live from Google Sheets') +
          (data?.fetchedAt
            ? ` · fetched ${format(new Date(data.fetchedAt), 'h:mm:ss a')}`
            : '')
        }
        actions={
          <div className="flex gap-2">
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

      {/* Full-width editorial hero — big AUM + since-inception in a navy
          gradient card, same vibe as the Dashboard hero but page-scoped. */}
      <PortfolioHero
        totalValue={displayedTotal}
        lifetimeGainLoss={lifetimeGainLoss}
        lifetimeGainLossPct={lifetimeGainLossPct}
        cashValue={totals.cashValue}
        holdingsCount={holdings.filter((h) => !h.isCash).length}
        history={fullHistory}
      />

      {/* Five supporting metrics below the hero. */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryTile
          kicker="Daily Change"
          value={dailyChange ? fmtMoney(dailyChange.diff) : '—'}
          sub={dailyChange ? fmtPct(dailyChange.pct) : null}
          tone={dailyChange ? (dailyChange.diff >= 0 ? 'good' : 'bad') : 'neutral'}
          icon={dailyChange ? (dailyChange.diff >= 0 ? TrendingUp : TrendingDown) : null}
        />
        <SummaryTile
          kicker="Total Gain/Loss"
          value={fmtMoney(lifetimeGainLoss)}
          sub={fmtPct(lifetimeGainLossPct)}
          footnote={`vs. ${fmtMoney(TOTAL_INVESTED)} invested`}
          tone={isUp ? 'good' : 'bad'}
          icon={isUp ? TrendingUp : TrendingDown}
        />
        <SummaryTile
          kicker="Real Return"
          value={lifetimeGainLossPct != null ? fmtPct(lifetimeGainLossPct) : '—'}
          sub={lifetimeGainLoss != null ? fmtMoney(lifetimeGainLoss) : null}
          footnote="Actual book return · cash drag included"
          tone={
            lifetimeGainLoss == null
              ? 'neutral'
              : lifetimeGainLoss >= 0
                ? 'good'
                : 'bad'
          }
          icon={
            lifetimeGainLoss == null
              ? null
              : lifetimeGainLoss >= 0
                ? TrendingUp
                : TrendingDown
          }
        />
        <SummaryTile
          kicker="Adjusted Return"
          value={adjustedReturn ? fmtPct(adjustedReturn.pct) : '—'}
          sub={equityReturn ? `${fmtPct(equityReturn.pct)} equity-only` : null}
          footnote={
            adjustedReturn
              ? `Adds back ${(adjustedReturn.cashRatio * 100).toFixed(1)}% avg cash drag at the equity rate`
              : 'Adds back avg cash drag at the equity rate'
          }
          tone={
            adjustedReturn == null
              ? 'neutral'
              : adjustedReturn.pct >= 0
                ? 'good'
                : 'bad'
          }
          icon={
            adjustedReturn == null
              ? null
              : adjustedReturn.pct >= 0
                ? TrendingUp
                : TrendingDown
          }
        />
        <SummaryTile
          kicker="Sharpe Ratio"
          value={sharpe != null ? sharpe.toFixed(2) : '—'}
          footnote={
            sharpe != null
              ? `Equity sleeve · Rf = ${(RISK_FREE_RATE * 100).toFixed(2)}%`
              : null
          }
          tone={sharpe == null ? 'neutral' : sharpe >= 1 ? 'good' : sharpe >= 0 ? 'neutral' : 'bad'}
        />
      </div>

      <div className="mt-6">
        <Card>
          {/* Header row: title + perf summary on left, range selector on right */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-navy">Performance Over Time</div>
              {rangeChange && (
                <>
                  <div
                    className={`mt-1 text-sm font-semibold ${
                      rangeChange.diff >= 0 ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {rangeChange.diff >= 0 ? '+' : ''}
                    {fmtMoney(rangeChange.diff)} ({rangeChange.diff >= 0 ? '+' : ''}
                    {rangeChange.pct.toFixed(2)}%){' '}
                    <span className="text-navy-400 font-normal">
                      in {RANGES.find((r) => r.key === range)?.label}
                    </span>
                  </div>
                  {range === 'ALL' ? (
                    <div className="mt-0.5 text-[11px] text-navy-400">
                      vs. {fmtMoney(TOTAL_INVESTED)} invested
                    </div>
                  ) : rangeChange.cashFlowInRange > 0 ? (
                    <div className="mt-0.5 text-[11px] text-navy-400">
                      Excludes {fmtMoney(rangeChange.cashFlowInRange)} capital infusion
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex rounded-lg border border-navy-100 bg-white p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                    range === r.key
                      ? 'bg-navy text-white'
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
                  className={`rounded-full px-2 py-0.5 font-semibold ${
                    versusBenchmark.gap >= 0
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-rose-50 text-rose-700'
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

      {canSeeRisk && (
        <RiskPanel
          holdings={holdings}
          totals={totals}
          history={fullHistory}
          cashFlows={CASH_FLOWS}
        />
      )}

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
              <div className="flex rounded-lg border border-navy-100 bg-white p-0.5">
                {RETURN_RANGES.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setReturnRange(r.key)}
                    className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                      returnRange === r.key
                        ? 'bg-navy text-white'
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
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
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
                            <div className="flex items-center gap-1 font-bold text-navy">
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
                Positions and prices are read live from the club's Google Sheet.
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

// Palette for sector slices — navy/gold anchors plus enough supporting hues
// to cover typical S&P sectors without repeating.
const SECTOR_COLORS = [
  NAVY.DEFAULT, // navy
  GOLD.DEFAULT, // gold
  '#3B5998',
  '#8C99BB',
  '#B48A3C',
  '#4A6AA8',
  '#6E7FA8',
  '#D4B76B',
  '#2E4375',
  '#A88C3C',
  '#7C8FB8',
];

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

  const topConcentration = slices[0];
  const concentrationWarning = topConcentration.pct > 25;

  return (
    <div className="mt-6">
      <Card title="Sector Allocation">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={1}
                >
                  {slices.map((_, i) => (
                    <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v, name) => [
                    `${v.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                      maximumFractionDigits: 0,
                    })} (${((v / totalValue) * 100).toFixed(2)}%)`,
                    name,
                  ]}
                  contentStyle={{
                    borderRadius: 8,
                    borderColor: GOLD.DEFAULT,
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div>
            <ul className="space-y-2">
              {slices.map((s, i) => (
                <li key={s.name} className="flex items-center gap-3">
                  <span
                    className="h-3 w-3 rounded-sm"
                    style={{ backgroundColor: SECTOR_COLORS[i % SECTOR_COLORS.length] }}
                  />
                  <span className="flex-1 text-sm font-semibold text-navy truncate">
                    {s.name}
                  </span>
                  <span className="text-xs tabular-nums text-navy-400">
                    {s.value.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                      maximumFractionDigits: 0,
                    })}
                  </span>
                  <span className="w-14 text-right text-sm font-bold tabular-nums text-navy">
                    {s.pct.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
            {concentrationWarning && (
              <div className="mt-4 rounded-lg border border-gold-300 bg-gold-100/40 px-3 py-2 text-xs text-navy">
                <strong>Heads up:</strong> {topConcentration.name} is{' '}
                {topConcentration.pct.toFixed(1)}% of the portfolio — watch
                concentration risk.
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

// Editorial summary tile — small-caps kicker, serif number, optional sub-
// value and footnote. Used for the wide metric row at the top of Portfolio.
function SummaryTile({ kicker, value, sub, footnote, tone = 'neutral', icon: Icon }) {
  const toneClass =
    tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : 'text-navy';
  return (
    <div className="rounded-xl border border-navy-100 bg-white p-5 shadow-card">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
        <span className="h-px w-4 bg-gold" />
        {kicker}
      </div>
      <div className={`mt-3 flex items-center gap-2 font-serif text-3xl font-semibold tabular-nums ${toneClass}`}>
        {Icon && <Icon className="h-5 w-5" />}
        {value}
      </div>
      {sub && (
        <div className={`mt-1 text-xs font-semibold tabular-nums ${toneClass}`}>
          {sub}
        </div>
      )}
      {footnote && (
        <div className="mt-1 text-[10px] text-navy-400">{footnote}</div>
      )}
    </div>
  );
}

// ─── Portfolio hero ────────────────────────────────────────────────────
// Full-width editorial banner at the top of the Portfolio page: big AUM in
// serif, since-inception + WoW deltas as chips, 90-day sparkline, and a
// bottom strip with cash / positions / invested. Same visual language as
// the Dashboard hero so the two feel like siblings.
function PortfolioHero({
  totalValue,
  lifetimeGainLoss,
  lifetimeGainLossPct,
  cashValue,
  holdingsCount,
  history,
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
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy-700 to-navy-800 text-white shadow-xl">
      {/* faint gold grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            `linear-gradient(to right, ${GOLD.DEFAULT} 1px, transparent 1px), linear-gradient(to bottom, ${GOLD.DEFAULT} 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative grid gap-6 p-6 md:grid-cols-[1.3fr_1fr] md:gap-10 md:p-8">
        {/* Left */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
            <span className="h-px w-5 bg-gold" />
            Fund Value
          </div>
          <div className="mt-3 font-serif text-4xl font-semibold leading-none tabular-nums md:text-6xl">
            {fmtMoney(totalValue)}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
                isUp
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-red-500/20 text-red-300'
              }`}
            >
              {isUp ? (
                <TrendingUp className="h-3.5 w-3.5" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5" />
              )}
              {fmtPct(lifetimeGainLossPct)} since inception
            </span>
            {weekPct != null && (
              <span className="text-xs text-navy-100">
                {fmtPct(weekPct)} WoW
              </span>
            )}
          </div>

          <div className="mt-6 flex flex-wrap gap-6 border-t border-white/10 pt-4 text-sm">
            <HeroStat
              label="Cash"
              value={cashPct != null ? `${cashPct.toFixed(0)}%` : '—'}
            />
            <HeroStat label="Positions" value={holdingsCount} />
            <HeroStat label="Invested" value={fmtMoney(TOTAL_INVESTED)} />
          </div>
        </div>

        {/* Right — sparkline */}
        <div className="flex flex-col justify-center">
          {sparkData.length > 1 ? (
            <div className="h-28 md:h-36 -mx-1">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={sparkData}
                  margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
                >
                  <defs>
                    <linearGradient id="heroSparkGold" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={GOLD.DEFAULT} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={GOLD.DEFAULT} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="ts" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: `1px solid ${GOLD.DEFAULT}`,
                      background: 'rgba(27,42,74,0.92)',
                      color: 'white',
                      fontSize: 11,
                    }}
                    labelFormatter={(ts) => format(new Date(ts), 'MMM d')}
                    formatter={(v) => [fmtMoney(v), 'Value']}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={GOLD.DEFAULT}
                    strokeWidth={2}
                    fill="url(#heroSparkGold)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-28 items-center justify-center text-xs text-navy-200 md:h-36">
              Collecting snapshots…
            </div>
          )}
          <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold/70">
            Last 90 days · daily snapshots
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroStat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold">
        {label}
      </div>
      <div className="mt-1 font-serif text-xl font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}
