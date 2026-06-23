#!/usr/bin/env node
// One-time import of the live Google Sheet portfolio into the database — the
// cutover's data step. Dry-run by default (prints the plan + sheet totals);
// writes only with --commit, then reconciles to the dollar and aborts on any
// mismatch. The same logic backs the in-app "Import from sheet" button
// (services/portfolioImport.js), so the CLI and the UI behave identically.
//
// Run from the server directory so dotenv picks up server/.env:
//   cd server && node scripts/backfillPortfolio.js            # dry run
//   cd server && node scripts/backfillPortfolio.js --commit   # write

import 'dotenv/config';
import prisma from '../src/db.js';
import { importFromSheet, PortfolioImportError } from '../src/services/portfolioImport.js';

const COMMIT = process.argv.includes('--commit');

function usd(n) {
  return n == null
    ? '—'
    : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

try {
  const report = await importFromSheet({ commit: COMMIT });

  console.error(`\nGriffin Fund portfolio backfill ${COMMIT ? '(COMMIT)' : '(dry run)'}\n`);
  console.error(`Positions to import: ${report.positions.length}`);
  for (const p of report.positions) {
    console.error(
      `  ${p.ticker.padEnd(6)} ${String(p.shares).padStart(8)} sh @ ${usd(p.costBasis).padStart(12)} cost`
    );
  }
  console.error(`\nOpening cash (Transaction seed): ${usd(report.openingCash)}`);
  console.error(`Total cost basis of positions:   ${usd(report.totalCost)}`);

  if (report.skipped.length) {
    console.error(`\nSkipped ${report.skipped.length} row(s) missing ticker/shares/costBasis:`);
    for (const s of report.skipped) {
      console.error(`  ${String(s.ticker).padEnd(8)} shares=${s.shares} costBasis=${s.costBasis}`);
    }
  }

  if (!report.committed) {
    console.error('\nDry run — nothing written. Re-run with --commit to import.');
  } else {
    const r = report.reconciliation;
    console.error(
      `\nDone. Upserted ${report.upserted} holding(s), seeded ${report.lotsSeeded} opening lot(s), ` +
        `${report.cashSeeded ? `opening cash ${usd(report.openingCash)}` : 'cash ledger already populated — left untouched'}.`
    );
    console.error(
      `\nReconciliation OK:\n` +
        `  positions   ${r.positions.db} in DB vs ${r.positions.sheet} from sheet\n` +
        `  cost basis  ${usd(r.cost.db)} in DB vs ${usd(r.cost.sheet)} sheet (Δ ${usd(r.cost.diff)})\n` +
        `  cash        ${usd(r.cash.db)} in DB vs ${usd(r.cash.sheet)} sheet (Δ ${usd(r.cash.diff)})`
    );
  }
} catch (err) {
  console.error(
    err instanceof PortfolioImportError ? `\nIMPORT ABORTED: ${err.message}` : `\nImport failed: ${err.message}`
  );
  await prisma.$disconnect();
  process.exit(1);
}

await prisma.$disconnect();
