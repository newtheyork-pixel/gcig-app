// Triangulation: does a claim hold up across independent sources?
//
// One person saying a thing is an anecdote. The value of field research
// is in the second and third voice — and in noticing when they are not
// actually independent. Two former employees from the same team who
// heard it from the same manager are one source wearing two coats, and a
// report that counts them as two is overstating its evidence.
//
// So corroboration here is not a count of matching claims. It is a count
// of distinct sources, discounted when those sources share an employer,
// and it deliberately refuses to promote a claim on volume alone.
//
// Nothing in here judges whether a claim is TRUE. It reports how much
// independent support exists, which is the honest thing a research
// system can offer.

// Corroboration levels, in ascending order of support.
export const SUPPORT = {
  SINGLE: 'single-source',
  // More than one voice, but they share an employer — so possibly one
  // origin. Named rather than hidden, because this is the failure mode
  // that flatters a thesis.
  CLUSTERED: 'clustered',
  CORROBORATED: 'corroborated',
  CONTESTED: 'contested',
};

/**
 * Group claims by topic and assess support for each group.
 *
 * @param {Array} claims - rows joined to their interview + source, i.e.
 *   { id, text, topic, kind, ticker, interview: { id, sourceId,
 *     source: { id, alias, employer, relationship } } }
 * @param {Array} contradictions - optional [[claimIdA, claimIdB], …]
 *   pairs a human has marked as disagreeing
 */
export function assessTopics(claims, contradictions = []) {
  const disputed = new Set();
  for (const [a, b] of contradictions) {
    disputed.add(a);
    disputed.add(b);
  }

  const groups = new Map();
  for (const c of claims || []) {
    // Claims with no topic can't be triangulated — they still belong in
    // the ledger, just not in a support group. Silently bucketing them
    // together under "" would invent agreement.
    if (!c?.topic) continue;
    const key = c.topic;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const out = [];
  for (const [topic, rows] of groups) {
    const sourceIds = new Set();
    const employers = new Set();
    let anonymousEmployers = 0;
    for (const r of rows) {
      const src = r.interview?.source;
      if (src?.id != null) sourceIds.add(src.id);
      // An unknown employer cannot be assumed distinct OR shared.
      // Counted separately so it never silently creates independence.
      if (src?.employer) employers.add(src.employer.trim().toLowerCase());
      else anonymousEmployers += 1;
    }

    const distinctSources = sourceIds.size;
    // Independence is bounded by distinct employers. Two sources at one
    // employer are treated as one line of evidence.
    const independentLines = employers.size + anonymousEmployers;

    let support;
    if (rows.some((r) => disputed.has(r.id))) {
      support = SUPPORT.CONTESTED;
    } else if (distinctSources <= 1) {
      support = SUPPORT.SINGLE;
    } else if (independentLines <= 1) {
      support = SUPPORT.CLUSTERED;
    } else {
      support = SUPPORT.CORROBORATED;
    }

    out.push({
      topic,
      support,
      claimCount: rows.length,
      distinctSources,
      independentLines,
      // Facts and forecasts are not the same currency. A topic supported
      // only by opinion should not read as established, however many
      // people hold the opinion.
      factCount: rows.filter((r) => r.kind === 'fact').length,
      opinionCount: rows.filter((r) => r.kind === 'opinion').length,
      forecastCount: rows.filter((r) => r.kind === 'forecast').length,
      claimIds: rows.map((r) => r.id),
    });
  }

  // Best-supported first, then by weight of evidence.
  const rank = {
    [SUPPORT.CONTESTED]: 0,
    [SUPPORT.CORROBORATED]: 1,
    [SUPPORT.CLUSTERED]: 2,
    [SUPPORT.SINGLE]: 3,
  };
  out.sort((a, b) => {
    if (rank[a.support] !== rank[b.support]) return rank[a.support] - rank[b.support];
    return b.distinctSources - a.distinctSources || b.claimCount - a.claimCount;
  });
  return out;
}

/**
 * A citation string for a claim, in the form a footnote wants.
 * Uses the source alias, never the real name — sources are usually
 * promised anonymity and the alias is the citable identity.
 */
export function formatCitation(claim, { formatStamp }) {
  const src = claim.interview?.source;
  const who = src?.alias || 'unattributed source';
  const role = src?.relationship ? describeRelationship(src.relationship) : null;
  const when = claim.interview?.conductedAt
    ? new Date(claim.interview.conductedAt).toISOString().slice(0, 10)
    : null;
  const at = formatStamp ? formatStamp(claim.startMs) : null;
  return [
    `C${claim.id}`,
    [who, role].filter(Boolean).join(', '),
    when,
    at,
  ]
    .filter(Boolean)
    .join(' · ');
}

function describeRelationship(rel) {
  const map = {
    FormerEmployee: 'former employee',
    CurrentEmployee: 'current employee',
    Customer: 'customer',
    Distributor: 'distributor',
    Supplier: 'supplier',
    Competitor: 'competitor',
    IndustryExpert: 'industry expert',
  };
  return map[rel] || null;
}
