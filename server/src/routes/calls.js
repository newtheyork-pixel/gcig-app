import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { isSuperAdminEmail, verifyJwt, requireRole, denyGuest } from '../middleware/auth.js';
import { parsePhone, formatPhone, telUrl } from '../services/phone.js';
import { ingestRecording } from '../services/recordingIngest.js';
import { regimeFor } from '../services/recordingConsent.js';
import { inferOutcome } from '../services/callOutcome.js';
import { isConfigured as transcriptionConfigured } from '../services/transcription.js';

// Store channel checks, placed from the terminal.
//
// The club does not own a phone system and does not want one. What it
// owns is the queue, the script, the log and the transcript; the ringing
// is done by the analyst's own handset, which is why there is no carrier
// in this file. The server hands out a tel: URL and writes down what
// came back.
//
// Three invariants hold the thing together.
//
//   EVERY DIAL IS A ROW. Ring forty doors and eleven answer; the
//   thirty-nine rows that are not interviews are what stop a later read
//   becoming "of the stores that felt like talking". A refusal is
//   evidence about the banner, a ring-out is evidence about the hour.
//
//   A STORE IS ITS OWN SOURCE. corroboration.js bounds independence by
//   distinct employer, so eight calls filed under the employer "Kay
//   Jewelers" come back as ONE line of evidence, `clustered`, however
//   many doors were rung. Each door therefore gets its own source row
//   whose employer is that door. This matches the rule the field-work
//   spine already states, that independence for observations is distinct
//   LOCATIONS. It is not a free pass: two stores in one district repeat
//   the same corporate promo calendar, so they are independent on what
//   is physically on their shelf and NOT independent on what head office
//   told them, and nothing here can tell those apart for you.
//
//   STORE STAFF ARE CURRENT EMPLOYEES. Sources created here get
//   relationship CurrentEmployee, which starts every one of these calls
//   at elevated MNPI risk. That is deliberate and is not paperwork: the
//   whole reason a store manager is worth calling is that they sometimes
//   know something head office has not said yet, and inventing a gentler
//   category for them would be exactly the screen that can be talked out
//   of a flag.

const router = Router();
router.use(verifyJwt);
// Defence in depth: a guest never dials on the club's behalf and never
// sees the call log, whatever the firewall allowlist says.
router.use(denyGuest);

const canResearch = requireRole('Analyst');

const upload = multer({
  storage: multer.memoryStorage(),
  // CallRecorder writes uncompressed 16 kHz 16-bit stereo, which is
  // 3.84 MB a minute, so a fifteen-minute call is ~58 MB and the old
  // 50 MB ceiling refused it — as an opaque 500, because multer's
  // LIMIT_FILE_SIZE carries no status. Matched to the interview route.
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Transcription costs money per minute. Sized for a genuine calling
// session, which is a couple of dozen doors in an afternoon.
const recordingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed per CALLER, never per IP. In the building every member is
  // behind one public address, so an IP bucket is one allowance the
  // whole club shares and a single afternoon of calling locks everybody
  // else out. This is the rule the rest of the repo already follows.
  keyGenerator: (req) => `calls-recording:${req.user?.id || req.ip}`,
  message: { error: 'Too many recordings uploaded in the last hour.' },
});

// Null while the call is still up. Every one of these is a different
// fact, which is why there is no single "didn't work".
const OUTCOMES = new Set([
  'Answered',
  'NoAnswer',
  'Busy',
  'Voicemail',
  'Refused',
  'WrongNumber',
  'CallBackLater',
  'Failed',
]);

// What each outcome says about whether a person picked up. Absent means
// the outcome does not settle it, and null beats a guess: Voicemail is a
// machine answering and WrongNumber could be either.
const ANSWERED_BY_OUTCOME = {
  Answered: true,
  Refused: true,
  CallBackLater: true,
  NoAnswer: false,
  Busy: false,
  Failed: false,
};

// Where the duration came from. Kept apart because they are different
// measurements and a column that renders them alike invites a precision
// nobody took.
const METADATA_SOURCES = new Set(['apptimer', 'callhistory', 'manual']);

// Relationships a door may carry through to the source it becomes.
// Deliberately not every string the funnel accepts: an unrecognised one
// means nobody decided, and the undecided case has to land on the
// stricter side.
// Which recording rule the call was placed under, and therefore what
// happens to the audio afterwards.
//
// one-party: lawful on the caller's own consent, so the tape is KEPT —
//   it is what a contested claim gets walked back to.
// all-party: we asked and they agreed to a conversation being recorded
//   for notes, so the file goes once the transcript exists.
// unknown: treated as all-party everywhere. A jurisdiction nobody has
//   established is not a licence, and the cost of being wrong in the
//   other direction is a stranger's voice we had no right to keep.
const CONSENT_REGIMES = new Set(['one-party', 'all-party', 'unknown']);

/** The only place this decision is made. */
function keepsAudio(regime) {
  return regime === 'one-party';
}

const DOOR_RELATIONSHIPS = new Set([
  'CurrentEmployee', 'FormerEmployee', 'Distributor', 'Customer',
  'Supplier', 'Competitor', 'IndustryExpert',
]);

/** Projects a non-owner may not see never enter the query at all. */
function visibilityFor(req) {
  return isSuperAdminEmail(req.user?.email) ? {} : { ownerOnly: false };
}

async function loadProject(db, projectId, req) {
  return db.researchProject.findFirst({
    where: { id: projectId, ...visibilityFor(req) },
  });
}

/**
 * The dial list.
 *
 * Sorted the way an afternoon is actually worked: priority first, and
 * within that the doors nobody has tried yet, because the cost of
 * re-ringing a store you already spoke to is not the wasted minute, it
 * is the second conversation arriving as a duplicate data point.
 */
export async function callQueueHandler(req, res, deps = {}) {
  const { db = prisma } = deps;
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad id' });
  try {
    const project = await loadProject(db, projectId, req);
    if (!project) return res.status(404).json({ error: 'No such project' });

    const targets = await db.researchTarget.findMany({
      where: { projectId, phone: { not: null } },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, employer: true, tier: true, status: true,
        phone: true, locationState: true, notes: true, priority: true,
        // The count comes from the database, not from the three rows
        // fetched for display. Deriving it from `take: 3` capped every
        // badge at three and, worse, hid an Answered that had fallen off
        // the end — so a door that HAD been reached came back looking
        // untouched and got rung again.
        _count: { select: { callAttempts: true } },
        callAttempts: {
          orderBy: { startedAt: 'desc' },
          take: 3,
          select: {
            id: true, startedAt: true, outcome: true, durationMs: true,
            interviewId: true, callerId: true,
          },
        },
      },
    });

    // Which doors have EVER answered, across the whole history. One
    // query for the project rather than a scan per door, and it answers
    // the only question the badge is for: do not ring this one again
    // without a reason.
    const answeredRows = await db.callAttempt.findMany({
      where: { projectId, outcome: 'Answered', targetId: { not: null } },
      select: { targetId: true },
      distinct: ['targetId'],
    });
    const answeredDoors = new Set(answeredRows.map((r) => r.targetId));

    // Targets on this project carrying no number at all. They are NOT
    // listed: on a project whose funnel is former employees reached by
    // email, every one of them would be noise in a dial list. But the
    // count is reported, because a queue of twenty-eight that silently
    // dropped twelve doors nobody found a number for reads as a complete
    // sample when it is not.
    const withoutPhone = await db.researchTarget.count({
      where: { projectId, phone: null },
    });

    const rows = targets.map((t) => {
      const parsed = parsePhone(t.phone);
      const attempts = t.callAttempts;
      return {
        ...t,
        callAttempts: undefined,
        // A number that will not parse is surfaced on the row rather
        // than filtered out of the queue: a door you cannot ring is a
        // gap in the sample and has to be visible as one.
        dialable: Boolean(parsed),
        phoneDisplay: parsed ? formatPhone(parsed) : t.phone,
        telUrl: parsed ? telUrl(parsed) : null,
        _count: undefined,
        attemptCount: t._count?.callAttempts ?? attempts.length,
        lastAttempt: attempts[0] || null,
        // Reached at least once, so a second ring needs a reason.
        everAnswered: answeredDoors.has(t.id),
      };
    });

    // The order an afternoon is actually worked. Priority first, then
    // the doors nobody has tried, then alphabetical. The docblock has
    // promised this since the file was written and only the database's
    // half of it was implemented, so a refused door sorted above an
    // untouched one and got rung again.
    rows.sort((a, b) => {
      const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
      const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      const ta = a.attemptCount > 0 ? 1 : 0;
      const tb = b.attemptCount > 0 ? 1 : 0;
      if (ta !== tb) return ta - tb;
      return String(a.name).localeCompare(String(b.name));
    });

    res.json({
      project: { id: project.id, name: project.name, ticker: project.ticker },
      // Said out loud so the queue never looks complete when it is not.
      undialable: rows.filter((r) => !r.dialable).length,
      withoutPhone,
      targets: rows,
    });
  } catch (err) {
    console.error('calls/queue failed:', err.message);
    res.status(500).json({ error: 'Could not load the call queue' });
  }
}

/**
 * The log, and the denominator.
 *
 * The roll-up is the point of the endpoint. A channel check that reports
 * what eleven stores said, without saying that forty were rung and seven
 * refused, is a different and much friendlier finding than the one the
 * afternoon actually produced.
 */
export async function callLogHandler(req, res, deps = {}) {
  const { db = prisma } = deps;
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad id' });
  try {
    const project = await loadProject(db, projectId, req);
    if (!project) return res.status(404).json({ error: 'No such project' });

    const calls = await db.callAttempt.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: 500,
      include: {
        caller: { select: { id: true, name: true } },
        target: { select: { id: true, name: true, employer: true, tier: true, locationState: true } },
        interview: { select: { id: true, status: true, mnpiRisk: true, quarantined: true } },
      },
    });

    const byOutcome = {};
    const byBanner = {};
    for (const c of calls) {
      const key = c.outcome || 'InProgress';
      byOutcome[key] = (byOutcome[key] || 0) + 1;
      const banner = c.target?.employer || 'Unattributed';
      byBanner[banner] ||= { dials: 0, answered: 0, refused: 0, doors: new Set() };
      byBanner[banner].dials += 1;
      if (c.outcome === 'Answered') byBanner[banner].answered += 1;
      if (c.outcome === 'Refused') byBanner[banner].refused += 1;
      if (c.targetId) byBanner[banner].doors.add(c.targetId);
    }

    res.json({
      calls,
      rollup: {
        dials: calls.length,
        byOutcome,
        // Doors, not dials: ringing one store four times is one door.
        // The distinction is the same one corroboration makes, and for
        // the same reason.
        byBanner: Object.fromEntries(
          Object.entries(byBanner).map(([k, v]) => [
            k,
            { dials: v.dials, answered: v.answered, refused: v.refused, doors: v.doors.size },
          ])
        ),
        transcribed: calls.filter((c) => c.interviewId).length,
      },
    });
  } catch (err) {
    console.error('calls/log failed:', err.message);
    res.status(500).json({ error: 'Could not load the call log' });
  }
}

/**
 * Open a call.
 *
 * Written before the phone rings, not after, so a call that goes wrong
 * still leaves a row. The response carries the tel: URL because the
 * server is the only place that knows how to turn what somebody typed
 * into something a handset will accept.
 */
export async function openCallHandler(req, res, deps = {}) {
  const { db = prisma } = deps;
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Bad id' });
  const { targetId, phone, notes } = req.body || {};
  try {
    const project = await loadProject(db, projectId, req);
    if (!project) return res.status(404).json({ error: 'No such project' });

    let target = null;
    if (targetId !== undefined && targetId !== null) {
      const tid = Number(targetId);
      if (!Number.isInteger(tid)) return res.status(400).json({ error: 'Bad targetId' });
      target = await db.researchTarget.findFirst({ where: { id: tid, projectId } });
      if (!target) return res.status(404).json({ error: 'No such target on this project' });
    }

    const raw = phone || target?.phone;
    if (!raw) return res.status(400).json({ error: 'No number to dial' });
    const parsed = parsePhone(raw);
    if (!parsed) {
      // Refused rather than stored: a number we cannot parse is a number
      // that will misdial, and a log saying we rang it would be false.
      return res.status(400).json({
        error: `Not a dialable number: ${String(raw).slice(0, 40)}`,
      });
    }

    // The regime is derived, not chosen. Asking an analyst mid-call to
    // rule on a state they have not looked up produced one answer every
    // time, the safe one, which meant the tape was thrown away even on
    // the calls where keeping it was both lawful and the point.
    //
    // Consent itself is not in question here: the disclosure is read on
    // every call, which is what makes the recording lawful at both ends.
    // This decides only whether the audio survives the transcript.
    const consent = regimeFor({
      storeState: target?.locationState,
      callerState: req.body?.callerState,
    });

    const call = await db.callAttempt.create({
      data: {
        projectId,
        targetId: target?.id ?? null,
        ticker: project.ticker,
        dialedNumber: parsed.ext ? `${parsed.e164};ext=${parsed.ext}` : parsed.e164,
        callerId: req.user?.id ?? null,
        startedAt: new Date(),
        consentRegime: consent.regime,
        // True because the script requires the disclosure before anything
        // else is said. A person who objects flips it false, which is the
        // only thing that stops a transcript being made.
        consentSpoken: true,
        notes: notes ? String(notes).slice(0, 10_000) : null,
      },
      include: { target: { select: { id: true, name: true, employer: true, locationState: true } } },
    });

    res.status(201).json({
      ...call,
      telUrl: telUrl(parsed),
      phoneDisplay: formatPhone(parsed),
      // Shown on the console so the analyst can see WHY the tape is being
      // kept or dropped, rather than being told that it is.
      consentReason: consent.reason,
      consentUnknownEnd: consent.unknownEnd,
    });
  } catch (err) {
    console.error('calls/create failed:', err.message);
    res.status(500).json({ error: 'Could not open the call' });
  }
}

/**
 * Close a call, or correct one.
 *
 * `metadataSource` travels with the duration because they are one fact
 * together and useless apart. An app timer starts when a human presses
 * dial and therefore includes ringing and the seconds spent finding the
 * handset; a duration read back off the phone's own record does not.
 */
export async function updateCallHandler(req, res, deps = {}) {
  const { db = prisma } = deps;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const {
    outcome, endedAt, durationMs, metadataSource, answered,
    consentSpoken, consentNote, consentRegime, notes,
  } = req.body || {};

  if (outcome !== undefined && outcome !== null && !OUTCOMES.has(String(outcome))) {
    return res.status(400).json({ error: `Unknown outcome: ${String(outcome).slice(0, 40)}` });
  }
  if (metadataSource !== undefined && !METADATA_SOURCES.has(String(metadataSource))) {
    return res.status(400).json({ error: `Unknown metadataSource: ${String(metadataSource).slice(0, 40)}` });
  }
  if (consentRegime !== undefined && !CONSENT_REGIMES.has(String(consentRegime))) {
    return res.status(400).json({ error: `Unknown consentRegime: ${String(consentRegime).slice(0, 40)}` });
  }

  try {
    const existing = await db.callAttempt.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const project = await loadProject(db, existing.projectId, req);
    if (!project) return res.status(404).json({ error: 'Not found' });

    const data = {};
    if (outcome !== undefined) data.outcome = outcome === null ? null : String(outcome);
    if (endedAt !== undefined) data.endedAt = endedAt ? new Date(endedAt) : null;
    if (durationMs !== undefined) {
      const d = Number(durationMs);
      data.durationMs = Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
    }
    if (metadataSource !== undefined) data.metadataSource = String(metadataSource);
    if (answered !== undefined) data.answered = answered === null ? null : Boolean(answered);
    if (consentSpoken !== undefined) data.consentSpoken = Boolean(consentSpoken);
    if (consentNote !== undefined) {
      data.consentNote = consentNote ? String(consentNote).slice(0, 2_000) : null;
    }
    if (consentRegime !== undefined) data.consentRegime = String(consentRegime);
    if (notes !== undefined) data.notes = notes ? String(notes).slice(0, 10_000) : null;

    // `answered` asks whether a HUMAN picked up, which is not the same
    // question as whether the call produced anything. A refusal is
    // somebody answering and declining, and filing it as unanswered
    // undercounts the connect rate by exactly the rows this table
    // exists to keep. Ambiguous outcomes are left null rather than
    // guessed: a machine picking up is not a person, and a wrong number
    // might be either.
    if (data.outcome && answered === undefined) {
      const implied = ANSWERED_BY_OUTCOME[data.outcome];
      if (implied !== undefined) data.answered = implied;
    }

    const call = await db.callAttempt.update({
      where: { id },
      data,
      include: {
        target: { select: { id: true, name: true, employer: true } },
        interview: { select: { id: true, status: true } },
      },
    });

    // A door that answered is Contacted, and one that refused is
    // Declined. Moving the funnel here rather than asking the analyst to
    // remember means the queue is still true at the end of an afternoon.
    if (existing.targetId && data.outcome) {
      const status =
        data.outcome === 'Answered' ? 'Contacted'
        : data.outcome === 'Refused' ? 'Declined'
        : data.outcome === 'WrongNumber' ? 'Unreachable'
        : null;
      if (status) {
        await db.researchTarget.update({
          where: { id: existing.targetId },
          data: { status, lastContactAt: new Date() },
        }).catch((e) => console.error('calls: target status update failed:', e.message));
      }
    }

    res.json(call);
  } catch (err) {
    console.error('calls/update failed:', err.message);
    res.status(500).json({ error: 'Could not update the call' });
  }
}

/**
 * A recording from a store call, turned into a transcript in the ledger.
 *
 * Whether the audio survives is decided by the call's consentRegime and
 * by nothing else. Under one-party the tape is kept, because a contested
 * claim is walked back to a recording and a transcript alone cannot do
 * that. Under all-party the file is destroyed the moment the transcript
 * exists: they agreed to a conversation being recorded for notes, not to
 * the club holding their voice. A regime nobody set reads as all-party.
 *
 * Consent is checked twice on the way in, which is not redundant: this
 * route refuses without a spoken disclosure logged on the CALL, and
 * ingestRecording refuses without consent recorded on the INTERVIEW. The
 * first is about the conversation, the second about the file.
 */
export async function callRecordingHandler(req, res, deps = {}) {
  const { db = prisma, ingest = ingestRecording, configured = transcriptionConfigured } = deps;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!configured()) {
      return res.status(503).json({
        error: 'Transcription is not configured — set ELEVENLABS_API_KEY.',
      });
    }

    try {
      const call = await db.callAttempt.findUnique({
        where: { id },
        include: { target: true },
      });
      if (!call) return res.status(404).json({ error: 'Not found' });
      const project = await loadProject(db, call.projectId, req);
      if (!project) return res.status(404).json({ error: 'Not found' });

      // The disclosure is read on every call, so the question here is not
      // whether somebody ticked a box. It is whether anybody OBJECTED.
      // An explicit objection blocks the transcript outright, in either
      // regime: a person who said no to being recorded has not agreed to
      // a transcript of the recording either.
      if (call.consentSpoken === false) {
        return res.status(409).json({
          error: 'This call was marked as objected to. No transcript can be made from it.',
        });
      }
      if (call.interviewId) {
        // One dial is one interview. A second upload is a mistake, not a
        // second opinion, and the unique constraint would refuse it
        // anyway — this is the readable version of that refusal.
        return res.status(409).json({
          error: `This call already has interview ${call.interviewId}.`,
        });
      }

      // The door, not the banner. See the note at the top of this file:
      // filing every Kay store under one employer collapses eight
      // independent shelf reads into one line of evidence.
      const doorLabel =
        call.target?.name ||
        `Unlisted store (${call.dialedNumber})`;

      // The door's own relationship decides the source's. A shop
      // assistant behind a company-owned counter is a current employee
      // of the name under study; one in a third-party retailer that
      // merely stocks the product is not, and filing them alike would
      // either mislabel the source or elevate every call for nothing.
      //
      // Anything vague falls back to the stricter reading. A screen that
      // can be softened by leaving a field blank is not a screen.
      const relationship = DOOR_RELATIONSHIPS.has(call.target?.relationship)
        ? call.target.relationship
        : 'CurrentEmployee';

      // Find-or-create with no unique index, so two simultaneous first
      // calls to one door can make two source rows. Accepted rather than
      // migrated: corroboration keys on the employer STRING, so duplicate
      // rows carrying the same door still collapse to one line of
      // evidence. The cost is a tidy-up, not a wrong number.
      let source = await db.researchSource.findFirst({
        where: { employer: doorLabel, relationship },
      });
      if (!source) {
        source = await db.researchSource.create({
          data: {
            alias: doorLabel,
            employer: doorLabel,
            relationship,
            role: 'Store staff',
            tickers: project.ticker ? [project.ticker] : [],
            notes:
              'Created by a store channel check. Employer is the individual door, '
              + 'so corroboration counts locations rather than collapsing a banner '
              + 'into one line. Staff at two doors in one district are NOT '
              + 'independent on anything head office told them.',
            createdById: req.user?.id ?? null,
          },
        });
      }

      const when = call.startedAt || new Date();
      const interview = await db.interview.create({
        data: {
          sourceId: source.id,
          ticker: project.ticker,
          title: `${doorLabel} — channel check`,
          conductedAt: when,
          interviewerId: call.callerId ?? req.user?.id ?? null,
          status: 'Recorded',
          projectId: call.projectId,
          consentObtained: true,
          // Spelled out rather than left as a bare true. Months later
          // "consent obtained" has to say WHOSE: a one-party recording
          // rests on the caller's own agreement and nobody on the other
          // end was ever asked, which is a materially different record
          // from somebody saying yes on tape.
          consentNote:
            call.consentNote
            || (keepsAudio(call.consentRegime)
              ? 'Placed under a one-party rule: recorded on the caller\'s own consent. '
                + 'No disclosure was required and none is claimed.'
              : 'Recording disclosed at the top of the call and agreed to. Logged on the call attempt.'),
        },
      });

      // Claim the dial BEFORE paying for a transcript. The read of
      // `call.interviewId` above is a check-then-act: a double click
      // sends two uploads, both see null, both create an Interview and
      // both pay ElevenLabs, and the loser's unique-constraint failure
      // used to leave a fully transcribed orphan in the project. This
      // update is conditional on the column still being null, so exactly
      // one request can win it.
      const claim = await db.callAttempt.updateMany({
        where: { id, interviewId: null },
        data: { interviewId: interview.id, recorded: true },
      });
      if (claim.count === 0) {
        await db.interview.delete({ where: { id: interview.id } }).catch(() => {});
        return res.status(409).json({
          error: 'Another upload for this call is already in progress.',
        });
      }

      let out;
      try {
        out = await ingest({
          interviewId: interview.id,
          buffer: req.file.buffer,
          filename: req.file.originalname || `call-${id}.m4a`,
          mimetype: req.file.mimetype,
          numSpeakers: Number(req.body?.numSpeakers) || 2,
          userId: req.user?.id ?? null,
          // The regime decides, and nothing else does. An `unknown` or a
          // missing value lands on all-party, which destroys the file.
          retainAudio: keepsAudio(call.consentRegime),
        });
      } catch (err) {
        // The interview row exists but has no transcript. Leaving it
        // would put an empty interview in the project for every failed
        // upload, and a project whose interview count is mostly ghosts
        // is one nobody trusts. The claim is released with it, so a
        // retry is not locked out by the attempt that failed.
        await db.callAttempt
          .update({ where: { id }, data: { interviewId: null, recorded: false } })
          .catch(() => {});
        await db.interview
          .delete({ where: { id: interview.id } })
          .catch(() => {});
        throw err;
      }

      // What happened on the call, worked out rather than typed in.
      //
      // The eight outcome buttons were a tax on the wrong moment: an
      // analyst who has just hung up is thinking about what the manager
      // said, and they were also the only way to close a row, so a
      // forgotten press left the timer running forever. The phone's own
      // record settles whether anybody picked up; the local model reads
      // the transcript for the rest. An outcome nobody could establish
      // stays null and says so, because NoAnswer is the value that would
      // quietly flatter the refusal rate.
      const transcribed = await db.interview.findUnique({
        where: { id: interview.id },
        select: { transcript: true },
      });
      const inferred = await inferOutcome({
        transcript: transcribed?.transcript,
        record: { answered: call.answered, durationMs: call.durationMs },
      });

      await db.callAttempt.update({
        where: { id },
        data: {
          // What happened to the tape is read back off the ingest rather
          // than assumed from the regime: storage can fail, and a log
          // that says an audio file exists when it does not is worse
          // than one that says nothing.
          audioRetained: out.audioRetained === true,
          // Never overwrite a human's call. A person who already picked
          // an outcome has made a judgement the model does not get to
          // revise.
          ...(call.outcome ? {} : { outcome: inferred.outcome ?? undefined }),
          ...(call.outcome || !inferred.outcome ? {} : {
            answered: inferred.outcome === 'NoAnswer' ? false : call.answered ?? undefined,
          }),
        },
      });

      res.json({
        ...out,
        callId: id,
        interviewId: interview.id,
        sourceId: source.id,
        outcome: call.outcome || inferred.outcome,
        // Said out loud so a low-confidence guess is visible as one.
        outcomeInference: call.outcome ? null : inferred,
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message });
      if (err.code === 'EMPTY_TRANSCRIPT') return res.status(422).json({ error: err.message });
      console.error('calls/recording failed:', err.message);
      res.status(502).json({ error: err.message });
    }
}

// Wiring. Handlers are exported above and driven directly by the test
// suite with a Prisma double, which is how every other route file in
// here is tested: no HTTP harness, no database.
router.get('/projects/:id/call-queue', canResearch, (req, res) => callQueueHandler(req, res));
router.get('/projects/:id/calls', canResearch, (req, res) => callLogHandler(req, res));
router.post('/projects/:id/calls', canResearch, (req, res) => openCallHandler(req, res));
router.patch('/calls/:id', canResearch, (req, res) => updateCallHandler(req, res));
router.post(
  '/calls/:id/recording',
  canResearch,
  recordingLimiter,
  upload.single('file'),
  (req, res) => callRecordingHandler(req, res)
);

export default router;
