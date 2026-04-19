export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 md:mb-6 md:gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold leading-tight text-navy md:text-3xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 hidden text-sm text-navy-400 md:block">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap gap-2 [&>*]:text-xs md:[&>*]:text-sm">
          {actions}
        </div>
      )}
    </div>
  );
}
