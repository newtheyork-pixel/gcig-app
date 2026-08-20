// Shared LLM client. Tries providers in priority order:
//   1. Local Ollama (free, private — tunneled from club hardware)
//   2. Anthropic Claude (best quality for financial analysis)
//   3. OpenAI (legacy fallback)
//
// Returns the `message.content` string, or null if every provider fails
// (or none is configured). Never throws.
//
// Config:
//   LOCAL_LLM_URL           Base URL of the local endpoint; blank disables.
//   LOCAL_LLM_MODEL         Defaults to qwen2.5:14b-instruct-q4_K_M.
//   RESEARCH_LLM_MODEL      Local weights for field research, which does
//                           not survive the small model. Same default.
//   LOCAL_LLM_API_KEY       Optional bearer if the tunnel is protected.
//   LOCAL_LLM_TIMEOUT_MS    Shared default timeout. Defaults to 25000.
//   ANTHROPIC_API_KEY       Enables Claude. Preferred cloud provider.
//   ANTHROPIC_MODEL         Defaults to claude-haiku-4-5-20251001.
//   OPENAI_API_KEY          Enables OpenAI fallback.
//   OPENAI_MODEL            Defaults to gpt-4.1-mini.

const DEFAULT_LOCAL_MODEL = 'qwen2.5:14b-instruct-q4_K_M';

// The model field research runs on, independent of whatever the global
// default has drifted to. Reading a transcript for the answer to a
// question is a reasoning task, not a summarising one, and it degrades
// silently rather than loudly — a model too small to make the inference
// returns "no answer here", which is indistinguishable from a transcript
// that genuinely has none. That failure is invisible in a way a wrong
// summary is not, so this path names its own weights.
export const RESEARCH_LOCAL_MODEL =
  process.env.RESEARCH_LLM_MODEL || 'qwen2.5:14b-instruct-q4_K_M';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

// What each job runs on, because they are not the same kind of work.
//
// Screening an outreach draft for MNPI and ranking a headline both call
// "the model" and want opposite things from it: one is a compliance
// judgement where being talked out of a flag is the failure mode, the
// other is a cheap sort over twenty strings fifty times a day. Paying
// frontier prices for the second is waste, and running the first on
// whatever is cheapest is how the screen quietly stops screening.
//
// Every entry is an env var so a model can be moved without a deploy, and
// the fallback is OPENAI_MODEL so an unset job simply inherits the house
// default rather than failing.
const JOB_MODELS = {
  // Compliance and evidence. These decide whether words reach a stranger
  // or whether a claim enters the ledger, and they get the best model.
  screen:     () => process.env.OPENAI_MODEL_SCREEN,
  claims:     () => process.env.OPENAI_MODEL_CLAIMS,
  synthesis:  () => process.env.OPENAI_MODEL_SYNTHESIS,
  // Prose somebody reads once a day.
  review:     () => process.env.OPENAI_MODEL_REVIEW,
  chat:       () => process.env.OPENAI_MODEL_CHAT,
  // Bulk sorting. Cheap on purpose, and wrong answers here cost a
  // headline's position rather than anything that matters.
  // Reading a reply and deciding whether it actually asks anything of us.
  // Cheap on purpose: the worst case is one unnecessary chase or one
  // missed one, both of which a person catches by looking at the row.
  triage:     () => process.env.OPENAI_MODEL_TRIAGE,
  rank:       () => process.env.OPENAI_MODEL_RANK,
  describe:   () => process.env.OPENAI_MODEL_DESCRIBE,
};

export function modelForJob(job) {
  const pick = job && JOB_MODELS[job];
  return (pick && pick()) || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}
const DEFAULT_TIMEOUT_MS = 25_000;

function normalizeBase(raw) {
  const s = String(raw).trim().replace(/\/+$/, '');
  if (/\/v1$/.test(s)) return s;
  return `${s}/v1`;
}

// OpenAI's gpt-5 / o-series reasoning models reject non-default temperature
// and require max_completion_tokens instead of max_tokens. Detect by name
// prefix so we omit the params cleanly.
function isReasoningModel(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
}

// ── OpenAI-compatible endpoint (works for local Ollama + OpenAI) ────

async function callEndpoint({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  jsonMode,
  timeoutMs,
  tools,
  extraBody,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      model,
      messages,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      // Provider-specific fields. Only the local endpoint gets any: a
      // hosted API rejects an unknown key outright.
      ...(extraBody || {}),
    };
    if (!isReasoningModel(model) && temperature != null) {
      body.temperature = temperature;
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || '';
      } catch {
        detail = text.slice(0, 200);
      }
      return { ok: false, status: res.status, detail };
    }
    const json = await res.json();
    const msg = json?.choices?.[0]?.message;
    const content = msg?.content;
    return {
      ok: true,
      content: typeof content === 'string' ? content : null,
      // Carried through for the tool loop. A model answering with a tool
      // call and no prose returns content:'' — which the string-only
      // path read as an empty reply and discarded.
      toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls : null,
    };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    clearTimeout(timer);
  }
}

// ── Anthropic Messages API ──────────────────────────────────────────
// Different auth, body shape, and response format from OpenAI.
// System prompt is a top-level field, not a message.

async function callAnthropic({
  apiKey,
  model,
  messages,
  temperature,
  jsonMode,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Extract system message(s) — Anthropic wants them as a top-level field.
    let system;
    const filtered = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else {
        filtered.push({ role: m.role, content: m.content });
      }
    }

    // Ensure messages alternate user/assistant. If the first non-system
    // message is assistant, prepend a minimal user turn.
    if (filtered.length > 0 && filtered[0].role === 'assistant') {
      filtered.unshift({ role: 'user', content: '(continue)' });
    }

    const body = {
      model,
      max_tokens: 2048,
      messages: filtered,
      ...(system ? { system } : {}),
      ...(temperature != null ? { temperature } : {}),
    };

    // Anthropic doesn't have a native JSON mode, but we can nudge it
    // by appending an instruction to the system prompt.
    if (jsonMode && system) {
      body.system = system + '\n\nIMPORTANT: Respond with valid JSON only. No prose, no code fences.';
    } else if (jsonMode) {
      body.system = 'Respond with valid JSON only. No prose, no code fences.';
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || '';
      } catch {
        detail = text.slice(0, 200);
      }
      return { ok: false, status: res.status, detail };
    }

    const json = await res.json();
    // Anthropic response: { content: [{ type: 'text', text: '...' }] }
    const text = json?.content?.[0]?.text;
    return { ok: true, content: typeof text === 'string' ? text : null };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    clearTimeout(timer);
  }
}

// ── Logging ─────────────────────────────────────────────────────────

function logFailure(provider, result) {
  if (result.error) {
    if (result.error.name === 'AbortError') {
      console.warn(`llm: ${provider} timed out`);
    } else {
      console.warn(`llm: ${provider} failed:`, result.error.message);
    }
  } else if (result.status) {
    console.warn(`llm: ${provider} responded ${result.status}${result.detail ? ' — ' + result.detail : ''}`);
  }
}

// ── Main entry point ────────────────────────────────────────────────

// Individual provider callers, keyed by name. Each returns the shared
// { ok, content, ... } result shape and is a no-op (returns null) when its
// env isn't configured, so the runner can just skip it.
// How much context to ask the local model for.
//
// Ollama defaults to 2048 tokens and silently drops whatever does not
// fit — from the FRONT, which takes the system prompt with it. A 30,000
// character transcript therefore reached the model as a fragment with no
// instructions attached, and the model answered the only way it could:
// an empty JSON object, in under a second. Every caller read that as
// "the model was unavailable" and fell back to its keyword floor.
//
// Nothing errored. The MNPI screen returned risk "low" on interviews it
// had never actually read, and the only visible symptom was a
// modelAvailable flag that nobody had reason to question.
//
// Measured on the real thing: default context evaluated 2,050 tokens of
// a 9,339 token prompt and returned {}. At 16k it evaluated all 9,339
// and returned a verdict.
//
// Sized per call because a large window costs KV cache on a shared box.
// Chars/3.5 is a deliberate over-estimate of tokens, plus room to answer.
export function contextFor(messages, { max = Number(process.env.LOCAL_LLM_MAX_CTX) || 16_384 } = {}) {
  const chars = (messages || []).reduce((n, m) => n + String(m?.content || '').length, 0);
  const want = Math.ceil(chars / 3.5) + 1024;
  // Never below Ollama's own default, never above what the box can hold.
  return Math.min(Math.max(want, 4096), max);
}

/// The first complete JSON value in a model's reply.
///
/// Qwen appends a bare <tool_call> sentinel after the closing brace when
/// no tools were offered, and JSON.parse on the whole string throws. Ten
/// call sites parse model output directly, and every one of them catches
/// the throw and quietly falls back — so a screen that had produced a
/// perfectly good verdict was recorded as "the model was unavailable".
/// Interview 9 failed exactly this way on a 1,220-character transcript,
/// which is how it survived the context fix that repaired everything
/// else: a different cause with an identical symptom.
///
/// Scans for a balanced value rather than regexing to the last brace,
/// because a brace inside a quoted excerpt is not the end of anything.
export function extractJson(text) {
  if (typeof text !== 'string') return text;
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.search(/[{[]/);
  if (start < 0) return s;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  // Unbalanced: hand back what we have and let the caller's parse fail
  // honestly rather than inventing a closing brace.
  return s;
}

/// The native Ollama chat URL, derived from the configured base by
/// dropping the OpenAI-compat suffix. Overridable, because a deployment
/// whose local endpoint is not Ollama should be able to turn this off and
/// keep the compat path.
export function nativeChatURL(base = process.env.LOCAL_LLM_NATIVE_URL || process.env.LOCAL_LLM_URL) {
  if (!base) return null;
  if (process.env.LOCAL_LLM_NATIVE_DISABLED === '1') return null;
  const root = normalizeBase(base).replace(/\/v1$/, '');
  return `${root}/api/chat`;
}

/// Ollama's own endpoint. Same job as callEndpoint, different wire shape:
/// options instead of top-level fields, format:"json" instead of
/// response_format, and the reply at message.content.
async function callOllamaNative({ endpoint, apiKey, model, messages, temperature, jsonMode, timeoutMs, numCtx }) {
  const once = async (temp) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          ...(jsonMode ? { format: 'json' } : {}),
          options: { num_ctx: numCtx, ...(temp != null ? { temperature: temp } : {}) },
        }),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
      }
      const data = await res.json();
      const content = data?.message?.content;
      // A prompt longer than the window it was given is still truncated
      // from the front, which is how this whole class of failure hides.
      // Say so rather than returning a confident answer to half a question.
      if (typeof data?.prompt_eval_count === 'number' && data.prompt_eval_count >= numCtx - 8) {
        console.warn(
          `local model: prompt filled the ${numCtx}-token window (${data.prompt_eval_count} evaluated) — input may have been truncated`
        );
      }
      if (!content) return { ok: false, status: res.status, error: 'empty response' };
      // Only when JSON was asked for. Trimming prose off a prose answer
      // would be the transport editing the model.
      return { ok: true, content: jsonMode ? extractJson(content) : content };
    } catch (err) {
      return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  };

  const parses = (t) => {
    try { JSON.parse(t); return true; } catch { return false; }
  };

  const first = await once(temperature);
  if (!jsonMode || !first.ok || parses(first.content)) return first;

  // One retry, warmer.
  //
  // At temperature 0 the decode is greedy and therefore deterministic,
  // so a malformed answer stays malformed however many times it is
  // asked. Interview 9 produced the same broken excerpt array on every
  // run: a quote opened and every quote after it escaped, so the string
  // never closed. Measured on that transcript, temperature 0.6 parsed
  // twice out of twice and 0.9 the same, while 0 never did.
  //
  // Determinism is worth giving up only on the failure path. A valid
  // verdict from a warmer sample beats a reproducible one nobody can
  // read, and if this also fails the caller still sees an unusable
  // answer and degrades honestly.
  const retry = await once(Math.min((Number(temperature) || 0) + 0.6, 1));
  return retry.ok && parses(retry.content) ? retry : first;
}

function runProvider(name, { messages, temperature, jsonMode, timeoutMs, localModel, job, tools }) {
  if (name === 'local') {
    if (!process.env.LOCAL_LLM_URL) return null;
    // Ollama's NATIVE api, not the OpenAI-compatible one, because the
    // context window can only be set through the native options object.
    // Measured, twice, on the same 9,339-token prompt: native honoured
    // num_ctx and evaluated all of it; the compat endpoint reported 2,050
    // tokens and returned {} — including immediately after the model had
    // been loaded at 16k, so it is not a stale-instance effect. The
    // compat path remains for any local server that is not Ollama.
    const native = nativeChatURL();
    if (native) {
      return callOllamaNative({
        endpoint: native,
        apiKey: process.env.LOCAL_LLM_API_KEY,
        model: localModel || process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
        messages,
        temperature,
        jsonMode,
        timeoutMs,
        numCtx: contextFor(messages),
      });
    }
    return callEndpoint({
      endpoint: `${normalizeBase(process.env.LOCAL_LLM_URL)}/chat/completions`,
      apiKey: process.env.LOCAL_LLM_API_KEY,
      // A caller may name the local model it needs. The global default is
      // tuned for cheap bulk work — ranking headlines, summarising an
      // article — and the box is shared, so it drifts down to whatever
      // was small enough to co-resident with another project's models.
      // Field research does not survive that: on the same transcript and
      // the same prompt, the 7b answered "nothing here" where the 14b
      // returned the quote with 0.9 confidence. Naming the model per call
      // rather than repinning the global keeps the bigger weights loaded
      // only for the runs that actually need them.
      model: localModel || process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
      messages,
      temperature,
      jsonMode,
      timeoutMs,
      tools,
    });
  }
  if (name === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    return callAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      messages,
      temperature,
      jsonMode,
      timeoutMs,
    });
  }
  if (name === 'openai') {
    if (!process.env.OPENAI_API_KEY) return null;
    return callEndpoint({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: process.env.OPENAI_API_KEY,
      model: modelForJob(job),
      messages,
      temperature,
      jsonMode,
      timeoutMs,
    });
  }
  return null;
}

// Provider priority.
//   default        local → anthropic → openai   (free/private first; cheap bulk
//                                                 work like article ranking)
//   preferQuality  anthropic → openai → local   (best reasoning first; used for
//                                                 the interactive terminal AI —
//                                                 chat, briefs, command parse —
//                                                 where a weak local model reads
//                                                 as "dumb". Falls back to local
//                                                 so nothing breaks if no cloud
//                                                 key is set.)
const DEFAULT_ORDER = ['local', 'anthropic', 'openai'];
const QUALITY_ORDER = ['anthropic', 'openai', 'local'];

// The jobs that must never quietly run on the small local model.
//
// Everything else can: ranking a headline, describing a company, writing
// the daily brief. If the box is up they cost nothing, and a worse answer
// costs a headline's position.
//
// Compliance cannot. The MNPI screen decides whether words reach a
// stranger, and the claim gate decides whether an assertion enters a
// ledger that a footnote will one day point at. The failure mode of a
// model too small for those is not a wrong answer somebody catches in
// review, it is NO answer, which is byte-for-byte what an honest clean
// result looks like. That already happened once: every claim extracted
// for the Lindt project came through a 7B that returned "nothing found"
// on a transcript a person had read and knew contained an answer.
//
// So these jobs go to the cloud FIRST and fall back to local only if
// there is no cloud provider at all, which is a degraded state the
// screen already reports as modelAvailable:false rather than a pass.
const COMPLIANCE_JOBS = new Set(['screen', 'claims']);

// Whether llmChat has any provider to try at all. Callers that want to
// skip a doomed round trip must ask THIS, not re-derive the env-var
// list themselves: two services checked only LOCAL_LLM_URL/OPENAI and
// silently disabled ranking and the daily brief in the exact deploy
// configuration where Anthropic was the one working provider.
export function llmConfigured() {
  return !!(
    process.env.LOCAL_LLM_URL ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY
  );
}

// Best guess at which model tag a default-order llmChat call will be
// served by, for persistence rows. A fallback mid-call can still make
// this wrong; it is a label, not a receipt.
export function likelyModelTag() {
  if (process.env.LOCAL_LLM_URL) {
    return process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  }
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  }
  return 'none';
}

export async function llmChat({
  messages,
  temperature,
  jsonMode,
  timeoutMs,
  preferQuality = false,
  localModel,
  // Which KIND of work this is. Picks the model per job rather than per
  // deployment, so a compliance screen and a headline sort stop sharing
  // one setting purely because they share one function.
  job,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const effectiveTimeoutMs =
    Number(timeoutMs) ||
    Number(process.env.LOCAL_LLM_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS;

  // Compliance overrides the caller's own preference. A service that
  // forgot to ask for quality must not thereby get the cheap model on the
  // one question where cheap is dangerous.
  const order = (COMPLIANCE_JOBS.has(job) || preferQuality) ? QUALITY_ORDER : DEFAULT_ORDER;
  for (const name of order) {
    const result = await runProvider(name, {
      messages,
      temperature,
      jsonMode,
      timeoutMs: effectiveTimeoutMs,
      localModel,
      job,
    });
    if (!result) continue; // provider not configured
    if (result.ok && result.content) return result.content;
    logFailure(name, result);
  }

  return null;
}

// Same call, but returns { content, toolCalls } instead of a string.
//
// A model answering with a tool call and no prose returns content:'',
// which llmChat treats as a failure and drops on the floor — correct for
// every caller that just wants text, and fatal for a tool loop. Local
// only: tool calling here runs against the OpenAI-compatible endpoint,
// and Anthropic's tool shape is different enough that silently falling
// through to it would produce a reply with the tools quietly ignored.
export async function llmChatTools({
  messages,
  tools,
  temperature,
  timeoutMs,
  localModel,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const result = await runProvider('local', {
    messages,
    temperature,
    timeoutMs: Number(timeoutMs) || DEFAULT_TIMEOUT_MS,
    localModel,
    tools,
  });
  if (!result) return null;
  if (!result.ok) {
    logFailure('local', result);
    return null;
  }
  return { content: result.content, toolCalls: result.toolCalls };
}

// ── Health check ────────────────────────────────────────────────────
// Live probe of each configured provider. Returns per-provider status
// plus an `active` field — the provider that would serve the next
// request (first reachable in priority order).

// The local box shares one 16 GB card with the Optimize grading models,
// so the Fund's 9 GB model is regularly evicted and has to be re-read
// from disk on the next call. A measured cold load runs ~11s, against a
// 6s probe budget — which is why this page reported the GPU "down" while
// the tunnel was healthy and real requests (25s budget) were succeeding.
// A health check that is stricter than the code path it reports on
// manufactures outages, so the local probe gets room for a cold load.
// Cloud providers keep the short budget: they have no cold start, and a
// genuinely dead key should fail fast rather than stall the page.
const LOCAL_PROBE_TIMEOUT_MS = 20_000;

export async function probeProviders({ timeoutMs = 6000, localTimeoutMs = LOCAL_PROBE_TIMEOUT_MS } = {}) {
  const status = {
    local: { configured: !!process.env.LOCAL_LLM_URL, ok: false, latencyMs: null, error: null, model: null },
    anthropic: { configured: !!process.env.ANTHROPIC_API_KEY, ok: false, latencyMs: null, error: null, model: null },
    openai: { configured: !!process.env.OPENAI_API_KEY, ok: false, latencyMs: null, error: null, model: null },
    active: null,
  };

  const ping = [{ role: 'user', content: 'ok' }];

  if (status.local.configured) {
    const t = Date.now();
    const r = await callEndpoint({
      endpoint: `${normalizeBase(process.env.LOCAL_LLM_URL)}/chat/completions`,
      apiKey: process.env.LOCAL_LLM_API_KEY,
      model: process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
      messages: ping,
      temperature: 0,
      timeoutMs: localTimeoutMs,
    });
    status.local.latencyMs = Date.now() - t;
    status.local.model = process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL;
    if (r.ok) {
      status.local.ok = true;
      // Healthy but slow means the model was paged back into VRAM. Worth
      // surfacing: it explains a one-off slow first request, and a page
      // that shows "ok" with no nuance invites the opposite confusion to
      // the one this timeout fix just removed.
      status.local.cold = status.local.latencyMs > 6000;
    } else {
      status.local.error = r.status
        ? `HTTP ${r.status}${r.detail ? ' — ' + r.detail : ''}`
        : r.error?.message || 'unreachable';
    }
  }

  if (status.anthropic.configured) {
    const t = Date.now();
    const r = await callAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      messages: ping,
      temperature: 0,
      timeoutMs,
    });
    status.anthropic.latencyMs = Date.now() - t;
    status.anthropic.model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    if (r.ok) {
      status.anthropic.ok = true;
    } else {
      status.anthropic.error = r.status
        ? `HTTP ${r.status}${r.detail ? ' — ' + r.detail : ''}`
        : r.error?.message || 'unreachable';
    }
  }

  if (status.openai.configured) {
    const t = Date.now();
    const r = await callEndpoint({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: process.env.OPENAI_API_KEY,
      model: modelForJob(job),
      messages: ping,
      temperature: 0,
      timeoutMs,
    });
    status.openai.latencyMs = Date.now() - t;
    status.openai.model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    if (r.ok) {
      status.openai.ok = true;
    } else {
      status.openai.error = r.status
        ? `HTTP ${r.status}${r.detail ? ' — ' + r.detail : ''}`
        : r.error?.message || 'unreachable';
    }
  }

  status.active = status.local.ok ? 'local' : status.anthropic.ok ? 'anthropic' : status.openai.ok ? 'openai' : null;
  return status;
}

/// The same local call, delivered a token at a time.
///
/// A 14B on a shared box needs the better part of a minute to write a
/// real answer, and until now the whole thing was withheld until the
/// last token landed — so the surface where somebody is actually sitting
/// and watching was the one that made them wait longest, with nothing on
/// screen to show it was working. Raising the timeout stopped it failing
/// and did nothing about that.
///
/// Deliberately local-only. Streaming a hosted fallback would mean two
/// more wire formats to parse for a path that exists to catch outages,
/// and a caller that cannot stream is better served by the ordinary
/// blocking call than by a half-built one.
export function canStreamLocally() {
  return !!(process.env.LOCAL_LLM_URL && nativeChatURL());
}

/**
 * Stream a local completion, calling `onToken` with each fragment.
 *
 * Resolves with the full text. Throws on transport failure so a caller
 * can fall back to the blocking path — a stream that dies halfway is a
 * failure even though bytes arrived, and treating it as success would
 * publish a truncated answer as a complete one.
 */
export async function llmChatStreamLocal({
  messages, temperature, localModel, timeoutMs = 120_000, onToken,
}) {
  const endpoint = nativeChatURL();
  if (!endpoint) throw new Error('No local streaming endpoint configured.');

  const controller = new AbortController();
  // The deadline covers silence, not total duration: a model still
  // emitting tokens is working, and cutting it off at a fixed wall-clock
  // would truncate the long answers that most need streaming.
  let idle = setTimeout(() => controller.abort(), timeoutMs);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), timeoutMs);
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LOCAL_LLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: localModel || process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL,
        messages,
        stream: true,
        options: {
          num_ctx: contextFor(messages),
          ...(temperature != null ? { temperature } : {}),
        },
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`local stream ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }

    // Ollama streams newline-delimited JSON, and a chunk boundary lands
    // mid-object often enough that a naive per-chunk parse loses tokens.
    // The tail is carried forward.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        const piece = obj?.message?.content;
        if (piece) {
          full += piece;
          onToken?.(piece);
        }
      }
    }
    if (!full.trim()) throw new Error('local stream produced no text');
    return full;
  } finally {
    clearTimeout(idle);
  }
}
