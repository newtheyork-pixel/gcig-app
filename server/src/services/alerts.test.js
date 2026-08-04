import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, summarize, daysUntil, IPS } from './alerts.js';

const JUL = new Date('2026-07-15T12:00:00Z');
const NOV = new Date('2026-11-15T12:00:00Z');
const book = (over = {}) => ({
  holdings: [
    { ticker: 'APLD', marketValue: 5012, percentReturn: -31.4 },
    { ticker: 'GD', marketValue: 7668, percentReturn: 11.9 },
    { ticker: 'VOO', marketValue: 44632, percentReturn: 8.0 },
  ],
  cash: 10151,
  now: JUL,
  ...over,
});

test('the drawdown rule fires with the number and the threshold', () => {
  // "APLD is down" is a mood. The alert has to carry what it is and what
  // it crossed, or an exec cannot dispute it and a member cannot act.
  const a = evaluate(book()).find((x) => x.id === 'review-APLD');
  assert.ok(a);
  assert.equal(a.kind, 'action');
  assert.ok(a.title.includes('-31.4%'));
  assert.equal(a.threshold, IPS.reviewDrawdownPct);
  // The charter's own words travel with it.
  assert.match(a.detail, /voting members must meet to review/);
  assert.match(a.source, /ips\.md/);
});

test('a position inside the threshold raises nothing', () => {
  const alerts = evaluate(book({
    holdings: [{ ticker: 'GD', marketValue: 100, percentReturn: -14.9 }],
  }));
  assert.equal(alerts.filter((a) => a.id.startsWith('review-')).length, 0);
  // And exactly at the line it does fire — the charter says "beyond 15%"
  // and a position sitting on it is the one worth arguing about.
  const at = evaluate(book({
    holdings: [{ ticker: 'GD', marketValue: 100, percentReturn: -15 }],
  }));
  assert.equal(at.filter((a) => a.id.startsWith('review-')).length, 1);
});

test('concentration is measured against the whole fund, cash included', () => {
  // Against equity alone every position looks larger and the cap would
  // fire on names that are nowhere near it.
  const a = evaluate(book()).find((x) => x.id === 'concentration-VOO');
  assert.ok(a);
  assert.ok(a.value > 60 && a.value < 70, `expected ~66%, got ${a.value}`);
  // And it declines to rule on the ambiguity rather than pretending.
  assert.match(a.detail, /whether a broad index fund counts/);
});

test('a rule that cannot run says so instead of passing', () => {
  // The failure that makes a compliance screen worse than none: an
  // outage rendering as silence, which reads as compliant.
  const alerts = evaluate({ holdings: [], cash: null, now: JUL });
  const ids = alerts.map((a) => a.id);
  assert.ok(ids.includes('unchecked-drawdown'));
  assert.ok(ids.includes('unchecked-cash'));
  assert.equal(summarize(alerts).clear, true, 'unchecked is not a breach');
  assert.equal(summarize(alerts).unchecked, 2);
});

test('the summer rule only fires in summer', () => {
  const jul = evaluate(book()).find((a) => a.id === 'summer-picks');
  assert.ok(jul, 'July should raise it');
  assert.ok(jul.title.includes('2 individual names'), jul.title);
  assert.ok(jul.detail.includes('APLD') && jul.detail.includes('GD'));
  assert.ok(!jul.detail.includes('VOO'), 'ETFs may be held over the summer');

  // A rule that fires in November is a rule people learn to dismiss.
  assert.equal(evaluate(book({ now: NOV })).find((a) => a.id === 'summer-picks'), undefined);
});

test('cash below the floor is a breach, above it is silence', () => {
  const low = evaluate(book({ cash: 100 })).find((a) => a.id === 'cash-floor');
  assert.ok(low);
  assert.equal(low.kind, 'breach');
  assert.equal(evaluate(book()).find((a) => a.id === 'cash-floor'), undefined);
});

test('earnings inside a week are a watch, beyond it are nothing', () => {
  const alerts = evaluate(book({
    earnings: [
      { ticker: 'AIT', date: '2026-07-18', hour: 'bmo' },
      { ticker: 'BN', date: '2026-09-01' },
    ],
  }));
  const ids = alerts.map((a) => a.id);
  assert.ok(ids.includes('earnings-AIT'));
  assert.ok(!ids.includes('earnings-BN'));
});

test('breaches sort above actions, actions above watches', () => {
  const alerts = evaluate(book({
    cash: 1,
    earnings: [{ ticker: 'AIT', date: '2026-07-16' }],
  }));
  const kinds = alerts.map((a) => a.kind);
  assert.equal(kinds[0], 'breach');
  assert.ok(kinds.indexOf('action') < kinds.indexOf('watch'));
});

test('day arithmetic does not drift across timezones', () => {
  assert.equal(daysUntil('2026-07-15', JUL), 0);
  assert.equal(daysUntil('2026-07-16', JUL), 1);
  assert.equal(daysUntil('2026-07-14', JUL), -1);
  assert.equal(daysUntil(null), null);
  assert.equal(daysUntil('nonsense'), null);
});
