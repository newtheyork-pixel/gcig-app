import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';
import { auditReq } from '../services/audit.js';

const router = Router();
router.use(verifyJwt);

const MESSAGE_MAX = 2000;

// Messages-per-user rate limit to blunt spam. 30 messages / minute / user.
const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `chat:${req.user?.id || req.ip}`,
  message: { error: 'You are sending messages too quickly. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Can this user read/write the given channel? Returns { ok, reason }.
async function channelAccess(req, channel) {
  if (channel === 'general') return { ok: true };
  const match = channel.match(/^industry:(\d+)$/);
  if (!match) return { ok: false, reason: 'Unknown channel' };
  const industryId = Number(match[1]);
  // Presidents and CIOs can always participate in any industry chat for
  // oversight. Other members must be in the industry.
  if (req.user.role === 'President' || req.user.role === 'CIO') return { ok: true };
  const membership = await prisma.userIndustry.findUnique({
    where: { userId_industryId: { userId: req.user.id, industryId } },
  });
  if (!membership) return { ok: false, reason: 'You are not a member of this industry' };
  return { ok: true };
}

// List channels the caller can access: always 'general', plus each industry
// they're a member of (or all industries if President/CIO).
router.get('/channels', async (req, res) => {
  let industries;
  if (req.user.role === 'President' || req.user.role === 'CIO') {
    industries = await prisma.industry.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  } else {
    const rows = await prisma.userIndustry.findMany({
      where: { userId: req.user.id },
      include: { industry: { select: { id: true, name: true } } },
    });
    industries = rows.map((r) => r.industry).sort((a, b) => a.name.localeCompare(b.name));
  }
  res.json({
    general: { key: 'general', label: 'General' },
    industries: industries.map((i) => ({
      key: `industry:${i.id}`,
      label: i.name,
      industryId: i.id,
    })),
  });
});

// Fetch recent messages for a channel. `since` = fetch only messages with
// id > since (incremental polling). Otherwise returns last 100.
router.get('/messages', async (req, res) => {
  const channel = String(req.query.channel || '');
  const since = req.query.since ? Number(req.query.since) : null;
  const access = await channelAccess(req, channel);
  if (!access.ok) return res.status(403).json({ error: access.reason });

  const where = { channel };
  if (since && Number.isFinite(since)) where.id = { gt: since };

  const messages = await prisma.chatMessage.findMany({
    where,
    include: { user: { select: { id: true, name: true, role: true } } },
    orderBy: { id: since ? 'asc' : 'desc' },
    take: since ? 200 : 100,
  });
  // When not polling (since=null), we fetched newest-first for the take limit;
  // the client wants chronological order so reverse it.
  if (!since) messages.reverse();
  res.json(messages);
});

router.post('/messages', postLimiter, async (req, res) => {
  const { channel, content } = req.body || {};
  if (!channel || typeof content !== 'string') {
    return res.status(400).json({ error: 'channel and content required' });
  }
  const trimmed = content.trim();
  if (!trimmed) return res.status(400).json({ error: 'Message cannot be empty' });
  if (trimmed.length > MESSAGE_MAX) {
    return res.status(400).json({ error: `Max ${MESSAGE_MAX} characters` });
  }
  const access = await channelAccess(req, channel);
  if (!access.ok) return res.status(403).json({ error: access.reason });

  const msg = await prisma.chatMessage.create({
    data: { channel, userId: req.user.id, content: trimmed },
    include: { user: { select: { id: true, name: true, role: true } } },
  });
  res.status(201).json(msg);
});

// Delete own message OR any message if President/CIO (for moderation).
router.delete('/messages/:id', async (req, res) => {
  const id = Number(req.params.id);
  const msg = await prisma.chatMessage.findUnique({ where: { id } });
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const isOwner = msg.userId === req.user.id;
  const isExec = req.user.role === 'President' || req.user.role === 'CIO';
  if (!isOwner && !isExec) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  await prisma.chatMessage.delete({ where: { id } });
  if (!isOwner) {
    await auditReq(req, 'chat.message_deleted_by_mod', 'chatMessage', id, {
      channel: msg.channel,
      authorId: msg.userId,
    });
  }
  res.json({ ok: true });
});

export default router;
