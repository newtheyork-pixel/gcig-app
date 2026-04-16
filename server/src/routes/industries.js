import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireAdmin, ROLE_RANK, roleForRank } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

// President or industry leader can manage membership.
async function canManageIndustry(req, industryId) {
  if (req.user.role === 'President') return true;
  const industry = await prisma.industry.findUnique({
    where: { id: industryId },
    select: { leaderId: true },
  });
  return industry && industry.leaderId === req.user.id;
}

// Promote `userId` to one rank below `leaderRole`, but never demote.
async function applyLeaderRankAdjust(userId, leaderRole) {
  if (!leaderRole) return;
  const targetRank = (ROLE_RANK[leaderRole] ?? 0) - 1;
  const targetRole = roleForRank(targetRank);
  if (!targetRole) return;
  const member = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!member) return;
  const currentRank = ROLE_RANK[member.role] ?? 0;
  if (currentRank < targetRank) {
    await prisma.user.update({ where: { id: userId }, data: { role: targetRole } });
  }
}

// Ensure the leader is also a member of their own industry.
async function ensureLeaderIsMember(industryId, leaderId) {
  if (!leaderId) return;
  await prisma.userIndustry.upsert({
    where: { userId_industryId: { userId: leaderId, industryId } },
    update: {},
    create: { userId: leaderId, industryId },
  });
}

router.get('/', async (_req, res) => {
  const industries = await prisma.industry.findMany({
    orderBy: { name: 'asc' },
    include: {
      leader: { select: { id: true, name: true, role: true } },
      members: {
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      },
    },
  });
  const shaped = industries.map((i) => ({
    id: i.id,
    name: i.name,
    leader: i.leader,
    members: i.members.map((m) => m.user),
  }));
  res.json(shaped);
});

router.post('/', requireAdmin, async (req, res) => {
  const { name, leaderId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const lId = leaderId ? Number(leaderId) : null;
  try {
    const industry = await prisma.industry.create({
      data: { name: String(name).trim(), leaderId: lId },
    });
    await ensureLeaderIsMember(industry.id, lId);
    res.status(201).json(industry);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'An industry with that name already exists' });
    }
    throw err;
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, leaderId } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = String(name).trim();
  if (leaderId !== undefined) data.leaderId = leaderId ? Number(leaderId) : null;
  const industry = await prisma.industry.update({ where: { id }, data });
  await ensureLeaderIsMember(industry.id, industry.leaderId);
  res.json(industry);
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.industry.delete({ where: { id } });
  res.json({ ok: true });
});

// Add member — President OR this industry's leader.
router.post('/:id/members', async (req, res) => {
  const industryId = Number(req.params.id);
  if (!(await canManageIndustry(req, industryId))) {
    return res.status(403).json({ error: 'Only the industry leader or President can add members' });
  }
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const memberId = Number(userId);

  await prisma.userIndustry.upsert({
    where: { userId_industryId: { userId: memberId, industryId } },
    update: {},
    create: { userId: memberId, industryId },
  });

  // Auto-adjust member's rank to one below the leader's.
  const industry = await prisma.industry.findUnique({
    where: { id: industryId },
    include: { leader: { select: { role: true } } },
  });
  if (industry?.leader?.role) {
    await applyLeaderRankAdjust(memberId, industry.leader.role);
  }

  res.json({ ok: true });
});

router.delete('/:id/members/:userId', async (req, res) => {
  const industryId = Number(req.params.id);
  if (!(await canManageIndustry(req, industryId))) {
    return res.status(403).json({ error: 'Only the industry leader or President can remove members' });
  }
  const userId = Number(req.params.userId);
  await prisma.userIndustry.delete({
    where: { userId_industryId: { userId, industryId } },
  });
  res.json({ ok: true });
});

export default router;
