import { getGooglePrices } from './googlePrices.js';
import { getLiveQuotes } from './liveQuotes.js';

// One quote resolver for the whole portfolio + trade surface, so a caller
// never has to know where a price comes from. Two sources, picked per ticker:
//
//   - Google "prices_needed" tab (googlePrices.js) — the names we already
//     hold. Free, bulk, no per-request budget. This is the price source the
//     club wants for the book.
//   - Finnhub /quote (liveQuotes.js) — anything the Google tab does not list:
//     a stock being pitched or bought for the first time, or a freshly-held
//     name not yet added to the tab. Finnhub quotes an arbitrary symbol on
//     demand, which GOOGLEFINANCE cannot do without first editing a sheet.
//
// The effect: "add a stock we've never held" just works — the new ticker
// falls through to Finnhub — and the portfolio read stays cheap because held
// names are served from the one bulk Google pull.

// Collapse either source to one shape. dayChange is the per-share dollar move
// (price - prevClose) when we have a previous close; changePct is filled from
// it when the source didn't hand one over.
function shape(price, prevClose, changePct, source) {
  const dayChange = price != null && prevClose != null ? price - prevClose : null;
  let pct = changePct;
  if (pct == null && price != null && prevClose != null && prevClose !== 0) {
    pct = ((price - prevClose) / prevClose) * 100;
  }
  return { price, prevClose, dayChange, changePct: pct ?? null, source };
}

// resolveQuotes(tickers) -> { [TICKER]: {price, prevClose, dayChange,
// changePct, source} | null }. Upper-cases + de-dupes; an unresolvable ticker
// (not on the tab and unknown to Finnhub) maps to null rather than throwing,
// so one bad symbol never sinks the batch.
export async function resolveQuotes(tickers = [], opts = {}) {
  const list = Array.from(
    new Set(
      (Array.isArray(tickers) ? tickers : [])
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim().toUpperCase())
    )
  );
  const out = {};
  if (list.length === 0) return out;

  // One bulk Google pull covers every held name at once. If the feed is down
  // we don't fail the whole resolve — every ticker just falls through to
  // Finnhub below.
  let bySymbol = {};
  try {
    ({ bySymbol } = await getGooglePrices(opts.google || {}));
  } catch (err) {
    console.warn('resolveQuotes: Google price feed unavailable:', err.message);
  }

  const missing = [];
  for (const t of list) {
    const g = bySymbol[t];
    if (g && g.price != null) {
      out[t] = shape(g.price, g.prevClose, g.changePct, 'google');
    } else {
      missing.push(t);
    }
  }

  if (missing.length) {
    const fh = await getLiveQuotes(missing);
    for (const t of missing) {
      const q = fh[t];
      out[t] = q && q.last != null ? shape(q.last, q.prevClose, q.changePct, 'finnhub') : null;
    }
  }

  return out;
}

// Single-ticker convenience for the "look up a price as we add/size a buy"
// path. Returns the quote object or null.
export async function resolveQuote(ticker, opts = {}) {
  if (!ticker) return null;
  const key = String(ticker).trim().toUpperCase();
  const out = await resolveQuotes([key], opts);
  return out[key] || null;
}
