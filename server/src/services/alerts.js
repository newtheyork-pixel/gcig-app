// ALRT — the things somebody should have been told.
//
// The club's Investment Policy Statement sits in this repo as prose
// (server/src/ai/ips.md), gets read once into an LLM prompt, and is
// checked by nothing. It is not vague: a maximum 10% in any single
// security, cash no less than 5%, and — the one that names an action —
// "if a position ever declines beyond 15%, the voting members must meet
// to review the holding and decide whether to maintain or sell".
//
// On the book as it stands that rule is firing on Applied Digital and
// has been for weeks. Nobody was told, because nothing was watching.
//
// THREE RULES ABOUT RULES.
//
// An alert names the number and the threshold it crossed. "APLD is down"
// is a mood; "APLD is 31.4% below cost, past the 15% the IPS requires a
// review at" is something a member can act on and an exec can dispute.
//
// The charter's own language travels with it. A member who has never
// read the IPS should learn what it says from the alert, and an exec who
// disagrees should be arguing with the document rather than with us.
//
// Silence means checked and clear, never unchecked. Every rule reports
// whether it could run, so a data outage cannot look like compliance —
// which is the failure mode that makes a compliance screen worse than no
// compliance screen.

/// Straight from ips.md. Named here so a reader can see the numbers
/// without opening the charter, and so changing one is a deliberate act
/// rather than a tweak to a literal buried in a comparison.
export const IPS = {
  maxSinglePositionPct: 10,      // "maximum 10% ... to any single security"
  minCashPct: 5,                 // "cash or cash equivalents can be no less than 5%"
  minEquityPct: 20,              // "US equities can be no less than 20%"
  maxEquityPct: 100,
  reviewDrawdownPct: -15,        // "if a position ever declines beyond 15%"
  minHoldMonths: 3,              // "held for at least three months"
};

/// The funds the club may hold over the summer. Everything else is a
/// "group pick" the charter says to sell before it starts.
const ETF_LIKE = /^(VOO|QQQ|VGT|ROBO|SCHD|SHLD|KSA|VDE|SPY|IVV|VTI|BND|AGG)$/;

const sev = { breach: 3, action: 2, watch: 1 };

/**
 * Every alert the current book raises.
 *
 * `holdings` are the sheet rows, `cash` the dollar balance, `earnings`
 * the upcoming calendar. Any of them may be missing; a rule that cannot
 * run says so instead of passing.
 */
export function evaluate({ holdings = [], cash = null, earnings = [], now = new Date() } = {}) {
  const out = [];
  const eq = holdings.filter((h) => !h.isCash && h.ticker);
  const equity = eq.reduce((a, h) => a + (h.marketValue || 0), 0);
  const total = equity + (cash || 0);

  // --- the one that names an action -------------------------------
  if (eq.length) {
    for (const h of eq) {
      const r = h.percentReturn;
      if (typeof r !== 'number') continue;
      if (r <= IPS.reviewDrawdownPct) {
        out.push({
          id: `review-${h.ticker}`,
          kind: 'action',
          ticker: h.ticker,
          title: `${h.ticker} is ${fmt(r)} — the IPS requires a review`,
          detail: `Down ${fmt(r)} against cost, past the ${IPS.reviewDrawdownPct}% threshold. `
            + 'The charter does not make this optional: "if a position ever declines beyond '
            + '15%, the voting members must meet to review the holding and decide whether to '
            + 'maintain or sell the investment."',
          value: r,
          threshold: IPS.reviewDrawdownPct,
          source: 'ips.md — Target Asset Allocation Policy',
        });
      }
    }
  } else {
    out.push(unchecked('drawdown', 'No holdings loaded, so no position could be checked.'));
  }

  // --- concentration ----------------------------------------------
  if (total > 0) {
    for (const h of eq) {
      const pct = ((h.marketValue || 0) / total) * 100;
      if (pct > IPS.maxSinglePositionPct) {
        out.push({
          id: `concentration-${h.ticker}`,
          kind: 'breach',
          ticker: h.ticker,
          title: `${h.ticker} is ${pct.toFixed(1)}% of the fund`,
          detail: `Over the ${IPS.maxSinglePositionPct}% single-security cap. `
            + 'The charter allows exceptions "with approval from the Advisory Board and the '
            + 'voting members" — so this is either an approved exception nobody recorded, or a '
            + 'breach. Worth noting the cap does not say whether a broad index fund counts as '
            + '"a single security", which is a question for the Advisory Board rather than for '
            + 'this screen.',
          value: pct,
          threshold: IPS.maxSinglePositionPct,
          source: 'ips.md — Target Asset Allocation Policy',
        });
      }
    }
  }

  // --- cash floor and equity band ---------------------------------
  if (cash == null || total <= 0) {
    out.push(unchecked('cash', 'No cash balance available, so the 5% floor could not be checked.'));
  } else {
    const cashPct = (cash / total) * 100;
    if (cashPct < IPS.minCashPct) {
      out.push({
        id: 'cash-floor',
        kind: 'breach',
        title: `Cash is ${cashPct.toFixed(2)}% of the fund`,
        detail: `Below the ${IPS.minCashPct}% floor the IPS sets.`,
        value: cashPct,
        threshold: IPS.minCashPct,
        source: 'ips.md — Target Asset Allocation Policy',
      });
    }
    const eqPct = (equity / total) * 100;
    if (eqPct < IPS.minEquityPct || eqPct > IPS.maxEquityPct) {
      out.push({
        id: 'equity-band',
        kind: 'breach',
        title: `US equities are ${eqPct.toFixed(1)}% of the fund`,
        detail: `Outside the ${IPS.minEquityPct}–${IPS.maxEquityPct}% band.`,
        value: eqPct,
        threshold: IPS.minEquityPct,
        source: 'ips.md — Target Asset Allocation Policy',
      });
    }
  }

  // --- the summer rule --------------------------------------------
  //
  // "The fund will continue to hold the ETFs over the summer and will
  // sell all of the group picks before summer starts." Checked only in
  // the months where it can be true, because a rule that fires in
  // November is a rule people learn to dismiss.
  const month = new Date(now).getMonth();     // 0-indexed
  if (month >= 5 && month <= 7 && eq.length) { // June, July, August
    const picks = eq.filter((h) => !ETF_LIKE.test(String(h.ticker).toUpperCase()));
    if (picks.length) {
      const value = picks.reduce((a, h) => a + (h.marketValue || 0), 0);
      out.push({
        id: 'summer-picks',
        kind: 'action',
        title: `${picks.length} individual names still held over the summer`,
        detail: `${picks.map((p) => p.ticker).join(', ')} — `
          + `${total > 0 ? `${((value / total) * 100).toFixed(1)}% of the fund. ` : ''}`
          + 'The charter says "the fund will continue to hold the ETFs over the summer and will '
          + 'sell all of the group picks before summer starts". Either these were kept '
          + 'deliberately, in which case the decision belongs in the minutes, or the rule was '
          + 'missed.',
        value: picks.length,
        source: 'ips.md — Hiatus While Students Are Not in School',
      });
    }
  }

  // --- things about to happen -------------------------------------
  for (const e of earnings) {
    const days = daysUntil(e.date, now);
    if (days != null && days >= 0 && days <= 7) {
      out.push({
        id: `earnings-${e.ticker}`,
        kind: 'watch',
        ticker: e.ticker,
        title: `${e.ticker} reports in ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}`,
        detail: `${e.date}${e.hour ? ` (${e.hour})` : ''}. The one day a thesis is confirmed or `
          + 'contradicted in public.',
        value: days,
        source: 'earnings calendar',
      });
    }
  }

  out.sort((a, b) => (sev[b.kind] || 0) - (sev[a.kind] || 0)
    || Math.abs(b.value || 0) - Math.abs(a.value || 0));
  return out;
}

/// A rule that could not run. Distinct from a rule that passed, because
/// a compliance screen that shows silence for an outage is worse than
/// none at all.
function unchecked(rule, why) {
  return { id: `unchecked-${rule}`, kind: 'unchecked', title: `Not checked: ${rule}`, detail: why };
}

function fmt(n) {
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function daysUntil(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date(now);
  const today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((d.getTime() - today) / 86_400_000);
}

/// One line for a strip or a digest.
export function summarize(alerts) {
  const n = (k) => alerts.filter((a) => a.kind === k).length;
  return {
    total: alerts.length,
    breach: n('breach'),
    action: n('action'),
    watch: n('watch'),
    unchecked: n('unchecked'),
    clear: alerts.every((a) => a.kind === 'unchecked') || alerts.length === 0,
  };
}
