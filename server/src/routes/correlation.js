import express from 'express';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';
import { getCorrelationMatrix } from '../services/correlation.js';

// CORR — the book's pairwise correlation matrix. Same gate as every
// other terminal data panel: any member who may open the terminal may
// see how the book hangs together.
//
// The service never throws and degrades to a well-shaped empty payload
// with the reason on it, so the panel can say WHY it is blank instead
// of painting an anonymous 500. The catch below is for the truly
// unexpected only.
const router = express.Router();
router.use(verifyJwt, requireTerminalAccess);

router.get('/', async (req, res) => {
  try {
    const data = await getCorrelationMatrix();
    res.json(data);
  } catch (err) {
    console.error('correlation read failed:', err?.message || err);
    res.status(500).json({ error: 'Could not load the correlation matrix' });
  }
});

export default router;
