import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tickerKey, sameTicker, normalizeTicker, tickerVariants, tickerWhere, groupByTicker,
} from './tickerKey.js';

test('case and surrounding space are noise', () => {
  assert.equal(tickerKey(' ait '), 'AIT');
  assert.ok(sameTicker('ait', 'AIT'));
  assert.ok(sameTicker(' Gd', 'GD '));
});

test('the share-class separator is noise, because every source picks a different one', () => {
  // Vendors write BRK.B, EDGAR writes BRK-B, a member types either, and
  // the club's own tables carry whichever was pasted in.
  assert.ok(sameTicker('BRK.B', 'BRK-B'));
  assert.ok(sameTicker('MOG-A', 'MOG.A'));
  assert.equal(tickerKey('BRK.B'), tickerKey('BRK-B'));
});

test('nothing else is stripped, because a ticker is an identifier', () => {
  // "Helpfully" removing punctuation is how MOG-A becomes MOGA and
  // matches nothing at all.
  assert.ok(!sameTicker('MOG-A', 'MOGA'));
  assert.ok(!sameTicker('AIT', 'AI'));
  assert.ok(!sameTicker('GD', 'GDX'));
});

test('empty is never equal to empty', () => {
  // Two rows with a blank ticker are not the same security; they are two
  // rows somebody failed to fill in. Matching them would join unrelated
  // records together.
  assert.equal(tickerKey(''), '');
  assert.equal(tickerKey(null), '');
  assert.ok(!sameTicker('', ''));
  assert.ok(!sameTicker(null, undefined));
});

test('validation is narrow enough to put in a URL', () => {
  assert.equal(normalizeTicker('ait'), 'AIT');
  assert.equal(normalizeTicker('BRK.B'), 'BRK.B');
  assert.equal(normalizeTicker('../etc/passwd'), null);
  assert.equal(normalizeTicker('AIT; DROP'), null);
  assert.equal(normalizeTicker('TOOLONGTICKERX'), null);
  assert.equal(normalizeTicker(''), null);
});

test('a query asks for every spelling the row might have been stored as', () => {
  const v = tickerVariants('BRK.B');
  assert.ok(v.includes('BRK.B') && v.includes('BRK-B'));
  assert.deepEqual(tickerVariants('AIT'), ['AIT']);
  assert.deepEqual(tickerVariants('nonsense!!'), []);
});

test('an unusable ticker matches nothing rather than everything', () => {
  // The dangerous failure: a where clause that degenerates to "no
  // filter" and returns another company's pitches under this one's name.
  const w = tickerWhere('!!!');
  assert.deepEqual(w, { ticker: '__NO_TICKER_MATCH__' });
  // Printable on purpose: a NUL sentinel makes Postgres throw on the
  // query rather than return nothing, which turns an unreadable ticker
  // into a 500 instead of an empty result.
  assert.ok(!JSON.stringify(w).includes('u0000'));
  const ok = tickerWhere('BRK.B');
  assert.ok(ok.ticker.in.includes('BRK-B'));
  assert.equal(ok.ticker.mode, 'insensitive');
  // The field is nameable, for tables that call it something else.
  assert.ok(tickerWhere('AIT', 'symbol').symbol);
});

test('rows from different tables group onto one security', () => {
  const rows = [
    { ticker: 'brk.b', kind: 'pitch' },
    { ticker: 'BRK-B', kind: 'vote' },
    { ticker: 'AIT', kind: 'pitch' },
    { ticker: '', kind: 'orphan' },
  ];
  const g = groupByTicker(rows);
  assert.equal(g.get('BRK-B').length, 2);
  assert.equal(g.get('AIT').length, 1);
  // The blank row is dropped rather than bucketed under ''.
  assert.equal(g.size, 2);
});
