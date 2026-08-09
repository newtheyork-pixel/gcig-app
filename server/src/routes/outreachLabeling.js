import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { SYSTEM_PROMPT, RISK } from '../services/outreachScreen.js';

// The calibration surface for the outreach screen. Every draft the screen
// has already read can be walked here and given a human verdict, so the
// places the model over- or under-flags stop being anecdotes and become a
// list. A second opinion (Grok, graded by hand) sits beside the human's
// as a tie-break the reviewer can still see disagree.
//
// This is the eval set, and it is deliberately walled off from the prompt:
// nothing recorded here is ever fed back to SYSTEM_PROMPT as an example,
// because a screen scored against cases it was also shown is scored
// against its own answer key. Same firewall as the golden eval.

const router = Router();
router.use(verifyJwt);

// Who may label. The same people who sign off on outreach going out, for
// the same reason: this is the club's compliance judgement, and it belongs
// with the members accountable for it. Mirrors canApproveOutreach.
function requireOutreachReviewer(req, res, next) {
  const u = req.user;
  const roles = u ? [u.role, ...(u.extraRoles || [])] : [];
  const ok =
    !!u &&
    (u.isSuperAdmin || roles.some((r) => r === 'President' || r === 'CIO' || r === 'FacultyAdvisor'));
  if (!ok) return res.status(403).json({ error: 'Outreach reviewer role required' });
  next();
}
router.use(requireOutreachReviewer);

// The three-level verdict the screen itself emits. A human label outside
// this set is a typo, not a new category.
const VALID_RISK = new Set([RISK.LOW, RISK.ELEVATED, RISK.PROHIBITED]);

// The FLAG-list behaviours, so a flag can name what it matched rather than
// gesture at unease. Shipped to the client as the category picker; a low
// verdict carries none. Kept in sync with SYSTEM_PROMPT's FLAG list.
const FLAG_CATEGORIES = [
  { key: 'mnpi', label: 'Asks for material non-public information' },
  { key: 'breach', label: 'Pushes a confidentiality breach' },
  { key: 'misrepresentation', label: 'Overstates who we are' },
  { key: 'payment', label: 'Offers or implies payment' },
  { key: 'inappropriate-recipient', label: 'Wrong person to ask (e.g. a sitting executive)' },
];
const VALID_CATEGORY = new Set(FLAG_CATEGORIES.map((c) => c.key));

const RANK = { low: 0, elevated: 1, prohibited: 2 };

// The screen against a reference verdict: do they agree, and if not, which
// way did the screen err. 'over' is the screen stricter than the reference
// (the noise that trains people to click past warnings); 'under' is the
// screen laxer (the dangerous direction). Null when either side has no
// comparable verdict.
function compareRisk(screen, ref) {
  const s = RANK[screen];
  const r = RANK[ref];
  if (s == null || r == null) return null;
  if (s === r) return 'agree';
  return s > r ? 'over' : 'under';
}

/**
 * Agreement across the labelled set. The live loop compares the screen to
 * GROK (the second opinion the reviewer records); the human verdict is
 * kept as an optional third column for the cases someone weighs in on.
 * Pure and exported so the arithmetic is tested rather than trusted.
 */
export function agreementMetrics(rows) {
  const tally = () => ({ compared: 0, agree: 0, overFlag: 0, underFlag: 0 });
  const m = {
    total: rows.length,
    screenVsGrok: tally(),
    screenVsClaude: tally(),
    screenVsHuman: tally(),
  };
  for (const row of rows) {
    for (const [key, ref] of [
      ['screenVsGrok', row.grokRisk],
      ['screenVsClaude', row.claudeRisk],
      ['screenVsHuman', row.humanRisk],
    ]) {
      const c = compareRisk(row.screenRisk, ref);
      if (!c) continue;
      const t = m[key];
      t.compared++;
      if (c === 'agree') t.agree++;
      else if (c === 'over') t.overFlag++;
      else t.underFlag++;
    }
  }
  return m;
}

/**
 * Pull a verdict out of whatever Grok replied. The prompt asks for strict
 * JSON, so the happy path is the first {...} block; but a chat model wraps
 * it in prose or fences often enough that a bare-word fallback is worth
 * having. Exported for tests. Returns { risk, reason } with risk null when
 * nothing legible is found — the caller decides that is not saveable.
 */
export function parseGrokVerdict(text) {
  if (text == null || text === '') return { risk: null, reason: null };
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(s.slice(start, end + 1));
      if (o && typeof o === 'object' && !Array.isArray(o) && VALID_RISK.has(o.risk)) {
        return { risk: o.risk, reason: o.reason != null ? String(o.reason).slice(0, 300) : null };
      }
    } catch {
      /* fall through to the bare-word scan */
    }
  }
  const m = s.toLowerCase().match(/\b(low|elevated|prohibited)\b/);
  return { risk: m ? m[1] : null, reason: null };
}

// The entire prompt the screen hands the model, flattened into one block
// a person can paste into Grok. Grok starts cold — no system message,
// none of our context — so the whole thing has to travel: the complete
// instructions (SYSTEM_PROMPT, which already ends by asking for the JSON
// verdict) and then this one email with its recipient. Nothing is
// summarised or trimmed. What the model is asked, Grok is asked; the
// labelled divider only marks where the rules stop and the email begins.
export function grokPromptFor(draft) {
  const t = draft.target || {};
  const context =
    `Recipient: ${t.name || 'unknown'}` +
    `\nTheir relationship to the company we are researching: ${t.relationship || 'unknown'}` +
    `\nCurrent employer: ${t.employer || 'unknown'}` +
    `\n\nSubject: ${draft.subject || ''}` +
    `\n\n${draft.body || ''}`;
  return `${SYSTEM_PROMPT}\n\n--- EMAIL TO REVIEW ---\n\n${context}`;
}

function draftRow(d) {
  return {
    id: d.id,
    subject: d.subject,
    body: d.body,
    target: d.target
      ? { name: d.target.name, relationship: d.target.relationship, employer: d.target.employer }
      : null,
    // What the screen decided about these words, and where the draft got
    // to — a blocked or rejected draft is exactly where the over-flags
    // hide, so it belongs in the queue even though it never sent.
    screenRisk: d.screenRisk,
    screenReason: d.screenReason,
    screenModelOk: d.screenModelOk,
    stage: d.sentAt ? 'sent' : d.rejectedAt ? 'rejected' : 'held',
    screenedAt: d.screenedAt,
    label: d.label
      ? {
          humanRisk: d.label.humanRisk,
          humanCategory: d.label.humanCategory,
          humanNote: d.label.humanNote,
          grokRisk: d.label.grokRisk,
          grokNote: d.label.grokNote,
          grokRaw: d.label.grokRaw,
          claudeRisk: d.label.claudeRisk,
          claudeReason: d.label.claudeReason,
          screenRiskAtLabel: d.label.screenRiskAtLabel,
          labeledBy: d.label.labeledBy?.name || null,
          updatedAt: d.label.updatedAt,
        }
      : null,
  };
}

const DRAFT_INCLUDE = {
  target: true,
  label: { include: { labeledBy: { select: { name: true } } } },
};

// The categories the client picker offers.
router.get('/config', (_req, res) => {
  res.json({ risks: [RISK.LOW, RISK.ELEVATED, RISK.PROHIBITED], categories: FLAG_CATEGORIES });
});

// The queue. Every draft the screen has actually read — sent, held or
// rejected — newest read first. filter=unlabeled hides ones already
// graded; filter=disagreements keeps only where the human differs from
// the frozen screen verdict.
router.get('/queue', async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const drafts = await prisma.outreachDraft.findMany({
      where: { screenedAt: { not: null } },
      include: DRAFT_INCLUDE,
      orderBy: { screenedAt: 'desc' },
      take: 500,
    });
    let rows = drafts.map(draftRow);
    // "Not yet graded" means no Grok verdict recorded — the loop's unit of
    // work. "Disagreements" is where the screen and Grok part ways.
    if (filter === 'unlabeled') rows = rows.filter((r) => !(r.label && r.label.grokRisk));
    else if (filter === 'disagreements')
      rows = rows.filter(
        (r) =>
          r.label &&
          r.label.screenRiskAtLabel &&
          r.label.grokRisk &&
          r.label.grokRisk !== r.label.screenRiskAtLabel
      );
    res.json({ rows });
  } catch (err) {
    console.error('outreach labeling queue failed:', err.message);
    res.status(500).json({ error: 'Could not load the queue' });
  }
});

// Agreement across everything labelled so far, plus the disagreement list
// — which is the prompt-improvement queue in disguise.
router.get('/metrics', async (_req, res) => {
  try {
    const labels = await prisma.outreachScreenLabel.findMany({
      include: { draft: { include: { target: true } } },
    });
    const rows = labels.map((l) => ({
      humanRisk: l.humanRisk,
      screenRisk: l.screenRiskAtLabel,
      grokRisk: l.grokRisk,
      claudeRisk: l.claudeRisk,
    }));
    const metrics = agreementMetrics(rows);
    // The prompt-improvement queue: where the screen and Grok disagree.
    const disagreements = labels
      .filter((l) => l.screenRiskAtLabel && l.grokRisk && l.grokRisk !== l.screenRiskAtLabel)
      .map((l) => ({
        draftId: l.draftId,
        subject: l.draft?.subject || '',
        screenRisk: l.screenRiskAtLabel,
        grokRisk: l.grokRisk,
        grokNote: l.grokNote,
        humanRisk: l.humanRisk,
        direction: RANK[l.screenRiskAtLabel] > RANK[l.grokRisk] ? 'over-flag' : 'under-flag',
      }));
    res.json({ metrics, disagreements });
  } catch (err) {
    console.error('outreach labeling metrics failed:', err.message);
    res.status(500).json({ error: 'Could not compute metrics' });
  }
});

// The exact block to paste into Grok, so its verdict grades the same
// words under the same instructions the screen used.
router.get('/:draftId/grok-prompt', async (req, res) => {
  const draftId = Number(req.params.draftId);
  if (!Number.isInteger(draftId)) return res.status(400).json({ error: 'Bad id' });
  try {
    const draft = await prisma.outreachDraft.findUnique({
      where: { id: draftId },
      include: { target: true },
    });
    if (!draft) return res.status(404).json({ error: 'No such draft' });
    res.json({ prompt: grokPromptFor(draft) });
  } catch (err) {
    console.error('outreach labeling grok-prompt failed:', err.message);
    res.status(500).json({ error: 'Could not build the prompt' });
  }
});

// Record (or update) the verdict on one draft. The screen's current call
// is frozen onto the label, because the draft's live screenRisk is
// rewritten the next time anyone edits the words and the label is about
// the words the grader saw.
router.post('/:draftId', async (req, res) => {
  const draftId = Number(req.params.draftId);
  if (!Number.isInteger(draftId)) return res.status(400).json({ error: 'Bad id' });

  const { humanRisk, humanCategory, humanNote, grokResponse } = req.body || {};

  // The human verdict is optional now. When present it must be valid, and
  // a category only makes sense on a flag — you cannot cite a FLAG-list
  // behaviour for a clean low.
  let hRisk = null;
  let category = null;
  if (humanRisk != null && humanRisk !== '') {
    if (!VALID_RISK.has(humanRisk)) {
      return res.status(400).json({ error: 'humanRisk must be low, elevated, or prohibited' });
    }
    hRisk = humanRisk;
    if (hRisk !== RISK.LOW) {
      if (humanCategory != null && humanCategory !== '' && !VALID_CATEGORY.has(humanCategory)) {
        return res.status(400).json({ error: 'humanCategory is not a known flag category' });
      }
      category = humanCategory || null;
    }
  }

  // Grok's verdict is parsed straight out of the reply the reviewer
  // pasted, so nothing is retyped.
  const grok = parseGrokVerdict(grokResponse);

  // Something comparable has to land, or there is nothing to score.
  if (!hRisk && !grok.risk) {
    const msg = grokResponse
      ? "Could not read a verdict from Grok's reply — paste the whole JSON it returned"
      : "Paste Grok's reply, or set your own verdict, before saving";
    return res.status(400).json({ error: msg });
  }

  try {
    const draft = await prisma.outreachDraft.findUnique({ where: { id: draftId } });
    if (!draft) return res.status(404).json({ error: 'No such draft' });

    const data = {
      humanRisk: hRisk,
      humanCategory: category,
      humanNote: humanNote ? String(humanNote).slice(0, 1000) : null,
      grokRisk: grok.risk,
      grokNote: grok.reason,
      grokRaw: grokResponse ? String(grokResponse).slice(0, 4000) : null,
      screenRiskAtLabel: draft.screenRisk,
      labeledById: req.user?.id ?? null,
    };
    const saved = await prisma.outreachScreenLabel.upsert({
      where: { draftId },
      create: { draftId, ...data },
      update: data,
    });
    const full = await prisma.outreachDraft.findUnique({
      where: { id: draftId },
      include: DRAFT_INCLUDE,
    });
    res.status(201).json({ label: saved, row: draftRow(full) });
  } catch (err) {
    console.error('outreach labeling save failed:', err.message);
    res.status(500).json({ error: 'Could not save the label' });
  }
});

// Record Claude's verdict, written by the offline grading pass. It touches
// ONLY the claude columns via upsert, so Grok's and the human's grades on
// the same draft are never overwritten — two independent second opinions
// kept side by side. Freezes the screen verdict on first write so the
// comparison is against the words Claude actually saw.
router.post('/:draftId/claude', async (req, res) => {
  const draftId = Number(req.params.draftId);
  if (!Number.isInteger(draftId)) return res.status(400).json({ error: 'Bad id' });
  const { risk, reason } = req.body || {};
  if (!VALID_RISK.has(risk)) {
    return res.status(400).json({ error: 'risk must be low, elevated, or prohibited' });
  }
  try {
    const draft = await prisma.outreachDraft.findUnique({ where: { id: draftId } });
    if (!draft) return res.status(404).json({ error: 'No such draft' });
    const claude = { claudeRisk: risk, claudeReason: reason ? String(reason).slice(0, 600) : null };
    await prisma.outreachScreenLabel.upsert({
      where: { draftId },
      create: { draftId, screenRiskAtLabel: draft.screenRisk, ...claude },
      // Only the claude columns; grok/human and the frozen screen verdict
      // are left exactly as they were.
      update: claude,
    });
    const full = await prisma.outreachDraft.findUnique({ where: { id: draftId }, include: DRAFT_INCLUDE });
    res.status(201).json({ row: draftRow(full) });
  } catch (err) {
    console.error('outreach labeling claude save failed:', err.message);
    res.status(500).json({ error: 'Could not save the Claude verdict' });
  }
});

export default router;
