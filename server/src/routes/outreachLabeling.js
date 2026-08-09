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

/**
 * Where the screen and the human agree, and — when they do not — which
 * way the screen erred. Over-flagging is the screen stricter than the
 * truth (the noise that trains people to click past warnings);
 * under-flagging is the screen missing what a person caught (the
 * dangerous direction). Pure and exported so the arithmetic is tested
 * rather than trusted.
 */
export function agreementMetrics(rows) {
  const m = {
    total: rows.length,
    screen: { compared: 0, agree: 0, overFlag: 0, underFlag: 0 },
    grok: { compared: 0, agree: 0, disagree: 0 },
  };
  for (const r of rows) {
    const h = RANK[r.humanRisk];
    if (h == null) continue;
    const s = RANK[r.screenRisk];
    if (s != null) {
      m.screen.compared++;
      if (s === h) m.screen.agree++;
      else if (s > h) m.screen.overFlag++;
      else m.screen.underFlag++;
    }
    const g = RANK[r.grokRisk];
    if (g != null) {
      m.grok.compared++;
      if (g === h) m.grok.agree++;
      else m.grok.disagree++;
    }
  }
  return m;
}

// The email as the screen saw it, so a paste into Grok grades the same
// words with the same instructions the model was given. Mirrors the user
// content screenOutreach builds.
function grokPromptFor(draft) {
  const t = draft.target || {};
  const text = `Subject: ${draft.subject || ''}\n\n${draft.body || ''}`;
  const context =
    `Recipient: ${t.name || 'unknown'}` +
    `\nTheir relationship to the company we are researching: ${t.relationship || 'unknown'}` +
    `\nCurrent employer: ${t.employer || 'unknown'}` +
    `\n\n${text}`;
  return `${SYSTEM_PROMPT}\n\n---\n\n${context}`;
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
    if (filter === 'unlabeled') rows = rows.filter((r) => !r.label);
    else if (filter === 'disagreements')
      rows = rows.filter(
        (r) => r.label && r.label.screenRiskAtLabel && r.label.humanRisk !== r.label.screenRiskAtLabel
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
    }));
    const metrics = agreementMetrics(rows);
    const disagreements = labels
      .filter((l) => l.screenRiskAtLabel && l.humanRisk !== l.screenRiskAtLabel)
      .map((l) => ({
        draftId: l.draftId,
        subject: l.draft?.subject || '',
        screenRisk: l.screenRiskAtLabel,
        humanRisk: l.humanRisk,
        humanCategory: l.humanCategory,
        grokRisk: l.grokRisk,
        direction: RANK[l.screenRiskAtLabel] > RANK[l.humanRisk] ? 'over-flag' : 'under-flag',
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

  const { humanRisk, humanCategory, humanNote, grokRisk, grokNote } = req.body || {};
  if (!VALID_RISK.has(humanRisk)) {
    return res.status(400).json({ error: 'humanRisk must be low, elevated, or prohibited' });
  }
  // A category only makes sense on a flag, and must name a real one. A low
  // verdict clears it — you cannot cite a FLAG-list behaviour for a clean
  // email.
  let category = null;
  if (humanRisk !== RISK.LOW) {
    if (humanCategory != null && humanCategory !== '' && !VALID_CATEGORY.has(humanCategory)) {
      return res.status(400).json({ error: 'humanCategory is not a known flag category' });
    }
    category = humanCategory || null;
  }
  if (grokRisk != null && grokRisk !== '' && !VALID_RISK.has(grokRisk)) {
    return res.status(400).json({ error: 'grokRisk must be low, elevated, or prohibited' });
  }

  try {
    const draft = await prisma.outreachDraft.findUnique({ where: { id: draftId } });
    if (!draft) return res.status(404).json({ error: 'No such draft' });

    const data = {
      humanRisk,
      humanCategory: category,
      humanNote: humanNote ? String(humanNote).slice(0, 1000) : null,
      grokRisk: grokRisk || null,
      grokNote: grokNote ? String(grokNote).slice(0, 1000) : null,
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

export default router;
