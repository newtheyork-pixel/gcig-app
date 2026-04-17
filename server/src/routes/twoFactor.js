import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { verifyJwt, issueJwt } from '../middleware/auth.js';
import { authLimiter, codeLimiter } from '../middleware/rateLimit.js';
import { auditReq } from '../services/audit.js';
import {
  generateSecret,
  buildQrCodeDataUrl,
  verifyToken,
  generateBackupCodes,
  consumeBackupCode,
  generateEmailCode,
  consumeEmailCode,
} from '../services/twoFactor.js';
import { sendTwoFactorCodeEmail } from '../services/email.js';

const router = Router();

// Short-lived "you've passed password, now prove TOTP" challenge token.
const CHALLENGE_TTL = '5m';

function signChallenge(userId) {
  return jwt.sign(
    { id: userId, purpose: '2fa_challenge' },
    process.env.JWT_SECRET,
    { expiresIn: CHALLENGE_TTL }
  );
}

function verifyChallenge(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.purpose !== '2fa_challenge') return null;
    return payload.id;
  } catch {
    return null;
  }
}

// ── SETUP ────────────────────────────────────────────────────────────

// Begin TOTP enrollment: generate a secret, store it (disabled until verified),
// return QR + recovery codes. Can be called again to regenerate (wipes prior
// pending/confirmed 2FA).
router.post('/setup', verifyJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.twoFactorEnabled) {
      return res
        .status(400)
        .json({ error: '2FA is already enabled. Disable it first to regenerate.' });
    }

    const secret = generateSecret();
    const { plain, hashed } = await generateBackupCodes(8);
    const qrCodeDataUrl = await buildQrCodeDataUrl(user.email, secret);

    await prisma.$transaction([
      prisma.backupCode.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorSecret: secret,
          twoFactorMethod: 'totp',
          twoFactorEnabled: false,
        },
      }),
      prisma.backupCode.createMany({
        data: hashed.map((codeHash) => ({ userId: user.id, codeHash })),
      }),
    ]);

    await auditReq(req, '2fa.setup_started', 'user', user.id);

    res.json({
      method: 'totp',
      secret,
      qrCodeDataUrl,
      backupCodes: plain,
    });
  } catch (err) {
    console.error('2FA TOTP setup failed:', err);
    res.status(500).json({ error: `Setup failed: ${err.message}` });
  }
});

// Begin EMAIL enrollment: generate an 8-char code, email it, and store its
// hash. User confirms by entering the code.
router.post('/setup-email', verifyJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.twoFactorEnabled) {
      return res
        .status(400)
        .json({ error: '2FA is already enabled. Disable it first to regenerate.' });
    }

    const code = generateEmailCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Clear prior pending codes + backup codes.
    await prisma.$transaction([
      prisma.twoFactorCode.deleteMany({ where: { userId: user.id } }),
      prisma.backupCode.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorMethod: 'email',
          twoFactorSecret: null,
          twoFactorEnabled: false,
        },
      }),
      prisma.twoFactorCode.create({
        data: { userId: user.id, codeHash, expiresAt, purpose: 'setup' },
      }),
    ]);

    await sendTwoFactorCodeEmail(user.email, { name: user.name, code });
    await auditReq(req, '2fa.setup_started', 'user', user.id, { method: 'email' });
    res.json({ method: 'email', email: user.email });
  } catch (err) {
    console.error('2FA email setup failed:', err);
    res.status(500).json({ error: `Setup failed: ${err.message}` });
  }
});

// Confirm TOTP enrollment by providing a current code from the app.
router.post('/verify-setup', verifyJwt, codeLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorSecret) {
    return res.status(400).json({ error: 'No setup in progress. Start again.' });
  }
  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA already enabled' });
  }
  if (!verifyToken(user.twoFactorSecret, code)) {
    return res.status(400).json({ error: 'Incorrect code. Check your authenticator app.' });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true },
  });
  await auditReq(req, '2fa.enabled', 'user', user.id, { method: 'totp' });
  res.json({ ok: true });
});

// Confirm email enrollment by providing the 8-char code we emailed.
router.post('/verify-setup-email', verifyJwt, codeLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA already enabled' });
  }
  if (user.twoFactorMethod !== 'email') {
    return res.status(400).json({ error: 'No email 2FA setup in progress. Start again.' });
  }
  const ok = await consumeEmailCode(prisma, user.id, code, 'setup');
  if (!ok) {
    return res.status(400).json({ error: 'Incorrect or expired code. Try again or resend.' });
  }

  // Also generate recovery backup codes so the member has a fallback.
  const { plain, hashed } = await generateBackupCodes(8);
  await prisma.$transaction([
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
    prisma.backupCode.createMany({
      data: hashed.map((codeHash) => ({ userId: user.id, codeHash })),
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true },
    }),
  ]);

  await auditReq(req, '2fa.enabled', 'user', user.id, { method: 'email' });
  res.json({ ok: true, backupCodes: plain });
});

// Resend the email setup code (fresh 10-min window).
router.post('/resend-setup-email', verifyJwt, codeLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.twoFactorEnabled || user.twoFactorMethod !== 'email') {
    return res.status(400).json({ error: 'No email 2FA setup in progress' });
  }
  const code = generateEmailCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.$transaction([
    prisma.twoFactorCode.deleteMany({ where: { userId: user.id, purpose: 'setup' } }),
    prisma.twoFactorCode.create({
      data: { userId: user.id, codeHash, expiresAt, purpose: 'setup' },
    }),
  ]);
  try {
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'setup' });
  } catch (err) {
    console.error('Resend 2FA setup email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

// Disable 2FA on your own account — requires password + a current code.
router.post('/disable', verifyJwt, authLimiter, async (req, res) => {
  const { password, code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const pwOk = await bcrypt.compare(password, user.passwordHash);
  if (!pwOk) return res.status(401).json({ error: 'Incorrect password' });

  if (user.twoFactorEnabled) {
    const codeOk =
      verifyToken(user.twoFactorSecret, code) ||
      (await consumeBackupCode(prisma, user.id, code));
    if (!codeOk) {
      return res.status(400).json({ error: 'Incorrect 2FA code' });
    }
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        tokenVersion: { increment: 1 }, // nuke other sessions just in case
      },
    }),
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
  ]);
  await auditReq(req, '2fa.disabled', 'user', user.id);

  // Re-issue token for the caller so they stay logged in on this device.
  const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
  const token = issueJwt(refreshed);
  res.json({ ok: true, token });
});

// Regenerate backup codes (keeps 2FA enabled; invalidates all old codes).
router.post('/regenerate-backup-codes', verifyJwt, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA is not enabled' });
  }
  const { plain, hashed } = await generateBackupCodes(8);
  await prisma.$transaction([
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
    prisma.backupCode.createMany({
      data: hashed.map((codeHash) => ({ userId: user.id, codeHash })),
    }),
  ]);
  await auditReq(req, '2fa.backup_codes_regenerated', 'user', user.id);
  res.json({ backupCodes: plain });
});

// ── LOGIN (2nd factor) ───────────────────────────────────────────────

// Second step of login when 2FA is enabled. Takes the challenge token from
// /auth/login + one of: a TOTP code, an emailed login code, or a backup code.
router.post('/login', codeLimiter, async (req, res) => {
  const { challengeToken, code } = req.body || {};
  const userId = verifyChallenge(challengeToken);
  if (!userId) {
    return res.status(401).json({ error: 'Challenge expired. Sign in again.' });
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA not enabled on this account' });
  }

  let method = null;
  if (user.twoFactorMethod === 'totp' && verifyToken(user.twoFactorSecret, code)) {
    method = 'totp';
  } else if (
    user.twoFactorMethod === 'email' &&
    (await consumeEmailCode(prisma, user.id, code, 'login'))
  ) {
    method = 'email';
  } else if (await consumeBackupCode(prisma, user.id, code)) {
    method = 'backup';
  }

  if (!method) {
    await auditReq(
      { ...req, user: { id: user.id, name: user.name } },
      '2fa.login_failed',
      'user',
      user.id
    );
    return res.status(400).json({ error: 'Incorrect code' });
  }

  const jwtToken = issueJwt(user);
  await auditReq(
    { ...req, user: { id: user.id, name: user.name, role: user.role } },
    method === 'backup' ? '2fa.login_backup_code' : '2fa.login_success',
    'user',
    user.id,
    { method }
  );
  res.json({
    token: jwtToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// Resend the login email code (fresh 10-min window) — requires a valid
// challenge token so only the person partway through a login can trigger it.
router.post('/resend-login-email', codeLimiter, async (req, res) => {
  const { challengeToken } = req.body || {};
  const userId = verifyChallenge(challengeToken);
  if (!userId) {
    return res.status(401).json({ error: 'Challenge expired. Sign in again.' });
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.twoFactorEnabled || user.twoFactorMethod !== 'email') {
    return res.status(400).json({ error: 'Email 2FA is not enabled' });
  }
  const code = generateEmailCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.$transaction([
    prisma.twoFactorCode.deleteMany({ where: { userId: user.id, purpose: 'login' } }),
    prisma.twoFactorCode.create({
      data: { userId: user.id, codeHash, expiresAt, purpose: 'login' },
    }),
  ]);
  try {
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'login' });
  } catch (err) {
    console.error('Resend 2FA login email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

// Admin: reset 2FA on another user's account (lost-phone + lost-backup recovery).
// Destructive — deletes their secret and backup codes; they'll log in with
// password alone until they re-enroll.
router.post('/admin-reset/:id', verifyJwt, async (req, res) => {
  if (req.user.role !== 'President') {
    return res.status(403).json({ error: 'President only' });
  }
  const id = Number(req.params.id);
  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.backupCode.deleteMany({ where: { userId: id } }),
  ]);
  await auditReq(req, '2fa.admin_reset', 'user', id);
  res.json({ ok: true });
});

export default router;

// Exported helpers for use by /auth/login
export { signChallenge };
