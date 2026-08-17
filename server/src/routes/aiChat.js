import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { llmChat, llmChatTools, RESEARCH_LOCAL_MODEL, llmChatStreamLocal, canStreamLocally } from '../services/llm.js';
import { TOOL_SPECS, runChatTool } from '../ai/chatTools.js';
import { getClubSystemPrompt } from '../ai/clubBrief.js';

// The Griffin Fund AI Assistant — conversational endpoint backed by the
// club's own local Ollama model (with OpenAI fallback). Open to every
// authenticated member.
//
// Conversations are server-owned: each turn the client sends only a
// sessionId + a new user message. The full history is loaded from the
// DB server-side before calling the model. This prevents a malicious
// client from forging "assistant" turns and asking the model to treat
// them as precedent. The system prompt (IPS + policies + live club
// data) is built by ai/clubBrief.js and is never client-controllable.

const router = Router();
router.use(verifyJwt);

// How many times the model may call a tool before we make it answer.
//
// Bounded because an unbounded loop is a way to burn the GPU and the
// member's patience on a question that is never going to resolve —
// three is enough for "price this, price that, now compare", and a
// model still asking on the fourth is looping rather than working.
const MAX_TOOL_ROUNDS = 3;

// One reply, with the model allowed to fetch what it needs first.
//
// Falls back to a plain completion if the tool path returns nothing, so
// a model that cannot do tool calling still answers from its context
// rather than failing outright.
async function runWithTools(messages, temperature) {
  const convo = [...messages];
  // What the member actually asked, kept aside so it can be put back in
  // front of the model after the tool output.
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  // Every number any tool actually returned this turn. The reply is
  // checked against it below.
  const fromTools = [];
  // What was looked up, for the member to see. An answer that came from
  // a live quote and one that came from the model's context read
  // identically otherwise, and only one of them is current.
  const used = [];
  // Tool call -> result, so a repeated identical request is answered
  // from cache rather than refetched.
  const seen = new Map();
  let gotData = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const out = await llmChatTools({
    job: 'chat',
      messages: convo,
      tools: TOOL_SPECS,
      temperature,
      timeoutMs: 120_000,
      localModel: RESEARCH_LOCAL_MODEL,
    });
    if (!out) break;

    const calls = out.toolCalls || [];
    if (calls.length === 0) {
      if (out.content) return { text: out.content, fromTools, used };
      break;
    }

    // The assistant turn that requested the tools has to go back in
    // verbatim, tool_calls and all, or the tool results below have
    // nothing to attach to and the model sees answers to questions it
    // never asked.
    convo.push({ role: 'assistant', content: out.content || '', tool_calls: calls });

    for (const call of calls) {
      const name = call?.function?.name;
      // The model re-asked for the identical thing rather than answering
      // — live, "what is the price of Apple" produced two identical
      // get_quote · AAPL calls and then a refusal. Serve the cached
      // answer instead of fetching twice, and stop it counting as
      // progress.
      const key = `${name}:${call?.function?.arguments || ''}`;
      const result = seen.has(key)
        ? seen.get(key)
        : await runChatTool(name, call?.function?.arguments);
      const repeat = seen.has(key);
      seen.set(key, result);
      const json = JSON.stringify(result);
      if (!repeat) used.push({
        name,
        // The argument that makes the call legible — a ticker, mostly.
        subject: (() => {
          try {
            const a = JSON.parse(call?.function?.arguments || '{}');
            return a.ticker || (Array.isArray(a.tickers) ? a.tickers.join(', ') : null);
          } catch { return null; }
        })(),
        // Whether it actually got anything. A failed lookup shown as a
        // successful one is the same lie in a smaller font.
        ok: !result?.error,
      });
      if (!result?.error) gotData = true;
      for (const m of json.matchAll(/-?\d+(?:\.\d+)?/g)) fromTools.push(m[0]);
      convo.push({ role: 'tool', tool_call_id: call.id, name, content: json });
    }

    // Restate the question after the tool output.
    //
    // Left alone, the conversation ends on a block of JSON and the model
    // loses what was asked — it fetched a good AAPL quote and then
    // replied "Sure, what would you like to know?", over and over. By
    // that point the question is thousands of characters back, behind a
    // system prompt and a tool payload. Putting it last is what makes it
    // the thing being answered.
    if (question) {
      convo.push({
        role: 'user',
        content: `Using the tool results above, answer my question: ${question}`,
      });
    }
  }

  // Either it ran out of rounds or the tool path was unavailable. Ask
  // once more without tools so there is always an answer.
  // Out of rounds. If tools DID return data, the model has an answer in
  // front of it and simply kept asking — live it went on to say "we did
  // not establish that based on our research" while a good AAPL quote
  // sat in the conversation. Make the last call an instruction to use
  // what it already has.
  if (gotData) {
    convo.push({
      role: 'system',
      content:
        'The tool results above contain what was asked for. Answer the ' +
        "member's question directly from them now. Do not call another " +
        'tool, and do not say the information was not established — that ' +
        'phrasing is only for questions about our own field research, not ' +
        'for market data you have just been handed.',
    });
  }
  const text = await llmChat({
    job: 'chat',
    messages: convo, temperature, localModel: RESEARCH_LOCAL_MODEL,
    timeoutMs: CHAT_TIMEOUT_MS,
  });
  return { text, fromTools, used };
}


/// How long a person will wait for a chat reply, versus how long a 14B
/// on a shared box actually needs.
///
/// llmChat's default is 25 seconds, which is a sensible ceiling for a
/// background summarisation and far too short for this. Measured on the
/// real tunnel: a 3,400-token prompt with a 600-token answer takes 23
/// seconds from a laptop, before Render's own hop. So every chat request
/// timed out by a hair and the panel said "AI provider unavailable"
/// while the tunnel, both models and the fallback probe were all
/// provably healthy — the least informative possible sentence about a
/// working system.
///
/// Ninety seconds is chosen against the human, not the machine: chat is
/// the one surface where somebody is watching a cursor blink and will
/// wait, and a slow answer beats a false report of an outage.
const CHAT_TIMEOUT_MS = 90_000;

/// Send the answer as it is written.
///
/// Server-sent events rather than a socket: this is one direction, one
/// response, and it survives a proxy that would drop a websocket. The
/// client reads it with fetch + a reader rather than EventSource,
/// because EventSource cannot carry the Authorization header and this
/// route is authenticated.
async function streamReply({ req, res, session, modelMessages, temp, startedAt, message }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer an event stream into uselessness unless
    // told not to. Harmless where nothing is listening.
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('open', { sessionId: session.id });

  let full = '';
  try {
    full = await llmChatStreamLocal({
      messages: modelMessages,
      temperature: temp,
      localModel: RESEARCH_LOCAL_MODEL,
      timeoutMs: CHAT_TIMEOUT_MS,
      onToken: (piece) => send('token', piece),
    });
  } catch (err) {
    console.warn('aiChat stream failed:', err.message);
    // Nothing partial is kept. A half-written answer saved as an answer
    // is worse than no answer, because it reads as complete.
    send('error', {
      error: 'The assistant stopped part way through. Nothing was saved — try again.',
    });
    return res.end();
  }

  // The same guards the blocking path applies, applied late because
  // that is when the text exists. A tripped guard retracts.
  let reply = full;
  if (looksLikeLeakedToolCall(reply)) {
    reply = null;
  } else if (unbackedPrice(reply, [])) {
    console.warn('aiChat stream: reply carried an unbacked figure; retracting');
    reply = null;
  }
  if (!reply) {
    send('retract', {
      reason: 'That draft stated a figure nothing backed it up with, so it was withdrawn. '
        + 'Ask again and it will answer from what it can actually cite.',
    });
    return res.end();
  }

  const latencyMs = Date.now() - startedAt;
  await prisma.aiChatMessage.create({
    data: {
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      model: process.env.LOCAL_LLM_URL ? 'local?' : 'unknown',
      latencyMs,
    },
  });

  let title = session.title;
  if (!title) {
    title = truncateTitle(message, 80);
    await prisma.aiChatSession.update({ where: { id: session.id }, data: { title, updatedAt: new Date() } });
  } else {
    await prisma.aiChatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
  }

  send('done', { sessionId: session.id, title, latencyMs });
  res.end();
}

// A price in a reply that came from nowhere.
//
// Live, the assistant answered "AIT is trading at $123.45 per share" and
// called it "Advanced Infrastructure Technologies Inc". Both invented;
// the real answer is Applied Industrial Technologies at $347.06, which
// it produced correctly on the next attempt. Prompting cannot make that
// reliable, and a fabricated price handed to a member is the single
// worst thing this assistant can do — someone acts on it.
//
// So a money figure has to be traceable to something a tool actually
// returned this turn. Anything else is treated as invented.
//
// Deliberately narrow: only currency-marked figures are checked, so
// ordinary prose about percentages, dates and counts is untouched. And
// it only applies when tools ran — a general conversation about
// valuation methods that never quotes a live price is not the target.
const MONEY = /(?:\$|USD\s?|CHF\s?)(\d[\d,]*(?:\.\d+)?)/gi;

function unbackedPrice(text, fromTools) {
  if (typeof text !== 'string' || fromTools.length === 0) return null;
  const seen = new Set(fromTools.map((n) => String(Number(n))));
  for (const m of text.matchAll(MONEY)) {
    const raw = m[1].replace(/,/g, '');
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    // Tolerate rounding: 347.06 reported as 347 is the same number.
    const ok = [...seen].some((v) => {
      const d = Math.abs(Number(v) - n);
      return d < 0.01 || (n !== 0 && d / Math.abs(n) < 0.005);
    });
    if (!ok) return m[0];
  }
  return null;
}

// The local model sometimes emits a tool call as PROSE rather than as a
// structured tool_calls field — literal `{"name": "get_quote", ...}` and
// stray `</tool_call>` tags land in the reply and go straight to a
// member. It is a model limitation rather than something the prompt can
// be talked out of, so the transport refuses to pass it on.
//
// Deliberately not "clean it up and send the rest": a reply carrying
// half a tool call is a reply where the model never got its answer, and
// the tidied remainder reads like a real response to a question that was
// never actually resolved.
const TOOL_SYNTAX = /<\/?tool_call>|\{\s*"name"\s*:\s*"(get_quote|get_company_snapshot|get_recent_filings)"/i;

function looksLikeLeakedToolCall(text) {
  return typeof text === 'string' && TOOL_SYNTAX.test(text);
}

// 60 requests / 10 minutes per user. Generous for normal Q&A, tight
// enough to catch a runaway client or bulk-prompt abuse.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `ai-chat:${req.user?.id || req.ip}`,
  message: { error: 'AI Assistant rate limit reached. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const MAX_MESSAGE_CHARS = 8_000;
const MAX_TURNS_PER_SESSION = 80; // 40 user + 40 assistant
const MAX_TOTAL_SESSION_CHARS = 60_000; // matches the model's usable context

function truncateTitle(s, n = 80) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).trimEnd() + '…';
}

// ------------------------------------------------------------
// Session listing + management
// ------------------------------------------------------------

router.get('/sessions', async (req, res) => {
  const sessions = await prisma.aiChatSession.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  res.json(
    sessions.map((s) => ({
      id: s.id,
      title: s.title || 'New conversation',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s._count.messages,
    }))
  );
});

router.get('/sessions/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad session id' });
  const session = await prisma.aiChatSession.findUnique({
    where: { id },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });
  if (!session || session.userId !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({
    id: session.id,
    title: session.title || 'New conversation',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages,
  });
});

router.delete('/sessions/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad session id' });
  const session = await prisma.aiChatSession.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!session || session.userId !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }
  await prisma.aiChatSession.delete({ where: { id } });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// Send a turn
// ------------------------------------------------------------

router.post('/', chatLimiter, async (req, res) => {
  const { sessionId, message, temperature } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res
      .status(400)
      .json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` });
  }
  const temp =
    typeof temperature === 'number' && temperature >= 0 && temperature <= 2
      ? temperature
      : 0.7;

  // Resolve (or create) the session. A client-supplied sessionId must
  // belong to the current user — otherwise we treat it as "start new".
  let session = null;
  if (sessionId != null) {
    const id = Number(sessionId);
    if (Number.isFinite(id)) {
      session = await prisma.aiChatSession.findUnique({ where: { id } });
      if (session && session.userId !== req.user.id) session = null;
    }
  }
  if (!session) {
    session = await prisma.aiChatSession.create({
      data: { userId: req.user.id },
    });
  }

  // Load the existing thread. If it's already past the turn / size caps,
  // refuse — the user should start a new conversation.
  const priorMessages = await prisma.aiChatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });
  if (priorMessages.length >= MAX_TURNS_PER_SESSION) {
    return res.status(400).json({
      error: 'This conversation is at the turn limit. Start a new chat.',
    });
  }
  const priorChars = priorMessages.reduce((s, m) => s + m.content.length, 0);
  if (priorChars + message.length > MAX_TOTAL_SESSION_CHARS) {
    return res.status(400).json({
      error: 'This conversation has grown too long. Start a new chat.',
    });
  }

  // Persist the user turn before calling the model — that way if the LLM
  // errors we still have a record + the UI can retry against the same
  // session without losing the message.
  await prisma.aiChatMessage.create({
    data: { sessionId: session.id, role: 'user', content: message.trim() },
  });

  // Build the model input: server system prompt + thread from DB.
  // The last few turns, not just this message: a member who asks about
  // Lindt and then says "and what is it trading at" should still have
  // the project loaded.
  const topic = [...priorMessages.slice(-4).map((m) => m.content), message]
    .join(' ')
    .slice(0, 2000);
  const systemPrompt = await getClubSystemPrompt({ user: req.user, topic });
  const modelMessages = [
    { role: 'system', content: systemPrompt },
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message.trim() },
  ];

  const startedAt = Date.now();
  // The same weights the research pipeline uses, and for the same
  // reason. Asked to quote our own DCF verbatim, the small model
  // returned "$75 per share" and an EV/EBITDA of 12.0x — figures that
  // appear nowhere in our data, presented as a quotation from our
  // research. It is not a retrieval gap: the model could read back the
  // section heading correctly, then invented the contents beneath it.
  // A model that fabricates a citation is worse than one that declines,
  // because the fabrication carries the authority of the section it
  // claims to be quoting.
  //
  // Tools go in for the same reason. The prompt carries a portfolio
  // snapshot from the last sync, so asked what a name is trading at the
  // model either quoted a stale figure as current or made one up. Now it
  // can go and look.
  // Tools are OFF unless explicitly enabled.
  //
  // The tool path works in isolation — both local models call get_quote
  // correctly, three trials each, and answer cleanly from the result.
  // Against the real brief they do not: across dozens of production
  // attempts at "what is the price of Apple" the quote was fetched
  // correctly almost every time and the reply was a greeting, a
  // deflection, an answer about a different holding, or in three cases
  // Thai and Chinese text and a fabricated $142.65.
  //
  // Eight fixes narrowed it — gating research, trimming news, gating the
  // policy documents, deduping calls, restating the question after the
  // tool output — and none made it reliable. An assistant that fetches
  // the right number and then fails to say it is worse than one that
  // never claimed it could: the chips make it look as though it checked.
  //
  // So the default is the behaviour that actually works, and the tool
  // path stays in the tree behind AI_CHAT_TOOLS=1 for the next time
  // there is a better local model to point it at.
  // Off by default. Turn on with AI_CHAT_TOOLS=1.
  //
  // Tried again after the prompt was cut from 31 KB to a relevance-
  // assembled fraction, on the theory that size was the problem. It was
  // not: six consecutive runs of "what is the price of Apple" fetched
  // AAPL correctly — the chip fired every time — and answered with a
  // greeting, a portfolio summary, or an unprompted note about AIT. Zero
  // for six.
  //
  // The distinction the retest made clear: single-turn questions over
  // the same brief now work well, including the valuation and research
  // questions that used to fail. What does not work is the round trip —
  // handing the model a tool result and getting it to answer the
  // original question from it. That is a different failure from prompt
  // size, and it did not move when the prompt shrank.
  const toolsEnabled = process.env.AI_CHAT_TOOLS === '1';

  // Stream, when the client asked and the local path can.
  //
  // A 14B on a shared box takes the better part of a minute to write a
  // real answer, and withholding all of it until the last token means
  // the one surface with a person sitting in front of it is the one that
  // shows nothing the longest. Raising the timeout stopped it failing
  // and did nothing about the waiting.
  //
  // The guards below run AFTER the text has been shown, which is the
  // honest cost of streaming: an invented price can reach the screen
  // before anything checks it. So the stream can retract — the client is
  // told to replace what it drew, rather than the server pretending it
  // never sent it.
  if (req.body?.stream === true && !toolsEnabled && canStreamLocally()) {
    return streamReply({
      req, res, session, modelMessages, temp, startedAt, message,
    });
  }

  const attempt = toolsEnabled
    ? await runWithTools(modelMessages, temp)
    : {
        text: await llmChat({
    job: 'chat',
          messages: modelMessages,
          temperature: temp,
          localModel: RESEARCH_LOCAL_MODEL,
          timeoutMs: CHAT_TIMEOUT_MS,
        }),
        fromTools: [],
        used: [],
      };
  let reply = attempt?.text ?? null;

  const invented = unbackedPrice(reply, attempt?.fromTools || []);
  if (invented) {
    console.warn(`aiChat: reply carried an unbacked figure ${invented}; retrying`);
    const second = await runWithTools(
      [
        ...modelMessages,
        {
          role: 'system',
          content:
            'Your previous draft stated a monetary figure that no tool returned. ' +
            'Use ONLY figures present in the tool results. If you do not have a price, say so.',
        },
      ],
      0
    );
    const retryText = second?.text ?? null;
    reply = unbackedPrice(retryText, second?.fromTools || []) ? null : retryText;
  }

  if (looksLikeLeakedToolCall(reply)) {
    console.warn('aiChat: model leaked tool-call syntax into the reply; retrying without tools');
    // Without tools it cannot leak a tool call, and an answer from
    // context is better than machine syntax in a member's chat window.
    reply = await llmChat({
    job: 'chat',
      messages: modelMessages,
      temperature: temp,
      localModel: RESEARCH_LOCAL_MODEL,
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    if (looksLikeLeakedToolCall(reply)) reply = null;
  }
  const latencyMs = Date.now() - startedAt;

  if (!reply) {
    return res.status(503).json({
      error:
        'The assistant did not answer in time. The local model is slow under load — '
        + 'try again, and if it keeps happening check the tunnel and the OpenAI fallback.',
      sessionId: session.id,
    });
  }

  // Persist the assistant turn. Provider identification is best-effort —
  // llmChat currently returns just the content string, so we tag based on
  // which env is configured (local preferred, fallback to openai).
  const providerTag = process.env.LOCAL_LLM_URL
    ? 'local?'
    : process.env.OPENAI_API_KEY
      ? 'openai'
      : 'unknown';
  await prisma.aiChatMessage.create({
    data: {
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      model: providerTag,
      latencyMs,
    },
  });

  // Title the session from the first user message if still blank.
  let title = session.title;
  if (!title) {
    title = truncateTitle(message, 80);
    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { title, updatedAt: new Date() },
    });
  } else {
    // Bump updatedAt so the sidebar orders by last activity.
    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });
  }

  res.json({
    sessionId: session.id,
    title,
    reply,
    // Shown in the UI. Empty means nothing was looked up and the answer
    // came from context — which is worth knowing, not hiding.
    toolsUsed: attempt?.used || [],
  });
});

// The assembled system prompt, for looking at.
//
// Added because a whole afternoon went into guessing why the assistant
// could not see the valuations, using the model's own answers as
// evidence — and those answers turned out to be unreliable: asked
// whether two strings that ARE in its context were present, it said yes
// to one and no to the other. Debugging a prompt through the model
// reading it back is debugging through a witness who cannot read.
//
// Super-admin only. It contains the whole brief, including the
// role-gated research section.
router.get('/debug/prompt', async (req, res) => {
  if (!req.user?.isSuperAdmin) return res.status(403).json({ error: 'Forbidden' });
  const topic = typeof req.query.topic === 'string' ? req.query.topic : '';
  try {
    const prompt = await getClubSystemPrompt({ user: req.user, topic, forceFresh: true });
    res.type('text/plain').send(prompt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
