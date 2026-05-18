// The executive half of MGMT's person profiles. Directors' bios ride
// the DEF 14A we already fetch (parseBoard); executive bios do not live
// in the proxy at all — by SEC rule the officer disclosure sits in the
// 10-K's Part I "Information about our Executive Officers" item. This
// service is the same SEC plumbing as proxyStatement.js (keyless,
// declarative SEC_UA, 24h cache, size-capped, never-throws): it picks
// the latest 10-K, locates that section by heading signature, and
// splits it into per-officer { name, bio }.
//
// Three real filer shapes drive the parser, captured as trimmed-but-
// real fixtures (see __fixtures__/README.md):
//   - AMZN: a Name/Age/Position summary table, then one bold-name
//     prose paragraph per officer — the prose IS the bio.
//   - KO:   every officer is one <tr> [Name, Age, career-narrative],
//     the narrative cell IS the bio, split across a page break into
//     two sibling <table>s.
//   - CAT:  one table, the name cell trails a parenthetical age and
//     two position columns carry the bio.
// Bespoke-document variance is the same honest class as the proxy
// parser: it works where the section parses; an honest empty officers
// list otherwise (some filers — MLAB, AAPL — incorporate Item 10 by
// reference to the proxy and carry no such section; that is a tier,
// not a bug).
import { getRecentFilings, SEC_UA } from './secFilings.js';
import { parseHtml, cellText } from './htmlExtract.js';

// SEC hands back the XSL viewer URL (.../xslF…/doc.htm → an HTML
// wrapper, not the filing). The raw primary document sits at the same
// path without that segment. Same strip as pickLatestDef14A.
function toRawUrl(url) {
  return String(url || '').replace(/\/xsl[^/]+\//, '/');
}

// 10-K/A is an amendment and frequently restates only a slice of the
// filing — never fall back to it for the officer section. Newest 10-K
// only, raw-URL stripped, same discipline as pickLatestDef14A.
export function pickLatest10K(filings) {
  if (!Array.isArray(filings)) return null;
  const ks = filings
    .filter((f) => f && String(f.form) === '10-K' && f.url)
    .sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
  if (ks.length === 0) return null;
  return { ...ks[0], url: toRawUrl(ks[0].url) };
}

// 10-Ks run tens of MB. The officer section sits in Part I, Item 1
// (Business) — comfortably inside the front of the document — so a
// 12 MB cap is generous headroom while staying bounded; a pathological
// filing can't blow memory. Mirrors proxyStatement's MAX_HTML.
const MAX_HTML = 12 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
export function _resetExecBiosCache() {
  cache.clear();
}

async function defaultFilingsFetch(ticker) {
  return getRecentFilings(ticker, { limit: 150 });
}
async function defaultDocFetch(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': SEC_UA, Accept: 'text/html,*/*' },
  });
  if (!r.ok) throw new Error(`sec doc ${r.status}`);
  return r.text();
}

// The section heading. Filers title it "Information about our
// Executive Officers" (AMZN, CAT — sometimes prefixed "Item 1D." /
// "ITEM X."), "Information About Our Executive Officers" (KO), or the
// legacy "Executive Officers of the Registrant" / "...of the Company"
// forms. The TOC carries the same words as a hyperlink, so the locate
// below also checks the node isn't an anchor link.
const HEADING_RE =
  /information about (?:our )?executive officers|executive officers of the (?:registrant|company)/i;

// Where the officer section ends. The very next Part/Item heading or a
// sibling section title bounds it — critically the AMZN "Board of
// Directors" roster sits immediately after the officers and reuses the
// same Name/Age/Position columns, so without this bound a non-
// executive director would be read as an officer.
const SECTION_END_RE =
  /^(board of directors\b|part\s+i{1,3}\b|item\s+\d|executive compensation\b|directors,\s+executive officers)/i;

// A node that reads as a heading: short, and a typographic heading tag
// or a short bold/italic run. Used both to find the section start and
// to find where it ends.
function isHeadingNode(n) {
  const tag = String(n.tagName || '').toLowerCase();
  if (!/^(h[1-6]|div|p|span|b|strong|td)$/.test(tag)) return false;
  const t = cellText(n);
  if (!t || t.length > 140) return false;
  if (/^h[1-6]$/.test(tag)) return true;
  const style = String(n.getAttribute('style') || '').toLowerCase();
  // 10-K headings are styled, not <h*>: a bold weight on a short run.
  return /font-weight:\s*(?:700|800|900|bold)/.test(style) || tag === 'b' || tag === 'strong';
}

// SEC's bio-card-derived layouts pack the zero-width space (U+200B)
// and BOM (U+FEFF) between cells; cellText collapses ordinary runs but
// leaves these, and they wedge into the middle of a name or sentence.
// Strip them, then collapse — the one normalization both name and bio
// cleaning need.
function collapse(s) {
  return String(s == null ? '' : s)
    .replace(/[​﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The bio cap. Officer career narratives are long (KO's densest run
// ~1,500 chars; an AMZN multi-role history similar) but bounded; the
// cap keeps a pathological cell from ballooning the payload. Matches
// governanceParsers' BIO_CAP so director and officer bios cap alike.
const BIO_CAP = 4000;
function tidyBio(s) {
  const t = collapse(s);
  if (!t || t.length < 2) return null;
  return t.length > BIO_CAP ? t.slice(0, BIO_CAP).trim() : t;
}

// A cell reads as an officer name, not a header or a title fragment,
// when it is 2–5 capitalized tokens (initials and Roman-numeral
// suffixes allowed) with no leading role word. The diacritic-friendly
// letter class matches the same surnames the governance parser
// handles ("Botín"); CAT packs a parenthetical age onto the cell
// ("Joseph E. Creed (50)"), stripped before the token test. Doubling
// as the officer-row discriminator, this rejects "Name", "Name and
// age" and any "Chief …" position cell.
const ROLE_WORD_RE =
  /^(chief|president|vice|senior|executive|chair|founder|co-?founder|ceo|cfo|coo|cto|cio|svp|evp|vp|general|former|director|head|group|global|principal|treasurer|secretary|managing|interim|deputy|corporate|operating|board|lead|independent|nominee|name)\b/i;

function cleanName(raw) {
  const t = collapse(raw)
    // Drop a trailing parenthetical age — CAT's "(50)" — and any
    // footnote marker glued to the surname.
    .replace(/\s*\(\s*\d{1,3}\s*\)\s*$/, '')
    .replace(/\s*\(\s*[\w.,]{1,4}\s*\)\s*$/, '')
    .trim();
  if (!t || ROLE_WORD_RE.test(t)) return '';
  // 2–5 tokens, each a name piece (word or initial); reject a cell
  // that is really a sentence/title.
  const toks = t.split(' ');
  if (toks.length < 2 || toks.length > 5) return '';
  const piece = /^(?:[\p{Lu}]\.?|[\p{Lu}][\p{L}.'’-]*|I{1,3}V?|IV|V)$/u;
  if (!toks.every((w) => piece.test(w))) return '';
  return t;
}

// Direct child <td>/<th> cells of a row, collapsed, blanks dropped.
// SEC officer tables pad every logical column with width-only spacer
// <td>s and wrap each value in a colspan=3 cell, so htmlExtract's
// column-aligned tableRows collapses them to noise; reading the row's
// own non-empty cells in order is what recovers [Name, Age, Position].
function rowCells(tr) {
  return tr
    .querySelectorAll('td,th')
    .filter((c) => c.parentNode === tr)
    .map((c) => cellText(c))
    .filter((x) => x !== '');
}

// A node "belongs to" the located section when its own source span
// opens inside the section window. node-html-parser carries each
// node's [start,end] source offsets on `.range`; comparing the start
// offset is a stable, structure-preserving alternative to physically
// moving subtrees out of the tree (reparenting flattens nested cards
// and double-visits descendants).
function inWindow(node, lo, hi) {
  const r = node && node.range;
  if (!r) return false;
  return r[0] >= lo && r[0] < hi;
}

// The officer table path (KO, CAT). For every data row whose first
// cell is a person name, the remaining cells are age and/or the
// position/career narrative. KO's narrative is one long cell; CAT
// splits "present position (year)" and "principal positions held"
// across two cells — joining the non-age remainder yields the bio
// either way. The age column (a bare 2–3 digit cell) is dropped from
// the bio. Header rows ("Name", "Name and age") fail NAME_RE.
function officersFromTables(root, lo, hi) {
  const out = [];
  for (const tr of root.querySelectorAll('tr')) {
    if (!inWindow(tr, lo, hi)) continue;
    const cells = rowCells(tr);
    if (cells.length < 2) continue;
    const name = cleanName(cells[0]);
    if (!name) continue;
    const rest = cells.slice(1).filter((c) => !/^\d{1,3}$/.test(c.trim()));
    const bio = tidyBio(rest.join(' '));
    if (bio) out.push({ name, bio });
  }
  return out;
}

// The prose path (AMZN). After the summary table the filer prints one
// block per officer: a bold run that is exactly the name plus a period
// ("Andrew R. Jassy."), then a normal-weight run with the career
// sentence. The bio is that block's text with the leading name token
// stripped. Anchoring on the bold name node (not slicing the whole
// section by name order) keeps the adjacent Board-of-Directors table
// out — directors have no such bold-name prose block.
function officersFromProse(root, lo, hi) {
  const out = [];
  for (const el of root.querySelectorAll('div,p')) {
    if (!inWindow(el, lo, hi)) continue;
    // First element child must be the bold name run.
    const kids = (el.childNodes || []).filter((c) => c.nodeType === 1);
    if (!kids.length) continue;
    const head = kids[0];
    const htag = String(head.tagName || '').toLowerCase();
    if (!/^(span|b|strong)$/.test(htag)) continue;
    const hstyle = String(head.getAttribute('style') || '').toLowerCase();
    const bold =
      htag === 'b' ||
      htag === 'strong' ||
      /font-weight:\s*(?:700|800|900|bold)/.test(hstyle);
    if (!bold) continue;
    const headTxt = cellText(head);
    // "Name." — a person name immediately followed by a period.
    const m = headTxt.match(/^(.+?)\.\s*$/);
    if (!m) continue;
    const name = cleanName(m[1]);
    if (!name) continue;
    const full = cellText(el);
    // Strip the leading name run so the bio is the career narrative,
    // not a sentence that restates the name. The bold head node IS
    // exactly "Name." — remove that known prefix rather than guess a
    // period boundary (a middle initial like "R." in "Andrew R.
    // Jassy" is itself a period and would cut the name in half).
    let bioRaw = full;
    if (full.startsWith(headTxt)) {
      bioRaw = full.slice(headTxt.length);
    }
    const bio = tidyBio(bioRaw);
    if (bio && bio.length > 20) out.push({ name, bio });
  }
  return out;
}

// Locate the officer section and return its [lo, hi) source-offset
// window: from just after the section heading to the start of the
// next bounding heading (or end of document). Returns null when no
// heading matches — the honest "no section" signal that yields an
// empty officers list rather than a fabricated one.
function locateSectionWindow(root) {
  const nodes = root.querySelectorAll('*');
  let startNode = null;
  let startIdx = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = String(n.tagName || '').toLowerCase();
    // The table of contents repeats the heading words inside an <a>;
    // the real section heading is not a link and contains none.
    if (tag === 'a') continue;
    if (!isHeadingNode(n)) continue;
    const t = cellText(n);
    if (HEADING_RE.test(t) && !n.querySelector('a')) {
      startNode = n;
      startIdx = i;
      break;
    }
  }
  if (!startNode || !startNode.range) return null;
  // The window opens at the end of the heading's own span so the
  // heading text itself (and any wrapper that merely contains it)
  // isn't mistaken for officer content.
  const lo = startNode.range[1];
  let hi = Infinity;
  for (let i = startIdx + 1; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n.range || n.range[0] < lo) continue;
    if (isHeadingNode(n)) {
      const t = cellText(n);
      if (SECTION_END_RE.test(t) && !HEADING_RE.test(t)) {
        hi = n.range[0];
        break;
      }
    }
  }
  return { lo, hi };
}

// { ticker, source, asOf, officers:[{name,bio}] }. Never throws —
// any failure (no 10-K, fetch error, unparseable section) degrades to
// the empty stub, exactly the proxyStatement.js / worldIndices.js
// contract. No fabrication: a missing section yields [], never an
// invented biography.
export async function getExecutiveBios(ticker, deps = {}) {
  const sym = String(ticker || '').toUpperCase();
  const empty = { ticker: sym, source: null, asOf: null, officers: [] };
  if (!sym) return empty;

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const filingsFetch = deps.filingsFetch || defaultFilingsFetch;
  const docFetch = deps.docFetch || defaultDocFetch;

  let payload = empty;
  try {
    const filing = pickLatest10K(await filingsFetch(sym));
    if (filing) {
      const raw = String((await docFetch(filing.url)) || '').slice(0, MAX_HTML);
      const root = parseHtml(raw);
      const win = locateSectionWindow(root);
      let officers = [];
      if (win) {
        // Prose first: where a filer publishes per-officer prose
        // (AMZN), it is the substantive bio and it naturally excludes
        // the adjacent director roster. The table path then fills in
        // the filers whose section IS a table (KO, CAT). Merge by
        // name, prose winning — an AMZN officer also appears in the
        // thin summary table and the prose bio is the better one.
        const prose = officersFromProse(root, win.lo, win.hi);
        const tabular = officersFromTables(root, win.lo, win.hi);
        const byName = new Map();
        for (const o of tabular) if (!byName.has(o.name)) byName.set(o.name, o);
        for (const o of prose) byName.set(o.name, o);
        officers = [...byName.values()];
      }
      payload = {
        ticker: sym,
        source: officers.length ? filing.url : null,
        asOf: officers.length ? filing.filingDate || null : null,
        officers,
      };
    }
  } catch (err) {
    console.warn(`executiveBios(${sym}) failed:`, err.message);
    payload = empty;
  }

  cache.set(sym, { at: Date.now(), payload });
  return payload;
}
