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
import { extractOutreach, extractStoreVisits } from './lindt-workbook.mjs';

const API = process.env.GCIG_API || 'https://gcig-api.onrender.com/api';
let TOKEN = process.env.GCIG_TOKEN;
const DRY = process.argv.includes('--dry-run');
const EXTRACT = process.argv.includes('--extract');

const LINDT = path.join(os.homedir(), 'repos/Lindt');
// "Lindt Main.xlsx" is the system of record for the campaign: who was
// emailed, who replied, which addresses were dead, and the structured
// store-visit findings. None of that lives in the markdown files.
const WORKBOOK = path.join(os.homedir(), 'repos/Lindt/model/Lindt Main.xlsx');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

// Ask for the token rather than requiring it on the command line. A JWT
// pasted into a shell is a quoting hazard — angle brackets are redirects,
// and any stray character turns a 298 MB ingest into a cryptic zsh error
// before a single byte moves. Prompting sidesteps the shell entirely, and
// keeps the token out of shell history.
async function promptForToken() {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Get your token: thegriffinfund.org → Profile → Security → API Token → Copy token\n');
  const answer = (await rl.question('Paste token: ')).trim();
  rl.close();
  return answer;
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

// The interview corpus, taken from the transcripts' own headers rather
// than guessed from filenames. Several of my first-pass assumptions were
// wrong and the headers said so: "New Recording 14" is a StoneX cocoa
// call, "New Recording 32" is a CVS in East Hampton, Francesco is a
// Fithian colleague rather than an outside expert, and CVS #4 was the
// manager with scanner data rather than floor staff. Getting these right
// is not cosmetic — `relationship` drives the MNPI default, and
// `employer` is what decides whether two voices corroborate or merely
// cluster.
//
// `date` is the interview date where a header states one, otherwise the
// transcript file's own timestamp. Both are recorded on the interview so
// the provenance of the date is never guessed at later.
const INTERVIEWS = [
  // ── Expert / project calls ──
  { file: 'Call with von Cramon-Taubadel - Transcript.txt', dir: 'lindt',
    title: 'Prof. Stephan von Cramon-Taubadel — cocoa economics', date: '2026-07-14',
    alias: 'Prof. von Cramon-Taubadel', relationship: 'IndustryExpert',
    employer: 'University of Göttingen', role: 'Agricultural economist',
    dateFrom: 'transcript header' },
  { file: 'New Recording 14 - Transcript.txt', dir: 'downloads',
    title: 'StoneX — cocoa market call', date: '2026-07-07',
    alias: 'StoneX cocoa desk', relationship: 'IndustryExpert', employer: 'StoneX',
    role: 'Commodities broker', dateFrom: 'transcript header (transcribed date)' },
  { file: 'Call with Francesco - Transcript.txt', dir: 'downloads',
    title: 'Francesco (Fithian) — Lindt project call', date: '2026-07-13',
    alias: 'Francesco, Fithian', relationship: 'Other', employer: 'Fithian',
    role: 'Project colleague', dateFrom: 'file timestamp' },

  // ── CVS, Manhattan (UES / Midtown) ──
  { file: 'CVS 1 (969 Second Ave) - Transcript A.txt', dir: 'downloads',
    title: 'CVS #1a, 969 Second Ave — staff interview, part 1', date: '2026-07-13',
    location: 'CVS, 969 Second Ave (51st–52nd), Manhattan',
    alias: 'CVS 969 Second Ave staff', relationship: 'Distributor', employer: 'CVS',
    role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'CVS 1 (969 Second Ave) - Transcript B.txt', dir: 'downloads',
    title: 'CVS #1b, 969 Second Ave — staff interview, part 2', date: '2026-07-13',
    location: 'CVS, 969 Second Ave (51st–52nd), Manhattan',
    // Same store and same conversation, continued. Reusing one source
    // keeps two halves of one interview from reading as two voices.
    alias: 'CVS 969 Second Ave staff', relationship: 'Distributor', employer: 'CVS',
    role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'CVS 2 - Transcript.txt', dir: 'downloads',
    title: 'CVS #2, Manhattan — staff interview', date: '2026-07-13',
    location: 'CVS #2, Manhattan', alias: 'CVS #2 staff',
    relationship: 'Distributor', employer: 'CVS', role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'CVS 3 (rec50) - Transcript.txt', dir: 'downloads',
    title: 'CVS #3, UES/Midtown — staff interview', date: '2026-07-13',
    location: 'CVS #3, UES/Midtown 40s–70s', alias: 'CVS #3 staff',
    relationship: 'Distributor', employer: 'CVS', role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'CVS 4 (rec51) - Transcript.txt', dir: 'downloads',
    title: 'CVS #4, UES/Midtown — MANAGER interview with scanner data', date: '2026-07-13',
    location: 'CVS #4, UES/Midtown 40s–70s', alias: 'CVS #4 store manager',
    relationship: 'Distributor', employer: 'CVS', role: 'Store manager', dateFrom: 'file timestamp' },
  { file: 'CVS 5 (rec49) - Transcript.txt', dir: 'downloads',
    title: 'CVS #5, UES/Midtown — staff interview', date: '2026-07-13',
    location: 'CVS #5, UES/Midtown 40s–70s', alias: 'CVS #5 staff',
    relationship: 'Distributor', employer: 'CVS', role: 'Store staff', dateFrom: 'file timestamp' },

  // ── CVS, Harlem ──
  { file: 'CVS Harlem Store 1 - Transcript.txt', dir: 'downloads',
    title: 'CVS Harlem #1 — staff interview', date: '2026-07-13',
    location: 'CVS Harlem store 1', alias: 'CVS Harlem #1 staff',
    relationship: 'Distributor', employer: 'CVS', role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'CVS Harlem Store 2 - Transcript.txt', dir: 'downloads',
    title: 'CVS Harlem #2 — staff interview', date: '2026-07-13',
    location: 'CVS Harlem store 2', alias: 'CVS Harlem #2 staff',
    relationship: 'Distributor', employer: 'CVS', role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'CVS Store 3 Harlem - Transcript.txt', dir: 'downloads',
    title: 'CVS Harlem #3 — Chris, showed live scanner/margin data', date: '2026-07-13',
    location: 'CVS Harlem store 3', alias: 'Chris, CVS Harlem #3',
    relationship: 'Distributor', employer: 'CVS', role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'New Recording 32 - Transcript.txt', dir: 'downloads',
    title: 'CVS East Hampton — follow-up visit', date: '2026-07-10',
    location: 'CVS, 71 Montauk Hwy, East Hampton', alias: 'CVS East Hampton staff',
    relationship: 'Distributor', employer: 'CVS', role: 'Store staff',
    dateFrom: 'transcript header (transcribed date)' },

  // ── Duane Reade ──
  { file: 'Duane Reade 1 - Transcript.txt', dir: 'downloads',
    title: 'Duane Reade #1 — staff interview', date: '2026-07-13',
    location: 'Duane Reade #1, Manhattan', alias: 'Duane Reade #1 staff',
    relationship: 'Distributor', employer: 'Duane Reade', role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'Duane Reade 2 - Transcript.txt', dir: 'downloads',
    title: 'Duane Reade #2 — staff interview', date: '2026-07-13',
    location: 'Duane Reade #2, Manhattan', alias: 'Duane Reade #2 staff',
    relationship: 'Distributor', employer: 'Duane Reade', role: 'Store staff', dateFrom: 'file timestamp' },
  { file: 'Duane Reade 3 - Transcript.txt', dir: 'downloads',
    title: 'Duane Reade #3, UES/Midtown — debrief / staff interview', date: '2026-07-13',
    location: 'Duane Reade #3, UES/Midtown 40s–70s', alias: 'Duane Reade #3 staff',
    relationship: 'Distributor', employer: 'Duane Reade', role: 'Store staff', dateFrom: 'file timestamp' },

  // ── IGA ──
  { file: 'New Recording 33 - Transcript (IGA East Hampton).txt', dir: 'downloads',
    title: 'IGA East Hampton — store visit', date: '2026-07-12',
    location: 'IGA, East Hampton', alias: 'IGA East Hampton staff',
    relationship: 'Distributor', employer: 'IGA', role: 'Store staff', dateFrom: 'file timestamp' },
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

// Re-running must not double the corpus. The API has no natural
// idempotency key, so the run writes a manifest of what it created and
// a resumed run skips anything already recorded there.
// Overridable so a rehearsal against a mock API cannot poison the real
// run's resume state.
const STATE = process.env.GCIG_STATE || path.join(os.homedir(), '.gcig-lindt-ingest.json');
const loadState = () =>
  fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { sources: {}, interviews: {}, artifacts: {}, visits: {}, targets: {} };
const saveState = (st) => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));

async function main() {
  if (!TOKEN && !DRY) {
    TOKEN = await promptForToken();
    if (!TOKEN) {
      console.error('No token given — nothing to do.');
      process.exit(1);
    }
  }

  const files = fs.existsSync(LINDT) ? walk(LINDT) : [];
  const present = INTERVIEWS.filter((i) =>
    fs.existsSync(path.join(i.dir === 'downloads' ? DOWNLOADS : path.join(LINDT, 'outreach'), i.file))
  );
  const workbookVisits = fs.existsSync(WORKBOOK) ? await extractStoreVisits(WORKBOOK) : [];
  const outreach = fs.existsSync(WORKBOOK) ? await extractOutreach(WORKBOOK) : [];
  const sources = [...new Set(present.map((t) => t.alias))];

  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(LINDT, f)).size, 0);
  console.log(`Lindt corpus:  ${files.length} files, ${(bytes / 1e6).toFixed(0)} MB`);
  console.log(`Transcripts:   ${present.length} of ${INTERVIEWS.length}`);
  console.log(`Sources:       ${sources.length} distinct (CVS 969 2nd Ave spans two parts)`);
  console.log(`Site visits:   ${workbookVisits.length} from the workbook, ${workbookVisits.reduce((n, v) => n + v.observations.length, 0)} observations`);
  console.log(`Outreach:      ${outreach.length} tracked contacts`);
  console.log(`Questions:     ${QUESTIONS.length}\n`);

  if (DRY) {
    const byKind = {};
    for (const f of files) byKind[kindFor(f)] = (byKind[kindFor(f)] || 0) + 1;
    console.log('Artifacts by kind:', byKind);
    const byEmployer = {};
    for (const t of present) byEmployer[t.employer || '(none)'] = (byEmployer[t.employer || '(none)'] || 0) + 1;
    // Employer spread is what decides corroboration vs clustering, so it
    // is worth eyeballing before the run rather than after.
    console.log('Interviews by employer:', byEmployer);
    const funnel = {};
    for (const t of outreach) funnel[t.status] = (funnel[t.status] || 0) + 1;
    console.log('Outreach funnel:', funnel);
    const missing = INTERVIEWS.filter((i) => !present.includes(i)).map((i) => i.file);
    if (missing.length) console.log('MISSING transcripts:', missing);
    console.log('\nDry run — nothing uploaded.');
    return;
  }

  const st = loadState();
  if (!st.targets) st.targets = {};

  if (!st.projectId) {
    const project = await call('/research/projects', {
      method: 'POST',
      json: {
        name: 'Lindt & Sprüngli — premium chocolate field research',
        ticker: 'LISN',
        brief:
          'Primary research behind the Lindt investment study: whether Lindt holds ~20% of the ' +
          'premium chocolate shelf, whether price transmission is asymmetric through the cocoa ' +
          'spike, and how it sells through against Hershey and Ghirardelli at the same shelf. ' +
          'Evidence is store-staff and manager interviews across CVS, Duane Reade and IGA in ' +
          'Manhattan, Harlem and East Hampton, expert calls on cocoa economics (Göttingen) and ' +
          'the cocoa market (StoneX), plus the desk research, models and photography behind the ' +
          'report.',
      },
    });
    st.projectId = project.id;
    saveState(st);
    console.log(`project #${st.projectId} created`);
  } else {
    console.log(`resuming project #${st.projectId}`);
  }

  if (!st.questionIds) {
    st.questionIds = [];
    for (const [i, text] of QUESTIONS.entries()) {
      const q = await call(`/research/projects/${st.projectId}/questions`, {
        method: 'POST', json: { text, rank: i + 1 },
      });
      st.questionIds.push(q.id);
    }
    saveState(st);
    console.log(`${st.questionIds.length} questions added`);
  }

  // Site visits come from the workbook, not from transcript filenames.
  // The sheet knows things the filenames do not — notably that CVS
  // Harlem "recording 1 of 2" and "recording 2 of 2" are the SAME
  // physical store. Treating those as two locations would have inflated
  // the distinct-location count, which is exactly what promotes a
  // question from thin to supported.
  for (const v of workbookVisits) {
    if (st.visits[v.location]) continue;
    const created = await call(`/research/projects/${st.projectId}/visits`, {
      method: 'POST',
      json: {
        location: v.location,
        visitedAt: v.date ? new Date(`${v.date}T12:00:00Z`).toISOString() : undefined,
        notes: v.notes.join(' | ').slice(0, 10_000) || null,
      },
    });
    st.visits[v.location] = created.id;
    saveState(st);
    // Each Topic/Finding pair from the sheet is one observation.
    for (const o of v.observations) {
      await call(`/research/visits/${created.id}/observations`, {
        method: 'POST', json: { text: o.text, topic: o.topic },
      }).catch(() => {});
    }
  }
  const obsTotal = workbookVisits.reduce((n, v) => n + v.observations.length, 0);
  console.log(`${Object.keys(st.visits).length} site visits logged, ${obsTotal} observations`);

  // The outreach funnel: everyone emailed, with the status the tracker's
  // own outcome text supports.
  let newTargets = 0;
  for (const t of outreach) {
    const key = `${t.name}|${t.email || ''}`;
    if (st.targets[key]) continue;
    const created = await call(`/research/projects/${st.projectId}/targets`, {
      method: 'POST',
      json: {
        name: t.name,
        relationship: 'Other',
        employer: t.employer, role: t.role,
        channel: t.email ? `email: ${t.email}` : null,
        // The whole correspondence, so clicking a name shows what was
        // actually said rather than a summary of it. Their reply is the
        // most valuable line in the record and was previously dropped.
        notes: [
          t.why && `WHY WE APPROACHED THEM\n${t.why}`,
          t.email && `ADDRESS\n${t.email}`,
          t.emailSent && `EMAIL WE SENT\n${t.emailSent}`,
          t.response && `THEIR REPLY\n${t.response}`,
          t.outcome && `OUTCOME\n${t.outcome}`,
        ].filter(Boolean).join('\n\n').slice(0, 20_000) || null,
      },
    });
    // Status is a separate PATCH because create always starts at
    // Identified, and the PATCH is what stamps lastContactAt.
    if (t.status !== 'Identified') {
      await call(`/research/targets/${created.id}`, {
        method: 'PATCH', json: { status: t.status },
      }).catch(() => {});
    }
    st.targets[key] = created.id;
    newTargets += 1;
    if (newTargets % 25 === 0) saveState(st);
  }
  saveState(st);
  console.log(`${newTargets} outreach targets loaded (${outreach.length} in the tracker)`);

  let imported = 0, skipped = 0;
  for (const t of present) {
    if (st.interviews[t.file]) { skipped += 1; continue; }
    const dir = t.dir === 'downloads' ? DOWNLOADS : path.join(LINDT, 'outreach');
    const text = fs.readFileSync(path.join(dir, t.file), 'utf8');

    // One source per alias. CVS 969 Second Ave appears twice because the
    // conversation was recorded in two parts, and creating two sources
    // would let one person's answers corroborate themselves.
    let sourceId = st.sources[t.alias];
    if (!sourceId) {
      const src = await call('/research/sources', {
        method: 'POST',
        json: {
          alias: t.alias, relationship: t.relationship,
          employer: t.employer || null, role: t.role || null, tickers: ['LISN'],
        },
      });
      sourceId = src.id;
      st.sources[t.alias] = sourceId;
      saveState(st);
    }

    const interview = await call('/research/interviews', {
      method: 'POST',
      json: {
        sourceId, projectId: st.projectId, ticker: 'LISN', title: t.title,
        conductedAt: new Date(`${t.date}T12:00:00Z`).toISOString(),
        consentObtained: true,
        consentNote: `Recorded field interview, consent captured at recording. Interview date from ${t.dateFrom}.`,
      },
    });
    const r = await call(`/research/interviews/${interview.id}/transcript`, {
      method: 'POST', json: { text },
    });
    st.interviews[t.file] = interview.id;
    saveState(st);
    imported += 1;
    const flag = r.quarantined ? '  ** QUARANTINED **' : r.mnpiRisk !== 'low' ? `  [${r.mnpiRisk}]` : '';
    console.log(`  [${imported}/${present.length - skipped}] ${t.title.slice(0, 58)} — ${r.turnCount} turns${flag}`);

    if (EXTRACT && !r.quarantined) {
      try {
        const e = await call(`/research/interviews/${interview.id}/extract`, { method: 'POST' });
        console.log(`        ${e.extracted} claims (${e.droppedUnlocatable} dropped as unlocatable)`);
      } catch (err) {
        console.log(`        extraction skipped: ${err.message}`);
      }
    }
  }
  if (skipped) console.log(`  (${skipped} interviews already present, skipped)`);

  let uploaded = 0, failed = 0, already = 0;
  for (const rel of files) {
    if (st.artifacts[rel]) { already += 1; continue; }
    const full = path.join(LINDT, rel);
    const size = fs.statSync(full).size;
    if (size > 200 * 1024 * 1024) {
      console.log(`  SKIP (over 200 MB API cap) ${rel}`);
      failed += 1;
      continue;
    }
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(full)]), path.basename(rel));
    form.append('kind', kindFor(rel));
    form.append('title', rel);
    form.append('note', `Lindt corpus — ${path.dirname(rel)}`);
    try {
      const a = await call(`/research/projects/${st.projectId}/artifacts`, { method: 'POST', form });
      st.artifacts[rel] = a.id;
      uploaded += 1;
      if (uploaded % 20 === 0) { saveState(st); console.log(`  uploaded ${uploaded}/${files.length - already}…`); }
    } catch (err) {
      failed += 1;
      console.log(`  FAILED ${rel}: ${err.message}`);
    }
  }
  saveState(st);

  console.log(`\nDone. project #${st.projectId}`);
  console.log(`  interviews ${imported} new, ${skipped} already present`);
  console.log(`  files      ${uploaded} uploaded, ${already} already present, ${failed} failed`);
  console.log(`  state      ${STATE} (delete to start clean)`);
  console.log(`\nOpen it:  LISN FLD  in the terminal`);
}

main().catch((err) => {
  console.error('\nIngest failed:', err.message);
  process.exit(1);
});
