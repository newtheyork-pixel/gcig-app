import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNasdaqFeed,
  parseNyseCsv,
  classifyHalts,
  decodeReason,
  REASON_CODES,
  getHalts,
} from './tradingHalts.js';

// Every fixture below is a trimmed copy of what the two wires actually
// served on 2026-08-07 — real symbols, real codes, real quoting quirks
// (the CSV's doubled literal quotes, the RSS's self-closed empties).
// Synthetic fixtures would encode what we assume the feeds look like,
// which is exactly the assumption these tests exist to check.

// The live channel's own pubDate: Sat, 08 Aug 2026 00:38:33 GMT —
// 8:38pm ET on Aug 7. Deliberately past UTC midnight, because the
// interesting classification bugs all live on that boundary.
const NOW = Date.parse('2026-08-08T00:38:33Z');

const NASDAQ_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/">
  <channel>
    <title>NASDAQTrader.com</title>
    <description>NASDAQ Trade Halts</description>
    <pubDate>Sat, 08 Aug 2026 00:38:33 GMT</pubDate>
    <ndaq:numItems>3</ndaq:numItems>
    <item>
      <title>AEHL</title>
      <pubDate>Fri, 07 Aug 2026 04:00:00 GMT</pubDate>
      <ndaq:HaltDate>08/07/2026</ndaq:HaltDate>
      <ndaq:HaltTime>19:50:00.000</ndaq:HaltTime>
      <ndaq:IssueSymbol>AEHL</ndaq:IssueSymbol>
      <ndaq:IssueName>Antelope Entprs Hld Cl A Ord</ndaq:IssueName>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>T1</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice />
      <ndaq:ResumptionDate />
      <ndaq:ResumptionQuoteTime />
      <ndaq:ResumptionTradeTime />
      <description><![CDATA[<table><tr><td>trimmed</td></tr></table>]]></description>
    </item>
    <item>
      <title>MB</title>
      <pubDate>Fri, 07 Aug 2026 04:00:00 GMT</pubDate>
      <ndaq:HaltDate>08/07/2026</ndaq:HaltDate>
      <ndaq:HaltTime>15:42:38.183</ndaq:HaltTime>
      <ndaq:IssueSymbol>MB</ndaq:IssueSymbol>
      <ndaq:IssueName>MasterBeef Grp Ord</ndaq:IssueName>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice />
      <ndaq:ResumptionDate>08/07/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>15:42:38</ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime>16:00:00</ndaq:ResumptionTradeTime>
      <description><![CDATA[<table><tr><td>trimmed</td></tr></table>]]></description>
    </item>
    <item>
      <title>BKSY.W</title>
      <pubDate>Fri, 07 Aug 2026 04:00:00 GMT</pubDate>
      <ndaq:HaltDate>08/07/2026</ndaq:HaltDate>
      <ndaq:HaltTime>16:05:26.515</ndaq:HaltTime>
      <ndaq:IssueSymbol>BKSY.W</ndaq:IssueSymbol>
      <ndaq:IssueName>BlackSky Technology Inc. Redeemable Warrants</ndaq:IssueName>
      <ndaq:Market>NYSE</ndaq:Market>
      <ndaq:ReasonCode>H11</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice />
      <ndaq:ResumptionDate />
      <ndaq:ResumptionQuoteTime />
      <ndaq:ResumptionTradeTime />
      <description><![CDATA[<table><tr><td>trimmed</td></tr></table>]]></description>
    </item>
  </channel>
</rss>`;

const NYSE_CSV = `Halt Date,Halt Time,Symbol,Name,Exchange,Reason,Resume Date,NYSE Resume Time
2026-08-07,19:50:00,TNONW,"""Tenon Medical, Inc. Warrant""",Nasdaq,News Pending,,
2026-08-07,16:05:26,BKSY WS,"""BlackSky Technology Inc. Redeemable Warrants, each whole Warrant exercisable for one-eighth (1/8th) of a share of Class A Common Stock at an exercise """,NYSE,Regulatory Concern,,
2026-08-07,15:42:38,MB,MasterBeef Group Ordinary Shares,Nasdaq,LULD Pause,2026-08-07,16:00:00
2025-05-19,00:21:31,SVA,"""Sinovac Biotech, Ltd""",Nasdaq,News Pending,,`;

// ── Nasdaq RSS parser ────────────────────────────────────────────────

test('parses a real active Nasdaq halt item', () => {
  const rows = parseNasdaqFeed(NASDAQ_XML);
  assert.equal(rows.length, 3);
  const a = rows[0];
  assert.equal(a.symbol, 'AEHL');
  assert.equal(a.name, 'Antelope Entprs Hld Cl A Ord');
  assert.equal(a.exchange, 'NASDAQ');
  assert.equal(a.reasonCode, 'T1');
  assert.equal(a.reason, 'News pending');
  // 7:50pm ET on Aug 7 is EDT, UTC-4.
  assert.equal(a.haltedAt, '2026-08-07T23:50:00.000Z');
  assert.equal(a.resumptionAt, null);
  assert.equal(a.source, 'nasdaq');
});

test('a resumed Nasdaq item takes the trade time, not the quote time', () => {
  const mb = parseNasdaqFeed(NASDAQ_XML).find((r) => r.symbol === 'MB');
  assert.equal(mb.reasonCode, 'LUDP');
  assert.equal(mb.haltedAt, '2026-08-07T19:42:38.183Z');
  // Quote window opened 15:42:38, trading resumed 16:00:00 — the
  // resumption is when the stock trades again.
  assert.equal(mb.resumptionAt, '2026-08-07T20:00:00.000Z');
});

test('self-closed empty resumption fields read as no value, not as empty strings', () => {
  const bksy = parseNasdaqFeed(NASDAQ_XML).find((r) => r.symbol === 'BKSY.W');
  assert.equal(bksy.resumptionAt, null);
  assert.equal(bksy.reasonCode, 'H11');
  assert.equal(bksy.reason, 'Regulatory concern (halted across markets)');
});

test('an unparseable Nasdaq body yields no rows rather than throwing', () => {
  for (const junk of ['', null, undefined, '<html>maintenance page</html>', '{"json":true}']) {
    assert.deepEqual(parseNasdaqFeed(junk), []);
  }
});

test('a Nasdaq item missing symbol or halt time is skipped, not invented', () => {
  const rows = parseNasdaqFeed(
    `<item><ndaq:HaltDate>08/07/2026</ndaq:HaltDate><ndaq:HaltTime>10:00:00.000</ndaq:HaltTime></item>
     <item><ndaq:IssueSymbol>OK</ndaq:IssueSymbol><ndaq:HaltDate>08/07/2026</ndaq:HaltDate><ndaq:HaltTime>10:00:00.000</ndaq:HaltTime><ndaq:ReasonCode>T1</ndaq:ReasonCode></item>`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'OK');
});

// ── NYSE CSV parser ──────────────────────────────────────────────────

test('parses the real NYSE CSV, including doubled-quote names with commas', () => {
  const rows = parseNyseCsv(NYSE_CSV);
  assert.equal(rows.length, 4);
  const tnon = rows[0];
  assert.equal(tnon.symbol, 'TNONW');
  // The export wraps some names in literal doubled quotes; the comma
  // inside must survive and the spare quotes must not.
  assert.equal(tnon.name, 'Tenon Medical, Inc. Warrant');
  assert.equal(tnon.exchange, 'Nasdaq');
  assert.equal(tnon.reason, 'News Pending');
  // NYSE publishes English, not codes — served verbatim, never
  // reverse-mapped to a Nasdaq code.
  assert.equal(tnon.reasonCode, null);
  assert.equal(tnon.haltedAt, '2026-08-07T23:50:00.000Z');
  assert.equal(tnon.resumptionAt, null);
  assert.equal(tnon.source, 'nyse');
});

test('a resumed NYSE row carries its resumption instant', () => {
  const mb = parseNyseCsv(NYSE_CSV).find((r) => r.symbol === 'MB');
  assert.equal(mb.haltedAt, '2026-08-07T19:42:38.000Z');
  assert.equal(mb.resumptionAt, '2026-08-07T20:00:00.000Z');
});

test('a months-old still-unresolved NYSE halt parses as active history', () => {
  // Real row: SVA has sat halted since May 2025. May 19 is EDT.
  const sva = parseNyseCsv(NYSE_CSV).find((r) => r.symbol === 'SVA');
  assert.equal(sva.haltedAt, '2025-05-19T04:21:31.000Z');
  assert.equal(sva.resumptionAt, null);
});

test('NYSE columns are found by header name, so a reordered export still parses', () => {
  const rows = parseNyseCsv(
    `Symbol,Reason,Halt Date,Halt Time,Exchange,Name,NYSE Resume Time,Resume Date
WWR,LULD Pause,2026-08-07,15:00:44,NYSE American,"Westwater Resources, Inc.",15:05:44,2026-08-07`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'WWR');
  assert.equal(rows[0].name, 'Westwater Resources, Inc.');
  assert.equal(rows[0].resumptionAt, '2026-08-07T19:05:44.000Z');
});

test('a reshaped NYSE export degrades to nothing, never to wrong rows', () => {
  assert.deepEqual(parseNyseCsv('Totally,Different,Columns\n1,2,3'), []);
  for (const junk of ['', null, undefined, '<html>blocked</html>']) {
    assert.deepEqual(parseNyseCsv(junk), []);
  }
});

// ── The decode table ─────────────────────────────────────────────────

test('decodes the halt codes seen on the live tape', () => {
  // Meanings from Nasdaq's own legend
  // (nasdaqtrader.com/trader.aspx?id=TradeHaltCodes, read 2026-08-07).
  assert.equal(decodeReason('T1'), 'News pending');
  assert.equal(decodeReason('T2'), 'News released');
  assert.equal(decodeReason('T12'), 'Additional information requested by Nasdaq');
  assert.equal(decodeReason('H10'), 'SEC trading suspension');
  assert.equal(decodeReason('H11'), 'Regulatory concern (halted across markets)');
  assert.equal(decodeReason('LUDP'), 'Limit up-limit down volatility pause');
  assert.equal(decodeReason('M'), 'Volatility trading pause (exchange-listed issue)');
  assert.equal(decodeReason('MWC1'), 'Market-wide circuit breaker — Level 1');
  assert.equal(decodeReason('MWC3'), 'Market-wide circuit breaker — Level 3');
});

test('an unknown code renders as itself — the raw code, never a guess', () => {
  assert.equal(decodeReason('ZZ9'), 'ZZ9');
  assert.equal(decodeReason('t1'), 'News pending'); // case-normalized
  assert.equal(decodeReason(''), null);
  assert.equal(decodeReason(null), null);
});

test('every table entry decodes to prose, not to itself', () => {
  // A key accidentally mapped to an empty or identical string would
  // silently downgrade a known code to "unknown" styling.
  for (const [code, meaning] of Object.entries(REASON_CODES)) {
    assert.ok(meaning && meaning !== code, `${code} has no real decode`);
  }
});

// ── Classification ───────────────────────────────────────────────────

test('classifies active vs resumed against now, on the ET calendar', () => {
  const rows = classifyHalts(
    [...parseNasdaqFeed(NASDAQ_XML), ...parseNyseCsv(NYSE_CSV)],
    NOW
  );
  const by = (s) => rows.find((r) => r.symbol === s);
  assert.equal(by('AEHL').resumed, false);
  // MB resumed 20:00Z Aug 7 with NOW past UTC midnight on Aug 8 —
  // different UTC days, same ET day. A UTC-day rule would wrongly
  // drop it from "resolved today".
  assert.equal(by('MB').resumed, true);
  // SVA: halted since May 2025, never resumed — an old ACTIVE halt is
  // exactly the thing to keep showing.
  assert.equal(by('SVA').resumed, false);
});

test('the same halt on both wires collapses to the coded Nasdaq row', () => {
  const rows = classifyHalts(
    [...parseNasdaqFeed(NASDAQ_XML), ...parseNyseCsv(NYSE_CSV)],
    NOW
  );
  const mbs = rows.filter((r) => r.symbol === 'MB');
  assert.equal(mbs.length, 1);
  assert.equal(mbs[0].source, 'nasdaq');
  assert.equal(mbs[0].reasonCode, 'LUDP');
  // Pinned, documented limitation: the two wires spell warrant
  // suffixes differently (BKSY.W vs "BKSY WS"), which the dedupe
  // does not bridge — both rows show rather than risk merging two
  // different instruments.
  assert.equal(rows.filter((r) => r.symbol.startsWith('BKSY')).length, 2);
});

test('a halt resumed on a prior ET day is dropped; a future resumption stays active', () => {
  const base = {
    name: null,
    exchange: 'NASDAQ',
    reason: 'News pending',
    reasonCode: 'T1',
    source: 'nasdaq',
  };
  const rows = classifyHalts(
    [
      // Resumed yesterday — history, not today's tape.
      { ...base, symbol: 'OLD', haltedAt: '2026-08-06T14:00:00.000Z', resumptionAt: '2026-08-06T15:00:00.000Z' },
      // Resumption scheduled for tomorrow morning — still halted NOW.
      { ...base, symbol: 'SOON', haltedAt: '2026-08-07T21:00:00.000Z', resumptionAt: '2026-08-08T13:00:00.000Z' },
    ],
    NOW
  );
  assert.equal(rows.find((r) => r.symbol === 'OLD'), undefined);
  const soon = rows.find((r) => r.symbol === 'SOON');
  assert.equal(soon.resumed, false);
  assert.equal(soon.resumptionAt, '2026-08-08T13:00:00.000Z');
});

test('orders newest halt first', () => {
  const rows = classifyHalts(
    [...parseNasdaqFeed(NASDAQ_XML), ...parseNyseCsv(NYSE_CSV)],
    NOW
  );
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      Date.parse(rows[i - 1].haltedAt) >= Date.parse(rows[i].haltedAt),
      `rows ${i - 1} and ${i} out of order`
    );
  }
});

// ── getHalts ─────────────────────────────────────────────────────────

test('one dead wire does not blank the other', async () => {
  const out = await getHalts({
    fetchNasdaq: async () => {
      throw new Error('rss.aspx timed out');
    },
    fetchNyse: async () => parseNyseCsv(NYSE_CSV),
    now: NOW,
  });
  assert.equal(out.sources.nasdaq, 0);
  assert.equal(out.sources.nyse, 4);
  assert.ok(out.halts.length > 0);
  assert.ok(out.halts.every((h) => h.source === 'nyse'));
});

test('both wires down is an empty tape with a visible roll call, never a throw', async () => {
  const out = await getHalts({
    fetchNasdaq: async () => null,
    fetchNyse: async () => {
      throw new Error('csv 403');
    },
    now: NOW,
  });
  assert.deepEqual(out.halts, []);
  // Injected fetchers bypass lastGood, so both wires read live-but-empty
  // rather than stale — the roll call still shows zero rows each.
  assert.equal(out.sources.nasdaq, 0);
  assert.equal(out.sources.nyse, 0);
  assert.equal(out.sources.nasdaqLive, true);
  assert.equal(out.sources.nyseLive, true);
  assert.equal(out.fetchedAt, new Date(NOW).toISOString());
});

test('the merged payload carries the documented shape', async () => {
  const out = await getHalts({
    fetchNasdaq: async () => parseNasdaqFeed(NASDAQ_XML),
    fetchNyse: async () => parseNyseCsv(NYSE_CSV),
    now: NOW,
  });
  assert.equal(out.sources.nasdaq, 3);
  assert.equal(out.sources.nyse, 4);
  for (const h of out.halts) {
    assert.equal(typeof h.symbol, 'string');
    assert.equal(typeof h.reason, 'string');
    assert.ok('exchange' in h && 'haltedAt' in h && 'reasonCode' in h);
    assert.equal(typeof h.resumed, 'boolean');
    assert.ok('resumptionAt' in h);
  }
});
