import { PrismaClient } from '@prisma/client';
import { gmailConfigured, inboundOnThread, classify } from './gmail.js';

const prisma = new PrismaClient();

// Pulling replies in, on a timer, for everyone who has connected a mailbox.
//
// This was a button. A button is the wrong shape for it: the whole promise
// of the reply loop is that nobody has to remember, and a sweep that only
// runs when somebody presses SWEEP is a sweep that runs on the days you
// were already paying attention. The days that matter are the other ones.
//
// Idempotent by database constraint rather than by scheduling care:
// gmailMessageId is unique on OutreachMessage, so this racing a member's
// own sweep, or two ticks overlapping, cannot log a reply twice.

export async function sweepAll() {
  if (!gmailConfigured()) return { skipped: 'not configured' };

  const accounts = await prisma.gmailAccount.findMany({
    where: { revokedAt: null },
    select: { userId: true, address: true },
  });
  if (!accounts.length) return { accounts: 0 };

  let added = 0, threads = 0;
  const errors = [];
  for (const acct of accounts) {
    // Only threads this member's own drafts started. The same fence the
    // manual sweep keeps, and the reason gmail.readonly is defensible: a
    // timer that widened the read would be worse than a button that did.
    const drafts = await prisma.outreachDraft.findMany({
      where: { gmailThreadId: { not: null }, authorId: acct.userId },
      select: { id: true, targetId: true, gmailThreadId: true },
      orderBy: { id: 'desc' },
      take: 300,
    });
    for (const d of drafts) {
      threads += 1;
      let msgs;
      try {
        msgs = await inboundOnThread(acct.userId, d.gmailThreadId);
      } catch (err) {
        errors.push(`${acct.address} ${d.gmailThreadId}: ${err.message}`);
        // A refused credential refuses every remaining thread for this
        // member, so stop rather than generating three hundred identical
        // failures on every tick, forever.
        if (/reconnect|refused the saved/i.test(err.message)) break;
        continue;
      }
      for (const m of msgs) {
        try {
          await prisma.outreachMessage.create({
            data: {
              targetId: d.targetId, draftId: d.id, direction: 'in',
              kind: classify(m), occurredAt: m.occurredAt,
              body: m.body?.slice(0, 20_000) || null,
              gmailMessageId: m.gmailMessageId, recordedById: null,
            },
          });
          added += 1;
        } catch (err) {
          if (err?.code !== 'P2002') errors.push(`${m.gmailMessageId}: ${err.message}`);
        }
      }
    }
    await prisma.gmailAccount.updateMany({
      where: { userId: acct.userId }, data: { lastSyncAt: new Date() },
    });
  }
  return { accounts: accounts.length, threads, added, errors: errors.slice(0, 5) };
}
