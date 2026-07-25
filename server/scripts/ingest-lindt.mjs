#!/usr/bin/env node
// Load the Lindt field research into the Griffin Fund research platform.
//
// Creates one project, then walks the corpus: the interview transcripts
// become Interviews with imported transcripts (and, optionally, extracted
// claims), the store visits become SiteVisits, and every document,
// spreadsheet, chart and photo becomes a project artifact.
//
// This runs against the live API rather than the database, so it goes
// through exactly the same validation, MNPI screening and consent checks
// a member would. Nothing here is a back door.
//
// Usage:
//   GCIG_TOKEN=<your token> node scripts/ingest-lindt.mjs [--dry-run] [--extract]
//
// Get the token from the browser: sign in to thegriffinfund.org, open
// the console, and run  localStorage.getItem('gcig_token')
//
//   --dry-run   print the plan, upload nothing
//   --extract   also run claim extraction on each transcript (slow, uses
//               the GPU; safe to run later from the FLD panel instead)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API = process.env.GCIG_API || 'https://gcig-api.onrender.com/api';
const TOKEN = process.env.GCIG_TOKEN;
const DRY = process.argv.includes('--dry-run');
const EXTRACT = process.argv.includes('--extract');

const LINDT = path.join(os.homedir(), 'repos/Lindt');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

if (!TOKEN && !DRY) {
  console.error('GCIG_TOKEN is not set. Run with --dry-run to see the plan,');
  console.error("or get a token: localStorage.getItem('gcig_token') in the browser console.");
  process.exit(1);
}

// Files that are build output or working scratch rather than research.
// Kept out because a project everyone has to scroll past is one nobody
// opens.
const SKIP = /(^\.|\.pyc$|__pycache__|\.DS_Store|node_modules)/;

// Folder → artifact kind. The corpus is already organised by what things
// are, so the directory is the best classifier available.
const KIND_BY_DIR = {
  outreach: 'guide',
  report: 'memo',
  research: 'document',
  model: 'data',
  cocoa: 'data',
  'niq-data': 'data',
  'price-comps': 'data',
  'h1-2026': 'document',
  scripts: 'other',
};

function kindFor(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.heic'].includes(ext)) return 'photo';
  if (['.csv', '.xlsx', '.xml', '.zip'].includes(ext)) return 'data';
  const top = relPath.split(path.sep)[0];
  return KIND_BY_DIR[top] || 'document';
}

// The interview corpus. Each transcript is a real conversation; the store
// ones double as site visits, which is why they carry a location.
const INTERVIEWS = [
  { file: 'Call with von Cramon-Taubadel - Transcript.txt', dir: 'lindt-outreach',
    title: 'Prof. Stephan von Cramon-Taubadel — cocoa economics',
    alias: 'Prof. von Cramon-Taubadel', relationship: 'IndustryExpert',
    employer: 'University of Göttingen', role: 'Agricultural economist' },
  { file: 'Call with Francesco - Transcript.txt', dir: 'downloads',
    title: 'Francesco — industry call',
    alias: 'Francesco', relationship: 'IndustryExpert' },
  { file: 'CVS 1 (969 Second Ave) - Transcript A.txt', dir: 'downloads',
    title: 'CVS 969 Second Ave — staff (A)', location: 'CVS, 969 Second Ave, NYC',
    alias: 'CVS 969 Second Ave staffer', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS 1 (969 Second Ave) - Transcript B.txt', dir: 'downloads',
    title: 'CVS 969 Second Ave — staff (B)', location: 'CVS, 969 Second Ave, NYC',
    alias: 'CVS 969 Second Ave staffer B', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS 2 - Transcript.txt', dir: 'downloads', title: 'CVS store 2 — staff',
    location: 'CVS store 2, NYC', alias: 'CVS store 2 staffer', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS 3 (rec50) - Transcript.txt', dir: 'downloads', title: 'CVS store 3 — staff',
    location: 'CVS store 3, NYC', alias: 'CVS store 3 staffer', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS 4 (rec51) - Transcript.txt', dir: 'downloads', title: 'CVS store 4 — staff',
    location: 'CVS store 4, NYC', alias: 'CVS store 4 staffer', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS 5 (rec49) - Transcript.txt', dir: 'downloads', title: 'CVS store 5 — staff',
    location: 'CVS store 5, NYC', alias: 'CVS store 5 staffer', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS Harlem Store 1 - Transcript.txt', dir: 'downloads', title: 'CVS Harlem 1 — staff',
    location: 'CVS Harlem store 1', alias: 'CVS Harlem 1 staffer', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS Harlem Store 2 - Transcript.txt', dir: 'downloads', title: 'CVS Harlem 2 — staff',
    location: 'CVS Harlem store 2', alias: 'CVS Harlem 2 staffer', relationship: 'Distributor', employer: 'CVS' },
  { file: 'CVS Store 3 Harlem - Transcript.txt', dir: 'downloads',
    title: 'CVS Harlem 3 — staffer Chris, live scanner/margin data',
    location: 'CVS Harlem store 3', alias: 'Chris, CVS Harlem 3', relationship: 'Distributor', employer: 'CVS' },
  { file: 'Duane Reade 1 - Transcript.txt', dir: 'downloads', title: 'Duane Reade 1 — staff',
    location: 'Duane Reade store 1, NYC', alias: 'Duane Reade 1 staffer', relationship: 'Distributor', employer: 'Duane Reade' },
  { file: 'Duane Reade 2 - Transcript.txt', dir: 'downloads', title: 'Duane Reade 2 — staff',
    location: 'Duane Reade store 2, NYC', alias: 'Duane Reade 2 staffer', relationship: 'Distributor', employer: 'Duane Reade' },
  { file: 'Duane Reade 3 - Transcript.txt', dir: 'downloads', title: 'Duane Reade 3 — staff',
    location: 'Duane Reade store 3, NYC', alias: 'Duane Reade 3 staffer', relationship: 'Distributor', employer: 'Duane Reade' },
  { file: 'New Recording 33 - Transcript (IGA East Hampton).txt', dir: 'downloads',
    title: 'IGA East Hampton — staff', location: 'IGA, East Hampton',
    alias: 'IGA East Hampton staffer', relationship: 'Distributor', employer: 'IGA' },
  { file: 'New Recording 14 - Transcript.txt', dir: 'downloads', title: 'Field recording 14',
    alias: 'Unidentified field source 14', relationship: 'Other' },
  { file: 'New Recording 32 - Transcript.txt', dir: 'downloads', title: 'Field recording 32',
    alias: 'Unidentified field source 32', relationship: 'Other' },
];

// The questions the Lindt work was actually trying to answer, taken from
// the report's own framing. They go in first so evidence has something to
// attach to.
const QUESTIONS = [
  'Does Lindt hold roughly 20% of the premium chocolate shelf, and is that keep-rate stable?',
  'Is price transmission asymmetric — do retail prices rise with cocoa but fail to fall back?',
  'How does Lindt sell through against Hershey and Ghirardelli at the same shelf?',
  'What happened to cocoa input costs, and how far do they pass through to shelf price?',
  'Does Lindt hold its shelf space and facings through a cost shock?',
  'Is the premium buyer price-insensitive enough to absorb repeated increases?',
];

async function call(route, { method = 'GET', json, form } = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${route}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : form,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${method} ${route} → ${res.status}: ${String(text).slice(0, 200)}`);
  }
  return body;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function main() {
  const files = fs.existsSync(LINDT) ? walk(LINDT) : [];
  const transcripts = INTERVIEWS.filter((i) =>
    fs.existsSync(path.join(i.dir === 'downloads' ? DOWNLOADS : path.join(LINDT, 'outreach'), i.file))
  );
  const visits = [...new Set(transcripts.filter((t) => t.location).map((t) => t.location))];

  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(LINDT, f)).size, 0);
  console.log(`Lindt corpus: ${files.length} files, ${(bytes / 1e6).toFixed(0)} MB`);
  console.log(`Transcripts found: ${transcripts.length} of ${INTERVIEWS.length}`);
  console.log(`Site visits implied: ${visits.length}`);
  console.log(`Questions: ${QUESTIONS.length}\n`);

  if (DRY) {
    const byKind = {};
    for (const f of files) byKind[kindFor(f)] = (byKind[kindFor(f)] || 0) + 1;
    console.log('Artifacts by kind:', byKind);
    console.log('\nMissing transcripts:',
      INTERVIEWS.filter((i) => !transcripts.includes(i)).map((i) => i.file));
    console.log('\nDry run — nothing uploaded.');
    return;
  }

  const project = await call('/research/projects', {
    method: 'POST',
    json: {
      name: 'Lindt & Sprüngli — premium chocolate field research',
      ticker: 'LISN',
      brief:
        'Primary research behind the Lindt investment study: whether Lindt holds ~20% of the ' +
        'premium chocolate shelf, whether price transmission is asymmetric through the cocoa ' +
        'spike, and how it sells through against Hershey and Ghirardelli at the same shelf. ' +
        'Evidence is store-staff interviews across CVS, Duane Reade and IGA, an expert call on ' +
        'cocoa economics, plus the desk research, models and photography behind the report.',
    },
  });
  console.log(`project #${project.id} created`);

  const questionIds = [];
  for (const [i, text] of QUESTIONS.entries()) {
    const q = await call(`/research/projects/${project.id}/questions`, {
      method: 'POST', json: { text, rank: i + 1 },
    });
    questionIds.push(q.id);
  }
  console.log(`${questionIds.length} questions added`);

  for (const location of visits) {
    await call(`/research/projects/${project.id}/visits`, {
      method: 'POST',
      json: { location, notes: 'Store visit — staff interview recorded, see linked interview.' },
    });
  }
  console.log(`${visits.length} site visits logged`);

  let imported = 0;
  for (const t of transcripts) {
    const dir = t.dir === 'downloads' ? DOWNLOADS : path.join(LINDT, 'outreach');
    const text = fs.readFileSync(path.join(dir, t.file), 'utf8');
    const source = await call('/research/sources', {
      method: 'POST',
      json: {
        alias: t.alias, relationship: t.relationship,
        employer: t.employer || null, role: t.role || null, tickers: ['LISN'],
      },
    });
    const interview = await call('/research/interviews', {
      method: 'POST',
      json: {
        sourceId: source.id, projectId: project.id, ticker: 'LISN', title: t.title,
        consentObtained: true,
        consentNote: 'Recorded field interview; consent captured at time of recording.',
      },
    });
    const r = await call(`/research/interviews/${interview.id}/transcript`, {
      method: 'POST', json: { text },
    });
    imported += 1;
    const flag = r.quarantined ? '  QUARANTINED' : r.mnpiRisk !== 'low' ? `  ${r.mnpiRisk}` : '';
    console.log(`  [${imported}/${transcripts.length}] ${t.title} — ${r.turnCount} turns${flag}`);

    if (EXTRACT && !r.quarantined) {
      try {
        const e = await call(`/research/interviews/${interview.id}/extract`, { method: 'POST' });
        console.log(`        extracted ${e.extracted} claims (${e.droppedUnlocatable} dropped)`);
      } catch (err) {
        console.log(`        extraction skipped: ${err.message}`);
      }
    }
  }

  let uploaded = 0, failed = 0;
  for (const rel of files) {
    const full = path.join(LINDT, rel);
    const size = fs.statSync(full).size;
    // The API caps a single upload at 200 MB; nothing here approaches it,
    // but fail loudly rather than silently skipping if that changes.
    if (size > 200 * 1024 * 1024) {
      console.log(`  SKIP (too large) ${rel}`);
      failed += 1;
      continue;
    }
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(full)]), path.basename(rel));
    form.append('kind', kindFor(rel));
    form.append('title', rel);
    form.append('note', `Lindt corpus — ${path.dirname(rel)}`);
    try {
      await call(`/research/projects/${project.id}/artifacts`, { method: 'POST', form });
      uploaded += 1;
      if (uploaded % 20 === 0) console.log(`  uploaded ${uploaded}/${files.length}…`);
    } catch (err) {
      failed += 1;
      console.log(`  FAILED ${rel}: ${err.message}`);
    }
  }

  console.log(`\nDone. project #${project.id}: ${imported} interviews, ${visits.length} visits, ${uploaded} files uploaded, ${failed} failed.`);
  console.log(`Open it in the terminal: LISN FLD`);
}

main().catch((err) => {
  console.error('\nIngest failed:', err.message);
  process.exit(1);
});
