import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  isSuperAdminEmail,
  ROLE_RANK,
  requireRole,
  requireExecutive,
  requireAdmin,
  requirePresidentOrSuperAdmin,
  issueJwt,
  verifySessionToken,
} from './auth.js';
import { signChallenge } from '../routes/twoFactor.js';

// Minimal Express test doubles, matching the dependency-injection /
// fake-req-res precedent in routes/terminal.execbios.test.js. No DB,
// no network.
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}
function runGate(gate, user) {
  const res = fakeRes();
  let nextCalled = false;
  gate({ user }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

const ORIGINAL = process.env.SUPER_ADMIN_EMAIL;

beforeEach(() => {
  delete process.env.SUPER_ADMIN_EMAIL;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SUPER_ADMIN_EMAIL;
  else process.env.SUPER_ADMIN_EMAIL = ORIGINAL;
});

test('returns false for any email when SUPER_ADMIN_EMAIL is unset', () => {
  assert.equal(isSuperAdminEmail('anyone@example.com'), false);
  assert.equal(isSuperAdminEmail('solinick@gcschool.org'), false);
});

test('returns false for empty/nullish input', () => {
  assert.equal(isSuperAdminEmail(''), false);
  assert.equal(isSuperAdminEmail(null), false);
  assert.equal(isSuperAdminEmail(undefined), false);
});

test('returns true only for emails listed in SUPER_ADMIN_EMAIL', () => {
  process.env.SUPER_ADMIN_EMAIL = 'owner@gcschool.org';
  assert.equal(isSuperAdminEmail('owner@gcschool.org'), true);
  assert.equal(isSuperAdminEmail('someone-else@gcschool.org'), false);
});

test('comma-separated list is honored, case- and whitespace-insensitive', () => {
  process.env.SUPER_ADMIN_EMAIL = 'a@example.com, B@Example.com ,c@example.com';
  assert.equal(isSuperAdminEmail('a@example.com'), true);
  assert.equal(isSuperAdminEmail('  B@example.com  '), true);
  assert.equal(isSuperAdminEmail('C@EXAMPLE.COM'), true);
  assert.equal(isSuperAdminEmail('d@example.com'), false);
});

// ─── FormerPresident is a no-power honorific ───────────────────────────
// A former president's *primary* role is JuniorAnalyst; FormerPresident
// only ever appears as an extraRoles badge. As defense in depth, the
// FormerPresident role itself is ranked 0 so it confers nothing even if
// it were ever mis-set as a primary role.

test('ROLE_RANK ranks FormerPresident at 0 (below every operational role)', () => {
  assert.equal(ROLE_RANK.FormerPresident, 0);
  assert.ok(ROLE_RANK.FormerPresident < ROLE_RANK.JuniorAnalyst);
  assert.ok(ROLE_RANK.FormerPresident < ROLE_RANK.AdvisoryBoardMember);
});

test('requireRole denies a FormerPresident the JuniorAnalyst tier', () => {
  const gate = requireRole('JuniorAnalyst');
  const { res, nextCalled } = runGate(gate, { role: 'FormerPresident' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireExecutive denies a FormerPresident', () => {
  const { res, nextCalled } = runGate(requireExecutive, {
    role: 'FormerPresident',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireAdmin denies a FormerPresident', () => {
  const { res, nextCalled } = runGate(requireAdmin, {
    role: 'FormerPresident',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

// ─── requirePresidentOrSuperAdmin (step-down gate) ─────────────────────
// A sitting President OR the owner/super-admin may perform the
// presidential step-down. The owner must not need the President role.

test('requirePresidentOrSuperAdmin allows a sitting President', () => {
  const { nextCalled } = runGate(requirePresidentOrSuperAdmin, {
    role: 'President',
  });
  assert.equal(nextCalled, true);
});

test('requirePresidentOrSuperAdmin allows the owner/super-admin regardless of role', () => {
  const { nextCalled } = runGate(requirePresidentOrSuperAdmin, {
    role: 'JuniorAnalyst',
    isSuperAdmin: true,
  });
  assert.equal(nextCalled, true);
});

test('requirePresidentOrSuperAdmin denies a non-President, non-owner', () => {
  const { res, nextCalled } = runGate(requirePresidentOrSuperAdmin, {
    role: 'Analyst',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requirePresidentOrSuperAdmin denies when unauthenticated', () => {
  const { res, nextCalled } = runGate(requirePresidentOrSuperAdmin, undefined);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

// A role that outranks another but cannot do what that other one does is an
// org chart the gates disagree with. Director of Research sits above CIO, so
// both halves have to be true at once, and the second is the one a future
// edit would quietly drop.
test('DirectorOfResearch outranks CIO and sits below President', () => {
  assert.ok(ROLE_RANK.DirectorOfResearch > ROLE_RANK.CIO);
  assert.ok(ROLE_RANK.DirectorOfResearch < ROLE_RANK.President);
  assert.ok(ROLE_RANK.DirectorOfResearch > ROLE_RANK.SeniorPortfolioManager);
});

test('requireExecutive admits a DirectorOfResearch', () => {
  let passed = false;
  requireExecutive(
    { user: { role: 'DirectorOfResearch' } },
    { status: () => ({ json: () => {} }) },
    () => { passed = true; },
  );
  assert.equal(passed, true);
});

// Director of Public Relations is an officer title, and the other
// director in this enum is an investment executive. Sharing that rank
// would let a PR office send trade confirmations. The analog is Chief
// of Communication: same non-investment rank, outside the executive
// set, below the analyst chain.
test('DirectorOfPublicRelations shares the non-trading officer rank', () => {
  assert.equal(ROLE_RANK.DirectorOfPublicRelations, ROLE_RANK.ChiefOfCommunication);
  assert.equal(ROLE_RANK.DirectorOfPublicRelations, 2);
  assert.ok(ROLE_RANK.DirectorOfPublicRelations < ROLE_RANK.JuniorAnalyst);
});

test('requireExecutive denies a Director of Public Relations', () => {
  const { res, nextCalled } = runGate(requireExecutive, {
    role: 'DirectorOfPublicRelations',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireRole denies a Director of Public Relations the JuniorAnalyst tier', () => {
  const gate = requireRole('JuniorAnalyst');
  const { res, nextCalled } = runGate(gate, { role: 'DirectorOfPublicRelations' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

// ── What counts as a session ─────────────────────────────────────────

function withSecret(fn) {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-session-secret';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prev;
  }
}

test('verifySessionToken accepts what issueJwt mints', () => {
  withSecret(() => {
    const token = issueJwt({ id: 7, role: 'Analyst', tokenVersion: 3 });
    const payload = verifySessionToken(token);
    assert.equal(payload.id, 7);
    assert.equal(payload.v, 3);
  });
});

test('verifySessionToken refuses the 2FA challenge a correct password earns', () => {
  // The challenge is signed with the same secret and handed out before
  // the second factor is checked. Accepting it as a session let a
  // password alone skip 2FA.
  withSecret(() => {
    const challenge = signChallenge(7);
    assert.ok(jwt.verify(challenge, process.env.JWT_SECRET), 'challenge is validly signed');
    assert.throws(() => verifySessionToken(challenge));
  });
});

test('verifySessionToken refuses any token minted for a purpose, or without a version', () => {
  withSecret(() => {
    const secret = process.env.JWT_SECRET;
    assert.throws(() => verifySessionToken(jwt.sign({ id: 7, v: 0, purpose: 'anything' }, secret)));
    assert.throws(() => verifySessionToken(jwt.sign({ id: 7 }, secret)));
    assert.throws(() => verifySessionToken(jwt.sign({ id: '7', v: 0 }, secret)));
  });
});

test('verifySessionToken refuses a forged or expired session', () => {
  withSecret(() => {
    const forged = jwt.sign({ id: 7, role: 'President', v: 0 }, 'some-other-secret');
    assert.throws(() => verifySessionToken(forged));
    const expired = jwt.sign(
      { id: 7, role: 'Analyst', v: 0, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET
    );
    assert.throws(() => verifySessionToken(expired));
  });
});
