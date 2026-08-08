import express from 'express';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getEcoCalendar, _lastRawSample } from '../services/ecoCalendar.js';
import { isSuperAdminEmail } from '../middleware/auth.js';

// ECO — the terminal's economic calendar. Same gate as every other
// terminal surface: any member who can open the terminal can see the
// macro calendar; there is nothing position- or member-specific in it.
const router = express.Router();
router.use(verifyJwt, requireTerminalAccess);

router.get('/', async (req, res) => {
  try {
    const data = await getEcoCalendar(
      req.query.fresh === '1' && isSuperAdminEmail(req.user?.email)
        ? { forceFresh: true }
        : {}
    );
    // Diagnosis peephole, super admin only: what FRED actually sent for
    // the upcoming half, trimmed to three rows. Costs nothing, removed
    // the guesswork the first production miss required.
    if (req.query.raw === '1' && isSuperAdminEmail(req.user?.email)) {
      return res.json({ ...data, _rawSample: _lastRawSample() });
    }
    res.json(data);
  } catch (err) {
    // getEcoCalendar is contracted never to throw; this is the seatbelt
    // for the contract being broken, not an expected path.
    console.error('ECO route failed:', err);
    res.status(500).json({ error: 'Failed to load the economic calendar' });
  }
});

export default router;
