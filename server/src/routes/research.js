import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { verifyJwt, requireRole } from '../middleware/auth.js';
import { transcribe, isConfigured as transcriptionConfigured, formatStamp } from '../services/transcription.js';
import { extractClaims } from '../services/claimExtraction.js';
import { assessTopics, formatCitation } from '../services/corroboration.js';
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
const heavyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
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
    const interviews = await prisma.interview.findMany({
      where: ticker ? { ticker } : undefined,
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
  const { sourceId, ticker, title, conductedAt, consentObtained, consentNote, mnpiRisk } = req.body || {};
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
        quarantined: risk === 'prohibited',
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

      const updated = await prisma.interview.update({
        where: { id },
        data: {
          recordingRef,
          transcript: result.transcript,
          transcriptWords: result.words,
          transcriptModel: result.model,
          durationMs: result.durationMs,
          status: 'Transcribed',
        },
        select: { id: true, status: true, durationMs: true, transcriptModel: true },
      });

      res.json({
        ...updated,
        wordCount: result.words.length,
        speakerCount: result.speakerCount,
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
    const { claims, dropped, unavailable } = await extractClaims({
      words,
      turns: rebuildTurns(words),
    });
    if (unavailable) {
      return res.status(503).json({ error: 'The research model is unavailable right now.' });
    }

    const written = await prisma.$transaction(async (tx) => {
      await tx.researchClaim.deleteMany({
        where: { interviewId: id, verifiedById: null },
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
        })),
      });
      await tx.interview.update({ where: { id }, data: { status: 'Extracted' } });
      return created.count;
    });

    res.json({
      extracted: written,
      // Surfaced deliberately: a spike here means the model started
      // paraphrasing instead of quoting, and that run's output should
      // be treated as suspect.
      droppedUnlocatable: dropped,
    });
  } catch (err) {
    console.error('research/extract failed:', err.message);
    res.status(502).json({ error: 'Claim extraction failed' });
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
