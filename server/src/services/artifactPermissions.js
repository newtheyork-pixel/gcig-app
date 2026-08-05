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
// THE RULE. You may remove what you contributed, and nothing else.
// Touching anybody else's work, by either route, is the super admin
// alone.
//
// The first cut let Portfolio Managers remove other members' files, on
// the reasoning that seniority already reviews their work. That was the
// wrong instinct for a research archive. Reviewing a pitch and being
// able to delete the evidence behind it are different powers, the club
// has several people at that tier, and the volume turns the action into
// a drag of a folder. The tier that can destroy a project's record
// should be as small as it can be, and one is as small as it gets.

import { ROLE_RANK, isSuperAdminEmail } from '../middleware/auth.js';

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

  // Named precisely. "Permission denied" sends somebody to ask an
  // engineer; this sends them to the one person who can actually do it.
  return {
    ok: false,
    reason: artifact?.uploadedById == null
      ? 'This file has no recorded uploader, so only the super admin can remove it.'
      : 'You can remove files you uploaded. Anything else is the super admin.',
  };
}

/**
 * May this user destroy it outright, past recovery?
 *
 * Super admin only, same as removing somebody else's file, but the two
 * are not the same act and the distinction is worth keeping.
 *
 * Trashing is the Mac's Trash: the file leaves every read path while the
 * row and the bytes remain, and /restore brings it back whole. A member
 * who trashes their own upload by accident loses nothing. Purging
 * deletes the row, and nothing brings it back for anybody.
 *
 * So the reversible one is the default and the destructive one is a
 * separate deliberate act, even though the same person holds both.
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
    trashAny: isSuperAdminEmail(user?.email),
    purge: canPurge(user).ok,
    rank: rank(user),
  };
}
