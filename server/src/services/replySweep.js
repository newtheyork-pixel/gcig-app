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

  let added = 0, addedOut = 0, claimed = 0, threads = 0, missing = 0;
  const errors = [];
  for (const acct of accounts) {
    // Only threads this member's own mailbox started. The same fence the
    // manual sweep keeps, and the reason gmail.readonly is defensible: a
    // timer that widened the read would be worse than a button that did.
    //
    // Keyed on who SENT it, not who wrote it. Those were the same person
    // for the first hundred sends and the distinction cost nothing, until
    // the day a second member connected a mailbox and sent a draft someone
    // else had drafted. Then the sweep asked the author's mailbox for a
    // thread that lives in the sender's, Gmail answered 404, and
    // inboundOnThread turned that into an empty list. The reply was not
    // lost loudly. It simply never arrived, the target stayed at Contacted,
    // and the chase panel went on recommending we write again to somebody
    // who had already answered.
    //
    // sentById is null only for drafts nobody has sent, which carry no
    // thread id either; the fallback covers any that predate the column.
    const drafts = await prisma.outreachDraft.findMany({
      where: {
        gmailThreadId: { not: null },
        OR: [
          { sentById: acct.userId },
          { AND: [{ sentById: null }, { authorId: acct.userId }] },
        ],
      },
      select: { id: true, targetId: true, gmailThreadId: true },
      orderBy: { id: 'desc' },
      take: 300,
    });
    for (const d of drafts) {
      threads += 1;
      let msgs;
      try {
        msgs = await inboundOnThread(acct.userId, d.gmailThreadId, { keepOurs: true });
      } catch (err) {
        // A thread that is not in this mailbox is now reported rather than
        // read as silence, but it must not stop the sweep: one deleted
        // conversation is not a reason to skip ninety-nine live ones.
        if (err?.threadMissing) { missing += 1; continue; }
        errors.push(`${acct.address} ${d.gmailThreadId}: ${err.message}`);
        // A refused credential refuses every remaining thread for this
        // member, so stop rather than generating three hundred identical
        // failures on every tick, forever.
        if (/reconnect|refused the saved/i.test(err.message)) break;
        continue;
      }
      for (const m of msgs) {
        // A letter sent straight from Gmail rather than from the terminal.
        //
        // The sweep only ever read INBOUND mail, so answering somebody in
        // their own thread from the Gmail web client left no trace here at
        // all: the draft stayed unsent, the ledger stayed empty, and the
        // panel went on saying we owed them a reply. Shane McMurray was
        // answered at 8am and the desk still had him flagged ten hours
        // later. Recording our own side closes that.
        if (m.isFromUs) {
          try {
            await prisma.outreachMessage.create({
              data: {
                targetId: d.targetId, draftId: d.id, direction: 'out',
                kind: 'Reply', occurredAt: m.occurredAt,
                subject: m.subject ? String(m.subject).slice(0, 300) : null,
                rfcMessageId: m.rfcMessageId || null,
                body: m.body?.slice(0, 20_000) || null,
                gmailMessageId: m.gmailMessageId,
                recordedById: null,
              },
            });
            addedOut += 1;
          } catch (err) {
            if (err?.code !== 'P2002') errors.push(`out ${m.gmailMessageId}: ${err.message}`);
          }
          // And if a draft for this person was still sitting unsent with
          // the same subject, it is the letter that just went. Marking it
          // stops the terminal offering to send it a second time.
          try {
            const norm = (v) => String(v || '').replace(/^\s*re:\s*/i, '').trim().toLowerCase();
            const twin = await prisma.outreachDraft.findFirst({
              where: { targetId: d.targetId, sentAt: null, rejectedAt: null },
              orderBy: { createdAt: 'desc' },
            });
            if (twin && norm(twin.subject) === norm(m.subject)) {
              await prisma.outreachDraft.update({
                where: { id: twin.id },
                data: { sentAt: m.occurredAt, sentVia: 'gmail-direct',
                        gmailMessageId: m.gmailMessageId, gmailThreadId: d.gmailThreadId },
              });
              claimed += 1;
            }
          } catch { /* matching is a convenience; the ledger row is the record */ }
          continue;
        }
        try {
          await prisma.outreachMessage.create({
            data: {
              targetId: d.targetId, draftId: d.id, direction: 'in',
                            kind: classify(m),
              subject: m.subject ? String(m.subject).slice(0, 300) : null,
              rfcMessageId: m.rfcMessageId || null,
              subject: m.subject ? String(m.subject).slice(0, 300) : null, occurredAt: m.occurredAt,
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
  return { accounts: accounts.length, threads, added, addedOut, claimed, errors: errors.slice(0, 5), missing };
}
