// Audio in, evidence out: the one path a recording takes to become a
// transcript in the ledger.
//
// This was inline in the interview upload route until store calls needed
// the identical chain. Two copies of it would have been two consent
// checks, two screens and two chances for one of them to drift — and the
// one that drifted would be the new one, written in a hurry, for the
// calls nobody thought of as interviews.
//
// The order here is the whole point and does not vary:
//
//   consent → store (optionally) → transcribe → screen → write
//
// Consent first because recording someone without their agreement is
// unlawful in two-party states and fatal to a source relationship, and a
// check that runs after the audio is on disk has already failed. Screen
// before the row is readable because an interview must never sit
// unscreened in the archive waiting for somebody to request it.
import prisma from '../db.js';
import { transcribe } from './transcription.js';
import { screenTranscript, RISK } from './mnpiScreen.js';
import { uploadFile } from './oneDriveStorage.js';

function fail(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * @param {object} args
 * @param {number} args.interviewId
 * @param {Buffer} args.buffer        raw audio
 * @param {string} [args.filename]
 * @param {string} [args.mimetype]
 * @param {number} [args.numSpeakers] default 2
 * @param {number|null} [args.userId] who pressed the button
 * @param {boolean} [args.retainAudio]
 *   Whether the audio is kept after the transcript exists. True for a
 *   scheduled interview, where the tape is the backup for a claim
 *   somebody may challenge years later. False for a store channel check:
 *   forty cold calls to shop assistants who agreed to be recorded for
 *   one conversation is not an archive anybody intended to build, and
 *   the least dangerous place for that audio is nowhere. The transcript
 *   is the evidence either way; the difference is only how much of a
 *   stranger's voice we keep afterwards.
 * @param {object} [deps] test seams
 */
export async function ingestRecording(
  {
    interviewId,
    buffer,
    filename,
    mimetype,
    numSpeakers = 2,
    userId = null,
    retainAudio = true,
  },
  deps = {}
) {
  const db = deps.prisma || prisma;
  const doTranscribe = deps.transcribe || transcribe;
  const doScreen = deps.screenTranscript || screenTranscript;
  const doUpload = deps.uploadFile || uploadFile;

  const interview = await db.interview.findUnique({ where: { id: interviewId } });
  if (!interview) throw fail('Not found', 'NOT_FOUND', 404);
  if (!interview.consentObtained) {
    throw fail(
      'Consent is not recorded for this interview. Record consent before uploading audio.',
      'NO_CONSENT',
      409
    );
  }

  // Store the audio alongside every other member upload so the recording
  // outlives anyone's laptop — unless this is a call we promised not to
  // keep, in which case the buffer is used and dropped.
  let recordingRef = interview.recordingRef;
  if (retainAudio) {
    try {
      const stored = await doUpload({
        buffer,
        filename: filename || `interview-${interviewId}.m4a`,
        contentType: mimetype || 'audio/mpeg',
      });
      if (stored?.id) recordingRef = `onedrive:${stored.id}`;
    } catch (err) {
      // Storage failing should not cost us the transcription — the
      // transcript is the evidence, the audio is the backup.
      console.error(`research: recording upload failed for ${interviewId}:`, err.message);
    }
  }

  const result = await doTranscribe(buffer, { filename, numSpeakers });

  const source = await db.researchSource.findUnique({
    where: { id: interview.sourceId },
    select: { relationship: true },
  });
  const screen = await doScreen(result.transcript, { relationship: source?.relationship });

  const prohibited = screen.risk === RISK.PROHIBITED;
  const updated = await db.interview.update({
    where: { id: interviewId },
    data: {
      recordingRef,
      transcript: result.transcript,
      transcriptWords: result.words,
      transcriptModel: result.model,
      durationMs: result.durationMs,
      status: prohibited ? 'Quarantined' : 'Transcribed',
      mnpiRisk: screen.risk,
      screenedAt: new Date(),
      screenedById: userId,
      // Prohibited quarantines immediately: material non-public
      // information must not reach the ledger while somebody gets round
      // to reviewing it. A person can release it afterwards — the safe
      // default is the reversible one.
      quarantined: prohibited,
      quarantineNote: prohibited ? `Auto-quarantined by MNPI screen: ${screen.reason}` : null,
      screenResult: {
        risk: screen.risk,
        reason: screen.reason,
        hits: screen.hits,
        modelAvailable: screen.modelAvailable,
      },
    },
    select: {
      id: true,
      status: true,
      durationMs: true,
      transcriptModel: true,
      mnpiRisk: true,
      quarantined: true,
    },
  });

  return {
    ...updated,
    // Said plainly rather than inferred from a null recordingRef, so a
    // client never has to guess whether the audio is gone on purpose.
    audioRetained: Boolean(retainAudio && recordingRef),
    wordCount: result.words.length,
    speakerCount: result.speakerCount,
    screen: {
      risk: screen.risk,
      reason: screen.reason,
      hits: screen.hits,
      // A "low" that only the crude pass produced is not a clean bill of
      // health, and the UI must not present it as one.
      modelAvailable: screen.modelAvailable,
    },
    // One separated voice on a two-party call means diarization failed,
    // and every attribution from it would be a guess. The caller is told
    // rather than left to discover it in a footnote.
    diarizationWarning:
      result.speakerCount < 2
        ? 'Only one speaker was separated — attributions from this transcript are unreliable.'
        : null,
  };
}
