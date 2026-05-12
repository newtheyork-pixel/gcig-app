import prisma from '../db.js';
import { findYieldOnOrBefore } from './gsamRates.js';

// The two cash sleeves are simple constants — both were set up by hand
// at the start of the year, neither has changed, and the math depends
// on them being literal. If the club ever moves money into a different
// MMF or the bank rate changes, edit these and redeploy.
export const FGTXX_TICKER = 'FGTXX';
export const FGTXX_PRINCIPAL = 40_000;
// Oct 17, 2025 — the day the $40k seed was transferred into FGTXX. Days
// before this date attribute all cash to the Bank USA deposit sleeve.
export const FGTXX_START_DATE = new Date(Date.UTC(2025, 9, 17));
// Bank USA deposit pays a flat 3% APY simple-interest sweep rate.
export const BANK_APY = 0.03;
// Fallback annual yield if we somehow have no scraped FGTXX yield rows
// at all (cold-start case before the daily scrape runs even once).
const FGTXX_FALLBACK_APY = 0.035;

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Split a day's combined cashValue into the FGTXX sleeve and the Bank
// USA deposit sleeve. Model: pre-Oct-17 everything is in the bank; from
// Oct-17 onward FGTXX holds up to its $40k seed, the bank holds the
// rest, and once the bank is drained (e.g. a stock buy emptied it),
// further outflows pull from FGTXX so its balance walks down with the
// total cash.
export function splitCashSleeves(date, totalCash) {
  const day = startOfUtcDay(date);
  if (day < FGTXX_START_DATE) {
    return { fgtxx: 0, bank: Math.max(0, totalCash) };
  }
  if (totalCash >= FGTXX_PRINCIPAL) {
    return { fgtxx: FGTXX_PRINCIPAL, bank: totalCash - FGTXX_PRINCIPAL };
  }
  return { fgtxx: Math.max(0, totalCash), bank: 0 };
}

// Compute YTD interest earned on the club's cash position, broken out
// by sleeve. We replay each PortfolioSnapshot in order, splitting its
// cashValue into the two sleeves and accruing one calendar day of
// interest at that day's prevailing yield. Days where the snapshot is
// missing simply don't accrue — we don't try to interpolate.
export async function computeCashInterest({ from, to } = {}) {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: {
      ...(from ? { date: { gte: from } } : {}),
      ...(to ? { date: { lte: to } } : {}),
    },
    orderBy: { date: 'asc' },
    select: { date: true, totalValue: true, cashValue: true },
  });

  if (snapshots.length === 0) {
    return {
      ytdFgtxxInterest: 0,
      ytdBankInterest: 0,
      ytdTotalInterest: 0,
      daysCounted: 0,
      currentFgtxxBalance: 0,
      currentBankBalance: 0,
      latestFgtxxYield: null,
      asOf: null,
      series: [],
    };
  }

  // Pre-fetch all stored FGTXX yields once, then look up by binary
  // search rather than hitting the DB once per snapshot. Most years
  // this is a few hundred rows so it's free.
  const yieldRows = await prisma.mmfYieldSnapshot.findMany({
    where: { ticker: FGTXX_TICKER },
    orderBy: { date: 'asc' },
    select: { date: true, sevenDayCurrentYield: true, dividendFactor: true },
  });

  function yieldForDate(date) {
    if (yieldRows.length === 0) return { apy: FGTXX_FALLBACK_APY, source: 'fallback' };
    // Find the latest row whose date <= target date.
    let lo = 0;
    let hi = yieldRows.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (yieldRows[mid].date <= date) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // No row on/before this date — use the earliest row we have as a
    // backward-fill. This is the "scraper only started today" case
    // applied to historical days.
    const row = best === -1 ? yieldRows[0] : yieldRows[best];
    const apy =
      typeof row.sevenDayCurrentYield === 'number'
        ? row.sevenDayCurrentYield / 100
        : typeof row.dividendFactor === 'number'
        ? row.dividendFactor * 365
        : FGTXX_FALLBACK_APY;
    return { apy, source: best === -1 ? 'backward-fill' : 'observed' };
  }

  let ytdFgtxxInterest = 0;
  let ytdBankInterest = 0;
  let daysCounted = 0;
  let lastFgtxx = 0;
  let lastBank = 0;
  let lastDate = null;
  const series = [];

  // Each snapshot represents "the cash position at end of day D". We
  // accrue one day of interest per snapshot. This loses precision on
  // days where no snapshot was recorded (gaps), which is the right
  // behavior — we'd rather under-state earnings than fabricate them.
  for (const s of snapshots) {
    const cash = typeof s.cashValue === 'number' ? s.cashValue : 0;
    const { fgtxx, bank } = splitCashSleeves(s.date, cash);
    const { apy } = yieldForDate(s.date);

    const fgtxxDay = (fgtxx * apy) / 365;
    const bankDay = (bank * BANK_APY) / 365;

    ytdFgtxxInterest += fgtxxDay;
    ytdBankInterest += bankDay;
    daysCounted += 1;

    lastFgtxx = fgtxx;
    lastBank = bank;
    lastDate = s.date;

    series.push({
      date: s.date,
      cash,
      fgtxxBalance: fgtxx,
      bankBalance: bank,
      fgtxxYieldApy: apy,
      fgtxxInterest: fgtxxDay,
      bankInterest: bankDay,
    });
  }

  const latestRow = yieldRows[yieldRows.length - 1] || null;

  return {
    ytdFgtxxInterest,
    ytdBankInterest,
    ytdTotalInterest: ytdFgtxxInterest + ytdBankInterest,
    daysCounted,
    currentFgtxxBalance: lastFgtxx,
    currentBankBalance: lastBank,
    latestFgtxxYield: latestRow?.sevenDayCurrentYield ?? null,
    latestFgtxxYieldDate: latestRow?.date ?? null,
    asOf: lastDate,
    bankApy: BANK_APY,
    fgtxxStartDate: FGTXX_START_DATE,
    fgtxxPrincipal: FGTXX_PRINCIPAL,
    series,
  };
}
