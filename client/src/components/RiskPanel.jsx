import { useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';

// The Risk view of the portfolio page. Sharpe and the adjusted return
// live in the page header band; this is beta, volatility, drawdown,
// concentration, and the flags that follow from the limits.

const MAX_POSITION_PCT = 10;   // flag single positions above this weight
const MAX_SECTOR_PCT = 30;     // flag sectors above this weight
const CASH_FLOOR_PCT = 2;      // flag if cash ever drops below this
const CASH_CEILING_PCT = 15;   // flag if cash sits above this

// Broad-market index ETFs are not single-name concentration risk, so they
// don't need to obey the per-position cap.
const POSITION_CAP_EXEMPT = new Set(['VOO']);

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export default function RiskPanel({ holdings, totals, history, cashFlows = [], headline = [] }) {
  const [betas, setBetas] = useState(null);
  const [error, setError] = useState('');
  const [commentary, setCommentary] = useState(null);
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const [driftAlerts, setDriftAlerts] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/holdings/betas')
      .then(({ data }) => {
        if (!cancelled) setBetas(data.byTicker || {});
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load betas');
      });
    // Thesis drift is server-computed and cached 24h, so we can fire it
    // immediately in parallel with the rest of the panel.
    api
      .get('/holdings/thesis-drift')
      .then(({ data }) => {
        if (!cancelled) setDriftAlerts(data?.alerts || []);
      })
      .catch(() => {
        if (!cancelled) setDriftAlerts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalValue = totals?.totalValue || 0;
  const cashValue = totals?.cashValue || 0;

  // Weighted portfolio beta. Cash contributes 0. If a ticker has no beta,
  // we exclude it from both numerator and denominator so the average isn't
  // biased downward by missing data.
  const weightedBeta = useMemo(() => {
    if (!betas || !holdings?.length || !totalValue) return null;
    let weighted = 0;
    let coveredWeight = 0;
    for (const h of holdings) {
      if (h.isCash) continue;
      const b = betas[h.ticker]?.beta;
      const mv =
        h.marketValue ??
        (h.shares != null && h.price != null ? h.shares * h.price : 0);
      if (b == null || !mv) continue;
      weighted += b * mv;
      coveredWeight += mv;
    }
    if (coveredWeight === 0) return null;
    const effectiveBeta = weighted / coveredWeight;
    const coverage = coveredWeight / (totalValue - cashValue || 1);
    return { value: effectiveBeta, coverage };
  }, [betas, holdings, totalValue, cashValue]);

  // Annualized volatility + max drawdown on equity returns.
  const { vol, maxDrawdown } = useMemo(() => {
    if (!history || history.length < 20) return { vol: null, maxDrawdown: null };
    const cfByDay = new Map();
    for (const cf of cashFlows) {
      const k = new Date(cf.date).toISOString().slice(0, 10);
      cfByDay.set(k, (cfByDay.get(k) || 0) + cf.amount);
    }
    const returns = [];
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      const day = curr.date.getDay();
      if (day === 0 || day === 6) continue;
      const k = curr.date.toISOString().slice(0, 10);
      const cfOnDay = cfByDay.get(k) || 0;
      const dollarChange = curr.value - cfOnDay - prev.value;
      const base = prev.equity;
      if (base <= 0) continue;
      returns.push(dollarChange / base);
    }
    if (returns.length < 10) return { vol: null, maxDrawdown: null };
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const annualVol = Math.sqrt(variance) * Math.sqrt(252) * 100;

    // Max drawdown on cumulative total-value curve. Cash flows are re-based
    // into the equity curve so adding capital doesn't artificially "recover"
    // a drawdown.
    let peak = history[0].value;
    let maxDD = 0;
    for (const h of history) {
      if (h.value > peak) peak = h.value;
      const dd = peak > 0 ? (h.value - peak) / peak : 0;
      if (dd < maxDD) maxDD = dd;
    }
    return { vol: annualVol, maxDrawdown: maxDD * 100 };
  }, [history, cashFlows]);

  // Concentration metrics: HHI over positions (0–10000 scale, squash to 0–1).
  // Top position %, top 3 positions %.
  const concentration = useMemo(() => {
    if (!holdings?.length || !totalValue) return null;
    const weights = holdings
      .filter((h) => !h.isCash)
      .map((h) => {
        const mv =
          h.marketValue ??
          (h.shares != null && h.price != null ? h.shares * h.price : 0);
        return { ticker: h.ticker, pct: (mv / totalValue) * 100, sector: h.sector };
      })
      .sort((a, b) => b.pct - a.pct);
    const hhi = weights.reduce((s, w) => s + w.pct * w.pct, 0);
    const top = weights[0];
    const top3 = weights.slice(0, 3).reduce((s, w) => s + w.pct, 0);
    return { weights, hhi, top, top3 };
  }, [holdings, totalValue]);

  const cashPct = totalValue > 0 ? (cashValue / totalValue) * 100 : 0;

  // Rebalancing flags. Each flag is a { severity, message } object.
  const flags = useMemo(() => {
    const out = [];
    if (!concentration) return out;
    for (const w of concentration.weights) {
      if (POSITION_CAP_EXEMPT.has(w.ticker)) continue;
      if (w.pct > MAX_POSITION_PCT) {
        out.push({
          severity: w.pct > MAX_POSITION_PCT * 1.5 ? 'high' : 'med',
          message: `${w.ticker} is ${w.pct.toFixed(1)}% of the portfolio (target ≤ ${MAX_POSITION_PCT}%)`,
        });
      }
    }
    // Sector aggregation for flagging
    if (holdings?.length && totalValue) {
      const sectorMap = new Map();
      for (const h of holdings) {
        if (h.isCash) continue;
        const key = h.sector?.trim() || 'Unclassified';
        const mv =
          h.marketValue ??
          (h.shares != null && h.price != null ? h.shares * h.price : 0);
        sectorMap.set(key, (sectorMap.get(key) || 0) + mv);
      }
      for (const [sector, mv] of sectorMap.entries()) {
        const pct = (mv / totalValue) * 100;
        if (pct > MAX_SECTOR_PCT) {
          out.push({
            severity: 'med',
            message: `${sector} sector is ${pct.toFixed(1)}% of the portfolio (target ≤ ${MAX_SECTOR_PCT}%)`,
          });
        }
      }
    }
    if (cashPct < CASH_FLOOR_PCT) {
      out.push({
        severity: 'med',
        message: `Cash is ${cashPct.toFixed(1)}% — consider keeping ≥ ${CASH_FLOOR_PCT}% for flexibility`,
      });
    } else if (cashPct > CASH_CEILING_PCT) {
      out.push({
        severity: 'low',
        message: `Cash is ${cashPct.toFixed(1)}% — idle above ${CASH_CEILING_PCT}%, consider deploying`,
      });
    }
    if (weightedBeta?.value != null && weightedBeta.value > 1.3) {
      out.push({
        severity: 'low',
        message: `Portfolio beta ${weightedBeta.value.toFixed(2)} — more volatile than the market`,
      });
    }
    return out;
  }, [concentration, weightedBeta, cashPct, holdings, totalValue]);

  // Fire the AI commentary request once the full metrics payload is ready.
  // Gated on concentration because it's the single most-dependent piece —
  // if it's null we don't have enough to say anything useful.
  useEffect(() => {
    if (!concentration?.weights?.length) return;
    let cancelled = false;
    const payload = {
      totals: { totalValue, cashValue },
      cashPct,
      portfolioBeta: weightedBeta?.value ?? null,
      betaCoverage: weightedBeta?.coverage ?? null,
      annualizedVolPct: vol ?? null,
      maxDrawdownPct: maxDrawdown ?? null,
      hhi: concentration.hhi,
      topTicker: concentration.top?.ticker,
      topPct: concentration.top?.pct,
      top3Pct: concentration.top3,
      weights: concentration.weights.map((w) => ({
        ticker: w.ticker,
        pct: Number(w.pct.toFixed(2)),
        sector: w.sector || null,
        beta: betas?.[w.ticker]?.beta ?? null,
      })),
    };
    setCommentaryLoading(true);
    api
      .post('/holdings/risk-commentary', payload)
      .then(({ data }) => {
        if (!cancelled) setCommentary(data?.commentary || null);
      })
      .catch(() => {
        if (!cancelled) setCommentary(null);
      })
      .finally(() => {
        if (!cancelled) setCommentaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [concentration, weightedBeta, vol, maxDrawdown, cashPct, totalValue, cashValue, betas]);

  return (
    <div className="mt-4 space-y-10">
      {error && <div className="text-sm text-red-700">{error}</div>}

      <div className="rounded-2xl bg-white px-6 py-6">
        {headline.length > 0 && (
          <div className="grid grid-cols-2 gap-x-8 gap-y-6 border-b border-navy/10 pb-6 sm:grid-cols-3">
            {headline.map((item) => (
              <Metric key={item.label} {...item} />
            ))}
          </div>
        )}
        <div className={`grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4 ${headline.length ? 'pt-6' : ''}`}>
        <Metric
          label="Portfolio beta"
          value={weightedBeta?.value != null ? fmt(weightedBeta.value) : '—'}
          sub={
            weightedBeta?.coverage != null
              ? `${(weightedBeta.coverage * 100).toFixed(0)}% of equity covered`
              : betas
              ? 'No beta data'
              : 'Loading…'
          }
          tone={
            weightedBeta?.value == null
              ? 'neutral'
              : weightedBeta.value > 1.2
              ? 'warn'
              : weightedBeta.value < 0.8
              ? 'good'
              : 'neutral'
          }
        />
        <Metric
          label="Annualized vol"
          value={vol != null ? fmtPct(vol) : '—'}
          sub="Equity daily returns"
          tone={vol == null ? 'neutral' : vol > 20 ? 'warn' : 'neutral'}
        />
        <Metric
          label="Max drawdown"
          value={maxDrawdown != null ? fmtPct(maxDrawdown) : '—'}
          sub="Peak to trough"
          tone={maxDrawdown == null ? 'neutral' : maxDrawdown < -10 ? 'warn' : 'neutral'}
        />
        <Metric
          label="Concentration"
          value={concentration ? Math.round(concentration.hhi).toString() : '—'}
          sub={
            concentration
              ? `HHI · top ${concentration.top?.ticker} ${concentration.top?.pct.toFixed(1)}%`
              : '—'
          }
          tone={
            !concentration
              ? 'neutral'
              : concentration.hhi > 1500
              ? 'warn'
              : 'neutral'
          }
        />
        </div>
      </div>

      <section>
        <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">
          Flags
        </h2>
        {flags.length === 0 ? (
          <p className="mt-3 text-sm text-navy-400">Within the targets.</p>
        ) : (
          <ul className="mt-3">
            {flags.map((f, i) => (
              <li
                key={i}
                className={`border-t border-navy/10 py-3 text-sm first:border-t-0 ${
                  f.severity === 'high'
                    ? 'text-red-700'
                    : f.severity === 'med'
                    ? 'text-navy'
                    : 'text-navy-400'
                }`}
              >
                {f.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {concentration?.weights?.length ? (
        <section>
          <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">
            Weights
          </h2>
          <p className="mt-1 text-[11px] text-navy-400">
            A full bar is {100 / 5}%. Red is above the {MAX_POSITION_PCT}% name limit.
          </p>
          <div className="mt-4 space-y-2.5">
            {concentration.weights.slice(0, 10).map((w) => {
              const over =
                w.pct > MAX_POSITION_PCT && !POSITION_CAP_EXEMPT.has(w.ticker);
              const beta = betas?.[w.ticker]?.beta;
              return (
                <div key={w.ticker} className="flex items-center gap-3 text-sm">
                  <span className="w-14 font-medium text-navy">{w.ticker}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-navy/10">
                    <div
                      className={`h-full ${over ? 'bg-red-700' : 'bg-navy'}`}
                      style={{ width: `${Math.min(w.pct * 5, 100)}%` }}
                    />
                  </div>
                  <span className={`w-14 text-right tabular-nums ${over ? 'text-red-700' : 'text-navy'}`}>
                    {w.pct.toFixed(1)}%
                  </span>
                  <span className="w-14 text-right tabular-nums text-navy-400">
                    {beta != null ? `β ${beta.toFixed(2)}` : 'β —'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {driftAlerts && driftAlerts.length > 0 && (
        <section>
          <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">
            Thesis drift
          </h2>
          <ul className="mt-3">
            {driftAlerts.map((a) => (
              <li
                key={a.ticker}
                className={`border-t border-navy/10 py-3 text-sm first:border-t-0 ${
                  a.severity === 'high' ? 'text-red-700' : 'text-navy'
                }`}
              >
                <span className="font-medium">{a.ticker}</span>
                {a.reason ? <span className="text-navy-400"> — {a.reason}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(commentaryLoading || commentary) && (
        <section className="max-w-3xl">
          <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">
            Read
          </h2>
          {commentaryLoading && !commentary ? (
            <p className="mt-3 text-sm text-navy-400">Reading the book…</p>
          ) : (
            <p className="mt-3 font-serif text-xl leading-relaxed text-navy">
              {commentary}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, sub, tone = 'neutral' }) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'warn' || tone === 'bad'
      ? 'text-red-700'
      : 'text-navy';
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-navy-400">{label}</div>
      <div className={`mt-0.5 font-serif text-2xl font-medium tabular-nums ${toneClass}`}>
        {value}
      </div>
      <div className="mt-1 text-[11px] text-navy-400">{sub}</div>
    </div>
  );
}
