// Loading, empty, and broken are three different things, and on most of
// these pages they render identically: a list initialised to [] paints an
// empty table on first frame, and an empty table is exactly what "there
// are no members" looks like. A failed fetch that leaves the array at []
// looks like that too. So the page says "nothing here" three times over,
// meaning something different each time, and the reader cannot tell
// which.
//
// That is not a cosmetic complaint. The two real bugs found in the site
// sweep — MOVR ranking one holding of thirteen, and the tanker page
// reporting zero departures from every Gulf terminal for eighteen days —
// were both a default rendered as a finding. This is the same failure
// one layer up, in the shell rather than the data.
//
// Usage:
//   <AsyncSection loading={loading} error={error} empty={rows.length === 0}
//                 emptyText="No pitches have been submitted yet.">
//     <table>…</table>
//   </AsyncSection>
//
// `retry` is offered on the error branch only. A reader who hits an error
// wants one button, not an explanation of the network.

export default function AsyncSection({
  loading,
  error,
  empty,
  emptyText = 'Nothing here yet.',
  loadingText = 'Loading…',
  retry,
  children,
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-navy-400">
        <span
          className="h-3 w-3 animate-pulse rounded-full bg-gold"
          aria-hidden="true"
        />
        {loadingText}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        <div className="font-semibold">This didn’t load.</div>
        {/* The message where there is one. Never swallowed into a generic
            failure — "couldn't load" with no reason is what sends someone
            to reload four times. */}
        <div className="mt-1">
          {typeof error === 'string' ? error : error?.message || 'The request failed.'}
        </div>
        {retry && (
          <button
            type="button"
            onClick={retry}
            className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-900 hover:bg-red-100"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  if (empty) {
    return <div className="py-8 text-sm text-navy-400">{emptyText}</div>;
  }

  return children;
}
