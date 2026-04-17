import crypto from 'node:crypto';
import prisma from '../db.js';
import { sendNewDeviceLoginEmail } from './email.js';

function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    ''
  );
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

/**
 * On a successful login, check whether this IP has been seen for the user
 * before. If this is the first login ever we silently record it. If the
 * user has prior known IPs but this one is new, we email them an alert.
 */
export async function trackLogin(user, req) {
  const ip = getIp(req);
  if (!ip) return;
  const ipHash = hashIp(ip);
  const userAgent = (req.headers['user-agent'] || '').slice(0, 200);

  const existing = await prisma.knownLogin.findUnique({
    where: { userId_ipHash: { userId: user.id, ipHash } },
  });

  if (existing) {
    await prisma.knownLogin.update({
      where: { id: existing.id },
      data: { lastSeen: new Date(), userAgent },
    });
    return;
  }

  const priorCount = await prisma.knownLogin.count({ where: { userId: user.id } });
  await prisma.knownLogin.create({
    data: { userId: user.id, ipHash, userAgent },
  });

  // Only alert if this is NOT the user's first ever login.
  if (priorCount > 0) {
    try {
      await sendNewDeviceLoginEmail(user.email, {
        name: user.name,
        ip,
        userAgent,
        when: new Date().toLocaleString('en-US', {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }),
      });
    } catch (err) {
      console.error('New-device login email failed:', err.message);
    }
  }
}
