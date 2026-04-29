import { Router } from 'express';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';
import { probeProviders } from '../services/llm.js';
import { ensureRecurringMeetings } from '../services/recurringMeetings.js';

const router = Router();

// Admin-only live health check for the LLM providers that power Week in
// Review, article ranking, per-article summaries, and vote synthesis.
router.get('/llm-status', verifyJwt, requireAdmin, async (_req, res) => {
  const status = await probeProviders();
  res.json(status);
});

// Admin-only trigger for the recurring-meeting reconciler. Normally runs
// once at API startup — this lets a President kick it without waiting for
// the next deploy if a meeting was inadvertently deleted from the DB.
router.post(
  '/recurring-meetings/sync',
  verifyJwt,
  requireAdmin,
  async (_req, res) => {
    try {
      await ensureRecurringMeetings();
      res.json({ ok: true });
    } catch (err) {
      console.error('manual recurring-meetings sync failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

export default router;
