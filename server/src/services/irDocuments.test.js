import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManifest, isTranscript, quarterFrom, transcriptsIn, feedURL, fetchDocuments,
} from './irDocuments.js';

// The two shapes actually observed on live feeds. Johnson & Johnson
// publishes a transcript every quarter; General Dynamics publishes a
// release, a deck, a webcast and a 10-Q and no transcript at all. Both
// return HTTP 200, so only the document list distinguishes them — which
// is the whole reason to read the manifest rather than guess.
const JNJ = {
  GetFinancialReportListResult: [
    {
      ReportYear: 2026,
      ReportQuarter: null,
      ReportTitle: '2026 Second-Quarter Results',
      Documents: [
        { DocumentTitle: '2026 Second-Quarter Press Release ', DocumentPath: '/static/q2-release.pdf' },
        { DocumentTitle: '2026 Second-Quarter Earnings Transcript', DocumentPath: 'https://cdn.example/JNJ_Transcript_2026-07-15.pdf' },
      ],
    },
  ],
};

const GD = {
  GetFinancialReportListResult: [
    {
      ReportYear: 2026,
      ReportQuarter: null,
      ReportTitle: 'Q2 2026',
      Documents: [
        { DocumentTitle: 'Earnings Release', DocumentPath: '/files/q2-release.pdf' },
        { DocumentTitle: 'Presentation', DocumentPath: '/files/q2-deck.pdf' },
        // A webcast row with no file behind it: the manifest saying
        // "this is a player, not a document".
        { DocumentTitle: 'Webcast', DocumentPath: 'https://events.q4inc.com/x', DocumentFileType: null, DocumentFileSize: null },
        { DocumentTitle: 'Form 10-Q', DocumentPath: '/files/q2-10q.pdf' },
      ],
    },
  ],
};

test('a company that publishes a transcript is distinguishable from one that does not', () => {
  const jnj = parseManifest(JNJ, 'www.investor.jnj.com');
  const gd = parseManifest(GD, 'investorrelations.gd.com');
  assert.equal(transcriptsIn(jnj).length, 1);
  assert.equal(transcriptsIn(gd).length, 0);
  // Both feeds answered. "No transcript" is a finding, not a failure.
  assert.equal(gd.length, 4);
});

test('a relative path becomes a fetchable URL and an absolute one is left alone', () => {
  const docs = parseManifest(JNJ, 'www.investor.jnj.com');
  const release = docs.find((d) => d.kind === 'release');
  assert.equal(release.url, 'https://www.investor.jnj.com/static/q2-release.pdf');
  assert.equal(transcriptsIn(docs)[0].url, 'https://cdn.example/JNJ_Transcript_2026-07-15.pdf');
});

test('the quarter is read from the title, because the feed field is usually null', () => {
  // Every J&J and GD row observed live had ReportQuarter null.
  assert.equal(quarterFrom('2026 Second-Quarter Earnings Transcript'), 2);
  assert.equal(quarterFrom('Q3 2025 Transcript'), 3);
  assert.equal(quarterFrom('2Q26 Other Financial Disclosures'), 2);
  assert.equal(quarterFrom('Fourth-Quarter Press Release'), 4);
  assert.equal(quarterFrom('Annual Report'), null);
  assert.equal(parseManifest(JNJ, 'h')[0].quarter, 2);
});

test('a webcast is not a transcript, and neither is a request form', () => {
  // Matching the bare word would file the audio player and an admin form
  // as readable text, and produce links that open onto nothing.
  assert.equal(isTranscript('Conference Call & Webcast Transcript'), true);
  assert.equal(isTranscript('Earnings Call Transcript'), true);
  assert.equal(isTranscript('Q2 2026 Transcript'), true);
  assert.equal(isTranscript('Webcast'), false);
  assert.equal(isTranscript('Presentation'), false);
  assert.equal(isTranscript('Transcript Request Form'), false);
  assert.equal(isTranscript(''), false);
});

test('every deployment shape of the manifest parses', () => {
  const docs = [{ DocumentTitle: 'Earnings Transcript', DocumentPath: '/t.pdf' }];
  const report = { ReportYear: 2026, Documents: docs };
  for (const shape of [
    { GetFinancialReportListResult: [report] },
    { Items: [report] },
    [report],
  ]) {
    assert.equal(transcriptsIn(parseManifest(shape, 'h')).length, 1, JSON.stringify(Object.keys(shape)));
  }
  // Nothing usable is an empty list, never a throw.
  assert.deepEqual(parseManifest(null, 'h'), []);
  assert.deepEqual(parseManifest({ nonsense: true }, 'h'), []);
});

test('the feed URL carries no credential', () => {
  // Q4's route requires an apiKey parameter and does not validate it.
  // Nothing here is a secret and nothing is being circumvented.
  const u = feedURL('ir.example.com');
  assert.match(u, /^https:\/\/ir\.example\.com\/feed\/FinancialReport\.svc\/GetFinancialReportList\?/);
  assert.match(u, /apiKey=X/);
});

test('a refused request is reported as refused, not as a company with no transcripts', async () => {
  // These are different facts. A Cloudflare interstitial means we do not
  // know; an answered feed with no transcript row means the company
  // does not publish one. Collapsing them would put companies in the
  // "no" column that belong in the "unknown" one.
  const blocked = await fetchDocuments('ir.example.com', {
    secFetch: async () => { const e = new Error('SEC 403 for ir.example.com'); e.status = 403; throw e; },
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /refused an automated request/);

  const empty = await fetchDocuments('ir.example.com', {
    secFetch: async () => ({ json: async () => ({ GetFinancialReportListResult: [] }) }),
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.documents.length, 0);
  assert.match(empty.reason, /answered but listed no documents/);
});

test('no host is not a network failure', async () => {
  const out = await fetchDocuments('', {});
  assert.equal(out.ok, false);
  assert.match(out.reason, /No IR host known/);
});

test('documents come back newest first', async () => {
  const out = await fetchDocuments('h', {
    secFetch: async () => ({
      json: async () => ({
        Items: [
          { ReportYear: 2024, Documents: [{ DocumentTitle: 'Q1 2024 Transcript', DocumentPath: '/a' }] },
          { ReportYear: 2026, Documents: [{ DocumentTitle: 'Q2 2026 Transcript', DocumentPath: '/b' }] },
        ],
      }),
    }),
  });
  assert.equal(out.documents[0].year, 2026);
});
