import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyJwt, requireTerminalAccess } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt, requireTerminalAccess);

// The club's shared subscriptions — WSJ and whatever else it pays for.
//
// The credentials live in Render's environment, not in our database.
// That was Thomas's call and it is the right one: every other secret
// this app holds is already an env var, a database column full of
// recoverable passwords is a different class of liability from anything
// else we store, and a leak of that table would be a leak of somebody's
// real account rather than of our own data.
//
// So this route is a reader over configuration, never a writer. There is
// no endpoint that sets a password. Adding a subscription means adding
// it in Render, which also means the people who can change it are
// exactly the people who already administer the deployment.
//
// SUBSCRIPTIONS is one JSON array:
//   [{"key":"wsj","label":"Wall Street Journal",
//     "loginUrl":"https://www.wsj.com/client/login",
//     "username":"...","password":"...",
//     "note":"Club account. Ask Thomas before changing the password."}]

/// Revealing a credential is rare and deliberate. This is loose enough
/// that nobody hits it working normally and tight enough that a stolen
/// token cannot walk the whole list repeatedly.
const revealLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many credential reads in an hour.' },
});

function parsed() {
  const raw = process.env.SUBSCRIPTIONS;
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    // A malformed variable is a configuration error, and returning an
    // empty list would render as "the club has no subscriptions" — a
    // sentence that is false and that nobody would think to question.
    console.error('SUBSCRIPTIONS is set but is not valid JSON — no subscriptions will be served');
    return null;
  }
}

/// The list, WITHOUT secrets. Nothing here is sensitive: it is the names
/// of publications the club pays for and where to sign in.
router.get('/', (_req, res) => {
  const list = parsed();
  if (list === null) {
    return res.status(500).json({
      error: 'The subscription list is misconfigured on the server.',
      configured: false,
    });
  }
  res.json({
    configured: list.length > 0,
    items: list.map((s) => ({
      key: String(s.key || '').slice(0, 40),
      label: String(s.label || s.key || 'Unnamed').slice(0, 120),
      loginUrl: s.loginUrl || null,
      note: s.note || null,
      // Whether a login exists at all is the difference between "sign in
      // with the club account" and "there is no club account for this",
      // and a reader needs to know which before clicking.
      hasCredentials: !!(s.username && s.password),
    })),
  });
});

/// The actual login, for one subscription, on request.
///
/// Logged by WHO and WHICH, never the value. A shared account with no
/// record of who used it is how a club discovers a password changed and
/// cannot find out by whom.
router.get('/:key/credentials', revealLimiter, (req, res) => {
  const list = parsed();
  if (list === null) return res.status(500).json({ error: 'The subscription list is misconfigured.' });
  const found = list.find((s) => String(s.key) === req.params.key);
  if (!found) return res.status(404).json({ error: 'No such subscription' });
  if (!found.username || !found.password) {
    return res.status(409).json({ error: `No stored login for ${found.label || found.key}.` });
  }
  console.log(
    `subscription credential read: ${found.key} by user ${req.user?.id} <${req.user?.email}>`
  );
  res.set('Cache-Control', 'no-store');
  res.json({
    key: found.key,
    label: found.label || found.key,
    loginUrl: found.loginUrl || null,
    username: found.username,
    password: found.password,
  });
});

export default router;
