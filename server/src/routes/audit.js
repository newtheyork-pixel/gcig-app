import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);
router.use(requireSuperAdmin);

// Super-admin only (app owner): tail of the audit log. Contains sensitive
// security signal (login attempts, password resets, IP addresses) so we
// don't expose it to every President.
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json(logs);
});

export default router;
