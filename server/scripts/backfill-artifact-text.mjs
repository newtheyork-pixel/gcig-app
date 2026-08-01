#!/usr/bin/env node
// Read every uploaded research document once and keep the words.
//
//   node scripts/backfill-artifact-text.mjs --dry-run
//   node scripts/backfill-artifact-text.mjs --limit=2
//   node scripts/backfill-artifact-text.mjs --concurrency=3
//   node scripts/backfill-artifact-text.mjs --retry-unsupported
//
// Idempotent by construction: `ok`, `empty` and `unsupported` are never
// re-selected without a flag, so a run interrupted halfway resumes
// exactly where it stopped rather than paying for the first half again.
// `failed` comes back only after a cooldown and only while under the
// attempt ceiling, so one permanently broken file cannot burn the
// Graph quota forever.

import prisma from '../src/db.js';
import { extractForArtifact } from '../src/services/artifactText.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const num = (f, d) => {
  const hit = argv.find((a) => a.startsWith(`${f}=`));
  const v = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};

const DRY_RUN = has('--dry-run');
const FORCE = has('--force');
const RETRY_UNSUPPORTED = has('--retry-unsupported');
const CONCURRENCY = num('--concurrency', 3);
const LIMIT = num('--limit', 0);
const MAX_ATTEMPTS = 4;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

function where() {
  const base = { fileRef: { startsWith: 'onedrive:' } };
  if (FORCE) return base;
  const or = [
    { extractStatus: 'never' },
    {
      extractStatus: 'failed',
      extractAttempts: { lt: MAX_ATTEMPTS },
      OR: [
        { extractAttemptedAt: null },
        { extractAttemptedAt: { lt: new Date(Date.now() - COOLDOWN_MS) } },
      ],
    },
  ];
  if (RETRY_UNSUPPORTED) or.push({ extractStatus: 'unsupported' });
  return { ...base, OR: or };
}

// Graph throttles the APPLICATION, not the connection. A 429 answered by
// only the worker that received it leaves the other two hammering, which
// keeps the throttle alive — so the pause is global and everybody waits.
let resumeAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForQuota() {
  while (Date.now() < resumeAt) await sleep(Math.min(2000, resumeAt - Date.now()));
}

async function main() {
  const rows = await prisma.researchArtifact.findMany({
    where: where(),
    select: { id: true, title: true, filename: true, fileRef: true, projectId: true },
    orderBy: { id: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`${rows.length} artifact${rows.length === 1 ? '' : 's'} to read`
    + `${DRY_RUN ? ' (dry run, nothing will be written)' : ''}`);
  if (DRY_RUN) {
    for (const r of rows) console.log(`  ${String(r.id).padStart(4)}  ${r.filename || r.title}`);
    return;
  }

  const tally = { ok: 0, empty: 0, unsupported: 0, failed: 0 };
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const row = rows[i++];
      await waitForQuota();
      const update = await extractForArtifact(row);
      if (update._retryAfterMs) {
        resumeAt = Math.max(resumeAt, Date.now() + update._retryAfterMs);
        console.log(`  throttled — pausing ${Math.round(update._retryAfterMs / 1000)}s`);
      }
      delete update._retryAfterMs;
      await prisma.researchArtifact.update({ where: { id: row.id }, data: update });
      tally[update.extractStatus] = (tally[update.extractStatus] || 0) + 1;
      const size = update.extractChars ? `${update.extractChars.toLocaleString()} chars` : '';
      console.log(`  ${String(row.id).padStart(4)}  ${update.extractStatus.padEnd(11)} `
        + `${(row.filename || row.title || '').slice(0, 52).padEnd(54)} ${size}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  console.log(`\ndone: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
