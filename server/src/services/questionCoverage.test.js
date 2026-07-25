import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCoverage, assessQuestion, funnel, COVERAGE } from './questionCoverage.js';

// Coverage is what tells you a project is finished rather than merely
// stopped. The failures that matter are the flattering ones: one
// analyst's afternoon reading as corroboration, or a question counted
// answered because someone predicted the answer.

const Q = (id, text, status = 'Open') => ({ id, text, status });
const claim = (id, questionId, sourceId, employer, kind = 'fact') => ({
  id, questionId, kind,
  interview: { source: { id: sourceId, employer } },
});
const obs = (id, questionId, location) => ({ id, questionId, visit: { location } });

test('a question with nothing behind it is unaddressed', () => {
  const { questions } = assessCoverage([Q(1, 'Are rebates being cut?')], [], []);
  assert.equal(questions[0].coverage, COVERAGE.UNADDRESSED);
});

test('one source is thin, not supported', () => {
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [claim(10, 1, 100, 'Acme'), claim(11, 1, 100, 'Acme')],
    []
  );
  assert.equal(questions[0].coverage, COVERAGE.THIN);
  assert.equal(questions[0].claimCount, 2, 'repetition is not independence');
});

test('two independent employers support a question', () => {
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [claim(10, 1, 100, 'Acme'), claim(11, 1, 200, 'Globex')],
    []
  );
  assert.equal(questions[0].coverage, COVERAGE.SUPPORTED);
});

test('two colleagues at one employer stay thin', () => {
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [claim(10, 1, 100, 'Acme'), claim(11, 1, 200, 'Acme')],
    []
  );
  assert.equal(questions[0].coverage, COVERAGE.THIN);
  assert.equal(questions[0].distinctSources, 2);
  assert.equal(questions[0].independentLines, 1);
});

test('site-visit independence is the location, not the visitor', () => {
  // One analyst, three different stores: three data points.
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [],
    [obs(1, 1, 'Store A'), obs(2, 1, 'Store B'), obs(3, 1, 'Store C')]
  );
  assert.equal(questions[0].coverage, COVERAGE.SUPPORTED);
  assert.equal(questions[0].distinctLocations, 3);
});

test('many observations of ONE store do not add up to support', () => {
  // The flattering failure: one afternoon in one store wearing a
  // crowd's clothing.
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [],
    [obs(1, 1, 'Store A'), obs(2, 1, 'Store A'), obs(3, 1, 'store a '), obs(4, 1, 'Store A')]
  );
  assert.equal(questions[0].distinctLocations, 1);
  assert.equal(questions[0].coverage, COVERAGE.THIN);
});

test('claims and observations are counted but never merged', () => {
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [claim(10, 1, 100, 'Acme')],
    [obs(1, 1, 'Store A')]
  );
  assert.equal(questions[0].claimCount, 1);
  assert.equal(questions[0].observationCount, 1);
  // One voice and one store is still thin — the two kinds don't add up
  // into independence.
  assert.equal(questions[0].coverage, COVERAGE.THIN);
});

test('a disputed claim makes the question contested', () => {
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [claim(10, 1, 100, 'Acme'), claim(11, 1, 200, 'Globex')],
    [],
    [[10, 11]]
  );
  assert.equal(questions[0].coverage, COVERAGE.CONTESTED);
});

test('claim kinds are broken out so forecasts cannot pass as answers', () => {
  const { questions } = assessCoverage(
    [Q(1, 'x')],
    [
      claim(10, 1, 100, 'Acme', 'forecast'),
      claim(11, 1, 200, 'Globex', 'forecast'),
      claim(12, 1, 300, 'Initech', 'fact'),
    ],
    []
  );
  assert.equal(questions[0].forecastCount, 2);
  assert.equal(questions[0].factCount, 1);
});

test('human status is reported, never inferred from evidence volume', () => {
  const { questions } = assessCoverage(
    [Q(1, 'x', 'Answered')],
    [],
    []
  );
  // No evidence at all, but a person marked it answered. Both facts are
  // reported and neither overrides the other.
  assert.equal(questions[0].status, 'Answered');
  assert.equal(questions[0].coverage, COVERAGE.UNADDRESSED);
});

test('claims answering nothing we asked are surfaced, not hidden', () => {
  const { summary } = assessCoverage(
    [Q(1, 'x')],
    [claim(10, null, 100, 'Acme'), claim(11, 1, 200, 'Globex')],
    []
  );
  assert.equal(summary.unlinkedClaims, 1);
});

test('the summary names what is still open with nothing behind it', () => {
  const { summary } = assessCoverage(
    [Q(1, 'answered-ish'), Q(2, 'nothing yet'), Q(3, 'closed', 'Answered')],
    [claim(10, 1, 100, 'Acme'), claim(11, 1, 200, 'Globex')],
    []
  );
  assert.equal(summary.total, 3);
  assert.equal(summary.supported, 1);
  assert.equal(summary.unaddressed, 2);
  // Q3 is unaddressed but a human closed it, so only Q2 is next week's
  // call list.
  assert.equal(summary.openAndUnaddressed, 1);
});

test('assessQuestion handles a question with no evidence arrays', () => {
  const r = assessQuestion(Q(1, 'x'));
  assert.equal(r.coverage, COVERAGE.UNADDRESSED);
  assert.equal(r.claimCount, 0);
});

test('the outreach funnel counts attempts and conversion', () => {
  const f = funnel([
    { status: 'Identified' }, { status: 'Identified' },
    { status: 'Contacted' }, { status: 'Scheduled' },
    { status: 'Completed' }, { status: 'Completed' },
    { status: 'Declined' }, { status: 'Unreachable' },
  ]);
  assert.equal(f.total, 8);
  assert.equal(f.Identified, 2, 'not yet tried');
  assert.equal(f.attempted, 6);
  assert.equal(f.Completed, 2);
  assert.equal(f.conversionPct, 33);
});

test('an empty funnel reports null conversion rather than dividing by zero', () => {
  assert.equal(funnel([]).conversionPct, null);
  assert.equal(funnel([{ status: 'Identified' }]).conversionPct, null);
});
