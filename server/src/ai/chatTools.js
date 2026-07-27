import { resolveQuotes } from '../services/portfolioQuotes.js';
import { getPeerSnapshot } from '../services/marketData.js';
import { getRecentFilings } from '../services/secFilings.js';

// Tools the club assistant may call.
//
// Everything here is READ-ONLY, and that is a deliberate boundary rather
// than a first increment. The assistant is open to every authenticated
// member — JuniorAnalyst is the default role for any Google sign-up — so
// a tool that changes state is a tool that can be talked into changing
// state by whoever finds the login page. Reading a price cannot be
// abused into buying one.
//
// Two rules every tool here follows:
//
//   Return the failure, do not throw. A tool that throws takes the whole
//   reply down; a tool that returns { error } lets the model say it
//   could not get the price, which is the honest answer and the one a
//   member can act on.
//
//   Never return an empty success. `{}` or a bare null reads to a model
//   as "nothing there" and invites it to fill the gap — the exact
//   failure that put "$75 per share" in front of a member earlier. Say
//   what was not found, by name.

export const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description:
        'Current market price for one or more tickers. Use this whenever asked what something is trading at, or to compare a live price against one of our price targets or buy levels. Do not guess a price — call this.',
      parameters: {
        type: 'object',
        properties: {
          tickers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ticker symbols, e.g. ["AIT","JNJ"]. Max 10.',
          },
        },
        required: ['tickers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_company_snapshot',
      description:
        'Valuation and size snapshot for one ticker: price, market cap, trailing and forward P/E, dividend yield. Use for "how expensive is X" or to compare a name against peers.',
      parameters: {
        type: 'object',
        properties: { ticker: { type: 'string', description: 'One ticker symbol.' } },
        required: ['ticker'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_filings',
      description:
        'Recent SEC filings for one ticker, newest first. Use for "has X filed anything", "any 8-Ks", or to check whether something has been disclosed.',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: 'One ticker symbol.' },
          limit: { type: 'number', description: 'How many filings, default 5, max 15.' },
        },
        required: ['ticker'],
      },
    },
  },
];

const clean = (t) => String(t || '').trim().toUpperCase().slice(0, 12);

const HANDLERS = {
  async get_quote(args) {
    const tickers = (Array.isArray(args?.tickers) ? args.tickers : [args?.tickers])
      .map(clean)
      .filter(Boolean)
      .slice(0, 10);
    if (tickers.length === 0) return { error: 'No ticker given.' };

    const quotes = await resolveQuotes(tickers);
    // Best-effort naming; a null name is better than a guessed one, and
    // the model is told below not to invent one.
    const names = {};
    await Promise.all(
      tickers.map(async (t) => {
        try {
          const snap = await getPeerSnapshot(t);
          if (snap?.name) names[t] = snap.name;
        } catch {
          /* a missing name must not cost the price */
        }
      })
    );
    const found = [];
    const missing = [];
    for (const t of tickers) {
      const q = quotes?.[t];
      if (!q || q.price == null) {
        missing.push(t);
        continue;
      }
      found.push({
        ticker: t,
        // The company's actual name, because without it the model
        // supplies one from whatever else is in its context: asked for
        // AIT while holding a Lindt research brief, it returned the
        // correct price of 347.06 labelled "Lindt & Sprüngli AG". A real
        // figure under the wrong company is worse than a missing one.
        name: names[t] || null,
        price: q.price,
        previousClose: q.prevClose ?? null,
        dayChange: q.dayChange ?? null,
        dayChangePct:
          q.changePct != null ? Number((q.changePct * 100).toFixed(2)) : null,
        source: q.source || null,
      });
    }
    // Named, not silently dropped: a model handed four quotes when it
    // asked for five will happily answer about the fifth.
    return {
      quotes: found,
      ...(missing.length ? { couldNotPrice: missing } : {}),
      asOf: new Date().toISOString(),
      note:
        'Delayed or last-sale prices, not a live trading feed. Where `name` is null we could not confirm the company — report the TICKER only and do not name the company from memory.',
    };
  },

  async get_company_snapshot(args) {
    const ticker = clean(args?.ticker);
    if (!ticker) return { error: 'No ticker given.' };
    const snap = await getPeerSnapshot(ticker);
    if (!snap) {
      return {
        error: `No snapshot available for ${ticker}. It may be an ETF or a non-US listing — say that rather than estimating the figures.`,
      };
    }
    return snap;
  },

  async get_recent_filings(args) {
    const ticker = clean(args?.ticker);
    if (!ticker) return { error: 'No ticker given.' };
    const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 15);
    const filings = await getRecentFilings(ticker, { limit });
    if (!filings || filings.length === 0) {
      return { error: `No recent SEC filings found for ${ticker}. Foreign issuers and ETFs often have none — do not invent one.` };
    }
    return { ticker, filings: filings.slice(0, limit) };
  },
};

/**
 * Run one tool call. Never throws: a tool that takes the reply down with
 * it is worse than one that reports it could not answer.
 */
export async function runChatTool(name, rawArgs) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool: ${name}` };

  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
  } catch {
    return { error: 'Could not parse the tool arguments.' };
  }

  try {
    const out = await handler(args);
    return out ?? { error: 'The tool returned nothing.' };
  } catch (err) {
    console.warn(`chatTool ${name} failed:`, err.message);
    return { error: `${name} failed: ${err.message}. Say you could not retrieve it.` };
  }
}
