import prisma from '../db.js';

// Settlement: turning an approved trade into facts in the book. When an exec
// marks a signed TradeRequest as filled, this writes the real position +
// cash movements the broker just executed. The Holding table holds the current
// position; HoldingLot holds the open lots (FIFO-relieved on a sell); the
// Transaction ledger is the immutable record of every buy, sell, and cash move,
// and the cash balance is the running sum of it. Nothing here trusts the
// quote-at-send — the exec passes the actual fill price/qty.
//
// Cost basis: lots are authoritative. A buy appends a lot; a sell relieves the
// oldest lots first (FIFO) and books realized P/L against the lots it consumed.
// The Holding's shares + blended costBasis are recomputed from the open lots
// after every change, so they can never drift from the lot history.

// A typed error so the route can map it to the right HTTP status instead of a
// blanket 500.
export class TradeExecutionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TradeExecutionError';
    this.status = status;
  }
}

// One process-wide advisory lock for the whole book. Every settlement grabs it
// as the first statement in its transaction, so concurrent trades can't both
// read a stale cash/lot state and then double-book proceeds or overdraw cash.
// pg_advisory_xact_lock auto-releases at commit/rollback. Trades are
// low-frequency admin actions, so serializing them globally costs nothing.
const BOOK_LOCK_KEY = 728193;

async function lockBook(tx) {
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns Postgres `void`,
  // and $queryRaw tries to deserialize that result column and dies with P2010
  // ("Failed to deserialize column of type 'void'"). $executeRaw runs the
  // statement as a command and never maps a result set, which is all we want —
  // the lock is a side effect, not a value.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOK_LOCK_KEY})`;
}

// Spendable cash = the running sum of every ledger movement. No stored balance.
// Accepts a tx client so it can read a consistent value inside a settlement.
export async function getCashBalance(client = prisma) {
  const agg = await client.transaction.aggregate({ _sum: { cashDelta: true } });
  return agg._sum.cashDelta ?? 0;
}

// Fold the open lots back into the Holding's authoritative shares + blended
// cost. Creates the Holding row on first buy of a new name. A position with no
// remaining shares is soft-closed (closedAt set, row kept for history); buying
// back in clears it. `meta` carries name/sector for a freshly created row.
export async function recomputeHoldingFromLots(client, ticker, meta = {}) {
  const t = String(ticker).toUpperCase();
  const lots = await client.holdingLot.findMany({ where: { ticker: t } });
  const shares = lots.reduce((s, l) => s + l.shares, 0);
  const costSum = lots.reduce((s, l) => s + l.shares * l.pricePerShare, 0);
  const costBasis = shares > 0 ? costSum / shares : 0;

  const existing = await client.holding.findUnique({ where: { ticker: t } });
  if (existing) {
    return client.holding.update({
      where: { ticker: t },
      data: {
        shares,
        costBasis,
        closedAt: shares <= 0 ? existing.closedAt ?? new Date() : null,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
        ...(meta.sector !== undefined ? { sector: meta.sector } : {}),
      },
    });
  }
  return client.holding.create({
    data: {
      ticker: t,
      name: meta.name ?? t,
      sector: meta.sector ?? null,
      shares,
      costBasis,
      isCash: false,
      closedAt: shares <= 0 ? new Date() : null,
    },
  });
}

// Append a buy lot and refold the Holding. Returns the cash outflow.
async function applyBuy(tx, { ticker, shares, price, note, meta, buyDate }) {
  await tx.holdingLot.create({
    data: {
      ticker: String(ticker).toUpperCase(),
      shares,
      pricePerShare: price,
      buyDate: buyDate || new Date(),
      note: note || null,
    },
  });
  await recomputeHoldingFromLots(tx, ticker, meta || {});
  return shares * price;
}

// Pure FIFO relief: given the open lots oldest-first, a sell quantity, and a
// fill price, return the realized P/L and which lots to delete/shrink — plus
// any quantity the lots couldn't cover. No DB, so the tricky money math is
// unit-tested in isolation (tradeExecution.test.js).
export function relieveLotsFifo(lots, shares, price) {
  let remaining = shares;
  let realizedPnl = 0;
  const deletes = [];
  const updates = [];
  for (const lot of lots) {
    if (remaining <= 1e-9) break;
    const take = Math.min(lot.shares, remaining);
    realizedPnl += (price - lot.pricePerShare) * take;
    remaining -= take;
    const left = lot.shares - take;
    if (left <= 1e-9) deletes.push(lot.id);
    else updates.push({ id: lot.id, shares: left });
  }
  return { realizedPnl, deletes, updates, remaining };
}

// Relieve the oldest lots FIFO for a sale, booking realized P/L against the
// lots consumed, then refold the Holding. Returns { proceeds, realizedPnl }.
async function applySell(tx, { ticker, shares, price }) {
  const t = String(ticker).toUpperCase();
  const holding = await tx.holding.findUnique({ where: { ticker: t } });
  if (!holding || holding.closedAt || holding.shares <= 0) {
    throw new TradeExecutionError(`Can't sell ${t} — no open position`, 409);
  }
  if (shares > holding.shares + 1e-9) {
    throw new TradeExecutionError(
      `Can't sell ${shares} ${t} — only ${holding.shares} held`,
      400
    );
  }

  const lots = await tx.holdingLot.findMany({
    where: { ticker: t },
    orderBy: [{ buyDate: 'asc' }, { id: 'asc' }],
  });

  const { realizedPnl, deletes, updates, remaining } = relieveLotsFifo(lots, shares, price);
  if (remaining > 1e-6) {
    // Lots didn't cover the sale even though the Holding said they should —
    // the lot ledger and the position have drifted. Refuse rather than book a
    // half-relieved sell.
    throw new TradeExecutionError(
      `Lot history for ${t} is short of its ${holding.shares}-share position; fix the lots before selling`,
      409
    );
  }
  for (const lotId of deletes) {
    await tx.holdingLot.delete({ where: { id: lotId } });
  }
  for (const u of updates) {
    await tx.holdingLot.update({ where: { id: u.id }, data: { shares: u.shares } });
  }

  await recomputeHoldingFromLots(tx, t);
  return { proceeds: shares * price, realizedPnl };
}

// Execute a signed TradeRequest: write the fills as positions + cash movements.
// `fills` is an optional array of { itemId, shares?, pricePerShare? } overrides
// — anything omitted defaults to the item's recorded shares/price (the
// quote-at-send), so a straight confirm needs no fills at all. Idempotent: a
// request that already has ledger rows is refused. Whole thing is one
// transaction, so a mid-settlement failure leaves the book untouched.
export async function executeTradeRequest({ tradeRequestId, fills = [], actorName = null, db = prisma }) {
  const id = Number(tradeRequestId);
  if (!Number.isFinite(id)) throw new TradeExecutionError('Invalid trade request id', 400);

  const fillById = new Map();
  for (const f of Array.isArray(fills) ? fills : []) {
    if (f && f.itemId != null) fillById.set(Number(f.itemId), f);
  }

  // db is injectable so the settlement orchestration can be exercised against
  // an in-memory fake (tradeExecution.integration.test.js) without a real
  // Postgres; production always passes the real prisma client.
  return db.$transaction(async (tx) => {
    await lockBook(tx);
    // Lock the request row for the life of the transaction so two concurrent
    // /execute calls can't both clear the idempotency check below and settle
    // the same trade twice (doubling lots, cash, and realized P/L). The second
    // caller blocks here until the first commits, then sees executedAt set.
    await tx.$queryRaw`SELECT id FROM "TradeRequest" WHERE id = ${id} FOR UPDATE`;
    const tr = await tx.tradeRequest.findUnique({ where: { id }, include: { items: true } });
    if (!tr) throw new TradeExecutionError('Trade request not found', 404);
    if (tr.executedAt) {
      throw new TradeExecutionError('This trade request was already marked filled', 409);
    }
    const already = await tx.transaction.count({ where: { tradeRequestId: id } });
    if (already > 0) {
      throw new TradeExecutionError('This trade request already has ledger entries', 409);
    }
    if (!tr.items.length) throw new TradeExecutionError('Trade request has no line items', 400);

    // Resolve each line to its actual fill, defaulting to what was sent.
    const lines = tr.items.map((it) => {
      const f = fillById.get(it.id) || {};
      const shares = f.shares != null ? Number(f.shares) : it.shares;
      const price = f.pricePerShare != null ? Number(f.pricePerShare) : it.pricePerShare;
      // Whole shares only — the signed TradeRequestItem is an Int, and the
      // brokerage fills in whole shares; a fractional fill from a direct API
      // caller would desync the lot ledger from the envelope.
      if (!Number.isInteger(shares) || shares <= 0) {
        throw new TradeExecutionError(`Fill shares for ${it.ticker} must be a whole number`, 400);
      }
      if (!Number.isFinite(price) || price <= 0) {
        throw new TradeExecutionError(`Invalid fill price for ${it.ticker}`, 400);
      }
      return { kind: it.kind, ticker: String(it.ticker).toUpperCase(), shares, price, votingSessionId: it.votingSessionId };
    });

    // Buying-power: the net of this basket can't drive cash negative. Sells add
    // cash, buys spend it; we check the net so a sell-to-cover funds its buys.
    const buyTotal = lines.filter((l) => l.kind === 'Buy').reduce((s, l) => s + l.shares * l.price, 0);
    const sellTotal = lines.filter((l) => l.kind === 'Sell').reduce((s, l) => s + l.shares * l.price, 0);
    const cashBefore = await getCashBalance(tx);
    if (cashBefore + sellTotal - buyTotal < -1e-6) {
      throw new TradeExecutionError(
        `Insufficient cash: this basket needs $${(buyTotal - sellTotal).toFixed(2)} but only $${cashBefore.toFixed(2)} is available`,
        400
      );
    }

    const executedAt = new Date();
    const transactions = [];

    // Sells first so freed cash is on hand before the buys draw on it.
    for (const l of lines.filter((x) => x.kind === 'Sell')) {
      const { proceeds, realizedPnl } = await applySell(tx, l);
      transactions.push(
        await tx.transaction.create({
          data: {
            kind: 'Sell',
            ticker: l.ticker,
            shares: l.shares,
            pricePerShare: l.price,
            cashDelta: proceeds,
            realizedPnl,
            tradeRequestId: id,
            votingSessionId: l.votingSessionId ?? null,
            executedByName: actorName,
            executedAt,
          },
        })
      );
    }
    for (const l of lines.filter((x) => x.kind === 'Buy')) {
      const cost = await applyBuy(tx, { ticker: l.ticker, shares: l.shares, price: l.price, note: `Buy via trade request #${id}` });
      transactions.push(
        await tx.transaction.create({
          data: {
            kind: 'Buy',
            ticker: l.ticker,
            shares: l.shares,
            pricePerShare: l.price,
            cashDelta: -cost,
            tradeRequestId: id,
            votingSessionId: l.votingSessionId ?? null,
            executedByName: actorName,
            executedAt,
          },
        })
      );
    }

    const updated = await tx.tradeRequest.update({
      where: { id },
      data: { executedAt, executedByName: actorName },
      include: {
        creator: { select: { id: true, name: true, role: true } },
        items: { orderBy: { id: 'asc' } },
      },
    });

    const cashAfter = await getCashBalance(tx);
    return { tradeRequest: updated, transactions, cashBefore, cashAfter };
  });
}

// A direct buy or sell on the portfolio, unattached to a vote or DocuSign
// envelope — the super admin trades the book straight from the portfolio page.
// Same settlement accounting as a filled TradeRequest (FIFO lots, realized P/L,
// derived cash, buying-power + over-sell guards), just without the governance
// pipeline. One transaction, so a guard trip leaves the book untouched.
export async function executeDirectTrade({
  side,
  ticker,
  shares,
  pricePerShare,
  buyDate = null,
  // A buy that moves no cash — a transfer-in / donation / correction where the
  // shares appeared without the fund spending. Off by default: a buy spends.
  noCash = false,
  name = null,
  sector = null,
  actorName = null,
  note = null,
  db = prisma,
}) {
  const t = String(ticker || '').trim().toUpperCase();
  const s = Number(shares);
  const p = Number(pricePerShare);
  if (side !== 'Buy' && side !== 'Sell') {
    throw new TradeExecutionError('side must be "Buy" or "Sell"', 400);
  }
  if (!/^[A-Z0-9.\-]{1,10}$/.test(t)) {
    throw new TradeExecutionError('Invalid ticker', 400);
  }
  if (!Number.isInteger(s) || s <= 0) {
    throw new TradeExecutionError('Shares must be a whole number', 400);
  }
  if (!Number.isFinite(p) || p <= 0) {
    throw new TradeExecutionError('Price per share must be positive', 400);
  }
  let lotDate = null;
  if (buyDate) {
    lotDate = new Date(buyDate);
    if (Number.isNaN(lotDate.getTime())) throw new TradeExecutionError('Invalid buy date', 400);
  }

  return db.$transaction(async (tx) => {
    await lockBook(tx);

    // Idempotency / double-submit guard: refuse an identical trade booked in
    // the last 15 seconds (a double-click or a network retry). A genuinely
    // intentional repeat can be re-entered after the window.
    const recent = await tx.transaction.findFirst({
      where: {
        kind: side,
        ticker: t,
        shares: s,
        pricePerShare: p,
        executedAt: { gte: new Date(Date.now() - 15000) },
      },
    });
    if (recent) {
      throw new TradeExecutionError(
        `An identical ${side} of ${s} ${t} @ $${p} was just recorded — if this is a second, intentional trade, try again in a moment.`,
        409
      );
    }

    const cashBefore = await getCashBalance(tx);

    if (side === 'Buy') {
      const cost = s * p;
      if (!noCash && cashBefore - cost < -1e-6) {
        throw new TradeExecutionError(
          `Insufficient cash: this buy needs $${cost.toFixed(2)} but only $${cashBefore.toFixed(2)} is available. Record a deposit first if needed.`,
          400
        );
      }
      await applyBuy(tx, {
        ticker: t,
        shares: s,
        price: p,
        note: note || (noCash ? 'transfer in' : 'direct buy'),
        meta: { name: name || undefined, sector: sector || undefined },
        buyDate: lotDate,
      });
      // A real buy spends cash; a transfer-in doesn't (the shares arrived
      // without the fund paying), so no ledger row in that case.
      const transaction = noCash
        ? null
        : await tx.transaction.create({
            data: { kind: 'Buy', ticker: t, shares: s, pricePerShare: p, cashDelta: -cost, note: note || null, executedByName: actorName },
          });
      return { transaction, cashBefore, cashAfter: await getCashBalance(tx) };
    }

    // Sell — applySell guards over-sell + lot/holding drift, returns proceeds + P/L.
    const { proceeds, realizedPnl } = await applySell(tx, { ticker: t, shares: s, price: p });
    const transaction = await tx.transaction.create({
      data: { kind: 'Sell', ticker: t, shares: s, pricePerShare: p, cashDelta: proceeds, realizedPnl, note: note || null, executedByName: actorName },
    });
    return { transaction, cashBefore, cashAfter: await getCashBalance(tx) };
  });
}

// Record a batch of buys/sells in one shot — a broker-statement import. All
// trades land in a single transaction (all-or-nothing: if any fails, none
// apply), and SELLS run before BUYS so the proceeds fund the buys regardless
// of the order they were pasted in. Each line is the same accounting as a
// single direct trade.
export async function executeBulkTrades({ trades, actorName = null, db = prisma }) {
  if (!Array.isArray(trades) || trades.length === 0) {
    throw new TradeExecutionError('No trades provided', 400);
  }
  if (trades.length > 200) {
    throw new TradeExecutionError('Too many trades in one batch (max 200)', 400);
  }
  const norm = trades.map((tr, i) => {
    const side = tr.side === 'Buy' || tr.side === 'Sell' ? tr.side : null;
    const ticker = String(tr.ticker || '').trim().toUpperCase();
    const shares = Number(tr.shares);
    const price = Number(tr.pricePerShare);
    const where = `Row ${i + 1}${ticker ? ` (${ticker})` : ''}`;
    if (!side) throw new TradeExecutionError(`${where}: side must be Buy or Sell`, 400);
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) throw new TradeExecutionError(`${where}: invalid ticker`, 400);
    if (!Number.isInteger(shares) || shares <= 0) throw new TradeExecutionError(`${where}: shares must be a whole number`, 400);
    if (!Number.isFinite(price) || price <= 0) throw new TradeExecutionError(`${where}: price must be positive`, 400);
    return { side, ticker, shares, price };
  });
  // Sells first so their proceeds are on hand before the buys draw cash.
  norm.sort((a, b) => (a.side === b.side ? 0 : a.side === 'Sell' ? -1 : 1));

  return db.$transaction(
    async (tx) => {
      await lockBook(tx);
      const results = [];
      for (const trade of norm) {
        if (trade.side === 'Buy') {
          const cost = trade.shares * trade.price;
          const cash = await getCashBalance(tx);
          if (cash - cost < -1e-6) {
            throw new TradeExecutionError(
              `${trade.ticker}: buy needs $${cost.toFixed(2)} but only $${cash.toFixed(2)} is available (after sells). Add a deposit or check the list.`,
              400
            );
          }
          await applyBuy(tx, { ticker: trade.ticker, shares: trade.shares, price: trade.price, note: 'bulk import' });
          await tx.transaction.create({
            data: { kind: 'Buy', ticker: trade.ticker, shares: trade.shares, pricePerShare: trade.price, cashDelta: -cost, note: 'bulk import', executedByName: actorName },
          });
          results.push({ ...trade, cashDelta: -cost });
        } else {
          const { proceeds, realizedPnl } = await applySell(tx, { ticker: trade.ticker, shares: trade.shares, price: trade.price });
          await tx.transaction.create({
            data: { kind: 'Sell', ticker: trade.ticker, shares: trade.shares, pricePerShare: trade.price, cashDelta: proceeds, realizedPnl, note: 'bulk import', executedByName: actorName },
          });
          results.push({ ...trade, cashDelta: proceeds, realizedPnl });
        }
      }
      const cashAfter = await getCashBalance(tx);
      const realizedPnl = results.reduce((s, r) => s + (r.realizedPnl || 0), 0);
      return { results, cashAfter, count: norm.length, realizedPnl };
    },
    { timeout: 30000 }
  );
}
