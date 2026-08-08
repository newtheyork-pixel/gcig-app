import { Router } from 'express';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getDividends } from '../services/dividends.js';

// DVD — dividend history for one ticker, off the keyless NASDAQ quote
// API (services/dividends.js). Same terminal gate as the watchlist:
// Analyst and above, plus Advisory.
//
// The degrade is deliberately a 200: the service never throws, and an
// unknown symbol, a non-NASDAQ listing, or a throttled upstream all
// come back as empty rows with nulls and (when the upstream said so)
// a note explaining why. A dash the panel can explain beats a
// fabricated zero or an error page over a name that simply lists on
// the NYSE.

const router = Router();
router.use(verifyJwt, requireTerminalAccess);

router.get('/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    res.json(await getDividends(raw));
  } catch (err) {
    // Unreachable in normal operation — getDividends catches its own
    // trouble — so anything landing here is a bug worth a loud 502,
    // not a quiet empty table.
    console.error(`terminal/dividends(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Dividend fetch failed' });
  }
});

export default router;
