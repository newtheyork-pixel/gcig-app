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

  // A price alone is not a resolved quote.
  //
  // Google returns a last price for most names and, for many of them, no
  // previous close and no change — so `shape` yields dayChange: null.
  // The old condition treated "has a price" as done and never asked
  // Finnhub, which does carry a previous close. MOVR therefore ranked
  // one holding of twelve and reported the other eleven as unpriceable,
  // with a working quote endpoint sitting next to it.
  //
  // So a Google row only settles a ticker when it can actually produce a
  // day move. Otherwise the ticker goes to Finnhub and takes BOTH
  // figures from there — mixing one source's price with another's
  // previous close would produce a day change that never happened.
  const missing = [];
  for (const t of list) {
    const g = bySymbol[t];
    const usable = g && g.price != null && (g.prevClose != null || g.changePct != null);
    if (usable) {
      out[t] = shape(g.price, g.prevClose, g.changePct, 'google');
    } else {
      missing.push(t);
    }
  }

  if (missing.length) {
    const fh = await getLiveQuotes(missing);
    for (const t of missing) {
      const q = fh[t];
      if (q && q.last != null) {
        out[t] = shape(q.last, q.prevClose, q.changePct, 'finnhub');
        continue;
      }
      // Finnhub had nothing either. Keep Google's price if there was
      // one — a position worth $5,529 with no day move still belongs in
      // the book — but leave dayChange null so nothing invents a move.
      const g = bySymbol[t];
      out[t] = g && g.price != null ? shape(g.price, null, null, 'google') : null;
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
