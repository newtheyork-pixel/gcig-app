import DerivedCard from './DerivedCard';

function fmt(n, digits = 1) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);
}

export default function DerivedPanel({ derived }) {
  if (!derived) return null;

  const t = derived.hormuzThroughputMbbl || {};
  const fh = derived.flowHealth || {};
  const ie = derived.iranExportShare || {};
  const oc = derived.opecCoordinationZ || {};
  const cp = derived.chokepointPressure || {};

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
      {/* Throughput */}
      <DerivedCard
        title="Hormuz Throughput"
        valueText={t.value === null || t.value === undefined ? '—' : `${fmt(t.value, 2)} Mbbl/d`}
        subtle={`${t.tanker_count || 0} laden tankers today · baseline ~${fmt(t.baseline_mbbl, 0)} Mbbl/d`}
        footnote="Estimated barrels of crude leaving the Gulf today"
        status={
          t.value === null || t.value === undefined || t.tanker_count === 0
            ? 'warming_up'
            : (t.value >= 15 ? 'ok' : t.value >= 8 ? 'below_normal' : 'stalled')
        }
      />

      {/* Flow Health */}
      <DerivedCard
        title="Flow Health"
        valueText={fh.value === null || fh.value === undefined ? '—' : `${fh.value} / 100`}
        subtle={
          fh.value === null
            ? 'Need 7+ days of history'
            : `Today ${fmt(fh.today, 0)} crossings · 30d median ${fmt(fh.median_30d, 0)}`
        }
        footnote="Are tankers actually moving through the strait"
        status={fh.status || 'warming_up'}
      />

      {/* Iran Export Share */}
      <DerivedCard
        title="Iran Export Share"
        valueText={ie.value === null || ie.value === undefined ? '—' : `${fmt(ie.value, 1)}%`}
        subtle={
          ie.value === null
            ? 'No terminal departures yet'
            : `${fmt(ie.iran, 0)} of ${fmt(ie.opec_total, 0)} OPEC-Gulf departures`
        }
        footnote="Iran's slice of total Gulf exports today"
        status={ie.status || 'warming_up'}
      />

      {/* OPEC Coordination */}
      <DerivedCard
        title="OPEC Coordination"
        valueText={oc.value === null || oc.value === undefined ? '—' : `${oc.value > 0 ? '+' : ''}${fmt(oc.value, 2)}σ`}
        subtle={
          oc.value === null
            ? 'Need 7+ days of history'
            : `Today ${fmt(oc.today, 0)} · 30d mean ${fmt(oc.mean_30d, 1)}`
        }
        footnote="Coordinated production move detector (|σ|>2 = unusual)"
        status={oc.status || 'warming_up'}
      />

      {/* Chokepoint Pressure */}
      <DerivedCard
        title="Chokepoint Pressure"
        valueText={
          cp.value === null || cp.value === undefined
            ? (cp.anchored_at_strait ? `${cp.anchored_at_strait} idle` : '—')
            : `${fmt(cp.value, 2)}×`
        }
        subtle={
          cp.value === null
            ? `${cp.anchored_at_strait || 0} anchored, no outbound today`
            : `${cp.anchored_at_strait} anchored vs ${cp.outbound_today} crossings`
        }
        footnote="Idle tankers near Hormuz divided by today's transits"
        status={cp.status || 'warming_up'}
      />
    </div>
  );
}
