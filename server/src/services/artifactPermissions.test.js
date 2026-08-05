import test from 'node:test';
import assert from 'node:assert/strict';

// Set BEFORE the import, because isSuperAdminEmail reads the env var at
// call time but the safe default is "unset means nobody", so a test that
// forgets this silently exercises the no-admin path and its super admin
// assertions fail for a reason that has nothing to do with the rules.
process.env.SUPER_ADMIN_EMAIL = 'newtheyork@gmail.com';

const { canTrash, canPurge, canUpload, capabilities } =
  await import('./artifactPermissions.js');

const analyst = { id: 1, role: 'Analyst', email: 'a@gcschool.org' };
const pm = { id: 2, role: 'PortfolioManager', email: 'p@gcschool.org' };
const junior = { id: 3, role: 'JuniorAnalyst', email: 'j@gcschool.org' };
const admin = { id: 4, role: 'Analyst', email: 'newtheyork@gmail.com' };
const mine = { id: 10, uploadedById: 1 };
const theirs = { id: 11, uploadedById: 99 };
const orphan = { id: 12, uploadedById: null };

test('you can remove what you contributed', () => {
  assert.equal(canTrash(analyst, mine).ok, true);
});

test('you cannot remove somebody else\'s, and are told who can', () => {
  // The whole point of the change: an Analyst could previously delete
  // all 205 documents on a project they had never opened, and after the
  // Finder volume started honouring a trash gesture that became a drag.
  const r = canTrash(analyst, theirs);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Portfolio Manager or above/);
});

test('seniority can remove anybody\'s', () => {
  assert.equal(canTrash(pm, theirs).ok, true);
  assert.equal(canTrash(admin, theirs).ok, true, 'super admin bypasses');
});

test('an unowned file needs seniority, not nobody', () => {
  // uploadedById is null on everything imported in bulk. Treating null
  // as "yours" would hand every member the entire legacy archive.
  assert.equal(canTrash(analyst, orphan).ok, false);
  assert.equal(canTrash(pm, orphan).ok, true);
});

test('extraRoles count toward seniority', () => {
  const dual = { id: 5, role: 'Analyst', extraRoles: ['PortfolioManager'], email: 'd@x.org' };
  assert.equal(canTrash(dual, theirs).ok, true);
});

test('permanent deletion is narrower than trashing', () => {
  // Trash is reversible and several people hold it. Purge is not
  // reversible by anybody, so exactly one person holds it.
  assert.equal(canPurge(pm).ok, false);
  assert.match(canPurge(pm).reason, /reversible/);
  assert.equal(canPurge(admin).ok, true);
});

test('uploading stays open, because contributing is the point', () => {
  assert.equal(canUpload(analyst).ok, true);
  assert.equal(canUpload(pm).ok, true);
  // JuniorAnalyst is below the terminal gate and every Google signup
  // lands there, so it must not carry write access.
  assert.equal(canUpload(junior).ok, false);
  assert.equal(canUpload(null).ok, false);
});

test('capabilities lets a client hide a button instead of refusing a press', () => {
  const a = capabilities(analyst);
  assert.equal(a.upload, true);
  assert.equal(a.trashAny, false);
  assert.equal(a.purge, false);
  const s = capabilities(admin);
  assert.equal(s.trashAny, true);
  assert.equal(s.purge, true);
});


test('with no super admin configured, nobody is one', () => {
  // The fail-safe in isSuperAdminEmail, pinned here because this file
  // depends on it: an env var missing in some future environment must
  // never quietly promote everybody to the one tier that can destroy
  // things irreversibly.
  const saved = process.env.SUPER_ADMIN_EMAIL;
  delete process.env.SUPER_ADMIN_EMAIL;
  try {
    assert.equal(canPurge(admin).ok, false, 'no env var means no purge for anyone');
    assert.equal(canTrash(analyst, theirs).ok, false);
  } finally {
    process.env.SUPER_ADMIN_EMAIL = saved;
  }
});
