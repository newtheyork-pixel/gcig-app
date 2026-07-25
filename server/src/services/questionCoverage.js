import { SUPPORT } from './corroboration.js';

// How well is each research question actually answered?
//
// This is the difference between a project that finishes and one that
// merely stops. A ledger tells you what people said; coverage tells you
// whether what they said bears on the thing you set out to learn, and
// whether enough independent voices bear on it to lean on the answer.
// The questions still showing thin are the outreach list for next week.
//
// Two kinds of evidence feed a question and they are counted, but never
// merged:
//
//   claims       — said on tape, pinned to a millisecond. Walk-backable.
//   observations — seen with someone's own eyes on a site visit. Often
//                  stronger than hearsay, but there is no recording to
//                  return to, so it is a different kind of knowing.
//
// Merging them would let three store visits by one analyst read as
// "well corroborated", which is one person's Tuesday afternoon wearing a
// crowd's clothing.

export const COVERAGE = {
  UNADDRESSED: 'unaddressed',
  THIN: 'thin',
  SUPPORTED: 'supported',
  CONTESTED: 'contested',
};

/**
 * Assess one question against the evidence attached to it.
 *
 * @param {object} question - { id, text, status }
 * @param {Array} claims - claims linked to this question, joined to
 *   interview + source
 * @param {Array} observations - site observations linked to it, joined
 *   to their visit
 * @param {Set} disputedClaimIds - claims a human has flagged as contested
 */
export function assessQuestion(question, claims = [], observations = [], disputedClaimIds = new Set()) {
  const sourceIds = new Set();
  const employers = new Set();
  let unknownEmployers = 0;

  for (const c of claims) {
    const src = c.interview?.source;
    if (src?.id != null) sourceIds.add(src.id);
    if (src?.employer) employers.add(src.employer.trim().toLowerCase());
    else unknownEmployers += 1;
  }

  // Independence for observations is the visited LOCATION, not the
  // analyst. Two people describing the same store is one data point
  // about that store; one person visiting eight stores is eight.
  const locations = new Set();
  for (const o of observations) {
    const loc = o.visit?.location;
    if (loc) locations.add(loc.trim().toLowerCase());
  }

  const independentLines = employers.size + unknownEmployers;
  const contested = claims.some((c) => disputedClaimIds.has(c.id));

  let coverage;
  if (claims.length === 0 && observations.length === 0) {
    coverage = COVERAGE.UNADDRESSED;
  } else if (contested) {
    coverage = COVERAGE.CONTESTED;
  } else if (independentLines >= 2 || locations.size >= 3) {
    // Two independent employers on tape, or three separate locations
    // seen. Either is a real answer; one store and one voice is not.
    coverage = COVERAGE.SUPPORTED;
  } else {
    coverage = COVERAGE.THIN;
  }

  return {
    questionId: question.id,
    text: question.text,
    // The human's call. A question is only closed because someone
    // decided it was, never because a threshold was crossed.
    status: question.status,
    coverage,
    claimCount: claims.length,
    observationCount: observations.length,
    distinctSources: sourceIds.size,
    independentLines,
    distinctLocations: locations.size,
    // Facts carry differently from forecasts. A question "answered"
    // entirely by people's predictions is not answered.
    factCount: claims.filter((c) => c.kind === 'fact').length,
    opinionCount: claims.filter((c) => c.kind === 'opinion').length,
    forecastCount: claims.filter((c) => c.kind === 'forecast').length,
    claimIds: claims.map((c) => c.id),
  };
}

/**
 * Coverage across a whole project, plus the summary a reader wants
 * first: how much of what we set out to learn do we actually know?
 */
export function assessCoverage(questions, claims, observations, contradictions = []) {
  const disputed = new Set();
  for (const [a, b] of contradictions) {
    disputed.add(a);
    disputed.add(b);
  }

  const claimsByQ = new Map();
  for (const c of claims || []) {
    if (c.questionId == null) continue;
    if (!claimsByQ.has(c.questionId)) claimsByQ.set(c.questionId, []);
    claimsByQ.get(c.questionId).push(c);
  }
  const obsByQ = new Map();
  for (const o of observations || []) {
    if (o.questionId == null) continue;
    if (!obsByQ.has(o.questionId)) obsByQ.set(o.questionId, []);
    obsByQ.get(o.questionId).push(o);
  }

  const rows = (questions || []).map((q) =>
    assessQuestion(q, claimsByQ.get(q.id) || [], obsByQ.get(q.id) || [], disputed)
  );

  // Evidence that answers something nobody thought to ask. Worth
  // surfacing rather than hiding — an unasked question the fieldwork
  // kept answering is usually the most interesting thing in a project.
  const unlinkedClaims = (claims || []).filter((c) => c.questionId == null).length;

  const open = rows.filter((r) => r.status === 'Open');
  return {
    questions: rows,
    summary: {
      total: rows.length,
      unaddressed: rows.filter((r) => r.coverage === COVERAGE.UNADDRESSED).length,
      thin: rows.filter((r) => r.coverage === COVERAGE.THIN).length,
      supported: rows.filter((r) => r.coverage === COVERAGE.SUPPORTED).length,
      contested: rows.filter((r) => r.coverage === COVERAGE.CONTESTED).length,
      answeredByHuman: rows.filter((r) => r.status === 'Answered').length,
      unlinkedClaims,
      // The single most useful line in the whole panel: what is still
      // open AND has nothing behind it. That is next week's call list.
      openAndUnaddressed: open.filter((r) => r.coverage === COVERAGE.UNADDRESSED).length,
    },
  };
}

/**
 * Outreach funnel counts. "Who haven't we tried yet" is the number that
 * actually paces a project.
 */
export function funnel(targets = []) {
  const out = {
    Identified: 0, Contacted: 0, Scheduled: 0,
    Completed: 0, Declined: 0, Unreachable: 0,
  };
  for (const t of targets) {
    if (out[t.status] != null) out[t.status] += 1;
  }
  const reached = out.Completed;
  const attempted = out.Contacted + out.Scheduled + out.Completed + out.Declined + out.Unreachable;
  return {
    ...out,
    total: targets.length,
    attempted,
    // Conversion is worth watching: a low rate usually means the ask is
    // wrong, not that the industry is unfriendly.
    conversionPct: attempted > 0 ? Math.round((reached / attempted) * 100) : null,
  };
}

// Re-exported so callers get one import for the whole assessment layer.
export { SUPPORT };
