import express from 'express';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getEcoCalendar } from '../services/ecoCalendar.js';

// ECO — the terminal's economic calendar. Same gate as every other
// terminal surface: any member who can open the terminal can see the
// macro calendar; there is nothing position- or member-specific in it.
const router = express.Router();
router.use(verifyJwt, requireTerminalAccess);

router.get('/', async (req, res) => {
  try {
    const data = await getEcoCalendar();
    res.json(data);
  } catch (err) {
    // getEcoCalendar is contracted never to throw; this is the seatbelt
    // for the contract being broken, not an expected path.
    console.error('ECO route failed:', err);
    res.status(500).json({ error: 'Failed to load the economic calendar' });
  }
});

export default router;
