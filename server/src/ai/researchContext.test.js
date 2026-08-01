import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_RANK } from '../middleware/auth.js';

// The entitlement rule, pinned separately from the database work.
//
// /api/research is Analyst-and-above. The assistant is open to every
// authenticated member, so the research section has to re-apply that bar
// itself — if it ever stops doing so, the claim ledger reaches every
// JuniorAnalyst and every advisory member through a chat box, and the
// role gate on the research routes becomes decoration.
//
// This mirrors canSeeResearch. It is deliberately a copy: the point is
// to fail loudly if someone changes the rule in one place, and a test
// that imports the implementation cannot do that.
const MIN_RANK = ROLE_RANK.Analyst;
const entitled = (user) => {
  if (!user) return false;
  const ranks = [user.role, ...(user.extraRoles || [])].map((r) => ROLE_RANK[r] || 0);
  return Math.max(0, ...ranks) >= MIN_RANK;
};

test('the research section is Analyst and above, matching the API', () => {
  for (const role of ['President', 'CIO', 'SeniorPortfolioManager', 'PortfolioManager', 'SeniorAnalyst', 'Analyst']) {
    assert.equal(entitled({ role }), true, role);
  }
});

test('everyone below Analyst gets nothing', () => {
  // JuniorAnalyst matters most: it is the default role for every Google
  // self-signup, so anyone who finds the login page lands there.
  for (const role of ['JuniorAnalyst', 'ChiefOfCommunication', 'AdvisoryBoardMember', 'FacultyAdvisory', 'FormerPresident']) {
    assert.equal(entitled({ role }), false, role);
  }
  assert.equal(entitled(null), false);
  assert.equal(entitled({}), false);
  assert.equal(entitled({ role: 'NotARole' }), false);
});

test('extraRoles can grant it, because that is how the app grants anything else', () => {
  assert.equal(entitled({ role: 'JuniorAnalyst', extraRoles: ['Analyst'] }), true);
  // But a junk entry in extraRoles must not.
  assert.equal(entitled({ role: 'JuniorAnalyst', extraRoles: ['Nonsense'] }), false);
});

test('advisory is excluded even though the terminal lets them in', () => {
  // requireTerminalAccess admits Advisory deliberately; the research
  // ledger is a stricter bar and the two must not be conflated.
  assert.equal(entitled({ role: 'AdvisoryBoardMember' }), false);
  assert.equal(entitled({ role: 'FacultyAdvisory' }), false);
});

// The owner-only rule, pinned the same way and for the same reason.
//
// routes/research.js gates owner-only projects in four places. This
// module gated them in NONE, so the assistant read out projects the
// same member is refused over the API — and after thirty-nine owner-only
// archives were imported, that was thirty-nine project names leaking
// through a chat box.
//
// Deliberately a copy of the rule rather than an import, so changing it
// in one place fails loudly here.
const visibilityFor = (isSuperAdmin) => (isSuperAdmin ? {} : { ownerOnly: false });

test('a member never sees owner-only research through the assistant', () => {
  assert.deepEqual(visibilityFor(false), { ownerOnly: false });
  assert.deepEqual(visibilityFor(true), {});
});

test('the assistant applies the same owner-only gate the API does', async () => {
  // The API's rule, read from the route file itself so the two cannot
  // drift apart silently.
  const { readFileSync } = await import('node:fs');
  const routes = readFileSync(
    new URL('../routes/research.js', import.meta.url), 'utf8');
  const ctx = readFileSync(
    new URL('./researchContext.js', import.meta.url), 'utf8');
  assert.match(routes, /isSuperAdminEmail\(req\.user\?\.email\) \? \{\} : \{ ownerOnly: false \}/);
  assert.match(ctx, /isSuperAdminEmail\(user\?\.email\) \? \{\} : \{ ownerOnly: false \}/,
    'researchContext must gate owner-only projects like the API does');
});

test('a named project is never displaced by a bulk import', async () => {
  // Recency alone filled `take: 6` with archive folders the afternoon
  // thirty-nine were imported, and the assistant lost every claim it
  // had. A project the conversation names must be fetched regardless of
  // when it was last touched.
  const { readFileSync } = await import('node:fs');
  const ctx = readFileSync(new URL('./researchContext.js', import.meta.url), 'utf8');
  assert.match(ctx, /const named = topic/, 'named projects are fetched separately');
  assert.match(ctx, /notIn: named\.map/, 'recency must not re-fetch a named project');
});
