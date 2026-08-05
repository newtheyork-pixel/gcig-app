// Who may remove a document from the club's research record.
//
// Every artifact operation used to sit behind one gate, requireRole
// ('Analyst'), which meant any of the twenty-odd members at Analyst or
// above could permanently delete any file in any project — including all
// 205 documents on LISN, a project most of them have never opened.
//
// That was survivable while deleting took a deliberate API call. It
// stopped being survivable when the Griffin Fund volume began honouring
// a Finder trash gesture, because the same power became a drag of a
// folder by somebody tidying their sidebar. Widening how easily an
// action can be taken is the same thing as widening who can take it, and
// this file is the half that did not get written at the time.
//
// THE RULE. You may remove what you contributed. Removing somebody
// else's work needs seniority. Destroying anything irreversibly is the
// super admin alone.
//
// It is the ordinary rule for shared drives and it is the right one
// here: a member who uploads the wrong file must be able to fix it
// without asking, and a member who has never touched a project should
// not be able to empty it.

import { ROLE_RANK, isSuperAdminEmail } from '../middleware/auth.js';

/// Deleting another member's upload. PortfolioManager and above, which
/// is the tier that already runs industries and reviews pitches.
export const DELETE_OTHERS_RANK = ROLE_RANK.PortfolioManager;

function rank(user) {
  const own = ROLE_RANK[user?.role] || 0;
  const extra = (user?.extraRoles || []).map((r) => ROLE_RANK[r] || 0);
  return Math.max(own, ...extra, 0);
}

/**
 * May this user trash this artifact?
 *
 * Returns `{ ok }` or `{ ok: false, reason }`. A reason rather than a
 * bare false, because this refusal reaches a member through a Finder
 * volume where nothing else can explain itself — a file that reappears
 * with no message is indistinguishable from a sync bug, which is exactly
 * how the drive lost a day to a silent write failure once already.
 */
export function canTrash(user, artifact) {
  if (!user) return { ok: false, reason: 'Not signed in.' };
  if (isSuperAdminEmail(user.email)) return { ok: true };

  const mine = artifact?.uploadedById != null && artifact.uploadedById === user.id;
  if (mine) return { ok: true };

  if (rank(user) >= DELETE_OTHERS_RANK) return { ok: true };

  // Named precisely. "Permission denied" sends somebody to ask an
  // engineer; this sends them to the right person.
  return {
    ok: false,
    reason: artifact?.uploadedById == null
      ? 'This file has no recorded uploader, so only a Portfolio Manager or above can remove it.'
      : 'You can remove files you uploaded. Removing somebody else\'s needs a Portfolio Manager or above.',
  };
}

/**
 * May this user destroy it outright, past recovery?
 *
 * Super admin only, and deliberately narrower than trashing. A soft
 * delete leaves the row and the bytes and can be undone by anybody; this
 * cannot be undone by anybody, and the club has exactly one person whose
 * job includes that.
 */
export function canPurge(user) {
  if (isSuperAdminEmail(user?.email)) return { ok: true };
  return { ok: false, reason: 'Permanent deletion is super admin only. Use trash, which is reversible.' };
}

/**
 * May this user add a file to this project?
 *
 * Deliberately unrestricted at Analyst and above, which is the terminal
 * gate already. Research is the thing members are here to do, and an
 * upload is additive: the worst case is a file somebody has to remove,
 * which is a smaller problem than a member who cannot contribute.
 */
export function canUpload(user) {
  if (!user) return { ok: false, reason: 'Not signed in.' };
  if (rank(user) >= ROLE_RANK.Analyst || isSuperAdminEmail(user.email)) return { ok: true };
  return { ok: false, reason: 'Analyst role or above is needed to add research files.' };
}

/// What this user may do, for a client that wants to hide a button
/// rather than let somebody press it and be refused.
export function capabilities(user) {
  return {
    upload: canUpload(user).ok,
    trashOwn: !!user,
    trashAny: isSuperAdminEmail(user?.email) || rank(user) >= DELETE_OTHERS_RANK,
    purge: canPurge(user).ok,
    rank: rank(user),
  };
}
