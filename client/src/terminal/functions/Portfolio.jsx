import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';
import FlashPrice from '../components/FlashPrice.jsx';

// PM — the portfolio-manager blotter, modeled on Bloomberg's PORT. The
// book itself (which names are held, shares, average cost, sector) is
// the positions sheet's call and stays that way; it's the system of
// record. On top of that we overlay /terminal/quotes for live price and
// recompute the marks that move with it — market value, weight, day
// P&L, unrealized P&L — so the blotter is current to the tick rather
// than to the sheet's 20-40m GOOGLEFINANCE read. Cash is shown as its
// own line and carries no price or P&L.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  qty: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })),
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`),
  wt: (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`),
  money: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  },
  signed: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  },
};

const sign = (v) => (v == null || Number.isNaN(v) ? '' : v >= 0 ? 'pos' : 'neg');

// Fold the sheet row and any live quote into one mark. The sheet's
// day-change column is per-share dollars; when a live quote is present
// we trust its dp (percent) and back out the per-share move from it,
// otherwise we fall back to the sheet's figures so a cell never blanks.
function buildRow(h, q) {
  if (h.isCash) {
    return { ...h, last: null, mv: h.marketValue ?? 0, dayPL: 0, dayPct: null, uplDollar: null, uplPct: null };
  }
  const last = q?.last != null ? q.last : h.price;
  const shares = h.shares;
  const mv =
    shares != null && last != null ? shares * last : h.marketValue != null ? h.marketValue : 0;

  let dayPct = null;
  let perShareDay = null;
  if (q?.last != null && q?.changePct != null) {
    const prev = q.last / (1 + q.changePct / 100);
    perShareDay = q.last - prev;
    dayPct = q.changePct / 100;
  } else if (h.price != null && h.dayChange != null && h.price - h.dayChange > 0) {
    perShareDay = h.dayChange;
    dayPct = h.dayChange / (h.price - h.dayChange);
  }
  const dayPL =
    shares != null && perShareDay != null
      ? shares * perShareDay
      : dayPct != null
      ? mv - mv / (1 + dayPct)
      : 0;

  let uplDollar = null;
  let uplPct = null;
  if (shares != null && h.costBasis != null && last != null) {
    uplDollar = (last - h.costBasis) * shares;
    uplPct = h.costBasis > 0 ? (last - h.costBasis) / h.costBasis : null;
  } else {
    uplDollar = h.dollarReturn != null ? h.dollarReturn : null;
    uplPct = h.percentReturn != null ? h.percentReturn / 100 : null;
  }
  return { ...h, last, mv, dayPL, dayPct, uplDollar, uplPct };
}

const COLUMNS = [
  { key: 'ticker', label: 'Ticker', align: 'left', sort: (r) => r.ticker },
  { key: 'shares', label: 'Pos', align: 'right', sort: (r) => r.shares ?? -Infinity },
  { key: 'costBasis', label: 'Avg Cost', align: 'right', sort: (r) => r.costBasis ?? -Infinity },
  { key: 'last', label: 'Last', align: 'right', sort: (r) => r.last ?? -Infinity },
  { key: 'mv', label: 'Mkt Val', align: 'right', sort: (r) => r.mv ?? -Infinity },
  { key: 'weight', label: 'Wt%', align: 'right', sort: (r) => r.weight ?? -Infinity },
  { key: 'dayPct', label: 'Day%', align: 'right', sort: (r) => r.dayPct ?? -Infinity },
  { key: 'uplDollar', label: 'Unreal P&L', align: 'right', sort: (r) => r.uplDollar ?? -Infinity },
  { key: 'uplPct', label: '%', align: 'right', sort: (r) => r.uplPct ?? -Infinity },
];

export default function Portfolio({ onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'weight', dir: 'desc' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setBrief('');
    api
      .get('/terminal/portfolio')
      .then(({ data }) => {
        if (!cancelled) setData(data);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live price tap for the held, non-cash names — same source and
  // while-visible cadence as MOVR/DES. Re-keys only when the book
  // actually changes, and keeps the last good quotes across a failed
  // poll rather than wiping the marks.
  const liveTickers = useMemo(
    () => [
      ...new Set(
        (data?.holdings || [])
          .filter((h) => !h.isCash)
          .map((h) => String(h.ticker).toUpperCase())
      ),
    ],
    [data]
  );
  const liveKey = liveTickers.join(',');

  const { data: liveQuotes } = useLiveRefresh(
    async () => {
      if (!liveKey) return {};
      const { data: q } = await api.get('/terminal/quotes', { params: { tickers: liveKey } });
      return q;
    },
    { enabled: liveTickers.length > 0 }
  );

  // Marks + fund-level aggregates, recomputed whenever the sheet or a
  // live tick changes. Weights are taken against the live NAV so they
  // always foot to 100%, and the summary band is summed from the same
  // rows the table renders — one source of truth for the panel.
  const view = useMemo(() => {
    if (!data?.holdings) return null;
    const rows = data.holdings.map((h) =>
      buildRow(h, liveQuotes ? liveQuotes[String(h.ticker).toUpperCase()] : null)
    );
    const nav = rows.reduce((s, r) => s + (r.mv || 0), 0);
    for (const r of rows) r.weight = nav > 0 ? r.mv / nav : null;

    const positions = rows.filter((r) => !r.isCash);
    const cash = rows.filter((r) => r.isCash).reduce((s, r) => s + (r.mv || 0), 0);
    const dayPL = rows.reduce((s, r) => s + (r.dayPL || 0), 0);
    const priorNav = nav - dayPL;
    const dayPct = priorNav > 0 ? dayPL / priorNav : null;
    const uplDollar = positions.reduce((s, r) => s + (r.uplDollar || 0), 0);
    const costNonCash = positions.reduce((s, r) => {
      if (r.shares != null && r.costBasis != null) return s + r.shares * r.costBasis;
      if (r.mv != null && r.uplDollar != null) return s + (r.mv - r.uplDollar);
      return s;
    }, 0);
    const uplPct = costNonCash > 0 ? uplDollar / costNonCash : null;

    // Sector weights for the allocation rail (positions only).
    const bySector = new Map();
    for (const r of positions) {
      const k = r.sector || 'Unclassified';
      bySector.set(k, (bySector.get(k) || 0) + (r.mv || 0));
    }
    const sectors = [...bySector.entries()]
      .map(([name, mv]) => ({ name, weight: nav > 0 ? mv / nav : 0 }))
      .sort((a, b) => b.weight - a.weight);

    return {
      rows,
      sectors,
      summary: { nav, cash, cashPct: nav > 0 ? cash / nav : null, dayPL, dayPct, uplDollar, uplPct, count: positions.length },
    };
  }, [data, liveQuotes]);

  const sorted = useMemo(() => {
    if (!view) return [];
    const col = COLUMNS.find((c) => c.key === sort.key) || COLUMNS[5];
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Cash sinks to the bottom regardless of sort — it's a residual, not
    // a position to rank.
    return [...view.rows].sort((a, b) => {
      if (a.isCash !== b.isCash) return a.isCash ? 1 : -1;
      const av = col.sort(a);
      const bv = col.sort(b);
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });
  }, [view, sort]);

  useEffect(() => {
    if (!view?.rows?.length) return;
    let cancelled = false;
    setBriefLoading(true);
    const s = view.summary;
    const top = [...view.rows]
      .filter((r) => !r.isCash)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 5);
    const context = [
      `GCIG book, as of ${data.fetchedAt ? String(data.fetchedAt).slice(0, 10) : 'n/a'}:`,
      `NAV ${fmt.money(s.nav)} · day P&L ${fmt.signed(s.dayPL)} (${fmt.pct(s.dayPct)}) · unrealized ${fmt.signed(s.uplDollar)} (${fmt.pct(s.uplPct)}) · cash ${fmt.money(s.cash)} (${fmt.wt(s.cashPct)}) · ${s.count} positions`,
      'Top positions by weight:',
      ...top.map((r) => `${r.ticker} ${fmt.wt(r.weight)} · day ${fmt.pct(r.dayPct)} · unreal ${fmt.pct(r.uplPct)}`),
      'Sector weights:',
      ...view.sectors.map((x) => `${x.name} ${fmt.wt(x.weight)}`),
    ].join('\n');
    api
      .post('/terminal/annotate', { function: 'PM', context })
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
    // Re-brief on a fresh sheet load, not on every live tick.
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="term-panel"><div className="term-loading">Loading the book…</div></div>;
  }
  if (err) {
    return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  }
  if (!view) return null;

  const s = view.summary;

  function toggleSort(key) {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'ticker' ? 'asc' : 'desc' }
    );
  }

  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="term-panel term-pm">
      <div className="term-panel-header">
        <span className="ticker">PM</span>
        <span className="equity">Portfolio</span>
        <span className="name">
          The Griffin Fund{data.fetchedAt ? ` · as of ${String(data.fetchedAt).slice(0, 10)}` : ''}
        </span>
      </div>

      <div className="term-pm-summary">
        <PmStat label="Net Asset Value" value={fmt.money(s.nav)} />
        <PmStat label="Day P&L" value={fmt.signed(s.dayPL)} sub={fmt.pct(s.dayPct)} cls={sign(s.dayPL)} />
        <PmStat label="Unrealized P&L" value={fmt.signed(s.uplDollar)} sub={fmt.pct(s.uplPct)} cls={sign(s.uplDollar)} />
        <PmStat label="Cash" value={fmt.money(s.cash)} sub={fmt.wt(s.cashPct)} />
        <PmStat label="Positions" value={String(s.count)} />
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <table className="term-table term-pm-table">
        <thead>
          <tr>
            <th style={{ width: 20 }}>#</th>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={`${c.align === 'right' ? 'num ' : ''}sortable${sort.key === c.key ? ' sorted' : ''}`}
                onClick={() => toggleSort(c.key)}
                title={`Sort by ${c.label}`}
              >
                {c.label}
                {sort.key === c.key ? <span className="arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr
              key={r.ticker}
              className={r.isCash ? 'term-pm-cash' : 'term-row-link'}
              role={r.isCash ? undefined : 'button'}
              tabIndex={r.isCash ? undefined : 0}
              onClick={r.isCash ? undefined : () => onOpen?.({ ticker: r.ticker, fn: 'DES' })}
              onKeyDown={r.isCash ? undefined : rowKey(() => onOpen?.({ ticker: r.ticker, fn: 'DES' }))}
              title={r.isCash ? undefined : `Open ${r.ticker} DES`}
            >
              <td className="rank">{r.isCash ? '' : i + 1}</td>
              <td className="sym">
                {r.ticker}
                {r.name && r.name !== r.ticker ? <span className="peer-name">{r.name}</span> : null}
              </td>
              <td className="num">{fmt.qty(r.shares)}</td>
              <td className="num">{fmt.px(r.costBasis)}</td>
              <td className="num">
                {r.isCash ? '—' : <FlashPrice value={r.last}>{fmt.px(r.last)}</FlashPrice>}
              </td>
              <td className="num">{fmt.money(r.mv)}</td>
              <td className="num">{fmt.wt(r.weight)}</td>
              <td className={`num ${sign(r.dayPct)}`}>{r.isCash ? '—' : fmt.pct(r.dayPct)}</td>
              <td className={`num ${sign(r.uplDollar)}`}>{r.isCash ? '—' : fmt.signed(r.uplDollar)}</td>
              <td className={`num ${sign(r.uplPct)}`}>{r.isCash ? '—' : fmt.pct(r.uplPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="term-pm-alloc">
        <div className="term-pm-alloc-title">Sector Allocation</div>
        {view.sectors.map((x) => (
          <div className="term-pm-bar" key={x.name}>
            <span className="lbl" title={x.name}>{x.name}</span>
            <span className="track">
              <span className="fill" style={{ width: `${Math.min(100, x.weight * 100).toFixed(1)}%` }} />
            </span>
            <span className="val">{fmt.wt(x.weight)}</span>
          </div>
        ))}
      </div>

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Book from the positions sheet; price, value, weight and P&L recomputed
        live (~20s) while open. Click any position to open its DES.
      </div>
    </div>
  );
}

function PmStat({ label, value, sub, cls = '' }) {
  return (
    <div className="term-pm-stat">
      <span className="lbl">{label}</span>
      <span className={`val ${cls}`}>
        {value}
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
    </div>
  );
}
