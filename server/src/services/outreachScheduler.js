import { PrismaClient } from '@prisma/client';
import { renderSignature } from './outreachSignature.js';
import { sendAs, gmailConfigured, maySendMail } from './gmail.js';

const prisma = new PrismaClient();

// Drafts that were told to go later, going.
//
// The point of scheduling outreach is not convenience, it is arrival time.
// A cold email that lands at 8am on a Monday is read; the same words at
// 11pm on a Saturday are archived unread, and nobody is going to sit at a
// desk at eight in the morning pressing send forty times.
//
// Three rules this file exists to keep.
//
// It sends AS the person who scheduled it, from their mailbox, over their
// credential. A queue that sent as whoever the process happened to run as
// would put one member's name on another's outreach.
//
// It re-checks every gate at the moment of sending rather than trusting
// the moment of scheduling. A draft can be edited, rejected, screened
// differently, or already sent by hand in the days between, and the
// screen's verdict at schedule time is not evidence about the words that
// would actually leave now.
//
// A failure is RECORDED on the draft and the schedule is cleared. A draft
// that silently stopped being scheduled is indistinguishable from one
// nobody scheduled, and the person who queued it would never learn.

export async function runDueSends(now = new Date()) {
  if (!gmailConfigured()) return { skipped: 'not configured' };

  const due = await prisma.outreachDraft.findMany({
    where: {
      scheduledFor: { lte: now },
      sentAt: null,
      rejectedAt: null,
    },
    orderBy: { scheduledFor: 'asc' },
    take: 40,
    include: { target: true, scheduledBy: true },
  });
  if (!due.length) return { due: 0, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const d of due) {
    const fail = async (why) => {
      failed += 1;
      await prisma.outreachDraft.update({
        where: { id: d.id },
        data: { scheduledFor: null, scheduleError: why.slice(0, 400) },
      });
    };

    const user = d.scheduledBy;
    if (!user) { await fail('The member who scheduled this no longer has an account.'); continue; }
    if (!maySendMail(user)) { await fail(`${user.email} is no longer a permitted sender.`); continue; }
    if (!d.screenedAt) { await fail('Nothing screened this draft.'); continue; }
    if (d.screenRisk === 'prohibited') { await fail(`Compliance blocked it: ${d.screenReason || 'no reason recorded'}`); continue; }

    const to = (d.target?.email || '').trim();
    if (!to || !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(to)) {
      await fail(`No usable address (${to || 'blank'}).`); continue;
    }

    // The signature resolves for the SENDER, which here is the person who
    // scheduled it rather than whoever happens to read the draft later.
    //
    // Through the shared helper, because this used to build its own block
    // and dropped the title line while doing it. The preview in the
    // terminal said "President, The Griffin Fund" and the letter that left
    // said "The Griffin Fund", and since almost the whole Signet campaign
    // was scheduled rather than sent by hand, almost the whole campaign
    // went out unsigned by office.
    const body = renderSignature(String(d.body || ''), user);

    let out;
    try {
      out = await sendAs(user.id, { to, subject: d.subject, body, fromName: user.name });
    } catch (err) {
      await fail(`Gmail refused it: ${err.message}`);
      // A refused credential will refuse every remaining send by this
      // member, so stop rather than burning the whole queue against it.
      if (/reconnect|refused the saved/i.test(err.message)) break;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.outreachDraft.update({
          where: { id: d.id },
          data: {
            sentAt: new Date(), sentById: user.id, sentBody: body,
            scheduledFor: null, scheduleError: null,
            gmailThreadId: out.threadId, gmailMessageId: out.messageId, sentVia: 'gmail',
          },
        });
        await tx.outreachMessage.create({
          data: {
            targetId: d.targetId, draftId: d.id, direction: 'out', kind: 'Other',
            occurredAt: new Date(), body: body.slice(0, 20_000),
            gmailMessageId: out.messageId, recordedById: user.id,
          },
        });
        const t = await tx.researchTarget.findUnique({ where: { id: d.targetId }, select: { status: true } });
        // Queued is BEHIND Contacted, so it must not be treated as ahead:
        // a letter that has now actually left has to advance the row past
        // the state that only meant it was waiting to.
        const AHEAD = new Set(['Scheduled', 'Completed', 'Declined']);
        await tx.researchTarget.update({
          where: { id: d.targetId },
          data: { ...(AHEAD.has(t?.status) ? {} : { status: 'Contacted' }), lastContactAt: new Date() },
        });
      });
      sent += 1;
    } catch (err) {
      // Sent and unrecorded. Recorded AS such rather than left to look
      // unsent, because the queue would otherwise send it again on the
      // next tick, which is the one failure worth engineering against.
      console.error('scheduled send delivered but not recorded:', d.id, out.messageId, err.message);
      await prisma.outreachDraft.update({
        where: { id: d.id },
        data: { scheduledFor: null, sentAt: new Date(), sentById: user.id,
                gmailMessageId: out.messageId, gmailThreadId: out.threadId, sentVia: 'gmail',
                scheduleError: 'SENT, but the ledger row failed to write. Do not resend.' },
      });
      failed += 1;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { due: due.length, sent, failed };
}
