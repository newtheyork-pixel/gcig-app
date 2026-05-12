import prisma from '../db.js';
import { PDFParse } from 'pdf-parse';

// Source of truth: Goldman Sachs publishes a single PDF that gets
// overwritten daily with the current-day rate sheet for every share
// class of every GS money market fund. We only care about the
// Institutional class of the Government Fund (FGTXX), which is the
// sleeve the Griffin Fund actually holds, but the parser is generic
// enough to pull any row by ticker.
const PDF_URL =
  'https://www.gsam.com/content/dam/gsam/pdfs/us/en/fund-resources/daily-rate-sheet/DailyRates.pdf';

// Without an Accept: application/pdf header, GSAM's web layer serves
// an AEM HTML viewer wrapper instead of the actual PDF. With it, we
// get the raw bytes.
//
// KNOWN ISSUE — May 2026: this endpoint returns HTTP 403 when called
// from Render's egress IPs, even though the same request succeeds from
// a local laptop. GSAM is rate-limiting or geo/IP-filtering datacenter
// ranges. Until we find a workaround, the dashboard's "Refresh today's
// yield" button surfaces the 403 verbatim and falls back to the most
// recent stored yield. Fix candidates: proxy through an Akamai/CF
// worker, send a more browser-like header set, or scrape from a
// downstream mirror (Vanguard publishes a similar daily sheet that
// indexes GS yields). The SEC N-MFP3 backfill is unaffected — that's
// served directly by EDGAR with a generous UA policy.
async function downloadPdf() {
  const res = await fetch(PDF_URL, {
    headers: {
      Accept: 'application/pdf',
      // A realistic UA helps with the same edge — bare curl-style UAs
      // sometimes get the HTML wrapper as well.
      'User-Agent':
        'Mozilla/5.0 (compatible; GriffinFundBot/1.0; +https://thegriffinfund.org)',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`GSAM PDF returned HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.slice(0, 5).toString() !== '%PDF-') {
    throw new Error('GSAM endpoint returned non-PDF payload');
  }
  return buf;
}

// Each fund row on the PDF is a single line of the form
//   "<long fund name> [rating tags] <TICKER> <number> <Mon DD, YYYY>
//    1.00 0.000xxxxx 3.51 3.53 3.52 3.58 3.54 270,926.6"
// Numeric columns are space-separated. We anchor on the ticker (5 chars
// upper) and walk left/right from there to extract the date and the
// trailing numeric block.
const ROW_RE =
  /\b([A-Z]{4,5})\s+\d+\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+([0-9.]+)\s+([0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([0-9.,]+)/;

function parseRow(line) {
  const m = line.match(ROW_RE);
  if (!m) return null;
  const [
    ,
    ticker,
    dateStr,
    /* closingPrice */,
    dividendFactorStr,
    oneDayStr,
    sevenDayDistributionStr,
    sevenDayCurrentStr,
    sevenDayEffectiveStr,
    /* thirtyDay */,
    /* assets */,
  ] = m;

  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;
  // Normalize to UTC midnight so we always upsert one row per calendar
  // day regardless of the scraper's wall-clock time.
  const dateUtc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );

  const num = (s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  return {
    ticker,
    date: dateUtc,
    dividendFactor: num(dividendFactorStr),
    oneDayYield: num(oneDayStr),
    // We expose both the Distribution and Current 7-day yields; the
    // Current one is the SEC-standardized number most members will
    // recognize, so it's the one the calc keys off by default.
    sevenDayDistributionYield: num(sevenDayDistributionStr),
    sevenDayCurrentYield: num(sevenDayCurrentStr),
    sevenDayEffectiveYield: num(sevenDayEffectiveStr),
  };
}

// Parse the PDF and return the rate-sheet row for every ticker we care
// about. Most callers just want FGTXX, but the generic shape lets us
// add the bank-sweep ticker later if it ever shows up on the sheet.
async function parsePdf(buf) {
  const parser = new PDFParse({ data: buf });
  const { text } = await parser.getText();
  const lines = String(text || '').split(/\n/);

  // Order matters for the early-exit optimization: as soon as we find
  // each requested ticker, we can stop scanning. The Institutional row
  // for FGTXX is near the top of the sheet so the loop is short.
  const out = new Map();
  for (const line of lines) {
    const row = parseRow(line);
    if (row && !out.has(row.ticker)) {
      out.set(row.ticker, row);
    }
  }
  return out;
}

export async function scrapeAndStoreDailyRates(tickers = ['FGTXX']) {
  const buf = await downloadPdf();
  const byTicker = await parsePdf(buf);

  const stored = [];
  for (const ticker of tickers) {
    const row = byTicker.get(ticker);
    if (!row) {
      console.warn(`gsamRates: ticker ${ticker} not found on rate sheet`);
      continue;
    }
    const saved = await prisma.mmfYieldSnapshot.upsert({
      where: { ticker_date: { ticker: row.ticker, date: row.date } },
      create: {
        ticker: row.ticker,
        date: row.date,
        sevenDayCurrentYield: row.sevenDayCurrentYield,
        sevenDayEffectiveYield: row.sevenDayEffectiveYield,
        oneDayYield: row.oneDayYield,
        dividendFactor: row.dividendFactor,
      },
      update: {
        sevenDayCurrentYield: row.sevenDayCurrentYield,
        sevenDayEffectiveYield: row.sevenDayEffectiveYield,
        oneDayYield: row.oneDayYield,
        dividendFactor: row.dividendFactor,
      },
    });
    stored.push(saved);
  }
  return stored;
}

// Read-side helper used by the cash-interest service: most-recent stored
// snapshot for a ticker on or before the given date. Falls back to the
// most-recent overall row if nothing is stored on/before the target,
// which is the case for any historical date that pre-dates the scraper.
export async function findYieldOnOrBefore(ticker, date) {
  const onOrBefore = await prisma.mmfYieldSnapshot.findFirst({
    where: { ticker, date: { lte: date } },
    orderBy: { date: 'desc' },
  });
  if (onOrBefore) return onOrBefore;
  return prisma.mmfYieldSnapshot.findFirst({
    where: { ticker },
    orderBy: { date: 'desc' },
  });
}
