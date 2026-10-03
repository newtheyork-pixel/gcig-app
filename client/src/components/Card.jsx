// Surface card. `title` is a serif heading; `kicker` is a quiet label.
//
// Usage:
//   <Card>body</Card>
//   <Card title="Positions">body</Card>
//   <Card kicker="On the calendar" title="Upcoming events">body</Card>
//   <Card title="..." action={<Link>view all</Link>}>body</Card>

export default function Card({ children, className = '', title, kicker, action }) {
  const headed = title || kicker || action;
  return (
    <div className={`rounded-2xl border border-navy/[0.07] bg-white ${className}`}>
      {headed && (
        <div className="flex items-center justify-between gap-4 px-5 pt-4">
          <div className="min-w-0">
            {kicker && (
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-navy-400">
                {kicker}
              </div>
            )}
            {title && (
              <h2 className="font-serif text-2xl font-medium tracking-tight text-navy">{title}</h2>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={headed ? 'px-5 pb-5 pt-3' : 'p-5'}>{children}</div>
    </div>
  );
}
