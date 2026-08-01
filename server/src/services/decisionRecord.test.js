import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeOnOrBefore, lastClose, scoreDecision, summarize, buildScoreboard, MATURITY_DAYS,
} from './decisionRecord.js';

/// A series of daily closes starting at `from`, one per day, so a test
/// can say "a year of it" without hand-writing 250 rows.
function series(from, closes) {
  const start = new Date(from).getTime();
  return closes.map((c, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    close: c,
  }));
}

/// Flat benchmark of the same length, so the excess return equals the
/// stock's own return and the arithmetic under test is visible.
function flat(from, n, level = 100) {
  return series(from, Array(n).fill(level));
}

test('a decision made on a closed market prices at the last print anyone saw', () => {
  // Meetings run on whatever evening the room is free, and the market
  // is regularly shut. Searching FORWARD would price a Friday vote at
  // Monday's open and charge the club for a weekend it had no part in.
  const bars = [
    { date: '2026-06-04', close: 100 },
    { date: '2026-06-05', close: 110 },   // Friday
    { date: '2026-06-08', close: 130 },   // Monday, after a weekend gap
  ];
  assert.equal(closeOnOrBefore(bars, '2026-06-06').close, 110);
  assert.equal(closeOnOrBefore(bars, '2026-06-07').close, 110);
  assert.equal(closeOnOrBefore(bars, '2026-06-05').close, 110);
  // Before the series starts there is nothing to stand on.
  assert.equal(closeOnOrBefore(bars, '2026-01-01'), null);
  assert.equal(lastClose(bars).close, 130);
});

test('a buy is scored against the index, not against zero', () => {
  // The club's alternative to owning a stock is owning the index. A buy
  // that returned 10% while SPY returned 25% cost the club money it
  // would otherwise have had, and a report card scored against zero
  // would call it a win.
  const r = scoreDecision({
    decision: 'Buy',
    closedAt: '2025-01-01',
    bars: series('2025-01-01', [100, ...Array(400).fill(110)]),
    benchBars: series('2025-01-01', [100, ...Array(400).fill(125)]),
  });
  assert.equal(r.scored, true);
  assert.ok(Math.abs(r.ret - 10) < 0.001);
  assert.ok(Math.abs(r.bench - 25) < 0.001);
  assert.ok(r.excess < 0, 'beating zero but losing to the index is a loss');
  assert.ok(Math.abs(r.excess + 15) < 0.001);
});

test('a sell that dodged a fall is a win, not a loss', () => {
  // The same arithmetic that rewards a buy on a rising stock would file
  // the club's best exits as its worst calls. IBRX is the real case:
  // voted out in June on four ballots.
  const r = scoreDecision({
    decision: 'Sell',
    closedAt: '2025-01-01',
    bars: series('2025-01-01', [100, ...Array(400).fill(60)]),   // fell 40%
    benchBars: flat('2025-01-01', 401),
  });
  assert.ok(r.excess > 0, 'avoiding a 40% fall is a good decision');
  assert.ok(Math.abs(r.excess - 40) < 0.001);
  assert.equal(r.sign, -1);

  // And a sell before a rally is a real loss, stated as one.
  const missed = scoreDecision({
    decision: 'Sell',
    closedAt: '2025-01-01',
    bars: series('2025-01-01', [100, ...Array(400).fill(150)]),
    benchBars: flat('2025-01-01', 401),
  });
  assert.ok(missed.excess < 0);
});

test('a name the club looked at and passed on is scored too', () => {
  // NoBuy is a decision. Leaving it out would grade the club only on
  // the trades it made, which is the flattering half of the record.
  const dodged = scoreDecision({
    decision: 'NoBuy',
    closedAt: '2025-01-01',
    bars: series('2025-01-01', [100, ...Array(400).fill(50)]),
    benchBars: flat('2025-01-01', 401),
  });
  assert.ok(dodged.excess > 0);

  // Hold is different: it says nothing about what the club expected, so
  // there is no direction to grade.
  const hold = scoreDecision({
    decision: 'Hold',
    closedAt: '2025-01-01',
    bars: series('2025-01-01', [100, ...Array(400).fill(50)]),
    benchBars: flat('2025-01-01', 401),
  });
  assert.equal(hold.scored, false);
  assert.match(hold.reason, /no direction/);
});

test('a recent decision keeps its number and loses its verdict', () => {
  const r = scoreDecision({
    decision: 'Buy',
    closedAt: '2026-07-01',
    bars: series('2026-07-01', [100, 106]),
    benchBars: flat('2026-07-01', 2),
  });
  assert.equal(r.scored, true);
  assert.ok(Math.abs(r.excess - 6) < 0.001, 'the number is still real');
  assert.equal(r.mature, false, 'a one-day 6% move is not a verdict');

  const old = scoreDecision({
    decision: 'Buy',
    closedAt: '2025-01-01',
    bars: series('2025-01-01', [100, ...Array(MATURITY_DAYS + 10).fill(106)]),
    benchBars: flat('2025-01-01', MATURITY_DAYS + 11),
  });
  assert.equal(old.mature, true);
});

test('the reasons a decision cannot be scored are kept apart', () => {
  // "We hold no prices for this ticker" is our gap. "The vote predates
  // our history" is a limit of the archive. "The benchmark failed" is an
  // outage. Collapsing them into one dash sends somebody to look for the
  // wrong thing.
  const noHistory = scoreDecision({ decision: 'Buy', closedAt: '2025-01-01', bars: [], benchBars: flat('2025-01-01', 5) });
  assert.equal(noHistory.scored, false);
  assert.match(noHistory.reason, /No price history/);

  const predates = scoreDecision({
    decision: 'Buy', closedAt: '2019-01-01',
    bars: series('2025-01-01', [100, 110]), benchBars: flat('2025-01-01', 2),
  });
  assert.match(predates.reason, /decision date/);

  const noBench = scoreDecision({
    decision: 'Buy', closedAt: '2025-01-01',
    bars: series('2025-01-01', [100, 110]), benchBars: [],
  });
  assert.match(noBench.reason, /benchmark/);
});

test('the summary shows its denominator, because four decisions is not a hit rate', () => {
  const rows = [
    { scored: true, mature: true, excess: 10 },
    { scored: true, mature: true, excess: -4 },
    { scored: true, mature: false, excess: 90 },   // last week, excluded
    { scored: false, reason: 'No price history' },
  ];
  const s = summarize(rows);
  assert.equal(s.decisions, 4);
  assert.equal(s.mature, 2);
  assert.equal(s.tooEarly, 1);
  assert.equal(s.unscored, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.hitRate, 50);
  // Averaged, not compounded: these are parallel judgments on different
  // names, not a sequence of positions in one account.
  assert.equal(s.avgExcess, 3);
  // A 90% winner sitting in tooEarly must not leak into the average.
  assert.ok(s.avgExcess < 10);
});

test('nothing mature yet reports null rather than zero', () => {
  // A zero hit rate means the club got everything wrong. No mature
  // decisions means we do not know yet, and those must never render the
  // same.
  const s = summarize([{ scored: true, mature: false, excess: 5 }]);
  assert.equal(s.hitRate, null);
  assert.equal(s.avgExcess, null);
  assert.equal(summarize([]).decisions, 0);
});

test('a ticker whose history fails does not take the scoreboard with it', async () => {
  const out = await buildScoreboard(
    [
      { ticker: 'GD', decision: 'Buy', closedAt: '2025-01-01' },
      { ticker: 'BROKEN', decision: 'Buy', closedAt: '2025-01-01' },
    ],
    {
      getHistory: async (t) => {
        if (t === 'BROKEN') throw new Error('EDGAR is having a day');
        return series('2025-01-01', [100, ...Array(200).fill(120)]);
      },
    },
  );
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].scored, true);
  assert.equal(out.rows[1].scored, false);
  assert.equal(out.benchError, null);
});

test('a dead benchmark is said once, not thirty times', async () => {
  const out = await buildScoreboard(
    [{ ticker: 'GD', decision: 'Buy', closedAt: '2025-01-01' }],
    {
      getHistory: async (t) => {
        if (t === 'SPY') throw new Error('rate limited');
        return series('2025-01-01', [100, 120]);
      },
    },
  );
  assert.match(out.benchError, /rate limited/);
  assert.equal(out.rows[0].scored, false);
});
