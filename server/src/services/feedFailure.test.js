import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finnhubRefusal, feedFailure } from './feedFailure.js';

test('finnhubRefusal names the rate limit and a refused key', () => {
  assert.match(finnhubRefusal(429), /rate-limiting us \(HTTP 429\)/);
  assert.match(finnhubRefusal(401), /refused our API key \(HTTP 401\)/);
  assert.match(finnhubRefusal(403), /refused our API key \(HTTP 403\)/);
  assert.equal(finnhubRefusal(500), 'answered HTTP 500');
});

test('our outage is a 502 that names every source, never "not found"', () => {
  const out = feedFailure('AAPL', { why: finnhubRefusal(429) }, 'Failed to get crumb, status 429');
  assert.equal(out.status, 502);
  assert.match(out.error, /Price feed unavailable for AAPL/);
  assert.match(out.error, /Finnhub is rate-limiting us \(HTTP 429\)/);
  assert.match(out.error, /Yahoo fallback failed too \(Failed to get crumb, status 429\)/);
  assert.match(out.error, /our data feed, not the ticker/);
  assert.doesNotMatch(out.error, /not found/i);
});

test('an unset key says so', () => {
  const out = feedFailure('MSFT', { why: 'is not configured (FINNHUB_API_KEY is unset)' });
  assert.equal(out.status, 502);
  assert.match(out.error, /FINNHUB_API_KEY is unset/);
});

test('only a symbol Finnhub answered for and did not know is a 404', () => {
  const out = feedFailure('ZZZZQ', { unknown: true }, 'Not Found');
  assert.equal(out.status, 404);
  assert.match(out.error, /Finnhub has no quote for ZZZZQ/);
  assert.match(out.error, /Check the symbol/);
});

test('a trace with nothing in it still blames the feed, not the ticker', () => {
  const out = feedFailure('GD');
  assert.equal(out.status, 502);
  assert.match(out.error, /Finnhub did not answer/);
});
