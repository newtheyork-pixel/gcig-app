"""Whether the bars contradict themselves.

None of these checks can tell you a price is *right* — nothing here has
a second vendor to compare against. What they can tell you is when the
panel disagrees with itself: a close outside its own high-low band, a
bar on a day the exchange was shut, a 78% overnight loss with no split
recorded anywhere near it.

That is worth a whole module because of what a single bad print does
downstream. A backtest does not average a bad print away; it hunts for
it. An unrecorded 4-for-1 split reads as a 75% one-day loss and then a
300% one-day gain, and any mean-reversion signal in the book will find
that pair, size into it, and report a Sharpe that belongs to a typo.
The asymmetry is the point: a good bar contributes a normal return, a
broken one contributes an outlier the optimiser is drawn to.

Two distinctions run through the file and both exist because somebody
will otherwise "fix" the wrong thing:

  * A price row on a non-session date is *fabricated* — the exchange
    was closed and no trade happened. A session with almost no rows is
    a *hole in the pull* — the trades happened and we failed to fetch
    them. The first invalidates a backtest, the second merely thins it.
  * Duplicates on (permaticker, date) are a hard corruption. Duplicates
    on (ticker, date) are the expected consequence of symbols being
    recycled between companies, and deduplicating on the symbol is how
    you delete a real company's history.
"""

from __future__ import annotations

from typing import Callable

import numpy as np
import pandas as pd

from .context import AuditContext
from .result import CheckResult, Verdict

# A move this large in one session is either a corporate action or an
# error. Half is low enough to catch a 2-for-1 and high enough that
# ordinary biotech binary events stay out of the way.
JUMP_THRESHOLD = 0.50

# Vendors disagree by a day or two on whether an action is stamped at
# announcement, ex-date or effective date. Three sessions either side
# absorbs that without being so wide it excuses everything.
JUMP_ACTION_WINDOW = 3
JUMP_WARN_PER_MILLION = 5.0

ZERO_VOLUME_WARN = 0.02
ZERO_VOLUME_FAIL = 0.10

# A session carrying under 40% of the recent typical row count did not
# have 60% of the market take the day off.
SPARSE_SESSION_FRACTION = 0.40
SPARSE_MEDIAN_WINDOW = 21
SPARSE_MIN_PERIODS = 5

ADJ_SAMPLE_NAMES = 500
# Half a cent of quantisation on each of the four prices in a two-day
# return. Vendors round the adjusted series, and on a back-adjusted
# eighty-cent price that rounding alone is tens of basis points.
ADJ_QUANTUM = 0.005
ADJ_TOLERANCE_FLOOR = 2e-4
ADJ_WARN_RATE = 1e-3
# Below this relative gap the two closes are the same number wearing
# different rounding. Matches pointintime.DIVERGENCE_EPS, and is a
# question about the levels rather than about the returns, so it is
# deliberately not ADJ_TOLERANCE_FLOOR.
ADJ_IDENTITY_EPS = 1e-6

MAX_TABLE_ROWS = 40


# -- shared plumbing ----------------------------------------------------


def _ns(dates: pd.Series) -> pd.Series:
    """Normalise to nanosecond midnights before touching the calendar.

    The schema accepts datetime64 at any resolution, and an index built
    at microsecond precision will not align with the nanosecond one
    `exchange_calendars` hands back — it reindexes to all-NaN and the
    calendar check reports the entire panel as missing.
    """
    return dates.astype("datetime64[ns]").dt.normalize()


def _dstr(dates: pd.Series) -> pd.Series:
    return dates.dt.strftime("%Y-%m-%d").astype("str")


def _pct(x: float) -> str:
    return f"{x * 100:.3f}%"


def _no_rows(key: str, title: str, *, blocking: bool) -> CheckResult:
    """An empty panel proves nothing, so it must not read as a pass."""
    return CheckResult(
        key=key,
        title=title,
        verdict=Verdict.UNPROVABLE,
        blocking=blocking,
        headline="The price pull returned no rows; nothing could be tested.",
        unprovable_reason=(
            "There are no price bars in the audited range. An empty panel "
            "satisfies every coherence test trivially, which is exactly why "
            "it cannot count as passing one."
        ),
    )


def _exact_ordinal(dates: pd.Series, sessions: pd.DatetimeIndex) -> pd.Series:
    """Position on the session grid, NaN for dates that are not sessions."""
    lookup = pd.Series(np.arange(len(sessions), dtype="float64"), index=sessions)
    return _ns(dates).map(lookup)


def _projected_ordinal(dates: pd.Series, sessions: pd.DatetimeIndex) -> np.ndarray:
    """Position on the session grid, rounding forward to the next session.

    Corporate actions are dated by the filer, not by the tape, so a
    merger closes on a Saturday often enough to matter. Projecting it
    onto the following Monday keeps it inside the window of the bar it
    actually explains.
    """
    if len(sessions) == 0:
        return np.zeros(len(dates), dtype="int64")
    pos = sessions.searchsorted(pd.DatetimeIndex(_ns(dates)), side="left")
    return np.clip(pos, 0, len(sessions) - 1).astype("int64")


def _action_frame(ctx: AuditContext, sessions: pd.DatetimeIndex) -> pd.DataFrame:
    """Actions with a session ordinal attached, ready to merge against."""
    acts = ctx.actions
    if acts.empty:
        return pd.DataFrame(
            {
                "act_date": pd.Series([], dtype="datetime64[ns]"),
                "action": pd.Series([], dtype="str"),
                "ticker": pd.Series([], dtype="str"),
                "permaticker": pd.Series([], dtype="int64"),
                "sess": pd.Series([], dtype="int64"),
            }
        )
    out = pd.DataFrame(
        {
            "act_date": _ns(acts["date"]),
            "action": acts["action"].astype("str"),
            "ticker": acts["ticker"].astype("str"),
            "sess": _projected_ordinal(acts["date"], sessions),
        }
    )
    if "permaticker" in acts.columns:
        out["permaticker"] = acts["permaticker"]
    else:
        out["permaticker"] = pd.Series([pd.NA] * len(acts), dtype="Int64")
    return out


def _action_ordinals_by_key(
    acts: pd.DataFrame,
) -> tuple[dict[str, np.ndarray], dict[int, np.ndarray]]:
    """Sorted action ordinals per ticker and per permaticker.

    Both keys, because the actions frame carries permaticker only as an
    optional column and a null one there would otherwise silently mean
    "this name never had a corporate action".
    """
    by_ticker: dict[str, np.ndarray] = {}
    by_permaticker: dict[int, np.ndarray] = {}
    if acts.empty:
        return by_ticker, by_permaticker
    for tk, g in acts.groupby("ticker", sort=False):
        by_ticker[str(tk)] = np.sort(g["sess"].to_numpy(dtype="int64"))
    known = acts.dropna(subset=["permaticker"])
    for pt, g in known.groupby("permaticker", sort=False):
        by_permaticker[int(pt)] = np.sort(g["sess"].to_numpy(dtype="int64"))
    return by_ticker, by_permaticker


# -- 1. positive, self-consistent bars ----------------------------------


def check_no_nonpositive_prices(ctx: AuditContext) -> CheckResult:
    key = "quality.nonpositive_prices"
    title = "Prices are positive and each bar is internally consistent"
    guard = ctx.require(key, title, ["provides_unadjusted_prices"], blocking=True)
    if guard is not None:
        return guard

    px = ctx.prices
    if px.empty:
        return _no_rows(key, title, blocking=True)

    o = px["open_unadj"].to_numpy(dtype="float64")
    h = px["high_unadj"].to_numpy(dtype="float64")
    lo = px["low_unadj"].to_numpy(dtype="float64")
    c = px["close_unadj"].to_numpy(dtype="float64")

    # NaN fails every comparison below, so without this first mask a
    # missing close is the one broken bar that walks straight through a
    # test named "no nonpositive prices" and detonates later in a return.
    finite = np.isfinite(o) & np.isfinite(h) & np.isfinite(lo) & np.isfinite(c)
    not_a_number = ~finite

    nonpos_close = finite & (c <= 0)
    # Slightly beyond the name of the check on purpose: a zero low with
    # a positive close sits happily inside its own band and passes the
    # band test, then divides by zero in anything that computes a range.
    nonpos_ohl = finite & ~nonpos_close & ((o <= 0) | (h <= 0) | (lo <= 0))
    inverted = finite & (h < lo)
    # An inverted bar has no meaningful band, so testing the close
    # against it would report the same broken row twice under two
    # different explanations.
    outside = finite & ~inverted & ((c > h) | (c < lo))

    reason = np.select(
        [not_a_number, nonpos_close, nonpos_ohl, inverted, outside],
        [
            "price is not a number",
            "close <= 0",
            "open/high/low <= 0",
            "high < low",
            "close outside [low, high]",
        ],
        default="",
    )
    priority = np.select(
        [not_a_number | nonpos_close | nonpos_ohl, inverted, outside],
        [0, 1, 2],
        default=9,
    )
    with np.errstate(divide="ignore", invalid="ignore"):
        band = np.where(c > h, (c - h) / np.abs(h), (lo - c) / np.abs(lo))
        inv = (lo - h) / np.abs(lo)
    severity = np.select(
        [not_a_number | nonpos_close | nonpos_ohl, inverted, outside],
        [np.ones(len(px)), inv, band],
        default=0.0,
    )
    severity = np.nan_to_num(severity, nan=1.0, posinf=1.0, neginf=1.0)

    bad = reason != ""
    n_bad = int(bad.sum())

    result = CheckResult(
        key=key,
        title=title,
        verdict=Verdict.PASS if n_bad == 0 else Verdict.FAIL,
        blocking=True,
        headline=(
            f"All {len(px):,} bars are positive and self-consistent."
            if n_bad == 0
            else f"{n_bad:,} of {len(px):,} bars "
            f"({_pct(n_bad / len(px))}) are impossible as printed."
        ),
    )
    if n_bad == 0:
        result.add(Verdict.PASS, "No nonpositive, inverted or out-of-band bars.")
        return result

    viol = pd.DataFrame(
        {
            "permaticker": px["permaticker"].to_numpy(),
            "ticker": px["ticker"].to_numpy(),
            "date": _dstr(_ns(px["date"])).to_numpy(),
            "open": o,
            "high": h,
            "low": lo,
            "close": c,
            "reason": reason,
            "priority": priority,
            "severity": severity,
            "year": _ns(px["date"]).dt.year.to_numpy(),
        }
    ).loc[bad]

    by_year = viol.groupby(["year", "reason"], sort=True).size().unstack(fill_value=0)
    by_year.columns.name = None
    by_year = by_year.reset_index()
    by_year["total"] = by_year.drop(columns="year").sum(axis=1)
    result.tables["Impossible bars by year"] = by_year

    worst = (
        viol.sort_values(["priority", "severity"], ascending=[True, False])
        .head(10)
        .loc[
            :,
            ["permaticker", "ticker", "date", "open", "high", "low", "close", "reason"],
        ]
        .reset_index(drop=True)
    )
    result.tables["Ten worst bars"] = worst

    for label, count in viol["reason"].value_counts().items():
        first = viol.loc[viol["reason"] == label].iloc[0]
        result.add(
            Verdict.FAIL,
            f"{count:,} bar(s): {label}.",
            detail=(
                f"{first['ticker']} (permaticker {first['permaticker']}) on "
                f"{first['date']}: o={first['open']:.4f}, h={first['high']:.4f}, "
                f"l={first['low']:.4f}, c={first['close']:.4f}"
            ),
        )
    return result


# -- 2. calendar alignment ----------------------------------------------


def check_trading_calendar_alignment(ctx: AuditContext) -> CheckResult:
    key = "quality.calendar_alignment"
    title = "Price dates are real NYSE sessions, and sessions are populated"

    px = ctx.prices
    if px.empty:
        return _no_rows(key, title, blocking=True)

    sessions = ctx.sessions
    dates = _ns(px["date"])
    counts = dates.value_counts().sort_index()

    lo = pd.Timestamp(ctx.start).normalize()
    hi = pd.Timestamp(ctx.end).normalize()
    in_range = (counts.index >= lo) & (counts.index <= hi)
    out_of_range = counts.loc[~in_range]
    in_window = counts.loc[in_range]

    fabricated = in_window.loc[~in_window.index.isin(sessions)]

    per_session = in_window.reindex(sessions, fill_value=0)
    trailing = (
        per_session.shift(1)
        .rolling(SPARSE_MEDIAN_WINDOW, min_periods=SPARSE_MIN_PERIODS)
        .median()
    )
    sparse_mask = (trailing > 0) & (per_session < SPARSE_SESSION_FRACTION * trailing)
    sparse = per_session.loc[sparse_mask]

    covered = int((per_session > 0).sum())
    coverage = covered / len(sessions) * 100 if len(sessions) else float("nan")
    empty_sessions = len(sessions) - covered

    if len(fabricated):
        verdict = Verdict.FAIL
        headline = (
            f"{len(fabricated):,} price date(s) fall on days the NYSE was "
            f"closed ({int(fabricated.sum()):,} rows). Session coverage "
            f"{coverage:.2f}%."
        )
    elif len(sparse):
        verdict = Verdict.WARN
        headline = (
            f"Every price date is a real session, but {len(sparse):,} "
            f"session(s) carry implausibly few rows. Coverage {coverage:.2f}%."
        )
    else:
        verdict = Verdict.PASS
        headline = (
            f"All {len(in_window):,} price dates are NYSE sessions; "
            f"{coverage:.2f}% of the {len(sessions):,} sessions in range are "
            "populated."
        )

    # The two halves of this check mean opposite things and `blocking`
    # is one flag, so it follows whichever half fired. Fabricated dates
    # invalidate a backtest; a thin session is a gap in the pull and must
    # not be allowed to veto an otherwise sound dataset. A clean run
    # stays blocking so the report records that the half that matters
    # was genuinely tested.
    result = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=verdict is not Verdict.WARN,
        headline=headline,
    )
    result.tables["Session coverage"] = pd.DataFrame(
        [
            {
                "sessions_in_range": len(sessions),
                "sessions_with_rows": covered,
                "sessions_with_no_rows": empty_sessions,
                "coverage_pct": round(coverage, 3),
                "distinct_price_dates": len(counts),
            }
        ]
    )

    if len(fabricated):
        tbl = pd.DataFrame(
            {
                "date": fabricated.index.strftime("%Y-%m-%d"),
                "weekday": fabricated.index.day_name(),
                "rows": fabricated.to_numpy(),
            }
        )
        result.tables["Dates that are not NYSE sessions"] = tbl.head(MAX_TABLE_ROWS)
        worst = fabricated.sort_values(ascending=False).index[0]
        result.add(
            Verdict.FAIL,
            f"{len(fabricated):,} non-session date(s) carry price rows. These "
            "are bars for days on which nothing traded.",
            detail=(
                f"e.g. {worst.date().isoformat()} "
                f"({worst.day_name()}), {int(fabricated.loc[worst]):,} row(s)"
            ),
        )
    else:
        result.add(Verdict.PASS, "No price rows on non-session dates.")

    if len(sparse):
        tbl = pd.DataFrame(
            {
                "date": sparse.index.strftime("%Y-%m-%d"),
                "rows": sparse.to_numpy(),
                "trailing_median": trailing.loc[sparse_mask].round(0).to_numpy(),
            }
        )
        tbl["pct_of_median"] = (
            tbl["rows"] / tbl["trailing_median"].replace(0, np.nan) * 100
        ).round(1)
        result.tables["Sessions with implausibly few rows"] = tbl.head(MAX_TABLE_ROWS)
        thinnest = sparse.sort_values().index[0]
        result.add(
            Verdict.WARN,
            f"{len(sparse):,} session(s) hold under "
            f"{int(SPARSE_SESSION_FRACTION * 100)}% of the trailing "
            f"{SPARSE_MEDIAN_WINDOW}-session median row count, of which "
            f"{empty_sessions:,} are completely empty. That is a hole in the "
            "pull, not a market holiday.",
            detail=(
                f"e.g. {thinnest.date().isoformat()}: "
                f"{int(sparse.loc[thinnest]):,} rows against a trailing "
                f"median of {trailing.loc[thinnest]:,.0f}"
            ),
        )

    if len(out_of_range):
        result.add(
            Verdict.WARN,
            f"{len(out_of_range):,} price date(s) lie outside the requested "
            f"range {lo.date()}..{hi.date()} and were not tested against the "
            "calendar.",
            detail=(
                f"{out_of_range.index.min().date()} .. "
                f"{out_of_range.index.max().date()}, "
                f"{int(out_of_range.sum()):,} rows"
            ),
        )
    return result


# -- 3. duplicate bars ---------------------------------------------------


def check_duplicate_bars(ctx: AuditContext) -> CheckResult:
    key = "quality.duplicate_bars"
    title = "One bar per entity-day (and symbol collisions are not that)"
    guard = ctx.require(key, title, ["provides_permanent_ids"], blocking=True)
    if guard is not None:
        return guard

    px = ctx.prices
    if px.empty:
        return _no_rows(key, title, blocking=True)

    entity_dupe = px.duplicated(subset=["permaticker", "date"], keep=False).to_numpy()
    symbol_dupe = px.duplicated(subset=["ticker", "date"], keep=False).to_numpy()

    n_entity = int(entity_dupe.sum())

    # A symbol duplicate is only the interesting kind when the rows
    # belong to different companies, so the collision set is defined by
    # distinct permatickers rather than by subtracting the entity
    # duplicates — subtracting drops one side of every collision that
    # also happens to be corrupt and quietly reports the survivor as
    # sharing its symbol with nobody.
    symbol_only = np.zeros(len(px), dtype=bool)
    if symbol_dupe.any():
        shared = px.loc[symbol_dupe]
        n_owners = shared.groupby(["ticker", "date"])["permaticker"].transform(
            "nunique"
        )
        symbol_only[np.flatnonzero(symbol_dupe)] = n_owners.gt(1).to_numpy()
    n_symbol = int(symbol_only.sum())

    result = CheckResult(
        key=key,
        title=title,
        verdict=Verdict.FAIL if n_entity else Verdict.PASS,
        blocking=True,
        headline=(
            f"{n_entity:,} row(s) duplicate an existing (permaticker, date) "
            f"— the panel is double-counting entity-days."
            if n_entity
            else f"No duplicate entity-days; {n_symbol:,} row(s) share a "
            "(ticker, date) with a different company, which is expected."
        ),
    )

    if n_entity:
        dupes = px.loc[entity_dupe].sort_values(["permaticker", "date"])
        keys = (
            dupes.groupby(["permaticker", "date"]).size().sort_values(ascending=False)
        )
        tbl = (
            dupes.head(MAX_TABLE_ROWS)
            .assign(date=lambda d: _dstr(_ns(d["date"])))
            .loc[:, ["permaticker", "ticker", "date", "close_unadj", "volume_unadj"]]
            .reset_index(drop=True)
        )
        result.tables["Duplicated entity-days"] = tbl
        pt, dt = keys.index[0]
        result.add(
            Verdict.FAIL,
            f"{n_entity:,} row(s) across {len(keys):,} entity-day key(s) are "
            "duplicated. Every groupby below this point double-counts, and "
            "the first visible symptom is a weight vector that does not sum "
            "to one. Note that PRICES declares (permaticker, date) as its "
            "primary key, so a frame loaded through load_context could not "
            "reach here — this panel bypassed schema validation.",
            detail=(
                f"permaticker {pt} on {pd.Timestamp(dt).date()} appears "
                f"{int(keys.iloc[0])} times"
            ),
        )

    if n_symbol:
        coll = px.loc[symbol_only]
        pairs = (
            coll.groupby(["ticker", "date"])["permaticker"]
            .nunique()
            .sort_values(ascending=False)
        )
        tbl = (
            coll.sort_values(["ticker", "date"])
            .head(MAX_TABLE_ROWS)
            .assign(date=lambda d: _dstr(_ns(d["date"])))
            .loc[:, ["ticker", "date", "permaticker", "close_unadj"]]
            .reset_index(drop=True)
        )
        result.tables["Symbol collisions (expected, do not deduplicate)"] = tbl
        tk, dt = pairs.index[0]
        result.add(
            # Deliberately not a WARN. Someone reading a WARN reaches for
            # drop_duplicates(subset=["ticker", "date"]), and that deletes
            # a real company's bars.
            Verdict.PASS,
            f"{n_symbol:,} row(s) share a (ticker, date) with a DIFFERENT "
            "permaticker. This is the recycled-symbol case and is correct "
            "data: two companies held the same symbol. Deduplicating on "
            "(ticker, date) here would delete one of them.",
            detail=(
                f"e.g. {tk} on {pd.Timestamp(dt).date()} is carried by "
                f"{int(pairs.iloc[0])} distinct permatickers"
            ),
        )
    else:
        result.add(Verdict.PASS, "No symbol collisions in the audited range.")

    return result


# -- 4. unexplained jumps ------------------------------------------------


def check_unexplained_price_jumps(ctx: AuditContext) -> CheckResult:
    key = "quality.unexplained_jumps"
    title = "Large single-session moves have a corporate action behind them"
    guard = ctx.require(
        key,
        title,
        ["provides_unadjusted_prices", "provides_permanent_ids"],
        blocking=False,
    )
    if guard is not None:
        return guard

    px = ctx.prices
    if px.empty:
        return _no_rows(key, title, blocking=False)

    sessions = ctx.sessions
    df = px.loc[:, ["permaticker", "ticker", "date", "close_unadj"]].copy()
    df["date"] = _ns(df["date"])
    df["sess"] = _exact_ordinal(df["date"], sessions)
    # Bars off the session grid are the calendar check's business; a
    # phantom Saturday row here would only invent a jump twice.
    df = (
        df.loc[df["sess"].notna()]
        .sort_values(["permaticker", "date"], kind="stable")
        .reset_index(drop=True)
    )
    if df.empty:
        return _no_rows(key, title, blocking=False)
    df["sess"] = df["sess"].astype("int64")

    g = df.groupby("permaticker", sort=False)
    prev_close = g["close_unadj"].shift(1)
    prev_sess = g["sess"].shift(1)
    prev_date = g["date"].shift(1)

    # Only consecutive sessions count. A name that halts for a year and
    # resumes at a third of the price did not jump; it has a gap, and
    # counting gaps as jumps inflates the rate with exactly the names
    # whose history is already unusable.
    consecutive = (df["sess"] - prev_sess) == 1
    usable = (
        consecutive
        & prev_close.gt(0)
        & df["close_unadj"].gt(0)
        & np.isfinite(prev_close.to_numpy(dtype="float64"))
        & np.isfinite(df["close_unadj"].to_numpy(dtype="float64"))
    )
    ret = df["close_unadj"] / prev_close - 1.0
    comparable = int(usable.sum())
    jumped = usable & ret.abs().gt(JUMP_THRESHOLD)
    n_jumps = int(jumped.sum())

    acts = _action_frame(ctx, sessions)
    jumps = (
        df.loc[jumped]
        .assign(
            prev_close=prev_close.loc[jumped],
            prev_date=prev_date.loc[jumped],
            ret=ret.loc[jumped],
        )
        .sort_values("sess", kind="stable")
    )

    def _matched(left_key: str, right: pd.DataFrame) -> pd.Series:
        merged = pd.merge_asof(
            jumps.loc[:, ["sess", left_key]].assign(_i=jumps.index),
            right.loc[:, ["sess", left_key, "act_date"]],
            on="sess",
            by=left_key,
            direction="nearest",
            tolerance=JUMP_ACTION_WINDOW,
        )
        hit = pd.Series(
            merged["act_date"].notna().to_numpy(), index=merged["_i"].to_numpy()
        )
        return hit.reindex(jumps.index).fillna(False).astype(bool)

    explained = pd.Series(False, index=jumps.index, dtype=bool)
    if len(jumps) and not acts.empty:
        right = acts.sort_values("sess", kind="stable")
        explained |= _matched("ticker", right)
        known = right.dropna(subset=["permaticker"]).copy()
        if len(known):
            known["permaticker"] = known["permaticker"].astype("int64")
            explained |= _matched("permaticker", known)

    unexplained = jumps.loc[~explained]
    n_unexplained = len(unexplained)
    rate = (n_unexplained / comparable * 1e6) if comparable else 0.0

    if n_unexplained == 0:
        verdict = Verdict.PASS
    elif rate <= JUMP_WARN_PER_MILLION:
        verdict = Verdict.WARN
    else:
        verdict = Verdict.FAIL

    result = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=False,
        headline=(
            f"{n_unexplained:,} of {n_jumps:,} moves beyond "
            f"±{int(JUMP_THRESHOLD * 100)}% have no action within "
            f"±{JUMP_ACTION_WINDOW} sessions: {rate:.2f} per million "
            f"comparable bars ({comparable:,} examined)."
        ),
    )
    result.tables["Jump scan"] = pd.DataFrame(
        [
            {
                "price_rows": len(px),
                "comparable_consecutive_pairs": comparable,
                "moves_over_threshold": n_jumps,
                "explained_by_an_action": n_jumps - n_unexplained,
                "unexplained": n_unexplained,
                "per_million_bars": round(rate, 3),
                "action_rows_searched": len(acts),
            }
        ]
    )

    if n_unexplained:
        worst = unexplained.reindex(
            unexplained["ret"].abs().sort_values(ascending=False).index
        ).head(20)
        tbl = pd.DataFrame(
            {
                "permaticker": worst["permaticker"].to_numpy(),
                "ticker": worst["ticker"].to_numpy(),
                "prev_date": _dstr(worst["prev_date"]).to_numpy(),
                "date": _dstr(worst["date"]).to_numpy(),
                "prev_close": worst["prev_close"].round(4).to_numpy(),
                "close": worst["close_unadj"].round(4).to_numpy(),
                "move_pct": (worst["ret"] * 100).round(1).to_numpy(),
            }
        )
        # Show what the search actually turned up for these names, not
        # merely that the window was empty. "Nothing on record for this
        # ticker, ever" and "a split eleven sessions away" are different
        # diagnoses — the first is a missing action row, the second a
        # date convention we are failing to handle — and the fix differs.
        nearest_label = np.full(
            len(worst), "no action on record for this ticker", dtype=object
        )
        gap_days = np.full(len(worst), np.nan)
        if not acts.empty:
            probe = pd.merge_asof(
                worst.loc[:, ["sess", "ticker"]]
                .assign(_i=np.arange(len(worst)))
                .sort_values("sess", kind="stable"),
                acts.sort_values("sess", kind="stable").loc[
                    :, ["sess", "ticker", "act_date", "action"]
                ],
                on="sess",
                by="ticker",
                direction="nearest",
            ).sort_values("_i")
            found = probe["act_date"].notna().to_numpy()
            nearest_label = np.where(
                found,
                probe["action"].astype("str")
                + " on "
                + probe["act_date"].dt.strftime("%Y-%m-%d").astype("str"),
                nearest_label,
            )
            gap_days = (
                (probe["act_date"].to_numpy() - worst["date"].to_numpy())
                / np.timedelta64(1, "D")
            )
        tbl["nearest_action"] = nearest_label
        tbl["calendar_days_away"] = gap_days
        result.tables["Twenty worst unexplained moves"] = tbl

        top = worst.iloc[0]
        result.add(
            verdict,
            f"{n_unexplained:,} single-session move(s) beyond "
            f"±{int(JUMP_THRESHOLD * 100)}% with no split, merger or other "
            f"action within ±{JUMP_ACTION_WINDOW} sessions. These are almost "
            "always unrecorded splits — a 4-for-1 that nobody logged reads as "
            "a 75% loss, and a backtest will size into it.",
            detail=(
                f"{top['ticker']} (permaticker {top['permaticker']}) "
                f"{top['prev_date'].date()} → {top['date'].date()}: "
                f"{top['prev_close']:,.4f} → {top['close_unadj']:,.4f} "
                f"({top['ret'] * 100:+.1f}%)"
            ),
        )
    elif n_jumps == 0:
        # "Every one of the 0 moves is explained" is true of any panel
        # whatsoever, and it is the sentence a reader skims as proof the
        # action record is complete. Say the denominator was empty
        # instead: nothing here is wrong, and nothing here was shown.
        result.add(
            Verdict.PASS,
            f"No single-session move beyond ±{int(JUMP_THRESHOLD * 100)}% "
            f"occurs anywhere in the {comparable:,} comparable bar(s), so "
            "the action record was never asked to explain one. Nothing "
            "was found wrong and nothing was demonstrated.",
        )
    else:
        result.add(
            Verdict.PASS,
            f"Every one of the {n_jumps:,} move(s) beyond "
            f"±{int(JUMP_THRESHOLD * 100)}% has a corporate action nearby.",
        )
    return result


# -- 5. zero-volume bars -------------------------------------------------


def check_zero_volume_bars(ctx: AuditContext) -> CheckResult:
    key = "quality.zero_volume"
    title = "Bars represent trades, not carried-forward quotes"
    guard = ctx.require(
        key, title, ["provides_unadjusted_prices"], blocking=False
    )
    if guard is not None:
        return guard

    px = ctx.prices
    if px.empty:
        return _no_rows(key, title, blocking=False)

    vol = px["volume_unadj"]
    zero = vol.eq(0).to_numpy()
    missing = vol.isna().to_numpy()
    share = float(zero.mean())

    if share > ZERO_VOLUME_FAIL:
        verdict = Verdict.FAIL
    elif share > ZERO_VOLUME_WARN:
        verdict = Verdict.WARN
    else:
        verdict = Verdict.PASS

    result = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=False,
        headline=(
            f"{int(zero.sum()):,} of {len(px):,} bars ({_pct(share)}) print "
            f"zero volume; {int(missing.sum()):,} carry no volume at all."
        ),
    )

    year = _ns(px["date"]).dt.year
    by_year = (
        pd.DataFrame({"year": year.to_numpy(), "zero": zero, "missing": missing})
        .groupby("year", sort=True)
        .agg(
            bars=("zero", "size"),
            zero_volume=("zero", "sum"),
            no_volume=("missing", "sum"),
        )
        .reset_index()
    )
    by_year["zero_pct"] = (by_year["zero_volume"] / by_year["bars"] * 100).round(2)
    result.tables["Zero-volume bars by year"] = by_year

    if zero.any():
        per_name = (
            pd.DataFrame(
                {
                    "permaticker": px["permaticker"].to_numpy(),
                    "ticker": px["ticker"].to_numpy(),
                    "zero": zero,
                }
            )
            .groupby(["permaticker", "ticker"], sort=False)
            .agg(bars=("zero", "size"), zero_volume=("zero", "sum"))
            .reset_index()
        )
        # A name with nine bars, all untraded, is noise. Requiring a
        # quarter of history keeps the table pointed at names a strategy
        # could actually have held.
        per_name = per_name.loc[per_name["bars"] >= 60].copy()
        if len(per_name):
            per_name["zero_pct"] = (
                per_name["zero_volume"] / per_name["bars"] * 100
            ).round(1)
            per_name = per_name.sort_values(
                ["zero_pct", "zero_volume"], ascending=False
            ).head(15)
            result.tables[
                "Names with the most zero-volume bars"
            ] = per_name.reset_index(drop=True)

    if verdict is Verdict.PASS:
        result.add(
            Verdict.PASS,
            f"Zero-volume bars are {_pct(share)} of the panel, inside the "
            f"{int(ZERO_VOLUME_WARN * 100)}% tolerance.",
        )
    else:
        worst_year = by_year.sort_values("zero_pct", ascending=False).iloc[0]
        result.add(
            verdict,
            f"{_pct(share)} of bars have zero volume. Above a few percent "
            "this stops being illiquidity and starts being quotes carried "
            "forward as trades — and a fill model will happily transact "
            "against every one of them at a price nobody paid.",
            detail=(
                f"worst year {int(worst_year['year'])}: "
                f"{int(worst_year['zero_volume']):,} of "
                f"{int(worst_year['bars']):,} bars "
                f"({worst_year['zero_pct']}%)"
            ),
        )
    if missing.any():
        result.add(
            Verdict.WARN,
            f"{int(missing.sum()):,} bar(s) have no volume figure at all, "
            "which a liquidity screen reads as neither passing nor failing.",
            detail=f"{_pct(float(missing.mean()))} of the panel",
        )
    return result


# -- 6. adjusted vs unadjusted returns -----------------------------------


def _sample_names(names: np.ndarray, limit: int) -> np.ndarray:
    """An evenly-spaced stride over the sorted ids, never a draw.

    Deterministic without a seed. A seeded RNG would also be
    reproducible, but only for as long as nobody edits the constant, and
    a stride over ids that are roughly assignment-ordered covers old
    listings and new ones instead of clustering wherever the generator
    happened to land.
    """
    if len(names) <= limit:
        return names
    idx = np.unique(np.linspace(0, len(names) - 1, limit).round().astype("int64"))
    return names[idx]


def check_adjustment_consistency(ctx: AuditContext) -> CheckResult:
    key = "quality.adjustment_consistency"
    title = "Adjusted and unadjusted returns agree away from corporate actions"
    guard = ctx.require(
        key,
        title,
        ["provides_unadjusted_prices", "provides_permanent_ids"],
        blocking=True,
    )
    if guard is not None:
        return guard

    px = ctx.prices
    if px.empty:
        return _no_rows(key, title, blocking=True)

    sessions = ctx.sessions
    cols = ["permaticker", "ticker", "date", "close_unadj", "close_adj"]
    extras = [c for c in ("dividends", "split_factor") if c in px.columns]
    df = px.loc[:, cols + extras].copy()
    df["date"] = _ns(df["date"])
    df["sess"] = _exact_ordinal(df["date"], sessions)
    df = df.loc[df["sess"].notna()].copy()
    if df.empty:
        return _no_rows(key, title, blocking=True)
    df["sess"] = df["sess"].astype("int64")

    all_names = np.sort(df["permaticker"].unique())
    sampled = _sample_names(all_names, ADJ_SAMPLE_NAMES)
    full_coverage = len(sampled) == len(all_names)
    how = (
        f"every one of the {len(all_names):,} names in the panel"
        if full_coverage
        else f"{len(sampled):,} of {len(all_names):,} names, taken as an "
        "evenly-spaced stride over the sorted permatickers"
    )

    sub = df.loc[df["permaticker"].isin(sampled)].sort_values(
        ["permaticker", "date"], kind="stable"
    )
    acts = _action_frame(ctx, sessions)
    by_ticker, by_permaticker = _action_ordinals_by_key(acts)

    compared = 0
    skipped_for_action = 0
    examples: list[dict] = []
    per_name: dict[int, int] = {}

    for pt, g in sub.groupby("permaticker", sort=False):
        if len(g) < 2:
            continue
        adj = g["close_adj"].to_numpy(dtype="float64")
        una = g["close_unadj"].to_numpy(dtype="float64")
        ordn = g["sess"].to_numpy(dtype="int64")
        dates = g["date"].to_numpy()
        # Every symbol the name has worn, not just the first. A ticker
        # change is exactly the moment an action exists, and looking
        # only under the old symbol would leave the one day that is
        # allowed to differ counted as a defect.
        tickers = [str(t) for t in pd.unique(g["ticker"])]

        good = (adj[1:] > 0) & (adj[:-1] > 0) & (una[1:] > 0) & (una[:-1] > 0)
        good &= np.isfinite(adj[1:]) & np.isfinite(adj[:-1])
        good &= np.isfinite(una[1:]) & np.isfinite(una[:-1])

        # A dividend or split anywhere between the two closes is a day
        # the series are SUPPOSED to differ. The window is widened by a
        # session on each side because vendors disagree by a day on
        # whether an action is stamped at its ex- or its effective date,
        # and it spans the whole gap rather than just the two endpoints
        # so an action inside a trading halt is not missed.
        keys = [by_permaticker.get(int(pt))] + [by_ticker.get(t) for t in tickers]
        has_action = np.zeros(len(adj) - 1, dtype=bool)
        for arr in keys:
            if arr is None or not len(arr):
                continue
            lo_i = np.searchsorted(arr, ordn[:-1] - 1, side="left")
            hi_i = np.searchsorted(arr, ordn[1:] + 1, side="right")
            has_action |= hi_i > lo_i
        for col in extras:
            marks = g[col].to_numpy(dtype="float64")
            if col == "dividends":
                flag = np.nan_to_num(marks, nan=0.0) != 0.0
            else:
                flag = np.nan_to_num(marks, nan=1.0) != 1.0
            has_action |= flag[1:] | flag[:-1]

        usable = good & ~has_action
        skipped_for_action += int((good & has_action).sum())
        n = int(usable.sum())
        if not n:
            continue
        compared += n

        r_adj = adj[1:] / adj[:-1] - 1.0
        r_una = una[1:] / una[:-1] - 1.0
        diff = np.abs(r_adj - r_una)
        tol = ADJ_TOLERANCE_FLOOR + ADJ_QUANTUM * (
            1.0 / adj[1:] + 1.0 / adj[:-1] + 1.0 / una[1:] + 1.0 / una[:-1]
        )
        bad = usable & (diff > tol)
        n_bad = int(bad.sum())
        if not n_bad:
            continue
        per_name[int(pt)] = n_bad
        if len(examples) < 2000:
            for i in np.flatnonzero(bad)[:20]:
                examples.append(
                    {
                        "permaticker": int(pt),
                        "ticker": tickers[0],
                        "prev_date": pd.Timestamp(dates[i]).date().isoformat(),
                        "date": pd.Timestamp(dates[i + 1]).date().isoformat(),
                        "adj_return_pct": round(float(r_adj[i]) * 100, 4),
                        "unadj_return_pct": round(float(r_una[i]) * 100, 4),
                        "gap_bps": round(float(diff[i]) * 1e4, 2),
                        "tolerance_bps": round(float(tol[i]) * 1e4, 2),
                    }
                )

    n_bad_total = int(sum(per_name.values()))
    rate = (n_bad_total / compared) if compared else 0.0

    if compared == 0:
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            blocking=True,
            headline=(
                "No action-free consecutive session pairs survived the "
                f"filters ({how}); the two series were never compared."
            ),
            unprovable_reason=(
                "Every candidate day was either non-finite, non-positive or "
                "sat next to a corporate action, so there was no day on "
                "which the adjusted and unadjusted series were required to "
                "agree. Nothing was tested."
            ),
        )

    # Perfect agreement is only evidence once there are two series to
    # agree. A source returning the adjusted close under both headings
    # produces flawless agreement on every pair it is given, and this
    # check would report that as a blocking PASS over 1.4 million
    # comparisons — corroborating, in the most quantitative language in
    # the report, the very defect pit_unadjusted_prices_available is
    # failing two sections above. The levels are asked about rather than
    # the returns, because two identical series also have identical
    # returns and the tautology is invisible from where the arithmetic
    # ends up.
    if n_bad_total == 0:
        both = df["close_adj"].notna() & df["close_unadj"].notna() & (
            df["close_unadj"] != 0
        )
        rel = (
            (df.loc[both, "close_adj"] / df.loc[both, "close_unadj"] - 1.0).abs()
            if both.any()
            else None
        )
        if rel is not None and not bool((rel > ADJ_IDENTITY_EPS).any()):
            return CheckResult(
                key=key,
                title=title,
                verdict=Verdict.UNPROVABLE,
                blocking=True,
                headline=(
                    "close_adj and close_unadj are identical on every row, "
                    "so their returns agree by construction and the "
                    f"{compared:,} pairs compared prove nothing."
                ),
                unprovable_reason=(
                    "This check asks whether the adjustment factors were "
                    "applied on the right dates, which it can only answer "
                    "by watching two independent series diverge and "
                    "reconverge around the days an action falls. Here "
                    "there is one series carrying two names: it agrees "
                    "with itself perfectly whether the adjustments are "
                    "right, wrong, or absent. Nothing was tested — see "
                    "pit_unadjusted_prices_available."
                ),
            )

    if n_bad_total == 0:
        verdict = Verdict.PASS
    elif rate < ADJ_WARN_RATE:
        verdict = Verdict.WARN
    else:
        verdict = Verdict.FAIL

    result = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=True,
        headline=(
            f"{n_bad_total:,} of {compared:,} action-free session pairs "
            f"({_pct(rate)}) show adjusted and unadjusted returns "
            f"disagreeing beyond rounding, across {len(per_name):,} name(s). "
            f"Sampled {how}."
        ),
    )
    # State the sample in the tables as well as the headline. A sampled
    # result printed without its denominator reads as full coverage, and
    # the reader who most needs to know is the one skimming.
    result.tables["How this was sampled"] = pd.DataFrame(
        [
            {
                "names_in_panel": len(all_names),
                "names_compared": len(sampled),
                "method": (
                    "all" if full_coverage else "even stride over permatickers"
                ),
                "session_pairs_compared": compared,
                "pairs_skipped_next_to_an_action": skipped_for_action,
                "tolerance": (
                    f"{ADJ_TOLERANCE_FLOOR * 1e4:.0f}bp + half-cent rounding "
                    "on all four prices"
                ),
            }
        ]
    )

    if examples:
        ex = pd.DataFrame(examples).sort_values("gap_bps", ascending=False)
        result.tables["Worst disagreements"] = ex.head(20).reset_index(drop=True)
        counts = (
            pd.Series(per_name, name="disagreeing_days")
            .rename_axis("permaticker")
            .sort_values(ascending=False)
            .head(15)
            .reset_index()
        )
        result.tables["Names with the most disagreements"] = counts
        top = ex.iloc[0]
        result.add(
            verdict,
            f"On {n_bad_total:,} day(s) with no dividend and no split on "
            "record, the adjusted series implies a different return from the "
            "as-traded one. That is an adjustment factor applied on the wrong "
            "date: the return is real but it has been moved into a "
            "neighbouring day, which no amount of care downstream can undo.",
            detail=(
                f"{top['ticker']} (permaticker {top['permaticker']}) "
                f"{top['prev_date']} → {top['date']}: adjusted "
                f"{top['adj_return_pct']:+.4f}% vs as-traded "
                f"{top['unadj_return_pct']:+.4f}% "
                f"({top['gap_bps']}bp apart, tolerance "
                f"{top['tolerance_bps']}bp)"
            ),
        )
    else:
        result.add(
            Verdict.PASS,
            f"The two series agree on all {compared:,} action-free session "
            f"pairs compared ({how}).",
        )
    return result


CHECKS: list[Callable[[AuditContext], CheckResult]] = [
    check_no_nonpositive_prices,
    check_trading_calendar_alignment,
    check_duplicate_bars,
    check_unexplained_price_jumps,
    check_zero_volume_bars,
    check_adjustment_consistency,
]
