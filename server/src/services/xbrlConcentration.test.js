import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConcentration, latestPeriod, humanizeMember, factValue, getCustomerConcentration,
} from './xbrlConcentration.js';

// The shape Johnson & Johnson actually files, reduced to the parts that
// matter. Three anonymised wholesalers against net sales, plus the
// product-concentration figure measured against R&D expense that must
// not end up in a customer table.
const JNJ = `
<html><body>
<xbrli:context id="c-972">
  <xbrli:entity><xbrli:segment>
    <xbrldi:explicitMember dimension="srt:MajorCustomersAxis">jnj:Wholesaler1Member</xbrldi:explicitMember>
    <xbrldi:explicitMember dimension="us-gaap:ConcentrationRiskByTypeAxis">jnj:WholesalerConcentrationRiskMember</xbrldi:explicitMember>
    <xbrldi:explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:SalesRevenueNetMember</xbrldi:explicitMember>
  </xbrli:segment></xbrli:entity>
  <xbrli:period><xbrli:startDate>2024-12-30</xbrli:startDate><xbrli:endDate>2025-12-28</xbrli:endDate></xbrli:period>
</xbrli:context>
<xbrli:context id="c-973">
  <xbrli:segment>
    <xbrldi:explicitMember dimension="srt:MajorCustomersAxis">jnj:Wholesaler2Member</xbrldi:explicitMember>
    <xbrldi:explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:SalesRevenueNetMember</xbrldi:explicitMember>
  </xbrli:segment>
  <xbrli:period><xbrli:startDate>2024-12-30</xbrli:startDate><xbrli:endDate>2025-12-28</xbrli:endDate></xbrli:period>
</xbrli:context>
<xbrli:context id="c-old">
  <xbrli:segment>
    <xbrldi:explicitMember dimension="srt:MajorCustomersAxis">jnj:Wholesaler1Member</xbrldi:explicitMember>
    <xbrldi:explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:SalesRevenueNetMember</xbrldi:explicitMember>
  </xbrli:segment>
  <xbrli:period><xbrli:startDate>2023-01-02</xbrli:startDate><xbrli:endDate>2024-12-29</xbrli:endDate></xbrli:period>
</xbrli:context>
<xbrli:context id="c-60">
  <xbrli:segment>
    <xbrldi:explicitMember dimension="us-gaap:ConcentrationRiskByTypeAxis">us-gaap:ProductConcentrationRiskMember</xbrldi:explicitMember>
    <xbrldi:explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:ResearchAndDevelopmentExpenseMember</xbrldi:explicitMember>
  </xbrli:segment>
  <xbrli:period><xbrli:startDate>2024-12-30</xbrli:startDate><xbrli:endDate>2025-12-28</xbrli:endDate></xbrli:period>
</xbrli:context>

<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="c-972" scale="-2" decimals="3">21.8</ix:nonFraction>
<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="c-973" scale="-2" decimals="3">15.5</ix:nonFraction>
<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="c-old" scale="-2" decimals="3">20.5</ix:nonFraction>
<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="c-60" scale="-2" decimals="3">5</ix:nonFraction>
</body></html>`;

test('anonymised wholesalers come back as the filer named them', () => {
  const rows = parseConcentration(JNJ);
  const latest = latestPeriod(rows);
  assert.equal(latest.period, '2025-12-28');
  assert.deepEqual(latest.rows.map((r) => [r.label, r.pct]),
    [['Wholesaler 1', 21.8], ['Wholesaler 2', 15.5]]);
  // The combined share is the fact worth having: two counterparties at
  // 21.8 and 15.5 is a different statement from either one alone.
  assert.equal(latest.total, 37.3);
});

test('a concentration measured against R&D expense is not a customer', () => {
  // JNJ files a 5% product concentration against research and
  // development expense. In a customer table it would read as a small
  // customer, which it is not — it is not a customer at all.
  const rows = parseConcentration(JNJ);
  assert.ok(!rows.some((r) => r.pct === 5), 'the R&D-benchmarked figure must be excluded');
  assert.ok(rows.every((r) => /Sales Revenue|Revenue/i.test(r.benchmark)));
});

test('only the newest period is reported', () => {
  const rows = parseConcentration(JNJ);
  // The prior year's 20.5% for the same wholesaler is in the filing and
  // must not sit in the same table as this year's 21.8%.
  assert.ok(rows.some((r) => r.pct === 20.5), 'prior year is parsed');
  assert.ok(!latestPeriod(rows).rows.some((r) => r.pct === 20.5), 'but not reported');
});

test('the party axis wins over the risk-type axis', () => {
  // Applied Digital's real shape: both axes present. Matching the type
  // axis first labelled a 59%-of-revenue customer "Customer
  // Concentration Risk" — the category, not the counterparty.
  const APLD = `
    <context id="c-127"><segment>
      <explicitMember dimension="us-gaap:ConcentrationRiskByTypeAxis">us-gaap:CustomerConcentrationRiskMember</explicitMember>
      <explicitMember dimension="srt:MajorCustomersAxis">apld:CustomerAMember</explicitMember>
      <explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:SalesRevenueNetMember</explicitMember>
    </segment><period><startDate>2025-06-01</startDate><endDate>2026-05-31</endDate></period></context>
    <ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="c-127" scale="-2">59</ix:nonFraction>`;
  const rows = parseConcentration(APLD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Customer A');
  assert.equal(rows[0].pct, 59);
});

test('bare namespace prefixes parse too', () => {
  // Prefixes are a filer's choice. A parser that only knows xbrli:
  // returns silent nothing for everybody else.
  const bare = `
    <context id="x1"><segment>
      <explicitMember dimension="srt:MajorCustomersAxis">co:CustomerOneMember</explicitMember>
      <explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:RevenueFromContractWithCustomerMember</explicitMember>
    </segment><period><startDate>2025-01-01</startDate><endDate>2025-12-31</endDate></period></context>
    <ix:nonFraction name="us-gaap:ConcentrationRiskPercentage1" contextRef="x1" scale="-2">33.4</ix:nonFraction>`;
  const rows = parseConcentration(bare);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pct, 33.4);
  assert.equal(rows[0].label, 'Customer One');
});

test('scale is honoured, and a dash is not a number', () => {
  // The document prints 21.8 and means 0.218; a filer printing 0.218
  // with no scale means the same thing.
  assert.equal(factValue('scale="-2"', '21.8'), 21.8);
  assert.equal(factValue('scale="0"', '0.218'), 21.8);
  // Thousands separators parse; the resulting 1234% is nonsense and is
  // rejected by parseConcentration's 0 < pct <= 100 guard rather than
  // here, so factValue stays a pure reading of the tag.
  assert.equal(factValue('scale="-2"', '1,234'), 1234);
  assert.equal(parseConcentration(`
    <context id="z"><segment>
      <explicitMember dimension="srt:MajorCustomersAxis">co:CustomerOneMember</explicitMember>
      <explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:SalesRevenueNetMember</explicitMember>
    </segment><period><endDate>2025-12-31</endDate></period></context>
    <ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="z" scale="-2">1,234</ix:nonFraction>`).length, 0);
  // An em dash is how a filer writes "not applicable" in a table.
  assert.equal(factValue('scale="-2"', '&#8212;'), null);
  assert.equal(factValue('scale="-2"', ''), null);
});

test('a filing that tags nothing says so, and says why', async () => {
  const out = await getCustomerConcentration('TEST', {
    getLatestFilingByForm: async () => ({ form: '10-K', filingDate: '2026-02-01', url: 'https://example.test/x.htm' }),
    secFetch: async () => ({ text: async () => '<html><body>no concentration tagged here</body></html>' }),
  });
  assert.equal(out.available, false);
  assert.match(out.reason, /10% of revenue/);
  // The empty answer still carries its source, so a reader can check.
  assert.equal(out.source.filedAt, '2026-02-01');
});

test('a failed read is not the same as an empty one', async () => {
  const out = await getCustomerConcentration('TESTFAIL', {
    getLatestFilingByForm: async () => ({ form: '10-K', filingDate: '2026-02-01', url: 'https://example.test/y.htm' }),
    secFetch: async () => { throw new Error('SEC is rate-limiting us'); },
  });
  assert.equal(out.available, false);
  assert.equal(out.failed, true);
  assert.match(out.reason, /rate-limiting/);
});

test('humanizeMember turns a tag into a counterparty', () => {
  assert.equal(humanizeMember('jnj:Wholesaler1Member'), 'Wholesaler 1');
  assert.equal(humanizeMember('apld:CustomerAMember'), 'Customer A');
  assert.equal(humanizeMember('us-gaap:SalesRevenueNetMember'), 'Sales Revenue Net');
});

test('an acronym running into a word is split', () => {
  // Cardinal Health tags a real named customer this way.
  assert.equal(humanizeMember('cah:CVSHealthCorporationMember'), 'CVS Health Corporation');
  assert.equal(humanizeMember('nvda:UnitedStatesAndEuropeBasedEndCustomersMember'),
    'United States And Europe Based End Customers');
});

test('shares that sum past 100 are flagged, not added up', () => {
  // NVIDIA tags a 76% grouping beside the 22% and 14% customers inside
  // it; McKesson tags "ten largest customers" beside three of them.
  // Summing gives 112% and 118% of revenue, which is not a thing.
  const rows = [
    { label: 'Group', pct: 76, end: '2026-01-25' },
    { label: 'Customer One', pct: 22, end: '2026-01-25' },
    { label: 'Customer Two', pct: 14, end: '2026-01-25' },
  ];
  const out = latestPeriod(rows);
  assert.equal(out.total, null, 'no combined figure may be published');
  assert.equal(out.overlapping, true);
  assert.match(out.overlapNote, /twice/);
  assert.equal(out.rows.length, 3, 'every disclosed line is still shown');
});

test('a receivable concentration is not a customer, and a missing benchmark is not revenue', () => {
  // Palantir tags a customer at 25% of ACCOUNTS RECEIVABLE while its
  // 10-K states no customer reached 10% of revenue.
  const receivable = `
    <context id="r"><segment>
      <explicitMember dimension="srt:MajorCustomersAxis">co:CustomerIMember</explicitMember>
      <explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:AccountsReceivableMember</explicitMember>
    </segment><period><endDate>2025-12-31</endDate></period></context>
    <ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="r" scale="-2">25</ix:nonFraction>`;
  assert.equal(parseConcentration(receivable).length, 0);

  // Apple's SUPPLIERS sit on the major-customers axis; only the risk
  // type tells them apart.
  const supplier = `
    <context id="s"><segment>
      <explicitMember dimension="srt:MajorCustomersAxis">co:VendorOneMember</explicitMember>
      <explicitMember dimension="us-gaap:ConcentrationRiskByTypeAxis">us-gaap:CreditConcentrationRiskMember</explicitMember>
      <explicitMember dimension="us-gaap:ConcentrationRiskByBenchmarkAxis">us-gaap:SalesRevenueNetMember</explicitMember>
    </segment><period><endDate>2025-09-27</endDate></period></context>
    <ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="s" scale="-2">46</ix:nonFraction>`;
  assert.equal(parseConcentration(supplier).length, 0);

  // No benchmark axis at all is a rejection, not an assumption.
  const noBenchmark = `
    <context id="n"><segment>
      <explicitMember dimension="srt:MajorCustomersAxis">co:CustomerAMember</explicitMember>
    </segment><period><endDate>2025-12-31</endDate></period></context>
    <ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="n" scale="-2">31</ix:nonFraction>`;
  assert.equal(parseConcentration(noBenchmark).length, 0);
});
