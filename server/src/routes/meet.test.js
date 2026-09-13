import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JITSI_JWT_APP_SECRET = 'test-secret-'.padEnd(40, 'x');
process.env.MEET_BASE_URL = 'https://meet.thegriffinfund.org';

const { mintJitsiToken, verifyJitsiToken, meetingUrl } =
  await import('../services/jitsiToken.js');
const {
  slugify, buildCode, isModerator,
  createMeetingHandler, meetingTokenHandler, emailMeetingHandler,
  listMeetingsHandler, endMeetingHandler,
} = await import('./meet.js');

function res() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const MEMBER = { id: 7, name: 'Junior Analyst', email: 'ja@example.com', role: 'JuniorAnalyst', extraRoles: [] };
const OFFICER = { id: 2, name: 'President', email: 'p@example.com', role: 'President', extraRoles: [] };

// --- token ---------------------------------------------------------------

test('token is scoped to one room, never a wildcard', () => {
  const t = mintJitsiToken({ room: 'pitch-review-abc123', user: MEMBER });
  const d = verifyJitsiToken(t);
  assert.equal(d.room, 'pitch-review-abc123');
  assert.notEqual(d.room, '*');
});

test('moderator is the STRING true, because Prosody ignores a real boolean', () => {
  const d = verifyJitsiToken(mintJitsiToken({ room: 'r', user: OFFICER, moderator: true }));
  assert.equal(d.context.user.moderator, 'true');
  assert.equal(typeof d.context.user.moderator, 'string');
  const p = verifyJitsiToken(mintJitsiToken({ room: 'r', user: MEMBER, moderator: false }));
  assert.equal(p.context.user.moderator, 'false');
});

test('nbf is backdated so a fast client clock is not refused', () => {
  // Uses the real clock on purpose: a fixed past timestamp mints a token
  // that is already expired, and verify() then fails for the wrong reason.
  const now = Date.now();
  const d = verifyJitsiToken(mintJitsiToken({ room: 'r', user: MEMBER, now }));
  assert.ok(d.nbf < d.iat, 'nbf must precede issue time');
  assert.ok(d.iat - d.nbf >= 30, 'and by enough to absorb a skewed client clock');
});

test('minting without the shared secret throws rather than signing with nothing', () => {
  const saved = process.env.JITSI_JWT_APP_SECRET;
  delete process.env.JITSI_JWT_APP_SECRET;
  assert.throws(() => mintJitsiToken({ room: 'r', user: MEMBER }), /JITSI_JWT_APP_SECRET/);
  process.env.JITSI_JWT_APP_SECRET = saved;
});

test('the shareable url carries no token', () => {
  const u = meetingUrl({ code: 'q3-review-abc123', title: 'Q3 Review' });
  assert.ok(!u.includes('jwt='), 'a link meant for forwarding must not embed a token');
  assert.ok(u.includes('config.subject'), 'the title rides in the hash so Jitsi shows it, not the code');
});

test('a member with a token walks straight in; a guest still gets asked who they are', () => {
  const member = meetingUrl({ code: 'c', token: 'TOK', title: 'T' });
  assert.match(member, /config\.prejoinConfig\.enabled=false/,
    'the token already carries their name, so do not ask for it again');

  const guest = meetingUrl({ code: 'c', title: 'T' });
  assert.ok(!guest.includes('prejoinConfig'),
    'a forwarded link has no token and no name, so the prejoin screen must stay');
  assert.ok(!guest.includes('requireDisplayName=false'),
    'a guest walking into a meeting nameless is exactly what that screen prevents');
});

// --- codes ---------------------------------------------------------------

test('slug is readable and the suffix is what makes it unguessable', () => {
  assert.equal(slugify('Q3 Pitch Review!'), 'q3-pitch-review');
  const code = buildCode('Q3 Pitch Review', () => 0.5);
  assert.match(code, /^q3-pitch-review-[a-z2-9]{6}$/);
});

test('codes avoid characters that are misread aloud', () => {
  const code = buildCode('x', () => 0.999999);
  assert.ok(!/[01lIoO]/.test(code.split('-').pop()), 'no 0/O/1/l/I in the random part');
});

test('a title that slugs to nothing still produces a usable code', () => {
  assert.match(buildCode('!!!', () => 0.1), /^meeting-[a-z2-9]{6}$/);
});

// --- who may moderate ----------------------------------------------------

test('the organiser moderates their own meeting', () => {
  assert.equal(isModerator(MEMBER, { createdById: 7 }), true);
});

test('an officer moderates any meeting, an ordinary member moderates none', () => {
  assert.equal(isModerator(OFFICER, { createdById: 99 }), true);
  assert.equal(isModerator(MEMBER, { createdById: 99 }), false);
});

// --- the security property ----------------------------------------------

test('a room code we never issued gets no token', async () => {
  const db = { meeting: { findUnique: async () => null } };
  const r = res();
  await meetingTokenHandler({ params: { code: 'SomeRoomAStrangerTyped' }, user: MEMBER }, r, { db });
  assert.equal(r.statusCode, 404);
  assert.ok(!r.body.joinUrl, 'no token may be issued for an unknown room');
});

test('a cancelled or ended meeting issues no token', async () => {
  for (const field of ['cancelledAt', 'endedAt']) {
    const db = { meeting: { findUnique: async () => ({ code: 'c', title: 't', createdById: 7, [field]: new Date() }) } };
    const r = res();
    await meetingTokenHandler({ params: { code: 'c' }, user: MEMBER }, r, { db });
    assert.equal(r.statusCode, 410, `${field} must close the room`);
  }
});

test('a live meeting issues a token scoped to that room', async () => {
  const db = { meeting: { findUnique: async () => ({ code: 'q3-review-abc123', title: 'Q3', createdById: 7, cancelledAt: null, endedAt: null }) } };
  const r = res();
  await meetingTokenHandler({ params: { code: 'q3-review-abc123' }, user: MEMBER }, r, { db });
  assert.equal(r.statusCode, 200);
  const jwtValue = new URL(r.body.joinUrl.split('#')[0]).searchParams.get('jwt');
  assert.equal(verifyJitsiToken(jwtValue).room, 'q3-review-abc123');
});

// --- creation ------------------------------------------------------------

test('a meeting needs a title', async () => {
  const r = res();
  await createMeetingHandler({ body: {}, user: MEMBER }, r, { db: {} });
  assert.equal(r.statusCode, 400);
});

test('an unparseable start time is refused rather than silently dropped', async () => {
  const r = res();
  await createMeetingHandler({ body: { title: 'x', startsAt: 'next tuesday' }, user: MEMBER }, r, { db: {} });
  assert.equal(r.statusCode, 400);
});

test('a code collision retries instead of surfacing as a 500', async () => {
  let calls = 0;
  const db = {
    meeting: {
      create: async ({ data }) => {
        calls += 1;
        if (calls === 1) { const e = new Error('dup'); e.code = 'P2002'; throw e; }
        return { ...data, id: 1, createdAt: new Date(), createdBy: { id: 7, name: 'x' } };
      },
    },
  };
  const r = res();
  await createMeetingHandler({ body: { title: 'Q3 Review' }, user: MEMBER }, r, { db });
  assert.equal(calls, 2);
  assert.equal(r.statusCode, 201);
});

// --- email ---------------------------------------------------------------

test('the link is mailed to the caller, never to an address in the request', async () => {
  const db = { meeting: { findUnique: async () => ({ code: 'c', title: 't', startsAt: null, durationMinutes: 60, createdBy: { id: 7, name: 'x' } }) } };
  let sentTo = null;
  const r = res();
  await emailMeetingHandler(
    { params: { code: 'c' }, user: MEMBER, body: { to: 'attacker@elsewhere.com' } },
    r,
    { db, send: async (to) => { sentTo = to; } },
  );
  assert.equal(sentTo, 'ja@example.com');
  assert.notEqual(sentTo, 'attacker@elsewhere.com');
});

// --- listing -------------------------------------------------------------

test('a meeting that started twenty minutes ago is still listed', async () => {
  let where = null;
  const now = new Date('2026-09-13T18:00:00Z');
  const db = { meeting: { findMany: async (args) => { where = args.where; return []; } } };
  await listMeetingsHandler({}, res(), { db, now });
  const since = where.OR[1].startsAt.gte;
  assert.ok(since < now, 'the window must reach back before now');
  assert.ok(new Date('2026-09-13T17:40:00Z') > since, 'a meeting 20 minutes old must fall inside it');
});

test('only the organiser or an officer may end a meeting', async () => {
  const db = { meeting: { findUnique: async () => ({ code: 'c', createdById: 99 }), update: async () => ({ code: 'c', createdById: 99, createdBy: { id: 99, name: 'y' } }) } };
  const r = res();
  await endMeetingHandler({ params: { code: 'c' }, method: 'POST', user: MEMBER }, r, { db });
  assert.equal(r.statusCode, 403);
});
