"""Is the graveyard in the panel, or only the survivors?

Survivorship bias is the one data defect that improves every number
you report. A universe assembled from the companies that exist today
has quietly dropped Lehman, Circuit City, Washington Mutual, Enron and
several thousand less famous failures, and a strategy backtested on
what remains has been trading with the answer sheet since 2005. The
resulting equity curve is not merely optimistic; it is optimistic in
exactly the places a risk model would have looked for trouble.

The trap this file is built around is that the bias is easy to look
clean on. A vendor can list ten thousand delisted names in its master,
publish delisting dates for all of them, and still store not one price
bar for any of them — the dead are present to be counted and absent
the moment you try to trade them. So the checks here escalate: is
anything flagged dead, does the entity count curve have the shape of a
panel built forwards or backwards, does anything ever die in a given
year, do the dead carry tape, and finally do a handful of companies
whose funerals are a matter of public record actually stop trading on
the day they stopped trading.

That last one is also the only check that can catch the recycling bug.
WB was Wachovia and is now Weibo; a source that keys on the symbol
hands back one continuous series through 2008 and the audit's other
four checks all pass, because nothing is missing — it is welded on.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable

import pandas as pd

from .context import AuditContext
from .decedents import DECEDENTS
from .result import CheckResult, Verdict

# Thresholds live at the top so a reviewer can argue with the numbers
# without reading the code. None of them is tuned; they are what a US
# equity panel looks like when somebody honest assembled it.
_DELISTED_SHARE_FAIL = 0.05
_DELISTED_SHARE_WARN = 0.15
_RISING_STEP_SHARE_FAIL = 0.85
_TERMINAL_GROWTH_FAIL = 0.40
_ATTRITION_MEDIAN_FLOOR = 0.005
_ATTRITION_MEDIAN_CEILING = 0.15
_DEAD_PRICED_FAIL = 0.80
_DEAD_PRICED_WARN = 0.95
_DECEDENT_ABSENT_FAIL = 0.20

# A fixture that gives no tolerance gets a fortnight. Vendors disagree
# about whether the last date is the final print, the day the exchange
# pulled the listing or the day the paperwork cleared, and those are
# routinely a week or two apart on the same event.
_DEFAULT_TOLERANCE_DAYS = 14

# How far back of the expected death we insist on seeing tape. Wide
# enough to survive a thin final month, narrow enough that a series
# ending years early still fails.
_PRE_DEATH_WINDOW_DAYS = 60

# A name whose last bar sits this close to the end of the whole panel
# has not died at all, whatever the master says about it.
_STILL_TRADING_SLACK_DAYS = 14

_SEVERITY = {
    Verdict.PASS: 0,
    Verdict.SKIPPED: 0,
    Verdict.WARN: 1,
    Verdict.UNPROVABLE: 2,
    Verdict.FAIL: 3,
}


def _worse(a: Verdict, b: Verdict) -> Verdict:
    return a if _SEVERITY[a] >= _SEVERITY[b] else b


def _flags(df: pd.DataFrame, col: str) -> pd.Series:
    """A plain boolean mask from a column that may be nullable."""
    return df[col].fillna(False).astype(bool)


def _d(ts: Any) -> str:
    if ts is None or pd.isna(ts):
        return "—"
    return pd.Timestamp(ts).strftime("%Y-%m-%d")


def _no_prices(key: str, title: str, ctx: AuditContext) -> CheckResult:
    return CheckResult(
        key=key,
        title=title,
        verdict=Verdict.UNPROVABLE,
        blocking=True,
        headline=f"{ctx.source.label} returned no price rows in the window.",
        unprovable_reason=(
            "There are no price rows between "
            f"{ctx.start.isoformat()} and {ctx.end.isoformat()}, so nothing "
            "about who was trading and who stopped could be counted. An "
            "empty panel is not a clean one."
        ),
    )


# -- 1. are the dead in the master at all -------------------------------


def check_delisted_entities_present(ctx: AuditContext) -> CheckResult:
    key, title = "survivorship.delisted_present", "Delisted entities in the master"
    guard = ctx.require(key, title, ["provides_delisting_dates"])
    if guard is not None:
        return guard

    master = ctx.master
    if master.empty:
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            headline=f"{ctx.source.label} returned an empty security master.",
            unprovable_reason=(
                "The master has no rows, so the share of it that is dead is "
                "undefined rather than zero."
            ),
        )

    dead = master.loc[_flags(master, "is_delisted")]
    n_total, n_dead = len(master), len(dead)
    share = n_dead / n_total

    if share < _DELISTED_SHARE_FAIL:
        verdict = Verdict.FAIL
    elif share < _DELISTED_SHARE_WARN:
        verdict = Verdict.WARN
    else:
        verdict = Verdict.PASS

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=True,
        headline=(
            f"{n_dead:,} of {n_total:,} entities ({share:.1%}) are flagged "
            "delisted. Roughly half of everything that has ever listed in "
            "the US since 2005 is gone — merged, taken private, bankrupt or "
            "delisted for non-compliance — so a real panel runs well north "
            f"of a third, and anything under {_DELISTED_SHARE_FAIL:.0%} is a "
            "master built from today's listings."
        ),
    )
    res.add(
        verdict,
        "Share of the security master flagged is_delisted.",
        f"{n_dead:,}/{n_total:,} = {share:.2%} "
        f"(fail <{_DELISTED_SHARE_FAIL:.0%}, warn <{_DELISTED_SHARE_WARN:.0%})",
    )

    by_year = _delistings_by_year(dead)
    if not by_year.empty:
        before = int(by_year.loc[by_year.index < ctx.start.year].sum())
        after = int(by_year.loc[by_year.index > ctx.end.year].sum())
        res.add(
            Verdict.PASS,
            "Where the dead fall relative to the audited window.",
            f"{before:,} last traded before {ctx.start.year}, "
            f"{n_dead - before - after:,} inside the window, "
            f"{after:,} after {ctx.end.year}",
        )

        window = by_year.loc[
            (by_year.index >= ctx.start.year) & (by_year.index <= ctx.end.year)
        ]
        res.tables["Delistings by year (last_price_date of delisted names)"] = (
            pd.DataFrame(
                {
                    "year": [int(y) for y in window.index],
                    "delistings": window.to_numpy(dtype="int64"),
                    # Percent, on the same 0-100 scale as every other
                    # column in the report whose name ends in _pct. This
                    # shipped as a fraction, so 2008 — the worst year in
                    # the sample, holding an eighth of all the deaths in
                    # the panel — printed as "0.1290" under a heading
                    # that said percent, and read as a rounding error.
                    "pct_of_delisted": (
                        100.0 * window.to_numpy() / n_dead
                    ).round(2),
                }
            )
        )

        # A year in which nobody died is not a quiet year, it is a hole.
        # Only worth saying on a panel big enough for the claim to mean
        # something; a five-name smoke fixture will have plenty of them.
        if n_dead >= 100:
            covered = range(ctx.start.year, ctx.end.year)
            silent = [y for y in covered if int(by_year.get(y, 0)) == 0]
            if silent:
                verdict = _worse(verdict, Verdict.WARN)
                res.verdict = verdict
                res.add(
                    Verdict.WARN,
                    "Calendar years inside the window with no delistings at all.",
                    "years: " + ", ".join(str(y) for y in silent),
                )
    else:
        res.add(
            Verdict.WARN,
            "No delisted name carries a last_price_date, so the dead cannot "
            "be placed in time.",
            f"{n_dead:,} delisted entities, 0 dated",
        )
        res.verdict = _worse(verdict, Verdict.WARN)

    return res


def _delistings_by_year(dead: pd.DataFrame) -> pd.Series:
    dates = dead["last_price_date"].dropna()
    if dates.empty:
        return pd.Series(dtype="int64")
    return dates.dt.year.value_counts().sort_index()


# -- 2. the shape of the count curve ------------------------------------


def check_universe_count_by_year(ctx: AuditContext) -> CheckResult:
    key, title = "survivorship.universe_count_by_year", "Entity count by year"
    guard = ctx.require(key, title, ["provides_permanent_ids"])
    if guard is not None:
        return guard
    if ctx.prices.empty:
        return _no_prices(key, title, ctx)

    counts = (
        ctx.prices.groupby(ctx.price_years)["permaticker"].nunique().sort_index()
    )
    counts.index = [int(y) for y in counts.index]

    if len(counts) < 3:
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            headline=(
                f"The audited window spans {len(counts)} calendar year(s); the "
                "shape of the curve is not readable from that."
            ),
            unprovable_reason=(
                "This check reads a trend across years. With fewer than three "
                "of them there is no trend to read, and calling that a pass "
                "would certify the panel on two data points."
            ),
        )

    diffs = counts.diff().dropna()
    rising = float((diffs > 0).mean())
    first, last = int(counts.iloc[0]), int(counts.iloc[-1])
    growth = (last / first - 1.0) if first else float("inf")

    monotone = rising > _RISING_STEP_SHARE_FAIL
    expanded = growth > _TERMINAL_GROWTH_FAIL
    if monotone and expanded:
        verdict = Verdict.FAIL
    elif monotone or expanded:
        verdict = Verdict.WARN
    else:
        verdict = Verdict.PASS

    peak_year = int(counts.idxmax())

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=True,
        headline=(
            f"Distinct entities with a price row went {first:,} in "
            f"{counts.index[0]} to {last:,} in {counts.index[-1]} "
            f"({growth:+.0%}), rising in {rising:.0%} of year-on-year steps, "
            f"peaking in {peak_year}. This is the single most diagnostic "
            "curve in the audit: a panel assembled from the companies that "
            "exist today can only grow toward the present, because the "
            "further back you look the more of its members had not yet "
            "listed and none of the ones that died were ever included. An "
            "honest US panel is broadly flat to gently declining off a "
            "2007-2014 peak, as the delisting wave and the shrinking count "
            "of public companies work against new listings."
        ),
    )
    res.add(
        verdict,
        "Shape of the entity count across years.",
        f"rising in {int((diffs > 0).sum())}/{len(diffs)} steps = {rising:.0%} "
        f"(fail >{_RISING_STEP_SHARE_FAIL:.0%} combined with "
        f"first-to-last growth >{_TERMINAL_GROWTH_FAIL:.0%}); "
        f"{counts.index[0]}={first:,}, {counts.index[-1]}={last:,}, "
        f"growth {growth:+.1%}"
    )
    if peak_year == int(counts.index[-1]) and len(counts) > 5:
        res.add(
            Verdict.WARN,
            "The panel is at its widest in its most recent year, which is "
            "what backfilling today's listings looks like.",
            f"peak {peak_year} = {last:,} entities",
        )

    res.tables["Entities with at least one price row, by year"] = pd.DataFrame(
        {
            "year": list(counts.index),
            "entities": counts.to_numpy(dtype="int64"),
            "change": counts.diff().to_numpy(),
            "pct_change": (counts.pct_change().to_numpy() * 100).round(1),
        }
    )
    return res


# -- 3. does anything ever die ------------------------------------------


def check_annual_attrition(ctx: AuditContext) -> CheckResult:
    key, title = "survivorship.annual_attrition", "Annual attrition rate"
    guard = ctx.require(key, title, ["provides_permanent_ids"])
    if guard is not None:
        return guard
    if ctx.prices.empty:
        return _no_prices(key, title, ctx)

    spans = ctx.prices.groupby("permaticker")["date"].agg(["min", "max"])
    first_seen, last_seen = spans["min"], spans["max"]
    panel_last = ctx.prices["date"].max()

    # The final calendar year of the panel cannot be measured: "no price
    # anywhere after this year ends" is a question about data we do not
    # have, and answering it from a truncated window would report the
    # end of the pull as a mass extinction.
    rows: list[dict[str, Any]] = []
    for year in range(ctx.start.year, int(panel_last.year)):
        jan1 = pd.Timestamp(year=year, month=1, day=1)
        dec31 = pd.Timestamp(year=year, month=12, day=31)
        # Alive at the start means already in the panel before the year
        # opened and not already gone. An IPO in year Y is not attrition
        # exposure for year Y, and neither is a name that died in 2009.
        alive = (first_seen <= jan1) & (last_seen >= jan1)
        n_alive = int(alive.sum())
        if n_alive == 0:
            continue
        ceased = int((alive & (last_seen <= dec31)).sum())
        rows.append(
            {
                "year": year,
                "alive_at_start": n_alive,
                "ceased_by_year_end": ceased,
                "attrition_pct": round(100.0 * ceased / n_alive, 2),
            }
        )

    if len(rows) < 3:
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            headline=(
                f"Only {len(rows)} year(s) of attrition are measurable in this "
                "window."
            ),
            unprovable_reason=(
                "Attrition needs a year of data after each year it scores, and "
                "a denominator of names that were already trading when the "
                "year opened. This window supplies fewer than three such "
                "years, so the median would be an anecdote."
            ),
        )

    table = pd.DataFrame(rows)
    median = float(table["attrition_pct"].median()) / 100.0

    if median < _ATTRITION_MEDIAN_FLOOR:
        verdict = Verdict.FAIL
    elif median > _ATTRITION_MEDIAN_CEILING:
        verdict = Verdict.WARN
    else:
        verdict = Verdict.PASS

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=True,
        headline=(
            f"Median annual attrition is {median:.2%} across "
            f"{table['year'].iloc[0]}-{table['year'].iloc[-1]}. US equities "
            "retire at roughly 2-8% a year with the wave breaking in 2008-09 "
            "and again in 2020; a median under "
            f"{_ATTRITION_MEDIAN_FLOOR:.1%} means nothing in this panel ever "
            f"dies, and one over {_ATTRITION_MEDIAN_CEILING:.0%} means "
            "something other than corporate mortality is ending these series."
        ),
    )
    res.add(
        verdict,
        "Median share of each year's incumbents that never trade again.",
        f"median {median:.2%} over {len(table)} years "
        f"(fail <{_ATTRITION_MEDIAN_FLOOR:.1%}, "
        f"warn >{_ATTRITION_MEDIAN_CEILING:.0%}); "
        f"min {table['attrition_pct'].min():.2f}%, "
        f"max {table['attrition_pct'].max():.2f}%",
    )

    # The crises are the cheap sanity check. If 2008 and 2020 look like
    # an ordinary year, the series that ended were not chosen by events.
    indexed = table.set_index("year")
    for crisis in (2008, 2009, 2020):
        if crisis not in indexed.index:
            continue
        row = indexed.loc[crisis]
        if int(row["alive_at_start"]) < 200:
            continue
        rate = float(row["attrition_pct"]) / 100.0
        if rate <= median:
            verdict = _worse(verdict, Verdict.WARN)
            res.add(
                Verdict.WARN,
                f"{crisis} shows no more attrition than a typical year, which "
                "is not what happened that year.",
                f"{crisis}: {rate:.2%} of {int(row['alive_at_start']):,} "
                f"incumbents vs median {median:.2%}",
            )
    res.verdict = verdict

    res.tables["Attrition by year"] = table
    return res


# -- 4. do the dead carry tape ------------------------------------------


def check_dead_names_have_price_history(ctx: AuditContext) -> CheckResult:
    key = "survivorship.dead_names_priced"
    title = "Delisted names carry price history"
    guard = ctx.require(
        key, title, ["provides_delisting_dates", "provides_permanent_ids"]
    )
    if guard is not None:
        return guard
    if ctx.prices.empty:
        return _no_prices(key, title, ctx)

    master = ctx.master
    dead = master.loc[_flags(master, "is_delisted")]
    start, end = pd.Timestamp(ctx.start), pd.Timestamp(ctx.end)
    in_window = dead.loc[
        dead["last_price_date"].between(start, end)
    ]

    if in_window.empty:
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            headline=(
                "No delisted entity has a last_price_date inside the audited "
                "window."
            ),
            unprovable_reason=(
                f"{len(dead):,} entities are flagged delisted but none of them "
                f"stopped trading between {ctx.start.isoformat()} and "
                f"{ctx.end.isoformat()}, so there is no death in this window "
                "whose tape could be looked for."
            ),
        )

    priced = set(ctx.prices["permaticker"].unique().tolist())
    has_tape = in_window["permaticker"].isin(priced)
    share = float(has_tape.mean())

    if share < _DEAD_PRICED_FAIL:
        verdict = Verdict.FAIL
    elif share < _DEAD_PRICED_WARN:
        verdict = Verdict.WARN
    else:
        verdict = Verdict.PASS

    missing = in_window.loc[~has_tape].sort_values(
        ["last_price_date", "permaticker"], ascending=[False, True]
    )

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=True,
        headline=(
            f"{int(has_tape.sum()):,} of {len(in_window):,} entities that died "
            f"inside the window ({share:.1%}) carry at least one price bar. A "
            "master that lists the dead and stores no prices for them is "
            "survivorship bias with extra steps: the names are there to be "
            "counted and absent the moment you try to trade them."
        ),
    )
    res.add(
        verdict,
        "Share of in-window delistings that appear in the price panel.",
        f"{int(has_tape.sum()):,}/{len(in_window):,} = {share:.2%} "
        f"(fail <{_DEAD_PRICED_FAIL:.0%}, warn <{_DEAD_PRICED_WARN:.0%})",
    )
    if len(missing):
        head = missing.head(3)
        # Carries the check's own verdict rather than a standing WARN: a
        # handful of untapped names inside a 99% result is a note, and a
        # finding louder than the check it sits under teaches people to
        # discount both.
        res.add(
            verdict,
            "Delisted names with no price rows at all.",
            "; ".join(
                f"{r.ticker} (permaticker {int(r.permaticker)}, "
                f"last_price_date {_d(r.last_price_date)})"
                for r in head.itertuples()
            ),
        )
        cols = [c for c in ("permaticker", "ticker", "name", "last_price_date")
                if c in missing.columns]
        res.tables["Dead but never priced (up to 20)"] = (
            missing[cols].head(20).reset_index(drop=True)
        )

    # A name can be present, dead and still wrong: the master says it
    # stopped in 2011 and the tape runs to last week. That is the
    # recycled-ticker splice seen from the other end.
    observed_last = ctx.prices.groupby("permaticker")["date"].max()
    lined_up = in_window.loc[has_tape].copy()
    if len(lined_up):
        lined_up = lined_up.assign(
            observed_last=lined_up["permaticker"].map(observed_last)
        )
        drift = (
            lined_up["observed_last"] - lined_up["last_price_date"]
        ).dt.days.abs()
        disagree = lined_up.loc[drift > 10]
        if len(disagree) and len(disagree) / len(lined_up) > 0.05:
            worst = disagree.assign(gap=drift.loc[disagree.index]).nlargest(
                3, "gap"
            )
            res.verdict = _worse(res.verdict, Verdict.WARN)
            res.add(
                Verdict.WARN,
                "The master's delisting date and the last bar on tape "
                "disagree by more than ten days.",
                f"{len(disagree):,}/{len(lined_up):,} names; worst: "
                + "; ".join(
                    f"{r.ticker} master {_d(r.last_price_date)} vs tape "
                    f"{_d(r.observed_last)}"
                    for r in worst.itertuples()
                ),
            )

    return res


# -- 5. companies whose funerals are a matter of record -----------------


def _field(fixture: Any, *names: str, default: Any = None) -> Any:
    """Read one field off a decedent fixture, however it is shaped.

    The fixture list is authored elsewhere. Reaching for a couple of
    spellings costs nothing and keeps a rename over there from turning
    this check silently into a no-op over here.
    """
    for name in names:
        if isinstance(fixture, Mapping):
            if name in fixture:
                return fixture[name]
        elif hasattr(fixture, name):
            return getattr(fixture, name)
    return default


def check_decedent_trace(ctx: AuditContext) -> CheckResult:
    key, title = "survivorship.decedent_trace", "Named decedents stop when they died"
    guard = ctx.require(
        key, title, ["provides_delisting_dates", "provides_permanent_ids"]
    )
    if guard is not None:
        return guard
    if ctx.prices.empty:
        return _no_prices(key, title, ctx)

    start, end = pd.Timestamp(ctx.start), pd.Timestamp(ctx.end)
    master = ctx.master
    symbols = master["ticker"].astype("str").str.strip().str.upper()
    last_bar = ctx.prices.groupby("permaticker")["date"].max()
    panel_last = ctx.prices["date"].max()
    # Two columns rather than the whole panel, and scanned per fixture
    # rather than split by entity: there are a couple of dozen names on
    # trial here and twenty thousand in the frame.
    ids, dates = ctx.prices["permaticker"], ctx.prices["date"]

    rows: list[dict[str, Any]] = []
    skipped: list[str] = []

    for fixture in DECEDENTS:
        ticker = str(_field(fixture, "ticker", "symbol", default="")).strip().upper()
        raw_expected = _field(
            fixture, "last_trade_on_or_about", "last_trade", "last_trade_date"
        )
        expected = pd.Timestamp(raw_expected) if raw_expected is not None else pd.NaT
        tol = int(
            _field(
                fixture,
                "tolerance_days",
                "tolerance",
                default=_DEFAULT_TOLERANCE_DAYS,
            )
        )
        label = str(
            _field(fixture, "name", "company", "company_name", default="") or ""
        )

        if pd.isna(expected) or not (start <= expected <= end):
            skipped.append(f"{ticker} ({_d(expected)})")
            rows.append(
                {
                    "ticker": ticker,
                    "name": label,
                    "expected_last_trade": _d(expected),
                    "master_matches": 0,
                    "permaticker": pd.NA,
                    "observed_last_price": "—",
                    "delta_days": pd.NA,
                    "tolerance_days": tol,
                    "verdict": "skipped (outside window)",
                }
            )
            continue

        candidates = master.loc[symbols == ticker]
        row: dict[str, Any] = {
            "ticker": ticker,
            "name": label,
            "expected_last_trade": _d(expected),
            "master_matches": len(candidates),
            "permaticker": pd.NA,
            "observed_last_price": "—",
            "delta_days": pd.NA,
            "tolerance_days": tol,
        }

        if candidates.empty:
            row["verdict"] = "absent (not in master)"
            rows.append(row)
            continue

        # Symbols get reused, so the right entity is the one that died
        # near the date we are testing — not the one that owns the
        # ticker today. Ties break on permaticker so two runs of this
        # audit never disagree.
        gap = (candidates["last_price_date"] - expected).abs().dt.days
        picked = (
            candidates.assign(_gap=gap.fillna(10**6))
            .sort_values(["_gap", "permaticker"])
            .iloc[0]
        )
        pt = int(picked["permaticker"])
        row["permaticker"] = pt

        observed = last_bar.get(pt, pd.NaT)
        if pd.isna(observed):
            row["verdict"] = "absent (no price rows)"
            rows.append(row)
            continue

        delta = int((observed - expected).days)
        row["observed_last_price"] = _d(observed)
        row["delta_days"] = delta

        floor = expected - pd.Timedelta(days=_PRE_DEATH_WINDOW_DAYS + tol)
        pre = int(((ids == pt) & (dates >= floor) & (dates <= expected)).sum())

        if delta > tol:
            still_open = observed >= panel_last - pd.Timedelta(
                days=_STILL_TRADING_SLACK_DAYS
            )
            row["verdict"] = "never stops" if still_open else "stops late"
        elif delta < -tol:
            row["verdict"] = "stops early"
        elif pre == 0:
            row["verdict"] = "no tape before the death"
        else:
            row["verdict"] = "ok"
        rows.append(row)

    if not rows:
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            headline="The decedent fixture list is empty.",
            unprovable_reason=(
                "DECEDENTS carries no companies, so no known death was looked "
                "for. An empty fixture list passes trivially, which is why "
                "this reports as untested instead."
            ),
        )

    table = pd.DataFrame(rows)
    evaluated = table.loc[~table["verdict"].str.startswith("skipped")]
    n_eval, n_skip = len(evaluated), len(table) - len(evaluated)

    if n_eval == 0:
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            headline=(
                f"All {len(table)} decedent fixtures fall outside "
                f"{ctx.start.isoformat()}-{ctx.end.isoformat()}."
            ),
            unprovable_reason=(
                "Every named company in the fixture list died outside the "
                "audited window, so none of their deaths could be looked for. "
                "Nothing was tested."
            ),
            tables={"Decedent trace": table},
        )

    def which(*names: str) -> pd.DataFrame:
        return evaluated.loc[evaluated["verdict"].isin(names)]

    absent = evaluated.loc[evaluated["verdict"].str.startswith("absent")]
    zombies = which("never stops")
    misdated = which("stops late", "stops early", "no tape before the death")
    clean = which("ok")
    absent_share = len(absent) / n_eval

    if absent_share > _DECEDENT_ABSENT_FAIL or len(zombies):
        verdict = Verdict.FAIL
    elif len(absent) or len(misdated):
        verdict = Verdict.WARN
    else:
        verdict = Verdict.PASS

    res = CheckResult(
        key=key,
        title=title,
        verdict=verdict,
        blocking=True,
        headline=(
            f"{len(clean)}/{n_eval} named decedents stop trading when they "
            f"actually stopped; {len(absent)} absent ({absent_share:.0%}), "
            f"{len(zombies)} still trading, {len(misdated)} on the wrong "
            f"date. {n_skip} fixture(s) fell outside the audited window and "
            "were skipped rather than counted as passes. These are companies "
            "whose last day is a matter of public record, so each failure "
            "names its own cause."
        ),
    )

    if len(absent):
        res.add(
            Verdict.FAIL if absent_share > _DECEDENT_ABSENT_FAIL else Verdict.WARN,
            "Survivorship bias: the company is not in the panel at all, and "
            "any backtest over these years traded a market it was never in.",
            "; ".join(
                f"{r.ticker} died {r.expected_last_trade} — {r.verdict}"
                for r in absent.head(6).itertuples()
            ),
        )
    if len(zombies):
        res.add(
            Verdict.FAIL,
            "Recycling: the symbol was reissued and a living company's "
            "history has been welded onto a dead one's, which reads as a "
            "stock that fell to nothing and recovered.",
            "; ".join(
                f"{r.ticker} died {r.expected_last_trade} but has bars to "
                f"{r.observed_last_price} ({int(r.delta_days):+,}d)"
                for r in zombies.head(6).itertuples()
            ),
        )
    if len(misdated):
        res.add(
            Verdict.WARN,
            "Stale or mis-stamped: the name does stop, on the wrong day. The "
            "panel is not survivorship-biased here, it is imprecise, and the "
            "final weeks of these series are the ones a strategy trades.",
            "; ".join(
                f"{r.ticker} expected {r.expected_last_trade}, observed "
                f"{r.observed_last_price} ({int(r.delta_days):+,}d, "
                f"tolerance {int(r.tolerance_days)}d)"
                for r in misdated.head(6).itertuples()
            ),
        )
    if n_skip:
        res.add(
            Verdict.SKIPPED,
            "Fixtures outside the audited window, excluded from the "
            "denominator and named here so the denominator is not silently "
            "shrunk.",
            "; ".join(skipped),
        )

    recycled = evaluated.loc[evaluated["master_matches"] > 1]
    if len(recycled):
        res.add(
            Verdict.PASS,
            "Tickers the master holds more than once — resolved on the "
            "entity whose last price date sits nearest the known death.",
            "; ".join(
                f"{r.ticker} ({int(r.master_matches)} entities)"
                for r in recycled.itertuples()
            ),
        )

    res.tables["Decedent trace"] = table
    return res


CHECKS: list[Callable[[AuditContext], CheckResult]] = [
    check_delisted_entities_present,
    check_universe_count_by_year,
    check_annual_attrition,
    check_dead_names_have_price_history,
    check_decedent_trace,
]
