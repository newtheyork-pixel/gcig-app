// A company's own quarterly documents, from the company's own site.
//
// Earnings call transcripts are the thing the club wanted and could not
// get. They are not filed with the SEC — measured across 2026, about
// 0.77% of calls produce a filed transcript, all micro caps, and none of
// the club's names has ever filed one. Every service that sells them is
// paid, and every site that gives them away for free is republishing
// somebody else's copyrighted work.
//
// But a good number of companies publish their OWN transcript on their
// OWN investor-relations site, and a great many IR sites run on Q4 Inc,
// which exposes an unauthenticated JSON manifest of every quarterly
// document. Johnson & Johnson lists "2026 Second-Quarter Earnings
// Transcript" there; General Dynamics lists a release, a deck, a webcast
// and a 10-Q and no transcript at all. So the manifest answers the
// question definitively, per company, without guessing.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// Read the manifest; never construct a document URL. Filenames are not
// systematic — one company's transcripts across a dozen quarters use
// half a dozen naming conventions, so a URL built from a pattern works
// on the quarter you tested and 404s on the rest.
//
// Index, do not hoard. We store the title, the date and the link. The
// bytes are fetched when a member opens one. The club has every right to
// read a document a company published, and no reason to keep a bulk copy
// of a hundred companies' material on its own disk.

import { secFetch } from './secFetch.js';

/// Q4's manifest endpoint. `apiKey` is required by the route and is not
/// validated — "X" is accepted — so nothing here is a credential and
/// nothing is being circumvented.
const FEED_PATH = '/feed/FinancialReport.svc/GetFinancialReportList';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function feedURL(host, { pageSize = 24, year = -1 } = {}) {
  return `https://${host}${FEED_PATH}?apiKey=X&exchange=&symbol=`
    + `&pageSize=${pageSize}&pageNumber=0&reportSubType=ALL&year=${year}`
    + '&includeSummary=false';
}

/// Does this document title name a transcript?
///
/// Titles are written by whoever uploaded them, so the shapes vary:
/// "Earnings Transcript", "Conference Call & Webcast Transcript",
/// "Q2 2026 Transcript", "Earnings Call Transcript".
///
/// The negative cases matter as much. A "Webcast" is the audio, not a
/// transcript; a "Transcript Request Form" is a form. Matching the bare
/// word would file both as readable text and produce a panel of links
/// that open onto nothing.
const TRANSCRIPT_RE = /\btranscripts?\b/i;
const NOT_TRANSCRIPT_RE = /\b(request|form|policy|guideline|webcast\s+replay\s+only)\b/i;

export function isTranscript(title) {
  const t = String(title || '');
  if (!TRANSCRIPT_RE.test(t)) return false;
  return !NOT_TRANSCRIPT_RE.test(t);
}

/// The quarter a document belongs to.
///
/// Q4's own ReportQuarter field is frequently null — it was null on
/// every J&J and General Dynamics row — so the quarter has to come from
/// the title, which does carry it in one of several spellings.
export function quarterFrom(title, reportTitle) {
  const hay = `${title || ''} ${reportTitle || ''}`;
  const q = hay.match(/\bQ([1-4])\b/i)
    || hay.match(/\b([1-4])Q\d{2,4}\b/i)
    || hay.match(/\b(first|second|third|fourth)[-\s]quarter\b/i);
  if (!q) return null;
  const word = { first: 1, second: 2, third: 3, fourth: 4 };
  const raw = String(q[1]).toLowerCase();
  return word[raw] ?? Number(raw) ?? null;
}

function absolute(host, path) {
  const p = String(path || '');
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return `https://${host}${p.startsWith('/') ? '' : '/'}${p}`;
}

/**
 * Flatten a Q4 manifest into documents.
 *
 * Shapes differ between deployments — the list is sometimes under
 * `GetFinancialReportListResult`, sometimes `Items`, sometimes both
 * nested — so all three are handled rather than the one that happened
 * to be in front of us.
 */
export function parseManifest(json, host) {
  let reports = json?.GetFinancialReportListResult ?? json?.Items ?? json ?? [];
  if (!Array.isArray(reports)) reports = reports?.Items ?? [];
  if (!Array.isArray(reports)) return [];

  const out = [];
  for (const r of reports) {
    const year = Number(r?.ReportYear) || null;
    const reportTitle = r?.ReportTitle || '';
    for (const d of r?.Documents ?? []) {
      const title = d?.DocumentTitle || d?.DocumentType || '';
      const url = absolute(host, d?.DocumentPath || d?.Url);
      if (!url) continue;
      out.push({
        title: String(title).trim(),
        url,
        year,
        quarter: quarterFrom(title, reportTitle) ?? (Number(r?.ReportQuarter) || null),
        reportTitle,
        kind: isTranscript(title) ? 'transcript' : classify(title),
        // The file type as the site declares it. A null size on a
        // "Webcast" row is the manifest telling you there is no file
        // behind the link, only a player.
        fileType: d?.DocumentFileType ?? null,
        fileSize: d?.DocumentFileSize ?? null,
      });
    }
  }
  return out;
}

function classify(title) {
  const t = String(title || '').toLowerCase();
  if (/press release|earnings release|news release/.test(t)) return 'release';
  if (/presentation|slides|deck|infographic/.test(t)) return 'presentation';
  if (/webcast|audio|replay/.test(t)) return 'webcast';
  if (/10-?q|10-?k|annual report|form/.test(t)) return 'filing';
  return 'other';
}

/**
 * Every document a company's IR feed lists, newest first.
 *
 * Returns `{ ok, host, documents, reason }` and never throws: a company
 * without a Q4 feed is the normal case, not an error, and a caller
 * sweeping a watchlist must be able to tell "no feed" from "the feed
 * said no transcripts" from "we could not reach it".
 */
export async function fetchDocuments(host, deps = {}) {
  if (!host) return { ok: false, host, documents: [], reason: 'No IR host known.' };
  const get = deps.secFetch || secFetch;
  try {
    const res = await get(feedURL(host), {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeoutMs: 15_000,
      attempts: 2,
    });
    const json = await res.json();
    const documents = parseManifest(json, host);
    if (!documents.length) {
      return { ok: true, host, documents: [], reason: 'The feed answered but listed no documents.' };
    }
    documents.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.quarter ?? 0) - (a.quarter ?? 0));
    return { ok: true, host, documents };
  } catch (err) {
    // A Cloudflare interstitial and a missing feed both land here, and
    // they are different facts about the company. Say which.
    const blocked = /403|503|challenge/i.test(String(err.message || ''));
    return {
      ok: false,
      host,
      documents: [],
      reason: blocked
        ? 'The IR site refused an automated request. Not something to work around.'
        : `No usable feed at ${host}: ${String(err.message || err).slice(0, 120)}`,
    };
  }
}

/// Just the transcripts, which is what anyone asking is asking for.
export function transcriptsIn(documents) {
  return (documents || []).filter((d) => d.kind === 'transcript');
}
