"""Checks that ask whether the panel knows only what the day knew.

Survivorship and point-in-time are different failures and this module
owns the second. A panel can retain every company that ever died and
still be unusable, because it stamps a 10-K onto the quarter it
describes rather than the day it was filed, or serves a 2013
restatement under a 2011 date, or lets a five-dollar price floor read
a back-adjusted series. None of that shows up as a missing row. It
shows up as a Sharpe ratio nobody could have earned.

The centre of gravity here is `check_adjusted_price_screen_leak`. It
counts the names that clear a price screen on the adjusted series and
fail it as traded, which is not a defect in the data at all — it is a
measurement of how much of the future a careless filter imports, and
it exists so that nobody has to take the distinction on faith.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .. import config
from .context import AuditContext
from .result import CheckResult, Verdict

#: Three calendar days spans a weekend plus a holiday, which is as wide
#: as an honest disagreement between the master's listing dates and the
#: price file's own first and last row can get. Past that, a row is
#: sitting in a window it does not belong to.
LISTING_WINDOW_TOLERANCE_DAYS = 3

#: A 10-Q takes about forty days and a 10-K about sixty. A median under
#: three weeks means these are not filing dates at all; a median past
#: four months means something is being stamped with the day the vendor
#: loaded it rather than the day the market saw it.
FAST_MEDIAN_LAG_DAYS = 20
SLOW_MEDIAN_LAG_DAYS = 120

#: Enough sample dates to see the shape of the leak across two decades
#: without turning the report into a spreadsheet. Spread evenly and
#: never drawn at random: the number has to come out the same next week
#: or it is an anecdote rather than a measurement.
SCREEN_SAMPLE_DATES = 24

#: A name whose last price sits within a month of the end of the pull
#: has not necessarily stopped trading — the pull might simply stop
#: there. Only a stop well inside the window is one we can demand an
#: explanation for.
DELISTING_TAIL_BUFFER_DAYS = 30

#: Substrings that mark an action as the end of a security's life. Prose
#: from a vendor, matched loosely on purpose; the alternative is a
#: closed list that silently misses "Acquired by merger" the first time
#: someone rewords it.
TERMINAL_ACTIONS = (
    "delist",
    "merge",
    "acquis",
    "bankrupt",
    "liquidat",
    "dissol",
    "deregist",
)

#: Below this relative gap the two closes are the same number wearing
#: different rounding, which is not evidence of an adjustment.
DIVERGENCE_EPS = 1e-6

#: A split on the first day of the pulled window leaves no earlier rows
#: to be adjusted, so a handful of split names showing no divergence is
#: geometry rather than a bug. A quarter of them is not geometry.
SPLIT_NO_DIVERGENCE_FAIL_SHARE = 0.25

#: Dividend payers are softer: plenty of vendors adjust for splits only,
#: which is a defensible convention and a dangerous one, because the
#: resulting series is a price return being read as a total return.
DIVIDEND_NO_DIVERGENCE_WARN_SHARE = 0.50


# -- small shared helpers -----------------------------------------------


def _no_evidence(
    key: str,
    title: str,
    headline: str,
    reason: str,
    *,
    blocking: bool = True,
) -> CheckResult:
    return CheckResult(
        key=key,
        title=title,
        verdict=Verdict.UNPROVABLE,
        headline=headline,
        blocking=blocking,
        unprovable_reason=reason,
    )


def _examples(df: pd.DataFrame, cols: list[str], n: int = 25) -> pd.DataFrame:
    keep = [c for c in cols if c in df.columns]
    return df.loc[:, keep].head(n).reset_index(drop=True)


def _pct(part: float, whole: float) -> float:
    return round(100.0 * part / whole, 3) if whole else float("nan")


def _n(count: int, singular: str, plural: str | None = None) -> str:
    """Count and noun, agreeing. Findings get read out loud in review."""
    word = singular if count == 1 else (plural or singular + "s")
    return f"{count:,} {word}"


def _fundamentals_or_reason(ctx: AuditContext) -> tuple[pd.DataFrame | None, str]:
    """The frame to test, or why there is nothing to test on."""
    if ctx.fundamentals is None:
        return None, (
            "This source does not implement a fundamentals frame at all, "
            "so no point-in-time property of it was examined. Nothing was "
            "tested — this is not a pass."
        )
    if ctx.fundamentals.empty:
        return None, (
            "The fundamentals frame came back with no rows over "
            f"{ctx.start.isoformat()} to {ctx.end.isoformat()}, so there "
            "was nothing to examine. An empty pull and a clean pull look "
            "identical from here, which is exactly why this is not a pass."
        )
    return ctx.fundamentals, ""


def _single_name_ids(ctx: AuditContext) -> tuple[set[int] | None, str]:
    """Permatickers eligible for the single-name price screen.

    Falls back to the whole panel when the vendor's category strings do
    not meet our allowlist, because measuring the leak across everything
    is more useful than measuring it across nothing — but the report has
    to say which of the two it did.
    """
    master = ctx.master
    if "category" not in master.columns:
        return None, "no category column; every priced name counted"
    hit = master.loc[
        master["category"].isin(config.SINGLE_NAME_CATEGORIES), "permaticker"
    ]
    if hit.empty:
        return None, (
            "no vendor category matched config.SINGLE_NAME_CATEGORIES; "
            "every priced name counted"
        )
    return set(hit.astype("int64").tolist()), (
        f"restricted to the {len(hit):,} entities whose category is in "
        "config.SINGLE_NAME_CATEGORIES"
    )


def _corporate_event_ids(ctx: AuditContext) -> tuple[set[int], set[int], list[str]]:
    """Entities that had a split, and entities that paid a dividend.

    Read from the price frame's own event columns first and the actions
    frame second, and only ever keyed on permaticker. Matching a
    corporate action to a company by ticker is the join this whole
    schema exists to prevent, and doing it here to pad a denominator
    would be a poor trade.
    """
    px, act = ctx.prices, ctx.actions
    splits: set[int] = set()
    divs: set[int] = set()
    notes: list[str] = []

    if "split_factor" in px.columns:
        m = px["split_factor"].notna() & (px["split_factor"] != 1.0)
        splits |= set(px.loc[m, "permaticker"].astype("int64").unique().tolist())
        notes.append("splits from prices.split_factor")
    if "dividends" in px.columns:
        m = px["dividends"].notna() & (px["dividends"] > 0)
        divs |= set(px.loc[m, "permaticker"].astype("int64").unique().tolist())
        notes.append("dividends from prices.dividends")

    if "permaticker" in act.columns and act["permaticker"].notna().any():
        known = act.loc[act["permaticker"].notna()]
        s = known["action"].str.contains("split", case=False, na=False)
        d = known["action"].str.contains("dividend", case=False, na=False)
        if bool(s.any()):
            splits |= set(known.loc[s, "permaticker"].astype("int64").tolist())
            notes.append("splits from actions")
        if bool(d.any()):
            divs |= set(known.loc[d, "permaticker"].astype("int64").tolist())
            notes.append("dividends from actions")

    return splits, divs, notes


# -- 1. is there a publication date at all ------------------------------


def check_filing_dates_present(ctx: AuditContext) -> CheckResult:
    """A period end is not an availability date, and the gap is a quarter.

    Everything else in this file assumes there is a real date to lag
    from. Where there is not, the pipeline falls back to a single
    constant applied to every filer alike, and the honest thing to
    report is that the panel was never point-in-time — not that it
    passed.
    """
    key = "pit_filing_dates_present"
    title = "Fundamentals carry a publication date, not just a period end"

    guard = ctx.require(key, title, ["provides_filing_dates"])
    if guard is not None:
        guard.unprovable_reason = (guard.unprovable_reason or "") + (
            " Every fundamental will therefore be lagged by "
            f"config.FALLBACK_FUNDAMENTAL_LAG_DAYS "
            f"({config.FALLBACK_FUNDAMENTAL_LAG_DAYS} calendar days). That "
            "constant is a guess applied to every filer at once, not a "
            "fact about any of them: it is early for the slow filers, "
            "which leaks, and late for the fast ones, which merely costs "
            "edge. Nothing here demonstrates the panel is point-in-time."
        )
        guard.add(
            Verdict.WARN,
            "Fundamentals fall back to a fixed lag.",
            f"config.FALLBACK_FUNDAMENTAL_LAG_DAYS = "
            f"{config.FALLBACK_FUNDAMENTAL_LAG_DAYS} days",
        )
        return guard

    fund, gap = _fundamentals_or_reason(ctx)
    if fund is None:
        return _no_evidence(key, title, "No fundamental rows to examine.", gap)

    n = len(fund)
    missing = int(fund["date_public"].isna().sum())
    both = fund["date_public"].notna() & fund["period_end"].notna()
    same_mask = both & (fund["date_public"] == fund["period_end"])
    identical = int(same_mask.sum())
    distinct = n - missing - identical

    summary = pd.DataFrame(
        {
            "metric": [
                "fundamental rows",
                "date_public missing",
                "date_public == period_end",
                "date_public distinct from period_end",
            ],
            "rows": [n, missing, identical, distinct],
            "share_pct": [
                100.0,
                _pct(missing, n),
                _pct(identical, n),
                _pct(distinct, n),
            ],
        }
    )

    if missing:
        verdict = Verdict.FAIL
        headline = (
            f"No publication date on {_n(missing, 'row')} of {n:,} "
            f"({_pct(missing, n)}%), so nothing says when the figures "
            "became knowable."
        )
    elif identical == n:
        verdict = Verdict.FAIL
        headline = (
            "date_public is a copy of period_end on every row: the source "
            "is presenting the quarter end as the availability date."
        )
    elif identical:
        verdict = Verdict.WARN
        headline = (
            f"Dated public on the day the period closed: "
            f"{_n(identical, 'row')} ({_pct(identical, n)}%). The rest "
            "carry a real filing date."
        )
    else:
        verdict = Verdict.PASS
        headline = (
            f"All {n:,} fundamental rows carry a publication date distinct "
            "from the period they describe."
        )

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        headline=headline,
        blocking=True,
        tables={"date_public coverage": summary},
    )

    if missing:
        res.add(
            Verdict.FAIL,
            "Rows with no publication date cannot be lagged honestly.",
            f"{_n(missing, 'row')}; first offender "
            f"{_first_label(fund.loc[fund['date_public'].isna()])}",
        )
        res.tables["rows with no publication date"] = _examples(
            fund.loc[fund["date_public"].isna()],
            ["permaticker", "ticker", "dimension", "period_end", "date_public"],
        )
    if identical:
        res.add(
            Verdict.FAIL if identical == n else Verdict.WARN,
            "A filing cannot be public on the day the period closed.",
            f"{_n(identical, 'row')}; see the filing-lag check, which "
            "counts these as impossible lags and tabulates them",
        )
        res.tables["published on the period end"] = _examples(
            fund.loc[same_mask],
            ["permaticker", "ticker", "dimension", "period_end", "date_public"],
        )

    return res


def _first_label(df: pd.DataFrame) -> str:
    if df.empty:
        return "none"
    row = df.iloc[0]
    tick = row.get("ticker", "?")
    period = row.get("period_end", "?")
    period = period.date().isoformat() if isinstance(period, pd.Timestamp) else "?"
    return f"{tick} period ending {period}"


# -- 2. is the lag physically possible, and plausibly sized -------------


def check_filing_lag_distribution(ctx: AuditContext) -> CheckResult:
    """The shape of the lag is the tell; a column of dates proves nothing.

    A non-positive lag is not a data-quality wobble, it is a figure that
    was available before the period it describes had finished, and any
    signal built on it is reading the answer. The two median bands catch
    the subtler versions: a column that is really the period end plus a
    constant, and a column that is really the vendor's load date.
    """
    key = "pit_filing_lag_distribution"
    title = "Filing lag is possible and plausibly sized"

    guard = ctx.require(key, title, ["provides_filing_dates"])
    if guard is not None:
        return guard

    fund, gap = _fundamentals_or_reason(ctx)
    if fund is None:
        return _no_evidence(key, title, "No fundamental rows to examine.", gap)

    usable = fund.loc[
        fund["date_public"].notna() & fund["period_end"].notna()
    ].copy()
    undated = len(fund) - len(usable)
    if usable.empty:
        return _no_evidence(
            key,
            title,
            "No fundamental row carries both dates.",
            "Every row is missing either period_end or date_public, so no "
            "lag could be computed. The distribution below would have been "
            "the evidence; there is none.",
        )

    usable = usable.assign(
        lag_days=(usable["date_public"] - usable["period_end"]).dt.days
    )
    lag = usable["lag_days"]

    qs = {
        "min": float(lag.min()),
        "p1": float(lag.quantile(0.01)),
        "p5": float(lag.quantile(0.05)),
        "p25": float(lag.quantile(0.25)),
        "p50": float(lag.quantile(0.50)),
        "p75": float(lag.quantile(0.75)),
        "p95": float(lag.quantile(0.95)),
        "p99": float(lag.quantile(0.99)),
        "max": float(lag.max()),
    }
    percentiles = pd.DataFrame(
        {
            "statistic": list(qs.keys()),
            "lag_days": [round(v, 1) for v in qs.values()],
        }
    )

    impossible = usable.loc[lag <= 0].sort_values(
        ["lag_days", "permaticker", "period_end"], kind="stable"
    )
    median = qs["p50"]
    offender_cols = [
        "permaticker",
        "ticker",
        "dimension",
        "period_end",
        "date_public",
        "lag_days",
    ]

    res = CheckResult(
        key=key,
        title=title,
        verdict=Verdict.PASS,
        headline="",
        blocking=True,
        tables={"filing lag percentiles (days)": percentiles},
    )

    if not impossible.empty:
        res.verdict = Verdict.FAIL
        worst = impossible.iloc[0]
        res.add(
            Verdict.FAIL,
            "Figures dated public on or before the period they describe "
            "had ended.",
            f"{_n(len(impossible), 'row')}; worst is {worst['ticker']} "
            f"(permaticker {int(worst['permaticker'])}) period ending "
            f"{worst['period_end'].date()} dated public "
            f"{worst['date_public'].date()}, a lag of "
            f"{int(worst['lag_days'])} days",
        )
        res.tables["worst offenders"] = _examples(impossible, offender_cols)
    else:
        # With nothing impossible in the frame, the interesting tail is
        # the other one: a filing that surfaced a year after its quarter
        # is either a delinquent filer or a back-stamp, and the two are
        # worth telling apart by hand.
        longest = usable.sort_values(
            ["lag_days", "permaticker"], ascending=[False, True], kind="stable"
        )
        res.tables["worst offenders"] = _examples(longest, offender_cols)

    if median < FAST_MEDIAN_LAG_DAYS:
        if res.verdict is not Verdict.FAIL:
            res.verdict = Verdict.WARN
        res.add(
            Verdict.WARN,
            "Median filing lag is faster than a 10-Q can be filed.",
            f"median {median:.0f} days, below the "
            f"{FAST_MEDIAN_LAG_DAYS}-day floor a real filing calendar "
            "respects",
        )
    elif median > SLOW_MEDIAN_LAG_DAYS:
        if res.verdict is not Verdict.FAIL:
            res.verdict = Verdict.WARN
        res.add(
            Verdict.WARN,
            "Median filing lag is long enough to suggest a load date "
            "rather than a filing date.",
            f"median {median:.0f} days, above the "
            f"{SLOW_MEDIAN_LAG_DAYS}-day ceiling",
        )

    if undated:
        res.add(
            Verdict.WARN,
            "Rows excluded from the distribution for want of a date.",
            f"{_n(undated, 'row')} of {len(fund):,}",
        )

    res.headline = (
        f"Median lag {median:.0f} days (p5 {qs['p5']:.0f}, p95 "
        f"{qs['p95']:.0f}, max {qs['max']:.0f}); "
        + (
            f"public on or before the period end: "
            f"{_n(len(impossible), 'row')}."
            if not impossible.empty
            else "no row predates the period it describes."
        )
    )
    return res


# -- 3. as reported, or quietly restated --------------------------------


def check_as_reported_dimension(ctx: AuditContext) -> CheckResult:
    """Restatement lookahead survives perfect filing dates.

    An MR* row can carry a flawless publication date and still be the
    number the company published two years later, which is why this is
    a separate check rather than a clause in the one above. The failure
    is invisible in every date column and shows up only as a quality
    factor that works suspiciously well on the names that later
    restated.
    """
    key = "pit_as_reported_dimension"
    title = "Fundamentals are as-reported, not restated"

    guard = ctx.require(key, title, ["provides_as_reported"])
    if guard is not None:
        return guard

    fund, gap = _fundamentals_or_reason(ctx)
    if fund is None:
        return _no_evidence(key, title, "No fundamental rows to examine.", gap)

    n = len(fund)
    dim = fund["dimension"].astype("str").str.upper()

    def _kind(code: str) -> str:
        if code.startswith("AR"):
            return "as-reported"
        if code.startswith("MR"):
            return "most-recent (restated)"
        return "unrecognised"

    counts = dim.value_counts(dropna=False).rename_axis("dimension")
    table = (
        counts.rename("rows")
        .reset_index()
        .assign(
            kind=lambda d: d["dimension"].map(_kind),
            share_pct=lambda d: [_pct(r, n) for r in d["rows"]],
        )
        .sort_values(["rows", "dimension"], ascending=[False, True], kind="stable")
        .reset_index(drop=True)
    )

    restated_mask = dim.str.startswith("MR")
    unknown_mask = ~dim.str.startswith("AR") & ~restated_mask
    restated = int(restated_mask.sum())
    unknown = int(unknown_mask.sum())

    if restated or unknown:
        verdict = Verdict.FAIL
        headline = (
            f"Not as-reported: {_n(restated + unknown, 'row')} of {n:,} "
            f"({_pct(restated + unknown, n)}%)."
        )
    else:
        verdict = Verdict.PASS
        headline = (
            f"All {n:,} rows carry an AR* dimension: what the filer said "
            "at the time, not what they said later."
        )

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        headline=headline,
        blocking=True,
        tables={"dimensions present": table},
    )

    if restated:
        res.add(
            Verdict.FAIL,
            "An MR* dimension substitutes later restatements into "
            "history, which tells you in 2011 what the company would "
            "only admit in 2013.",
            f"{_n(restated, 'row')} across "
            f"{sorted(dim.loc[restated_mask].unique().tolist())}",
        )
        res.tables["restated rows"] = _examples(
            fund.loc[restated_mask.to_numpy()],
            ["permaticker", "ticker", "dimension", "period_end", "date_public"],
        )
    if unknown:
        res.add(
            Verdict.FAIL,
            "A dimension code that is neither AR* nor MR* cannot be shown "
            "to be as-reported, and an unexamined code defaults to out.",
            f"{_n(unknown, 'row')} across "
            f"{sorted(dim.loc[unknown_mask].unique().tolist())}",
        )

    return res


# -- 4. one symbol, several companies -----------------------------------


def check_ticker_recycling(ctx: AuditContext) -> CheckResult:
    """Reuse is healthy. Not being able to see the seam is the bug.

    A master with no recycled symbols is usually one that quietly
    dropped the companies that died, so the count here is reported as
    evidence rather than as a problem. What decides the verdict is
    whether the panel can tell the tenants apart, and whether their
    windows behave like tenancies — one at a time, in sequence.
    """
    key = "pit_ticker_recycling"
    title = "Recycled symbols are resolvable to distinct entities"

    master = ctx.master
    if master.empty:
        return _no_evidence(
            key,
            title,
            "The security master has no rows.",
            "With no entities there are no symbols to collide, so nothing "
            "was tested about how this source resolves them.",
        )

    per_symbol = master.groupby("ticker")["permaticker"].nunique()
    recycled = per_symbol.loc[per_symbol > 1]
    n_recycled = int(len(recycled))
    has_ids = ctx.capability("provides_permanent_ids")

    ranked = (
        recycled.rename("entities")
        .reset_index()
        .sort_values(["entities", "ticker"], ascending=[False, True], kind="stable")
    )
    top = ranked["ticker"].head(20).tolist()
    listing = (
        master.loc[master["ticker"].isin(top)]
        .sort_values(["ticker", "first_price_date"], kind="stable")
        .pipe(
            _examples,
            [
                "ticker",
                "permaticker",
                "name",
                "first_price_date",
                "last_price_date",
                "is_delisted",
            ],
            n=80,
        )
    )

    # Sorted by start date, an entity overlaps its predecessors exactly
    # when the running maximum of their last prices reaches into its
    # own window. Comparing only to the immediately preceding row would
    # miss a short-lived third company nested inside a long one.
    win = master.loc[
        master["ticker"].isin(recycled.index)
        & master["first_price_date"].notna()
        & master["last_price_date"].notna()
    ].sort_values(["ticker", "first_price_date", "permaticker"], kind="stable")
    if win.empty:
        overlaps = win.assign(
            prior_last_price_date=pd.NaT, overlap_days=pd.array([], dtype="Int64")
        ).head(0)
    else:
        running = win.groupby("ticker")["last_price_date"].cummax()
        prior_last = running.groupby(win["ticker"].to_numpy()).shift(1)
        overlap_days = (prior_last - win["first_price_date"]).dt.days
        overlaps = (
            win.assign(
                prior_last_price_date=prior_last,
                overlap_days=overlap_days.astype("Int64"),
            )
            .loc[overlap_days >= 1]
            .sort_values(
                ["overlap_days", "ticker"], ascending=[False, True], kind="stable"
            )
        )

    if not has_ids:
        verdict = Verdict.FAIL
        headline = (
            f"{_n(n_recycled, 'symbol')} carried by more than one company, "
            "with no permanent entity id claimed to tell the companies "
            "apart."
        )
    elif not overlaps.empty:
        verdict = Verdict.FAIL
        headline = (
            f"{_n(len(overlaps), 'entity', 'entities')} sharing a symbol "
            "with another entity that was still trading at the time; a "
            "legitimate reuse never overlaps."
        )
    elif n_recycled == 0:
        verdict = Verdict.PASS
        headline = (
            f"No symbol among the {master['ticker'].nunique():,} in this "
            "master has been carried by more than one company."
        )
    else:
        verdict = Verdict.PASS
        headline = (
            f"{_n(n_recycled, 'recycled symbol')} out of "
            f"{master['ticker'].nunique():,}, each resolving to distinct "
            "permatickers with non-overlapping windows."
        )

    summary = pd.DataFrame(
        {
            "metric": [
                "distinct symbols in the master",
                "symbols carried by more than one entity",
                "entities sitting on a recycled symbol",
                "entities whose window overlaps a predecessor",
                "permanent entity ids claimed",
            ],
            "value": pd.Series(
                [
                    int(master["ticker"].nunique()),
                    n_recycled,
                    int(master["ticker"].isin(recycled.index).sum()),
                    int(len(overlaps)),
                    has_ids,
                ],
                dtype="object",
            ),
        }
    )

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        headline=headline,
        blocking=True,
        tables={
            "symbol reuse": summary,
            "most-recycled symbols": listing,
        },
    )

    if not has_ids:
        res.add(
            Verdict.FAIL,
            "Without stable ids a symbol join grafts a dead company's "
            "history onto a living one, and the result looks like a stock "
            "that fell 99% and recovered.",
            f"{_n(n_recycled, 'recycled symbol')}, e.g. "
            f"{', '.join(top[:5]) if top else 'none in this master'}",
        )
    if not overlaps.empty:
        worst = overlaps.iloc[0]
        res.add(
            Verdict.FAIL,
            "Two entities hold the same symbol over the same days, which "
            "means the ids are wrong rather than that the symbol was "
            "reused.",
            f"{worst['ticker']} — permaticker "
            f"{int(worst['permaticker'])} starts "
            f"{worst['first_price_date'].date()} while the symbol was in "
            f"use to {worst['prior_last_price_date'].date()} "
            f"({int(worst['overlap_days'])} days of overlap)",
        )
        res.tables["overlapping reuse"] = _examples(
            overlaps,
            [
                "ticker",
                "permaticker",
                "name",
                "first_price_date",
                "last_price_date",
                "prior_last_price_date",
                "overlap_days",
            ],
        )
    if n_recycled == 0:
        res.add(
            Verdict.WARN,
            "No symbol in this master was ever carried by two companies, "
            "which a real multi-decade panel does not manage; it usually "
            "means the dead names are simply not here.",
            f"{len(master):,} entities, "
            f"{int(master['is_delisted'].sum()):,} marked delisted",
        )

    return res


# -- 5. prices inside the window the master claims ----------------------


def check_prices_within_listing_window(ctx: AuditContext) -> CheckResult:
    """A quote outside the window is a fill nobody could have got.

    Rows after the last price date are the dangerous ones — they are
    usually a symbol join leaking the successor's prices backwards into
    the dead company, and they arrive as a position that keeps marking
    up after the security stopped existing. The tolerance is
    LISTING_WINDOW_TOLERANCE_DAYS calendar days, wide enough for the
    master and the price file to disagree across a long weekend and no
    wider.
    """
    key = "pit_prices_within_listing_window"
    title = "Prices stay inside the entity's listing window"

    prices, master = ctx.prices, ctx.master
    if prices.empty:
        return _no_evidence(
            key,
            title,
            "No price rows to examine.",
            "The price frame came back empty over the audited range, so no "
            "row could be tested against its listing window.",
        )

    px = prices.loc[:, ["permaticker", "ticker", "date"]].merge(
        master.loc[:, ["permaticker", "first_price_date", "last_price_date"]],
        on="permaticker",
        how="left",
        indicator=True,
    )
    orphan = px["_merge"].eq("left_only")
    n_orphan = int(orphan.sum())
    known = px.loc[~orphan]

    tol = pd.Timedelta(days=LISTING_WINDOW_TOLERANCE_DAYS)
    early = known["first_price_date"].notna() & (
        known["date"] < known["first_price_date"] - tol
    )
    late = known["last_price_date"].notna() & (
        known["date"] > known["last_price_date"] + tol
    )
    off = known.loc[early | late].copy()

    before = (off["first_price_date"] - off["date"]).dt.days
    after = (off["date"] - off["last_price_date"]).dt.days
    is_early = before.gt(0)
    off = off.assign(
        side=np.where(is_early.to_numpy(), "before listing", "after delisting"),
        days_outside=before.where(is_early, after).astype("Int64"),
    ).sort_values(
        ["days_outside", "permaticker", "date"],
        ascending=[False, True, True],
        kind="stable",
    )

    n_early = int(early.sum())
    n_late = int(late.sum())
    n_off = n_early + n_late
    n_known = int(len(known))

    summary = pd.DataFrame(
        {
            "metric": [
                "price rows checked",
                "rows before first_price_date",
                "rows after last_price_date",
                "entities affected",
                "tolerance (calendar days)",
            ],
            "value": [
                n_known,
                n_early,
                n_late,
                int(off["permaticker"].nunique()),
                LISTING_WINDOW_TOLERANCE_DAYS,
            ],
        }
    )

    if n_off:
        verdict = Verdict.FAIL
        headline = (
            f"Outside the listing window the master gives them: "
            f"{_n(n_off, 'price row')} ({_pct(n_off, n_known)}%) across "
            f"{_n(int(off['permaticker'].nunique()), 'entity', 'entities')}"
            f", beyond the {LISTING_WINDOW_TOLERANCE_DAYS}-day boundary "
            "tolerance."
        )
    else:
        verdict = Verdict.PASS
        headline = (
            f"All {n_known:,} price rows sit inside their entity's listing "
            f"window (± {LISTING_WINDOW_TOLERANCE_DAYS} calendar days for "
            "boundary conventions)."
        )

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        headline=headline,
        blocking=True,
        tables={"listing-window coverage": summary},
    )

    if n_off:
        worst = off.iloc[0]
        res.add(
            Verdict.FAIL,
            "A price outside the listing window is a quote for a security "
            "that was not trading, and it will be traded in a backtest.",
            f"{worst['ticker']} (permaticker {int(worst['permaticker'])}) "
            f"priced {worst['date'].date()}, {int(worst['days_outside'])} "
            f"days {worst['side']}",
        )
        res.tables["rows outside the window"] = _examples(
            off,
            [
                "permaticker",
                "ticker",
                "date",
                "first_price_date",
                "last_price_date",
                "side",
                "days_outside",
            ],
        )
    if n_orphan:
        res.add(
            Verdict.WARN,
            "Price rows for entities the master has never heard of could "
            "not be tested either way.",
            f"{_n(n_orphan, 'row')} across "
            f"{_n(int(px.loc[orphan, 'permaticker'].nunique()), 'unknown id')}",
        )

    return res


# -- 6. two closes, or one close printed twice --------------------------


def check_unadjusted_prices_available(ctx: AuditContext) -> CheckResult:
    """Two column names are not two series.

    A source that returns the adjusted close under both headings breaks
    nothing visibly: the schema validates, the columns are populated,
    and every price screen silently starts reading back-adjusted
    numbers. The only way to catch it is to insist the two disagree
    where a corporate action guarantees they must, which is why this
    check has to find the splits before it can say anything at all.
    """
    key = "pit_unadjusted_prices_available"
    title = "Adjusted and as-traded closes are genuinely different series"

    guard = ctx.require(key, title, ["provides_unadjusted_prices"])
    if guard is not None:
        return guard

    px = ctx.prices
    if px.empty:
        return _no_evidence(
            key,
            title,
            "No price rows to examine.",
            "The price frame came back empty, so the two close columns "
            "could not be compared.",
        )

    usable = px["close_adj"].notna() & px["close_unadj"].notna() & (
        px["close_unadj"] != 0
    )
    sub = px.loc[usable, ["permaticker", "ticker", "date", "close_adj", "close_unadj"]]
    if sub.empty:
        return _no_evidence(
            key,
            title,
            "No row carries both closes.",
            "Every row is missing close_adj or close_unadj, so the two "
            "series could not be compared and the price screen cannot be "
            "shown to read as-traded prices.",
        )

    rel = (sub["close_adj"] / sub["close_unadj"] - 1.0).abs()
    differs = rel > DIVERGENCE_EPS
    n_rows = int(len(sub))
    n_diff = int(differs.sum())
    ids = sub["permaticker"].astype("int64")
    diverged_ids = set(ids.loc[differs].unique().tolist())
    priced_ids = set(ids.unique().tolist())

    splits, divs, event_notes = _corporate_event_ids(ctx)
    splits &= priced_ids
    dividend_only = (divs - splits) & priced_ids
    split_silent = sorted(splits - diverged_ids)
    dividend_silent = sorted(dividend_only - diverged_ids)

    gaps = rel.loc[differs]
    summary = pd.DataFrame(
        {
            "metric": [
                "rows with both closes",
                "rows where they differ",
                "entities priced",
                "entities where they ever differ",
                "median gap on differing rows (%)",
                "p95 gap on differing rows (%)",
                "max gap (%)",
                "entities with a split",
                "split entities that never diverge",
                "dividend-only entities",
                "dividend-only entities that never diverge",
            ],
            "value": pd.Series(
                [
                    n_rows,
                    n_diff,
                    len(priced_ids),
                    len(diverged_ids),
                    round(float(gaps.median()) * 100, 4) if n_diff else 0.0,
                    round(float(gaps.quantile(0.95)) * 100, 4) if n_diff else 0.0,
                    round(float(gaps.max()) * 100, 4) if n_diff else 0.0,
                    len(splits),
                    len(split_silent),
                    len(dividend_only),
                    len(dividend_silent),
                ],
                dtype="object",
            ),
        }
    )

    split_silent_share = len(split_silent) / len(splits) if splits else 0.0
    div_silent_share = (
        len(dividend_silent) / len(dividend_only) if dividend_only else 0.0
    )

    res = CheckResult(
        key=key,
        title=title,
        verdict=Verdict.PASS,
        headline="",
        blocking=True,
        tables={"adjusted vs as-traded divergence": summary},
    )

    if n_diff == 0:
        res.verdict = Verdict.FAIL
        res.headline = (
            f"close_adj and close_unadj are identical on all {n_rows:,} "
            "rows: the source is handing back the adjusted series twice."
        )
        res.add(
            Verdict.FAIL,
            "With one series wearing two names, every price and liquidity "
            "screen is silently applied to back-adjusted numbers.",
            f"{n_rows:,} rows compared, none differing by more than "
            f"{DIVERGENCE_EPS:g} relative",
        )
        return res

    if splits and split_silent_share > SPLIT_NO_DIVERGENCE_FAIL_SHARE:
        res.verdict = Verdict.FAIL
        res.add(
            Verdict.FAIL,
            "Names that split show no gap between the two closes, which a "
            "split makes arithmetically impossible for any row before it.",
            f"{len(split_silent):,} of {len(splits):,} split entities "
            f"({split_silent_share * 100:.1f}%), e.g. permatickers "
            f"{split_silent[:5]}",
        )
    elif split_silent:
        res.add(
            Verdict.WARN,
            "A few split names show no divergence, which a split landing "
            "at the very edge of the pulled window would explain.",
            f"{len(split_silent):,} of {len(splits):,} split entities, "
            f"e.g. permatickers {split_silent[:5]}",
        )

    if dividend_only and div_silent_share > DIVIDEND_NO_DIVERGENCE_WARN_SHARE:
        if res.verdict is not Verdict.FAIL:
            res.verdict = Verdict.WARN
        res.add(
            Verdict.WARN,
            "Dividend payers that never split show no divergence, so the "
            "adjusted series looks split-only — a price return being read "
            "as a total return everywhere downstream.",
            f"{len(dividend_silent):,} of {len(dividend_only):,} "
            f"dividend-only entities ({div_silent_share * 100:.1f}%)",
        )

    if not splits and not divs:
        res.add(
            Verdict.WARN,
            "No corporate actions were visible, so divergence could only "
            "be measured in aggregate rather than against the names that "
            "must show it.",
            "no split_factor or dividends column and no permaticker-keyed "
            "split or dividend actions",
        )
    elif event_notes:
        res.add(
            Verdict.PASS,
            "Corporate events located.",
            "; ".join(event_notes),
        )

    if split_silent:
        rows = sub.loc[sub["permaticker"].isin(split_silent)]
        res.tables["split names with identical closes"] = (
            rows.groupby(["permaticker", "ticker"], as_index=False)
            .agg(rows=("date", "size"), first=("date", "min"), last=("date", "max"))
            .head(20)
        )

    if res.headline == "":
        res.headline = (
            f"The two closes differ on {n_diff:,} of {n_rows:,} rows "
            f"({_pct(n_diff, n_rows)}%) and across "
            f"{len(diverged_ids):,} of {len(priced_ids):,} entities; "
            f"median gap {float(gaps.median()) * 100:.2f}%."
        )
    return res


# -- 7. the number the whole thing is for -------------------------------


def check_adjusted_price_screen_leak(ctx: AuditContext) -> CheckResult:
    """How much future a naive price filter imports, in one number.

    Nothing here is wrong with the data, which is why the check is
    non-blocking. It exists because "screen on unadjusted prices" is
    advice everyone nods at and nobody sizes, and the size is the whole
    argument: reverse splits cluster in exactly the names a price floor
    is meant to remove, so the disagreement is concentrated rather than
    diffuse. Report it even at a fraction of a percent.
    """
    key = "pit_adjusted_price_screen_leak"
    title = "Lookahead injected by screening on adjusted prices"

    # Non-blocking even as a guard: this check measures a consequence of
    # the panel rather than a defect in it. But it must not run without
    # real as-traded prices, because a zero here computed off two copies
    # of the adjusted series is the most reassuring wrong answer in the
    # whole report.
    guard = ctx.require(key, title, ["provides_unadjusted_prices"], blocking=False)
    if guard is not None:
        guard.unprovable_reason = (guard.unprovable_reason or "") + (
            " Without as-traded closes the disagreement between the two "
            "screens is unmeasurable, and it would read as zero — which "
            "is the answer a source that returns the adjusted series "
            "twice also gives."
        )
        return guard

    px = ctx.prices
    if px.empty:
        return _no_evidence(
            key,
            title,
            "No price rows to sample.",
            "The price frame came back empty, so no date could be sampled.",
            blocking=False,
        )

    # The guard above reads the vendor's claim. This reads the tape, and
    # it has to, because the failure being defended against does not
    # withdraw the claim: a source that returns the back-adjusted series
    # under both headings still advertises as-traded prices, sails
    # through the capability gate, and then has its two screens compared
    # against a copy of themselves. The answer is zero by construction —
    # twenty-four rows of zeros, a bold PASS, and the most reassuring
    # wrong number in the document. `pit_unadjusted_prices_available`
    # owns the FAIL for this; what this check owes the reader is a
    # refusal to certify a figure it did not measure.
    both = (
        px["close_adj"].notna()
        & px["close_unadj"].notna()
        & (px["close_unadj"] != 0)
    )
    if both.any():
        rel = (px.loc[both, "close_adj"] / px.loc[both, "close_unadj"] - 1.0).abs()
        if not bool((rel > DIVERGENCE_EPS).any()):
            return _no_evidence(
                key,
                title,
                "The two closes are one series under two names, so the "
                "leak cannot be measured.",
                "close_adj and close_unadj do not differ on a single row "
                "of this panel. Screening on one therefore cannot "
                "disagree with screening on the other, so the leak would "
                "measure exactly zero however much lookahead the data "
                "actually carries — a fact about the source's column "
                "naming rather than about the market. Nothing was "
                "tested; see pit_unadjusted_prices_available, which is "
                "where this failure is named.",
                blocking=False,
            )

    dates = pd.DatetimeIndex(pd.Series(px["date"].unique()).sort_values())
    n_dates = int(len(dates))
    if n_dates == 0:
        return _no_evidence(
            key,
            title,
            "No dated price rows to sample.",
            "The price frame carries no usable dates.",
            blocking=False,
        )

    picks = np.unique(
        np.linspace(0, n_dates - 1, min(SCREEN_SAMPLE_DATES, n_dates))
        .round()
        .astype(int)
    )
    sample = dates[picks]

    eligible_ids, scope_note = _single_name_ids(ctx)
    floor = config.UNIVERSE.min_price

    day = px.loc[
        px["date"].isin(sample),
        ["date", "permaticker", "ticker", "close_adj", "close_unadj"],
    ]
    day = day.loc[
        day["close_adj"].notna()
        & day["close_unadj"].notna()
        & (day["close_unadj"] > 0)
    ]
    if eligible_ids is not None:
        day = day.loc[day["permaticker"].isin(eligible_ids)]
    if day.empty:
        return _no_evidence(
            key,
            title,
            "Nothing priced on the sampled dates.",
            "No row on any sampled date carried both closes, so the two "
            "screens could not be compared.",
            blocking=False,
        )

    adj_ok = day["close_adj"] >= floor
    unadj_ok = day["close_unadj"] >= floor
    day = day.assign(
        adj_only=(adj_ok & ~unadj_ok),
        unadj_only=(unadj_ok & ~adj_ok),
        adj_universe=adj_ok,
    )

    per_date = (
        day.groupby("date", as_index=False)
        .agg(
            priced_names=("permaticker", "size"),
            adj_universe=("adj_universe", "sum"),
            adj_pass_unadj_fail=("adj_only", "sum"),
            unadj_pass_adj_fail=("unadj_only", "sum"),
        )
        .sort_values("date", kind="stable")
        .reset_index(drop=True)
    )
    per_date = per_date.assign(
        leak_pct_of_adj_universe=[
            _pct(a, u)
            for a, u in zip(
                per_date["adj_pass_unadj_fail"], per_date["adj_universe"]
            )
        ],
        disagree_pct_of_priced=[
            _pct(a + b, n)
            for a, b, n in zip(
                per_date["adj_pass_unadj_fail"],
                per_date["unadj_pass_adj_fail"],
                per_date["priced_names"],
            )
        ],
    )

    leak_rows = int(day["adj_only"].sum())
    drop_rows = int(day["unadj_only"].sum())
    leak_names = int(day.loc[day["adj_only"], "permaticker"].nunique())
    universe_rows = int(day["adj_universe"].sum())
    overall_leak = _pct(leak_rows, universe_rows)
    if universe_rows == 0:
        return _no_evidence(
            key,
            title,
            "No name cleared the price floor on any sampled date.",
            f"Not one name on any of the {len(per_date)} sampled dates sat "
            f"at or above ${floor:,.2f} on the adjusted close, so there "
            "was no universe for the two screens to disagree about. A "
            "zero here would be an empty denominator rather than a clean "
            "result.",
            blocking=False,
        )

    leaks = per_date["leak_pct_of_adj_universe"]
    worst = per_date.iloc[int(leaks.idxmax()) if leaks.notna().any() else 0]

    summary = pd.DataFrame(
        {
            "metric": [
                "price floor applied",
                "dates sampled",
                "name-days in the adjusted universe",
                "name-days admitted on adj, untradable on as-traded",
                "name-days excluded on adj, tradable on as-traded",
                "leak as % of the adjusted universe",
                "worst single date (%)",
                "distinct names ever leaked",
            ],
            "value": [
                f"${floor:,.2f}",
                int(len(per_date)),
                universe_rows,
                leak_rows,
                drop_rows,
                overall_leak,
                f"{worst['leak_pct_of_adj_universe']} on "
                f"{worst['date'].date()}",
                leak_names,
            ],
        }
    )

    disagreements = leak_rows + drop_rows
    verdict = Verdict.WARN if disagreements else Verdict.PASS
    headline = (
        f"A ${floor:,.2f} floor read off back-adjusted closes admits "
        f"{overall_leak}% of its own universe on names that were actually "
        f"trading below it (worst sampled date {worst['leak_pct_of_adj_universe']}% "
        f"on {worst['date'].date()}); it also discards {drop_rows:,} "
        "name-days that were genuinely tradable."
    )

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        headline=headline,
        blocking=False,
        tables={
            "screen disagreement by date": per_date,
            "screen disagreement summary": summary,
        },
    )
    res.add(
        Verdict.WARN if disagreements else Verdict.PASS,
        "This is the measurement, not a defect: it is how much of the "
        "future a naive adjusted-price filter would import. Reverse "
        "splits are the mechanism, and they cluster in exactly the names "
        "a price floor is meant to exclude.",
        f"{leak_rows:,} leaked name-days across {leak_names:,} distinct "
        f"names on {len(per_date)} sampled dates ({overall_leak}% of the "
        "adjusted universe)",
    )
    res.add(Verdict.PASS, "Sampling scope.", scope_note)
    return res


# -- 8. does the panel know why a name stopped --------------------------


def check_action_coverage_of_delistings(ctx: AuditContext) -> CheckResult:
    """A name that just stops is an unpriced coin flip.

    Retaining the dead companies is the survivorship fix; knowing why
    each one ended is what makes the retained history usable, because
    acquired at a 30% premium and wound up at zero look identical in a
    price series that simply terminates. Missing reasons are a warning
    rather than a veto — unless the source claimed to supply them, in
    which case everything written on the strength of that claim is
    suspect.
    """
    key = "pit_delisting_action_coverage"
    title = "Names that stopped trading have a corporate action to explain it"

    master, actions = ctx.master, ctx.actions
    start = pd.Timestamp(ctx.start)
    cutoff = pd.Timestamp(ctx.end) - pd.Timedelta(days=DELISTING_TAIL_BUFFER_DAYS)
    stopped = master.loc[
        master["last_price_date"].notna()
        & (master["last_price_date"] >= start)
        & (master["last_price_date"] <= cutoff)
    ]

    claims_reasons = ctx.capability("provides_delisting_reasons")
    claims_dates = ctx.capability("provides_delisting_dates")

    if stopped.empty:
        return _no_evidence(
            key,
            title,
            "No entity stopped trading inside the audited window.",
            "Coverage is undefined with no delistings to cover. In a panel "
            "spanning years that absence is itself the finding, and it "
            "belongs to the survivorship checks rather than this one.",
            blocking=False,
        )

    terminal = pd.Series(False, index=actions.index)
    for kw in TERMINAL_ACTIONS:
        terminal = terminal | actions["action"].str.contains(
            kw, case=False, na=False, regex=False
        )
    term = actions.loc[terminal]

    if term.empty and not (claims_dates or claims_reasons):
        return _no_evidence(
            key,
            title,
            "The source carries no terminal corporate actions and never "
            "claimed to.",
            "There are no delisting, merger or bankruptcy rows in the "
            "actions frame, and the source does not claim delisting dates "
            "or reasons. Its silence about why "
            f"{len(stopped):,} names stopped proves nothing about the "
            "panel — it declined the test rather than failing it.",
            blocking=False,
        )

    # Keyed on permaticker wherever the actions frame carries one. The
    # ticker fallback exists because some vendors only key actions by
    # symbol, and it is fenced with a date window: an unfenced symbol
    # join would credit a 2015 Chemours action to Circuit City.
    matched_by = "permaticker"
    if "permaticker" in term.columns and term["permaticker"].notna().any():
        covered_ids = set(
            term.loc[term["permaticker"].notna(), "permaticker"]
            .astype("int64")
            .tolist()
        )
    else:
        matched_by = "ticker within ±370 days of the last price"
        pairs = stopped.loc[:, ["permaticker", "ticker", "last_price_date"]].merge(
            term.loc[:, ["ticker", "date"]], on="ticker", how="inner"
        )
        near = (pairs["date"] - pairs["last_price_date"]).abs() <= pd.Timedelta(
            days=370
        )
        covered_ids = set(pairs.loc[near, "permaticker"].astype("int64").tolist())

    covered = stopped["permaticker"].astype("int64").isin(covered_ids)
    n_expected = int(len(stopped))
    n_covered = int(covered.sum())
    coverage = _pct(n_covered, n_expected)
    uncovered = stopped.loc[~covered.to_numpy()].sort_values(
        ["last_price_date", "permaticker"], kind="stable"
    )

    reason_populated = 0
    if "reason" in term.columns and not term.empty:
        stated = term["reason"].astype("str").str.strip()
        reason_populated = int((term["reason"].notna() & (stated != "")).sum())

    summary = pd.DataFrame(
        {
            "metric": [
                "entities whose last price is inside the window",
                "with a terminal action on file",
                "coverage (%)",
                "matched by",
                "terminal action rows seen",
                "terminal actions carrying a reason",
                "tail buffer (calendar days)",
            ],
            "value": [
                n_expected,
                n_covered,
                coverage,
                matched_by,
                int(len(term)),
                reason_populated if "reason" in term.columns else "no reason column",
                DELISTING_TAIL_BUFFER_DAYS,
            ],
        }
    )

    # A claimed capability that the data does not support is worse than
    # an unclaimed gap: everything downstream was written trusting it.
    # That is the one branch of this check that blocks.
    coverage_short = claims_reasons and coverage < 50.0
    reason_missing = claims_reasons and "reason" not in term.columns
    if coverage_short or reason_missing:
        parts = []
        if coverage_short:
            parts.append(
                f"a terminal action is on file for only {coverage}% of the "
                f"{_n(n_expected, 'name')} that stopped trading inside the "
                "window"
            )
        if reason_missing:
            parts.append("the actions frame carries no reason column at all")
        verdict, blocking = Verdict.FAIL, True
        headline = (
            "The source claims delisting reasons, but "
            + " and ".join(parts)
            + "."
        )
    elif n_covered < n_expected:
        verdict, blocking = Verdict.WARN, False
        headline = (
            f"A terminal action explains {coverage}% of the "
            f"{_n(n_expected, 'name')} that stopped trading inside the "
            f"window; nothing explains the other {n_expected - n_covered:,}."
        )
    else:
        verdict, blocking = Verdict.PASS, False
        headline = (
            f"A terminal action is on file for all "
            f"{_n(n_expected, 'name')} that stopped trading inside the "
            "window."
        )

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        headline=headline,
        blocking=blocking,
        tables={"delisting coverage": summary},
    )

    if n_covered < n_expected:
        res.add(
            verdict,
            "A name that stops without a reason is an acquisition at a "
            "premium and a wipeout at zero at the same time, and the "
            "backtest has to guess which.",
            f"{_n(n_expected - n_covered, 'entity', 'entities')} "
            f"uncovered, e.g. {uncovered.iloc[0]['ticker']} last priced "
            f"{uncovered.iloc[0]['last_price_date'].date()}",
        )
        res.tables["stopped with no action on file"] = _examples(
            uncovered,
            [
                "permaticker",
                "ticker",
                "name",
                "last_price_date",
                "is_delisted",
                "delisted_from",
            ],
        )
    if matched_by != "permaticker":
        res.add(
            Verdict.WARN,
            "Actions had to be matched to entities by symbol, which is the "
            "join the schema warns about; the date fence makes it "
            "defensible, not correct.",
            matched_by,
        )
    if claims_reasons and "reason" in term.columns and reason_populated < len(term):
        res.add(
            Verdict.WARN,
            "Terminal actions arrive without the reason the source claims "
            "to supply.",
            f"{len(term) - reason_populated:,} of {len(term):,} terminal "
            "rows have an empty reason",
        )

    return res


CHECKS = [
    check_filing_dates_present,
    check_filing_lag_distribution,
    check_as_reported_dimension,
    check_ticker_recycling,
    check_prices_within_listing_window,
    check_unadjusted_prices_available,
    check_adjusted_price_screen_leak,
    check_action_coverage_of_delistings,
]
