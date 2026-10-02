/**
 * Fully-invested counterfactual for the portfolio headline tiles.
 *
 * If the cash sleeve had earned the equity rate, the whole book earns
 * the equity rate. That identity is why the number cannot sit above
 * equity-only — it is equity-only.
 *
 * The first cut was `bookPct + cashRatio * equityPct`. That recovers
 * the identity only when cash returned nothing, so the book was
 * `(1 - cashRatio) * equityPct` and adding the cash-weight back
 * reconstructed the sleeve. The pile now yields (BDA / FGTXX), and
 * Total Gain/Loss already credits estimated interest, so the mix
 * overshoots the sleeve — which is how Adjusted printed above
 * Equity-only on a page that was meant to be removing cash drag.
 */
export function adjustedReturn({ equityPct, cashRatio }) {
  if (equityPct == null || !Number.isFinite(equityPct)) return null;
  if (cashRatio == null || !Number.isFinite(cashRatio) || cashRatio < 0) return null;
  return { pct: equityPct, cashRatio };
}
