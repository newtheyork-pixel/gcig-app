// Editorial card. Default title renders in serif with an optional
// small-caps kicker + gold hairline above it. Backwards-compatible with
// existing callers — `title` string still works and now reads as serif.
//
// Usage:
//   <Card>body</Card>
//   <Card title="Positions">body</Card>
//   <Card kicker="On the calendar" title="Upcoming events">body</Card>
//   <Card title="..." action={<Link>view all</Link>}>body</Card>

export default function Card({ children, className = '', title, kicker, action }) {
  return (
    <div
      className={`rounded-xl border border-navy-100 bg-white shadow-card ${className}`}
    >
      {(title || kicker || action) && (
        <div className="flex items-end justify-between gap-4 border-b border-navy-50 px-5 py-4">
          <div className="min-w-0">
            {kicker && (
              <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
                <span className="h-px w-5 bg-gold" />
                {kicker}
              </div>
            )}
            {title && (
              <h2 className="font-serif text-lg font-semibold text-navy">
                {title}
              </h2>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}
