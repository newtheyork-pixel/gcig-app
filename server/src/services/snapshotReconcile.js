// Correcting the historical value chart after a trade set was recorded late.
//
// PortfolioSnapshot rows are frozen daily captures of the book's total value
// (and cash). When a basket of trades really executed on some past date but
// wasn't recorded until later, every snapshot from the execution date onward
// was captured against the OLD book — it still counts the shares we'd sold and
// misses the ones we'd bought. This recomputes each of those days.
//
// The correction is a per-day delta valued at that day's close, not a flat
// offset: the sold basket and the bought basket drift apart as prices move, so
// the error grows across the window.
//
//   corrected_total(day) = old_total(day)
//                        + Σ boughtShares · close(day)   (positions we gained)
//                        − Σ soldShares  · close(day)    (positions we shed)
//                        + netCashDelta                  (cash the swap freed)
//   corrected_cash(day)  = old_cash(day) + netCashDelta
//
// netCashDelta is the ACTUAL cash the trades moved — the broker's net amounts
// (fees included), sells' proceeds minus buys' cost. On the execution day the
// delta collapses to roughly minus the fees, which is exactly right: a
// cash-for-stock swap is value-neutral apart from what the broker skimmed.

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function toIso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

// Build a closeFor(ticker, isoDate) over a { ticker -> [{date, close}] } map of
// ascending daily bars. Returns the latest close at or before the date, so a
// weekend/holiday snapshot resolves to the prior trading day. Null when we have
// no bar on or before the date — the caller surfaces that rather than zeroing.
export function makeCloseLookup(barsByTicker) {
  return (ticker, iso) => {
    const bars = barsByTicker[ticker];
    if (!bars || bars.length === 0) return null;
    let hit = null;
    for (const b of bars) {
      if (b.date <= iso) hit = b.close;
      else break;
    }
    return hit;
  };
}

// Pure: given the snapshots to fix, the trade legs ({ ticker, side, shares }),
// the net cash the basket moved, and a price lookup, return one correction row
// per snapshot (same order in, same order out). A leg with no price for a given
// day lands in that row's `missing` list and contributes nothing — so the
// caller can refuse to commit a day it can't fully value.
export function computeSnapshotCorrections({ snapshots, legs, netCashDelta, closeFor }) {
  const buys = legs.filter((l) => l.side === 'Buy');
  const sells = legs.filter((l) => l.side === 'Sell');

  return snapshots.map((snap) => {
    const iso = toIso(snap.date);
    const missing = [];
    let boughtValue = 0;
    let soldValue = 0;

    for (const l of buys) {
      const px = closeFor(l.ticker, iso);
      if (px == null) missing.push(l.ticker);
      else boughtValue += l.shares * px;
    }
    for (const l of sells) {
      const px = closeFor(l.ticker, iso);
      if (px == null) missing.push(l.ticker);
      else soldValue += l.shares * px;
    }

    const delta = boughtValue - soldValue + netCashDelta;
    const newCash =
      snap.cashValue == null ? snap.cashValue : round2(snap.cashValue + netCashDelta);

    return {
      date: iso,
      before: { totalValue: snap.totalValue, cashValue: snap.cashValue },
      after: { totalValue: round2(snap.totalValue + delta), cashValue: newCash },
      boughtValue: round2(boughtValue),
      soldValue: round2(soldValue),
      delta: round2(delta),
      missing,
    };
  });
}
