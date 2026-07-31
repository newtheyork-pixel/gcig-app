// A company's plain-language description lives in Item 1 ("Business") of
// its annual report. Finnhub's free tier doesn't carry one and Yahoo's
// profile endpoint is blocked from datacenter IPs, but EDGAR is reachable
// from Render with nothing more than a descriptive User-Agent — the same
// path the rest of secFilings.js already uses.
//
// The fragile bit is the 10-K HTML: "Item 1. Business" shows up first as
// a table-of-contents link and only later as the real header, the section
// closes at "Item 1A." (or "Item 2." for filers predating Risk Factors),
// and the markup is entity- and tag-soup. extractItem1Business is the
// pure, tested core of that; getBusinessSummary is thin glue over the
// existing CIK/filings lookup.

import { getLatestFilingByForm, SEC_UA } from './secFilings.js';

// Inline tags vanish with no gap ("<b>Acme</b>Co" -> "AcmeCo"); anything
// structural becomes whitespace so a header can't fuse to its body.
const BLOCK_TAG =
  /<\/?(p|div|br|tr|td|th|table|thead|tbody|h[1-6]|li|ul|ol|section|article|header|footer|hr)\b[^>]*>/gi;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Newlines are kept at block boundaries on purpose: a real section
// header sits alone on its own line, whereas a cross-reference ("...set
// forth in Part I, "Item 1. Business" of this report...") is embedded
// mid-sentence. That structural difference is the only reliable way to
// tell the real Item 1 from the dozens of times the phrase is cited.
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(BLOCK_TAG, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Headers must match in their *title* form. A bare "Item 1A" also occurs
// as a prose cross-reference ("See Item 1A of Part I — Risk Factors"),
// which would chop the description off after one sentence; requiring
// "Risk Factors" / "Properties" right after the number skips those. The
// number is anchored so "Item 1A" / "Item 10" can't satisfy "Item 1".
const ITEM1 = /\bitem\s+1\.?\s*[-—:]?\s*business\b/gi;
const ITEM1A = /\bitem\s+1a\.?\s*[-—:]?\s*risk\s+factors\b/gi;
const ITEM2 = /\bitem\s+2\.?\s*[-—:]?\s*propert/gi;

function endsOf(text, re) {
  const out = [];
  for (const m of text.matchAll(re)) out.push(m.index);
  return out;
}

export function extractItem1Business(html) {
  const text = htmlToText(html);

  // "Item 1. Business" appears in the table of contents, as the real
  // section header, and sometimes as a later cross-reference. Rather
  // than guess which, pair every candidate start with its closing
  // header (Item 1A · Risk Factors, or Item 2 · Properties for filers
  // predating Risk Factors) and keep the pairing that yields the most
  // text — the real Business section dwarfs a TOC row or a stray "see
  // Item 1. Business" reference.
  const starts = [...text.matchAll(ITEM1)]
    .filter((m) => m.index === 0 || text[m.index - 1] === '\n')
    .map((m) => m.index + m[0].length);
  if (starts.length === 0) return null;

  const closers = endsOf(text, ITEM1A);
  const fallback = endsOf(text, ITEM2);

  let best = null;
  for (const s of starts) {
    let end = closers.find((i) => i > s);
    if (end == null) end = fallback.find((i) => i > s);
    if (end == null) continue;
    if (!best || end - s > best.end - best.s) best = { s, end };
  }
  if (!best) return null;

  const body = collapse(text.slice(best.s, best.end));
  return body || null;
}

/// Split into sentences without cutting a company in half.
///
/// "Mesa Laboratories, Inc." and "approximately 6,800" both carry a full
/// stop that ends nothing, so the split needs the following token to
/// look like the start of a sentence and the preceding one not to be a
/// known abbreviation.
const ABBREV = /(?:\b(?:Inc|Corp|Co|Ltd|LLC|LP|Sr|Jr|Dr|Mr|Mrs|Ms|St|No|Nos|approx|Ave|vs|etc|al|U\.S|Fig)|\b[A-Z])\.$/;

export function sentences(text) {
  const parts = String(text || '').split(/(?<=\.)\s+(?=[A-Z“"(])/);
  const out = [];
  for (const p of parts) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/// The paragraph every 10-K opens with and nobody wants to read.
///
/// Item 1 does not begin with the business, it begins with the drafting
/// conventions of the document — who "we" refers to, which state the
/// company was chartered in, when the fiscal year ends. Mesa's
/// description opened "In this annual report, Mesa Laboratories, Inc., a
/// Colorado corporation, together with its subsidiaries is collectively
/// referred to as 'we,' 'us,' 'our'…", and Applied's opened on a bare
/// full stop. That is legal furniture, not a description.
const BOILERPLATE = [
  /^\W*in this (annual report|report|form 10-K)/i,
  /collectively referred to as/i,
  /^references? (in this|to)\b/i,
  /unless (the )?(context|otherwise)/i,
  /^the fiscal year (end|ended)/i,
  /^\W*(general|overview|our business|the company)\W*$/i,
  /^\W*$/,
  /^\S{1,3}$/,
];

/// A sentence that actually says what the company does. This is what we
/// want the description to OPEN on, the way Bloomberg's does.
const DESCRIPTIVE =
  /\b(?:we|the company|it)\s+(?:are|is|design|designs|manufactures?|provides?|offers?|operates?|distributes?|develops?|sells?|makes?|serves?)\b|\b(?:is|are)\s+a\s+(?:leading|global|major|worldwide|premier|diversified)\b|\bis\s+(?:a|an)\s+[A-Za-z-]+\s+(?:company|manufacturer|distributor|provider|producer|retailer|operator)\b/i;

/**
 * Drop the drafting conventions and start on the business.
 *
 * Conservative by design: if nothing in the opening looks like a
 * description, only the sentences that are unmistakably boilerplate are
 * removed and the rest is left exactly as filed. Returning a worse
 * description than we started with is the one outcome worth avoiding —
 * these are the company's own words and we are only choosing where to
 * begin quoting.
 */
/// Section furniture that survives the flattening and lands glued to the
/// front of the first real sentence: "General We are a global leader…",
/// "(Dollars in millions, unless otherwise noted) BUSINESS OVERVIEW…".
///
/// The single-word case needs care. "General We are…" is a header
/// followed by a sentence; "General Dynamics is…" is a company. So a
/// lone header word is only removed when what follows it unmistakably
/// begins a sentence, and a RUN of capitals is removed unconditionally
/// because no real sentence is written in block capitals.
const HEADER_WORD = /^(General|Overview|Introduction|Background|Business|Company)\s+(?=(?:We|Our|The|It|Its|This)\b)/;

export function stripLeadIn(s) {
  let out = String(s || '').trim();
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(/^\([^)]{0,120}\)\s*/, '');
    out = out.replace(/^(?:[A-Z][A-Z&.,'-]*\s+){1,5}(?=[A-Z][a-z])/, '');
    out = out.replace(HEADER_WORD, '');
    out = out.replace(/^[\s.,;:—–-]+/, '');
    if (out === before) break;
  }
  return out || String(s || '').trim();
}

export function openOnBusiness(text) {
  const sents = sentences(text).map((s, i) => (i === 0 ? stripLeadIn(s) : s));
  if (!sents.length) return text;

  // Look for a real opening line inside the preamble only. A 10-K that
  // says what it does in its first sentence must not be re-cut from
  // somewhere in the middle.
  const scan = Math.min(sents.length, 8);
  let start = -1;
  for (let i = 0; i < scan; i++) {
    if (DESCRIPTIVE.test(sents[i])) { start = i; break; }
  }

  if (start >= 0) {
    const picked = sents.slice(start);
    picked[0] = stripLeadIn(picked[0]);
    return picked.join(' ');
  }

  const kept = sents.filter((s, i) => !(i < scan && BOILERPLATE.some((re) => re.test(s))));
  const out = kept.length ? kept : sents;
  out[0] = stripLeadIn(out[0]);
  return out.join(' ');
}

/// Facts Bloomberg prints in a field of their own rather than burying in
/// the prose.
///
/// Both patterns here are deliberately narrow, because the loose version
/// of this function invented things. Matching "headquarters in <Place>"
/// anywhere in Item 1 gave General Dynamics a head office in St. Louis,
/// Missouri — read from "we supported NGA in the development of their
/// new headquarters", a sentence about a customer's building. GD is run
/// from Reston, Virginia. Head office now comes from the submissions
/// feed, which states it as a field and cannot be misread; nothing is
/// extracted from prose that a structured source already answers.
///
/// Headcount survived only in the first person. "approximately 40,000
/// employees" appears in segment discussions, safety policies and
/// customer descriptions; "we had approximately 6,800 associates" is the
/// company speaking about itself. Where a filer does not use that form
/// the answer is null, and null renders as a dash — which is the honest
/// outcome, and the one the source-discipline rule demands.
export function corporateFacts(text) {
  const t = String(text || '');
  const founded = t.match(
    /\b(?:was|were)\s+(?:originally\s+)?(?:organized|incorporated|founded|established|formed)\b[^.]{0,60}?\b(1[89]\d\d|20[0-2]\d)\b/i
  ) || t.match(/\b(?:have|has)\s+engaged in business since\s+(1[89]\d\d|20[0-2]\d)\b/i)
    || t.match(/\b(?:founded|established)\s+in\s+(1[89]\d\d|20[0-2]\d)\b/i);

  const emp = t.match(
    /\b(?:we|the company)\s+(?:had|have|employ|employed|currently employ)\s+(?:approximately|about|roughly|over|more than|nearly|some)?\s*([\d,]{3,12})\s+(?:full-?\s?time\s+|regular\s+|salaried\s+)?(?:employees|people|team members|associates|employee associates)\b/i
  ) || t.match(
    /\bour\s+(?:global\s+)?workforce\s+(?:of|numbers|totals|comprises|consisted of)\s+(?:approximately|about|roughly|over|more than|nearly)?\s*([\d,]{3,12})\b/i
  );
  const n = emp ? Number(String(emp[1]).replace(/,/g, '')) : null;

  return {
    founded: founded ? Number(founded[1]) : null,
    // A two-figure floor rules out a stray page number; a five-million
    // ceiling rules out a dollar amount that happened to precede the
    // word "employees".
    employees: n && n >= 10 && n < 5_000_000 ? n : null,
  };
}

// 10-Ks are annual; once we've parsed one, hold it for a week so a click
// storm doesn't re-pull a multi-megabyte filing.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map();

// EDGAR's Item 1 can run many pages of legalese; the DES panel wants a
// description, not the whole filing. Keep a generous slice ending on a
// sentence boundary.
const MAX_CHARS = 3500;

function trimToSentence(s) {
  if (s.length <= MAX_CHARS) return s;
  const cut = s.slice(0, MAX_CHARS);
  const dot = cut.lastIndexOf('. ');
  return (dot > MAX_CHARS * 0.5 ? cut.slice(0, dot + 1) : cut).trim() + ' […]';
}

/// The description alone, for callers that only want prose.
export async function getBusinessSummary(ticker) {
  return (await getBusinessProfile(ticker))?.summary || null;
}

/**
 * The description plus the corporate facts stated alongside it: when the
 * company was founded, where it is run from, how many people work there.
 * Bloomberg gives each of those its own field on DES, and every one of
 * them is sitting in Item 1 already.
 */
export async function getBusinessProfile(ticker) {
  const key = String(ticker || '').trim().toUpperCase();
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;
  try {
    const tenK = await getLatestFilingByForm(key, /^10-K(405|SB)?$/i);
    if (tenK?.url) {
      const r = await fetch(tenK.url, {
        headers: { 'User-Agent': SEC_UA, Accept: 'text/html' },
      });
      if (r.ok) {
        const item1 = extractItem1Business(await r.text());
        if (item1) {
          // Facts are read from the WHOLE section, then the prose is
          // trimmed. Doing it the other way round loses the headcount,
          // which is usually stated well past the opening paragraph.
          value = {
            summary: trimToSentence(openOnBusiness(item1)),
            ...corporateFacts(item1),
            filedAt: tenK.filingDate || null,
            url: tenK.url,
          };
        }
      }
    }
  } catch {
    value = null;
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}
