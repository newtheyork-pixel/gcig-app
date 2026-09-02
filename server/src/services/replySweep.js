import { triageReply } from './replyTriage.js';
import { PrismaClient } from '@prisma/client';
import { gmailConfigured, inboundOnThread, classify } from './gmail.js';
import { shouldClaimTwin } from './outreachTwin.js';

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
      select: { id: true, targetId: true, gmailThreadId: true, gmailMessageId: true },
      orderBy: { id: 'desc' },
      // No cap. There was one, at three hundred newest, and the campaign
      // outgrew it: once a chase is written for every quiet thread the
      // rows past three hundred are exactly the ones nobody is writing to
      // again, which are the people whose late reply would otherwise be
      // the only thing we ever learn from them. A thread read is one
      // Gmail call; four hundred of them is under a minute.
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
          let freshlyRecorded = false;
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
            freshlyRecorded = true;
          } catch (err) {
            if (err?.code !== 'P2002') errors.push(`out ${m.gmailMessageId}: ${err.message}`);
          }
          // And if a draft for this person was still sitting unsent with
          // the same subject, it is the letter that just went. Marking it
          // stops the terminal offering to send it a second time.
          //
          // Only for a letter the ledger has never seen. This block used to
          // run on every pass, and the letter it re-reads most is our own
          // first one, whose subject is exactly what every chase staged
          // under it carries after the Re:. Left as it was, the tick after
          // a hundred and sixty-five follow-ups were written would have
          // marked all of them sent, dated to the letter they were chasing,
          // and the scheduler would have skipped every one. outreachTwin.js
          // holds the rule and its tests.
          try {
            const twin = await prisma.outreachDraft.findFirst({
              where: { targetId: d.targetId, sentAt: null, rejectedAt: null },
              orderBy: { createdAt: 'desc' },
            });
            if (shouldClaimTwin({ freshlyRecorded, message: m, readingDraft: d, twin })) {
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
          const kind = classify(m);
          // Read it once, as it lands, rather than on every page load.
          // Fails open: no verdict leaves the columns null and the caller
          // keeps the old last-message-inbound rule.
          const verdict = ['Bounce', 'AutoReply'].includes(kind) ? null : await triageReply(m);
          await prisma.outreachMessage.create({
            data: {
              targetId: d.targetId, draftId: d.id, direction: 'in',
              kind,
              subject: m.subject ? String(m.subject).slice(0, 300) : null,
              rfcMessageId: m.rfcMessageId || null,
              occurredAt: m.occurredAt,
              body: m.body?.slice(0, 20_000) || null,
              replyNeeded: verdict ? verdict.replyNeeded : null,
              replyNote: verdict ? verdict.why : null,
              resumeAfter: verdict ? verdict.resumeAfter : null,
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
