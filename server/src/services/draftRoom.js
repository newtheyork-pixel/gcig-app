// Persistence for the analyst draft. The decisions — snake order,
// whose turn, what an expired clock does, who may touch it — live in
// analystDraft.js. This file only reads and writes them, so two
// polls cannot make the same pick twice: the claim is an updateMany
// on the current pickIndex, and the loser finds zero rows.

import prisma from '../db.js';
import { mentionsSegLabel } from './segLabel.js';
import {
  PM_ROLES,
  DRAFTABLE_ROLES,
  summarizeTrack,
  collectTracks,
  toExpiryState,
  decideExpiry,
  onClock,
  afterPick,
  pickDecision,
  buildOrder,
  canMakePick,
  canEditQueue,
  isDraftAdmin,
  selectPodRosters,
} from './analystDraft.js';

const CARD = { id: true, name: true, role: true, classYear: true };

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function coverageOf(user) {
  return (user?.industries || [])
    .map((row) => row.industry?.name)
    .filter((name) => name && !mentionsSegLabel(name));
}

const PITCH_CARD = {
  id: true,
  votedOutcome: true,
  pitcherName: true,
  industry: { select: { name: true } },
};

function rememberPitch(byId, pitch, presenterId) {
  if (!pitch) return;
  let row = byId.get(pitch.id);
  if (!row) {
    row = {
      id: pitch.id,
      votedOutcome: pitch.votedOutcome,
      pitcherName: pitch.pitcherName,
      industryName: pitch.industry?.name || '',
      presenterIds: [],
    };
    byId.set(pitch.id, row);
  }
  if (presenterId != null) row.presenterIds.push(presenterId);
}

async function trackFor(db, userIds) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const names = [...new Set(users.map((u) => String(u.name || '').trim()).filter(Boolean))];
  const [presenterRows, named] = await Promise.all([
    db.pitchPresenter.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, pitch: { select: PITCH_CARD } },
    }),
    names.length
      ? db.pitch.findMany({
          where: {
            OR: names.map((name) => ({
              pitcherName: { contains: name, mode: 'insensitive' },
            })),
          },
          select: PITCH_CARD,
        })
      : [],
  ]);
  const byId = new Map();
  for (const row of presenterRows) rememberPitch(byId, row.pitch, row.userId);
  for (const pitch of named) rememberPitch(byId, pitch);
  return collectTracks(users, [...byId.values()]);
}

function loadRaw(db, id) {
  return db.analystDraft.findUnique({
    where: { id },
    include: {
      seats: {
        orderBy: { slot: 'asc' },
        include: { user: { select: CARD } },
      },
      pool: {
        include: {
          user: {
            select: {
              ...CARD,
              industries: { include: { industry: { select: { id: true, name: true } } } },
            },
          },
        },
      },
      picks: {
        orderBy: { pickNumber: 'asc' },
        include: {
          pm: { select: { id: true, name: true } },
          analyst: { select: { id: true, name: true } },
        },
      },
      queue: { orderBy: { rank: 'asc' } },
    },
  });
}

async function analystsFor(db, draft) {
  const ids = draft.pool.map((p) => p.userId);
  const track = await trackFor(db, ids);
  return draft.pool.map((p) => {
    const record = track.get(p.userId) || summarizeTrack([]);
    return { id: p.userId, name: p.user?.name || '', ...record };
  });
}

async function recomputePods(tx, pmIds) {
  const ids = [...new Set(pmIds)];
  if (ids.length === 0) return;
  const drafts = await tx.analystDraft.findMany({
    where: { status: 'complete', seats: { some: { userId: { in: ids } } } },
    include: { seats: true, picks: true },
  });
  const map = selectPodRosters(
    drafts.map((d) => ({
      id: d.id,
      status: d.status,
      completedAt: d.completedAt ? d.completedAt.getTime() : 0,
      pmIds: d.seats.map((s) => s.userId),
      picks: d.picks,
    }))
  );
  const arriving = [];
  for (const pmId of ids) {
    const row = map.get(pmId);
    if (row) arriving.push(...row.analystIds);
  }
  await tx.pmPodMember.deleteMany({
    where: {
      OR: [
        { pmId: { in: ids } },
        ...(arriving.length ? [{ analystId: { in: arriving } }] : []),
      ],
    },
  });
  const data = [];
  for (const pmId of ids) {
    const row = map.get(pmId);
    if (!row) continue;
    for (const analystId of row.analystIds) {
      data.push({ pmId, analystId, draftId: row.draftId });
    }
  }
  if (data.length) await tx.pmPodMember.createMany({ data });
}

async function assertRosterRoles(pmIds, analystIds) {
  const users = await prisma.user.findMany({
    where: { id: { in: [...pmIds, ...analystIds] } },
    select: { id: true, role: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const id of pmIds) {
    const user = byId.get(id);
    if (!user || !PM_ROLES.has(user.role)) {
      throw httpError(400, 'Only portfolio managers sit in the draft order');
    }
  }
  for (const id of analystIds) {
    const user = byId.get(id);
    if (!user || !DRAFTABLE_ROLES.has(user.role)) {
      throw httpError(400, 'Only analysts can be drafted');
    }
  }
}

export async function createDraft(createdById, value) {
  await assertRosterRoles(value.pmIds, value.analystIds);
  return prisma.analystDraft.create({
    data: {
      name: value.name,
      rounds: value.rounds,
      pickSeconds: value.pickSeconds,
      snake: value.snake,
      createdById,
      seats: { create: value.pmIds.map((userId, slot) => ({ userId, slot })) },
      pool: { create: value.analystIds.map((userId) => ({ userId })) },
    },
    select: { id: true },
  });
}

export async function updateDraft(id, value) {
  await assertRosterRoles(value.pmIds, value.analystIds);
  await prisma.$transaction(async (tx) => {
    const draft = await tx.analystDraft.findUnique({ where: { id } });
    if (!draft) throw httpError(404, 'Draft not found');
    if (draft.status !== 'setup') {
      throw httpError(409, 'The draft has already started');
    }
    await tx.draftQueueRank.deleteMany({ where: { draftId: id } });
    await tx.draftSeat.deleteMany({ where: { draftId: id } });
    await tx.draftEligible.deleteMany({ where: { draftId: id } });
    await tx.analystDraft.update({
      where: { id },
      data: {
        name: value.name,
        rounds: value.rounds,
        pickSeconds: value.pickSeconds,
        snake: value.snake,
        seats: { create: value.pmIds.map((userId, slot) => ({ userId, slot })) },
        pool: { create: value.analystIds.map((userId) => ({ userId })) },
      },
    });
  });
}

export async function deleteDraft(id) {
  const draft = await prisma.analystDraft.findUnique({ where: { id } });
  if (!draft) throw httpError(404, 'Draft not found');
  if (draft.status !== 'setup') throw httpError(409, 'A started draft is kept');
  await prisma.analystDraft.delete({ where: { id } });
}

export async function startDraft(id, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const other = await tx.analystDraft.findFirst({
      where: { status: { in: ['live', 'paused'] }, NOT: { id } },
      select: { id: true, name: true },
    });
    if (other) {
      throw httpError(409, `End “${other.name}” before starting another draft`);
    }
    const draft = await tx.analystDraft.findUnique({
      where: { id },
      include: { seats: true, pool: true },
    });
    if (!draft) throw httpError(404, 'Draft not found');
    if (draft.status !== 'setup') throw httpError(409, 'The draft has already started');
    if (draft.seats.length < 2 || draft.pool.length < 1) {
      throw httpError(400, 'The draft needs two portfolio managers and one analyst');
    }
    const claimed = await tx.analystDraft.updateMany({
      where: { id, status: 'setup' },
      data: {
        status: 'live',
        startedAt: now,
        pickIndex: 0,
        clockEndsAt: new Date(now.getTime() + draft.pickSeconds * 1000),
        pausedRemainingMs: null,
        completedAt: null,
      },
    });
    if (claimed.count !== 1) throw httpError(409, 'The draft has already started');
  });
}

// One expired pick. Returns false when the clock is not due or
// another caller already took the pick. The next clock is dated
// from the moment this one expired, so a gap of several timers
// catches up instead of collapsing into a single pick.
export async function stepIfExpired(id, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const draft = await loadRaw(tx, id);
    if (!draft) return false;
    const analysts = await analystsFor(tx, draft);
    const state = toExpiryState(draft, analysts);
    const decision = decideExpiry(state, now);
    if (!decision) return false;
    const pmIds = draft.seats.map((s) => s.userId);

    if (decision.kind === 'complete') {
      const claimed = await tx.analystDraft.updateMany({
        where: { id, status: 'live', pickIndex: draft.pickIndex },
        data: {
          status: 'complete',
          completedAt: now,
          clockEndsAt: null,
          pausedRemainingMs: null,
        },
      });
      if (claimed.count !== 1) return false;
      await recomputePods(tx, pmIds);
      return true;
    }

    const claimed = await tx.analystDraft.updateMany({
      where: { id, status: 'live', pickIndex: draft.pickIndex },
      data: {
        pickIndex: decision.next.pickIndex,
        status: decision.next.status,
        clockEndsAt: decision.next.clockEndsAt,
        pausedRemainingMs: decision.next.pausedRemainingMs,
        completedAt: decision.next.completedAt,
      },
    });
    if (claimed.count !== 1) return false;
    await tx.draftPick.create({
      data: {
        draftId: id,
        pickNumber: decision.pickNumber,
        round: decision.round,
        slotInRound: decision.slotInRound,
        pmId: decision.pmId,
        analystId: decision.analystId,
        source: decision.source,
        pickedAt: decision.pickedAt,
      },
    });
    if (decision.next.status === 'complete') await recomputePods(tx, pmIds);
    return true;
  });
}

export async function catchUp(id, now = new Date()) {
  for (let i = 0; i < 100; i++) {
    const moved = await stepIfExpired(id, now);
    if (!moved) return;
  }
}

export async function catchUpLive(now = new Date()) {
  const due = await prisma.analystDraft.findMany({
    where: { status: 'live', clockEndsAt: { lte: now } },
    select: { id: true },
  });
  for (const row of due) await catchUp(row.id, now);
}

export function startDraftClock() {
  const timer = setInterval(() => {
    catchUpLive().catch((err) => console.warn('[draft] clock:', err.message));
  }, 1000);
  timer.unref?.();
  return timer;
}

export async function loadForDecision(id) {
  const draft = await loadRaw(prisma, id);
  if (!draft) return null;
  const analysts = await analystsFor(prisma, draft);
  return { ...draft, analysts };
}

export async function commitPick(id, { analystId, user }, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const draft = await loadRaw(tx, id);
    if (!draft) throw httpError(404, 'Draft not found');
    const analysts = await analystsFor(tx, draft);
    const state = toExpiryState(draft, analysts);
    const clock = onClock(state);
    const decision = pickDecision({
      user,
      status: draft.status,
      onClockUserId: clock?.pmId ?? null,
      analystId,
      poolIds: draft.pool.map((p) => p.userId),
      takenIds: draft.picks.map((p) => p.analystId),
    });
    if (!decision.ok) throw httpError(decision.status, decision.error);
    const next = afterPick({
      pickIndex: draft.pickIndex,
      orderLength: state.order.length,
      availableCount: state.available.length,
      pickSeconds: draft.pickSeconds,
      now,
      paused: draft.status === 'paused',
    });
    const claimed = await tx.analystDraft.updateMany({
      where: { id, status: draft.status, pickIndex: draft.pickIndex },
      data: {
        pickIndex: next.pickIndex,
        status: next.status,
        clockEndsAt: next.clockEndsAt,
        pausedRemainingMs: next.pausedRemainingMs,
        completedAt: next.completedAt,
      },
    });
    if (claimed.count !== 1) {
      throw httpError(409, 'The clock moved. Refresh and try again.');
    }
    await tx.draftPick.create({
      data: {
        draftId: id,
        pickNumber: clock.pickNumber,
        round: clock.round,
        slotInRound: clock.slotInRound,
        pmId: decision.pmId,
        analystId,
        source: decision.source,
        pickedAt: now,
      },
    });
    if (next.status === 'complete') {
      await recomputePods(tx, draft.seats.map((s) => s.userId));
    }
  });
}

export async function saveQueue(id, pmId, analystIds) {
  await prisma.$transaction(async (tx) => {
    await tx.draftQueueRank.deleteMany({ where: { draftId: id, pmId } });
    if (analystIds.length) {
      await tx.draftQueueRank.createMany({
        data: analystIds.map((analystId, rank) => ({
          draftId: id,
          pmId,
          analystId,
          rank: rank + 1,
        })),
      });
    }
  });
}

export async function pauseDraft(id, now = new Date()) {
  await catchUp(id, now);
  await prisma.$transaction(async (tx) => {
    const draft = await tx.analystDraft.findUnique({ where: { id } });
    if (!draft) throw httpError(404, 'Draft not found');
    if (draft.status !== 'live') throw httpError(409, 'Only a live draft can be paused');
    const remaining = draft.clockEndsAt
      ? Math.max(0, new Date(draft.clockEndsAt).getTime() - now.getTime())
      : draft.pickSeconds * 1000;
    const claimed = await tx.analystDraft.updateMany({
      where: { id, status: 'live', pickIndex: draft.pickIndex },
      data: { status: 'paused', pausedRemainingMs: remaining, clockEndsAt: null },
    });
    if (claimed.count !== 1) throw httpError(409, 'The clock moved. Refresh and try again.');
  });
}

export async function resumeDraft(id, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const draft = await tx.analystDraft.findUnique({ where: { id } });
    if (!draft) throw httpError(404, 'Draft not found');
    if (draft.status !== 'paused') throw httpError(409, 'The draft is not paused');
    const remaining = draft.pausedRemainingMs ?? draft.pickSeconds * 1000;
    await tx.analystDraft.update({
      where: { id },
      data: {
        status: 'live',
        clockEndsAt: new Date(now.getTime() + Math.max(0, remaining)),
        pausedRemainingMs: null,
      },
    });
  });
}

export async function endDraft(id, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const draft = await tx.analystDraft.findUnique({
      where: { id },
      include: { seats: true },
    });
    if (!draft) throw httpError(404, 'Draft not found');
    if (draft.status === 'complete') return;
    if (draft.status !== 'live' && draft.status !== 'paused') {
      throw httpError(409, 'Start the draft before ending it');
    }
    const claimed = await tx.analystDraft.updateMany({
      where: { id, status: draft.status },
      data: {
        status: 'complete',
        completedAt: now,
        clockEndsAt: null,
        pausedRemainingMs: null,
      },
    });
    if (claimed.count !== 1) throw httpError(409, 'The clock moved. Refresh and try again.');
    await recomputePods(tx, draft.seats.map((s) => s.userId));
  });
}

export async function undoPick(id, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const draft = await tx.analystDraft.findUnique({
      where: { id },
      include: {
        seats: true,
        picks: { orderBy: { pickNumber: 'desc' }, take: 1 },
      },
    });
    if (!draft) throw httpError(404, 'Draft not found');
    if (draft.status === 'setup') throw httpError(409, 'The draft has not started');
    if (draft.picks.length === 0) throw httpError(400, 'Nothing to undo');
    await tx.draftPick.delete({ where: { id: draft.picks[0].id } });
    const remaining = await tx.draftPick.count({ where: { draftId: id } });
    const stayPaused = draft.status === 'paused';
    await tx.analystDraft.update({
      where: { id },
      data: {
        pickIndex: remaining,
        status: stayPaused ? 'paused' : 'live',
        clockEndsAt: stayPaused ? null : new Date(now.getTime() + draft.pickSeconds * 1000),
        pausedRemainingMs: stayPaused ? draft.pickSeconds * 1000 : null,
        completedAt: null,
      },
    });
    await recomputePods(tx, draft.seats.map((s) => s.userId));
  });
}

export async function setClassYear(userId, classYear) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw httpError(404, 'Member not found');
  await prisma.user.update({ where: { id: userId }, data: { classYear } });
}

function decorate(user, track) {
  const record = track.get(user.id) || summarizeTrack([]);
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    classYear: user.classYear ?? null,
    coverage: coverageOf(user),
    pitches: record.pitches,
    decided: record.decided,
    buys: record.buys,
    hitRate: record.hitRate,
  };
}

export async function candidates() {
  const [users, industries] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: [...PM_ROLES, ...DRAFTABLE_ROLES] } },
      select: {
        ...CARD,
        industries: { include: { industry: { select: { id: true, name: true } } } },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.industry.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  const analystIds = users.filter((u) => DRAFTABLE_ROLES.has(u.role)).map((u) => u.id);
  const track = await trackFor(prisma, analystIds);
  return {
    pms: users
      .filter((u) => PM_ROLES.has(u.role))
      .map((u) => ({ id: u.id, name: u.name, role: u.role })),
    analysts: users
      .filter((u) => DRAFTABLE_ROLES.has(u.role))
      .map((u) => decorate(u, track)),
    coverageGroups: industries
      .filter((i) => !mentionsSegLabel(i.name))
      .map((i) => i.name),
  };
}

export async function listDrafts() {
  const drafts = await prisma.analystDraft.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      seats: {
        orderBy: { slot: 'asc' },
        include: { user: { select: { id: true, name: true } } },
      },
      _count: { select: { picks: true, pool: true } },
    },
  });
  return drafts.map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    rounds: d.rounds,
    pickSeconds: d.pickSeconds,
    snake: d.snake,
    createdAt: d.createdAt,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    pickCount: d._count.picks,
    poolCount: d._count.pool,
    seats: d.seats.map((s) => ({ userId: s.userId, name: s.user.name, slot: s.slot })),
  }));
}

export async function listPods() {
  const rows = await prisma.pmPodMember.findMany({
    include: {
      pm: { select: { id: true, name: true, role: true } },
      analyst: { select: { id: true, name: true, role: true, classYear: true } },
      draft: { select: { id: true, name: true, completedAt: true } },
    },
    orderBy: [{ pmId: 'asc' }, { assignedAt: 'asc' }],
  });
  const byPm = new Map();
  for (const row of rows) {
    if (!byPm.has(row.pmId)) {
      byPm.set(row.pmId, { pm: row.pm, draft: row.draft, analysts: [] });
    }
    byPm.get(row.pmId).analysts.push(row.analyst);
  }
  return [...byPm.values()].sort((a, b) => a.pm.name.localeCompare(b.pm.name));
}

export async function present(id, viewer, now = new Date()) {
  const draft = await loadRaw(prisma, id);
  if (!draft) return null;
  const track = await trackFor(prisma, draft.pool.map((p) => p.userId));
  const analysts = draft.pool.map((p) => ({
    id: p.userId,
    name: p.user?.name || '',
    ...(track.get(p.userId) || summarizeTrack([])),
  }));
  const state = toExpiryState(draft, analysts);
  const clock = onClock(state);
  const taken = new Set(draft.picks.map((p) => p.analystId));
  const seatBySlot = new Map(draft.seats.map((s) => [s.slot, s]));
  const admin = isDraftAdmin(viewer);
  const mySeat = draft.seats.find((s) => s.userId === viewer?.id) || null;

  const board = draft.pool
    .map((p) => ({
      ...decorate(p.user, track),
      available: !taken.has(p.userId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const seats = draft.seats.map((s) => ({
    userId: s.userId,
    name: s.user.name,
    role: s.user.role,
    slot: s.slot,
    roster: draft.picks
      .filter((p) => p.pmId === s.userId)
      .map((p) => ({
        analystId: p.analystId,
        name: p.analyst.name,
        pickNumber: p.pickNumber,
        round: p.round,
        source: p.source,
      })),
  }));

  const order = buildOrder(draft.seats.length, draft.rounds, draft.snake).map((slot) => {
    const seat = seatBySlot.get(slot.slot);
    return {
      pickNumber: slot.pickNumber,
      round: slot.round,
      slot: slot.slot,
      pmId: seat?.userId ?? null,
      pmName: seat?.user?.name || '',
      made: slot.pickNumber <= draft.picks.length,
    };
  });

  let remainingMs = null;
  if (draft.status === 'paused') remainingMs = draft.pausedRemainingMs ?? 0;
  else if (draft.status === 'live' && draft.clockEndsAt) {
    remainingMs = new Date(draft.clockEndsAt).getTime() - now.getTime();
  }

  const myQueue = mySeat
    ? draft.queue.filter((q) => q.pmId === mySeat.userId).map((q) => q.analystId)
    : null;

  return {
    serverNow: now.toISOString(),
    viewer: {
      isAdmin: admin,
      canPick: canMakePick({
        user: viewer,
        status: draft.status,
        onClockUserId: clock?.pmId ?? null,
      }),
      canQueue: mySeat
        ? canEditQueue({ user: viewer, status: draft.status, seatUserId: mySeat.userId })
        : false,
      seatUserId: mySeat?.userId ?? null,
    },
    draft: {
      id: draft.id,
      name: draft.name,
      status: draft.status,
      rounds: draft.rounds,
      pickSeconds: draft.pickSeconds,
      snake: draft.snake,
      pickIndex: draft.pickIndex,
      clockEndsAt: draft.clockEndsAt,
      pausedRemainingMs: draft.pausedRemainingMs,
      startedAt: draft.startedAt,
      completedAt: draft.completedAt,
      createdAt: draft.createdAt,
      remainingMs,
    },
    onClock: clock
      ? {
          pmId: clock.pmId,
          pmName: clock.pmName || seatBySlot.get(clock.slot)?.user?.name || '',
          pickNumber: clock.pickNumber,
          round: clock.round,
          slotInRound: clock.slotInRound,
        }
      : null,
    seats,
    board,
    picks: draft.picks.map((p) => ({
      pickNumber: p.pickNumber,
      round: p.round,
      slotInRound: p.slotInRound,
      pmId: p.pmId,
      pmName: p.pm.name,
      analystId: p.analystId,
      analystName: p.analyst.name,
      source: p.source,
      pickedAt: p.pickedAt,
    })),
    order,
    myQueue,
  };
}
