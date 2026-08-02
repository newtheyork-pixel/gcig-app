"""Stage 1: certify the data, or refuse to.

This is the entry point that stands between a vendor's marketing copy
and every number the rest of the repository will ever print. It builds
a source, pulls the four frames once, runs every check in
`griffinquant.audit`, prints the verdict and writes the markdown record
that gets committed next to a set of results.

The one thing worth reading twice is the exit code. PASS and WARN exit
0, FAIL exits 1, and everything else — UNPROVABLE, SKIPPED, a source
that could not be reached at all — exits 2. That third bucket is
deliberate and it is the whole reason this file has opinions about
process control. "We could not check" is not a weaker form of "we
checked and it was fine"; it is the absence of evidence, and the moment
it exits 0 somebody wires this into a pipeline, sees green, and ships a
Sharpe ratio computed on a dataset nobody ever examined. A non-zero
exit is the only thing that survives being skimmed.

The synthetic panel lives here rather than under `griffinquant/data`
because it is a property of the harness, not of the research. It exists
so the audit can be exercised with no vendor key on the machine, and so
each failure mode has a demonstration: `--inject-bias survivorship`
builds a panel with the graveyard deleted and the report has to catch
it. A check that has never been shown to fail is a check nobody should
trust to pass.
"""

from __future__ import annotations

import math
import sys
import traceback
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Callable, Iterable, Sequence

import numpy as np
import pandas as pd
import typer

from griffinquant import config
from griffinquant.audit import pointintime, quality, survivorship
from griffinquant.audit.context import AuditContext, load_context
from griffinquant.audit.decedents import DECEDENTS
from griffinquant.audit.report import print_console, render_markdown
from griffinquant.audit.result import AuditReport, CheckResult, Verdict
from griffinquant.data import schema
from griffinquant.data.base import DataSource, SourceCapabilities, SourceUnavailable
from griffinquant.data.cache import CacheKey, ParquetCache
from griffinquant.data.sharadar import SharadarSource

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "data_audit_report.md"

#: PASS and WARN are the only states a pipeline may treat as green. See
#: the module docstring for why UNPROVABLE is not one of them.
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_NOT_PROVEN = 2

_EXIT_FOR = {
    Verdict.PASS: EXIT_OK,
    Verdict.WARN: EXIT_OK,
    Verdict.FAIL: EXIT_FAILED,
}

#: Every check in the repository, in the order a reader would want to
#: meet them: is the graveyard here, does the panel know only what the
#: day knew, do the bars contradict themselves.
CHECK_MODULES = (survivorship, pointintime, quality)


class Source(str, Enum):
    sharadar = "sharadar"
    synthetic = "synthetic"


# -- the synthetic panel ------------------------------------------------

#: Fixed, and never a clock. Two runs of the smoke test a week apart
#: must differ only where the requested date range differs, or the
#: harness cannot be used to tell a code change from a data change.
SYNTHETIC_SEED = 20050103

#: Roughly the shape of the US listed market over the sample: a few
#: hundred names, widest in the early 2010s, gently narrowing after.
#: Big enough that the attrition and crisis clauses in the survivorship
#: checks have a denominator they are willing to speak about, small
#: enough that the whole audit runs in a coffee break.
_SEED_COUNT = 260
_PEAK_COUNT = 288
_FINAL_COUNT = 242

#: US equities retire at a few percent a year, and in a crisis at
#: several times that. A panel where 2008 looks like 2013 is a panel
#: whose deaths were not chosen by events.
_BASE_HAZARD = 0.035
_CRISIS_HAZARD = {2008: 0.095, 2009: 0.085, 2020: 0.075}

_CATEGORY = "Domestic Common Stock"
_EXCHANGES = ("NYSE", "NASDAQ")

#: The vocabulary the audit greps for. Every string here has to contain
#: one of `pointintime.TERMINAL_ACTIONS` as a substring or the delisting
#: will read as a name that simply stopped, which is the thing the
#: actions frame exists to prevent. Note that "Acquired" does not
#: contain "acquis" and "Acquisition" does — the vocabulary is matched
#: on substrings, so a plausible synonym is not the same as a match.
_TERMINAL_ACTION = {
    "acquisition": "Acquisition",
    "merger": "Merger",
    "bankruptcy": "Bankruptcy",
    "liquidation": "Liquidation",
    "going_private": "Delisted (going private)",
    "regulatory_delisting": "Delisted (non-compliance)",
    "seizure": "Delisted (regulatory seizure)",
}

_DEATH_REASONS = (
    "acquisition",
    "acquisition",
    "merger",
    "bankruptcy",
    "going_private",
    "regulatory_delisting",
)

#: Named so the failure mode is the first thing a reader sees, and
#: described in the terms of the check each one is meant to trip.
BIASES: dict[str, str] = {
    "survivorship": (
        "delete every delisted entity and all of its price history — the "
        "original bug, a panel assembled from the companies that exist "
        "today"
    ),
    "ticker-recycling": (
        "weld each recycled symbol's successor onto the dead company's "
        "permaticker, so Wachovia's series runs through Weibo's"
    ),
    "lookahead-fundamentals": (
        "stamp every filing as public on the day its quarter closed, which "
        "hands a backtest the numbers ~50 days before the market had them"
    ),
    "restated-fundamentals": (
        "serve most-recent-reported figures under the as-reported label: "
        "what the company admitted in 2013, dated 2011"
    ),
    "adjusted-prices": (
        "return the back-adjusted close under both headings, so every price "
        "and liquidity screen silently reads adjusted numbers"
    ),
    "phantom-sessions": (
        "print bars on days the exchange was shut — fills nobody could have "
        "got, on trades that never happened"
    ),
    "broken-adjustment": (
        "wobble the adjusted close away from the as-traded one on ordinary "
        "sessions, so total return and price return quietly disagree"
    ),
}


@dataclass
class _Entity:
    """One synthetic company, as a span of session indices."""

    permaticker: int
    ticker: str
    name: str
    exchange: str
    first_idx: int
    last_idx: int
    delisted: bool
    reason: str = ""


@dataclass
class _Panel:
    master: pd.DataFrame
    prices: pd.DataFrame
    actions: pd.DataFrame
    fundamentals: pd.DataFrame


def _widen_calendar_bounds(start: date, end: date) -> None:
    """Give exchange_calendars a wider default span before anything reads it.

    The library builds a calendar covering twenty years back from today
    unless it is told otherwise, and `AuditContext.sessions` asks for
    `get_calendar("XNYS")` with no bounds at all. Audit a sample that
    opens in 2005 from a machine whose clock says 2026 and every
    calendar-aware check dies on DateOutOfBounds — which this harness
    would then faithfully report as a dozen UNPROVABLE verdicts about
    the data, when the only thing that went wrong was a default.

    Patching a library global is a smell and it lives here anyway: the
    span is a property of the process, and the alternative is threading
    a calendar object through four modules that have no business
    knowing one exists. Called once, from the entry point, before any
    calendar has been built.
    """
    from exchange_calendars import exchange_calendar as ec

    lo = pd.Timestamp(start) - pd.Timedelta(days=400)
    hi = pd.Timestamp(end) + pd.Timedelta(days=400)
    if lo < ec.GLOBAL_DEFAULT_START:
        ec.GLOBAL_DEFAULT_START = lo
    if hi > ec.GLOBAL_DEFAULT_END:
        ec.GLOBAL_DEFAULT_END = hi


def _sessions(start: date, end: date) -> pd.DatetimeIndex:
    """The same calendar the audit will grade us against.

    Generating bars on our own notion of a trading day and then being
    marked against NYSE's would make the calendar check a test of two
    calendars rather than of the panel. Same call as `AuditContext`
    makes, deliberately, so both get the same cached object.
    """
    import exchange_calendars as xcals

    cal = xcals.get_calendar("XNYS")
    sess = cal.sessions_in_range(pd.Timestamp(start), pd.Timestamp(end))
    return pd.DatetimeIndex(sess).tz_localize(None).normalize()


def _ticker_pool(reserved: set[str], count: int) -> list[str]:
    """Symbols that cannot collide with a fixture's.

    Three letters starting at QAA — well clear of the real tickers the
    decedent list names, so a synthetic company can never be mistaken
    for one of the companies whose death is on the record.
    """
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out: list[str] = []
    for a in "QRSTUVWXYZ":
        for b in letters:
            for c in letters:
                sym = a + b + c
                if sym in reserved:
                    continue
                out.append(sym)
                if len(out) >= count:
                    return out
    return out


def _target_count(year: int, first: int, last: int) -> float:
    """A hump, not a ramp.

    The count curve is the single most diagnostic thing in the audit: a
    panel built from today's survivors can only grow toward the present.
    So the honest fixture has to peak in the middle and narrow after,
    the way the US listed market actually did.
    """
    if last <= first:
        return float(_SEED_COUNT)
    peak = first + max(1, int(0.40 * (last - first)))
    if year <= peak:
        t = (year - first) / (peak - first)
        return _SEED_COUNT + (_PEAK_COUNT - _SEED_COUNT) * t
    t = (year - peak) / max(1, last - peak)
    return _PEAK_COUNT + (_FINAL_COUNT - _PEAK_COUNT) * t


def _nearest_session(sessions: pd.DatetimeIndex, when: date) -> int | None:
    """Index of the session closest to a calendar date."""
    if len(sessions) == 0:
        return None
    ts = pd.Timestamp(when)
    pos = int(sessions.searchsorted(ts))
    best = None
    for cand in (pos - 1, pos):
        if 0 <= cand < len(sessions):
            gap = abs((sessions[cand] - ts).days)
            if best is None or gap < best[0]:
                best = (gap, cand)
    return None if best is None else best[1]


def _build_entities(sessions: pd.DatetimeIndex) -> list[_Entity]:
    """Who existed, when they listed, and when they stopped.

    Two populations, and the second is the point. The generated cohort
    supplies the statistics — the count curve, the attrition rate, the
    delisted share. The decedent fixtures supply the names, so that a
    panel which passes the statistics on aggregate still has to explain
    where Lehman went.
    """
    rng = np.random.default_rng(SYNTHETIC_SEED)
    first_ts, last_ts = sessions[0], sessions[-1]
    entities: list[_Entity] = []
    next_id = 100_001

    # -- the companies whose funerals are a matter of record ------------
    fixture_symbols = {d.ticker for d in DECEDENTS}
    for dec in DECEDENTS:
        idx = _nearest_session(sessions, dec.last_trade_on_or_about)
        if idx is None:
            continue
        observed = sessions[idx].date()
        if abs((observed - dec.last_trade_on_or_about).days) > dec.tolerance_days:
            # The death falls outside the audited window, or on a stretch
            # of calendar we did not pull. Leaving the company out is
            # honest; inventing a nearby date to make the row green is
            # not, and the check reports the absence as a skip anyway.
            continue
        entities.append(
            _Entity(
                permaticker=next_id,
                ticker=dec.ticker,
                name=dec.name,
                exchange=_EXCHANGES[next_id % 2],
                first_idx=0,
                last_idx=idx,
                delisted=True,
                reason=dec.reason,
            )
        )
        next_id += 1

        # The successor only exists to be told apart from its
        # predecessor. It starts well after the funeral, because a
        # legitimate reuse of a symbol never overlaps — an overlap is
        # the recycling bug rather than a reissue.
        if dec.successor_ticker:
            start_idx = _nearest_session(
                sessions, dec.last_trade_on_or_about + timedelta(days=300)
            )
            if start_idx is not None and start_idx > idx + 60:
                entities.append(
                    _Entity(
                        permaticker=next_id,
                        ticker=dec.successor_ticker,
                        name=f"{dec.successor_ticker} Holdings (successor)",
                        exchange=_EXCHANGES[next_id % 2],
                        first_idx=start_idx,
                        last_idx=len(sessions) - 1,
                        delisted=False,
                    )
                )
                next_id += 1

    # -- the generated cohort -------------------------------------------
    years = list(range(first_ts.year, last_ts.year + 1))
    session_years = sessions.year.to_numpy()
    by_year = {y: np.flatnonzero(session_years == y) for y in years}

    pool = _ticker_pool(fixture_symbols, 4000)
    pool_at = 0

    def _mint(first_idx: int, last_idx: int) -> _Entity:
        nonlocal next_id, pool_at
        sym = pool[pool_at % len(pool)]
        pool_at += 1
        ent = _Entity(
            permaticker=next_id,
            ticker=sym,
            name=f"Fixture {sym} Corp",
            exchange=_EXCHANGES[next_id % 2],
            first_idx=first_idx,
            last_idx=last_idx,
            delisted=False,
        )
        next_id += 1
        return ent

    last_idx = len(sessions) - 1
    living: list[_Entity] = [_mint(0, last_idx) for _ in range(_SEED_COUNT)]
    cohort: list[_Entity] = list(living)

    for year in years:
        idxs = by_year.get(year)
        if idxs is None or len(idxs) == 0:
            continue
        final_year = year == years[-1]
        if final_year or not living:
            # Nobody dies in the truncated final year. Every name's
            # series stops at the end of the pull, and scoring that as a
            # mass extinction would report the edge of the window as an
            # event in the market.
            continue

        hazard = _CRISIS_HAZARD.get(year, _BASE_HAZARD)
        n_die = int(round(hazard * len(living)))
        n_die = max(2, min(n_die, len(living) - 20))
        victims = rng.choice(len(living), size=n_die, replace=False)
        for v in sorted(victims.tolist(), reverse=True):
            ent = living.pop(v)
            ent.last_idx = int(rng.choice(idxs))
            ent.delisted = True
            ent.reason = _DEATH_REASONS[int(rng.integers(len(_DEATH_REASONS)))]

        want = _target_count(year + 1, years[0], years[-1]) - _target_count(
            year, years[0], years[-1]
        )
        n_new = max(0, int(round(n_die + want)))
        for _ in range(n_new):
            born = int(rng.choice(idxs))
            ent = _mint(born, len(sessions) - 1)
            living.append(ent)
            cohort.append(ent)

    entities.extend(cohort)
    return entities


def _price_block(
    ent: _Entity, sessions: pd.DatetimeIndex
) -> tuple[dict[str, np.ndarray], list[tuple[int, str, float]]]:
    """One company's tape, plus the corporate actions inside it.

    The series is generated in ADJUSTED space and divided down into
    as-traded prices, never the other way round. That ordering is what
    makes the two columns agree exactly on ordinary sessions — a
    piecewise-constant factor cancels out of a return — and disagree by
    precisely the split or the dividend on the days they are supposed
    to. Building the as-traded path first and adjusting it forward
    accumulates rounding into every return and turns a clean fixture
    into a source of false positives.
    """
    n = ent.last_idx - ent.first_idx + 1
    # A seed per entity, not a stream shared across the panel: adding a
    # company to the fixture must not repaint every company after it.
    rng = np.random.default_rng([SYNTHETIC_SEED, ent.permaticker])

    p0 = float(np.exp(rng.uniform(math.log(6.0), math.log(150.0))))
    steps = rng.normal(0.00015, 0.017, size=n)
    adj = p0 * np.exp(np.cumsum(steps))
    np.clip(adj, 0.25, None, out=adj)

    # `factor` is the back-adjustment: the number the as-traded price is
    # multiplied by to reach the adjusted one. It is 1.0 at the right
    # edge and steps at every event going backwards, which is exactly
    # the shape that leaves returns untouched between events.
    factor = np.ones(n, dtype="float64")
    events: list[tuple[int, str, float]] = []

    if n >= 500 and rng.random() < 0.22:
        j = int(rng.integers(n // 5, (4 * n) // 5))
        # Reverse splits are in here on purpose. They are the mechanism
        # behind the adjusted-price screen leak: a stock that traded at
        # $2 and later did a 1-for-4 shows up at $8 in adjusted terms and
        # clears a $5 floor it could never have cleared on the day.
        ratio = float(rng.choice([2.0, 2.0, 3.0, 0.25]))
        factor[:j] /= ratio
        events.append((j, "split", ratio))

    if rng.random() < 0.55:
        step = 63
        start = int(rng.integers(5, step))
        rate = float(rng.uniform(0.002, 0.008))
        for j in range(start, n, step):
            factor[:j] *= 1.0 - rate
            events.append((j, "dividend", rate))

    close_unadj = adj / factor

    noise = rng.normal(0.0, 0.005, size=n)
    open_adj = np.empty(n, dtype="float64")
    open_adj[0] = adj[0] * math.exp(float(noise[0]))
    open_adj[1:] = adj[:-1] * np.exp(noise[1:])
    high_adj = np.maximum(open_adj, adj) * (1.0 + np.abs(rng.normal(0.0, 0.004, n)))
    low_adj = np.minimum(open_adj, adj) * (1.0 - np.abs(rng.normal(0.0, 0.004, n)))

    base_vol = float(np.exp(rng.uniform(math.log(2.0e5), math.log(9.0e6))))
    vol_adj = base_vol * np.exp(rng.normal(0.0, 0.45, size=n))
    # Volume moves the other way from price: as-traded share counts are
    # smaller before a forward split, not larger.
    volume = np.maximum(np.round(vol_adj * factor), 1.0)

    dividends = np.zeros(n, dtype="float64")
    for j, kind, magnitude in events:
        if kind == "dividend":
            dividends[j] = round(magnitude * float(close_unadj[j]), 4)

    return (
        {
            "date": sessions[ent.first_idx : ent.last_idx + 1].to_numpy(),
            "open_unadj": open_adj / factor,
            "high_unadj": high_adj / factor,
            "low_unadj": low_adj / factor,
            "close_unadj": close_unadj,
            "volume_unadj": volume,
            "close_adj": adj,
            "dividends": dividends,
        },
        events,
    )


def _build_master(
    entities: Sequence[_Entity], sessions: pd.DatetimeIndex
) -> pd.DataFrame:
    ids = [e.permaticker for e in entities]
    return pd.DataFrame(
        {
            "permaticker": pd.Series(ids, dtype="int64"),
            "ticker": pd.Series([e.ticker for e in entities], dtype="str"),
            "name": pd.Series([e.name for e in entities], dtype="str"),
            "exchange": pd.Series([e.exchange for e in entities], dtype="str"),
            "category": pd.Series([_CATEGORY] * len(entities), dtype="str"),
            "is_delisted": pd.Series([e.delisted for e in entities], dtype="bool"),
            "first_price_date": pd.Series(
                [sessions[e.first_idx] for e in entities], dtype="datetime64[ns]"
            ),
            "last_price_date": pd.Series(
                [sessions[e.last_idx] for e in entities], dtype="datetime64[ns]"
            ),
            "sector": pd.Series(["Industrials"] * len(entities), dtype="str"),
            "currency": pd.Series(["USD"] * len(entities), dtype="str"),
        }
    ).sort_values("permaticker").reset_index(drop=True)


def _build_fundamentals(
    entities: Sequence[_Entity], sessions: pd.DatetimeIndex
) -> pd.DataFrame:
    """Quarterly filings, dated when they were filed.

    `period_end` is the quarter; `date_public` is the quarter plus a
    filing lag with a fourth-quarter tail on it, because a 10-K takes
    longer than a 10-Q and a panel whose lag has no shape is a panel
    whose lag was invented.
    """
    rows: list[dict] = []
    for ent in entities:
        rng = np.random.default_rng([SYNTHETIC_SEED, 7, ent.permaticker])
        first = sessions[ent.first_idx]
        last = sessions[ent.last_idx]
        scale = float(np.exp(rng.uniform(math.log(4.0e7), math.log(9.0e10))))
        q = pd.Timestamp(year=first.year, month=3, day=31)
        while q <= last:
            if q >= first:
                annual = q.month == 12
                lag = int(rng.integers(70, 101) if annual else rng.integers(33, 56))
                public = q + pd.Timedelta(days=lag)
                if public <= last + pd.Timedelta(days=120):
                    drift = float(np.exp(rng.normal(0.0, 0.12)))
                    rev = scale * drift / 4.0
                    rows.append(
                        {
                            "permaticker": ent.permaticker,
                            "ticker": ent.ticker,
                            "dimension": "ARQ",
                            "period_end": q,
                            "date_public": public,
                            "report_period": q,
                            "revenue": round(rev, 2),
                            "netinc": round(rev * float(rng.normal(0.09, 0.05)), 2),
                            "equity": round(scale * 0.55 * drift, 2),
                            "assets": round(scale * 1.4 * drift, 2),
                        }
                    )
            q = q + pd.offsets.QuarterEnd(1)

    if not rows:
        return schema.FUNDAMENTALS.empty()

    out = pd.DataFrame(rows)
    out["permaticker"] = out["permaticker"].astype("int64")
    for col in ("ticker", "dimension"):
        out[col] = out[col].astype("str")
    for col in ("period_end", "date_public", "report_period"):
        out[col] = out[col].astype("datetime64[ns]")
    out = out.drop_duplicates(subset=["permaticker", "dimension", "date_public"])
    return out.sort_values(["permaticker", "date_public"]).reset_index(drop=True)


def _build_panel(start: date, end: date, bias: str | None) -> _Panel:
    sessions = _sessions(start, end)
    if len(sessions) == 0:
        return _Panel(
            master=schema.SECURITY_MASTER.empty(),
            prices=schema.PRICES.empty(),
            actions=schema.ACTIONS.empty(),
            fundamentals=schema.FUNDAMENTALS.empty(),
        )

    entities = _build_entities(sessions)

    blocks: list[dict[str, np.ndarray]] = []
    ids: list[np.ndarray] = []
    syms: list[np.ndarray] = []
    action_rows: list[dict] = []

    for ent in entities:
        block, events = _price_block(ent, sessions)
        blocks.append(block)
        n = len(block["date"])
        ids.append(np.full(n, ent.permaticker, dtype="int64"))
        syms.append(np.full(n, ent.ticker, dtype=object))
        for j, kind, magnitude in events:
            action_rows.append(
                {
                    "date": sessions[ent.first_idx + j],
                    "action": "Split" if kind == "split" else "Dividend",
                    "ticker": ent.ticker,
                    "permaticker": ent.permaticker,
                    "name": ent.name,
                    # One column, two units, decided by `action`: a ratio
                    # for a split and a rate for a dividend.
                    "value": float(magnitude),
                    "reason": "",
                }
            )
        if ent.delisted:
            action_rows.append(
                {
                    "date": sessions[ent.last_idx],
                    "action": _TERMINAL_ACTION.get(ent.reason, "Delisted"),
                    "ticker": ent.ticker,
                    "permaticker": ent.permaticker,
                    "name": ent.name,
                    "value": float("nan"),
                    "reason": ent.reason,
                }
            )

    prices = pd.DataFrame(
        {
            "permaticker": np.concatenate(ids),
            "ticker": pd.Series(np.concatenate(syms), dtype="str"),
            "date": pd.Series(
                np.concatenate([b["date"] for b in blocks]), dtype="datetime64[ns]"
            ),
            **{
                col: np.concatenate([b[col] for b in blocks])
                for col in (
                    "open_unadj",
                    "high_unadj",
                    "low_unadj",
                    "close_unadj",
                    "volume_unadj",
                    "close_adj",
                    "dividends",
                )
            },
        }
    )
    # No `split_factor` column, on purpose. Sharadar's is cumulative, so
    # every bar before a split reads as != 1.0 — and the adjustment
    # check treats that as "an action happened here", which would
    # silently exclude most of a split name's history from the one
    # comparison that can catch a mis-scaled adjustment. Splits reach
    # the audit through the actions frame instead, keyed by permaticker.
    prices = prices.sort_values(["permaticker", "date"]).reset_index(drop=True)

    actions = pd.DataFrame(action_rows)
    if actions.empty:
        actions = schema.ACTIONS.empty()
    else:
        actions = actions.assign(
            date=actions["date"].astype("datetime64[ns]"),
            action=actions["action"].astype("str"),
            ticker=actions["ticker"].astype("str"),
            permaticker=actions["permaticker"].astype("Int64"),
            name=actions["name"].astype("str"),
            value=actions["value"].astype("float64"),
            reason=actions["reason"].astype("str"),
        ).sort_values(["date", "ticker", "action"]).reset_index(drop=True)

    panel = _Panel(
        master=_build_master(entities, sessions),
        prices=prices,
        actions=actions,
        fundamentals=_build_fundamentals(entities, sessions),
    )
    if bias:
        _inject(panel, bias)
    return panel


# -- the deliberate corruptions -----------------------------------------


def _inject(panel: _Panel, bias: str) -> None:
    """Break the panel in one specific, nameable way.

    Each of these is a real defect somebody has shipped, not a
    synthetic mutation chosen to be easy to spot. The capabilities the
    source claims are left untouched throughout — that is the point. A
    vendor that claims as-traded prices and returns the adjusted series
    twice must produce a FAIL, not an UNPROVABLE, because it did sit
    the test and it did get the answer wrong.
    """
    if bias == "survivorship":
        alive = ~panel.master["is_delisted"].to_numpy()
        keep = set(panel.master.loc[alive, "permaticker"].tolist())
        panel.master = panel.master.loc[alive].reset_index(drop=True)
        panel.prices = panel.prices.loc[
            panel.prices["permaticker"].isin(keep)
        ].reset_index(drop=True)
        panel.actions = panel.actions.loc[
            panel.actions["permaticker"].isin(keep)
        ].reset_index(drop=True)
        panel.fundamentals = panel.fundamentals.loc[
            panel.fundamentals["permaticker"].isin(keep)
        ].reset_index(drop=True)
        return

    if bias == "ticker-recycling":
        # Join on the symbol and the successor's history is grafted onto
        # the dead company's, which reads as a stock that fell to nothing
        # and recovered. The master keeps one row per symbol, wearing the
        # dead company's identity and the living one's dates.
        master = panel.master
        dupes = master.loc[master["ticker"].duplicated(keep=False)]
        remap: dict[int, int] = {}
        drop: set[int] = set()
        for _, grp in dupes.groupby("ticker", sort=True):
            grp = grp.sort_values("first_price_date")
            survivor = int(grp.iloc[0]["permaticker"])
            for pt in grp["permaticker"].iloc[1:].tolist():
                remap[int(pt)] = survivor
                drop.add(int(pt))
        if not remap:
            return
        for frame in ("prices", "actions", "fundamentals"):
            df = getattr(panel, frame)
            if df.empty or "permaticker" not in df.columns:
                continue
            dtype = df["permaticker"].dtype
            moved = df["permaticker"].map(lambda v: remap.get(v, v)).astype(dtype)
            welded_frame = df.assign(permaticker=moved).reset_index(drop=True)
            setattr(panel, frame, welded_frame)
        spans = panel.prices.groupby("permaticker")["date"].agg(["min", "max"])
        master = master.loc[~master["permaticker"].isin(drop)].copy()
        pt = master["permaticker"]
        master["first_price_date"] = (
            pt.map(spans["min"]).fillna(master["first_price_date"])
        )
        master["last_price_date"] = (
            pt.map(spans["max"]).fillna(master["last_price_date"])
        )
        # Only the welded rows lose their delisting flag. Clearing it
        # panel-wide would trip the survivorship checks as well and turn
        # a fixture aimed at one failure into a fixture that fails
        # everything — which proves nothing about either.
        welded = master["permaticker"].isin(set(remap.values()))
        master["is_delisted"] = (master["is_delisted"] & ~welded).astype("bool")
        panel.master = master.reset_index(drop=True)
        panel.prices = panel.prices.drop_duplicates(
            subset=["permaticker", "date"], keep="first"
        ).reset_index(drop=True)
        panel.fundamentals = panel.fundamentals.drop_duplicates(
            subset=["permaticker", "dimension", "date_public"], keep="first"
        ).reset_index(drop=True)
        return

    if bias == "lookahead-fundamentals":
        panel.fundamentals = panel.fundamentals.assign(
            date_public=panel.fundamentals["period_end"]
        )
        return

    if bias == "restated-fundamentals":
        # Served in answer to a request for ARQ, which is the failure:
        # the label says as-reported and the numbers are the restatement.
        n = len(panel.fundamentals)
        flag = np.arange(n) % 4 != 0
        dim = np.where(flag, "MRQ", "ARQ")
        panel.fundamentals = panel.fundamentals.assign(
            dimension=pd.Series(dim, dtype="str")
        )
        return

    if bias == "adjusted-prices":
        adj = panel.prices["close_adj"]
        scale = adj / panel.prices["close_unadj"]
        panel.prices = panel.prices.assign(
            close_unadj=adj,
            open_unadj=panel.prices["open_unadj"] * scale,
            high_unadj=panel.prices["high_unadj"] * scale,
            low_unadj=panel.prices["low_unadj"] * scale,
        )
        return

    if bias == "phantom-sessions":
        # Push one bar in every ninety onto the following day. Most of
        # those land on a session and change nothing; the ones that fall
        # off a Friday or the day before a holiday are quotes for a day
        # the exchange was shut.
        px = panel.prices
        moved = px["date"].to_numpy().copy()
        hit = np.arange(len(px)) % 90 == 0
        moved[hit] = moved[hit] + np.timedelta64(1, "D")
        panel.prices = px.assign(
            date=pd.Series(moved, dtype="datetime64[ns]")
        ).drop_duplicates(subset=["permaticker", "date"], keep="first").reset_index(
            drop=True
        )
        return

    if bias == "broken-adjustment":
        rng = np.random.default_rng([SYNTHETIC_SEED, 99])
        wobble = 1.0 + rng.normal(0.0, 0.004, size=len(panel.prices))
        panel.prices = panel.prices.assign(
            close_adj=panel.prices["close_adj"] * np.abs(wobble)
        )
        return

    raise ValueError(f"unknown bias {bias!r}")


class SyntheticSource(DataSource):
    """A panel with no vendor behind it, for exercising the harness.

    Everything it claims about itself is true of the clean fixture, and
    the injected biases do not walk those claims back. That asymmetry is
    deliberate: capabilities are what a source asserts, and the audit's
    job is to find out whether the assertion holds. A fixture that
    lowered its own claims as it corrupted itself would convert every
    FAIL into an UNPROVABLE and quietly stop testing anything.
    """

    capabilities = SourceCapabilities(
        name="Synthetic panel",
        claims_survivorship_free=True,
        provides_filing_dates=True,
        provides_as_reported=True,
        provides_delisting_dates=True,
        provides_delisting_reasons=True,
        provides_permanent_ids=True,
        provides_index_membership=False,
        provides_unadjusted_prices=True,
        is_smoke_test_only=True,
    )

    def __init__(self, start: date, end: date, *, bias: str | None = None) -> None:
        if bias is not None and bias not in BIASES:
            raise ValueError(f"unknown bias {bias!r}")
        self.bias = bias
        self._start = start
        self._end = end
        self._panel: _Panel | None = None

    @property
    def label(self) -> str:
        tag = f", bias={self.bias}" if self.bias else ", clean"
        return f"{self.capabilities.name}{tag} [SMOKE TEST ONLY]"

    def _built(self) -> _Panel:
        if self._panel is None:
            self._panel = _build_panel(self._start, self._end, self.bias)
        return self._panel

    def security_master(self) -> pd.DataFrame:
        return self._check(self._built().master.copy(), schema.SECURITY_MASTER)

    def prices(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
    ) -> pd.DataFrame:
        df = self._built().prices
        df = df.loc[df["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        if permatickers is not None:
            df = df.loc[df["permaticker"].isin({int(p) for p in permatickers})]
        return self._check(df.reset_index(drop=True), schema.PRICES)

    def actions(self, start: date, end: date) -> pd.DataFrame:
        df = self._built().actions
        df = df.loc[df["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        return self._check(df.reset_index(drop=True), schema.ACTIONS)

    def fundamentals(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
        dimension: str = "ARQ",
    ) -> pd.DataFrame:
        df = self._built().fundamentals
        df = df.loc[
            df["date_public"].between(pd.Timestamp(start), pd.Timestamp(end))
        ]
        if permatickers is not None:
            df = df.loc[df["permaticker"].isin({int(p) for p in permatickers})]
        return self._check(df.reset_index(drop=True), schema.FUNDAMENTALS)


# -- wiring -------------------------------------------------------------


class _SharadarCacheAdapter:
    """Two cache interfaces that were written apart, joined here.

    `SharadarSource` asks its cache for a string key and offers to build
    the frame; `ParquetCache` keys on a `CacheKey` and wants a stamp. The
    adapter is one method wide and belongs at the seam rather than
    inside either module — and it maps the vendor's table names onto the
    cache's frame names so the TTL rules apply. Without that mapping
    every entry falls to the unknown-frame default and a twenty-year
    price pull is re-downloaded daily.
    """

    _FRAMES = {
        "tickers": "security_master",
        "sep": "prices",
        "actions": "actions",
        "sf1": "fundamentals",
    }

    def __init__(
        self, cache: ParquetCache, *, end: date, stamped: datetime
    ) -> None:
        self._cache = cache
        self._end = end
        self._stamped = stamped

    def get_or_fetch(
        self, key: str, build: Callable[[], pd.DataFrame]
    ) -> pd.DataFrame:
        parts = key.split("/")
        table = parts[1] if len(parts) > 1 else "unknown"
        ck = CacheKey(
            source="sharadar",
            frame=self._FRAMES.get(table, table),
            # `end` rides along so the cache can tell a closed historical
            # range from one that is still accruing today's bar.
            params={"key": key, "end": self._end},
        )
        return self._cache.get_or_load(
            ck, build, stamped=self._stamped, now=self._stamped
        )


def _run_checks(ctx: AuditContext) -> list[CheckResult]:
    """Every check, and a survivable answer when one of them explodes.

    A check that raises is a bug in the audit, not a finding about the
    data, and it must not read as either a pass or a failure. UNPROVABLE
    is the honest verdict — nothing was tested — and it exits non-zero,
    so a broken check cannot quietly certify a dataset.
    """
    results: list[CheckResult] = []
    for module in CHECK_MODULES:
        for check in module.CHECKS:
            name = getattr(check, "__name__", repr(check))
            try:
                results.append(check(ctx))
            except Exception as exc:  # noqa: BLE001 - see the docstring
                results.append(
                    CheckResult(
                        key=f"harness.{name}",
                        title=f"{name} (did not complete)",
                        verdict=Verdict.UNPROVABLE,
                        blocking=True,
                        headline=(
                            f"{name} raised {type(exc).__name__} and returned "
                            "no verdict."
                        ),
                        unprovable_reason=(
                            f"The check itself failed: {type(exc).__name__}: "
                            f"{exc}. This says nothing about the data — it "
                            "says the audit did not run. Fix the check and "
                            "rerun; do not read the rest of this report as a "
                            "complete examination.\n\n"
                            + traceback.format_exc(limit=6)
                        ),
                    )
                )
    return results


def _build_source(
    source: Source,
    start: date,
    end: date,
    *,
    bias: str | None,
    use_cache: bool,
    stamped: datetime,
) -> tuple[DataSource, dict[str, str]]:
    if source is Source.synthetic:
        return (
            SyntheticSource(start, end, bias=bias),
            {
                "panel": "synthetic, generated in-process",
                "seed": str(SYNTHETIC_SEED),
                "injected bias": bias or "none (clean panel)",
                "warning": (
                    "SMOKE TEST ONLY. Nothing in this report is a statement "
                    "about any real security."
                ),
            },
        )

    cache = None
    cache_note = "disabled (--no-cache)"
    if use_cache:
        store = ParquetCache()
        cache = _SharadarCacheAdapter(store, end=end, stamped=stamped)
        cache_note = str(store.root)
    return SharadarSource(cache=cache), {"cache": cache_note}


def _explain_unavailable(exc: SourceUnavailable, source: Source) -> None:
    """The path that actually runs today, so make it worth reading."""
    from rich.console import Console
    from rich.padding import Padding

    err = Console(stderr=True)
    err.print()
    err.print("[bold red]The audit did not run: the data source is not there.[/]")
    err.print()
    err.print(Padding(str(exc), (0, 4)))
    err.print()
    if source is Source.sharadar:
        err.print(
            "Sharadar is read through Nasdaq Data Link and needs a key in the\n"
            "environment. Set [bold]NASDAQ_DATA_LINK_API_KEY[/] (the older\n"
            "[bold]QUANDL_API_KEY[/] is accepted too) and run this again."
        )
        err.print()
    err.print(
        "No report was written, and that is the point. This tool exists to\n"
        "certify a dataset, and a dataset that could not be reached has not\n"
        "been certified — it has not been examined at all. Emitting a report\n"
        "here would produce a document that looks exactly like a clean one."
    )
    err.print()
    err.print(
        "To exercise the harness itself without a key:\n"
        "  [bold]python data_audit.py --source synthetic[/]\n"
        "  [bold]python data_audit.py --source synthetic "
        "--inject-bias survivorship[/]\n"
        "The second builds a panel with the graveyard deleted; if the report\n"
        "comes back anything other than FAIL, the audit is broken."
    )
    err.print()


app = typer.Typer(
    add_completion=False,
    help=(
        "Audit a securities panel for survivorship bias, point-in-time "
        "integrity and internal consistency, and refuse to certify what it "
        "could not check."
    ),
)


@app.command()
def main(
    source: Source = typer.Option(
        Source.sharadar, "--source", help="Which panel to audit."
    ),
    start: str = typer.Option(
        config.SAMPLE_START, "--start", help="First date, ISO. Bounds the pull."
    ),
    end: str = typer.Option(
        None, "--end", help="Last date, ISO. Defaults to today."
    ),
    inject_bias: str = typer.Option(
        None,
        "--inject-bias",
        help=(
            "Synthetic only: corrupt the panel in one named way and check "
            "the audit catches it. One of: " + ", ".join(BIASES)
        ),
    ),
    out: Path = typer.Option(
        DEFAULT_REPORT, "--out", help="Where to write the markdown report."
    ),
    no_cache: bool = typer.Option(
        False, "--no-cache", help="Ignore the on-disk parquet cache and refetch."
    ),
    quiet: bool = typer.Option(
        False, "--quiet", help="Write the report, print nothing but errors."
    ),
) -> None:
    # One clock reading for the whole run, threaded into the cache stamp
    # and both renderings of the report. Read it twice and a slow audit
    # produces a report whose header disagrees with its own provenance
    # table, which is a small lie in a document whose entire value is
    # that it does not tell them.
    generated_at = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat(sep=" ")
    )
    stamped = datetime.now(timezone.utc).replace(microsecond=0)

    try:
        start_date = date.fromisoformat(start)
    except ValueError as exc:
        raise typer.BadParameter(f"--start {start!r} is not an ISO date") from exc
    try:
        end_date = date.today() if end is None else date.fromisoformat(end)
    except ValueError as exc:
        raise typer.BadParameter(f"--end {end!r} is not an ISO date") from exc
    if end_date <= start_date:
        raise typer.BadParameter("--end must fall after --start")

    _widen_calendar_bounds(start_date, end_date)

    if inject_bias is not None:
        if source is not Source.synthetic:
            raise typer.BadParameter(
                "--inject-bias only applies to --source synthetic. Corrupting "
                "a real vendor pull would produce a report about damage this "
                "tool did rather than about the dataset."
            )
        if inject_bias not in BIASES:
            raise typer.BadParameter(
                f"unknown bias {inject_bias!r}. Known: "
                + "; ".join(f"{k} — {v}" for k, v in BIASES.items())
            )

    try:
        src, extra_provenance = _build_source(
            source,
            start_date,
            end_date,
            bias=inject_bias,
            use_cache=not no_cache,
            stamped=stamped,
        )
        ctx = load_context(src, start_date, end_date)
    except SourceUnavailable as exc:
        _explain_unavailable(exc, source)
        raise typer.Exit(EXIT_NOT_PROVEN)

    report = AuditReport(source_label=src.label)
    for result in _run_checks(ctx):
        report.add(result)

    report.provenance = {
        **ctx.provenance,
        **extra_provenance,
        "command": " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]),
        "report": str(out),
    }

    if not quiet:
        print_console(report)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(report, generated_at=generated_at), "utf-8")

    if not quiet:
        from rich.console import Console

        Console().print(f"  written to {out}", style="dim")

    raise typer.Exit(_EXIT_FOR.get(report.verdict, EXIT_NOT_PROVEN))


if __name__ == "__main__":
    app()
