// Editorial page header. Small-caps kicker over a serif title with a thin
// gold rule — matches the Landing page's institutional rhythm.
//
// Usage:
//   <PageHeader title="Portfolio" />
//   <PageHeader title="Portfolio" kicker="Live Book" subtitle="..." />
//   <PageHeader title="..." actions={<Button>…</Button>} />

export default function PageHeader({ title, subtitle, actions, kicker }) {
  return (
    <div className="mb-6 border-b border-navy-100 pb-5 md:mb-8 md:pb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          {kicker && (
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700">
              <span className="h-px w-6 bg-gold" />
              {kicker}
            </div>
          )}
          <h1 className="font-serif text-2xl font-semibold leading-tight text-navy md:text-4xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-2 hidden text-sm leading-relaxed text-navy-400 md:block md:text-[15px]">
              {subtitle}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap gap-2 [&>*]:text-xs md:[&>*]:text-sm">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
