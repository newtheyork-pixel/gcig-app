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

function runProvider(name, { messages, temperature, jsonMode, timeoutMs, localModel, tools }) {
  if (name === 'local') {
    if (!process.env.LOCAL_LLM_URL) return null;
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
      extraBody: { options: { num_ctx: contextFor(messages) } },
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
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
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

export async function llmChat({
  messages,
  temperature,
  jsonMode,
  timeoutMs,
  preferQuality = false,
  localModel,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const effectiveTimeoutMs =
    Number(timeoutMs) ||
    Number(process.env.LOCAL_LLM_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS;

  const order = preferQuality ? QUALITY_ORDER : DEFAULT_ORDER;
  for (const name of order) {
    const result = await runProvider(name, {
      messages,
      temperature,
      jsonMode,
      timeoutMs: effectiveTimeoutMs,
      localModel,
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
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
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
