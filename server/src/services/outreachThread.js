import prisma from '../db.js';
import { inboundOnThread } from './gmail.js';

/**
 * Where does this letter belong, if anywhere.
 *
 * A draft written to somebody we have already corresponded with should land
 * INSIDE that conversation, not beside it. Nothing passed a thread id before,
 * so every follow-up we have ever sent arrived as a fresh cold email with
 * "Re:" in front of it, which is worse than no Re: at all.
 *
 * This used to live in the deliver route, which meant the scheduler and the
 * batch send never called it: a chase sent by hand threaded, the same chase
 * queued for eight in the morning did not, and since almost the whole
 * campaign goes out queued, almost every chase left as a stranger. One
 * helper, three send paths.
 *
 * The Message-ID is read live from Gmail rather than from our own column,
 * deliberately: it works on the schema as it stands, and it is the recipient's
 * header that matters, not ours. Gmail threads on threadId for us; every other
 * client in the world threads on In-Reply-To for them.
 *
 * OUR messages stay in the thread read. The whole point of a chase is that
 * the person has not written back, so a thread read inbound-only is empty for
 * exactly the people this exists for, and the letter left with a threadId
 * Gmail honours and no In-Reply-To anybody else does. Sixteen chases on 25
 * Aug arrived that way. The last message on a silent thread is our own first
 * letter, and that is the right header to answer. mergeCc already drops
 * ourselves and the To address, so keeping our messages adds nobody to Cc.
 *
 * Best effort throughout. A letter that fails to thread must still be sent.
 */
export async function threadContextFor(draft, userId) {
  if (!draft?.targetId) return {};
  try {
    const prior = await prisma.outreachDraft.findFirst({
      where: { targetId: draft.targetId, gmailThreadId: { not: null }, id: { not: draft.id } },
      orderBy: { sentAt: 'desc' },
      select: { gmailThreadId: true },
    });
    if (!prior?.gmailThreadId) return {};
    let inReplyTo; let extraCc = [];
    try {
      const msgs = await inboundOnThread(userId, prior.gmailThreadId, { keepOurs: true });
      const last = msgs[msgs.length - 1];
      inReplyTo = last?.rfcMessageId;
      // Anyone already on the conversation stays on it, for the same reason
      // the reply route does it: dropping them is invisible to us and very
      // visible to them.
      if (last) {
        extraCc = [last.toHeader, last.ccHeader]
          .filter(Boolean).join(',').split(',')
          .map((x) => x.trim()).filter(Boolean);
      }
    } catch { /* a thread we cannot read still threads on threadId alone */ }
    return { threadId: prior.gmailThreadId, inReplyTo: inReplyTo || undefined, extraCc };
  } catch {
    return {};
  }
}
