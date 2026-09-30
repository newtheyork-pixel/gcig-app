// What a ticker lookup says when every price source has failed.
//
// It used to answer 404 with whatever the last fallback said. With
// Finnhub refusing us and Yahoo blocking Render's addresses, a member
// typing AAPL was told "Ticker not found", or "Failed to get crumb,
// status 429": a claim about the company, or a riddle, when the fault
// was our own feed. Our outage must never read as a fact about the
// ticker, and a member's screenshot of this message is how a feed
// outage gets diagnosed, so it names each source and how it failed.

// Why Finnhub said no. One API key serves every panel and background
// job, and the free tier allows 60 calls a minute across all of them,
// so 429 is the allowance running out; 401/403 is the key itself.
export function finnhubRefusal(status) {
  if (status === 429) return 'is rate-limiting us (HTTP 429)';
  if (status === 401 || status === 403) return `refused our API key (HTTP ${status})`;
  return `answered HTTP ${status}`;
}

/**
 * `finnhub` is the trace fetchFinnhub fills in: `why` when it failed,
 * `unknown` when it answered and had no quote for the symbol. Only the
 * second can honestly be a 404; everything else is ours, so 502.
 */
export function feedFailure(ticker, finnhub = {}, yahooWhy = null) {
  const yahoo = yahooWhy
    ? `the Yahoo fallback failed too (${yahooWhy})`
    : 'the Yahoo fallback failed too';
  if (finnhub.unknown) {
    return {
      status: 404,
      error: `Finnhub has no quote for ${ticker}, and ${yahoo}. Check the symbol.`,
    };
  }
  return {
    status: 502,
    error: `Price feed unavailable for ${ticker}: Finnhub ${finnhub.why || 'did not answer'}, and ${yahoo}. This is our data feed, not the ticker.`,
  };
}
