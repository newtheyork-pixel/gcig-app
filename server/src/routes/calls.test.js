import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callQueueHandler,
  openCallHandler,
  updateCallHandler,
  callRecordingHandler,
} from './calls.js';

// Driven directly with a Prisma double, the way every other route suite
// in here works: no HTTP harness, no database.
//
// What these hold down is the honesty of the log. A store check is only
// worth anything if the denominator survives, if a door counts as its
// own source, and if audio never reaches a vendor without a disclosure
// somebody actually said out loud.

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const analyst = { id: 5, email: 'analyst@gracechurch.org' };
const req = (over = {}) => ({ params: {}, body: {}, user: analyst, ...over });

const PROJECT = { id: 45, title: 'Signet field work', ticker: 'SIG', ownerOnly: false };

// Overrides are DATA, never replacement model objects. Handing in a bare
// `{ researchTarget: { findMany } }` drops every other method the handler
// calls, and the suite then fails for a reason that has nothing to do
// with the behaviour under test — which is how the first version of this
// file quietly watched the wrong recorder.
function fakeDb({ callRow = null, answeredRows = [], claimCount = 1,
                  targets = [], withoutPhone = 0, ...over } = {}) {
  const seen = { created: [], updated: [], deleted: [], sourceCreated: [] };
  const db = {
    seen,
    researchProject: { findFirst: async () => PROJECT },
    researchTarget: {
      findMany: async () => targets,
      findFirst: async () => null,
      count: async () => withoutPhone,
      update: async (a) => { seen.updated.push(['target', a]); return a.data; },
    },
    callAttempt: {
      findMany: async () => answeredRows,
      findUnique: async () => callRow,
      create: async (a) => { seen.created.push(a.data); return { id: 901, ...a.data }; },
      update: async (a) => { seen.updated.push(['call', a]); return { id: a.where.id, ...a.data }; },
      updateMany: async (a) => { seen.updated.push(['claim', a]); return { count: claimCount }; },
    },
    researchSource: {
      findFirst: async () => null,
      create: async (a) => { seen.sourceCreated.push(a.data); return { id: 77, ...a.data }; },
    },
    interview: {
      create: async (a) => ({ id: 4242, ...a.data }),
      delete: async (a) => { seen.deleted.push(a.where.id); return {}; },
    },
  };
  return Object.assign(db, over);
}

// ── the queue ────────────────────────────────────────────────────────

test('a number that will not parse stays in the queue, flagged', async () => {
  // Filtering it out would make the sample look complete. A door you
  // cannot ring is a gap, and a gap has to be visible as one.
  const db = fakeDb({
    targets: [
      { id: 1, name: 'Kay #1247 Easton', phone: '(614) 555-0134', priority: 1,
        _count: { callAttempts: 0 }, callAttempts: [] },
      { id: 2, name: 'Kay #9002 Polaris', phone: 'ask at mall office', priority: 1,
        _count: { callAttempts: 0 }, callAttempts: [] },
    ],
  });
  const res = fakeRes();
  await callQueueHandler(req({ params: { id: '45' } }), res, { db });

  assert.equal(res.body.targets.length, 2, 'both doors are listed');
  assert.equal(res.body.undialable, 1);
  assert.equal(res.body.targets[0].telUrl, 'tel:+16145550134');
  assert.equal(res.body.targets[0].dialable, true);
  assert.equal(res.body.targets[1].dialable, false);
  assert.equal(res.body.targets[1].telUrl, null);
});

test('doors with no number at all are counted, not silently dropped', async () => {
  // They are not listed, because on a project whose funnel is former
  // employees reached by email every one of them would be noise. But a
  // queue of one that quietly omitted twelve reads as a finished sample.
  const db = fakeDb({
    withoutPhone: 12,
    targets: [{ id: 1, name: 'Kay #1247', phone: '6145550134',
                _count: { callAttempts: 0 }, callAttempts: [] }],
  });
  const res = fakeRes();
  await callQueueHandler(req({ params: { id: '45' } }), res, { db });
  assert.equal(res.body.withoutPhone, 12);
  assert.equal(res.body.targets.length, 1);
});

test('the queue says which doors have already answered', async () => {
  const db = fakeDb({
    answeredRows: [{ targetId: 1 }],
    targets: [{
      id: 1, name: 'Kay #1247', phone: '6145550134',
      _count: { callAttempts: 2 },
      callAttempts: [
        { id: 3, outcome: 'NoAnswer', startedAt: '2026-09-10T14:00:00Z' },
        { id: 2, outcome: 'Answered', startedAt: '2026-09-09T14:00:00Z' },
      ],
    }],
  });
  const res = fakeRes();
  await callQueueHandler(req({ params: { id: '45' } }), res, { db });
  assert.equal(res.body.targets[0].everAnswered, true);
  assert.equal(res.body.targets[0].attemptCount, 2);
  assert.equal(res.body.targets[0].lastAttempt.outcome, 'NoAnswer');
});

test('a door rung five times does not report three, and an old Answered is not forgotten', async () => {
  // The display list is capped at three. Counting it, or scanning it for
  // an Answered, quietly turns a door that HAS been reached back into a
  // fresh one, and somebody rings a store that already talked.
  const db = fakeDb({
    answeredRows: [{ targetId: 1 }],
    targets: [{
      id: 1, name: 'Kay #1247', phone: '6145550134',
      _count: { callAttempts: 5 },
      callAttempts: [
        { id: 9, outcome: 'NoAnswer', startedAt: '2026-09-10T18:00:00Z' },
        { id: 8, outcome: 'NoAnswer', startedAt: '2026-09-10T16:00:00Z' },
        { id: 7, outcome: 'Busy', startedAt: '2026-09-10T14:00:00Z' },
      ],
    }],
  });
  const res = fakeRes();
  await callQueueHandler(req({ params: { id: '45' } }), res, { db });
  assert.equal(res.body.targets[0].attemptCount, 5, "the count is the database's, not the page's");
  assert.equal(res.body.targets[0].everAnswered, true, 'the Answered fell off the display list');
});

test('untried doors sort above ones already rung, inside the same priority', async () => {
  // The handler has promised this since it was written and only the
  // database half was implemented, so a refused door sorted alphabetically
  // above an untouched one and got rung again.
  const db = fakeDb({
    targets: [
      { id: 1, name: 'AAA Kay #0112', phone: '6145550111', priority: 1,
        _count: { callAttempts: 2 }, callAttempts: [{ id: 5, outcome: 'Refused' }] },
      { id: 2, name: 'ZZZ Zales #9400', phone: '6145550222', priority: 1,
        _count: { callAttempts: 0 }, callAttempts: [] },
      { id: 3, name: 'Higher priority', phone: '6145550333', priority: null,
        _count: { callAttempts: 0 }, callAttempts: [] },
    ],
  });
  const res = fakeRes();
  await callQueueHandler(req({ params: { id: '45' } }), res, { db });
  assert.deepEqual(res.body.targets.map((t) => t.id), [2, 1, 3],
                   'untried before tried, and an unranked door still sorts last');
});

test('a project the caller may not see is a 404, not an empty queue', async () => {
  const db = fakeDb({ researchProject: { findFirst: async () => null } });
  const res = fakeRes();
  await callQueueHandler(req({ params: { id: '45' } }), res, { db });
  assert.equal(res.statusCode, 404);
});

// ── opening a call ───────────────────────────────────────────────────

test('an unparseable number is refused and no row is written', async () => {
  // Writing the row anyway would put a call in the log that never rang.
  const db = fakeDb();
  const res = fakeRes();
  await openCallHandler(
    req({ params: { id: '45' }, body: { phone: '614-555-013' } }), res, { db });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Not a dialable number/);
  assert.equal(db.seen.created.length, 0);
});

test('the extension survives into what we record as dialled', async () => {
  const db = fakeDb();
  const res = fakeRes();
  await openCallHandler(
    req({ params: { id: '45' }, body: { phone: '(614) 555-0134 x231' } }), res, { db });
  assert.equal(res.statusCode, 201);
  assert.equal(db.seen.created[0].dialedNumber, '+16145550134;ext=231');
  assert.equal(res.body.telUrl, 'tel:+16145550134;ext=231');
  assert.equal(db.seen.created[0].ticker, 'SIG', 'ticker comes from the project');
});

test('a target from another project cannot be dialled through this one', async () => {
  const db = fakeDb();
  const res = fakeRes();
  await openCallHandler(
    req({ params: { id: '45' }, body: { targetId: 9 } }), res, { db });
  assert.equal(res.statusCode, 404);
  assert.equal(db.seen.created.length, 0);
});

// ── closing a call ───────────────────────────────────────────────────

const openCall = { id: 901, projectId: 45, targetId: 1, consentSpoken: false, interviewId: null };

test('an outcome we do not recognise is refused', async () => {
  const db = fakeDb({ callRow: openCall });
  const res = fakeRes();
  await updateCallHandler(
    req({ params: { id: '901' }, body: { outcome: 'DidntWork' } }), res, { db });
  assert.equal(res.statusCode, 400);
});

test('an unrecognised metadata source is refused, because the duration means nothing without it', async () => {
  const db = fakeDb();
  const res = fakeRes();
  await updateCallHandler(
    req({ params: { id: '901' }, body: { metadataSource: 'vibes' } }), res, { db });
  assert.equal(res.statusCode, 400);
});

test('a refusal is somebody picking up, and the row must say so', async () => {
  // `answered` asks whether a HUMAN answered, not whether the call was
  // useful. Filing a refusal as unanswered undercounts the connect rate
  // by exactly the rows this table exists to keep.
  for (const [outcome, expected] of [
    ['Answered', true],
    ['Refused', true],
    ['CallBackLater', true],
    ['NoAnswer', false],
    ['Busy', false],
    ['Failed', false],
  ]) {
    const db = fakeDb({ callRow: openCall });
    await updateCallHandler(req({ params: { id: '901' }, body: { outcome } }), fakeRes(), { db });
    const [, update] = db.seen.updated.find(([kind]) => kind === 'call');
    assert.equal(update.data.answered, expected, outcome);
  }
});

test('an outcome that does not settle it leaves the question open', async () => {
  // A machine picking up is not a person, and a wrong number could be
  // either. Null beats a guess on a column somebody will later count.
  for (const outcome of ['Voicemail', 'WrongNumber']) {
    const db = fakeDb({ callRow: openCall });
    await updateCallHandler(req({ params: { id: '901' }, body: { outcome } }), fakeRes(), { db });
    const [, update] = db.seen.updated.find(([kind]) => kind === 'call');
    assert.equal(update.data.answered, undefined, outcome);
  }
});

test('the funnel moves itself: answered contacts the door, refused declines it', async () => {
  for (const [outcome, status] of [
    ['Answered', 'Contacted'],
    ['Refused', 'Declined'],
    ['WrongNumber', 'Unreachable'],
  ]) {
    const db = fakeDb({ callRow: openCall });
    const res = fakeRes();
    await updateCallHandler(req({ params: { id: '901' }, body: { outcome } }), res, { db });
    const moved = db.seen.updated.find(([kind]) => kind === 'target');
    assert.ok(moved, `${outcome} should move the target`);
    assert.equal(moved[1].data.status, status);
  }
});

test('a ring-out does not move the door out of the queue', async () => {
  // NoAnswer is evidence about the hour you called, not about the store.
  const db = fakeDb({ callRow: openCall });
  const res = fakeRes();
  await updateCallHandler(req({ params: { id: '901' }, body: { outcome: 'NoAnswer' } }), res, { db });
  assert.equal(db.seen.updated.some(([kind]) => kind === 'target'), false);
});

// ── the recording ────────────────────────────────────────────────────

const recReq = (over = {}) => req({
  params: { id: '901' },
  file: { buffer: Buffer.from('audio'), originalname: 'call.m4a', mimetype: 'audio/mp4' },
  ...over,
});

function recDeps(callRow, over = {}, dbOver = {}) {
  const ingested = [];
  const db = fakeDb({ callRow, ...dbOver });
  return {
    ingested,
    deps: {
      db,
      configured: () => true,
      ingest: async (a) => { ingested.push(a); return { id: 4242, status: 'Transcribed' }; },
      ...over,
    },
  };
}

test('no disclosure logged means the audio is never sent and no interview appears', async () => {
  const { deps, ingested } = recDeps({ ...openCall, consentSpoken: false, target: { name: 'Kay #1247' } });
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /No consent is logged/);
  assert.equal(ingested.length, 0);
});

test('a second upload against one dial is refused', async () => {
  const { deps } = recDeps({ ...openCall, consentSpoken: true, interviewId: 4000, target: { name: 'Kay #1247' } });
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already has interview 4000/);
});

test('each door becomes its own source, so eight stores are not one line of evidence', async () => {
  // corroboration.js bounds independence by distinct employer. Filing
  // every Kay call under "Kay Jewelers" would return `clustered`.
  const { deps } = recDeps({
    ...openCall, consentSpoken: true,
    target: { id: 1, name: 'Kay #1247 Easton, Columbus OH' },
  });
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  const src = deps.db.seen.sourceCreated[0];
  assert.equal(src.employer, 'Kay #1247 Easton, Columbus OH', 'the door, not the banner');
  assert.equal(src.alias, 'Kay #1247 Easton, Columbus OH');
  assert.equal(src.relationship, 'CurrentEmployee', 'store staff are current employees');
  assert.deepEqual(src.tickers, ['SIG']);
});

test('a store call does not keep its tape', async () => {
  const { deps, ingested } = recDeps({
    ...openCall, consentSpoken: true, target: { id: 1, name: 'Kay #1247' },
  });
  await callRecordingHandler(recReq(), fakeRes(), deps);
  assert.equal(ingested[0].retainAudio, false);
});

test('a failed transcription leaves no ghost interview behind', async () => {
  const { deps } = recDeps(
    { ...openCall, consentSpoken: true, target: { id: 1, name: 'Kay #1247' } },
    { ingest: async () => { const e = new Error('nothing but silence'); e.code = 'EMPTY_TRANSCRIPT'; throw e; } }
  );
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(deps.db.seen.deleted, [4242], 'the empty interview is removed');
});

test('transcription being unconfigured is a 503, not a silent drop', async () => {
  const { deps } = recDeps({ ...openCall, consentSpoken: true, target: { name: 'Kay' } },
    { configured: () => false });
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  assert.equal(res.statusCode, 503);
});

test('a third-party counter is not filed as the issuer\'s own employee', async () => {
  const { deps } = recDeps({
    ...openCall, consentSpoken: true,
    target: { id: 1, name: 'Zales concession, Macy\'s Easton', relationship: 'Distributor' },
  });
  await callRecordingHandler(recReq(), fakeRes(), deps);
  assert.equal(deps.db.seen.sourceCreated[0].relationship, 'Distributor');
});

test('a door nobody classified lands on the stricter reading', async () => {
  // "Other" is not a decision, and a screen that can be softened by
  // leaving a field vague is not a screen.
  for (const relationship of ['Other', '', undefined, 'store']) {
    const { deps } = recDeps({
      ...openCall, consentSpoken: true,
      target: { id: 1, name: 'Kay #1247', relationship },
    });
    await callRecordingHandler(recReq(), fakeRes(), deps);
    assert.equal(deps.db.seen.sourceCreated[0].relationship, 'CurrentEmployee',
                 `relationship ${JSON.stringify(relationship)}`);
  }
});

// ── what happens to the tape ─────────────────────────────────────────

test('a one-party call keeps its recording', async () => {
  const { deps, ingested } = recDeps({
    ...openCall, consentSpoken: true, consentRegime: 'one-party',
    target: { id: 1, name: 'Kay #1247' },
  });
  await callRecordingHandler(recReq(), fakeRes(), deps);
  assert.equal(ingested[0].retainAudio, true);
});

test('an all-party call destroys it once the transcript exists', async () => {
  const { deps, ingested } = recDeps({
    ...openCall, consentSpoken: true, consentRegime: 'all-party',
    target: { id: 1, name: 'Kay #1247' },
  });
  await callRecordingHandler(recReq(), fakeRes(), deps);
  assert.equal(ingested[0].retainAudio, false);
});

test('a regime nobody established is not a licence to keep anything', async () => {
  for (const consentRegime of ['unknown', undefined, null, '', 'one party']) {
    const { deps, ingested } = recDeps({
      ...openCall, consentSpoken: true, consentRegime,
      target: { id: 1, name: 'Kay #1247' },
    });
    await callRecordingHandler(recReq(), fakeRes(), deps);
    assert.equal(ingested[0].retainAudio, false, `regime ${JSON.stringify(consentRegime)}`);
  }
});

test('the log records what happened to the tape, not what was intended', async () => {
  // Storage can fail after a one-party call. Saying the audio is there
  // when it is not is worse than saying nothing.
  const { deps } = recDeps(
    { ...openCall, consentSpoken: true, consentRegime: 'one-party', target: { id: 1, name: 'Kay' } },
    { ingest: async () => ({ id: 4242, status: 'Transcribed', audioRetained: false }) }
  );
  await callRecordingHandler(recReq(), fakeRes(), deps);
  const [, update] = deps.db.seen.updated.find(([kind]) => kind === 'call');
  assert.equal(update.data.audioRetained, false);
  const [, claim] = deps.db.seen.updated.find(([kind]) => kind === 'claim');
  assert.equal(claim.data.recorded, true);
  assert.equal(claim.where.interviewId, null, 'the claim is conditional on the column still being free');
});

test('a second upload racing the first is refused, and leaves no orphan interview', async () => {
  // Both requests pass the check-then-act guard. The loser must not keep
  // a fully transcribed Interview nobody can reach.
  const { deps } = recDeps(
    { ...openCall, consentSpoken: true, target: { id: 1, name: 'Kay #1247' } },
    {}, { claimCount: 0 }
  );
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(deps.db.seen.deleted, [4242], 'the interview it created is removed');
});

test('a failed transcription releases the claim so a retry is possible', async () => {
  const { deps } = recDeps(
    { ...openCall, consentSpoken: true, target: { id: 1, name: 'Kay #1247' } },
    { ingest: async () => { const e = new Error('nope'); e.code = 'EMPTY_TRANSCRIPT'; throw e; } }
  );
  await callRecordingHandler(recReq(), fakeRes(), deps);
  const release = deps.db.seen.updated.filter(([kind]) => kind === 'call')
    .map(([, a]) => a.data).find((d) => d.interviewId === null);
  assert.ok(release, 'the call is unclaimed again');
  assert.equal(release.recorded, false);
});

test('an unrecognised regime is refused at the door', async () => {
  const db = fakeDb({ callRow: openCall });
  const res = fakeRes();
  await updateCallHandler(
    req({ params: { id: '901' }, body: { consentRegime: 'sort of' } }), res, { db });
  assert.equal(res.statusCode, 400);
});

test('a one-party call does not need a disclosure to upload', async () => {
  const { deps, ingested } = recDeps({
    ...openCall, consentSpoken: false, consentRegime: 'one-party',
    target: { id: 1, name: 'Kay #1247' },
  });
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(ingested.length, 1);
});

test('an unknown regime still has to ask', async () => {
  // "Nobody decided" must not become the way round the disclosure.
  const { deps, ingested } = recDeps({
    ...openCall, consentSpoken: false, consentRegime: 'unknown',
    target: { id: 1, name: 'Kay #1247' },
  });
  const res = fakeRes();
  await callRecordingHandler(recReq(), res, deps);
  assert.equal(res.statusCode, 409);
  assert.equal(ingested.length, 0);
});
