import { resolveCik } from './secFundamentals.js';
import { SEC_UA } from './secFilings.js';

// Who runs the company TODAY.
//
// MGMT used to answer this from the proxy statement, which is the wrong
// document for the question. A DEF 14A is filed once a year and its
// compensation table is a record of who was paid last fiscal year — so
// Mesa Labs showed "Gary Owens, Former CEO and President" as the top of
// the org chart four months after he left, with no mention of the man
// who replaced him. The table was not stale by accident; it was never a
// roster in the first place.
//
// Forms 3 and 4 are. Every officer files a Form 3 within ten days of
// taking office and a Form 4 within two of trading, and both carry
// <officerTitle> in a structured field. Siddhartha Kadia's Form 3 was on
// file on 24 April 2026, nine days into the job and eleven weeks before
// the proxy we had been reading. The signal was always there.
//
// What this cannot see: an officer who leaves and is not replaced. They
// simply stop filing, and silence has no date. Departures are read from
// 8-K Item 5.02 instead, which is what that item exists to announce.

const SUBMISSIONS = 'https://data.sec.gov';
const EDGAR = 'https://www.sec.gov';
const TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();

// Fifteen months, so a full annual cycle of Form 4s is always in view
// even for a company whose insiders trade once a year after the blackout
// lifts. Forty documents, because the roster is a few dozen people and
// the rest is the same names trading again.
const WINDOW_MONTHS = 15;
const MAX_DOCS = 40;
const CONCURRENCY = 5;

export function _resetOfficerRosterCache() {
  cache.clear();
}

/// SEC ownership filings record a name as the surname first: "Owens Gary
/// M", "Crennen Lyndsey Elizabeth". Printed as filed it reads like a
/// database export, so we put it back the way a person writes it.
///
/// Two things break the naive swap and both are common enough to matter.
/// A suffix is not a forename ("Smith John Jr" is not "John Jr Smith"),
/// and a surname particle belongs to the surname ("Van Dort Oran" is
/// Oran Van Dort, not Dort Oran Van).
const SUFFIX = /^(JR|SR|II|III|IV|V|MD|PHD|ESQ)\.?$/i;
const PARTICLE = /^(VAN|VON|DE|DEL|DELLA|DER|DA|DI|DU|LA|LE|ST|MC|MAC|BIN|AL)$/i;

/// Some filers shout. "VINCENT K PETRELLA" next to "Peter C Wallace" in
/// the same table is the filer's habit showing through, not information,
/// so a name written entirely in capitals gets cased like the rest.
/// Mixed case is left exactly as filed — "McDonald" and "DeSantis" are
/// how those people spell their names and we do not know better.
function uncap(s) {
  if (/[a-z]/.test(s)) return s;
  // Roman numerals and post-nominals are not words and must not be
  // sentence-cased — "Warren E Hoffner Iii" is nobody's name.
  return s.replace(/[A-Z][A-Za-z'’-]*/g, (w) =>
    /^(I{1,3}|IV|VI{0,3}|MD|PHD|CPA|CFA)$/.test(w) ? w : w[0] + w.slice(1).toLowerCase());
}

export function displayName(filed) {
  const raw = uncap(decodeEntities(filed).trim().replace(/\s+/g, ' '));
  if (!raw) return '';
  // An explicit comma already tells us where the surname ends.
  const comma = raw.match(/^([^,]+),\s*(.+)$/);
  if (comma) return `${comma[2]} ${comma[1]}`.replace(/\s+/g, ' ').trim();

  let parts = raw.split(' ');
  if (parts.length < 2) return raw;

  let suffix = '';
  if (SUFFIX.test(parts[parts.length - 1])) suffix = parts.pop();
  if (parts.length < 2) return [...parts, suffix].filter(Boolean).join(' ');

  // A particle at the front means the surname runs two tokens.
  const surnameLen = PARTICLE.test(parts[0]) && parts.length > 2 ? 2 : 1;
  const surname = parts.slice(0, surnameLen).join(' ');
  const rest = parts.slice(surnameLen).join(' ');
  return [rest, surname, suffix].filter(Boolean).join(' ');
}

/// Which office a title names.
///
/// Titles are written by whoever filed them: "CEO", "Chief Executive
/// Officer", "President and CEO", "CAO", "SVP Operations". Grouping them
/// is what lets a successor displace a predecessor — the whole trick
/// below is that an office has one holder, so the newest filer holding
/// an office is the person in it.
///
/// Order matters. "President and CEO" is the chief executive, not the
/// president, so CEO is tested first.
///
/// Only offices that are SINGULAR by definition belong in this list,
/// because the successor rule below assumes one holder. Everything else
/// returns null and is never displaced by anybody.
const OFFICES = [
  ['ceo', /\bCEO\b|CHIEF\s+EXEC/i, 'Chief Executive Officer'],
  ['cfo', /\bCFO\b|CHIEF\s+FINANC/i, 'Chief Financial Officer'],
  ['coo', /\bCOO\b|CHIEF\s+OPERATING/i, 'Chief Operating Officer'],
  ['cao', /\bCAO\b|CHIEF\s+ACCOUNT/i, 'Chief Accounting Officer'],
  ['cto', /\bCTO\b|CHIEF\s+TECHNOL/i, 'Chief Technology Officer'],
  ['clo', /\bGENERAL\s+COUNSEL\b|\bCLO\b|CHIEF\s+LEGAL/i, 'General Counsel'],
  ['pres', /\bPRESIDENT\b/i, 'President'],
];

/// A vice president is not the president, and a company has many of
/// them. General Dynamics carries six Executive Vice Presidents and
/// Vice Presidents at once; matching the word PRESIDENT inside their
/// titles filed all six under one office, where the successor rule
/// promptly declared five of them departed. They had not gone anywhere.
///
/// A divisional president is the same trap one level down — "President,
/// Aerospace" is not the office of President — so the title has to be
/// the corporate one, alone or paired with another C-suite role.
const NOT_PRESIDENT = /\b(VICE|VP|EVP|SVP|AVP|DEPUTY|ASSISTANT|ASSOC(IATE)?)\b|VICE[-\s]*PRES/i;
const DIVISIONAL = /\bPRESIDENT\b\s*[-,–—]|\bPRESIDENT\s+OF\b/i;

export function officeOf(title) {
  const t = String(title || '');
  if (!t.trim()) return null;
  for (const [key, re] of OFFICES) {
    if (!re.test(t)) continue;
    if (key === 'pres' && (NOT_PRESIDENT.test(t) || DIVISIONAL.test(t))) return null;
    return key;
  }
  return null;
}

/// Rank for display. The chief executive goes first because that is the
/// name anyone opening the panel came for.
const OFFICE_RANK = { ceo: 0, pres: 1, cfo: 2, coo: 3, cao: 4, cto: 5, clo: 6 };

/// Entities, decoded once and in one place.
///
/// Both halves of this file need it and both got it wrong first time:
/// an officer's title came through as "Vice President-CFO &amp;
/// Treasurer" and an 8-K opened with a literal "&#160;". Numeric forms
/// matter as much as the named ones — SEC filers emit &#160; and &#8217;
/// far more often than &nbsp; and &rsquo;.
///
/// Order is not negotiable: markup is stripped BEFORE this runs, never
/// after, or an escaped &lt;b&gt; becomes a live tag that the stripper
/// has already gone past.
const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', mdash: '—', ndash: '–', hellip: '…',
};

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] ?? m));
}

function tag(xml, name) {
  const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

function flag(xml, name) {
  return new RegExp(`<${name}>\\s*(1|true)\\s*</${name}>`, 'i').test(String(xml));
}

export function parseOwnershipDoc(xml, { form, filedAt } = {}) {
  const doc = String(xml || '');
  if (!/<ownershipDocument/i.test(doc)) return null;
  const name = tag(doc, 'rptOwnerName');
  if (!name) return null;
  const rel = (doc.match(/<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/i) || [])[1] || '';
  return {
    filedName: name,
    // The person's own EDGAR identity. It unlocks their filings at
    // EVERY issuer, which is what the interlock network is built from.
    ownerCik: tag(doc, 'rptOwnerCik'),
    title: tag(rel, 'officerTitle'),
    isOfficer: flag(rel, 'isOfficer'),
    isDirector: flag(rel, 'isDirector'),
    isTenPercent: flag(rel, 'isTenPercentOwner'),
    form: form || '',
    filedAt: filedAt || '',
  };
}

/// Fold a pile of ownership filings into a roster.
///
/// Newest filing per person wins the title — people get promoted, and a
/// Form 4 from March should not outrank one from June. Then the office
/// rule: where two people have held the same office inside the window,
/// only the later one still holds it, and the earlier is marked former
/// with the date their successor first appeared. That is what separates
/// Kadia from Owens without anyone having to write a rule about Mesa.
export function buildRoster(docs) {
  const people = new Map();
  for (const d of docs) {
    if (!d || !d.filedName) continue;
    const key = d.filedName.toUpperCase().replace(/[^A-Z ]/g, '').trim();
    const prev = people.get(key);
    if (!prev) {
      people.set(key, {
        filedName: d.filedName,
        name: displayName(d.filedName),
        title: d.title || '',
        isOfficer: d.isOfficer,
        isDirector: d.isDirector,
        isTenPercent: d.isTenPercent,
        ownerCik: d.ownerCik || null,
        lastFiledAt: d.filedAt,
        firstFiledAt: d.filedAt,
        // A Form 3 is somebody's first ownership filing at this company,
        // which in practice is the day they took the job.
        form3At: d.form === '3' ? d.filedAt : null,
      });
      continue;
    }
    if (d.filedAt > prev.lastFiledAt) {
      prev.lastFiledAt = d.filedAt;
      if (d.title) prev.title = d.title;
      prev.isOfficer = prev.isOfficer || d.isOfficer;
      prev.isDirector = prev.isDirector || d.isDirector;
    }
    if (!prev.ownerCik && d.ownerCik) prev.ownerCik = d.ownerCik;
    if (d.filedAt < prev.firstFiledAt) prev.firstFiledAt = d.filedAt;
    if (d.form === '3' && (!prev.form3At || d.filedAt < prev.form3At)) prev.form3At = d.filedAt;
  }

  const all = [...people.values()].map((p) => ({ ...p, office: officeOf(p.title) }));

  // One office, one holder. Whoever filed most recently under it is in
  // the chair; anyone earlier left it, and we can say when.
  const byOffice = new Map();
  for (const p of all) {
    if (!p.office) continue;
    const cur = byOffice.get(p.office);
    if (!cur || p.lastFiledAt > cur.lastFiledAt) byOffice.set(p.office, p);
  }
  for (const p of all) {
    if (!p.office) continue;
    const holder = byOffice.get(p.office);
    // A filer who writes "Sakys John" one quarter and "Sakys John V" the
    // next is one person under two keys, and without this check he
    // succeeds himself and half of him is reported as having left.
    if (holder !== p && !sameHuman(holder.name, p.name)) {
      p.former = true;
      // The successor's first filing is the best-dated evidence we have
      // of when the handover happened. It is an upper bound, not the
      // announcement, so the panel says "by" rather than "on".
      p.supersededBy = holder.name;
      p.supersededBy_at = holder.form3At || holder.firstFiledAt || null;
    }
  }

  return all.sort((a, b) => {
    if (!!a.former !== !!b.former) return a.former ? 1 : -1;
    const ra = a.office ? OFFICE_RANK[a.office] ?? 90 : a.isOfficer ? 91 : 95;
    const rb = b.office ? OFFICE_RANK[b.office] ?? 90 : b.isOfficer ? 91 : 95;
    return ra - rb || (b.lastFiledAt || '').localeCompare(a.lastFiledAt || '');
  });
}

/// Is this the same person, written by two different filers?
///
/// The proxy says "Gary Owens", the Form 4 says "Owens Gary M". Compare
/// the substantial tokens and require the surname plus one more to line
/// up — initials and suffixes carry no information and their absence on
/// one side is not a mismatch.
export function sameHuman(a, b) {
  const toks = (s) => new Set(
    String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 1 && !SUFFIX.test(w)));
  const A = toks(a);
  const B = toks(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared >= 2 || (shared === 1 && (A.size === 1 || B.size === 1));
}

/**
 * Reconcile the proxy's leadership section against the ownership roster.
 *
 * The proxy contributes what only a proxy has — age, tenure, prior
 * roles, and what the person was paid. The roster contributes who is
 * actually in the chair. Neither is discarded: a current officer keeps
 * their pay figure, and a departed one stops being presented as staff.
 */
export function mergeLeadership(parsed, roster, { proxyFiledAt } = {}) {
  const proxyExecs = parsed?.execs || [];
  const officers = (roster?.officers || []).filter((o) => o.isOfficer || o.office);

  if (!officers.length) {
    return {
      ceo: parsed?.ceo || null,
      execs: proxyExecs,
      leadership: { source: 'proxy', asOf: proxyFiledAt || null, officers: [], former: [], events: roster?.events || [], changedSinceProxy: false },
    };
  }

  const enrich = (o) => {
    const p = proxyExecs.find((e) => sameHuman(e.name, o.name) || sameHuman(e.name, o.filedName));
    return {
      name: o.name,
      title: o.title || (p?.title ?? null),
      age: p?.age ?? null,
      since: p?.since ?? null,
      priorRoles: p?.priorRoles ?? null,
      totalComp: p?.totalComp ?? null,
      office: o.office || null,
      lastFiledAt: o.lastFiledAt,
      // A Form 3 dated after the proxy went out is somebody the proxy
      // could not have mentioned. Worth a badge — it is exactly the
      // information a stale panel was hiding.
      appointedAt: o.form3At || null,
      isNew: !!(o.form3At && proxyFiledAt && o.form3At > proxyFiledAt),
      inProxy: !!p,
    };
  };

  const current = officers.filter((o) => !o.former).map(enrich);
  const former = officers.filter((o) => o.former).map((o) => ({
    ...enrich(o),
    former: true,
    supersededBy: o.supersededBy || null,
    supersededByAt: o.supersededBy_at || null,
  }));

  const ceo = current.find((o) => o.office === 'ceo') || parsed?.ceo || null;
  return {
    ceo,
    execs: current,
    leadership: {
      source: 'sec-ownership',
      asOf: roster?.asOf || null,
      proxyAsOf: proxyFiledAt || null,
      officers: current,
      former,
      events: roster?.events || [],
      changedSinceProxy: former.length > 0 || current.some((o) => o.isNew),
    },
  };
}

/// Directors the proxy missed.
///
/// Applied Industrial's DEF 14A parsed to three directors and its
/// ownership filings name nine. The parse is best-effort against prose
/// that every filer lays out differently, so a short board is a parser
/// result, not a fact about the company. Names from filings fill the gap
/// and say where they came from — a row with no bio is honest; a board
/// missing two thirds of its members is not.
export function mergeBoard(board, roster) {
  const proxyBoard = board || [];
  const filed = (roster?.officers || []).filter((o) => o.isDirector);
  const extra = filed
    .filter((d) => !proxyBoard.some((b) => sameHuman(b.name, d.name) || sameHuman(b.name, d.filedName)))
    .map((d) => ({
      name: d.name,
      title: d.title || null,
      age: null, since: null, committees: [], independent: null,
      otherBoards: [], bio: null,
      _source: 'ownership',
    }));
  return [...proxyBoard, ...extra];
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`SEC ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/xml,text/xml,text/html,*/*' } });
  if (!r.ok) throw new Error(`SEC ${r.status}`);
  return r.text();
}

/// The XSL path in the feed points at SEC's HTML rendering; the raw
/// ownership XML is the same URL with that segment removed.
function rawOwnershipUrl(url) {
  return String(url || '').replace(/\/xsl[^/]+\//, '/');
}

function cutoffISO(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function mapLimited(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out.push(await fn(items[idx]));
      } catch {
        // One unreadable document must not empty the roster.
      }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

/// The 8-K item that announces people arriving and leaving.
///
/// The submissions feed carries an `items` column, so finding these
/// costs nothing beyond the feed we already hold — only the handful that
/// match are actually fetched.
export function extractItem502(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  // Non-breaking spaces survive decoding as U+00A0 and are not matched
  // by \s in every engine; fold them before collapsing runs.
  t = t.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const at = t.search(/Item\s*5\.02|5\.02/i);
  if (at < 0) return '';
  let body = t.slice(at);
  // Drop the item's own boilerplate heading — every filer repeats the
  // full "Departure of Directors or Certain Officers…" title and it is
  // forty words of nothing.
  body = body.replace(/^(Item\s*)?5\.02\.?\s*/i, '');
  body = body.replace(/^Departure of Directors[^.]*Officers\.?\s*/i, '');
  const end = body.search(/\bSIGNATURES?\b|Pursuant to the requirements of the Securities Exchange Act/i);
  if (end > 0) body = body.slice(0, end);
  return body.trim().slice(0, 700);
}

/**
 * Current leadership for a ticker, from ownership filings, plus the
 * 8-K Item 5.02 announcements behind any recent change.
 *
 * Never throws: MGMT still renders its proxy sections when this is
 * unavailable, and an empty roster is honestly empty.
 */
export async function getOfficerRoster(ticker, deps = {}) {
  const sym = String(ticker || '').toUpperCase();
  if (!sym) return { officers: [], events: [], asOf: null };

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const json = deps.getJson || getJson;
  const text = deps.getText || getText;

  const empty = { officers: [], events: [], asOf: null };
  let value = empty;
  try {
    const info = await resolveCik(sym);
    if (!info) return empty;
    const feed = await json(`${SUBMISSIONS}/submissions/CIK${info.cik}.json`);
    const r = feed?.filings?.recent;
    if (!r || !Array.isArray(r.form)) return empty;

    const since = cutoffISO(WINDOW_MONTHS);
    const docUrl = (i) =>
      `${EDGAR}/Archives/edgar/data/${info.cikInt}/${String(r.accessionNumber[i] || '').replace(/-/g, '')}/${r.primaryDocument[i] || ''}`;

    const ownership = [];
    const changes = [];
    for (let i = 0; i < r.form.length; i++) {
      const form = String(r.form[i] || '');
      const filedAt = String(r.filingDate[i] || '');
      if (filedAt < since && changes.length && ownership.length >= MAX_DOCS) break;
      if ((form === '3' || form === '4') && filedAt >= since && ownership.length < MAX_DOCS) {
        ownership.push({ form, filedAt, url: rawOwnershipUrl(docUrl(i)) });
      }
      // Officer-change 8-Ks reach back further than the ownership
      // window: the announcement that explains a departure is worth
      // keeping long after the trading records have rolled off.
      if (form === '8-K' && String(r.items?.[i] || '').includes('5.02') && changes.length < 4) {
        changes.push({ filedAt, url: docUrl(i) });
      }
    }

    const docs = await mapLimited(ownership, CONCURRENCY, async (f) =>
      parseOwnershipDoc(await text(f.url), { form: f.form, filedAt: f.filedAt })
    );
    const officers = buildRoster(docs);

    const events = await mapLimited(changes, 2, async (c) => {
      const summary = extractItem502(await text(c.url));
      return summary ? { filedAt: c.filedAt, url: c.url, summary } : null;
    });
    events.sort((a, b) => (b.filedAt || '').localeCompare(a.filedAt || ''));

    value = {
      officers,
      events,
      asOf: officers.reduce((m, o) => (o.lastFiledAt > m ? o.lastFiledAt : m), ''),
      source: 'sec-ownership',
      scanned: docs.length,
    };
  } catch (err) {
    console.warn(`officerRoster(${sym}) failed:`, err.message);
    return empty;
  }

  cache.set(sym, { at: Date.now(), value });
  return value;
}
