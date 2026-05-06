// One headline interpretive metric. Big value, status pill, footnote.
// Status drives color: ok = navy/gold neutral, watch/below_normal =
// amber, anomaly/stalled/alarm/stress = red, warming_up = muted gray.

const STATUS_STYLES = {
  ok:           { bar: 'bg-emerald-500', label: 'Normal',     pill: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  healthy:      { bar: 'bg-emerald-500', label: 'Healthy',    pill: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  below_normal: { bar: 'bg-amber-500',   label: 'Below normal', pill: 'text-amber-700 bg-amber-50 border-amber-200' },
  watch:        { bar: 'bg-amber-500',   label: 'Watch',      pill: 'text-amber-700 bg-amber-50 border-amber-200' },
  low:          { bar: 'bg-amber-500',   label: 'Low',        pill: 'text-amber-700 bg-amber-50 border-amber-200' },
  elevated:     { bar: 'bg-amber-500',   label: 'Elevated',   pill: 'text-amber-700 bg-amber-50 border-amber-200' },
  stalled:      { bar: 'bg-red-500',     label: 'Stalled',    pill: 'text-red-700 bg-red-50 border-red-200' },
  alarm:        { bar: 'bg-red-500',     label: 'Alarm',      pill: 'text-red-700 bg-red-50 border-red-200' },
  stress:       { bar: 'bg-red-500',     label: 'Stress',     pill: 'text-red-700 bg-red-50 border-red-200' },
  anomaly:      { bar: 'bg-red-500',     label: 'Anomaly',    pill: 'text-red-700 bg-red-50 border-red-200' },
  warming_up:   { bar: 'bg-navy/20',     label: 'Warming up', pill: 'text-navy/60 bg-navy/5 border-navy/10' },
  no_outbound:  { bar: 'bg-navy/20',     label: 'No outbound', pill: 'text-navy/60 bg-navy/5 border-navy/10' },
  latest_reading: { bar: 'bg-navy/40',   label: 'Latest reading', pill: 'text-navy/70 bg-navy/5 border-navy/15' },
};

export default function DerivedCard({ title, valueText, footnote, status, subtle }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.ok;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-navy/10 bg-white p-5 shadow-sm">
      <div className={`absolute left-0 top-0 h-full w-1 ${s.bar}`} />
      <div className="ml-1">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-navy/60">{title}</div>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${s.pill}`}>
            {s.label}
          </span>
        </div>
        <div className="mt-2 text-3xl font-semibold text-navy">{valueText}</div>
        {subtle && (
          <div className="mt-1 text-xs text-navy/60">{subtle}</div>
        )}
        {footnote && (
          <div className="mt-2 text-[11px] text-navy/50">{footnote}</div>
        )}
      </div>
    </div>
  );
}
