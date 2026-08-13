import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bySizeProximity, parseTickers, mergePeers, competitionSection,
  getPeerSet, _resetPeerSetCache,
} from './peerSet.js';

// The case that started this: AMZN PEER led with Dillard's and never
// showed Walmart. Both were GICS working exactly as specified — since
// the 2023 revision the department stores share Broadline Retail with
// Amazon, and Walmart sits in a different sector — which is why a
// classification alone cannot answer this panel's question.

const CAPS = {
  AMZN: 2_450_000, DDS: 4_100, EBAY: 40_000, MELI: 105_000,
  W: 6_800, CHWY: 14_000, KSS: 1_900, WMT: 780_000,
};

test('a department store 600x smaller sorts below the large cohort names', () => {
  const ranked = bySizeProximity(CAPS.AMZN, [
    { ticker: 'DDS', marketCap: CAPS.DDS },
    { ticker: 'EBAY', marketCap: CAPS.EBAY },
    { ticker: 'MELI', marketCap: CAPS.MELI },
    { ticker: 'KSS', marketCap: CAPS.KSS },
  ]);
  assert.equal(ranked[0].ticker, 'MELI', 'closest in size leads');
  assert.equal(ranked.at(-1).ticker, 'KSS');
  assert.ok(
    ranked.findIndex((r) => r.ticker === 'DDS') > ranked.findIndex((r) => r.ticker === 'EBAY'),
    'Dillard\'s must not outrank eBay against Amazon',
  );
});

test('an unknown market cap sorts last but is never dropped', () => {
  const ranked = bySizeProximity(CAPS.AMZN, [
    { ticker: 'MYSTERY', marketCap: null },
    { ticker: 'EBAY', marketCap: CAPS.EBAY },
  ]);
  assert.equal(ranked.length, 2, 'an unknown size is not a small one');
  assert.equal(ranked.at(-1).ticker, 'MYSTERY');
});

test('with no focus cap, nothing is reordered into a false ranking', () => {
  const ranked = bySizeProximity(null, [
    { ticker: 'B', marketCap: 10 },
    { ticker: 'A', marketCap: 20 },
  ]);
  assert.deepEqual(ranked.map((r) => r.ticker), ['A', 'B'], 'falls back to a stable alphabetical order');
});

test('the filing wins over our judgement, which wins over the classification', () => {
  const merged = mergePeers({
    filing: ['MOT'],
    judged: ['GPC', 'FAST'],
    sector: [{ ticker: 'DDS' }, { ticker: 'EBAY' }],
  }, { limit: 4, exclude: 'AIT' });
  assert.deepEqual(merged.map((r) => r.source), ['filing', 'peer', 'peer', 'sector']);
  assert.equal(merged[0].ticker, 'MOT');
});

test('a name reached by two sources is credited to the better one, once', () => {
  const merged = mergePeers({ filing: ['WMT'], judged: ['WMT'], sector: [{ ticker: 'WMT' }] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'filing');
});

test('the focus company can never be its own peer', () => {
  const merged = mergePeers({ judged: ['AMZN', 'WMT'] }, { exclude: 'AMZN' });
  assert.deepEqual(merged.map((r) => r.ticker), ['WMT']);
});

test('a model that answers in prose contributes nothing rather than garbage', () => {
  assert.deepEqual(parseTickers('NONE'), []);
  assert.deepEqual(parseTickers('The filing does not name any competitors.'), []);
  assert.deepEqual(parseTickers(''), []);
});

test('tickers are parsed from either separator, deduped, focus removed', () => {
  assert.deepEqual(
    parseTickers('WMT, COST\nTGT WMT', { exclude: 'TGT' }),
    ['WMT', 'COST'],
  );
});

test('the competition section is scoped, so litigants and customers stay out', () => {
  const item1 = 'Item 1. Business. We sell things. '
    + 'Our largest customer is Acme Corporation. '
    + 'Competition. We compete with Globex and Initech. '
    + 'Employees. We had many.';
  const seg = competitionSection(item1);
  assert.ok(seg.includes('Globex'), 'the competitors are in scope');
  assert.ok(!seg.includes('Acme'), 'the customer named earlier is not');
});

test('a filing with no competition discussion yields no filing-sourced peers', () => {
  assert.equal(competitionSection('Item 1. Business. We make widgets and sell them.'), null);
});

// The end-to-end shape, with every outside dependency stubbed. What is
// being pinned is that Amazon comes back with large comparables rather
// than a department store, and that each row can say where it came from.
test('AMZN resolves to size-comparable names, each carrying its source', async () => {
  _resetPeerSetCache();
  const out = await getPeerSet('AMZN', {
    // Amazon's real 10-K describes nine categories of competitor and
    // names no company at all, so this source correctly contributes
    // nothing and must not be filled in with guesses.
    getBusinessSummary: async () => 'Item 1. Competition. Our current and potential '
      + 'competitors include: (1) physical, e-commerce, and omnichannel retailers, '
      + 'publishers, vendors, distributors, manufacturers, and producers of the products '
      + 'we offer and sell to consumers and businesses; (2) web search engines and '
      + 'comparison shopping websites; (3) companies that provide information technology '
      + 'services or products, including on-premises or cloud-based infrastructure.',
    llmChat: async ({ messages }) => {
      const system = messages[0].content;
      if (system.includes('NAMED IN THIS TEXT')) return 'NONE';
      return 'WMT COST BABA EBAY MELI TGT';
    },
    getPeers: async () => ['AMZN', 'DDS', 'EBAY', 'KSS', 'W'],
    marketCaps: async () => CAPS,
    verifyTicker: async () => true,
  });

  const tickers = out.peers.map((p) => p.ticker);
  assert.ok(tickers.includes('WMT'), 'Walmart must be reachable; GICS alone never offers it');
  assert.ok(!tickers.slice(0, 3).includes('DDS'), 'Dillard\'s must not lead Amazon\'s peers');
  assert.ok(out.peers.every((p) => p.source), 'every row states its provenance');
  assert.ok(out.caveat, 'a judged row must be declared as a judgement');
});

test('a ticker EDGAR has never heard of is dropped, not shown', async () => {
  _resetPeerSetCache();
  const out = await getPeerSet('AIT', {
    getBusinessSummary: async () => 'Item 1. Competition. We compete with Motion and Genuine Parts.',
    llmChat: async ({ messages }) =>
      (messages[0].content.includes('NAMED IN THIS TEXT') ? 'GPC NOTAREALTICKER' : 'FAST'),
    getPeers: async () => [],
    marketCaps: async () => ({}),
    verifyTicker: async (t) => t !== 'NOTAREALTICKER',
  });
  const tickers = out.peers.map((p) => p.ticker);
  assert.ok(tickers.includes('GPC'));
  assert.ok(!tickers.includes('NOTAREALTICKER'), 'a hallucinated symbol may never reach the panel');
});

test('every source failing leaves an empty list, never a thrown panel', async () => {
  _resetPeerSetCache();
  const out = await getPeerSet('ZZZZ', {
    getBusinessSummary: async () => { throw new Error('EDGAR throttled'); },
    llmChat: async () => { throw new Error('model unreachable'); },
    getPeers: async () => { throw new Error('vendor down'); },
    marketCaps: async () => { throw new Error('no caps'); },
  });
  assert.deepEqual(out.peers, []);
});
