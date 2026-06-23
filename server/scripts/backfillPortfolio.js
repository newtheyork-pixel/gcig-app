#!/usr/bin/env node
// One-time import of the live Google Sheet portfolio into the database, the
// cutover step that makes the DB the source of truth for holdings and cash.
// For each non-cash row on the sheet it upserts a Holding (ticker, name,
// sector, shares, blended costBasis) and seeds one opening HoldingLot at that
// cost so the first future sell has a lot to relieve. The sheet's cash sleeve
// becomes a single "Opening" Transaction, after which the spendable cash is the
// running sum of the ledger.
//
// Safe to re-run: holdings upsert by ticker, the opening lot is only created
// when a ticker has no lots yet, and the opening-cash row is only written when
// the ledger is completely empty. Dry-run by default — it prints exactly what
// it would write and a reconciliation against the sheet — and only touches the
// database with --commit.
//
// Run from the server directory so dotenv picks up server/.env:
//   cd server && node scripts/backfillPortfolio.js            # dry run
//   cd server && node scripts/backfillPortfolio.js --commit   # write

import 'dotenv/config';
import prisma from '../src/db.js';
import { getSheetPortfolio } from '../src/services/sheetPortfolio.js';

const COMMIT = process.argv.includes('--commit');

function usd(n) {
  return n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Always read the SHEET here, even if the deployment has already flipped
// PORTFOLIO_SOURCE=db — otherwise getSheetPortfolio would dispatch to the
// (still empty, pre-import) DB and we would import nothing. Copying the sheet
// into the DB is this script's entire job.
process.env.PORTFOLIO_SOURCE = 'sheet';

const { holdings, totals } = await getSheetPortfolio({ forceFresh: true });

// Split the sheet rows into real positions and the cash sleeve. A position
// needs a ticker, a share count, and a cost basis; anything missing is flagged
// rather than silently imported as a zero.
const positions = [];
const skipped = [];
let cashRowSeen = false;

for (const h of holdings) {
  if (h.isCash) {
    cashRowSeen = true;
    continue;
  }
  if (!h.ticker || h.ticker === 'CASH' || h.shares == null || h.costBasis == null) {
    skipped.push(h);
    continue;
  }
  positions.push(h);
}

// Cash is the sheet's own total — it already sums every cash sleeve into one
// figure. If neither a cash row nor a sheet total turns up, the opening balance
// would silently be $0, so say so loudly.
const openingCash = totals?.cashValue ?? 0;
if (!cashRowSeen && !openingCash) {
  console.error(
    'WARNING: no cash row detected and the sheet reports $0 cash — the opening ' +
      'balance may be wrong. Verify the sheet before --commit.'
  );
}

console.error(`\nGriffin Fund portfolio backfill ${COMMIT ? '(COMMIT)' : '(dry run)'}`);
console.error(`Sheet read at ${new Date().toISOString()}\n`);

console.error(`Positions to import: ${positions.length}`);
let totalCost = 0;
let totalSheetValue = 0;
for (const h of positions) {
  totalCost += h.shares * h.costBasis;
  totalSheetValue += h.marketValue != null ? h.marketValue : h.shares * (h.price || 0);
  console.error(
    `  ${h.ticker.padEnd(6)} ${String(h.shares).padStart(8)} sh @ ${usd(h.costBasis).padStart(12)} ` +
      `cost  | sheet mkt ${usd(h.marketValue)}`
  );
}

console.error(`\nOpening cash (Transaction seed): ${usd(openingCash)}`);
console.error(`Total cost basis of positions:   ${usd(totalCost)}`);
console.error(`Total sheet market value:        ${usd(totalSheetValue)}`);
console.error(`Total incl. cash (sheet):        ${usd(totals?.totalValue)}`);

if (skipped.length) {
  console.error(`\nSkipped ${skipped.length} row(s) missing ticker/shares/costBasis:`);
  for (const h of skipped) {
    console.error(`  ${(h.ticker || h.name || '?').padEnd(8)} shares=${h.shares} costBasis=${h.costBasis}`);
  }
}

if (!COMMIT) {
  console.error('\nDry run — nothing written. Re-run with --commit to import.');
  await prisma.$disconnect();
  process.exit(0);
}

// Dropping a held position silently loses AUM. Refuse to import a partial book —
// complete every position on the sheet (ticker, shares, cost basis) and re-run.
if (skipped.length) {
  console.error(
    `\nABORTING --commit: ${skipped.length} position(s) are missing ticker/shares/costBasis ` +
      `(listed above). Complete them on the sheet, then re-run.`
  );
  await prisma.$disconnect();
  process.exit(1);
}

// --- Write path -----------------------------------------------------------

let upserted = 0;
let lotsSeeded = 0;

for (const h of positions) {
  await prisma.holding.upsert({
    where: { ticker: h.ticker },
    update: {
      // Re-run safety: never overwrite shares/costBasis here. Once any trade
      // has settled, the lots are authoritative and a fresh sheet read would
      // clobber them. Only metadata is refreshed; to re-import a position from
      // scratch, delete it first.
      name: h.name || null,
      sector: h.sector || null,
      isCash: false,
    },
    create: {
      ticker: h.ticker,
      name: h.name || null,
      sector: h.sector || null,
      shares: h.shares,
      costBasis: h.costBasis,
      isCash: false,
    },
  });
  upserted += 1;

  // Seed a single opening lot only when the ticker has none — so re-running
  // never duplicates lots, and a hand-entered lot history is left alone.
  const existingLots = await prisma.holdingLot.count({ where: { ticker: h.ticker } });
  if (existingLots === 0) {
    await prisma.holdingLot.create({
      data: {
        ticker: h.ticker,
        shares: h.shares,
        pricePerShare: h.costBasis,
        buyDate: new Date(),
        note: 'opening balance (sheet import)',
      },
    });
    lotsSeeded += 1;
  }
}

// Seed opening cash only into an empty ledger — never stack a second opening
// row on top of real trade history.
const txCount = await prisma.transaction.count();
let cashSeeded = false;
if (txCount === 0 && openingCash) {
  await prisma.transaction.create({
    data: {
      kind: 'Opening',
      cashDelta: openingCash,
      note: 'opening cash balance (sheet import)',
      executedByName: 'system (backfill)',
    },
  });
  cashSeeded = true;
}

console.error(
  `\nDone. Upserted ${upserted} holding(s), seeded ${lotsSeeded} opening lot(s), ` +
    `${cashSeeded ? `opening cash ${usd(openingCash)}` : 'cash ledger already populated — left untouched'}.`
);

// Read the book back and assert it matches the sheet to the dollar. A silent
// drift means a position was dropped or mis-imported — fail loudly so we never
// cut over onto a wrong book. (Re-running after trades have settled will trip
// this, which is correct: the sheet no longer reflects reality at that point.)
const dbHoldings = await prisma.holding.findMany({ where: { closedAt: null, isCash: false } });
const dbCost = dbHoldings.reduce((s, h) => s + h.shares * h.costBasis, 0);
const dbCashAgg = await prisma.transaction.aggregate({ _sum: { cashDelta: true } });
const dbCash = dbCashAgg._sum.cashDelta ?? 0;
const costDiff = Math.abs(dbCost - totalCost);
const cashDiff = Math.abs(dbCash - openingCash);
console.error(
  `\nReconciliation:\n` +
    `  positions   ${dbHoldings.length} in DB vs ${positions.length} from sheet\n` +
    `  cost basis  ${usd(dbCost)} in DB vs ${usd(totalCost)} sheet (Δ ${usd(costDiff)})\n` +
    `  cash        ${usd(dbCash)} in DB vs ${usd(openingCash)} sheet (Δ ${usd(cashDiff)})`
);
if (dbHoldings.length !== positions.length || costDiff > 1 || cashDiff > 1) {
  console.error(
    '\nRECONCILIATION FAILED — the DB book does not match the sheet. ' +
      'Investigate before flipping PORTFOLIO_SOURCE=db.'
  );
  await prisma.$disconnect();
  process.exit(1);
}
console.error('Reconciliation OK — DB book matches the sheet.');

await prisma.$disconnect();
