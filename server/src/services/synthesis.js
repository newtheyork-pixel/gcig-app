import { llmChat, RESEARCH_LOCAL_MODEL } from './llm.js';
import { COVERAGE } from './questionCoverage.js';

// Drafts the memo at the end of a field-research project.
//
// This is the last stage of the process and the one where a research
// system most easily betrays everything the earlier stages bought. A
// model handed a pile of claims will write fluent prose that states
// single-source hearsay as established fact, quietly drops the
// inconvenient claim, and invents a citation number when it wants one.
// All three failures produce a document that reads better than the
// evidence supports, which is the specific way research goes wrong.
//
// Three defences, in order of importance:
//
//   1. Citations are verified, not trusted. Every [C123] in the output
//      must match a claim id we actually supplied. Invented references
//      are stripped and counted — the same gate claimExtraction applies
//      to quotes, for the same reason.
//   2. Support level is in the prompt, per question. A question backed
//      by one voice is required to say so in the prose. The model is not
//      asked to judge confidence; it is told the confidence and asked to
//      write at it.
//   3. Gaps are output, never omitted. Questions with no evidence appear
//      in the memo as open, because the most dangerous memo is the one
//      that reads complete because the holes were left out.

const MAX_CLAIMS_IN_PROMPT = 120;

const SYSTEM_PROMPT = `You are drafting an internal research memo for an investment team, from field research the team conducted themselves — interviews with former employees, distributors, customers, competitors, plus direct store visits.

You write ONLY from the evidence supplied. You have no other knowledge of this company and must not supply any. If something is not in the evidence, it does not go in the memo.

For each question you are given:
  - Its support level is stated. Write at that level, do not exceed it:
      SUPPORTED  — multiple independent sources. State it plainly.
      THIN       — one source, or one location. You MUST say so in the prose ("a single former distributor reports…", "observed at one store…"). Never state a thin finding as established.
      CONTESTED  — sources disagree. Present both sides; do not resolve it.
      NO EVIDENCE — say the question is open and what would answer it.
  - Its claims, each with an id like C47.

Citation rules, which matter more than the prose:
  - Every factual sentence carries the id(s) it rests on, in square brackets: "Rebates were cut roughly 200bp in Q2 [C47]."
  - Use ONLY ids that appear in the evidence given. Never invent an id, never guess one, never cite a range.
  - A sentence with no citation must be your own framing or a statement of what is unknown — never a fact.

Distinguish the kinds of evidence in your wording. A "fact" is something the source observed or did. An "opinion" is their read. A "forecast" is a claim about the future — never write a forecast as though it happened. An "observation" was seen directly by our team on a site visit; say so, since it is different from something we were told.

Structure, using these exact headers:

## What we set out to learn
One short paragraph naming the questions, from the brief.

## What we found
One subsection per question that has evidence, with the question as a bold lead-in. Longest for SUPPORTED, briefest for THIN.

## What remains open
Every question with no evidence or thin support, and what specifically would close it. Be concrete about who to talk to.

## How much to trust this
Two or three sentences: how many independent sources, where the evidence is thin, what would change the read. Be blunt.

Constraints:
- Under 900 words.
- Plain prose. No bullet lists inside subsections.
- No market commentary, no valuation, no recommendation. This memo reports what the fieldwork found, nothing else.`;

// Pull every [C123] reference out of the draft.
function citedIds(text) {
  const out = new Set();
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const part of m[1].split(/[,;\s]+/)) {
      const id = /^C(\d+)$/i.exec(part.trim());
      if (id) out.add(Number(id[1]));
    }
  }
  return out;
}

/**
 * Strip citations that don't correspond to supplied evidence.
 *
 * A fabricated id is worse than a missing one: it looks checkable and
 * isn't, and a reader who spot-checks two real ones will trust the rest.
 * Removed references are counted so a bad run is visible rather than
 * silently shipped.
 *
 * Exported for tests — this is the integrity gate of the memo.
 */
export function stripInventedCitations(draft, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  let removed = 0;
  const cleaned = String(draft || '').replace(/\[([^\]]+)\]/g, (whole, inner) => {
    const parts = inner.split(/[,;]\s*/).map((p) => p.trim()).filter(Boolean);
    // Only touch bracket groups that look like citations; leave prose
    // brackets alone.
    if (!parts.every((p) => /^C\d+$/i.test(p))) return whole;
    const kept = parts.filter((p) => valid.has(Number(p.slice(1))));
    removed += parts.length - kept.length;
    return kept.length ? `[${kept.join(', ')}]` : '';
  });
  // Collapse the double spaces a removed citation leaves behind.
  return { text: cleaned.replace(/[ \t]{2,}/g, ' ').replace(/ ([.,;])/g, '$1'), removed };
}

function describeSupport(coverage) {
  switch (coverage) {
    case COVERAGE.SUPPORTED: return 'SUPPORTED';
    case COVERAGE.CONTESTED: return 'CONTESTED';
    case COVERAGE.THIN: return 'THIN';
    default: return 'NO EVIDENCE';
  }
}

// Build the evidence block the model reads. Claims are grouped under the
// question they answer, with their kind and source relationship, because
// "a former employee stated" and "a competitor speculated" are not the
// same sentence.
export function buildEvidence(project, coverage) {
  const byQuestion = new Map();
  for (const c of project.claims || []) {
    const k = c.questionId ?? 'unlinked';
    if (!byQuestion.has(k)) byQuestion.set(k, []);
    byQuestion.get(k).push(c);
  }

  const lines = [];
  lines.push(`PROJECT: ${project.name}${project.ticker ? ` (${project.ticker})` : ''}`);
  if (project.brief) lines.push(`BRIEF: ${project.brief}`);
  lines.push('');

  let budget = MAX_CLAIMS_IN_PROMPT;
  for (const q of coverage.questions || []) {
    lines.push(`QUESTION ${q.questionId}: ${q.text}`);
    lines.push(`SUPPORT: ${describeSupport(q.coverage)} — ${q.independentLines} independent source(s), ${q.observationCount} direct observation(s) across ${q.distinctLocations} location(s)`);
    const claims = (byQuestion.get(q.questionId) || []).slice(0, budget);
    budget -= claims.length;
    if (claims.length === 0) {
      lines.push('  (no evidence gathered)');
    }
    for (const c of claims) {
      const rel = c.interview?.source?.relationship || 'source';
      const alias = c.interview?.source?.alias || 'unattributed';
      lines.push(`  C${c.id} [${c.kind}] (${alias}, ${rel}): ${c.text}`);
    }
    lines.push('');
  }

  const unlinked = (byQuestion.get('unlinked') || []).slice(0, Math.max(0, budget));
  if (unlinked.length) {
    // Material that answers something nobody asked is often the most
    // interesting thing in a project — it goes to the model rather than
    // being dropped for not fitting the outline.
    lines.push('EVIDENCE NOT LINKED TO ANY QUESTION (may still matter):');
    for (const c of unlinked) {
      const alias = c.interview?.source?.alias || 'unattributed';
      lines.push(`  C${c.id} [${c.kind}] (${alias}): ${c.text}`);
    }
    lines.push('');
  }

  const observations = (project.visits || []).flatMap((v) =>
    (v.siteObservations || []).map((o) => `  ${v.location}${v.dayPart ? ` (${v.dayPart})` : ''}: ${o.text}`)
  );
  if (observations.length) {
    lines.push('DIRECT OBSERVATIONS (seen by our team, no recording — cite as observed, not reported):');
    lines.push(...observations.slice(0, 40));
  }

  return lines.join('\n');
}

/**
 * Draft the memo.
 *
 * Returns { draft, citedCount, removedCitations, unavailable }. Never
 * throws — a failed synthesis leaves the project exactly as it was.
 *
 * @param {object} project - with claims, visits, name, brief
 * @param {object} coverage - from assessCoverage
 * @param {object} deps - injectable chat, for tests
 */
export async function synthesize(project, coverage, deps = {}) {
  const claims = project?.claims || [];
  const hasObservations = (project?.visits || []).some((v) => v.siteObservations?.length);
  if (claims.length === 0 && !hasObservations) {
    return {
      draft: null,
      unavailable: true,
      reason: 'There is no evidence on this project yet — nothing to synthesize.',
    };
  }

  const chat = deps.llmChat || llmChat;
  const raw = await chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildEvidence(project, coverage) },
    ],
    temperature: 0.2,
    timeoutMs: 180_000,
    preferQuality: true,
    localModel: RESEARCH_LOCAL_MODEL,
  });
  if (!raw) {
    return { draft: null, unavailable: true, reason: 'The research model is unavailable right now.' };
  }

  const validIds = new Set(claims.map((c) => c.id));
  const { text, removed } = stripInventedCitations(raw, validIds);

  return {
    draft: text,
    citedCount: citedIds(text).size,
    // A non-zero count here means the model reached for evidence it did
    // not have. Worth showing the author before they trust the draft.
    removedCitations: removed,
    evidenceCount: claims.length,
  };
}
