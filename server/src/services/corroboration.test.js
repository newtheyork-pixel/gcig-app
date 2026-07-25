import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTopics, formatCitation, SUPPORT } from './corroboration.js';
import { formatStamp } from './transcription.js';

// The failure this guards against is flattering evidence: counting two
// colleagues who heard the same rumour from the same manager as two
// independent confirmations. That mistake reads as strength and is how a
// thesis gets talked into.

const claim = (id, topic, sourceId, employer, kind = 'fact') => ({
  id,
  topic,
  kind,
  interview: {
    id: id * 10,
    conductedAt: '2026-07-14T00:00:00Z',
    source: { id: sourceId, alias: `Source ${sourceId}`, employer, relationship: 'Distributor' },
  },
  startMs: 62_000,
});

test('one source is single-source however many times they say it', () => {
  const [t] = assessTopics([
    claim(1, 'rebate', 100, 'Acme'),
    claim(2, 'rebate', 100, 'Acme'),
    claim(3, 'rebate', 100, 'Acme'),
  ]);
  assert.equal(t.support, SUPPORT.SINGLE);
  assert.equal(t.claimCount, 3);
  assert.equal(t.distinctSources, 1, 'repetition is not corroboration');
});

test('two sources at different employers corroborate', () => {
  const [t] = assessTopics([
    claim(1, 'rebate', 100, 'Acme'),
    claim(2, 'rebate', 200, 'Globex'),
  ]);
  assert.equal(t.support, SUPPORT.CORROBORATED);
  assert.equal(t.independentLines, 2);
});

test('two sources at the SAME employer are clustered, not corroborated', () => {
  // The whole point: colleagues may share one origin for the claim.
  const [t] = assessTopics([
    claim(1, 'rebate', 100, 'Acme'),
    claim(2, 'rebate', 200, 'Acme'),
  ]);
  assert.equal(t.support, SUPPORT.CLUSTERED);
  assert.equal(t.distinctSources, 2);
  assert.equal(t.independentLines, 1);
});

test('employer matching ignores case and padding', () => {
  const [t] = assessTopics([
    claim(1, 'rebate', 100, 'Acme Corp'),
    claim(2, 'rebate', 200, '  acme corp '),
  ]);
  assert.equal(t.support, SUPPORT.CLUSTERED);
});

test('an unknown employer is never assumed to share or differ', () => {
  // Counted as its own line rather than folded into a known employer —
  // assuming otherwise would either invent independence or destroy it.
  const [t] = assessTopics([
    claim(1, 'rebate', 100, 'Acme'),
    claim(2, 'rebate', 200, null),
  ]);
  assert.equal(t.independentLines, 2);
});

test('a marked contradiction makes a topic contested, outranking support', () => {
  const t = assessTopics(
    [
      claim(1, 'rebate', 100, 'Acme'),
      claim(2, 'rebate', 200, 'Globex'),
      claim(3, 'pricing', 300, 'Initech'),
    ],
    [[1, 2]]
  );
  const rebate = t.find((x) => x.topic === 'rebate');
  assert.equal(rebate.support, SUPPORT.CONTESTED);
  assert.equal(t[0].topic, 'rebate', 'contested sorts first — it needs attention');
});

test('claim kinds are counted separately so opinion cannot pass as fact', () => {
  const [t] = assessTopics([
    claim(1, 'outlook', 100, 'Acme', 'opinion'),
    claim(2, 'outlook', 200, 'Globex', 'forecast'),
    claim(3, 'outlook', 300, 'Initech', 'fact'),
  ]);
  assert.equal(t.factCount, 1);
  assert.equal(t.opinionCount, 1);
  assert.equal(t.forecastCount, 1);
});

test('untopiced claims are excluded rather than lumped together', () => {
  // Bucketing them under a shared empty key would manufacture agreement
  // between unrelated statements.
  const out = assessTopics([
    { id: 1, topic: null, kind: 'fact', interview: { source: { id: 1 } } },
    { id: 2, topic: '', kind: 'fact', interview: { source: { id: 2 } } },
  ]);
  assert.equal(out.length, 0);
});

test('empty and malformed input is handled', () => {
  assert.deepEqual(assessTopics([]), []);
  assert.deepEqual(assessTopics(null), []);
  assert.deepEqual(assessTopics([null, undefined]), []);
});

test('citations use the alias, never the real name', () => {
  const c = {
    id: 47,
    startMs: 862_000,
    interview: {
      conductedAt: '2026-07-14T00:00:00Z',
      source: {
        alias: 'Former regional distributor',
        fullName: 'Jane Doe',
        relationship: 'Distributor',
      },
    },
  };
  const cite = formatCitation(c, { formatStamp });
  assert.match(cite, /^C47/);
  assert.match(cite, /Former regional distributor/);
  assert.match(cite, /distributor/);
  assert.match(cite, /2026-07-14/);
  assert.match(cite, /14:22/);
  assert.ok(!cite.includes('Jane Doe'), 'the real name must never reach a footnote');
});
