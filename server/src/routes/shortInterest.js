import express from 'express';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getShortInterest } from '../services/shortInterest.js';

// SI — short interest for one ticker, off two keyless FINRA feeds.
// Same gate as every other terminal data route: who may look is
// requireTerminalAccess's call, and there is nothing to mutate here.
const router = express.Router();
router.use(verifyJwt, requireTerminalAccess);

router.get('/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(ticker)) {
    return res.status(400).json({ error: 'A ticker is required' });
  }
  try {
    // The service never throws — feed outages ride back inside the
    // payload as available:false so the panel can name them instead
    // of rendering a company with no shorts.
    res.json(await getShortInterest(ticker));
  } catch (err) {
    console.error('short interest read failed:', err.message);
    res.status(500).json({ error: 'Could not load short interest' });
  }
});

export default router;
