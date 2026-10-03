// Quiet stat band. Numbers sit in serif on white so they read as
// a fact sheet, not a poster.
//
// Usage:
//   <EditorialMasthead
//     stats={[
//       { kicker: 'Total', value: '30', sub: 'members' },
//       { kicker: 'Executives', value: '5', sub: 'Presidents + CIO' },
//       { kicker: 'Analysts', value: '12', sub: 'Senior + Junior', tone: 'up' },
//     ]}
//   />

export default function EditorialMasthead({ stats = [] }) {
  if (!stats.length) return null;
  const cols =
    stats.length === 1
      ? 'md:grid-cols-1'
      : stats.length === 2
        ? 'md:grid-cols-2'
        : stats.length === 4
          ? 'md:grid-cols-4'
          : 'md:grid-cols-3';
  return (
    <div className="overflow-hidden rounded-2xl border border-navy/[0.07] bg-white">
      <div className={`grid gap-6 p-5 md:gap-8 md:p-7 ${cols}`}>
        {stats.map((s, i) => {
          const tone =
            s.tone === 'up' ? 'text-emerald-700' : s.tone === 'down' ? 'text-red-700' : 'text-navy';
          return (
            <div key={i} className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-navy-400">
                {s.kicker}
              </div>
              <div
                className={`mt-1.5 font-serif font-medium leading-none tracking-tight tabular-nums ${tone} ${
                  s.big === false ? 'text-2xl md:text-3xl' : 'text-4xl md:text-5xl'
                }`}
              >
                {s.value}
              </div>
              {s.sub && <div className="mt-2 text-xs leading-relaxed text-navy-400">{s.sub}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
