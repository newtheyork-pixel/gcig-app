import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

// All authed users — full vote history, newest first.
router.get('/', async (_req, res) => {
  const votes = await prisma.vote.findMany({
    orderBy: { createdAt: 'desc' },
    include: { creator: { select: { id: true, name: true, role: true } } },
  });
  res.json(votes);
});

// Latest vote for popup check. Returns null if none exist.
router.get('/latest', async (_req, res) => {
  const latest = await prisma.vote.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { creator: { select: { id: true, name: true, role: true } } },
  });
  res.json(latest || null);
});

// President only — cast a new vote.
router.post('/', requireAdmin, async (req, res) => {
  const { ticker, action, note } = req.body || {};
  if (!ticker || !action) {
    return res.status(400).json({ error: 'ticker and action required' });
  }
  if (!['Buy', 'Hold', 'Sell'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const vote = await prisma.vote.create({
    data: {
      ticker: ticker.toUpperCase(),
      action,
      note: note || null,
      createdBy: req.user.id,
    },
    include: { creator: { select: { id: true, name: true, role: true } } },
  });
  res.status(201).json(vote);
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.vote.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
