// Reads the two field-research sheets out of "Lindt Main.xlsx": the
// outreach tracker and the store visit notes.
//
// The workbook is the system of record for the campaign — 105 people
// emailed, who replied, which addresses were dead — and none of that
// lives in the markdown files. Without it the platform would show
// seventeen interviews and no sense of what it took to get them, which
// is the more useful half of a research process to be able to see.
//
// Written against the raw xlsx parts rather than a spreadsheet library
// so the ingest carries no extra dependency. Two things this workbook
// does that a naive reader gets wrong: relationship attributes appear in
// Target-before-Id order, and strings are inline rather than in a
// sharedStrings part. Both are legal and both are handled.

import fs from 'node:fs';
import JSZip from 'jszip';

function decode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function readSheet(file, wanted) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));

  let shared = [];
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (ssFile) {
    const ss = await ssFile.async('string');
    shared = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
    );
  }

  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relMap = {};
  for (const tag of rels.match(/<Relationship [^>]*>/g) || []) {
    const id = /Id="([^"]+)"/.exec(tag)?.[1];
    const target = /Target="([^"]+)"/.exec(tag)?.[1];
    if (id && target) relMap[id] = target;
  }

  const wb = await zip.file('xl/workbook.xml').async('string');
  const tag = (wb.match(/<sheet [^>]*>/g) || []).find(
    (t) => decode(/name="([^"]+)"/.exec(t)?.[1] || '') === wanted
  );
  if (!tag) throw new Error(`sheet "${wanted}" not found in ${file}`);
  const path = relMap[/r:id="([^"]+)"/.exec(tag)[1]].replace(/^\//, '');
  const xml = await zip.file(path).async('string');

  const rows = [];
  for (const row of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
    const cells = {};
    for (const c of row.matchAll(
      /<c r="([A-Z]+)\d+"(?:[^>]*t="(\w+)")?[^>]*>(?:<f[^>]*>[\s\S]*?<\/f>)?(?:<v>([\s\S]*?)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)?<\/c>/g
    )) {
      const [, col, type, v, inline] = c;
      let val = inline ?? v ?? '';
      if (type === 's') val = shared[Number(val)] ?? '';
      else if (val !== '') val = decode(val);
      if (val !== '') cells[col] = String(val);
    }
    if (Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}

// Classify a free-text outcome into the funnel.
//
// Every rule here was wrong on the first pass, in the direction that
// flatters the work. "zoom" matched "ZoomInfo accuracy 98" — a contact
// data vendor, not a video call — and promoted three people who had only
// been emailed to completed interviews. "scheduled" matched "scheduled
// send", an Outlook feature. Both are neutralised before matching, and
// ambiguity now lands lower in the funnel: an understated pipeline is a
// nuisance, an overstated one misrepresents how much fieldwork exists.
export function classifyOutcome(row) {
  const both = `${row.outcome || ''} ${row.response || ''}`
    .toLowerCase()
    .replace(/zoominfo/g, 'contactvendor')
    .replace(/schedule[d]? send/g, 'timed send');

  if (/\b(bounced|undeliverable|dead email|inactive mailbox|permanent fatal|dead end|invalid address|no longer (at|with)|left the (company|firm)|address (is )?stale)/.test(both)) {
    return 'Unreachable';
  }
  if (/\b(call (was )?(held|done|completed)|interview(ed)?\b|transcript|we spoke|spoke with|call notes)/.test(both)) {
    return 'Completed';
  }
  if (/\b(call scheduled|call to be scheduled|agreed to (talk|discuss|chat|a call)|booked|calendar invite|zoom link)/.test(both)) {
    return 'Scheduled';
  }
  if (/\b(declin|no thanks|not able to|unable to|cannot help|can't help|company policy|not interested)/.test(both)) {
    return 'Declined';
  }
  if (/\b(sent\b|awaiting reply|replied|responded|out of office|ooo\b)/.test(both) || row.date) {
    return 'Contacted';
  }
  return 'Identified';
}

// "Name (Title, Company)" is the sheet's convention. Split it so the
// employer lands in its own field, which is what decides whether two
// voices corroborate or merely cluster.
export function splitWho(who) {
  const m = /^([^(]+?)\s*\((.+)\)\s*$/.exec(String(who || '').trim());
  if (!m) return { name: String(who || '').trim().slice(0, 200), employer: null, role: null };
  const name = m[1].trim();
  const inner = m[2];
  const parts = inner.split(/\s*[,;]\s*/);
  // Last comma-separated part is usually the organisation; everything
  // before it is the title.
  const employer = parts.length > 1 ? parts[parts.length - 1] : inner;
  const role = parts.length > 1 ? parts.slice(0, -1).join(', ') : null;
  return {
    name: name.slice(0, 200),
    employer: employer ? employer.slice(0, 200) : null,
    role: role ? role.slice(0, 200) : null,
  };
}

// A genuine contact row carries either an email address or an explicit
// "no email" note in column D, plus a reason in column C.
//
// This filter exists because the Outreach sheet is not one table. Below
// the contact list sits a second block — the von Cramon call's findings,
// with its own "What he said / outcome" header — and column B there
// holds prose like "Tree crop -> supply can't respond for years". Taking
// every row with a value in B swept eight interview findings into the
// funnel as people, which both inflated the outreach count and put
// evidence somewhere it can never be cited from.
function looksLikeContact(r) {
  const hasAddressColumn = !!(r.D && r.D.trim());
  const hasReason = !!(r.C && r.C.trim());
  return hasAddressColumn && hasReason;
}

export async function extractOutreach(file) {
  const rows = await readSheet(file, 'Outreach');
  return rows
    .slice(1)
    .filter((r) => r.B && looksLikeContact(r))
    .map((r) => {
      const base = { date: r.A, who: r.B, why: r.C, email: r.D, response: r.F, outcome: r.G };
      const { name, employer, role } = splitWho(r.B);
      return {
        ...base, name, employer, role,
        status: classifyOutcome(base),
      };
    });
}

// Store visits are laid out as a header block ("Visit: …", "Date: …")
// followed by Topic | Finding pairs. Each finding is one observation.
export async function extractStoreVisits(file) {
  const rows = await readSheet(file, 'Store Visit Notes');
  const visits = [];
  let current = null;
  for (const r of rows) {
    const a = (r.A || '').trim();
    const b = (r.B || '').trim();
    if (/^Visit:/i.test(a)) {
      current = { location: a.replace(/^Visit:\s*/i, '').slice(0, 300), date: null, notes: [], observations: [] };
      visits.push(current);
      continue;
    }
    if (!current) continue;
    if (/^Date:/i.test(a)) {
      current.date = (/(\d{4}-\d{2}-\d{2})/.exec(a) || [])[1] || null;
      current.notes.push(a);
      continue;
    }
    if (/^Note:/i.test(a)) { current.notes.push(a); continue; }
    // The header row of the findings table, not a finding.
    if (/^Topic$/i.test(a)) continue;
    if (a && b) {
      current.observations.push({ topic: a.toLowerCase().slice(0, 60), text: b.slice(0, 2000) });
    }
  }
  return visits.filter((v) => v.observations.length || v.date);
}
