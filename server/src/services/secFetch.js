// One place that knows how to ask EDGAR for something.
//
// SEC publishes a hard limit of ten requests a second per client and
// answers a burst above it with 403 or 429 rather than data. Every
// ticker-scoped panel in the terminal reads from EDGAR, so opening a few
// of them at once — or sweeping the book to check something — is exactly
// the shape of traffic that trips it.
//
// That was not a theory. Auditing twelve holdings across ten endpoints
// produced 502s on APLD, BN and QQQ that looked like broken extraction
// and were nothing of the sort: the same calls returned full data a
// minute later. A throttled request is a request to make again shortly,
// and until this existed we turned it into "Fundamentals fetch failed"
// and left it there.
//
// Retries are deliberately few and short. The caller is a panel someone
// is waiting on, and a page that takes twelve seconds to admit defeat is
// worse than one that takes three.

const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [400, 1200];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch from EDGAR, retrying the failures that are worth retrying.
 *
 * Throws an Error carrying `.status` so callers can keep distinguishing
 * "this ticker has no such filing" (404, a fact) from "EDGAR would not
 * talk to us" (everything else, a condition).
 */
export async function secFetch(url, { headers = {}, timeoutMs = 15_000, attempts = 3 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (res.ok) return res;
      // A 404 is an answer: this filer has no such document, and asking
      // again three times cannot change that.
      if (!RETRYABLE.has(res.status)) {
        const err = new Error(`SEC ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      last = new Error(`SEC ${res.status} for ${url}`);
      last.status = res.status === 404 ? 404 : 502;
      last.throttled = res.status === 403 || res.status === 429;
    } catch (err) {
      if (err.status && !RETRYABLE.has(err.status)) throw err;
      // An abort is a timeout, and a timeout is worth one more try.
      last = err;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts - 1) await sleep(BACKOFF_MS[i] ?? 1200);
  }
  if (last && !last.status) last.status = 502;
  // Name the condition. "SEC is rate-limiting us" is actionable and
  // "fetch failed" is not, and the panel prints whatever it is given.
  if (last?.throttled) last.message = `SEC is rate-limiting us (${last.message})`;
  throw last || new Error(`SEC request failed for ${url}`);
}

export async function secFetchJson(url, opts = {}) {
  const res = await secFetch(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
  });
  return res.json();
}
