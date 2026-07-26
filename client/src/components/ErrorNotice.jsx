// An inline "this didn't load" notice, for pages where the content still
// renders around the failure.
//
// AsyncSection replaces a whole region when it cannot load. That is
// wrong for a calendar or a chart, where the grid is the page and a
// failed feed means the view is INCOMPLETE rather than absent — so those
// pages grew their own copy of this banner, four near-identical blocks
// with slightly different wording. This is that block, once.
//
// `title` should say what is missing rather than that something failed.
// "The calendar is incomplete" tells a reader what to do about the
// meeting they were checking for; "Request failed" does not.

export default function ErrorNotice({ title, message, hint, onRetry, className = '' }) {
  return (
    <div
      role="alert"
      className={`rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 ${className}`}
    >
      <div className="font-semibold">{title}</div>
      {message && <div className="mt-1">{message}</div>}
      {/* The sentence that stops a reader treating a gap as a finding. */}
      {hint && <div className="mt-1 text-red-800/80">{hint}</div>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-900 transition-colors hover:bg-red-100"
        >
          Try again
        </button>
      )}
    </div>
  );
}
