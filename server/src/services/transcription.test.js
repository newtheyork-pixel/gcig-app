import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, toTurns, renderTranscript, formatStamp } from './transcription.js';

// Scribe's raw output carries spacing tokens and audio events alongside
// real words. Everything downstream indexes into this array by position,
// so what we keep and how we timestamp it has to be exact.

test('drops spacing tokens but keeps real words', () => {
  const out = normalizeWords([
    { text: 'We', start: 1, end: 1.4, type: 'word', speaker_id: 'speaker_1' },
    { text: ' ', start: 1.4, end: 1.5, type: 'spacing' },
    { text: 'cut', start: 1.5, end: 1.9, type: 'word', speaker_id: 'speaker_1' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((w) => w.text), ['We', 'cut']);
});

test('converts float seconds to integer milliseconds', () => {
  const [w] = normalizeWords([{ text: 'x', start: 1.2345, end: 2.5, type: 'word' }]);
  assert.equal(w.startMs, 1235, 'rounds rather than truncating');
  assert.equal(w.endMs, 2500);
  assert.ok(Number.isInteger(w.startMs), 'offsets are integers, not floats');
});

test('a missing speaker label stays null and is never guessed', () => {
  const [w] = normalizeWords([{ text: 'x', start: 0, end: 1, type: 'word' }]);
  assert.equal(w.speaker, null);
});

test('audio events are kept but marked so they cannot be quoted as speech', () => {
  const out = normalizeWords([
    { text: '(laughter)', start: 0, end: 1, type: 'audio_event', speaker_id: 'speaker_1' },
  ]);
  assert.equal(out[0].type, 'audio_event');
});

test('words with no usable start are dropped', () => {
  const out = normalizeWords([
    { text: 'ok', start: null, end: 1, type: 'word' },
    { text: 'good', start: 2, end: 3, type: 'word' },
  ]);
  assert.deepEqual(out.map((w) => w.text), ['good']);
});

test('malformed input yields an empty stream rather than throwing', () => {
  for (const junk of [null, undefined, 'nope', {}, [null, {}, { text: '  ' }]]) {
    assert.deepEqual(normalizeWords(junk), []);
  }
});

test('groups consecutive words into speaker turns', () => {
  const turns = toTurns([
    { text: 'So', startMs: 0, endMs: 400, speaker: 'speaker_0' },
    { text: 'what?', startMs: 500, endMs: 900, speaker: 'speaker_0' },
    { text: 'We', startMs: 2000, endMs: 2400, speaker: 'speaker_1' },
    { text: 'cut.', startMs: 2500, endMs: 2900, speaker: 'speaker_1' },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'So what?');
  assert.equal(turns[1].speaker, 'speaker_1');
  assert.equal(turns[1].startMs, 2000);
  assert.equal(turns[1].endMs, 2900);
});

test('a speaker returning later starts a new turn', () => {
  const turns = toTurns([
    { text: 'a', startMs: 0, endMs: 1, speaker: 'speaker_0' },
    { text: 'b', startMs: 2, endMs: 3, speaker: 'speaker_1' },
    { text: 'c', startMs: 4, endMs: 5, speaker: 'speaker_0' },
  ]);
  assert.equal(turns.length, 3, 'turns are contiguous runs, not per-speaker buckets');
});

test('timestamps format as mm:ss and roll into hours', () => {
  assert.equal(formatStamp(0), '00:00');
  assert.equal(formatStamp(62_000), '01:02');
  assert.equal(formatStamp(3_723_000), '1:02:03');
});

test('the reading copy carries a stamp and a speaker on every turn', () => {
  const text = renderTranscript([
    { speaker: 'speaker_1', startMs: 62_000, endMs: 63_000, text: 'We cut the rebate.' },
    { speaker: null, startMs: 70_000, endMs: 71_000, text: 'Inaudible bit.' },
  ]);
  assert.match(text, /\[01:02\] Speaker 1: We cut the rebate\./);
  assert.match(text, /\[01:10\] Unknown: Inaudible bit\./);
});

// Importing a transcript we already have. The risk is manufactured
// precision: these timestamps are per turn, and interpolating a word's
// position inside its turn would produce a citation that looks exact and
// is a guess.
import { parseTranscriptText } from './transcription.js';

const SAMPLE = `TRANSCRIPT -- CVS Store 3, Harlem
scribe_v2 diarized. dur ~216s
======================================================================
[00:00] speaker_0: Premium chocolate like Lindt, how does it sell?
[00:12] speaker_1: I would say the Hershey's sells more because they are cheaper.
[00:25] speaker_0: Way cheaper, yeah.`;

test('parses timestamped turns and skips the header', () => {
  const r = parseTranscriptText(SAMPLE);
  assert.equal(r.turns.length, 3);
  assert.equal(r.turns[0].startMs, 0);
  assert.equal(r.turns[1].startMs, 12_000);
  assert.equal(r.turns[1].speaker, 'speaker_1');
});

test('a turn ends where the next one begins', () => {
  const r = parseTranscriptText(SAMPLE);
  assert.equal(r.turns[0].endMs, 12_000);
  assert.equal(r.turns[1].endMs, 25_000);
});

test('every word carries its turn bounds, never an interpolated guess', () => {
  const r = parseTranscriptText(SAMPLE);
  const inTurn2 = r.words.filter((w) => w.startMs === 12_000);
  assert.ok(inTurn2.length > 3);
  // Each word of a turn shares one start. A rising per-word offset here
  // would mean we invented precision the source never had.
  assert.equal(new Set(inTurn2.map((w) => w.startMs)).size, 1);
  assert.equal(r.precision, 'turn');
});

test('supports H:MM:SS for long calls', () => {
  const r = parseTranscriptText('[1:02:03] speaker_0: Still going.');
  assert.equal(r.turns[0].startMs, 3_723_000);
});

test('the imported stream works with locateQuote', async () => {
  const { locateQuote } = await import('./claimExtraction.js');
  const r = parseTranscriptText(SAMPLE);
  const hit = locateQuote(r.words, "the Hershey's sells more because they are cheaper");
  assert.ok(hit, 'a real quote must locate');
  assert.equal(hit.startMs, 12_000);
  assert.equal(hit.speaker, 'speaker_1');
  // And a paraphrase must still fail, exactly as with live transcription.
  assert.equal(locateQuote(r.words, 'Hershey outsells Lindt on price'), null);
});

test('a file with no timestamped lines is refused, not silently empty', () => {
  assert.throws(() => parseTranscriptText('Just some notes.\nNo timestamps here.'), /No timestamped lines/);
  assert.throws(() => parseTranscriptText(''), /No timestamped lines/);
});

test('speaker counting reflects the real number of voices', () => {
  assert.equal(parseTranscriptText(SAMPLE).speakerCount, 2);
  assert.equal(parseTranscriptText('[00:01] speaker_0: alone').speakerCount, 1);
});
