// The analyst draft, as pure decisions. Routes and the clock both
// call these so a permission or a snake reversal cannot be implemented
// twice and disagree. Nothing here touches the database.

export const PM_ROLES = new Set(['PortfolioManager', 'SeniorPortfolioManager']);
export const DRAFTABLE_ROLES = new Set(['Analyst', 'SeniorAnalyst', 'JuniorAnalyst']);
// The people who run a meeting. Super admin is checked separately,
// because that flag is an email match and not a role.
export const DRAFT_ADMIN_ROLES = new Set(['President', 'DirectorOfResearch', 'CIO']);

export function isDraftAdmin(user) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return DRAFT_ADMIN_ROLES.has(user.role);
}

function deny(status, error) {
  return { ok: false, status, error };
}

// Round 1 walks the seats in the order the commissioner set.
// Round 2 walks that order backwards, round 3 forwards again.
// With snake off, every round repeats round 1. A single seat is
// the same list either way — reversing one position changes nothing.
export function buildOrder(seatCount, rounds, snake = true) {
  const seats = Number(seatCount) || 0;
  const nRounds = Number(rounds) || 0;
  if (seats < 1 || nRounds < 1) return [];
  const order = [];
  let pickNumber = 1;
  for (let round = 1; round <= nRounds; round++) {
    const forward = !snake || round % 2 === 1;
    for (let i = 0; i < seats; i++) {
      const slot = forward ? i : seats - 1 - i;
      order.push({
        pickNumber,
        round,
        slotInRound: i + 1,
        slot,
      });
      pickNumber += 1;
    }
  }
  return order;
}

// The seat whose pick is due. Null once the order is exhausted or
// the draft has not started / is already over.
export function onClock(state) {
  if (!state) return null;
  if (state.status !== 'live' && state.status !== 'paused') return null;
  const slot = (state.order || [])[state.pickIndex];
  if (!slot) return null;
  const seat = (state.seats || []).find((s) => s.slot === slot.slot);
  if (!seat) return null;
  const pmId = seat.userId ?? seat.user?.id;
  if (pmId == null) return null;
  return {
    ...slot,
    pmId,
    pmName: seat.user?.name || seat.name || '',
  };
}

// Best available when a queue is empty or already used up.
// Hit rate first (buys over decided pitches), then more buys — a
// 2-for-4 ranks above a 1-for-2 — then name, so the choice is
// stable and two readers cannot disagree. An analyst with no
// decided pitches is a 0, tied with a winless record, and the
// name breaks it. We do not invent a projection past the pitches
// the club has already voted.
export function compareAnalysts(a, b) {
  const hit = (b.hitRate || 0) - (a.hitRate || 0);
  if (hit !== 0) return hit;
  const buys = (b.buys || 0) - (a.buys || 0);
  if (buys !== 0) return buys;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

export function chooseAutoPick(queueIds, available) {
  const byId = new Map((available || []).map((a) => [a.id, a]));
  for (const id of queueIds || []) {
    if (byId.has(id)) return { analystId: id, source: 'queue' };
  }
  if (!available || available.length === 0) return null;
  const best = [...available].sort(compareAnalysts)[0];
  return { analystId: best.id, source: 'auto' };
}

export function summarizeTrack(pitches) {
  let decided = 0;
  let buys = 0;
  for (const p of pitches || []) {
    const outcome = p.votedOutcome;
    if (outcome === 'Buy' || outcome === 'Approved') {
      decided += 1;
      buys += 1;
    } else if (outcome === 'NoBuy') {
      decided += 1;
    }
  }
  return {
    pitches: (pitches || []).length,
    decided,
    buys,
    hitRate: decided > 0 ? buys / decided : 0,
  };
}

// Pool membership decides who can still be taken. `analysts` only
// decorates them with a name and a record; a missing decoration is
// a zero record, not an absence.
export function toExpiryState(draft, analysts) {
  const byId = new Map((analysts || []).map((a) => [a.id, a]));
  const seats = [...(draft.seats || [])].sort((a, b) => a.slot - b.slot);
  const order = buildOrder(seats.length, draft.rounds, draft.snake !== false);
  const taken = new Set((draft.picks || []).map((p) => p.analystId));
  const available = [];
  for (const entry of draft.pool || []) {
    const id = entry.userId ?? entry.id;
    if (taken.has(id)) continue;
    const known = byId.get(id);
    available.push({
      id,
      name: known?.name || entry.user?.name || '',
      hitRate: known?.hitRate || 0,
      buys: known?.buys || 0,
    });
  }
  const queueByPm = new Map();
  const ranked = [...(draft.queue || [])].sort((a, b) => a.rank - b.rank);
  for (const q of ranked) {
    if (!queueByPm.has(q.pmId)) queueByPm.set(q.pmId, []);
    queueByPm.get(q.pmId).push(q.analystId);
  }
  return {
    status: draft.status,
    clockEndsAt: draft.clockEndsAt,
    pickIndex: draft.pickIndex,
    pickSeconds: draft.pickSeconds,
    order,
    seats,
    queueByPm,
    available,
  };
}

export function shouldAutoPick(draft, now) {
  if (!draft || draft.status !== 'live') return false;
  if (!draft.clockEndsAt) return false;
  return new Date(draft.clockEndsAt).getTime() <= now.getTime();
}

// `availableCount` includes the analyst this pick consumes. The
// draft ends when the order runs out or the board does, whichever
// comes first. A paused pick keeps the draft paused and banks a
// full clock for whoever is next, so assigning while paused does
// not start the timer under the commissioner's hands.
export function afterPick({
  pickIndex,
  orderLength,
  availableCount,
  pickSeconds,
  now,
  paused = false,
}) {
  const nextIndex = pickIndex + 1;
  const cap = Math.min(orderLength, pickIndex + availableCount);
  const done = nextIndex >= cap;
  return {
    pickIndex: nextIndex,
    status: done ? 'complete' : paused ? 'paused' : 'live',
    clockEndsAt: done || paused ? null : new Date(now.getTime() + pickSeconds * 1000),
    pausedRemainingMs: !done && paused ? pickSeconds * 1000 : null,
    completedAt: done ? now : null,
  };
}

// What an expired clock should do. The next clock starts at the
// moment THIS pick expired, not at wall-clock now, so a server that
// was asleep for ten minutes catches up one pick per timer instead
// of making a single pick and handing the next PM two fresh minutes.
export function decideExpiry(state, now) {
  if (!shouldAutoPick(state, now)) return null;
  const clock = onClock({ ...state, status: 'live' });
  const cap = Math.min(state.order.length, state.pickIndex + state.available.length);
  if (!clock || state.pickIndex >= cap || state.available.length === 0) {
    return { kind: 'complete' };
  }
  const queue = state.queueByPm.get(clock.pmId) || [];
  const choice = chooseAutoPick(queue, state.available);
  if (!choice) return { kind: 'complete' };
  const expiredAt = new Date(state.clockEndsAt);
  const next = afterPick({
    pickIndex: state.pickIndex,
    orderLength: state.order.length,
    availableCount: state.available.length,
    pickSeconds: state.pickSeconds,
    now: expiredAt,
    paused: false,
  });
  return {
    kind: 'pick',
    ...choice,
    pmId: clock.pmId,
    pickNumber: clock.pickNumber,
    round: clock.round,
    slotInRound: clock.slotInRound,
    pickedAt: expiredAt,
    next,
  };
}

// A PM picks only on their own live turn. A commissioner can assign
// the current pick while the draft is live or paused. Nobody picks
// for a future turn — undo exists so a wrong name comes off the
// board without jumping the snake.
export function canMakePick({ user, status, onClockUserId }) {
  if (!user || onClockUserId == null) return false;
  if (status !== 'live' && status !== 'paused') return false;
  if (isDraftAdmin(user)) return true;
  return status === 'live' && user.id === onClockUserId && PM_ROLES.has(user.role);
}

export function pickDecision({
  user,
  status,
  onClockUserId,
  analystId,
  poolIds,
  takenIds,
}) {
  if (!user) return deny(401, 'Sign in required');
  if (!Number.isInteger(analystId)) return deny(400, 'Choose an analyst');
  if (status === 'paused' && !isDraftAdmin(user)) {
    return deny(403, 'The draft is paused');
  }
  if (!canMakePick({ user, status, onClockUserId })) {
    return deny(403, 'Only the portfolio manager on the clock can make a pick');
  }
  if (!(poolIds || []).includes(analystId)) {
    return deny(400, 'That analyst is not in this draft');
  }
  if ((takenIds || []).includes(analystId)) {
    return deny(409, 'That analyst has already been drafted');
  }
  return {
    ok: true,
    pmId: onClockUserId,
    source: user.id === onClockUserId ? 'board' : 'admin',
  };
}

export function canEditQueue({ user, status, seatUserId }) {
  if (!user || seatUserId == null) return false;
  if (status !== 'setup' && status !== 'live' && status !== 'paused') return false;
  if (isDraftAdmin(user)) return true;
  return user.id === seatUserId && PM_ROLES.has(user.role);
}

export function queueDecision({ user, status, seatUserId, analystIds, poolIds }) {
  if (!canEditQueue({ user, status, seatUserId })) {
    return deny(403, 'Only that portfolio manager can set this queue');
  }
  if (!Array.isArray(analystIds)) return deny(400, 'Queue must be a list of analysts');
  const seen = new Set();
  for (const id of analystIds) {
    if (!Number.isInteger(id)) return deny(400, 'Queue must be a list of analysts');
    if (seen.has(id)) return deny(400, 'An analyst can only appear once in a queue');
    if (!(poolIds || []).includes(id)) {
      return deny(400, 'That analyst is not in this draft');
    }
    seen.add(id);
  }
  return { ok: true, analystIds };
}

export function canEditSetup(user, status) {
  return isDraftAdmin(user) && status === 'setup';
}

export function validateSetup(body) {
  const name = String(body?.name || '').trim();
  const rounds = Number(body?.rounds);
  // An omitted clock is 30 seconds. The band stays 15s–15min so a
  // commissioner can still run a slower room.
  const pickSeconds = body?.pickSeconds == null ? 30 : Number(body.pickSeconds);
  const snake = body?.snake !== false;
  const pmIds = Array.isArray(body?.pmIds) ? body.pmIds.map(Number) : [];
  const analystIds = Array.isArray(body?.analystIds) ? body.analystIds.map(Number) : [];
  if (!name || name.length > 80) return deny(400, 'Name the draft (80 characters or fewer)');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
    return deny(400, 'Rounds must be between 1 and 20');
  }
  if (!Number.isInteger(pickSeconds) || pickSeconds < 15 || pickSeconds > 900) {
    return deny(400, 'The pick clock must be between 15 seconds and 15 minutes');
  }
  const badPm =
    pmIds.length < 2 ||
    new Set(pmIds).size !== pmIds.length ||
    pmIds.some((id) => !Number.isInteger(id) || id < 1);
  if (badPm) {
    return deny(400, 'Choose at least two portfolio managers, with no one listed twice');
  }
  const badAnalyst =
    analystIds.length < 1 ||
    new Set(analystIds).size !== analystIds.length ||
    analystIds.some((id) => !Number.isInteger(id) || id < 1);
  if (badAnalyst) {
    return deny(400, 'Choose at least one analyst, with no one listed twice');
  }
  if (pmIds.some((id) => analystIds.includes(id))) {
    return deny(400, 'A member cannot both draft and be drafted');
  }
  return { ok: true, value: { name, rounds, pickSeconds, snake, pmIds, analystIds } };
}

export function cleanClassYear(value) {
  if (value === null || value === '' || value === undefined) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2000 || n > 2045) {
    return deny(400, 'Class year must be between 2000 and 2045');
  }
  return { ok: true, value: n };
}

// Which completed draft owns each PM's pod. A later draft replaces
// an earlier one for the PMs who sat in it. An analyst named by two
// drafts stays with the newer one — a person is on one pod.
export function selectPodRosters(drafts) {
  const byPm = new Map();
  const complete = (drafts || []).filter((d) => d.status === 'complete');
  for (const d of complete) {
    const when = d.completedAt || 0;
    for (const pmId of d.pmIds || []) {
      const prev = byPm.get(pmId);
      const newer =
        !prev ||
        when > prev.completedAt ||
        (when === prev.completedAt && d.id > prev.draftId);
      if (!newer) continue;
      const analystIds = (d.picks || [])
        .filter((p) => p.pmId === pmId)
        .sort((a, b) => a.pickNumber - b.pickNumber)
        .map((p) => p.analystId);
      byPm.set(pmId, { draftId: d.id, completedAt: when, analystIds });
    }
  }

  const owner = new Map();
  for (const [pmId, row] of byPm) {
    for (const analystId of row.analystIds) {
      const prev = owner.get(analystId);
      const newer =
        !prev ||
        row.completedAt > prev.completedAt ||
        (row.completedAt === prev.completedAt && row.draftId > prev.draftId);
      if (newer) {
        owner.set(analystId, {
          pmId,
          completedAt: row.completedAt,
          draftId: row.draftId,
        });
      }
    }
  }

  const cleaned = new Map();
  for (const [pmId, row] of byPm) {
    cleaned.set(pmId, { draftId: row.draftId, completedAt: row.completedAt, analystIds: [] });
  }
  for (const [analystId, o] of owner) {
    cleaned.get(o.pmId).analystIds.push(analystId);
  }
  return cleaned;
}
