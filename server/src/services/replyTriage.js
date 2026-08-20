import { llmChat, RESEARCH_LOCAL_MODEL } from './llm.js';

// Does this reply actually ask anything of us?
//
// "The last message was inbound" is a bad proxy for "we owe a reply", and
// the desk was built on it. Andrew Hayashi wrote "Sure, email in October
// would be just fine! I can certainly get back to you then." That closes a
// loop rather than opening one, and he sat flagged as unanswered for two
// days while the panel told us to write to a man who had already told us
// when to write.
//
// Read once, when the message lands. Cheap model on purpose: the worst
// outcome is one unnecessary chase or one missed one, both of which a
// person catches by looking at the row. That is a different risk class from
// the MNPI screen, which is why this does NOT ask for quality.
//
// FAILS OPEN, which is the opposite of the compliance screen and correct
// here. If the model is unreachable we return null and the caller keeps the
// old rule, so an outage means the desk is merely as good as it was
// yesterday rather than silently dropping conversations on the floor.

export const SYSTEM_PROMPT = `You read one email that a professional sent to a student investment club, and decide whether the club still owes them an answer.

Return JSON only: {"replyNeeded": true|false, "why": "<12 words>", "resumeAfter": "YYYY-MM-DD"|null}

replyNeeded is FALSE when the exchange is closed or parked:
- they declined, and asked no question
- they answered fully and asked nothing back
- they said to come back at a stated time ("email me in October", "after the new year")
- they are out of office with a return date and nothing else
- they said someone else will follow up

replyNeeded is TRUE when the ball is with us:
- they asked a question
- they offered a call and want times, or proposed times to confirm
- they asked for something before they can help
- they said yes and are waiting on us to arrange it
- anything ambiguous. When unsure, say true. An unnecessary reply is a small cost; a source who thinks they were ignored is not.

resumeAfter is a date ONLY when they named a time to come back. Otherwise null. If they said a month with no day, use the first of that month.`;

export async function triageReply(message, deps = {}) {
  const text = String(message?.body || '').trim();
  if (!text) return null;
  const chat = deps.llmChat || llmChat;
  try {
    const out = await chat({
      job: 'triage',
      localModel: RESEARCH_LOCAL_MODEL,
      jsonMode: true,
      temperature: 0,
      timeoutMs: 20_000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content:
          `Subject: ${message?.subject || '(none)'}\nFrom: ${message?.from || 'the source'}\n\n${text.slice(0, 4000)}` },
      ],
    });
    if (!out) return null;
    const raw = typeof out === 'string' ? out : out.content || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (typeof j.replyNeeded !== 'boolean') return null;
    let resume = null;
    if (j.resumeAfter && /^\d{4}-\d{2}-\d{2}$/.test(j.resumeAfter)) {
      const d = new Date(`${j.resumeAfter}T00:00:00Z`);
      // A date in the past is a model mistake, not an instruction.
      if (!Number.isNaN(d.getTime()) && d > new Date()) resume = d;
    }
    return {
      replyNeeded: j.replyNeeded,
      why: String(j.why || '').slice(0, 200),
      resumeAfter: resume,
    };
  } catch {
    return null;
  }
}
