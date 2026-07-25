// Speech to text for field-research recordings, via ElevenLabs Scribe.
//
// The output here is the evidence of record. Everything downstream — a
// claim, a footnote, a figure in a report — indexes back into the word
// stream this produces, so two properties matter more than accuracy:
//
//   Diarization. A claim attributed to the wrong speaker is worse than
//   no claim. We ask for speaker labels and carry them through; when the
//   model can't tell voices apart the label is null, never guessed.
//
//   Word-level offsets. Every claim pins to a millisecond range so a
//   reader can jump to the moment and hear it said. Sentence-level
//   timing is not good enough for that.
//
// Config: ELEVENLABS_API_KEY. Absent, transcription is simply
// unavailable and the caller is told so — an interview keeps its
// recording and can be transcribed later.

const API_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

// scribe_v1 was withdrawn in July 2026; v2 is the current model. Kept in
// an env var so a future model is a config change, and recorded on the
// row so we know which model produced any given transcript.
const DEFAULT_MODEL = 'scribe_v2';

// Interviews run long. A 90-minute call is a large upload plus real
// inference time, so this is generous by design.
const TIMEOUT_MS = 10 * 60 * 1000;

export function isConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

function requireKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    const err = new Error(
      'Transcription is not configured — set ELEVENLABS_API_KEY.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return key;
}

// Scribe reports seconds as floats. We store milliseconds as integers:
// the offsets are array indices into a recording, not measurements, and
// float drift in a citation is the kind of thing that makes a footnote
// wrong by a word.
function toMs(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.round(seconds * 1000));
}

/**
 * Normalize Scribe's word stream into the shape we persist.
 *
 * Keeps only real words — Scribe also emits `spacing` and `audio_event`
 * entries, which carry no citable content and would inflate every offset
 * lookup. Exported for tests.
 */
export function normalizeWords(words) {
  const out = [];
  for (const w of Array.isArray(words) ? words : []) {
    if (!w || w.type === 'spacing') continue;
    const text = typeof w.text === 'string' ? w.text : '';
    if (!text.trim()) continue;
    const startMs = toMs(w.start);
    if (startMs == null) continue;
    out.push({
      text,
      startMs,
      endMs: toMs(w.end),
      // `speaker_1` etc. when diarization worked, null when it didn't.
      // Never inferred — an unlabelled word stays unlabelled.
      speaker: typeof w.speaker_id === 'string' ? w.speaker_id : null,
      // Audio events (laughter, crosstalk) are kept but marked, since
      // they matter for reading a transcript and must never be quoted
      // as speech.
      ...(w.type && w.type !== 'word' ? { type: w.type } : {}),
    });
  }
  return out;
}

/**
 * Group a word stream into speaker turns — the readable transcript.
 * A new turn starts whenever the speaker label changes.
 *
 * Exported for tests and for re-rendering a transcript without paying
 * for the API again.
 */
export function toTurns(words) {
  const turns = [];
  for (const w of words) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === w.speaker) {
      last.text += (last.text ? ' ' : '') + w.text;
      last.endMs = w.endMs ?? last.endMs;
    } else {
      turns.push({
        speaker: w.speaker,
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.text,
      });
    }
  }
  return turns;
}

/** Render turns as the plain reading copy stored on the interview. */
export function renderTranscript(turns) {
  return turns
    .map((t) => {
      const stamp = formatStamp(t.startMs);
      const who = t.speaker ? t.speaker.replace(/^speaker_/, 'Speaker ') : 'Unknown';
      return `[${stamp}] ${who}: ${t.text}`;
    })
    .join('\n\n');
}

export function formatStamp(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Transcribe an audio buffer.
 *
 * @param {Buffer} buffer - the recording
 * @param {object} opts
 * @param {string} opts.filename - used for the multipart part name
 * @param {number} opts.numSpeakers - hint; most of our calls are 2
 * @param {object} deps - injectable fetch, for tests
 * @returns {Promise<{words, turns, transcript, model, durationMs}>}
 */
export async function transcribe(buffer, opts = {}, deps = {}) {
  const key = deps.apiKey || requireKey();
  const doFetch = deps.fetch || fetch;
  const model = process.env.ELEVENLABS_MODEL || DEFAULT_MODEL;

  const form = new FormData();
  form.append('model_id', model);
  form.append(
    'file',
    new Blob([buffer]),
    opts.filename || 'interview.m4a'
  );
  form.append('diarize', 'true');
  form.append('timestamps_granularity', 'word');
  if (opts.numSpeakers) form.append('num_speakers', String(opts.numSpeakers));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const wrapped = new Error(
      err.name === 'AbortError'
        ? 'Transcription timed out — the recording may be too long.'
        : `Transcription request failed: ${err.message}`
    );
    wrapped.code = 'TRANSCRIBE_FAILED';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Transcription failed (${res.status}): ${body.slice(0, 300)}`);
    err.code = 'TRANSCRIBE_FAILED';
    throw err;
  }

  const json = await res.json();
  const words = normalizeWords(json.words);
  if (words.length === 0) {
    const err = new Error(
      'The recording produced no words — it may be silent or corrupt.'
    );
    err.code = 'EMPTY_TRANSCRIPT';
    throw err;
  }
  const turns = toTurns(words);
  return {
    words,
    turns,
    transcript: renderTranscript(turns),
    model,
    durationMs: words[words.length - 1].endMs || words[words.length - 1].startMs,
    // How many distinct voices the model actually separated. A two-party
    // interview that comes back with one speaker means diarization
    // failed, and every attribution downstream is then suspect.
    speakerCount: new Set(words.map((w) => w.speaker).filter(Boolean)).size,
  };
}
