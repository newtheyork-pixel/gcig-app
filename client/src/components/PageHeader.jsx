// Page title. Sans, tight, with an optional quiet kicker.
//
// Usage:
//   <PageHeader title="Portfolio" />
//   <PageHeader title="Portfolio" kicker="Live Book" subtitle="..." />
//   <PageHeader title="..." actions={<Button>…</Button>} />

export default function PageHeader({ title, subtitle, actions, kicker }) {
  return (
    <div className="mb-6 md:mb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        {/* A floor on the title's width, so on a phone the actions wrap
            below it instead of squeezing it to a few letters. */}
        <div className="min-w-[12rem] flex-1">
          {kicker && (
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-navy-400">
              {kicker}
            </div>
          )}
          <h1 className="font-serif text-3xl font-medium leading-none tracking-tight text-navy md:text-4xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 hidden max-w-2xl text-sm leading-relaxed text-navy-400 md:block">
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
