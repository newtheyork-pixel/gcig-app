import prisma from '../db.js';

// The club's own research, as one list.
//
// Two tables hold everything we've ever written: Report (member-authored
// write-ups) and Pitch (the decks presented to the room). They don't
// share a shape — a report has a title and an author, a pitch has a
// ticker and a presenter — so this module flattens both into a single
// record the terminal can render without caring which table it came
// from. Everything downstream (RSCH, search, the reader pane) speaks
// only this shape.
//
// Ids are namespaced strings ("report:12", "pitch:3") rather than bare
// integers, because 12 means two different documents depending on which
// table you ask. Callers pass the whole string back and parseRef sorts
// it out.

// A rendered document is the point of the panel, so items whose file we
// can't reach are still listed — a member should know a pitch happened
// even if nobody uploaded the deck. `fileRef: null` marks those.
function normalizeReport(r) {
  return {
    id: `report:${r.id}`,
    kind: 'report',
    title: r.title,
    author: r.author,
    ticker: r.ticker || null,
    date: r.date,
    description: r.description || null,
    fileRef: r.fileUrl || null,
    // Reports carry no vote — the outcome column is a pitch concept.
    outcome: null,
    industry: null,
  };
}

function normalizePitch(p) {
  // A pitch has no title of its own. Build one that reads like a
  // document name in a list: "AIT — Pitch (Industrials)".
  const industry = p.industry?.name || null;
  const title = `${p.ticker} — Pitch${industry ? ` (${industry})` : ''}`;
  // Presenters are the club's record of who actually stood up; the
  // legacy pitcherName column is the fallback for older rows.
  const presenters = (p.presenters || [])
    .map((x) => x.user?.name)
    .filter(Boolean);
  return {
    id: `pitch:${p.id}`,
    kind: 'pitch',
    title,
    author: presenters.length ? presenters.join(', ') : p.pitcherName,
    ticker: p.ticker,
    date: p.date,
    description: p.location ? `Presented at ${p.location}` : null,
    fileRef: p.slideshowUrl || null,
    outcome: p.votedOutcome || null,
    industry,
  };
}

/**
 * Split a namespaced id back into its table and row.
 * Returns null for anything that isn't a well-formed reference —
 * callers should treat that as a 400, not a lookup miss.
 */
export function parseRef(ref) {
  const m = /^(report|pitch):(\d+)$/.exec(String(ref || ''));
  if (!m) return null;
  return { kind: m[1], id: Number(m[2]) };
}

const PITCH_INCLUDE = {
  industry: { select: { name: true } },
  presenters: { select: { user: { select: { name: true } } } },
};

const defaultLoadReports = (symbol) =>
  prisma.report.findMany({
    where: symbol ? { ticker: symbol } : undefined,
    orderBy: { date: 'desc' },
  });

const defaultLoadPitches = (symbol) =>
  prisma.pitch.findMany({
    where: symbol ? { ticker: symbol } : undefined,
    orderBy: { date: 'desc' },
    include: PITCH_INCLUDE,
  });

/**
 * The whole internal archive, newest first.
 *
 * @param {object} opts
 * @param {string} opts.ticker - Restrict to one symbol (case-insensitive)
 * @param {string} opts.q - Free-text filter over title, author, ticker, description
 * @param {number} opts.limit - Cap the result set (default 200)
 * @param {object} deps - Injectable loaders, for tests
 */
export async function listResearch(
  { ticker = null, q = null, limit = 200 } = {},
  deps = {}
) {
  const loadReports = deps.loadReports || defaultLoadReports;
  const loadPitches = deps.loadPitches || defaultLoadPitches;
  const symbol = ticker ? String(ticker).trim().toUpperCase() : null;

  // Ticker is an indexed-ish equality filter, so push it to the
  // database. Free text is not: it has to span two tables with
  // different column names, and the archive is small enough (hundreds
  // of rows, not millions) that filtering in memory beats maintaining
  // a search index nobody asked for. Revisit if this ever gets slow.
  const [reports, pitches] = await Promise.all([
    loadReports(symbol),
    loadPitches(symbol),
  ]);

  let items = [...reports.map(normalizeReport), ...pitches.map(normalizePitch)];

  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase();
    items = items.filter((it) =>
      [it.title, it.author, it.ticker, it.description, it.industry]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    );
  }

  // One merged chronology — the two tables interleave, so sorting has
  // to happen after the concat, not inside either query.
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  return items.slice(0, Math.max(1, Math.min(limit, 500)));
}

/**
 * One document by namespaced id, in the same shape listResearch emits.
 * Returns null when the reference is malformed or the row is gone.
 */
export async function getResearchItem(ref) {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'report') {
    const row = await prisma.report.findUnique({ where: { id: parsed.id } });
    return row ? normalizeReport(row) : null;
  }
  const row = await prisma.pitch.findUnique({
    where: { id: parsed.id },
    include: PITCH_INCLUDE,
  });
  return row ? normalizePitch(row) : null;
}

/**
 * Cached AI summaries for a batch of file refs, as a
 * `{ [fileRef]: summaryRow }` map. One query for the whole list so the
 * index can show which documents already have a read without N+1.
 */
export async function summariesFor(fileRefs) {
  const refs = [...new Set(fileRefs.filter(Boolean))];
  if (refs.length === 0) return {};
  const rows = await prisma.fileSummary.findMany({
    where: { fileRef: { in: refs } },
  });
  return Object.fromEntries(rows.map((r) => [r.fileRef, r]));
}
