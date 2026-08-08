// Trading halts — the two primary-source wires, both keyless.
//
// A halt is the one market event where minutes matter and the news
// writes itself up late: the exchange knows before any wire does, and
// both listing venues publish their halt tape publicly. We read the
// exchanges directly rather than a vendor's digest of them:
//
//   Nasdaq  https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts
//           RSS 2.0 whose items carry structured fields in the ndaq:
//           namespace (xmlns:ndaq="http://www.nasdaqtrader.com/").
//           Probed live 2026-08-07 — the real per-item fields are:
//           ndaq:HaltDate (MM/DD/YYYY), ndaq:HaltTime (HH:MM:SS.mmm),
//           ndaq:IssueSymbol, ndaq:IssueName, ndaq:Market,
//           ndaq:ReasonCode, ndaq:PauseThresholdPrice,
//           ndaq:ResumptionDate, ndaq:ResumptionQuoteTime,
//           ndaq:ResumptionTradeTime. The <description> repeats the
//           same table as CDATA HTML; we read only the fields.
//
//   NYSE    https://www.nyse.com/api/trade-halts/current/download
//           CSV, probed live the same day. Header row: Halt Date
//           (YYYY-MM-DD), Halt Time, Symbol, Name, Exchange, Reason,
//           Resume Date, NYSE Resume Time. Reason arrives already in
//           English ("News Pending", "LULD Pause", "Regulatory
//           Concern"), and Name fields arrive with literal quote
//           characters doubled inside quoted cells.
//
// Each wire also carries the OTHER exchange's halts (the Nasdaq feed
// listed NYSE/AMEX rows and vice versa), so the merge dedupes on
// symbol + halt second, preferring the Nasdaq row because it carries
// the structured reason code.
//
// All times on both wires are US Eastern — the Nasdaq halts page says
// so in a footnote ("Halt times displayed are Eastern Time (ET)"),
// and the same halts appear with identical wall-clock times in both
// feeds. We convert ET wall time to real instants here, once, so no
// caller ever has to know.
//
// Same regex-parse philosophy as newsFeeds.js: no XML or CSV
// dependency, best-effort per row, and a feed that is down or
// reshaped contributes nothing rather than an exception. One dead
// wire must never blank the other.

const CACHE_TTL_MS = 2 * 60 * 1000; // halts are urgent; 2 min, not 10
// A failed fetch must not hide behind a success's TTL (the secFetch
// lesson): on any source failure the cache is backdated so the next
// read retries in ~30s instead of serving the degraded payload for
// the full two minutes.
const FAILURE_RETRY_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

const NASDAQ_URL = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const NYSE_URL = 'https://www.nyse.com/api/trade-halts/current/download';

// Sent on every request — some publishers 403 an empty or scripted
// agent, and the http:// form of the Nasdaq URL 301s to this https
// host anyway, so we go straight there.
const UA = 'Mozilla/5.0 (compatible; GriffinFund/1.0; +https://thegriffinfund.org)';

const ET = 'America/New_York';

// ── The decode table ─────────────────────────────────────────────────
// Sourced from the exchange's own legend, not from memory: Nasdaq
// publishes "Trading Halt Codes" at
// https://www.nasdaqtrader.com/trader.aspx?id=TradeHaltCodes (read
// live 2026-08-07). The wording below is theirs, compressed to fit a
// terminal row. Two entries earned extra confidence from the live
// tape itself: the same BKSY warrant halt carried code H11 on the
// Nasdaq wire while NYSE's CSV spelled it "Regulatory Concern"
// (H11's exact legend meaning), and a WWR volatility pause carried
// code M on the Nasdaq wire against "LULD Pause" in the CSV — the
// legend defines M as the volatility pause for exchange-listed
// issues, which is why both M and LUDP exist.
//
// A code missing from this table renders as the raw code, never a
// guess: an unfamiliar code is information, an invented meaning is
// misinformation.
export const REASON_CODES = {
  T1: 'News pending',
  T2: 'News released',
  T3: 'News released — resumption times set',
  T5: 'Single-stock trading pause (10% move inside 5 minutes)',
  T6: 'Extraordinary market activity',
  T7: 'Quotation-only period — trading still paused',
  T8: 'ETF halt',
  T12: 'Additional information requested by Nasdaq',
  H4: 'Non-compliance with listing requirements',
  H9: 'Not current in required filings',
  H10: 'SEC trading suspension',
  H11: 'Regulatory concern (halted across markets)',
  O1: 'Operations halt — contact market operations',
  IPO1: 'IPO not yet trading',
  IPOQ: 'IPO released for quotation',
  IPOE: 'IPO positioning window extension',
  M1: 'Corporate action',
  M2: 'Quotation not available',
  M: 'Volatility trading pause (exchange-listed issue)',
  LUDP: 'Limit up-limit down volatility pause',
  LUDS: 'Limit up-limit down pause — straddle condition',
  MWC0: 'Market-wide circuit breaker — carried over from prior day',
  MWC1: 'Market-wide circuit breaker — Level 1',
  MWC2: 'Market-wide circuit breaker — Level 2',
  MWC3: 'Market-wide circuit breaker — Level 3',
  MWCQ: 'Market-wide circuit breaker — resumption',
  R1: 'New issue available',
  R2: 'Issue available',
  R4: 'Qualification issues resolved — resuming',
  R9: 'Filing requirements satisfied — resuming',
  C3: 'Issuer news not forthcoming — resuming',
  C4: 'Qualifications halt ended, requirements met — resuming',
  C9: 'Qualifications halt concluded, filings met — resuming',
  C11: 'Halt concluded by other regulatory authority — resuming',
  D: 'Security deleted from Nasdaq/CQS',
};

export function decodeReason(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return REASON_CODES[c] || c;
}

// ── Eastern time ─────────────────────────────────────────────────────
// Both wires publish wall-clock ET with no offset, so somebody has to
// know whether that wall clock was EDT or EST on the day in question.
// Rather than hardcoding DST rules, we try both candidate offsets and
// keep the one that formats back to the same wall time in ET. The
// hour that repeats at the fall-back seam resolves to EST — a halt
// stamped inside that single ambiguous hour lands at most an hour
// off, which beats dropping the row.

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function etParts(ms) {
  const p = {};
  for (const { type, value } of etFmt.formatToParts(ms)) p[type] = value;
  return p;
}

function etToIso(y, mo, d, h, mi, s, ms = 0) {
  for (const offsetH of [4, 5]) {
    // EDT (UTC-4) first — it covers most of the trading year.
    const t = Date.UTC(y, mo - 1, d, h + offsetH, mi, s, ms);
    const p = etParts(t);
    if (
      Number(p.year) === y &&
      Number(p.month) === mo &&
      Number(p.day) === d &&
      Number(p.hour) === h &&
      Number(p.minute) === mi
    ) {
      return new Date(t).toISOString();
    }
  }
  // The spring-forward gap (a wall time that never existed): take EST
  // rather than losing the halt.
  return new Date(Date.UTC(y, mo - 1, d, h + 5, mi, s, ms)).toISOString();
}

// The calendar day a halt resolves on is an ET question, not a UTC
// one: a 7:50pm ET halt is 23:50Z, and its same-evening resumption
// crosses UTC midnight while staying firmly "today" on the tape.
function etDayKey(ms) {
  const p = etParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

// ── Nasdaq RSS parsing ───────────────────────────────────────────────

// These fields are plain text (symbols, market names, code strings) —
// the full typographic-entity set newsFeeds carries is news-prose
// territory. Issue names still need the basics: ampersands, angle
// brackets, the odd numeric entity.
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last, or it would mint new entities
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function tag(block, name) {
  // Self-closing empties (<ndaq:ResumptionDate />) intentionally do
  // not match — an empty field and an absent one mean the same thing
  // here: no value.
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  if (!m) return null;
  const v = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
  return v || null;
}

// "08/07/2026" + "19:50:00.000" (ET) → ISO instant. Either half
// failing to parse fails the pair — a halt with a made-up time is
// worse than a skipped row.
function etStamp(dateRaw, timeRaw) {
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dateRaw || '').trim());
  const tm = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(String(timeRaw || '').trim());
  if (!dm || !tm) return null;
  return etToIso(
    Number(dm[3]),
    Number(dm[1]),
    Number(dm[2]),
    Number(tm[1]),
    Number(tm[2]),
    Number(tm[3]),
    Number((tm[4] || '0').padEnd(3, '0'))
  );
}

export function parseNasdaqFeed(xml) {
  const out = [];
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const symbol = tag(block, 'ndaq:IssueSymbol');
    const haltedAt = etStamp(tag(block, 'ndaq:HaltDate'), tag(block, 'ndaq:HaltTime'));
    if (!symbol || !haltedAt) continue;
    // The trade time is when the stock actually trades again; the
    // quote time only opens the quote-only window. Trade wins, quote
    // stands in when the feed carries only the window start.
    const resumptionAt =
      etStamp(tag(block, 'ndaq:ResumptionDate'), tag(block, 'ndaq:ResumptionTradeTime')) ||
      etStamp(tag(block, 'ndaq:ResumptionDate'), tag(block, 'ndaq:ResumptionQuoteTime'));
    const reasonCode = tag(block, 'ndaq:ReasonCode');
    out.push({
      symbol: symbol.toUpperCase(),
      name: tag(block, 'ndaq:IssueName'),
      exchange: tag(block, 'ndaq:Market'),
      haltedAt,
      reason: decodeReason(reasonCode) || 'Reason not available',
      reasonCode: reasonCode ? reasonCode.toUpperCase() : null,
      resumptionAt,
      source: 'nasdaq',
    });
  }
  return out;
}

// ── NYSE CSV parsing ─────────────────────────────────────────────────

// A real quoted-field CSV reader, not a comma split: issue names
// carry commas ("Tenon Medical, Inc.") and doubled quotes inside
// quoted cells.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

// "2026-08-07" + "16:00:00" (ET) → ISO instant.
function etStampIso(dateRaw, timeRaw) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateRaw || '').trim());
  const tm = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(timeRaw || '').trim());
  if (!dm || !tm) return null;
  return etToIso(Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2]), Number(tm[3]));
}

export function parseNyseCsv(csv) {
  const lines = String(csv || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Columns found by header name, never by position — a reordered or
  // widened export keeps working, a renamed one degrades to nothing
  // rather than to wrong data under right labels.
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const exact = headers.indexOf(n);
      if (exact !== -1) return exact;
    }
    for (const n of names) {
      const loose = headers.findIndex((h) => h.includes(n));
      if (loose !== -1) return loose;
    }
    return -1;
  };
  const cHaltDate = col('halt date');
  const cHaltTime = col('halt time');
  const cSymbol = col('symbol');
  const cName = col('name');
  const cExchange = col('exchange');
  const cReason = col('reason');
  const cResumeDate = col('resume date');
  const cResumeTime = col('nyse resume time', 'resume time');
  if (cHaltDate === -1 || cHaltTime === -1 || cSymbol === -1 || cReason === -1) return [];

  const out = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const symbol = String(cells[cSymbol] || '').toUpperCase().trim();
    const haltedAt = etStampIso(cells[cHaltDate], cells[cHaltTime]);
    if (!symbol || !haltedAt) continue;
    // The export doubles literal quotes inside quoted cells, which
    // leaves names like "Tenon Medical, Inc. Warrant" wearing a spare
    // pair after CSV decoding. Strip the wrapping, keep the words.
    const name = cName === -1 ? null : String(cells[cName] || '').replace(/^"+|"+$/g, '').trim() || null;
    out.push({
      symbol,
      name,
      exchange: cExchange === -1 ? null : cells[cExchange] || null,
      haltedAt,
      // NYSE publishes the English, not a code. The string is served
      // verbatim and reasonCode stays null — mapping their prose back
      // to Nasdaq's codes would be a guess (the live tape shows their
      // "LULD Pause" covering both LUDP and M), and the whole point
      // of this table is that nothing in it is guessed.
      reason: cells[cReason] || 'Reason not available',
      reasonCode: null,
      resumptionAt:
        cResumeDate === -1 || cResumeTime === -1
          ? null
          : etStampIso(cells[cResumeDate], cells[cResumeTime]),
      source: 'nyse',
    });
  }
  return out;
}

// ── Classification and merge ─────────────────────────────────────────

/**
 * Dedupe, classify and order parsed rows into the served list:
 * every still-active halt (however old — a stock halted for months is
 * exactly the thing to know about) plus anything that resumed today
 * ET, newest first. `resumed` is a statement about NOW: a scheduled
 * resumption still in the future is an active halt with a known
 * release time, not a resolved one.
 */
export function classifyHalts(rows, now = Date.now()) {
  const today = etDayKey(now);
  const seen = new Set();
  const out = [];
  // Nasdaq rows first so the coded row wins the cross-listing dedupe.
  const ordered = [...rows].sort((a, b) =>
    a.source === b.source ? 0 : a.source === 'nasdaq' ? -1 : 1
  );
  for (const r of ordered) {
    const haltMs = Date.parse(r.haltedAt);
    if (!Number.isFinite(haltMs)) continue;
    const resumeMs = r.resumptionAt ? Date.parse(r.resumptionAt) : NaN;
    const resumed = Number.isFinite(resumeMs) && resumeMs <= now;
    if (resumed && etDayKey(resumeMs) !== today) continue; // old news
    // Both wires report the same halt to the same second; symbol
    // conventions differ only in punctuation (BKSY.W vs "BKSY WS"),
    // which the alnum squeeze mostly reconciles. A convention pair it
    // misses shows as two rows — visible and true, versus a clever
    // normalization quietly merging two different instruments.
    const key = `${r.symbol.replace(/[^A-Z0-9]/g, '')}|${Math.floor(haltMs / 1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, resumed });
  }
  out.sort((a, b) => Date.parse(b.haltedAt) - Date.parse(a.haltedAt));
  return out;
}

// ── Fetch + cache ────────────────────────────────────────────────────

async function fetchText(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // Timeout, DNS, TLS — all one thing from here: the wire is down.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNasdaq() {
  const body = await fetchText(NASDAQ_URL, 'application/rss+xml, application/xml, text/xml, */*');
  return body == null ? null : parseNasdaqFeed(body);
}

async function fetchNyse() {
  const body = await fetchText(NYSE_URL, 'text/csv, text/plain, */*');
  return body == null ? null : parseNyseCsv(body);
}

let cache = { at: 0, payload: null };
// The last successful parse per source, so one wire dying degrades
// that wire to slightly-stale rather than blanking it — the same
// per-source posture /top-news takes with its feeds.
let lastGood = { nasdaq: null, nyse: null };
// When each wire last brought fresh rows. A wire down for a sustained
// stretch keeps serving its last snapshot, and a resumed halt that the
// snapshot still shows as active is a FALSE halt — so a member deserves
// to know the tape is stale, not "LIVE".
let lastGoodAt = { nasdaq: 0, nyse: 0 };

/**
 * The merged halt tape. Never throws and never returns null: the
 * worst case is an empty list with zeroed source counts, which the
 * panel renders as a quiet day plus a visible roll call.
 *
 * @param {object} deps - Injectable fetchers + clock, for tests.
 *   Injected calls bypass the module cache and lastGood entirely.
 * @returns {Promise<{halts: Array, fetchedAt: string, sources: {nasdaq: number, nyse: number}}>}
 */
export async function getHalts(deps = {}) {
  const injected = Boolean(deps.fetchNasdaq || deps.fetchNyse);
  const now = deps.now ?? Date.now();
  try {
    if (!injected && cache.payload && now - cache.at < CACHE_TTL_MS) {
      return cache.payload;
    }

    // A fetcher that throws counts as a dead wire, same as one that
    // returns null — injected test doubles included.
    const settle = (p) =>
      Promise.resolve()
        .then(p)
        .then((rows) => (Array.isArray(rows) ? rows : null))
        .catch(() => null);
    const [nasdaq, nyse] = await Promise.all([
      settle(deps.fetchNasdaq || fetchNasdaq),
      settle(deps.fetchNyse || fetchNyse),
    ]);

    let nasdaqRows = nasdaq;
    let nyseRows = nyse;
    if (!injected) {
      if (nasdaq) { lastGood.nasdaq = nasdaq; lastGoodAt.nasdaq = now; }
      else nasdaqRows = lastGood.nasdaq;
      if (nyse) { lastGood.nyse = nyse; lastGoodAt.nyse = now; }
      else nyseRows = lastGood.nyse;
    }
    nasdaqRows = nasdaqRows || [];
    nyseRows = nyseRows || [];

    const payload = {
      halts: classifyHalts([...nasdaqRows, ...nyseRows], now),
      fetchedAt: new Date(now).toISOString(),
      // Rows each wire brought to THIS payload — the roll call that
      // makes a dead wire visible in the terminal instead of months
      // later (the WSJ-freeze lesson). `live` is whether the wire
      // answered THIS cycle; `staleSeconds` ages a snapshot being
      // served from lastGood, so the panel can say a halt might have
      // resumed rather than badge it live.
      sources: {
        nasdaq: nasdaqRows.length,
        nyse: nyseRows.length,
        nasdaqLive: !injected ? !!nasdaq : true,
        nyseLive: !injected ? !!nyse : true,
        nasdaqStaleSeconds:
          !injected && !nasdaq && lastGoodAt.nasdaq
            ? Math.round((now - lastGoodAt.nasdaq) / 1000)
            : null,
        nyseStaleSeconds:
          !injected && !nyse && lastGoodAt.nyse
            ? Math.round((now - lastGoodAt.nyse) / 1000)
            : null,
      },
    };

    if (!injected) {
      // A degraded fetch is cached briefly, a clean one for the full
      // TTL — never a failure under a success's TTL.
      const failed = !nasdaq || !nyse;
      cache = { at: failed ? now - (CACHE_TTL_MS - FAILURE_RETRY_MS) : now, payload };
    }
    return payload;
  } catch {
    // Belt and braces: nothing above should reach here, but a halts
    // endpoint that 500s during a market-wide circuit breaker would
    // be failing at the exact moment it exists for.
    return { halts: [], fetchedAt: new Date(now).toISOString(), sources: { nasdaq: 0, nyse: 0 } };
  }
}
