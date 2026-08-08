import express from 'express';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getHalts } from '../services/tradingHalts.js';

const router = express.Router();
router.use(verifyJwt, requireTerminalAccess);

// HALT — the merged Nasdaq + NYSE halt tape, served as-is from the
// service. The one thing the route adds is the held flag: the client
// may pass ?held=AIT,GD,… and matching rows come back with held:true,
// so "one of OURS is halted" is decided server-side against the exact
// list the caller vouched for rather than re-derived in the panel.
// Symbols that fail the ticker shape are dropped, not 400'd — a
// malformed entry in a comma list should cost that entry only.
router.get('/', async (req, res) => {
  try {
    const heldSymbols = String(req.query.held || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z][A-Z0-9.\-]{0,11}$/.test(s));
    const held = new Set(heldSymbols);

    const data = await getHalts(); // never throws; worst case is empty
    res.json({
      ...data,
      heldSymbols,
      halts: held.size
        ? data.halts.map((h) => (held.has(h.symbol) ? { ...h, held: true } : h))
        : data.halts,
    });
  } catch (err) {
    console.error('halts read failed:', err.message);
    res.status(500).json({ error: 'Could not load trading halts' });
  }
});

export default router;
