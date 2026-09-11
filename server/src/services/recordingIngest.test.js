import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestRecording } from './recordingIngest.js';

// What these guard: the order of the chain. Consent has to stop the
// audio before it is stored, the screen has to run before the row is
// readable, and a store call must not quietly leave its tape behind.

const WORDS = [
  { text: 'the', startMs: 0, endMs: 200, speaker: 'speaker_0' },
  { text: 'price', startMs: 200, endMs: 900, speaker: 'speaker_1' },
];

function stub({ interview = {}, screen = {}, uploadThrows = false } = {}) {
  const calls = { uploaded: 0, transcribed: 0, screened: 0, updates: [] };
  const row = {
    id: 7,
    sourceId: 3,
    consentObtained: true,
    recordingRef: null,
    ...interview,
  };
  const deps = {
    prisma: {
      interview: {
        findUnique: async () => row,
        update: async ({ data }) => {
          calls.updates.push(data);
          return { id: row.id, status: data.status, durationMs: data.durationMs,
                   transcriptModel: data.transcriptModel, mnpiRisk: data.mnpiRisk,
                   quarantined: data.quarantined };
        },
      },
      researchSource: { findUnique: async () => ({ relationship: 'CurrentEmployee' }) },
    },
    transcribe: async () => {
      calls.transcribed += 1;
      return {
        words: WORDS, turns: [], transcript: 'the price',
        model: 'scribe_v2', durationMs: 900, speakerCount: 2,
      };
    },
    screenTranscript: async () => {
      calls.screened += 1;
      return { risk: 'low', reason: 'nothing found', hits: [], modelAvailable: true, ...screen };
    },
    uploadFile: async () => {
      calls.uploaded += 1;
      if (uploadThrows) throw new Error('OneDrive said no');
      return { id: 'ITEM123' };
    },
  };
  return { deps, calls };
}

const args = (over = {}) => ({
  interviewId: 7, buffer: Buffer.from('audio'), filename: 'call.m4a', userId: 1, ...over,
});

test('no consent means the audio is never stored and never sent anywhere', async () => {
  const { deps, calls } = stub({ interview: { consentObtained: false } });
  await assert.rejects(() => ingestRecording(args(), deps), (err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /Consent is not recorded/);
    return true;
  });
  assert.equal(calls.uploaded, 0, 'consent check must precede storage');
  assert.equal(calls.transcribed, 0, 'and precede sending audio to a vendor');
});

test('a store call keeps the transcript and not the tape', async () => {
  const { deps, calls } = stub();
  const out = await ingestRecording(args({ retainAudio: false }), deps);
  assert.equal(calls.uploaded, 0, 'nothing uploaded');
  assert.equal(out.audioRetained, false);
  assert.equal(calls.updates[0].recordingRef, null, 'no pointer left behind');
  assert.equal(out.status, 'Transcribed');
  assert.equal(calls.updates[0].transcript, 'the price');
});

test('a scheduled interview keeps its tape', async () => {
  const { deps, calls } = stub();
  const out = await ingestRecording(args({ retainAudio: true }), deps);
  assert.equal(calls.uploaded, 1);
  assert.equal(out.audioRetained, true);
  assert.equal(calls.updates[0].recordingRef, 'onedrive:ITEM123');
});

test('storage failing does not cost us the transcript', async () => {
  const { deps, calls } = stub({ uploadThrows: true });
  const out = await ingestRecording(args({ retainAudio: true }), deps);
  assert.equal(out.status, 'Transcribed');
  assert.equal(out.audioRetained, false, 'and it says the audio is not there');
  assert.equal(calls.transcribed, 1);
});

test('prohibited quarantines on the way in, not on the way out', async () => {
  const { deps, calls } = stub({ screen: { risk: 'prohibited', reason: 'unreleased comps' } });
  const out = await ingestRecording(args(), deps);
  assert.equal(out.quarantined, true);
  assert.equal(out.status, 'Quarantined');
  assert.match(calls.updates[0].quarantineNote, /unreleased comps/);
});

test('the screen always runs, and its result is stored as the audit trail', async () => {
  const { deps, calls } = stub();
  const out = await ingestRecording(args(), deps);
  assert.equal(calls.screened, 1);
  assert.equal(calls.updates[0].screenResult.risk, 'low');
  assert.equal(out.screen.modelAvailable, true);
});

test('one separated voice is reported, not buried', async () => {
  const { deps } = stub();
  deps.transcribe = async () => ({
    words: WORDS, turns: [], transcript: 'the price',
    model: 'scribe_v2', durationMs: 900, speakerCount: 1,
  });
  const out = await ingestRecording(args(), deps);
  assert.match(out.diarizationWarning, /Only one speaker/);
});

test('a missing interview is a 404, not a crash', async () => {
  const { deps } = stub();
  deps.prisma.interview.findUnique = async () => null;
  await assert.rejects(() => ingestRecording(args(), deps), (e) => e.status === 404);
});
