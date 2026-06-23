import prisma from '../db.js';
import { readSheetPortfolio } from './sheetPortfolio.js';

// The one-time (idempotent) import of the live sheet into the database — the
// cutover's data step, shared by the CLI backfill and the in-app "Import from
// sheet" button so both behave identically. Reads the sheet DIRECTLY (never
// the DB, even under PORTFOLIO_SOURCE=db), writes the held positions + their
// opening lots + the opening cash, then reconciles to the dollar. The whole
// commit is one transaction, so a reconciliation failure rolls the import back
// rather than leaving a half-written book.
//
// commit=false returns just the plan (what it would write + the sheet totals),
// for a dry run.

export class PortfolioImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortfolioImportError';
  }
}

export async function importFromSheet({ commit = false, db = prisma } = {}) {
  // Read the sheet straight, bypassing the cutover dispatcher so this works
  // even once PORTFOLIO_SOURCE=db, and without mutating global env (which would
  // race concurrent requests on the server).
  const { holdings, totals } = await readSheetPortfolio({ forceFresh: true });

  const positions = [];
  const skipped = [];
  let cashRowSeen = false;
  for (const h of holdings) {
    if (h.isCash) {
      cashRowSeen = true;
      continue;
    }
    if (!h.ticker || h.ticker === 'CASH' || h.shares == null || h.costBasis == null) {
      skipped.push({ ticker: h.ticker || h.name || '?', shares: h.shares, costBasis: h.costBasis });
      continue;
    }
    positions.push(h);
  }
  const openingCash = totals?.cashValue ?? 0;
  const totalCost = positions.reduce((s, h) => s + h.shares * h.costBasis, 0);

  const plan = {
    positions: positions.map((h) => ({
      ticker: h.ticker,
      shares: h.shares,
      costBasis: h.costBasis,
      name: h.name || null,
      sector: h.sector || null,
    })),
    skipped,
    openingCash,
    totalCost,
    cashRowSeen,
  };

  if (!commit) return { committed: false, ...plan };

  // Dropping a held position silently loses AUM — refuse a partial import.
  if (skipped.length) {
    throw new PortfolioImportError(
      `${skipped.length} position(s) on the sheet are missing ticker/shares/cost basis — complete them on the sheet and retry.`
    );
  }

  const result = await db.$transaction(
    async (tx) => {
      let upserted = 0;
      let lotsSeeded = 0;
      for (const h of positions) {
        await tx.holding.upsert({
          where: { ticker: h.ticker },
          // Re-run safety: never overwrite shares/costBasis once trades have
          // settled. Only metadata is refreshed on an existing row.
          update: { name: h.name || null, sector: h.sector || null, isCash: false },
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
        const lotCount = await tx.holdingLot.count({ where: { ticker: h.ticker } });
        if (lotCount === 0) {
          await tx.holdingLot.create({
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

      // Opening cash only into an empty ledger — never stack a second opening
      // row on top of real trade history.
      const txCount = await tx.transaction.count();
      let cashSeeded = false;
      if (txCount === 0 && openingCash) {
        await tx.transaction.create({
          data: {
            kind: 'Opening',
            cashDelta: openingCash,
            note: 'opening cash balance (sheet import)',
            executedByName: 'system (import)',
          },
        });
        cashSeeded = true;
      }

      // Reconcile the written book against the sheet, in the same transaction —
      // a mismatch throws and rolls everything back.
      const dbHoldings = await tx.holding.findMany({ where: { closedAt: null, isCash: false } });
      const dbCost = dbHoldings.reduce((s, h) => s + h.shares * h.costBasis, 0);
      const dbCashAgg = await tx.transaction.aggregate({ _sum: { cashDelta: true } });
      const dbCash = dbCashAgg._sum.cashDelta ?? 0;
      const reconciliation = {
        positions: { db: dbHoldings.length, sheet: positions.length },
        cost: { db: dbCost, sheet: totalCost, diff: Math.abs(dbCost - totalCost) },
        cash: { db: dbCash, sheet: openingCash, diff: Math.abs(dbCash - openingCash) },
      };
      const ok =
        dbHoldings.length === positions.length &&
        reconciliation.cost.diff <= 1 &&
        reconciliation.cash.diff <= 1;
      if (!ok) {
        throw new PortfolioImportError(
          `Reconciliation failed — DB book doesn't match the sheet ` +
            `(positions ${dbHoldings.length}/${positions.length}, ` +
            `cost Δ $${reconciliation.cost.diff.toFixed(2)}, cash Δ $${reconciliation.cash.diff.toFixed(2)}). ` +
            `Nothing was written.`
        );
      }

      return { upserted, lotsSeeded, cashSeeded, reconciliation };
    },
    { timeout: 20000 }
  );

  return { committed: true, ...result, ...plan };
}
