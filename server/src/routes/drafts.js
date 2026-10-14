import { Router } from 'express';
import { verifyJwt } from '../middleware/auth.js';
import {
  isDraftAdmin,
  validateSetup,
  cleanClassYear,
  toExpiryState,
  onClock,
  pickDecision,
  queueDecision,
} from '../services/analystDraft.js';
import * as room from '../services/draftRoom.js';

const router = Router();
router.use(verifyJwt);

function requireDraftAdmin(req, res) {
  if (isDraftAdmin(req.user)) return true;
  res.status(403).json({ error: 'President, Director of Research, or CIO required' });
  return false;
}

async function run(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
}

router.get('/', async (_req, res) => {
  res.json({ drafts: await room.listDrafts() });
});

router.get('/pods', async (_req, res) => {
  res.json({ pods: await room.listPods() });
});

router.get('/candidates', async (_req, res) => {
  res.json(await room.candidates());
});

router.patch('/class-year', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const userId = Number(req.body?.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Member required' });
  const cleaned = cleanClassYear(req.body?.classYear);
  if (!cleaned.ok) return res.status(cleaned.status).json({ error: cleaned.error });
  await run(res, async () => {
    await room.setClassYear(userId, cleaned.value);
    res.json({ ok: true, userId, classYear: cleaned.value });
  });
});

router.post('/', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const setup = validateSetup(req.body);
  if (!setup.ok) return res.status(setup.status).json({ error: setup.error });
  await run(res, async () => {
    const created = await room.createDraft(req.user.id, setup.value);
    res.status(201).json(created);
  });
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Draft not found' });
  await room.catchUp(id);
  const body = await room.present(id, req.user);
  if (!body) return res.status(404).json({ error: 'Draft not found' });
  res.json(body);
});

router.patch('/:id', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const id = Number(req.params.id);
  const setup = validateSetup(req.body);
  if (!setup.ok) return res.status(setup.status).json({ error: setup.error });
  await run(res, async () => {
    await room.updateDraft(id, setup.value);
    res.json(await room.present(id, req.user));
  });
});

router.delete('/:id', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const id = Number(req.params.id);
  await run(res, async () => {
    await room.deleteDraft(id);
    res.json({ ok: true });
  });
});

router.post('/:id/start', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const id = Number(req.params.id);
  await run(res, async () => {
    await room.startDraft(id);
    res.json(await room.present(id, req.user));
  });
});

router.post('/:id/pause', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const id = Number(req.params.id);
  await run(res, async () => {
    await room.pauseDraft(id);
    res.json(await room.present(id, req.user));
  });
});

router.post('/:id/resume', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const id = Number(req.params.id);
  await run(res, async () => {
    await room.resumeDraft(id);
    res.json(await room.present(id, req.user));
  });
});

router.post('/:id/undo', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const id = Number(req.params.id);
  await run(res, async () => {
    await room.undoPick(id);
    res.json(await room.present(id, req.user));
  });
});

router.post('/:id/end', async (req, res) => {
  if (!requireDraftAdmin(req, res)) return;
  const id = Number(req.params.id);
  await run(res, async () => {
    await room.endDraft(id);
    res.json(await room.present(id, req.user));
  });
});

// The handler takes its loader so a test can prove a refusal never
// reaches the write. The route below is the production wiring.
export async function pickHandler(req, res, deps) {
  const id = Number(req.params.id);
  const analystId = Number(req.body?.analystId);
  if (!Number.isInteger(id) || !Number.isInteger(analystId)) {
    return res.status(400).json({ error: 'Choose an analyst' });
  }
  const draft = await deps.load(id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  const state = toExpiryState(draft, draft.analysts || []);
  const clock = onClock(state);
  const decision = pickDecision({
    user: req.user,
    status: draft.status,
    onClockUserId: clock?.pmId ?? null,
    analystId,
    poolIds: (draft.pool || []).map((p) => p.userId),
    takenIds: (draft.picks || []).map((p) => p.analystId),
  });
  if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
  try {
    await deps.commitPick(id, { analystId, user: req.user });
    const body = deps.present ? await deps.present(id, req.user) : { ok: true };
    return res.json(body);
  } catch (err) {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
}

router.post('/:id/pick', (req, res) =>
  pickHandler(req, res, {
    load: room.loadForDecision,
    commitPick: room.commitPick,
    present: room.present,
  })
);

export async function queueHandler(req, res, deps) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Draft not found' });
  const draft = await deps.load(id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  const target = req.body?.pmId == null ? req.user?.id : Number(req.body.pmId);
  const isSeat = (draft.seats || []).some((s) => s.userId === target);
  if (!isSeat) {
    return res.status(400).json({ error: 'That portfolio manager is not in this draft' });
  }
  const analystIds = Array.isArray(req.body?.analystIds)
    ? req.body.analystIds.map(Number)
    : null;
  const decision = queueDecision({
    user: req.user,
    status: draft.status,
    seatUserId: target,
    analystIds,
    poolIds: (draft.pool || []).map((p) => p.userId),
  });
  if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
  try {
    await deps.saveQueue(id, target, decision.analystIds);
    const body = deps.present ? await deps.present(id, req.user) : { ok: true };
    return res.json(body);
  } catch (err) {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
}

router.put('/:id/queue', (req, res) =>
  queueHandler(req, res, {
    load: room.loadForDecision,
    saveQueue: room.saveQueue,
    present: room.present,
  })
);

export default router;
