import { useEffect, useState } from 'react';
import ErrorNotice from '../components/ErrorNotice';
import { RefreshCw } from 'lucide-react';
import { getLatestSnapshot } from '../api/sea';
import DerivedPanel from './tankers/DerivedPanel';
import SarStatusCard from './tankers/SarStatusCard';
import SignalPanel from './tankers/SignalPanel';
import VesselMap from './tankers/VesselMap';
import VesselDrawer from './tankers/VesselDrawer';

const POLL_MS = 30 * 1000;

function relativeTime(iso) {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export default function Tankers() {
  const [snapshot, setSnapshot] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVessel, setSelectedVessel] = useState(null);

  async function refresh() {
    try {
      const res = await getLatestSnapshot();
      setConfigured(res.configured !== false);
      setFeed(res.feed || null);
      setSnapshot(res.snapshot || null);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    let timer = null;
    async function tick() {
      if (!alive) return;
      await refresh();
      if (alive) timer = setTimeout(tick, POLL_MS);
    }
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          {/* Matches the kicker-over-serif-title rhythm every other page
              uses; this one had its own sans h1. */}
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700">
            <span className="h-px w-6 bg-gold" />
            Persian Gulf
          </div>
          <h1 className="font-serif text-2xl font-semibold leading-tight text-navy md:text-3xl">
            Tanker Tracker
          </h1>
          <p className="text-sm text-navy/60">
            Refreshed every 2 min. Vessels shown were seen in the last 6 hours
            via free terrestrial AIS — coverage is concentrated near the UAE
            coast where contributing receivers are dense. The shaded area on
            the map marks waters out of receiver reach (Iran, Iraq, Kuwait,
            Saudi, Qatar, Bahrain, most of Oman); paid satellite AIS would
            close it, and we don't subscribe.
          </p>
          {snapshot?.coverage && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-navy/60">
              <span><span className="font-semibold text-navy">{snapshot.coverage.vessels_last_6h}</span> visible now</span>
              <span className="text-navy/30">·</span>
              <span><span className="font-semibold text-navy">{snapshot.coverage.vessels_last_24h}</span> seen in 24h</span>
              <span className="text-navy/30">·</span>
              <span><span className="font-semibold text-navy">{snapshot.coverage.vessels_last_7d}</span> this week</span>
              <span className="text-navy/30">·</span>
              <span><span className="font-semibold text-navy">{snapshot.coverage.vessels_all_time}</span> total tracked</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm text-navy/60">
          <span>Last update: {relativeTime(snapshot?.snapshotAt)}</span>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1 rounded-lg border border-navy/10 px-2 py-1 hover:bg-navy/5"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {loading && <div className="text-sm text-navy/60">Loading…</div>}

      {!loading && !configured && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Tanker tracker is not configured yet — no snapshots have been received from the
          collector. Once the Windows-side <code>publish-snapshot</code> task starts running,
          data will appear here.
        </div>
      )}

      {!loading && error && (
        <ErrorNotice title="The tracker didn’t load." message={error} />
      )}

      {/* The panels below render 0 as readily as they render 40, so a dead
          feed looks like an empty Gulf. Say it once, at the top, before
          anyone reads a single figure. */}
      {!loading && configured && feed && !feed.ais.live && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-semibold">AIS feed is not reporting.</div>
          <div className="mt-1">{feed.ais.reason}</div>
          <div className="mt-1 text-amber-800/80">
            Treat every AIS-derived figure below — departures, anchored counts,
            Hormuz throughput, laden/ballast — as unavailable rather than zero.
            {feed.sar?.live
              ? ' The satellite (SAR) readings are on a separate feed and are current.'
              : ''}
          </div>
        </div>
      )}

      {snapshot && (
        <>
          <SarStatusCard sarDetections={snapshot.sarDetections} />
          <DerivedPanel derived={snapshot.derived} />
          <SignalPanel signals={snapshot.signals} />
          <VesselMap snapshot={snapshot} onVesselClick={setSelectedVessel} />
          <VesselDrawer vessel={selectedVessel} onClose={() => setSelectedVessel(null)} />
        </>
      )}
    </div>
  );
}
