import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  ComposedChart,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';

// Custom hover card for the CPI chart. Recharts' default tooltip lists every
// series by dataKey, which surfaces the `hi`/`lo` band edges as raw labels
// ("hi : 3.75%"). Here we collapse them to a single "80% band" range row and
// hide whichever of Released / Forecast is null at this point.
function CpiTooltip({ active, payload, label }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const byKey = Object.fromEntries(
    payload.map((p) => [p.dataKey, p.payload?.[p.dataKey]])
  );
  const released = byKey.yoy;
  const forecast = byKey.forecast;
  const lo = byKey.lo;
  const hi = byKey.hi;
  const fmt = (v) =>
    v == null || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(2)}%`;

  return (
    <div className="rounded-lg border border-navy-100 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-serif text-sm font-semibold text-navy">{label}</div>
      <div className="mt-1.5 h-px w-full bg-navy-50" />
      <div className="mt-1.5 space-y-1">
        {released != null && Number.isFinite(released) && (
          <Row dot="bg-navy" label="Released" value={fmt(released)} />
        )}
        {forecast != null && Number.isFinite(forecast) && (
          <Row dot="bg-gold" label="Forecast" value={fmt(forecast)} />
        )}
        {lo != null && hi != null && Number.isFinite(lo) && Number.isFinite(hi) && (
          <Row
            dot="bg-gold/40"
            label="80% band"
            value={`${fmt(lo)} – ${fmt(hi)}`}
          />
        )}
      </div>
    </div>
  );
}

function Row({ dot, label, value }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <span className="text-navy-400">{label}</span>
      </div>
      <span className="font-semibold text-navy tabular-nums">{value}</span>
    </div>
  );
}

// Hover card for the prediction-history chart. A month can carry up to
// four numbers — the released print plus the calls made for it from one,
// two, and three months out — and when the print is in we also show how
// far the headline (+1 mo) call missed.
function HistoryTooltip({ active, payload, label }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const row = payload[0]?.payload || {};
  const fmt = (v) =>
    v == null || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(2)}%`;
  const miss =
    Number.isFinite(row.actual) && Number.isFinite(row.p1)
      ? row.p1 - row.actual
      : null;

  return (
    <div className="rounded-lg border border-navy-100 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-serif text-sm font-semibold text-navy">{label}</div>
      <div className="mt-1.5 h-px w-full bg-navy-50" />
      <div className="mt-1.5 space-y-1">
        {Number.isFinite(row.actual) && (
          <Row dot="bg-navy" label="Released" value={fmt(row.actual)} />
        )}
        {Number.isFinite(row.p1) && (
          <Row dot="bg-gold" label="+1 mo call" value={fmt(row.p1)} />
        )}
        {Number.isFinite(row.p2) && (
          <Row dot="bg-gold/60" label="+2 mo call" value={fmt(row.p2)} />
        )}
        {Number.isFinite(row.p3) && (
          <Row dot="bg-gold/30" label="+3 mo call" value={fmt(row.p3)} />
        )}
        {miss != null && (
          <Row
            dot={Math.abs(miss) <= 0.25 ? 'bg-emerald-500' : 'bg-red-400'}
            label="+1 mo miss"
            value={`${miss > 0 ? '+' : ''}${miss.toFixed(2)}pp`}
          />
        )}
      </div>
    </div>
  );
}
import Card from '../components/Card.jsx';

// CPI forecast page. Reads from /api/cpi/forecast (latest run) and
// /api/cpi/history (recent runs for the backtest panel). Numbers are
// computed monthly by the Python forecaster on the club's local server
// and POSTed here — this page never runs models, just reads + charts.

function formatPct(n, signed = true) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n.toFixed(2);
  return signed && n > 0 ? `+${s}%` : `${s}%`;
}

function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function CPI() {
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [forecastRes, historyRes] = await Promise.all([
          api.get('/cpi/forecast'),
          api.get('/cpi/history?limit=24'),
        ]);
        if (cancelled) return;
        setLatest(forecastRes.data);
        setHistory(historyRes.data?.runs || []);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e?.response?.data?.error || e.message || 'Failed to load forecast');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const forecast = latest?.latest;
  const fanChartData = useMemo(() => {
    if (!forecast) return [];
    // Synthesize a "history" series from the most recent runs that share
    // the same source month — but for the chart we want a proper history.
    // Use the lastReleasedYoy as the anchor at asOfMonth, then the
    // forecasts as the next 3 months.
    const rows = [];
    rows.push({
      month: monthLabel(forecast.asOfMonth),
      yoy: forecast.lastReleasedYoy,
      forecast: null,
      lo: null,
      hi: null,
    });
    for (const f of forecast.forecasts) {
      rows.push({
        month: monthLabel(f.month),
        yoy: null,
        forecast: f.yoy,
        lo: f.yoyLo80,
        hi: f.yoyHi80,
      });
    }
    return rows;
  }, [forecast]);

  // Pivot the run history from "one row per run" to "one row per target
  // month": each run anchors an actual print at its asOfMonth and aims
  // calls at the next three. A given month therefore accumulates up to
  // three calls (made 1, 2, and 3 months out) that the chart lays
  // against the print once it's released.
  const historyChartData = useMemo(() => {
    if (history.length < 2) return [];
    const actuals = new Map();
    const calls = [new Map(), new Map(), new Map()];
    for (const run of history) {
      if (Number.isFinite(run.lastReleasedYoy)) {
        actuals.set(run.asOfMonth, run.lastReleasedYoy);
      }
      (run.forecasts || []).slice(0, 3).forEach((f, i) => {
        if (f?.month && Number.isFinite(f.yoy)) calls[i].set(f.month, f.yoy);
      });
    }
    const months = [
      ...new Set([...actuals.keys(), ...calls[0].keys()]),
    ].sort();
    return months.map((ym) => ({
      month: monthLabel(ym),
      actual: actuals.get(ym) ?? null,
      p1: calls[0].get(ym) ?? null,
      p2: calls[1].get(ym) ?? null,
      p3: calls[2].get(ym) ?? null,
    }));
  }, [history]);

  if (loading) {
    return (
      <div>
        <PageHeader kicker="Macro" title="CPI Forecast" />
        <Card>
          <div className="py-10 text-center text-sm text-navy-400">Loading forecast…</div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader kicker="Macro" title="CPI Forecast" />
        <Card>
          <div className="py-10 text-center text-sm text-red-600">{error}</div>
        </Card>
      </div>
    );
  }

  if (!latest?.configured || !forecast) {
    return (
      <div>
        <PageHeader kicker="Macro" title="CPI Forecast" />
        <Card>
          <div className="py-10 text-center text-sm text-navy-400">
            No forecast yet. The forecaster runs monthly after BLS releases CPI
            (typically mid-month). Once it has POSTed a run, it'll appear here.
          </div>
        </Card>
      </div>
    );
  }

  const direction =
    forecast.forecasts[2]?.yoy > forecast.lastReleasedYoy
      ? 'up'
      : forecast.forecasts[2]?.yoy < forecast.lastReleasedYoy
        ? 'down'
        : 'flat';
  const DirectionIcon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Macro"
        title="CPI Forecast"
        subtitle={`3-month-ahead headline CPI, forecast engine: ${
          forecast.engineLabel || 'production model'
        }. Generated ${new Date(forecast.runAt).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })}.`}
      />

      {/* Headline cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
            Last Released
          </div>
          <div className="mt-2 font-serif text-3xl font-semibold text-navy">
            {formatPct(forecast.lastReleasedYoy, false)}
          </div>
          <div className="mt-1 text-xs text-navy-400">
            {monthLabel(forecast.asOfMonth)} (YoY)
          </div>
        </Card>
        {forecast.forecasts.map((f, i) => (
          <Card key={f.month}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
              Forecast +{i + 1} mo
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="font-serif text-3xl font-semibold text-navy">
                {formatPct(f.yoy, false)}
              </span>
              {i === 2 && <DirectionIcon className="h-5 w-5 text-navy-400" />}
            </div>
            <div className="mt-1 text-xs text-navy-400">
              {monthLabel(f.month)} • 80% band {formatPct(f.yoyLo80, false)} →{' '}
              {formatPct(f.yoyHi80, false)}
            </div>
          </Card>
        ))}
      </div>

      {/* Fan chart */}
      <Card kicker="Path" title="Anchor + 3-month forecast">
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={fanChartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="bandFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#C9A84C" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="#C9A84C" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748B' }}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
                domain={['auto', 'auto']}
              />
              <Tooltip
                content={<CpiTooltip />}
                cursor={{ stroke: '#C9A84C', strokeOpacity: 0.4, strokeWidth: 1 }}
              />
              {/* 80% band as area between lo and hi. The custom tooltip
                  reads lo/hi directly off the row, so we don't surface
                  these as separate legend entries. */}
              <Area
                type="monotone"
                dataKey="hi"
                stroke="none"
                fill="url(#bandFill)"
                isAnimationActive={false}
                legendType="none"
                name="80% band"
              />
              <Area
                type="monotone"
                dataKey="lo"
                stroke="none"
                fill="#FFFFFF"
                isAnimationActive={false}
                legendType="none"
                name="80% band"
              />
              <Line
                type="monotone"
                dataKey="yoy"
                stroke="#1B2A4A"
                strokeWidth={2.5}
                dot={{ r: 4, fill: '#1B2A4A' }}
                isAnimationActive={false}
                name="Released"
              />
              <Line
                type="monotone"
                dataKey="forecast"
                stroke="#C9A84C"
                strokeWidth={2.5}
                strokeDasharray="5 4"
                dot={{ r: 4, fill: '#C9A84C' }}
                isAnimationActive={false}
                name="Forecast"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex items-center gap-4 text-xs text-navy-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-navy" /> Released
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-gold" style={{ borderTop: '1.5px dashed' }} />{' '}
            Forecast
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-4 bg-gold/30" /> 80% band
          </span>
        </div>
      </Card>

      {/* Forecast engine — names the actual production model */}
      <Card
        kicker="Forecast engine"
        title={forecast.engineLabel || 'Production model'}
      >
        {forecast.engineDescription && (
          <p className="text-sm leading-relaxed text-navy-500">
            {forecast.engineDescription}
          </p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
              Backtest RMSE
            </div>
            <div className="mt-1 font-serif text-2xl font-semibold text-navy">
              {forecast.engineRmseYoy != null
                ? `${forecast.engineRmseYoy.toFixed(3)}%`
                : '—'}
            </div>
            <div className="text-xs text-navy-400">YoY error, 24-mo window</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
              Prior ensemble
            </div>
            <div className="mt-1 font-serif text-2xl font-semibold text-navy-400">
              {forecast.backtest?.perModel?.ensemble?.rmseYoy != null
                ? `${forecast.backtest.perModel.ensemble.rmseYoy.toFixed(3)}%`
                : '—'}
            </div>
            <div className="text-xs text-navy-400">YoY error, same window</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
              Hit ±0.25pp
            </div>
            <div className="mt-1 font-serif text-2xl font-semibold text-navy">
              {forecast.backtest?.perHorizon?.['1']?.hitWithin25bp != null
                ? `${forecast.backtest.perHorizon['1'].hitWithin25bp.toFixed(0)}%`
                : '—'}
            </div>
            <div className="text-xs text-navy-400">+1mo forecasts in band</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
              Window
            </div>
            <div className="mt-1 font-serif text-2xl font-semibold text-navy">
              {forecast.backtest?.windowMonths || 24}
            </div>
            <div className="mt-1 text-xs text-navy-400">months evaluated</div>
          </div>
        </div>
        <p className="mt-5 text-xs leading-relaxed text-navy-400">
          The headline numbers above come from a single production model — not a vote across
          many models. The model's identity lives in the forecaster's registry; promoting a new
          champion updates this page automatically.
        </p>
      </Card>

      {history.length > 1 && (
        <Card kicker="Prediction history" title="Past forecasts vs. actuals">
          <p className="mb-3 text-xs text-navy-400">
            Showing the last {history.length} monthly runs. Each month lines up the released
            print against the calls the model had made for it one, two, and three months out.
          </p>
          {historyChartData.length > 1 && (
            <>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={historyChartData}
                    margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#64748B' }}
                      tickFormatter={(v) => `${v.toFixed(1)}%`}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip
                      content={<HistoryTooltip />}
                      cursor={{ stroke: '#C9A84C', strokeOpacity: 0.4, strokeWidth: 1 }}
                    />
                    {/* Older calls render as bare dots fading with distance —
                        a fan of guesses converging on each print. Only the
                        headline +1 mo call earns a line. */}
                    <Line
                      type="monotone"
                      dataKey="p3"
                      stroke="none"
                      dot={{ r: 3.5, fill: '#C9A84C', fillOpacity: 0.3, strokeWidth: 0 }}
                      isAnimationActive={false}
                      name="+3 mo call"
                    />
                    <Line
                      type="monotone"
                      dataKey="p2"
                      stroke="none"
                      dot={{ r: 3.5, fill: '#C9A84C', fillOpacity: 0.55, strokeWidth: 0 }}
                      isAnimationActive={false}
                      name="+2 mo call"
                    />
                    <Line
                      type="monotone"
                      dataKey="p1"
                      stroke="#C9A84C"
                      strokeWidth={2.5}
                      strokeDasharray="5 4"
                      dot={{ r: 4, fill: '#C9A84C' }}
                      connectNulls
                      isAnimationActive={false}
                      name="+1 mo call"
                    />
                    <Line
                      type="monotone"
                      dataKey="actual"
                      stroke="#1B2A4A"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: '#1B2A4A' }}
                      connectNulls
                      isAnimationActive={false}
                      name="Released"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="mb-4 mt-2 flex flex-wrap items-center gap-4 text-xs text-navy-400">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-4 bg-navy" /> Released
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-4 bg-gold"
                    style={{ borderTop: '1.5px dashed' }}
                  />{' '}
                  +1 mo call
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-gold/60" /> +2 mo
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-gold/30" /> +3 mo
                </span>
              </div>
            </>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-navy-400">
                <tr>
                  <th className="py-2">Run as-of</th>
                  <th className="py-2">+1 mo</th>
                  <th className="py-2">+2 mo</th>
                  <th className="py-2">+3 mo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-50">
                {history.map((h) => (
                  <tr key={h.asOfMonth}>
                    <td className="py-2.5 text-navy">{monthLabel(h.asOfMonth)}</td>
                    {(h.forecasts || []).slice(0, 3).map((f, i) => (
                      <td key={i} className="py-2.5 tabular-nums text-navy-500">
                        {formatPct(f.yoy, false)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
