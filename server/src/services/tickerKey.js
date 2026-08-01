// One way to say what "the same ticker" means.
//
// Ticker is a free-text string on Holding, Pitch, ResearchClaim,
// WatchlistItem, ResearchValuation, Report and VotingSession, with no
// foreign key anywhere and no agreement on how to match it. The codebase
// currently uses three different rules: `mode: 'insensitive'` in the
// coverage route, `.toUpperCase()` in the pitches route, and a regex
// validate-then-upper in the peers route. They mostly agree, and mostly
// is the problem.
//
// It matters more than it looks now that panels are about to JOIN these
// tables. A club block that shows two of a company's three pitches is
// worse than one that shows none, because it teaches a member the club
// has no history on a name when it does — and nothing on screen would
// say a row had been dropped.
//
// The rules are deliberately conservative. Case and surrounding space
// are noise. The dot-versus-hyphen share-class convention is noise too:
// vendors write BRK.B, EDGAR writes BRK-B, and a member types either.
// Everything else is left alone — a ticker is an identifier, and
// "helpfully" stripping characters from an identifier is how MOG-A
// silently becomes MOGA and matches nothing.

/// A value no ticker can equal, used to make an unusable input match
/// nothing. Deliberately printable: the first version used a NUL, and
/// Postgres refuses NUL inside a text value, so the query would have
/// THROWN where it was meant to return an empty list — turning "we could
/// not read that ticker" into a 500.
const NO_MATCH = '__NO_TICKER_MATCH__';

/// The canonical form used for comparison, never for display.
export function tickerKey(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return '';
  // Share classes: one separator, chosen arbitrarily but consistently.
  return s.replace(/[.\-\s]+/g, '-');
}

/// Do these two strings name the same security?
export function sameTicker(a, b) {
  const ka = tickerKey(a);
  return !!ka && ka === tickerKey(b);
}

/// A ticker fit to put in a URL or a query, or null if it is not one.
///
/// Validation lives here rather than at each call site so that a route
/// cannot accidentally accept something the others reject. The shape is
/// deliberately narrow: letters, digits, dot and hyphen, up to twelve —
/// which covers every US listing and the share-class forms without
/// admitting a path fragment.
export function normalizeTicker(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s || !/^[A-Z0-9.\-]{1,12}$/.test(s)) return null;
  return s;
}

/// Every spelling of a ticker worth matching in the database.
///
/// Prisma has no expression index here and a `WHERE upper(ticker) = ...`
/// would not use one anyway, so the practical approach is to hand the
/// query the small set of forms a human or a vendor might have stored:
/// as typed, dotted, and hyphenated. Case is handled by Prisma's
/// insensitive mode rather than by adding four more variants.
export function tickerVariants(raw) {
  const s = normalizeTicker(raw);
  if (!s) return [];
  const out = new Set([s, s.replace(/-/g, '.'), s.replace(/\./g, '-')]);
  return [...out];
}

/// The `where` clause for "this ticker, however it was written down".
///
/// Use this instead of `{ ticker: raw }` or `{ ticker: { equals: raw } }`
/// anywhere a join is being made across the club's own tables.
export function tickerWhere(raw, field = 'ticker') {
  const variants = tickerVariants(raw);
  if (!variants.length) return { [field]: NO_MATCH };
  return { [field]: { in: variants, mode: 'insensitive' } };
}

/// Group a list of rows by security, for callers holding data from
/// several tables that all carry a ticker.
export function groupByTicker(rows, pick = (r) => r.ticker) {
  const out = new Map();
  for (const r of rows ?? []) {
    const k = tickerKey(pick(r));
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}
