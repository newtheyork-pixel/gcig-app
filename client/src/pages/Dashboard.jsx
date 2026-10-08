import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowUpRight, Newspaper, X } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// ---------------------------------------------------------------------------
// Home. Pulls from three existing endpoints:
//   /dashboard         next pitch, upcoming events (+ pitches), activity, DIR
//   /holdings/quotes   live AUM, cash, holdings list → used for movers
//   /holdings/history  sparkline + WoW / MoM / YTD deltas
// All requests are cheap (server-cached). If any one fails the rest still
// renders; the affected section simply hides.
// ---------------------------------------------------------------------------

// Starting capital + cash infusions the club has added. Mirrors Portfolio.jsx.
const INITIAL_CAPITAL = 100_000;
const CASH_FLOWS = [
  { date: new Date('2026-01-29T12:00:00Z'), amount: 25_000 },
];
const TOTAL_INVESTED =
  INITIAL_CAPITAL + CASH_FLOWS.reduce((s, cf) => s + cf.amount, 0);

function fmtMoney(n, opts = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

function localDay(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function utcDay(d) {
  return d.toISOString().slice(0, 10);
}

function fmtPct(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export default function Dashboard() {
  const { user, isPmOrAbove } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [quotes, setQuotes] = useState(null);
  const [history, setHistory] = useState([]);
  const [earnings, setEarnings] = useState(null); // { upcoming: [...] }
  // Day in Review fetched separately so the slow LLM call doesn't
  // block the rest of the dashboard. Loading state lets the card
  // render a placeholder instead of disappearing entirely.
  const [dirData, setDirData] = useState(null);
  const [dirLoading, setDirLoading] = useState(true);
  // FRED macro snapshot. Cheap (1h server cache). Hidden when
  // FRED_API_KEY isn't configured — endpoint returns configured: false.
  const [macro, setMacro] = useState(null);
  // Estimated cash-sleeve interest, added on top of the sheet total for
  // the headline figure (matches Portfolio.jsx, per the treasurer).
  const [cashYield, setCashYield] = useState(null);

  useEffect(() => {
    api.get('/dashboard').then((r) => setDashboard(r.data)).catch(() => setDashboard({}));
    api.get('/holdings/quotes').then((r) => setQuotes(r.data)).catch(() => setQuotes(null));
    api.get('/holdings/history').then((r) => setHistory(r.data || [])).catch(() => setHistory([]));
    api.get('/holdings/earnings').then((r) => setEarnings(r.data)).catch(() => setEarnings(null));
    api.get('/dashboard/macro').then((r) => setMacro(r.data)).catch(() => setMacro(null));
    // Treasury overlay on the headline. Same officer gate as the
    // portfolio ledger; analysts and the communications / public-relations
    // offices see the marked total, which already includes cash.
    if (isPmOrAbove) {
      api
        .get('/holdings/cash-yield')
        .then((r) => setCashYield(r.data))
        .catch(() => setCashYield(null));
    }
    // DIR runs in parallel with the dashboard request. On cache miss
    // it can take 10-30s; on cache hit it's instant. The page
    // renders without waiting either way.
    setDirLoading(true);
    api
      .get('/dashboard/day-in-review')
      .then((r) => setDirData(r.data))
      .catch(() => setDirData(null))
      .finally(() => setDirLoading(false));
  }, [isPmOrAbove]);

  // Soonest upcoming earnings within the next 30 days — surfaces as a
  // spotlight card when relevant so pitchers don't walk into a pitch
  // the day before a holding reports.
  const nextEarnings = useMemo(() => {
    const list = earnings?.upcoming || [];
    if (list.length === 0) return null;
    const now = new Date();
    const cutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcoming = list
      .map((e) => ({ ...e, dateObj: new Date(`${e.date}T12:00:00Z`) }))
      .filter((e) => e.dateObj >= now && e.dateObj <= cutoff)
      .sort((a, b) => a.dateObj - b.dateObj);
    return upcoming[0] || null;
  }, [earnings]);

  // History in JS dates. /holdings/history returns raw sheet snapshots,
  // which already carry the cash sleeves (leftover FGTXX cash is the
  // sheet's CASH line; the rest became stocks the sheet prices).
  const normalizedHistory = useMemo(
    () =>
      (history || []).map((s) => ({
        date: new Date(s.date),
        value: Number(s.totalValue || 0),
        cash: Number(s.cashValue || 0),
      })),
    [history]
  );

  return (
    <div className="space-y-10">
      <BreakingBanner />

      <Masthead user={user} />

      <PortfolioHero
        totals={quotes?.totals}
        holdings={quotes?.holdings}
        history={normalizedHistory}
        cashInterestEarned={Number(cashYield?.estimatedInterestEarned) || 0}
      />

      {macro?.configured && macro.indicators?.length > 0 && (
        <MacroStrip macro={macro} />
      )}

      {/* DIR text comes from its own endpoint; on the very first load
          of a new ET review-day it can take 10-30s for the LLM to
          finish. The placeholder keeps the slot reserved so the page
          doesn't visibly reshuffle when it lands. Hidden entirely if
          the LLM produced nothing AND we're not still loading. */}
      {dirLoading ? (
        <DayInReviewPlaceholder />
      ) : dirData?.dayInReview ? (
        <DayInReview
          text={dirData.dayInReview}
          generatedAt={dirData.dayInReviewAt}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <OnTheCalendar
          events={dashboard?.upcomingEvents || []}
          nextEarnings={nextEarnings}
        />
        <LatelyFeed activity={dashboard?.activity || []} />
      </div>
    </div>
  );
}

// Breaking-news banner. The server surfaces only the rare, genuinely
// system-shaking story (~1-3 a week; see services/breakingNews.js), and a
// chosen alert persists there for a few days. Self-contained: it fetches on
// mount and renders nothing when there's no live alert (the common case).
// Dismissal is keyed by the story itself (its URL), not the calendar day —
// the same alert stays dismissed across its multi-day run, while a new
// story always reappears.
function BreakingBanner() {
  const [headline, setHeadline] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/dashboard/breaking-news')
      .then((r) => {
        if (cancelled) return;
        const h = r.data?.headline || null;
        setHeadline(h);
        if (h?.url && localStorage.getItem('gcig_breaking_dismissed') === h.url) {
          setDismissed(true);
        }
      })
      .catch(() => {
        /* no banner on failure — silence is the right default here */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!headline || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    if (headline.url) {
      try {
        localStorage.setItem('gcig_breaking_dismissed', headline.url);
      } catch {
        /* private mode — dismissal just won't persist */
      }
    }
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-black/[0.08] bg-white px-4 py-3 md:px-5">
      <span className="mt-0.5 flex items-center gap-1.5 rounded-md bg-navy px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white">
        <Newspaper className="h-3.5 w-3.5" />
        Breaking
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={headline.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-start gap-1 text-sm font-semibold leading-snug text-navy hover:text-navy-500 md:text-[15px]"
        >
          <span className="min-w-0">{headline.title}</span>
          <ArrowUpRight className="mt-0.5 h-4 w-4 flex-shrink-0 opacity-60 transition group-hover:opacity-100" />
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-navy-400">
          {headline.source ? <span className="font-semibold">{headline.source}</span> : null}
          {headline.why ? <span>· {headline.why}</span> : null}
        </div>
      </div>
      <button
        onClick={dismiss}
        className="flex-shrink-0 rounded p-1 text-navy-200 transition hover:bg-navy-50 hover:text-navy"
        title="Dismiss this alert"
        aria-label="Dismiss breaking news"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─── Masthead ───────────────────────────────────────────────────────────

function Masthead({ user }) {
  const today = new Date();
  // Personalize with "Mr. Seirer" / "Ms. Austin" when the server's
  // name-gender inference came back confident. Otherwise fall back to
  // the first name — still warm, not generic. Final fallback is "friend"
  // on the vanishingly rare case neither field is present.
  const firstName = user?.firstName || user?.name?.split(' ')[0] || '';
  const greetName = user?.honorificName || firstName || 'friend';
  const hour = today.getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="text-[13px] text-navy-400">{format(today, 'EEEE, MMMM d')}</div>
        <h1 className="mt-2 font-serif text-3xl font-medium leading-none tracking-tight text-navy md:text-[2.5rem]">
          {hello}, {greetName}
        </h1>
      </div>
    </div>
  );
}

// ─── Portfolio hero ─────────────────────────────────────────────────────

function PortfolioHero({ totals, holdings, history, cashInterestEarned = 0 }) {
  const totalValue = totals?.totalValue;
  const cashValue = totals?.cashValue;
  const nonCashHoldings = (holdings || []).filter((h) => !h.isCash);

  // Headline fund value adds the estimated cash-sleeve interest on top
  // of the sheet total, per the treasurer's instruction (same as
  // Portfolio.jsx). Kept consistent everywhere the figure is shown.
  const displayedValue =
    totalValue != null ? totalValue + cashInterestEarned : null;

  // Return metrics. Lifetime goes against total invested capital (100k
  // start + infusions). Daily / weekly / YTD use raw sheet snapshots.
  const lifetimeDelta =
    displayedValue != null ? displayedValue - TOTAL_INVESTED : null;
  const lifetimePct =
    lifetimeDelta != null && TOTAL_INVESTED > 0
      ? (lifetimeDelta / TOTAL_INVESTED) * 100
      : null;

  const { weekPct, ytdPct } = useMemo(() => {
    // Period returns use the marked book, not the headline. The headline
    // adds the whole cash-interest estimate, and the snapshots never
    // carried it — the server took that overlay off because it
    // double-counted. Diffing the estimate against last week's raw
    // snapshot books every dollar of interest as if it arrived this week.
    if (!history || history.length < 2 || totalValue == null)
      return { weekPct: null, ytdPct: null };
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const findOnOrBefore = (target) =>
      [...history].reverse().find((h) => h.date <= target) || history[0];
    // Subtract capital infusions that landed inside the window — they
    // aren't market returns. Matches the logic in Portfolio.jsx.
    const pct = (from, fromDate) => {
      if (!from || from.value <= 0) return null;
      const cfInWindow = CASH_FLOWS.filter(
        (cf) => cf.date > fromDate && cf.date <= now
      ).reduce((s, cf) => s + cf.amount, 0);
      const adjustedDelta = totalValue - cfInWindow - from.value;
      return (adjustedDelta / from.value) * 100;
    };
    return {
      weekPct: pct(findOnOrBefore(weekAgo), weekAgo),
      ytdPct: pct(findOnOrBefore(yearStart), yearStart),
    };
  }, [history, totalValue]);

  const cashPct = totalValue > 0 ? (cashValue / totalValue) * 100 : null;

  const sparkData = useMemo(() => {
    // Last 90 days, then today. Snapshots stop at the last close, so a
    // chart that ends there sits a session behind the figure beside it.
    // Today's point is the marked total, not the headline: the interest
    // estimate is not in any earlier point, and adding it here draws a
    // cliff across the last segment.
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const rows = (history || [])
      .filter((h) => h.date >= cutoff)
      .map((h) => ({ ts: h.date.getTime(), value: h.value }));
    if (totalValue == null) return rows;
    const now = new Date();
    const todayKey = localDay(now);
    const last = rows[rows.length - 1];
    const lastKey = last ? utcDay(new Date(last.ts)) : null;
    if (lastKey === todayKey) {
      rows[rows.length - 1] = { ts: now.getTime(), value: totalValue };
    } else {
      rows.push({ ts: now.getTime(), value: totalValue });
    }
    return rows;
  }, [history, totalValue]);

  if (totalValue == null) {
    return (
      <div className="rounded-2xl bg-white px-6 py-8">
        <div className="text-sm text-navy-400">Loading portfolio…</div>
      </div>
    );
  }

  return (
    <Link
      to="/portfolio"
      className="group block overflow-hidden rounded-2xl bg-white transition hover:shadow-[0_12px_40px_rgba(27,42,74,0.06)]"
    >
      {/* Gold is the fund's second color. The bar and the chart
          field are where it shows, so the paper page has one warm note. */}
      <div className="h-1 bg-gold" />
      <div className="px-6 py-7 md:px-8 md:py-8">
      <div className="grid items-end gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-gold-700">
              The book
            </div>
            <span className="text-[11px] font-medium text-navy-400 opacity-0 transition group-hover:opacity-100">
              Open portfolio
            </span>
          </div>
          <div className="mt-3 font-serif text-5xl font-medium leading-none tracking-tight tabular-nums text-navy md:text-6xl">
            {fmtMoney(displayedValue)}
          </div>
          <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
            <ReturnFigure label="This week" value={weekPct} />
            <ReturnFigure label="Year to date" value={ytdPct} />
            <ReturnFigure label="Since inception" value={lifetimePct} />
          </div>
        </div>

        <div className="min-w-0 rounded-xl bg-gold-100 px-3 pb-2 pt-3">
          <div className="mb-1 text-[11px] text-gold-800">Last 90 days</div>
          {sparkData.length > 1 && (
            <div className="h-36 md:h-44">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sparkData} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="sparkGold" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#C9A84C" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#C9A84C" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="ts" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 10,
                      border: '1px solid rgba(27,42,74,0.08)',
                      background: 'white',
                      color: '#0D1626',
                      fontSize: 12,
                      boxShadow: '0 8px 24px rgba(27,42,74,0.08)',
                    }}
                    labelFormatter={(ts) => format(new Date(ts), 'MMM d')}
                    formatter={(v) => [fmtMoney(v, { cents: true }), 'Value']}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#1B2A4A"
                    strokeWidth={2.25}
                    fill="url(#sparkGold)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 grid gap-6 border-t border-navy/10 pt-5 sm:grid-cols-3">
        <MiniStat label="Cash" value={cashPct != null ? `${cashPct.toFixed(0)}%` : '—'} />
        <MiniStat label="Positions" value={nonCashHoldings.length} />
        <MiniStat label="Capital" value={fmtMoney(TOTAL_INVESTED)} />
      </div>
      <MoversRail holdings={nonCashHoldings} />
      </div>
    </Link>
  );
}

function ReturnFigure({ label, value }) {
  const up = (value ?? 0) >= 0;
  return (
    <div>
      <div className="text-[11px] text-navy-400">{label}</div>
      <div
        className={`mt-0.5 font-serif text-xl tabular-nums ${
          value == null ? 'text-navy-200' : up ? 'text-emerald-700' : 'text-red-700'
        }`}
      >
        {fmtPct(value)}
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div>
      <div className="text-[11px] text-navy-400">{label}</div>
      <div className="mt-1 font-serif text-2xl font-medium tabular-nums tracking-tight text-navy">
        {value}
      </div>
    </div>
  );
}

function MoversRail({ holdings }) {
  // Best and worst since purchase. The figure is cost against the live
  // price, so it is not this week's leader — the label has to say so,
  // or a +56% name reads as the week's move.
  if (!holdings || holdings.length === 0) return null;
  const sorted = [...holdings]
    .filter((h) => Number.isFinite(h.percentReturn))
    .sort((a, b) => b.percentReturn - a.percentReturn);
  if (sorted.length === 0) return null;
  const gainer = sorted[0];
  const worst = sorted[sorted.length - 1];
  return (
    <div className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-navy/10 pt-4">
      <span className="text-[11px] uppercase tracking-[0.14em] text-navy-400">Since purchase</span>
      <Mover holding={gainer} />
      {worst !== gainer && <Mover holding={worst} />}
    </div>
  );
}

function Mover({ holding }) {
  if (!holding) return null;
  const up = (holding.percentReturn ?? 0) >= 0;
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-sm font-semibold text-navy">{holding.ticker}</span>
      <span className={`font-serif text-lg tabular-nums ${up ? 'text-emerald-700' : 'text-red-700'}`}>
        {fmtPct(holding.percentReturn, 1)}
      </span>
      <span className="hidden text-xs text-navy-400 sm:inline">{holding.sector || holding.name}</span>
    </div>
  );
}

// ─── Day in Review ──────────────────────────────────────────────────────

// Slot-reserving placeholder that renders while the DIR endpoint is
// still working. Three pulsing skeleton lines mimic the actual
// paragraph height so the page doesn't jump when the real card lands.
// ─── Macro strip ────────────────────────────────────────────────────────
// Tiny grid of macro indicators (10Y, VIX, USD, oil, CPI). Each tile
// shows the latest reading with a colored day-over-day chip. Designed
// to slot above the Day-in-Review without dominating the page.

function formatAsOf(ind) {
  const d = new Date(`${ind.asOf}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ind.asOf;
  // CPI is a monthly index stamped on the first of its month. "Aug 2026"
  // is the print. "2026-08-01" reads as a daily series that froze.
  if (ind.id === 'CPIAUCNS') return format(d, 'MMM yyyy');
  return format(d, 'MMM d');
}

function MacroStrip({ macro }) {
  const indicators = macro.indicators || [];
  if (indicators.length === 0) return null;

  const formatValue = (ind) => {
    if (ind.unit === '$') return `$${ind.value}`;
    if (ind.unit === '%') return `${ind.value}%`;
    return ind.value;
  };

  const formatChange = (ind) => {
    if (ind.change == null) return null;
    const v = Number(ind.change);
    if (!Number.isFinite(v)) return null;
    const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
    const abs = Math.abs(v).toFixed(2);
    if (ind.unit === '%') return `${sign}${abs}pp`;
    if (ind.unit === '$') return `${sign}$${abs}`;
    return `${sign}${abs}`;
  };

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-gold/40 py-5 sm:grid-cols-3 md:grid-cols-5">
      {indicators.map((ind) => {
        const change = formatChange(ind);
        const tone =
          ind.change == null
            ? 'text-navy-400'
            : Number(ind.change) > 0
              ? 'text-emerald-700'
              : Number(ind.change) < 0
                ? 'text-red-700'
                : 'text-navy-400';
        return (
          <div key={ind.id} className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.14em] text-navy-400">{ind.label}</div>
            <div className="mt-1 font-serif text-2xl font-medium tabular-nums tracking-tight text-navy">
              {formatValue(ind)}
            </div>
            <div className="mt-1">
              {change && <div className={`text-xs font-medium tabular-nums ${tone}`}>{change}</div>}
              {ind.asOf && <div className="text-[11px] text-navy-300">{formatAsOf(ind)}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
function DayInReviewPlaceholder() {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-gold-700">
        Day in Review
        <span className="ml-2 normal-case tracking-normal text-navy-400">generating…</span>
      </div>
      <div className="mt-4 max-w-3xl space-y-3">
        <div className="h-5 w-full animate-pulse rounded bg-navy/10" />
        <div className="h-5 w-11/12 animate-pulse rounded bg-navy/10" />
        <div className="h-5 w-7/12 animate-pulse rounded bg-navy/10" />
      </div>
    </div>
  );
}

function DayInReview({ text, generatedAt }) {
  // Stamp the card with an ET-formatted "as of" line so the user can see
  // exactly which market close the paragraph reflects.
  let stamp = null;
  if (generatedAt) {
    try {
      const d = new Date(generatedAt);
      const dateStr = d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
      });
      const timeStr = d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York',
      });
      stamp = `As of ${timeStr} ET · ${dateStr}`;
    } catch {
      /* ignore */
    }
  }
  return (
    <article className="max-w-3xl">
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-gold-700">
        Day in Review
      </div>
      <p className="mt-3 font-serif text-2xl font-medium leading-snug text-navy md:text-[1.75rem]">
        {text}
      </p>
      {stamp && <div className="mt-4 text-xs text-navy-400">{stamp}</div>}
    </article>
  );
}

function earningsWhen(hour) {
  if (hour === 'bmo') return 'Before the open';
  if (hour === 'amc') return 'After the close';
  if (hour === 'dmh') return 'During the session';
  return 'Reports';
}

// ─── On the Calendar ────────────────────────────────────────────────────

function OnTheCalendar({ events, nextEarnings }) {
  const rows = events.map((e) => ({
    key: e.id,
    date: new Date(e.date),
    kicker: e.kind === 'pitch' ? 'Pitch' : 'Event',
    title: e.title,
    detail: `${format(new Date(e.date), 'EEEE, h:mm a')}${e.location ? ` · ${e.location}` : ''}`,
    gold: e.kind === 'pitch',
    to: '/calendar',
  }));
  if (nextEarnings) {
    const date = new Date(`${nextEarnings.date}T12:00:00Z`);
    rows.push({
      key: `earn-${nextEarnings.ticker}`,
      date,
      kicker: 'Earnings',
      title: nextEarnings.ticker,
      detail: earningsWhen(nextEarnings.hour),
      to: '/portfolio',
    });
  }
  rows.sort((a, b) => a.date - b.date);

  return (
    <section>
      <SectionHeading title="Coming up" href="/calendar" />
      {rows.length === 0 ? (
        <div className="py-6 text-sm text-navy-400">Nothing scheduled in the next 30 days.</div>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.key} className="border-t border-navy/10 first:border-t-0">
              <AgendaRow {...row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgendaRow({ date, kicker, title, detail, gold, to = '/calendar' }) {
  return (
    <Link to={to} className="group flex items-start gap-4 py-4">
      <div className="w-11 shrink-0 pt-0.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-navy-400">
          {format(date, 'MMM')}
        </div>
        <div className={`font-serif text-2xl font-medium leading-none ${gold ? 'text-gold-700' : 'text-navy'}`}>
          {format(date, 'd')}
        </div>
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-[11px] uppercase tracking-[0.14em] text-navy-400">{kicker}</div>
        <div className="mt-0.5 truncate text-[15px] font-medium text-navy group-hover:underline">
          {title}
        </div>
        <div className="mt-0.5 text-xs text-navy-400">{detail}</div>
      </div>
    </Link>
  );
}

// ─── Lately (activity feed) ─────────────────────────────────────────────

function LatelyFeed({ activity }) {
  return (
    <section>
      <SectionHeading title="Lately" />
      {activity.length === 0 ? (
        <div className="py-6 text-sm text-navy-400">No recent activity yet.</div>
      ) : (
        <ul>
          {activity.map((a, i) => {
            const to = a.type === 'report' ? '/library' : '/calendar';
            return (
              <li key={i} className="border-t border-navy/10 first:border-t-0">
                <Link to={to} className="group block py-4">
                  <div className="text-[15px] leading-snug text-navy group-hover:underline">{a.label}</div>
                  <div className="mt-1 text-xs text-navy-400">
                    {formatDistanceToNow(new Date(a.at), { addSuffix: true })}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SectionHeading({ title, href }) {
  return (
    <div className="mb-1 flex items-baseline gap-3 border-b-2 border-gold pb-2">
      <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">{title}</h2>
      {href && (
        <Link to={href} className="text-xs font-medium text-navy-400 hover:text-navy">
          View all
        </Link>
      )}
    </div>
  );
}
