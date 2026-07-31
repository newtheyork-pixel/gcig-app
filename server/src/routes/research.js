import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { isSuperAdminEmail, verifyJwt, requireRole } from '../middleware/auth.js';
import { transcribe, isConfigured as transcriptionConfigured, formatStamp, parseTranscriptText } from '../services/transcription.js';
import { extractClaims } from '../services/claimExtraction.js';
import { scanForAnswer } from '../services/answerScan.js';
import { assessTopics, formatCitation } from '../services/corroboration.js';
import { assessCoverage, funnel } from '../services/questionCoverage.js';
import { assessOutreach } from '../services/followUp.js';
import { synthesize } from '../services/synthesis.js';
import { screenTranscript, RISK } from '../services/mnpiScreen.js';
import { screenOutreach } from '../services/outreachScreen.js';
import { uploadFile } from '../services/oneDriveStorage.js';

// Field research — sources, interviews, and the claim ledger.
//
// The invariant this router exists to hold: a claim is only ever created
// from a transcript the server produced, pinned to an offset the server
// verified. There is deliberately no endpoint that accepts a
// hand-written claim with a hand-typed timestamp. If that is ever added,
// the citation chain stops meaning anything, because a footnote would no
// longer guarantee someone actually said the words.
//
// Recordings are people's voices given under a promise. Everything here
// is gated to analysts and above, quarantined interviews are excluded
// from every read path, and source real names never leave the server in
// a citation.

const router = Router();
router.use(verifyJwt);

// Field research is a PM-and-above activity — the same bar that governs
// pitching and editing reports.
const canResearch = requireRole('Analyst');

const upload = multer({
  storage: multer.memoryStorage(),
  // Interviews are long. 200 MB covers ~2 hours of compressed audio.
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Transcription costs real money per minute and extraction burns GPU
// time. Generous for genuine use, tight enough to stop a loop.
// 20/hour was too tight for real use: re-extracting a project's
// interviews after a prompt change is a normal thing to do and hits it
// immediately. Still bounded, so a runaway loop cannot burn the GPU.
const heavyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 80,
  keyGenerator: (req) => `research-heavy:${req.user?.id || req.ip}`,
  message: { error: 'Transcription rate limit reached. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Quarantined interviews are excluded everywhere claims are read. They
// stay in the database for the audit trail — that is the whole point of
// quarantine rather than deletion — but their claims must never reach a
// report.
const CITABLE = { quarantined: false };

const SOURCE_PUBLIC = {
  id: true,
  alias: true,
  role: true,
  employer: true,
  relationship: true,
  tickers: true,
};

// ── Projects ─────────────────────────────────────────────────────────
//
// A project is the whole effort on one company: the brief, the question
// guides, the interviews, the photos, the pricing sheets, the memo. One
// row to open and everything is there — which is the difference between
// research someone can reproduce next year and a folder nobody can
// reconstruct.

// Kinds exist so a project can be read at a glance, not to police what
// belongs. A name worked properly is not only interviews: there is a
// valuation model, the filings and transcripts it was built from, the
// comps, the notes. Anything without a home lands in `other` rather than
// being kept in someone's Downloads folder, which is the only outcome
// that actually loses work.
const ARTIFACT_KINDS = new Set([
  'guide', 'script', 'document', 'data', 'model', 'filing', 'photo', 'memo', 'other',
]);
const PROJECT_STATUSES = new Set(['Open', 'Fieldwork', 'Synthesis', 'Closed']);

router.get('/projects', async (req, res) => {
  try {
    // Owner-only projects never enter a non-owner's payload at all, the
    // same rule artifacts follow: filtering in the query rather than the
    // response is the difference between not sending it and hoping the
    // client does not render it.
    const visibility = isSuperAdminEmail(req.user?.email) ? {} : { ownerOnly: false };
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
    const projects = await prisma.researchProject.findMany({
      // One where, not two: a second `where` key silently replaces the
      // first in an object literal, which quietly disabled the
      // owner-only filter entirely.
      where: { ...visibility, ...(ticker ? { ticker } : {}) },
      orderBy: { updatedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { interviews: true, artifacts: true } },
      },
    });
    res.json(projects);
  } catch (err) {
    console.error('research/projects failed:', err.message);
    res.status(500).json({ error: 'Could not load projects' });
  }
});

// One project, fully assembled: artifacts, interviews, and the claim
// ledger with triangulation. This is what the terminal panel opens, and
// it is deliberately one request — a research surface that makes you
// click four times to see what you have is a filing cabinet, not a
// workspace.
router.get('/projects/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const project = await prisma.researchProject.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true } },
        artifacts: {
          // Owner-only material never enters a non-owner's payload at
          // all. Filtering in the query rather than the response is the
          // difference between not sending it and hoping the client
          // does not render it.
          where: isSuperAdminEmail(req.user?.email) ? {} : { ownerOnly: false },
          // Key documents first, then newest. Recency is the right
          // default for everything else and exactly wrong for the three
          // files that carry the argument: they are written early and
          // revised rarely, so pure recency buries them under every
          // screenshot taken since.
          orderBy: [{ keyDoc: 'desc' }, { createdAt: 'desc' }],
          include: { uploadedBy: { select: { id: true, name: true } } },
        },
        interviews: {
          orderBy: { conductedAt: 'desc' },
          // Explicit columns, because `include` returns every scalar and
          // one of them is transcriptWords — the per-word timing array
          // the extractor needs and the browser never opens. It was 1.3 MB
          // of a 1.9 MB payload, shipped on every open of the panel, to
          // be parsed and thrown away. The transcript TEXT stays: that is
          // what the Transcript button shows.
          select: {
            id: true, title: true, ticker: true, conductedAt: true, status: true,
            durationMs: true, transcript: true, transcriptModel: true,
            consentObtained: true, consentNote: true, attestedAt: true,
            mnpiRisk: true, screenedAt: true, screenResult: true,
            quarantined: true, quarantineNote: true,
            reviewedAt: true, reviewNote: true,
            projectId: true, sourceId: true, createdAt: true,
            source: { select: SOURCE_PUBLIC },
            _count: { select: { claims: true } },
          },
        },
        questions: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
        // Call order first, most-recently-touched after. An unranked
        // name sorts last rather than disappearing — nulls: 'last' is
        // the whole point, since Postgres would otherwise put them at
        // the front of an ascending sort and bury the person we
        // decided to ring first.
        targets: {
          orderBy: [{ priority: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
          include: {
            drafts: { orderBy: { createdAt: 'desc' }, include: DRAFT_VIEW },
            // Oldest first: this is a correspondence, and a thread that
            // reads newest-down is a thread nobody can follow.
            messages: {
              orderBy: { occurredAt: 'asc' },
              include: { recordedBy: { select: { id: true, name: true } } },
            },
          },
        },
        valuations: {
          orderBy: { asOf: 'desc' },
          include: { createdBy: { select: { id: true, name: true } } },
        },
        visits: {
          orderBy: { visitedAt: 'desc' },
          include: {
            visitor: { select: { id: true, name: true } },
            siteObservations: { orderBy: { id: 'asc' } },
          },
        },
      },
    });
    // Hiding a project from the list while a direct link still opens it
    // is not hiding it.
    if (project?.ownerOnly && !isSuperAdminEmail(req.user?.email)) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!project) return res.status(404).json({ error: 'Not found' });

    const claims = await prisma.researchClaim.findMany({
      where: { interview: { projectId: id, ...CITABLE } },
      orderBy: [{ topic: 'asc' }, { startMs: 'asc' }],
      include: {
        interview: {
          select: {
            id: true, title: true, conductedAt: true,
            source: { select: SOURCE_PUBLIC },
          },
        },
      },
    });

    // Observations live under visits; flatten them so coverage can see
    // both kinds of evidence against a question in one pass.
    const observations = project.visits.flatMap((v) =>
      v.siteObservations.map((o) => ({ ...o, visit: { location: v.location } }))
    );

    // Whether THIS reader may approve a given draft is a per-user fact,
    // so it is computed here rather than cached with the project.
    const targets = project.targets.map((t) => ({
      ...t,
      drafts: (t.drafts || []).map((d) => decorate(d, req.user)),
    }));

    // When each silent target is worth chasing, counted in working days
    // so a Friday send is not treated as three days old on Monday.
    const chase = assessOutreach(targets);
    const chaseById = new Map(chase.rows.map((r) => [r.targetId, r]));

    res.json({
      ...project,
      targets: targets.map((t) => ({ ...t, followUp: chaseById.get(t.id) || null })),
      followUps: chase,
      // Priced valuations first, then newest.
      //
      // These two were saved twenty-one seconds apart, and pure
      // recency put the comps record — whose case fields are
      // deliberately empty, because a multiple is not a price target —
      // on top of the DCF that actually carries bear/base/bull. Opening
      // the tab therefore answered "what do we think it is worth" with
      // three dashes. A record that states a number is the headline
      // whatever order they happened to be typed in.
      valuations: [...(project.valuations || [])].sort((a, b) => {
        const priced = (v) => (v.bear != null || v.base != null || v.bull != null) ? 1 : 0;
        return priced(b) - priced(a) || new Date(b.asOf) - new Date(a.asOf);
      }),
      claims: claims.map((c) => ({
        ...c,
        stamp: formatStamp(c.startMs),
        citation: formatCitation(c, { formatStamp }),
      })),
      topics: assessTopics(claims),
      coverage: assessCoverage(project.questions, claims, observations),
      funnel: funnel(project.targets),
      // What is sitting on someone's desk right now. The panel needs
      // this at the top level or "is anything waiting on me" costs a
      // walk through every target.
      outreachQueue: (() => {
        const all = targets.flatMap((t) => (t.drafts || []).map((d) => ({ ...d, target: t.name })));
        // An auto-reply is not being heard from. Nobody has read the
        // email, so it must not count toward "replied".
        const inbound = (t) => (t.messages || []).filter((m) => m.direction === 'in');
        const heard = (t) => inbound(t).filter((m) => m.kind !== 'AutoReply');
        return {
          awaitingReview: all.filter((d) => !d.sentAt && !d.rejectedAt && !d.fullyApproved).length,
          awaitingMe: all.filter((d) => d.canIApprove).length,
          readyToSend: all.filter((d) => d.fullyApproved && !d.sentAt).length,
          rejected: all.filter((d) => d.rejectedAt && !d.sentAt).length,
          sent: all.filter((d) => d.sentAt).length,
          // Compliance state has to be countable at the top level too,
          // or "is anything flagged" means opening fourteen people.
          screenBlocked: all.filter((d) => d.screenBlocked && !d.sentAt).length,
          screenElevated: all.filter((d) => d.screenState === 'elevated' && !d.sentAt).length,
          unscreened: all.filter((d) => d.screenState === 'unscreened' && !d.sentAt).length,
          keywordOnly: all.filter((d) => d.screenState === 'clear-keyword-only' && !d.sentAt).length,
          // Sent is not answered, and the gap between the two is the
          // only number that says whether the batch is working. An
          // out-of-office counts as heard-from but NOT as answered:
          // nobody has read the email yet, so it stays in the waiting
          // column where it can still be chased.
          replied: targets.filter((t) => heard(t).length).length,
          autoRepliedOnly: targets.filter(
            (t) => inbound(t).length && !heard(t).length).length,
          bounced: targets.filter((t) => inbound(t).some((r) => r.kind === 'Bounce')).length,
          interested: targets.filter((t) => inbound(t).some((r) => r.kind === 'Interested')).length,
          // Whose turn it is, which is what the word actually means now
          // that both directions are logged: the last thing in the thread
          // came from us. A target we chased twice with no answer is
          // still awaiting a reply, and one that answered and is sitting
          // on our desk is not.
          awaitingReply: targets.filter((t) => {
            if (!(t.drafts || []).some((d) => d.sentAt)) return false;
            const last = (t.messages || [])[(t.messages || []).length - 1];
            // An inbound AUTO-REPLY leaves the ball in their court. The
            // first cut tested direction alone and dropped Stoopes out of
            // the waiting column because a robot had answered him, which
            // is the precise mistake this whole distinction exists to
            // prevent.
            return !last || last.direction === 'out' || last.kind === 'AutoReply';
          }).length,
          // Their move and we have not answered. The opposite failure to
          // silence, and the more embarrassing one.
          owedAReply: targets.filter((t) => {
            const last = (t.messages || [])[(t.messages || []).length - 1];
            return !!last && last.direction === 'in' && last.kind !== 'AutoReply';
          }).length,
        };
      })(),
      transcriptionReady: transcriptionConfigured(),
    });
  } catch (err) {
    console.error('research/project failed:', err.message);
    res.status(500).json({ error: 'Could not load project' });
  }
});

router.post('/projects', canResearch, async (req, res) => {
  const { ticker, name, brief } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const ownerOnly = req.body?.ownerOnly === true || req.body?.ownerOnly === 'true';
  try {
    const project = await prisma.researchProject.create({
      data: {
        ticker: ticker ? String(ticker).toUpperCase().slice(0, 12) : null,
        name: String(name).slice(0, 300),
        brief: brief ? String(brief).slice(0, 5000) : null,
        ownerOnly,
        createdById: req.user?.id ?? null,
      },
    });
    res.status(201).json(project);
  } catch (err) {
    console.error('research/project create failed:', err.message);
    res.status(500).json({ error: 'Could not create project' });
  }
});

router.patch('/projects/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const data = {};
  if (req.body?.name) data.name = String(req.body.name).slice(0, 300);
  // Ticker was missing from this handler entirely, so a project created
  // without one could never be given one — it showed a dash in the list
  // forever and no amount of editing fixed it. Blank clears it, since a
  // project can legitimately cover something with no listed symbol.
  if (req.body?.ticker !== undefined) {
    const t = String(req.body.ticker || '').toUpperCase().trim().slice(0, 12);
    data.ticker = t || null;
  }
  if (req.body?.aims !== undefined) {
    // Three lines, and the cap is enforced here rather than trusted to
    // the client: the discipline IS the feature, and a fourth bullet
    // arriving from a stale build would quietly undo it.
    const lines = String(req.body.aims || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3);
    data.aims = lines.length ? lines.join('\n').slice(0, 900) : null;
  }
  if (req.body?.brief !== undefined) {
    data.brief = req.body.brief ? String(req.body.brief).slice(0, 5000) : null;
  }
  if (req.body?.status) {
    if (!PROJECT_STATUSES.has(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${[...PROJECT_STATUSES].join(', ')}` });
    }
    data.status = req.body.status;
  }
  try {
    res.json(await prisma.researchProject.update({ where: { id }, data }));
  } catch (err) {
    console.error('research/project update failed:', err.message);
    res.status(500).json({ error: 'Could not update project' });
  }
});

// Attach anything to a project — an uploaded file, or a guide typed
// straight in. Both shapes land in the same list, because a script
// someone wrote in the app is as much a project artifact as a PDF they
// dragged over, and forcing the file shape on the first just means
// people keep their scripts somewhere else.
router.post(
  '/projects/:id/artifacts',
  canResearch,
  upload.single('file'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
    const title = req.body?.title || req.file?.originalname;
    if (!title) return res.status(400).json({ error: 'title or a file is required' });
    if (!req.file && !req.body?.body && !req.body?.fileRef) {
      return res.status(400).json({ error: 'Attach a file, reference one, or write some text.' });
    }
    const kind = ARTIFACT_KINDS.has(req.body?.kind) ? req.body.kind : 'document';
    try {
      const project = await prisma.researchProject.findUnique({ where: { id } });
      if (!project) return res.status(404).json({ error: 'No such project' });

      let fileRef = null;
      // An item already in OneDrive: imported by reference rather than
      // re-uploaded, so a folder somebody built by hand becomes a project
      // without copying a byte or duplicating storage. Super-admin only,
      // because it will point an artifact at any item id on the drive.
      if (!req.file && req.body?.fileRef && isSuperAdminEmail(req.user?.email)) {
        fileRef = String(req.body.fileRef).slice(0, 300);
      }
      if (req.file) {
        const stored = await uploadFile({
          buffer: req.file.buffer,
          filename: req.file.originalname || 'artifact',
          contentType: req.file.mimetype || 'application/octet-stream',
        });
        if (!stored?.id) {
          return res.status(502).json({ error: 'File storage failed — nothing was attached.' });
        }
        fileRef = `onedrive:${stored.id}`;
      }

      const artifact = await prisma.researchArtifact.create({
        data: {
          projectId: id,
          kind,
          title: String(title).slice(0, 300),
          fileRef,
          filename: req.file?.originalname || (req.body?.filename ? String(req.body.filename).slice(0, 300) : null),
          ownerOnly: req.body?.ownerOnly === true || req.body?.ownerOnly === 'true',
          body: req.body?.body ? String(req.body.body).slice(0, 100_000) : null,
          note: req.body?.note ? String(req.body.note).slice(0, 1000) : null,
          uploadedById: req.user?.id ?? null,
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });
      // Touch the project so the list sorts by real activity.
      await prisma.researchProject.update({ where: { id }, data: { updatedAt: new Date() } });
      res.status(201).json(artifact);
    } catch (err) {
      if (err.code === 'NOT_AUTHORIZED') {
        return res.status(503).json({ error: 'File storage is not connected.' });
      }
      console.error('research/artifact failed:', err.message);
      res.status(500).json({ error: 'Could not attach artifact' });
    }
  }
);

router.patch('/artifacts/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const data = {};
  if (req.body?.ownerOnly !== undefined) {
    if (!isSuperAdminEmail(req.user?.email)) {
      return res.status(403).json({ error: 'Only the owner can hide or unhide an artifact.' });
    }
    data.ownerOnly = !!req.body.ownerOnly;
  }
  if (req.body?.title) data.title = String(req.body.title).slice(0, 300);
  if (req.body?.keyDoc !== undefined) data.keyDoc = !!req.body.keyDoc;
  if (req.body?.note !== undefined) {
    data.note = req.body.note ? String(req.body.note).slice(0, 1000) : null;
  }
  // Bodies are editable because most artifacts ARE typed here — guides,
  // memos, briefs. A transcription of somebody else's document is the
  // exception, and the discipline there is a human one: correct our own
  // headings freely, leave the source's words and the provenance line
  // alone. Nothing in a column can enforce that distinction.
  if (req.body?.body !== undefined) {
    data.body = req.body.body ? String(req.body.body).slice(0, 100_000) : null;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to change' });
  try {
    res.json(await prisma.researchArtifact.update({ where: { id }, data }));
  } catch (err) {
    console.error('research/artifact rename failed:', err.message);
    res.status(500).json({ error: 'Could not update artifact' });
  }
});

// Replace an artifact's bytes, keeping the row.
//
// Needed for two-way sync: editing a model in Finder has to update the
// artifact everyone else reads, and creating a NEW artifact on every save
// would turn one spreadsheet into forty rows named the same thing.
//
// The old OneDrive item is deliberately left in place rather than
// deleted. A file somebody edited is the last thing to destroy on the
// strength of an upload that might itself be a mistake, and orphaned
// items cost storage rather than work.
router.put(
  '/artifacts/:id/file',
  canResearch,
  upload.single('file'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const existing = await prisma.researchArtifact.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: 'No such artifact' });
      const stored = await uploadFile({
        buffer: req.file.buffer,
        filename: req.file.originalname || existing.filename || 'artifact',
        contentType: req.file.mimetype || 'application/octet-stream',
      });
      if (!stored?.id) {
        return res.status(502).json({ error: 'File storage failed — nothing was changed.' });
      }
      const row = await prisma.researchArtifact.update({
        where: { id },
        data: {
          fileRef: `onedrive:${stored.id}`,
          filename: req.file.originalname || existing.filename,
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });
      await prisma.researchProject.update({
        where: { id: existing.projectId },
        data: { updatedAt: new Date() },
      });
      res.json(row);
    } catch (err) {
      if (err.code === 'NOT_AUTHORIZED') {
        return res.status(503).json({ error: 'File storage is not connected.' });
      }
      console.error('research/artifact replace failed:', err.message);
      res.status(500).json({ error: 'Could not replace the file' });
    }
  }
);

router.delete('/artifacts/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    await prisma.researchArtifact.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('research/artifact delete failed:', err.message);
    res.status(500).json({ error: 'Could not remove artifact' });
  }
});

// ── Synthesis: the memo at the end ───────────────────────────────────
//
// Drafts a memo from the project's own evidence, with every factual
// sentence carrying the claim ids it rests on. Saved as an artifact so
// it lives beside the evidence it was written from, and re-runnable —
// a draft is a starting point for the author, never the finished
// product, and nothing here overwrites human prose.
router.post('/projects/:id/synthesize', canResearch, heavyLimiter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const project = await prisma.researchProject.findUnique({
      where: { id },
      include: {
        questions: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
        visits: { include: { siteObservations: true } },
      },
    });
    if (!project) return res.status(404).json({ error: 'Not found' });

    const claims = await prisma.researchClaim.findMany({
      where: { interview: { projectId: id, ...CITABLE } },
      include: {
        interview: {
          select: {
            conductedAt: true,
            source: { select: SOURCE_PUBLIC },
          },
        },
      },
    });
    const observations = project.visits.flatMap((v) =>
      v.siteObservations.map((o) => ({ ...o, visit: { location: v.location } }))
    );
    const coverage = assessCoverage(project.questions, claims, observations);

    const result = await synthesize({ ...project, claims }, coverage);
    if (result.unavailable) {
      return res.status(503).json({ error: result.reason });
    }

    // Persist as a memo artifact. Each run is a new row rather than an
    // overwrite: drafts get edited by hand, and silently replacing
    // someone's edited memo with a fresh generation would be the worst
    // possible behaviour here.
    const artifact = await prisma.researchArtifact.create({
      data: {
        projectId: id,
        kind: 'memo',
        title: `Draft memo — ${new Date().toISOString().slice(0, 10)}`,
        body: result.draft,
        note: `Drafted from ${result.evidenceCount} claims; cites ${result.citedCount}.` +
          (result.removedCitations
            ? ` ${result.removedCitations} invented citation(s) removed.`
            : ''),
        uploadedById: req.user?.id ?? null,
      },
    });

    res.json({
      artifactId: artifact.id,
      draft: result.draft,
      citedCount: result.citedCount,
      evidenceCount: result.evidenceCount,
      // Non-zero means the model reached for evidence it did not have.
      // Surfaced rather than swallowed: the author should know before
      // they trust a word of it.
      removedCitations: result.removedCitations,
    });
  } catch (err) {
    console.error('research/synthesize failed:', err.message);
    res.status(502).json({ error: 'Could not draft the memo' });
  }
});

// ── Questions: the spine ─────────────────────────────────────────────

router.post('/projects/:id/questions', canResearch, async (req, res) => {
  const projectId = Number(req.params.id);
  const { text, rationale, rank } = req.body || {};
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad id' });
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const q = await prisma.researchQuestion.create({
      data: {
        projectId,
        text: String(text).slice(0, 500),
        rationale: rationale ? String(rationale).slice(0, 2000) : null,
        rank: Number.isInteger(Number(rank)) ? Number(rank) : 0,
      },
    });
    res.status(201).json(q);
  } catch (err) {
    console.error('research/question create failed:', err.message);
    res.status(500).json({ error: 'Could not add question' });
  }
});

const QUESTION_STATUSES = new Set(['Open', 'Answered', 'Abandoned']);

router.patch('/questions/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const data = {};
  if (req.body?.text) data.text = String(req.body.text).slice(0, 500);
  if (req.body?.rationale !== undefined) {
    data.rationale = req.body.rationale ? String(req.body.rationale).slice(0, 2000) : null;
  }
  if (req.body?.rank !== undefined && Number.isInteger(Number(req.body.rank))) {
    data.rank = Number(req.body.rank);
  }
  if (req.body?.status) {
    if (!QUESTION_STATUSES.has(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${[...QUESTION_STATUSES].join(', ')}` });
    }
    // Closing a question is a person's judgement, never inferred from
    // how much evidence piled up behind it.
    data.status = req.body.status;
  }
  try {
    res.json(await prisma.researchQuestion.update({ where: { id }, data }));
  } catch (err) {
    console.error('research/question update failed:', err.message);
    res.status(500).json({ error: 'Could not update question' });
  }
});

router.delete('/questions/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    // Claims and observations survive: the FK is SetNull, so evidence
    // gathered against a deleted question becomes unlinked rather than
    // vanishing with it.
    await prisma.researchQuestion.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('research/question delete failed:', err.message);
    res.status(500).json({ error: 'Could not remove question' });
  }
});

// Link a claim to the question it bears on. This is the join that makes
// coverage mean anything, and it is a human judgement — the extractor
// knows what was said, not what we were trying to learn.
router.post('/claims/:id/link', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const questionId = req.body?.questionId === null ? null : Number(req.body?.questionId);
  try {
    const claim = await prisma.researchClaim.update({
      where: { id },
      data: { questionId: Number.isInteger(questionId) ? questionId : null },
    });
    res.json(claim);
  } catch (err) {
    console.error('research/claim link failed:', err.message);
    res.status(500).json({ error: 'Could not link claim' });
  }
});

// ── Targets: the outreach funnel ─────────────────────────────────────

const TARGET_STATUSES = new Set([
  'Identified', 'Contacted', 'Scheduled', 'Completed', 'Declined', 'Unreachable',
]);

// An email we cannot send to is worse than a blank — it looks like a
// working address until the bounce comes back, by which point the name
// has been sitting in "Contacted" for a week.
function cleanEmail(v) {
  if (v === undefined || v === null || v === '') return null;
  const e = String(v).trim().slice(0, 200);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

router.post('/projects/:id/targets', canResearch, async (req, res) => {
  const projectId = Number(req.params.id);
  const { name, relationship, employer, role, channel, notes, email, priority, tier } = req.body || {};
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad id' });
  if (!name || !relationship) {
    return res.status(400).json({ error: 'name and relationship are required' });
  }
  // Reject a malformed address rather than storing it. Silently nulling
  // it would leave the caller believing the list is reachable.
  if (email && !cleanEmail(email)) {
    return res.status(400).json({ error: `Not a valid email address: ${String(email).slice(0, 80)}` });
  }
  const pri = Number(priority);
  try {
    const t = await prisma.researchTarget.create({
      data: {
        projectId,
        name: String(name).slice(0, 200),
        relationship: String(relationship).slice(0, 60),
        employer: employer ? String(employer).slice(0, 200) : null,
        role: role ? String(role).slice(0, 200) : null,
        channel: channel ? String(channel).slice(0, 300) : null,
        email: cleanEmail(email),
        priority: Number.isInteger(pri) ? pri : null,
        tier: tier ? String(tier).slice(0, 40) : null,
        // Generous: a target's notes hold the whole correspondence —
        // why we picked them, the email sent, their reply, the outcome.
        // Truncating that to a couple of lines loses the only record of
        // what was actually said to a person.
        notes: notes ? String(notes).slice(0, 20_000) : null,
        createdById: req.user?.id ?? null,
      },
    });
    res.status(201).json(t);
  } catch (err) {
    console.error('research/target create failed:', err.message);
    res.status(500).json({ error: 'Could not add target' });
  }
});

router.patch('/targets/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const data = {};
  if (req.body?.status) {
    if (!TARGET_STATUSES.has(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${[...TARGET_STATUSES].join(', ')}` });
    }
    data.status = req.body.status;
    // Any movement off "Identified" is contact, so stamp it — "when did
    // we last try this person" is the question that paces follow-up.
    if (req.body.status !== 'Identified') data.lastContactAt = new Date();
  }
  if (req.body?.notes !== undefined) {
    data.notes = req.body.notes ? String(req.body.notes).slice(0, 20_000) : null;
  }
  if (req.body?.sourceId !== undefined) {
    const sid = Number(req.body.sourceId);
    data.sourceId = Number.isInteger(sid) ? sid : null;
  }
  // Identity fields are correctable. A target list is usually assembled
  // from prose — a spreadsheet column of "Name (Title, Company, notes)" —
  // and whatever parsed it the first time will have got some of them
  // wrong. Employer especially: it decides whether two voices corroborate
  // or merely cluster, so leaving a bad value in place quietly distorts
  // the evidence later.
  if (req.body?.name) data.name = String(req.body.name).slice(0, 200);
  if (req.body?.employer !== undefined) {
    data.employer = req.body.employer ? String(req.body.employer).slice(0, 200) : null;
  }
  if (req.body?.role !== undefined) {
    data.role = req.body.role ? String(req.body.role).slice(0, 200) : null;
  }
  if (req.body?.relationship) {
    data.relationship = String(req.body.relationship).slice(0, 60);
  }
  if (req.body?.channel !== undefined) {
    data.channel = req.body.channel ? String(req.body.channel).slice(0, 300) : null;
  }
  if (req.body?.email !== undefined) {
    if (req.body.email && !cleanEmail(req.body.email)) {
      return res.status(400).json({ error: `Not a valid email address: ${String(req.body.email).slice(0, 80)}` });
    }
    data.email = cleanEmail(req.body.email);
  }
  if (req.body?.priority !== undefined) {
    const p = Number(req.body.priority);
    data.priority = Number.isInteger(p) ? p : null;
  }
  if (req.body?.tier !== undefined) {
    data.tier = req.body.tier ? String(req.body.tier).slice(0, 40) : null;
  }
  try {
    res.json(await prisma.researchTarget.update({ where: { id }, data }));
  } catch (err) {
    console.error('research/target update failed:', err.message);
    res.status(500).json({ error: 'Could not update target' });
  }
});

router.delete('/targets/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    await prisma.researchTarget.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not remove target' });
  }
});

// ── Outreach drafts: two sign-offs before anything is sent ───────────
//
// The only irreversible thing this app does. A vote can be re-run and a
// claim can be struck, but an email lands in a stranger's inbox
// carrying the club's name and the school's, and there is no taking it
// back. So it takes two people.

const REQUIRED_APPROVALS = 2;

// Who may sign off. Deliberately narrower than who may write: any
// analyst can draft, but the sign-off is the club's word going out
// under the school's name and belongs with the people accountable for
// it.
function canApproveOutreach(user) {
  if (!user) return false;
  const roles = [user.role, ...(user.extraRoles || [])];
  return user.isSuperAdmin || roles.some((r) => r === 'President' || r === 'CIO' || r === 'FacultyAdvisor');
}

const DRAFT_VIEW = {
  approvals: {
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, name: true } } },
  },
  author: { select: { id: true, name: true } },
  rejectedBy: { select: { id: true, name: true } },
  sentBy: { select: { id: true, name: true } },
};

// Everything the UI needs to decide what to show THIS user, computed
// server-side. A client that works out for itself whether it may send
// is a client that can be talked into being wrong about it; the server
// re-checks every gate anyway, and this just keeps the two agreeing.
function decorate(d, user) {
  const approvals = d.approvals || [];
  const mine = approvals.some((a) => a.userId === user?.id);
  const blocked = d.screenRisk === 'prohibited';
  return {
    ...d,
    approvalCount: approvals.length,
    approvalsNeeded: REQUIRED_APPROVALS,
    fullyApproved: approvals.length >= REQUIRED_APPROVALS && !d.rejectedAt && !blocked,
    iApproved: mine,
    canIApprove: canApproveOutreach(user) && !mine && !d.sentAt && !d.rejectedAt && !blocked,
    screenBlocked: blocked,
    // A draft nobody has screened is NOT a clean draft, and a "low" the
    // model never saw is a weaker claim than a "low" it did. Both states
    // are named here so the UI cannot accidentally render either as an
    // all-clear.
    screenState: !d.screenedAt
      ? 'unscreened'
      : d.screenRisk === 'prohibited'
      ? 'prohibited'
      : d.screenRisk === 'elevated'
      ? 'elevated'
      : d.screenModelOk
      ? 'clear'
      : 'clear-keyword-only',
    // Where a draft has got to, in one word, computed once here so the
    // table and the detail view cannot disagree about it.
    stage: d.sentAt
      ? 'sent'
      : d.rejectedAt
      ? 'rejected'
      : blocked
      ? 'blocked'
      : approvals.length >= REQUIRED_APPROVALS
      ? 'ready'
      : approvals.length > 0
      ? 'one-approval'
      : 'awaiting',
    // Who we are still waiting on, by name, because "1 of 2" does not
    // tell anyone whose inbox to go and nudge.
    approvedByNames: approvals.map((a) => a.user?.name).filter(Boolean),
  };
}

// Screen a draft and persist the verdict. Never throws: a screen that
// takes the save down with it means the draft is lost, which is worse
// than a draft that is saved unscreened and says so.
async function screenAndStore(draftId) {
  try {
    const d = await prisma.outreachDraft.findUnique({
      where: { id: draftId },
      include: { target: true },
    });
    if (!d) return null;
    const r = await screenOutreach(
      { subject: d.subject, body: d.body },
      d.target || {}
    );
    return await prisma.outreachDraft.update({
      where: { id: draftId },
      data: {
        screenRisk: r.risk,
        screenReason: r.reason,
        screenFindings: { hits: r.hits, concerns: r.concerns, modelRisk: r.modelRisk },
        screenModelOk: r.modelAvailable,
        screenedAt: new Date(),
      },
    });
  } catch (err) {
    console.error('outreach screen failed:', err.message);
    return null;
  }
}

router.post('/targets/:id/drafts', canResearch, async (req, res) => {
  const targetId = Number(req.params.id);
  const { subject, body } = req.body || {};
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Bad id' });
  if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
  try {
    const target = await prisma.researchTarget.findUnique({ where: { id: targetId } });
    if (!target) return res.status(404).json({ error: 'No such target' });
    const created = await prisma.outreachDraft.create({
      data: {
        targetId,
        subject: String(subject).slice(0, 300),
        body: String(body).slice(0, 20_000),
        authorId: req.user?.id ?? null,
      },
    });
    // Screened before anyone can approve it, so the first person to
    // open it is reading the compliance verdict rather than being the
    // one who has to think of it.
    await screenAndStore(created.id);
    const d = await prisma.outreachDraft.findUnique({ where: { id: created.id }, include: DRAFT_VIEW });
    res.status(201).json(decorate(d, req.user));
  } catch (err) {
    console.error('research/draft create failed:', err.message);
    res.status(500).json({ error: 'Could not save draft' });
  }
});

// Editing voids every approval on the draft.
//
// This is the rule that makes the gate real. Without it the whole
// control is defeated by getting a bland draft signed off and then
// rewriting it — and the case to design against is not malice, it is
// someone fixing a typo after approval and never thinking about what
// that means. Approvals attach to WORDS, not to a row id.
//
// Only a genuine change voids them: saving identical text is not an
// edit, and nuking two sign-offs because someone opened the box and
// clicked save would train people to route around the feature.
router.patch('/drafts/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const existing = await prisma.outreachDraft.findUnique({
      where: { id },
      include: { approvals: true },
    });
    if (!existing) return res.status(404).json({ error: 'No such draft' });
    if (existing.sentAt) {
      return res.status(409).json({ error: 'That draft has already been sent — it is now a record of what we said, not a document. Write a new one.' });
    }

    // A minor edit keeps the approvals and leaves a permanent mark
    // saying so. Restricted to the people who could have approved it in
    // the first place: deciding a change did not need re-signing is the
    // same authority as signing. And it demands a note, because an
    // unexplained edit to an approved draft is the exact thing the gate
    // exists to prevent.
    const minor = req.body?.minorEdit === true;
    if (minor && !canApproveOutreach(req.user)) {
      return res.status(403).json({
        error: 'A minor edit keeps existing approvals, so it is limited to a President, the CIO or the faculty advisor.',
      });
    }
    if (minor && !req.body?.minorEditNote) {
      return res.status(400).json({
        error: 'Say what changed. An unexplained edit to an approved draft is the thing this route exists to avoid.',
      });
    }

    const subject = req.body?.subject !== undefined ? String(req.body.subject).slice(0, 300) : existing.subject;
    const body = req.body?.body !== undefined ? String(req.body.body).slice(0, 20_000) : existing.body;
    const changed = subject !== existing.subject || body !== existing.body;

    await prisma.$transaction(async (tx) => {
      if (changed && existing.approvals.length && !minor) {
        await tx.outreachApproval.deleteMany({ where: { draftId: id } });
      }
      return tx.outreachDraft.update({
        where: { id },
        data: {
          subject,
          body,
          // An edit is also the answer to a rejection, so it clears the
          // block — otherwise a rejected draft can never be revived.
          ...(changed && !minor ? { rejectedById: null, rejectedAt: null } : {}),
          ...(changed && minor
            ? {
                minorEditAt: new Date(),
                minorEditById: req.user?.id ?? null,
                minorEditNote: String(req.body.minorEditNote).slice(0, 300),
              }
            : {}),
          // The old verdict described text that no longer exists.
          // Blanking it first means a crash between here and the
          // re-screen leaves the draft visibly unscreened rather than
          // carrying a stale all-clear.
          ...(changed
            ? { screenRisk: null, screenReason: null, screenFindings: null, screenModelOk: false, screenedAt: null }
            : {}),
        },
      });
    });
    // Re-screened on every real edit INCLUDING a minor one. Approvals
    // are a judgement a person can decide to stand by; a compliance
    // verdict is about the text, and the text changed.
    if (changed) await screenAndStore(id);
    const d = await prisma.outreachDraft.findUnique({ where: { id }, include: DRAFT_VIEW });
    res.json({
      ...decorate(d, req.user),
      approvalsCleared: changed && !minor ? existing.approvals.length : 0,
      approvalsKept: changed && minor ? existing.approvals.length : 0,
    });
  } catch (err) {
    console.error('research/draft update failed:', err.message);
    res.status(500).json({ error: 'Could not update draft' });
  }
});

router.post('/drafts/:id/approve', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  if (!canApproveOutreach(req.user)) {
    return res.status(403).json({ error: 'Outreach is signed off by a President, the CIO or the faculty advisor.' });
  }
  try {
    const d = await prisma.outreachDraft.findUnique({ where: { id } });
    if (!d) return res.status(404).json({ error: 'No such draft' });
    if (d.sentAt) return res.status(409).json({ error: 'That draft has already been sent.' });
    if (d.rejectedAt) {
      return res.status(409).json({ error: 'That draft was rejected. Edit it to clear the rejection, which also clears any approvals.' });
    }
    // The unique constraint is the real guard; this just turns a
    // database error into a sentence.
    await prisma.outreachApproval.create({
      data: {
        draftId: id,
        userId: req.user.id,
        note: req.body?.note ? String(req.body.note).slice(0, 1000) : null,
      },
    }).catch((err) => {
      if (err.code === 'P2002') throw new Error('ALREADY_APPROVED');
      throw err;
    });
    const full = await prisma.outreachDraft.findUnique({ where: { id }, include: DRAFT_VIEW });
    res.json(decorate(full, req.user));
  } catch (err) {
    if (err.message === 'ALREADY_APPROVED') {
      return res.status(409).json({ error: 'You have already approved this draft. It needs a second person.' });
    }
    console.error('research/draft approve failed:', err.message);
    res.status(500).json({ error: 'Could not record the approval' });
  }
});

// Withdrawing is a first-class action, not an edge case. Someone who
// signs off and then thinks better of it must be able to say so
// without editing the text out from under the other approver.
router.delete('/drafts/:id/approve', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const d = await prisma.outreachDraft.findUnique({ where: { id } });
    if (!d) return res.status(404).json({ error: 'No such draft' });
    if (d.sentAt) return res.status(409).json({ error: 'That draft has already been sent.' });
    await prisma.outreachApproval.deleteMany({ where: { draftId: id, userId: req.user.id } });
    const full = await prisma.outreachDraft.findUnique({ where: { id }, include: DRAFT_VIEW });
    res.json(decorate(full, req.user));
  } catch (err) {
    console.error('research/draft unapprove failed:', err.message);
    res.status(500).json({ error: 'Could not withdraw the approval' });
  }
});

router.post('/drafts/:id/reject', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  if (!canApproveOutreach(req.user)) {
    return res.status(403).json({ error: 'Outreach is signed off by a President, the CIO or the faculty advisor.' });
  }
  if (!req.body?.note) {
    // A rejection without a reason cannot be acted on, and the author
    // is left guessing at what to change.
    return res.status(400).json({ error: 'Say what is wrong with it — a rejection with no note cannot be acted on.' });
  }
  try {
    const d = await prisma.outreachDraft.findUnique({ where: { id } });
    if (!d) return res.status(404).json({ error: 'No such draft' });
    if (d.sentAt) return res.status(409).json({ error: 'That draft has already been sent.' });
    const updated = await prisma.$transaction(async (tx) => {
      await tx.outreachApproval.deleteMany({ where: { draftId: id } });
      return tx.outreachDraft.update({
        where: { id },
        data: {
          rejectedById: req.user.id,
          rejectedAt: new Date(),
          reviewNote: String(req.body.note).slice(0, 1000),
        },
        include: DRAFT_VIEW,
      });
    });
    res.json(decorate(updated, req.user));
  } catch (err) {
    console.error('research/draft reject failed:', err.message);
    res.status(500).json({ error: 'Could not record the rejection' });
  }
});

// The gate. Marking a draft sent is what moves the funnel, so this is
// where two-approvals is enforced — and it is enforced by counting rows
// at the moment of the call, never by trusting a flag the client sent.
router.post('/drafts/:id/sent', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const d = await prisma.outreachDraft.findUnique({
      where: { id },
      include: { approvals: true, target: true },
    });
    if (!d) return res.status(404).json({ error: 'No such draft' });
    if (d.sentAt) return res.status(409).json({ error: 'Already marked sent.' });
    if (d.rejectedAt) return res.status(409).json({ error: 'That draft was rejected — edit it and get it approved again.' });
    // The compliance screen is a gate, not a note. Re-checked here at
    // the moment of sending rather than trusted from whatever the
    // client last saw.
    if (d.screenRisk === 'prohibited') {
      return res.status(409).json({
        error: `The compliance screen will not pass this: ${d.screenReason || 'no reason recorded'}. Edit it, which re-screens.`,
      });
    }

    const have = new Set(d.approvals.map((a) => a.userId)).size;
    if (have < REQUIRED_APPROVALS) {
      return res.status(409).json({
        error: `This needs ${REQUIRED_APPROVALS} approvals and has ${have}. Two different people have to sign off before it goes out.`,
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const draft = await tx.outreachDraft.update({
        where: { id },
        data: { sentAt: new Date(), sentById: req.user?.id ?? null },
        include: DRAFT_VIEW,
      });
      // The whole point of marking it sent is that the funnel moves.
      // Leaving the target on "Identified" after an email went out is
      // how someone gets written to twice.
      if (draft.targetId) {
        await tx.researchTarget.update({
          where: { id: draft.targetId },
          data: { status: 'Contacted', lastContactAt: new Date() },
        });
      }
      return draft;
    });
    res.json(decorate(updated, req.user));
  } catch (err) {
    console.error('research/draft sent failed:', err.message);
    res.status(500).json({ error: 'Could not mark it sent' });
  }
});

// What came back, and what it means for the funnel.
//
// The kinds are deliberately few and each one implies a different next
// move: an out-of-office is not a no and must not stop the follow-up, a
// bounce is a dead address and stops it permanently, a decline is an
// answer and closes the target, and interest is the only one that leads
// anywhere. Anything genuinely ambiguous is Other, on purpose, so the
// four that carry consequences stay trustworthy.
const REPLY_KINDS = ['AutoReply', 'Bounce', 'Declined', 'Interested', 'Other'];
// What we sent. Separate list because none of these say anything about
// the target's intent and none of them may move the funnel: chasing
// somebody four times is not progress, and a status that improved every
// time we sent another email would be measuring our own activity.
const SENT_KINDS = ['Outreach', 'FollowUp', 'Reply', 'Scheduling', 'Other'];

// Only where the reply leaves no room for interpretation. A bounce means
// the address is dead and a decline is a person saying no, so leaving
// either on Contacted would keep a target in the follow-up queue that
// nobody should follow up.
//
// Interested moves to Scheduled too. This first read the other way, on
// the argument that Scheduled should mean a call in the diary rather
// than a warm sentence, and Thomas overruled it after logging the first
// yes and having to move the row by hand. The better argument is his:
// somebody who has agreed to talk does not belong in the same bucket as
// the twelve who have not answered, and the distinction between agreed
// and booked is carried by the reply itself, which is sitting right
// there under the email.
//
// AutoReply is the one kind that still moves nothing. An out-of-office
// is not an answer, and a target whose only reply is a robot must stay
// where it can be chased.
const STATUS_FOR_KIND = { Bounce: 'Unreachable', Declined: 'Declined', Interested: 'Scheduled' };

// Both paths hit the same handler. /replies stays because a client built
// before the log went two-way is still a client, and an outbound-capable
// server that 404s the old route would break it for no gain.
router.post(['/targets/:id/messages', '/targets/:id/replies'], canResearch, async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Bad id' });
  const { kind, body, action, draftId } = req.body || {};
  const direction = req.body?.direction === 'out' ? 'out' : 'in';
  const receivedAt = req.body?.occurredAt ?? req.body?.receivedAt;
  const allowed = direction === 'out' ? SENT_KINDS : REPLY_KINDS;
  if (!allowed.includes(kind)) {
    return res.status(400).json({ error: `kind for a ${direction === 'out' ? 'sent' : 'received'} message must be one of ${allowed.join(', ')}` });
  }
  // Received-when is required rather than defaulted to now(). Logging a
  // reply days later is normal, and a silently back-filled timestamp
  // would put a false number under every "days to respond" we compute.
  const when = receivedAt ? new Date(receivedAt) : null;
  if (!when || Number.isNaN(when.getTime())) {
    return res.status(400).json({ error: 'occurredAt must be a date — when the message happened, not when you logged it' });
  }
  try {
    const target = await prisma.researchTarget.findUnique({ where: { id: targetId } });
    if (!target) return res.status(404).json({ error: 'No such target' });
    if (draftId != null) {
      const d = await prisma.outreachDraft.findUnique({ where: { id: Number(draftId) } });
      if (!d || d.targetId !== targetId) {
        return res.status(400).json({ error: 'That draft does not belong to this target' });
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const reply = await tx.outreachMessage.create({
        data: {
          targetId,
          draftId: draftId != null ? Number(draftId) : null,
          direction,
          kind,
          occurredAt: when,
          body: body ? String(body).slice(0, 20_000) : null,
          action: action ? String(action).slice(0, 2_000) : null,
          recordedById: req.user?.id ?? null,
        },
        include: { recordedBy: { select: { id: true, name: true } } },
      });
      // Only what THEY said may move the funnel.
      const next = direction === 'in' ? STATUS_FOR_KIND[kind] : null;
      // Never walk a target BACKWARDS out of a state a person set by
      // hand. Someone who already booked the call and then logs a late
      // bounce on an old address should keep the call.
      if (next && !['Scheduled', 'Completed'].includes(target.status)) {
        await tx.researchTarget.update({ where: { id: targetId }, data: { status: next } });
      }
      return reply;
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('research/reply create failed:', err.message);
    res.status(500).json({ error: 'Could not log the reply' });
  }
});

router.delete(['/messages/:id', '/replies/:id'], canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    await prisma.outreachMessage.delete({ where: { id } });
    // Status is deliberately NOT reverted. It may have been changed by
    // hand since, and guessing what it used to be is worse than leaving
    // a value a person can see and correct.
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'No such reply' });
  }
});

// Re-run the screen without touching the text.
//
// Needed because the local model is sometimes down, and a draft
// screened by the keyword floor alone carries a weaker verdict than one
// the model actually read. Without this the only way to get a proper
// screen is to edit the draft, which would cost the approvals.
router.post('/drafts/:id/screen', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const updated = await screenAndStore(id);
    if (!updated) return res.status(502).json({ error: 'The screen could not run. The draft is unchanged and still shows its previous state.' });
    const d = await prisma.outreachDraft.findUnique({ where: { id }, include: DRAFT_VIEW });
    res.json(decorate(d, req.user));
  } catch (err) {
    console.error('research/draft screen failed:', err.message);
    res.status(500).json({ error: 'Could not screen that draft' });
  }
});

router.delete('/drafts/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const d = await prisma.outreachDraft.findUnique({ where: { id } });
    if (!d) return res.status(404).json({ error: 'No such draft' });
    if (d.sentAt) {
      return res.status(409).json({ error: 'A sent draft is the record of what we said to someone. It stays.' });
    }
    await prisma.outreachDraft.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('research/draft delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete draft' });
  }
});

// ── Site visits: going and looking ───────────────────────────────────

router.post('/projects/:id/visits', canResearch, async (req, res) => {
  const projectId = Number(req.params.id);
  const { location, banner, visitedAt, dayPart, weather, notes, observations } = req.body || {};
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad id' });
  if (!location) return res.status(400).json({ error: 'location is required' });
  try {
    const project = await prisma.researchProject.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'No such project' });
    const visit = await prisma.siteVisit.create({
      data: {
        projectId,
        ticker: project.ticker,
        location: String(location).slice(0, 300),
        banner: banner ? String(banner).slice(0, 200) : null,
        visitedAt: visitedAt ? new Date(visitedAt) : new Date(),
        visitorId: req.user?.id ?? null,
        // Day-part matters enormously for a retail traffic read: a
        // Tuesday 11am count says nothing about a Saturday.
        dayPart: dayPart ? String(dayPart).slice(0, 40) : null,
        weather: weather ? String(weather).slice(0, 120) : null,
        notes: notes ? String(notes).slice(0, 10_000) : null,
        observations: observations && typeof observations === 'object' ? observations : undefined,
      },
      include: { visitor: { select: { id: true, name: true } }, siteObservations: true },
    });
    res.status(201).json(visit);
  } catch (err) {
    console.error('research/visit create failed:', err.message);
    res.status(500).json({ error: 'Could not log visit' });
  }
});

const OBSERVATION_KINDS = new Set([
  'measurement', 'condition', 'pricing', 'traffic', 'assortment', 'other',
]);

router.post('/visits/:id/observations', canResearch, async (req, res) => {
  const visitId = Number(req.params.id);
  const { text, topic, kind, questionId } = req.body || {};
  if (!Number.isInteger(visitId)) return res.status(400).json({ error: 'Bad id' });
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const o = await prisma.siteObservation.create({
      data: {
        visitId,
        text: String(text).slice(0, 2000),
        topic: topic ? String(topic).toLowerCase().slice(0, 60) : null,
        kind: OBSERVATION_KINDS.has(kind) ? kind : 'condition',
        questionId: Number.isInteger(Number(questionId)) ? Number(questionId) : null,
      },
    });
    res.status(201).json(o);
  } catch (err) {
    console.error('research/observation failed:', err.message);
    res.status(500).json({ error: 'Could not add observation' });
  }
});

router.delete('/visits/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    await prisma.siteVisit.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not remove visit' });
  }
});

// ── Sources ──────────────────────────────────────────────────────────

router.get('/sources', async (req, res) => {
  try {
    const ticker = req.query.ticker
      ? String(req.query.ticker).toUpperCase()
      : null;
    const sources = await prisma.researchSource.findMany({
      where: ticker ? { tickers: { has: ticker } } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { interviews: true } } },
    });
    res.json(sources);
  } catch (err) {
    console.error('research/sources failed:', err.message);
    res.status(500).json({ error: 'Could not load sources' });
  }
});

const RELATIONSHIPS = new Set([
  'FormerEmployee', 'CurrentEmployee', 'Customer', 'Distributor',
  'Supplier', 'Competitor', 'IndustryExpert', 'Other',
]);

router.post('/sources', canResearch, async (req, res) => {
  const { alias, fullName, role, employer, relationship, tickers, notes } = req.body || {};
  if (!alias || !relationship) {
    return res.status(400).json({ error: 'alias and relationship are required' });
  }
  if (!RELATIONSHIPS.has(relationship)) {
    return res.status(400).json({ error: `relationship must be one of: ${[...RELATIONSHIPS].join(', ')}` });
  }
  try {
    const source = await prisma.researchSource.create({
      data: {
        alias: String(alias).slice(0, 200),
        fullName: fullName ? String(fullName).slice(0, 200) : null,
        role: role ? String(role).slice(0, 200) : null,
        employer: employer ? String(employer).slice(0, 200) : null,
        relationship,
        tickers: Array.isArray(tickers)
          ? tickers.map((t) => String(t).toUpperCase().slice(0, 12)).slice(0, 20)
          : [],
        notes: notes ? String(notes).slice(0, 5000) : null,
        createdById: req.user?.id ?? null,
      },
    });
    res.status(201).json(source);
  } catch (err) {
    console.error('research/sources create failed:', err.message);
    res.status(500).json({ error: 'Could not create source' });
  }
});

// ── Interviews ───────────────────────────────────────────────────────

router.get('/interviews', async (req, res) => {
  try {
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
    const projectId = Number(req.query.projectId);
    const interviews = await prisma.interview.findMany({
      where: {
        ...(ticker ? { ticker } : {}),
        ...(Number.isInteger(projectId) ? { projectId } : {}),
      },
      orderBy: { conductedAt: 'desc' },
      include: {
        source: { select: SOURCE_PUBLIC },
        interviewer: { select: { id: true, name: true } },
        _count: { select: { claims: true } },
      },
    });
    // The transcript itself is deliberately not in the list payload —
    // it is large, and a list view never needs it.
    res.json(interviews);
  } catch (err) {
    console.error('research/interviews failed:', err.message);
    res.status(500).json({ error: 'Could not load interviews' });
  }
});

router.get('/interviews/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const interview = await prisma.interview.findUnique({
      where: { id },
      include: {
        source: { select: SOURCE_PUBLIC },
        interviewer: { select: { id: true, name: true } },
        claims: { orderBy: { startMs: 'asc' } },
      },
    });
    if (!interview) return res.status(404).json({ error: 'Not found' });
    res.json(interview);
  } catch (err) {
    console.error('research/interview failed:', err.message);
    res.status(500).json({ error: 'Could not load interview' });
  }
});

router.post('/interviews', canResearch, async (req, res) => {
  const { sourceId, ticker, title, conductedAt, consentObtained, consentNote, mnpiRisk, projectId, attested } = req.body || {};
  if (!sourceId || !title) {
    return res.status(400).json({ error: 'sourceId and title are required' });
  }
  try {
    const source = await prisma.researchSource.findUnique({ where: { id: Number(sourceId) } });
    if (!source) return res.status(400).json({ error: 'No such source' });

    // A current employee is the high-risk case by default. The creator
    // can raise this but the floor is set here rather than trusted to
    // whoever is filling in the form at the time.
    const risk =
      mnpiRisk && ['low', 'elevated', 'prohibited'].includes(mnpiRisk)
        ? mnpiRisk
        : source.relationship === 'CurrentEmployee'
        ? 'elevated'
        : 'low';

    const interview = await prisma.interview.create({
      data: {
        sourceId: source.id,
        ticker: ticker ? String(ticker).toUpperCase().slice(0, 12) : null,
        title: String(title).slice(0, 300),
        conductedAt: conductedAt ? new Date(conductedAt) : new Date(),
        interviewerId: req.user?.id ?? null,
        consentObtained: !!consentObtained,
        consentNote: consentNote ? String(consentNote).slice(0, 1000) : null,
        mnpiRisk: risk,
        // A risk level with no stated reason is unreviewable — the panel
        // can show ELEVATED and then has nothing to justify it, so the
        // reviewer is asked to clear or quarantine on the strength of a
        // coloured word. Record why it was raised at the moment it is
        // raised; the transcript screen overwrites this with its own
        // finding when one runs.
        screenResult:
          risk === 'low'
            ? undefined
            : {
                risk,
                reason:
                  mnpiRisk && ['low', 'elevated', 'prohibited'].includes(mnpiRisk)
                    ? 'Risk was set by hand when the interview was created.'
                    : 'The source is a current employee of the company under research, so this starts elevated regardless of what was said.',
                hits: [],
                modelAvailable: null,
              },
        quarantined: risk === 'prohibited',
        projectId: Number.isInteger(Number(projectId)) ? Number(projectId) : null,
        // Recorded against the person who opened the interview. The
        // screen catches MNPI after the call; this is the commitment
        // made before it, which is where compliance actually bites.
        attestedAt: attested ? new Date() : null,
        attestedById: attested ? req.user?.id ?? null : null,
      },
      include: { source: { select: SOURCE_PUBLIC } },
    });
    res.status(201).json(interview);
  } catch (err) {
    console.error('research/interview create failed:', err.message);
    res.status(500).json({ error: 'Could not create interview' });
  }
});

// Upload a recording and transcribe it in one step.
//
// Consent is checked BEFORE the audio is stored, not after. Recording
// someone without their agreement is unlawful in two-party-consent
// states and fatal to a source relationship; refusing at the door is the
// only version of that check worth having.
router.post(
  '/interviews/:id/recording',
  canResearch,
  heavyLimiter,
  upload.single('file'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const interview = await prisma.interview.findUnique({ where: { id } });
      if (!interview) return res.status(404).json({ error: 'Not found' });
      if (!interview.consentObtained) {
        return res.status(409).json({
          error:
            'Consent is not recorded for this interview. Record consent before uploading audio.',
        });
      }
      if (!transcriptionConfigured()) {
        return res.status(503).json({
          error: 'Transcription is not configured — set ELEVENLABS_API_KEY.',
        });
      }

      // Store the audio alongside every other member upload so the
      // recording outlives anyone's laptop.
      let recordingRef = interview.recordingRef;
      try {
        const stored = await uploadFile({
          buffer: req.file.buffer,
          filename: req.file.originalname || `interview-${id}.m4a`,
          contentType: req.file.mimetype || 'audio/mpeg',
        });
        if (stored?.id) recordingRef = `onedrive:${stored.id}`;
      } catch (err) {
        // Storage failing should not cost us the transcription — the
        // transcript is the evidence, the audio is the backup.
        console.error(`research: recording upload failed for ${id}:`, err.message);
      }

      const result = await transcribe(req.file.buffer, {
        filename: req.file.originalname,
        numSpeakers: Number(req.body?.numSpeakers) || 2,
      });

      // Screen every transcript the moment it exists, before anyone
      // reads it or extracts from it. Doing this at ingest rather than
      // on request means an interview cannot sit unscreened in the
      // archive, and the result is stored on the row as the audit trail.
      const source = await prisma.researchSource.findUnique({
        where: { id: interview.sourceId },
        select: { relationship: true },
      });
      const screen = await screenTranscript(result.transcript, {
        relationship: source?.relationship,
      });

      const updated = await prisma.interview.update({
        where: { id },
        data: {
          recordingRef,
          transcript: result.transcript,
          transcriptWords: result.words,
          transcriptModel: result.model,
          durationMs: result.durationMs,
          status: screen.risk === RISK.PROHIBITED ? 'Quarantined' : 'Transcribed',
          mnpiRisk: screen.risk,
          screenedAt: new Date(),
          screenedById: req.user?.id ?? null,
          // Prohibited quarantines immediately: material non-public
          // information must not reach the ledger while someone gets
          // round to reviewing it. A person can release it afterwards —
          // the safe default is the reversible one.
          quarantined: screen.risk === RISK.PROHIBITED,
          quarantineNote:
            screen.risk === RISK.PROHIBITED
              ? `Auto-quarantined by MNPI screen: ${screen.reason}`
              : null,
          screenResult: {
            risk: screen.risk,
            reason: screen.reason,
            hits: screen.hits,
            modelAvailable: screen.modelAvailable,
          },
        },
        select: { id: true, status: true, durationMs: true, transcriptModel: true, mnpiRisk: true, quarantined: true },
      });

      res.json({
        ...updated,
        wordCount: result.words.length,
        speakerCount: result.speakerCount,
        screen: {
          risk: screen.risk,
          reason: screen.reason,
          hits: screen.hits,
          // A "low" that only the crude pass produced is not the same
          // as a clean bill of health, and the UI should not present it
          // as one.
          modelAvailable: screen.modelAvailable,
        },
        // One separated voice on a two-party call means diarization
        // failed, and every attribution from it would be a guess. The
        // caller is told rather than left to discover it in a footnote.
        diarizationWarning:
          result.speakerCount < 2
            ? 'Only one speaker was separated — attributions from this transcript are unreliable.'
            : null,
      });
    } catch (err) {
      if (err.code === 'NOT_CONFIGURED') {
        return res.status(503).json({ error: err.message });
      }
      if (err.code === 'EMPTY_TRANSCRIPT') {
        return res.status(422).json({ error: err.message });
      }
      console.error('research/recording failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  }
);

// Import a transcript we already have, instead of paying to re-run one.
//
// Accepts the "[MM:SS] speaker_N: text" form that scribe_v2 output is
// already saved in. The timestamps are per TURN rather than per word, so
// a claim from an imported transcript resolves to the turn containing it
// — genuinely less precise than live transcription, and recorded as such
// on the row rather than quietly presented as equivalent.
//
// Consent is still required. A transcript that exists is not evidence
// the person agreed to be recorded, and importing must not become the
// way round that check.
router.post('/interviews/:id/transcript', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const text = req.body?.text;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  try {
    const interview = await prisma.interview.findUnique({ where: { id } });
    if (!interview) return res.status(404).json({ error: 'Not found' });
    if (!interview.consentObtained) {
      return res.status(409).json({
        error: 'Consent is not recorded for this interview. Record consent before importing a transcript.',
      });
    }

    let parsed;
    try {
      parsed = parseTranscriptText(text);
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }

    // Imported transcripts get screened exactly like transcribed ones.
    // Where the words came from changes nothing about whether they
    // contain material non-public information.
    const source = await prisma.researchSource.findUnique({
      where: { id: interview.sourceId },
      select: { relationship: true },
    });
    const screen = await screenTranscript(parsed.transcript, {
      relationship: source?.relationship,
    });

    const updated = await prisma.interview.update({
      where: { id },
      data: {
        transcript: parsed.transcript,
        transcriptWords: parsed.words,
        transcriptModel: `imported (${parsed.precision}-level timing)`,
        durationMs: parsed.durationMs,
        status: screen.risk === RISK.PROHIBITED ? 'Quarantined' : 'Transcribed',
        mnpiRisk: screen.risk,
        screenedAt: new Date(),
        screenedById: req.user?.id ?? null,
        quarantined: screen.risk === RISK.PROHIBITED,
        quarantineNote:
          screen.risk === RISK.PROHIBITED
            ? `Auto-quarantined by MNPI screen: ${screen.reason}`
            : null,
        screenResult: {
          risk: screen.risk,
          reason: screen.reason,
          hits: screen.hits,
          modelAvailable: screen.modelAvailable,
        },
      },
      select: { id: true, status: true, durationMs: true, transcriptModel: true, mnpiRisk: true, quarantined: true },
    });

    res.json({
      ...updated,
      turnCount: parsed.turns.length,
      wordCount: parsed.words.length,
      speakerCount: parsed.speakerCount,
      precision: parsed.precision,
      screen: {
        risk: screen.risk,
        reason: screen.reason,
        hits: screen.hits,
        modelAvailable: screen.modelAvailable,
      },
    });
  } catch (err) {
    console.error('research/transcript import failed:', err.message);
    res.status(500).json({ error: 'Could not import the transcript' });
  }
});

// Extract claims from a transcribed interview.
//
// Re-running replaces the machine-extracted claims but preserves any a
// human has verified — a verification is a person's judgement and must
// not be silently discarded by a re-run.
router.post('/interviews/:id/extract', canResearch, heavyLimiter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const interview = await prisma.interview.findUnique({ where: { id } });
    if (!interview) return res.status(404).json({ error: 'Not found' });
    if (!interview.transcriptWords) {
      return res.status(409).json({ error: 'Transcribe the interview first.' });
    }
    if (interview.quarantined) {
      return res.status(409).json({
        error: 'This interview is quarantined — its claims cannot be extracted or cited.',
      });
    }

    const words = interview.transcriptWords;
    const { claims, dropped, unsupported, unavailable, failedWindows, windows } = await extractClaims({
      words,
      turns: rebuildTurns(words),
    });
    if (unavailable) {
      return res.status(503).json({ error: 'The research model is unavailable right now.' });
    }

    // Re-extraction replaces machine-extracted claims, which silently
    // destroyed every claim-to-question link a person had made — a
    // re-run after a prompt change wiped the entire coverage picture and
    // nothing said so. Carry the links across by where the claim sits in
    // the recording, which is stable across re-extractions in a way that
    // wording is not.
    const priorLinks = new Map();
    for (const c of await prisma.researchClaim.findMany({
      where: { interviewId: id, questionId: { not: null }, origin: 'extract' },
      select: { startMs: true, questionId: true },
    })) {
      priorLinks.set(c.startMs, c.questionId);
    }

    const written = await prisma.$transaction(async (tx) => {
      // Only the extractor's own rows. Claims found by reading the
      // transcript against a specific question are a different reading of
      // the same tape and are not this run's to throw away.
      await tx.researchClaim.deleteMany({
        where: { interviewId: id, verifiedById: null, origin: 'extract' },
      });
      if (claims.length === 0) return 0;
      const created = await tx.researchClaim.createMany({
        data: claims.map((c) => ({
          interviewId: id,
          ticker: interview.ticker,
          text: c.text,
          quote: c.quote,
          speaker: c.speaker,
          startMs: c.startMs,
          endMs: c.endMs,
          topic: c.topic,
          kind: c.kind,
          extractionConfidence: c.extractionConfidence,
          origin: 'extract',
          // Restored if a claim at this offset was linked before.
          questionId: priorLinks.get(c.startMs) ?? null,
        })),
      });
      await tx.interview.update({ where: { id }, data: { status: 'Extracted' } });
      return created.count;
    });

    res.json({
      extracted: written,
      relinked: claims.filter((c) => priorLinks.has(c.startMs)).length,
      // A transcript read in six windows of which two failed has not
      // been fully read, and the caller must be able to tell.
      windows,
      failedWindows,
      // Surfaced deliberately: a spike here means the model started
      // paraphrasing instead of quoting, and that run's output should
      // be treated as suspect.
      droppedUnlocatable: dropped,
      // Located verbatim, but the claim written above the quote said
      // more than the quote does. A different failure from the one
      // above and a worse one, because the citation checks out.
      droppedUnsupported: unsupported,
    });
  } catch (err) {
    console.error('research/extract failed:', err.message);
    res.status(502).json({ error: 'Claim extraction failed' });
  }
});

// ── Valuation ────────────────────────────────────────────────────────
//
// What the work concluded a share is worth. The spreadsheet can sit in
// artifacts; this is the part someone can argue with without opening it.

const VALUATION_KINDS = new Set(['dcf', 'merger', 'comps', 'other']);

// Watcher addresses. Deduped and lower-cased so the same person added
// twice with different capitalisation is not emailed twice, and anything
// without an @ is dropped rather than stored to fail later inside the
// mailer, where nobody would see it.
const emails = (v) =>
  Array.isArray(v)
    ? [...new Set(
        v.map((e) => String(e || '').trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
      )].slice(0, 20)
    : [];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Assumptions are the reason this lives next to the claim ledger. An
// assumption that cites a claim is a number somebody said on a recording
// at a timestamp; one that cites nothing is a number we picked. Both are
// legitimate — a discount rate is nobody's quote — but they must not look
// alike, so a claimId is verified to exist in THIS project and dropped
// if it does not. A citation that silently points nowhere is worse than
// no citation, because it reads as sourced.
async function cleanAssumptions(raw, projectId) {
  if (!Array.isArray(raw)) return { assumptions: [], droppedCitations: 0 };
  const wanted = new Set(
    raw.map((a) => (a?.claimId != null && a.claimId !== '' ? Number(a.claimId) : NaN))
       .filter(Number.isInteger)
  );
  let valid = new Set();
  if (wanted.size) {
    const found = await prisma.researchClaim.findMany({
      where: { id: { in: [...wanted] }, interview: { projectId, ...CITABLE } },
      select: { id: true },
    });
    valid = new Set(found.map((c) => c.id));
  }
  let droppedCitations = 0;
  const assumptions = raw.slice(0, 60).map((a) => {
    // Number(null) is 0, which passes Number.isInteger — so an
    // uncited assumption used to be counted as a DROPPED citation.
    // Twelve honest rows reported twelve dropped citations, and a
    // warning that fires on every clean save is a warning people learn
    // to ignore, which costs more than the miss it was meant to catch.
    const cited = a?.claimId != null && a.claimId !== '';
    const claimId = cited ? Number(a.claimId) : NaN;
    const keep = Number.isInteger(claimId) && valid.has(claimId);
    if (cited && !keep) droppedCitations += 1;
    return {
      label: String(a?.label || '').slice(0, 120),
      value: String(a?.value ?? '').slice(0, 80),
      unit: a?.unit ? String(a.unit).slice(0, 24) : null,
      note: a?.note ? String(a.note).slice(0, 300) : null,
      claimId: keep ? claimId : null,
    };
  }).filter((a) => a.label);
  return { assumptions, droppedCitations };
}

router.post('/projects/:id/valuations', canResearch, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad id' });
  const { kind, name, bear, base, bull, priceAtWrite, note, assumptions, currency, buyBelow, reviewBy } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const project = await prisma.researchProject.findUnique({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Not found' });
    const clean = await cleanAssumptions(assumptions, projectId);
    const row = await prisma.researchValuation.create({
      data: {
        projectId,
        ticker: project.ticker,
        kind: VALUATION_KINDS.has(kind) ? kind : 'dcf',
        name: String(name).slice(0, 200),
        bear: num(bear),
        base: num(base),
        bull: num(bull),
        priceAtWrite: num(priceAtWrite),
        // Three letters, upper-cased. A free-text currency is a currency
        // that eventually reads "swiss francs" in one row and "CHF" in
        // the next and cannot be compared.
        currency: /^[A-Za-z]{3}$/.test(String(currency || ''))
          ? String(currency).toUpperCase()
          : 'USD',
        buyBelow: num(buyBelow),
        reviewBy: reviewBy ? new Date(reviewBy) : null,
        watchers: emails(req.body?.watchers),
        note: note ? String(note).slice(0, 4000) : null,
        assumptions: clean.assumptions,
        createdById: req.user?.id ?? null,
      },
    });
    res.status(201).json({ ...row, droppedCitations: clean.droppedCitations });
  } catch (err) {
    console.error('research/valuation create failed:', err.message);
    res.status(500).json({ error: 'Could not save the valuation' });
  }
});

router.patch('/valuations/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const existing = await prisma.researchValuation.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const data = {};
    if (b.name !== undefined) data.name = String(b.name).slice(0, 200);
    if (b.kind !== undefined && VALUATION_KINDS.has(b.kind)) data.kind = b.kind;
    for (const k of ['bear', 'base', 'bull', 'priceAtWrite', 'buyBelow']) {
      if (b[k] !== undefined) data[k] = num(b[k]);
    }
    // Moving the level re-arms it. Otherwise raising a watch you have
    // already been alerted on stays silent at the new number, which is
    // the opposite of what changing it means.
    if (b.buyBelow !== undefined) data.alertedAt = null;
    if (b.reviewBy !== undefined) data.reviewBy = b.reviewBy ? new Date(b.reviewBy) : null;
    if (b.watchers !== undefined) data.watchers = emails(b.watchers);
    if (b.note !== undefined) data.note = b.note ? String(b.note).slice(0, 4000) : null;
    if (b.currency !== undefined && /^[A-Za-z]{3}$/.test(String(b.currency))) {
      data.currency = String(b.currency).toUpperCase();
    }
    let droppedCitations = 0;
    if (b.assumptions !== undefined) {
      const clean = await cleanAssumptions(b.assumptions, existing.projectId);
      data.assumptions = clean.assumptions;
      droppedCitations = clean.droppedCitations;
    }
    const row = await prisma.researchValuation.update({ where: { id }, data });
    res.json({ ...row, droppedCitations });
  } catch (err) {
    console.error('research/valuation update failed:', err.message);
    res.status(500).json({ error: 'Could not update the valuation' });
  }
});

router.delete('/valuations/:id', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    await prisma.researchValuation.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('research/valuation delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete the valuation' });
  }
});

// Sweep a project's transcripts for answers to its open questions.
//
// The extract-then-link pipeline reads a transcript once, asks what is
// substantive, and matches the results to questions afterwards. That
// misses answers that do not read as assertions. "Pack the whole thing"
// is not a claim about anything; asked how many units go back on the
// shelf, it is the answer. This runs the other direction — one question
// at a time, against the tape — and it exists because a question showing
// no evidence has two very different causes: nobody answered it, or we
// did not look for the answer. Those must not look alike.
//
// Defaults to questions that currently have nothing, since re-reading
// every transcript for every question is a lot of model time to spend
// confirming what is already known.
router.post('/projects/:id/answer-scan', canResearch, heavyLimiter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });

  const only = Array.isArray(req.body?.questionIds)
    ? req.body.questionIds.map(Number).filter(Number.isInteger)
    : null;

  try {
    const project = await prisma.researchProject.findUnique({ where: { id } });
    if (!project) return res.status(404).json({ error: 'Not found' });

    const questions = await prisma.researchQuestion.findMany({
      where: { projectId: id, ...(only ? { id: { in: only } } : {}) },
      include: { _count: { select: { claims: true } } },
      orderBy: { rank: 'asc' },
    });
    // Without an explicit list, only chase what has nothing.
    const targets = only ? questions : questions.filter((q) => q._count.claims === 0);
    if (targets.length === 0) {
      return res.json({ scanned: 0, found: 0, linkedExisting: 0, created: 0, questions: [] });
    }

    const interviews = await prisma.interview.findMany({
      where: { projectId: id, quarantined: false, transcriptWords: { not: null } },
      select: { id: true, ticker: true, title: true, transcriptWords: true },
    });
    if (interviews.length === 0) {
      return res.status(409).json({ error: 'No transcribed interviews in this project.' });
    }

    const perQuestion = [];
    let created = 0;
    let linkedExisting = 0;
    let unsupported = 0;

    for (const q of targets) {
      const hits = [];

      // A re-run replaces this scan's own earlier answers to this
      // question rather than layering on them. The first live run wrote
      // a claim asserting a Hershey comparison over a quote that never
      // mentioned Hershey; without this, tightening the check would
      // leave that sitting in the ledger forever, since the pass that
      // now rejects it would simply never look at it again. Only its own
      // unverified rows — a person's verification is not ours to undo,
      // and the extractor's rows belong to the extractor.
      await prisma.researchClaim.deleteMany({
        where: { questionId: q.id, origin: 'answer-scan', verifiedById: null },
      });

      for (const iv of interviews) {
        const words = iv.transcriptWords;
        const scan = await scanForAnswer({ words, turns: rebuildTurns(words) }, q.text);
        unsupported += scan.rejected;
        const answer = scan.answer;
        if (!answer) continue;

        // The extractor may already have pulled this passage and simply
        // never linked it. Adopting that row rather than writing a second
        // one keeps a single claim per thing-that-was-said; two rows over
        // one sentence would read as two sources agreeing.
        const existing = await prisma.researchClaim.findFirst({
          where: {
            interviewId: iv.id,
            startMs: { gte: answer.startMs - 1500, lte: answer.startMs + 1500 },
          },
        });

        if (existing) {
          if (existing.questionId !== q.id) {
            await prisma.researchClaim.update({
              where: { id: existing.id },
              data: { questionId: q.id },
            });
            linkedExisting += 1;
          }
          hits.push({ interviewId: iv.id, title: iv.title, claimId: existing.id, adopted: true });
        } else {
          const row = await prisma.researchClaim.create({
            data: {
              interviewId: iv.id,
              ticker: iv.ticker,
              questionId: q.id,
              text: answer.text,
              quote: answer.quote,
              speaker: answer.speaker,
              startMs: answer.startMs,
              endMs: answer.endMs,
              // Partiality is recorded on the claim, not just in the
              // response, so a half-answer stays legible as a half-answer
              // in the ledger long after this run is forgotten.
              topic: answer.partial ? 'answer (partial)' : 'answer',
              kind: 'fact',
              origin: 'answer-scan',
              extractionConfidence: answer.extractionConfidence,
            },
          });
          created += 1;
          hits.push({
            interviewId: iv.id, title: iv.title, claimId: row.id,
            adopted: false, partial: answer.partial,
          });
        }
      }
      perQuestion.push({ questionId: q.id, question: q.text, hits });
    }

    res.json({
      scanned: targets.length,
      interviews: interviews.length,
      found: perQuestion.filter((q) => q.hits.length > 0).length,
      created,
      linkedExisting,
      // Answers that located verbatim but did not survive the check that
      // the quote actually says them. Worth watching: a spike means the
      // scan is reaching, and reaching is how a fabricated comparison
      // ends up wearing a real citation.
      unsupported,
      questions: perQuestion,
    });
  } catch (err) {
    console.error('research/answer-scan failed:', err.message);
    res.status(502).json({ error: 'Answer scan failed' });
  }
});

// The claim ledger for a ticker, with triangulation across sources.
router.get('/claims', async (req, res) => {
  try {
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
    const claims = await prisma.researchClaim.findMany({
      where: {
        ...(ticker ? { ticker } : {}),
        interview: CITABLE,
      },
      orderBy: [{ topic: 'asc' }, { startMs: 'asc' }],
      include: {
        interview: {
          select: {
            id: true,
            title: true,
            conductedAt: true,
            ticker: true,
            source: { select: SOURCE_PUBLIC },
          },
        },
      },
    });

    res.json({
      claims: claims.map((c) => ({
        ...c,
        stamp: formatStamp(c.startMs),
        citation: formatCitation(c, { formatStamp }),
      })),
      topics: assessTopics(claims),
    });
  } catch (err) {
    console.error('research/claims failed:', err.message);
    res.status(500).json({ error: 'Could not load claims' });
  }
});

// Mark a claim as human-verified — someone listened back and agrees the
// pin is right. Verified claims survive a re-extraction.
router.post('/claims/:id/verify', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const claim = await prisma.researchClaim.update({
      where: { id },
      data: {
        verifiedById: req.body?.unverify ? null : req.user?.id ?? null,
        verifiedAt: req.body?.unverify ? null : new Date(),
      },
    });
    res.json(claim);
  } catch (err) {
    console.error('research/verify failed:', err.message);
    res.status(500).json({ error: 'Could not update claim' });
  }
});

// Record a person's judgement on a screened interview.
//
// Separate from the automated screen on purpose. The screen produces a
// flag; a flag nobody has read is an open question, not a decision. This
// is where someone says "I read it, here is what I concluded" — and it
// is the only thing that should ever clear an elevated interview for
// use, because a model's low-confidence pass is not a sign-off.
router.post('/interviews/:id/review', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  // Optional. The model does the catching and states what it found; a
  // reviewer is confirming or overriding that, which is usually a click.
  // Demanding a written conclusion on every interview turned compliance
  // into paperwork and buried the one finding that mattered.
  const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
  try {
    const data = {
      reviewedAt: new Date(),
      reviewedById: req.user?.id ?? null,
      reviewNote: note,
    };
    // A reviewer may release a quarantine, but never silently: the
    // release is stamped with who did it and why.
    if (req.body?.release === true) {
      data.quarantined = false;
      data.status = 'Extracted';
      data.quarantineNote = `Released after review: ${note}`.slice(0, 1000);
    }
    if (req.body?.quarantine === true) {
      data.quarantined = true;
      data.status = 'Quarantined';
      data.quarantineNote = `Quarantined on review: ${note}`.slice(0, 1000);
    }
    const iv = await prisma.interview.update({
      where: { id },
      data,
      select: { id: true, quarantined: true, status: true, mnpiRisk: true, reviewedAt: true },
    });
    res.json(iv);
  } catch (err) {
    console.error('research/review failed:', err.message);
    res.status(500).json({ error: 'Could not record the review' });
  }
});

// Everything needing a compliance decision, across every project.
// Compliance that you have to remember to go looking for is compliance
// that gets skipped.
router.get('/compliance', async (_req, res) => {
  try {
    const interviews = await prisma.interview.findMany({
      where: {
        OR: [
          { quarantined: true },
          { mnpiRisk: { not: 'low' } },
          { consentObtained: false },
          { screenedAt: null },
        ],
        reviewedAt: null,
      },
      orderBy: [{ quarantined: 'desc' }, { conductedAt: 'desc' }],
      include: {
        source: { select: SOURCE_PUBLIC },
        project: { select: { id: true, name: true, ticker: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    });
    const total = await prisma.interview.count();
    res.json({
      total,
      needsAttention: interviews.map((i) => ({
        id: i.id, title: i.title, ticker: i.ticker,
        project: i.project, source: i.source,
        conductedAt: i.conductedAt,
        mnpiRisk: i.mnpiRisk, quarantined: i.quarantined,
        consentObtained: i.consentObtained,
        screened: !!i.screenedAt, attested: !!i.attestedAt,
        reviewedAt: i.reviewedAt, reviewedBy: i.reviewedBy, reviewNote: i.reviewNote,
        quarantineNote: i.quarantineNote,
      })),
    });
  } catch (err) {
    console.error('research/compliance failed:', err.message);
    res.status(500).json({ error: 'Could not load the compliance view' });
  }
});

// Re-run the MNPI screen on a transcript already stored.
//
// Interviews ingested before the screen recorded its findings carry a
// risk level and no explanation, which is the one state a reviewer
// cannot act on. This also covers a screen that ran while the model was
// down and got only the keyword pass.
router.post('/interviews/:id/screen', canResearch, heavyLimiter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const interview = await prisma.interview.findUnique({
      where: { id },
      include: { source: { select: { relationship: true } } },
    });
    if (!interview) return res.status(404).json({ error: 'Not found' });
    if (!interview.transcript) {
      return res.status(409).json({ error: 'There is no transcript to screen.' });
    }

    const screen = await screenTranscript(interview.transcript, {
      relationship: interview.source?.relationship,
    });

    // Same pessimism as the ingest path: a re-run may raise the risk and
    // must never talk the record down below what a person set by hand.
    const order = { low: 0, elevated: 1, prohibited: 2 };
    const risk =
      order[screen.risk] >= order[interview.mnpiRisk] ? screen.risk : interview.mnpiRisk;

    const updated = await prisma.interview.update({
      where: { id },
      data: {
        mnpiRisk: risk,
        screenedAt: new Date(),
        screenedById: req.user?.id ?? null,
        quarantined: interview.quarantined || risk === RISK.PROHIBITED,
        screenResult: {
          risk: screen.risk,
          reason: screen.reason,
          hits: screen.hits,
          modelAvailable: screen.modelAvailable,
        },
      },
      select: { id: true, mnpiRisk: true, quarantined: true, screenResult: true },
    });
    res.json(updated);
  } catch (err) {
    console.error('research/screen failed:', err.message);
    res.status(502).json({ error: 'The MNPI screen could not run' });
  }
});

// Quarantine an interview: it stays in the archive for the audit trail
// but its claims leave every citable read path immediately.
router.post('/interviews/:id/quarantine', canResearch, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  try {
    const on = req.body?.release !== true;
    const interview = await prisma.interview.update({
      where: { id },
      data: {
        quarantined: on,
        quarantineNote: req.body?.note ? String(req.body.note).slice(0, 1000) : null,
        status: on ? 'Quarantined' : 'Extracted',
        screenedAt: new Date(),
        screenedById: req.user?.id ?? null,
      },
      select: { id: true, quarantined: true, status: true },
    });
    res.json(interview);
  } catch (err) {
    console.error('research/quarantine failed:', err.message);
    res.status(500).json({ error: 'Could not update interview' });
  }
});

// Rebuild speaker turns from a stored word stream — the same grouping
// transcription.js does at ingest, without paying for the API again.
function rebuildTurns(words) {
  const turns = [];
  for (const w of Array.isArray(words) ? words : []) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === w.speaker) {
      last.text += ` ${w.text}`;
      last.endMs = w.endMs ?? last.endMs;
    } else {
      turns.push({ speaker: w.speaker, startMs: w.startMs, endMs: w.endMs, text: w.text });
    }
  }
  return turns;
}

export default router;
