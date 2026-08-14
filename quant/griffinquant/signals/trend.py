"""Trend, because a long-only book has no other way to get out.

Asset classes show return persistence at horizons of months. It is the
most replicated result in asset allocation — Moskowitz, Ooi and
Pedersen (2012) find it across 58 futures markets back to 1965;
Asness, Moskowitz and Pedersen (2013) find it in eight asset classes
across four continents; Hurst, Ooi and Pedersen extend it to a century
of data and it survives. It is not a subtle statistical artefact that
needs a particular window to appear, which is precisely why it is the
one signal worth committing to before seeing a single performance
number.

It matters more here than in most designs, and the reason is the
account rather than the literature. This is a long-only cash account:
no shorts, no futures, no options, no leverage. There is no hedge to
put on ahead of a drawdown and no way to express a negative view. The
only de-risking mechanism available is to stop owning the thing, and
trend is the only signal in this system that can ask for that. A
valuation signal that says equities are expensive still has to be
translated into "hold less", and something has to decide when — that
something is this file.

What the file produces is a score per sleeve per date in [0, 1], read
as HOW MUCH OF THIS SLEEVE'S CAP TO TAKE. Zero means take none of it;
one means take all of it. It is never negative, because a negative
number would be an instruction this account cannot carry out, and a
sizing layer that received one would either clip it (and quietly lose
the information) or act on it (and place a short).

Four traps this file exists to refuse.

**Reading the wrong price.** Every return here comes from `close_adj`.
Over 2004-2026 TLT returned -2.6% on price and +105.8% on total
return; LQD -3.2% and +141.4%. A trend signal computed on
`close_unadj` would report that the two fixed-income sleeves have
spent twenty years going nowhere, and the allocator would learn that
bonds are worthless. The signal does not merely understate the
defensive half of the book on unadjusted prices — it deletes it.

**A neutral score for a sleeve we know nothing about.** DBC lists
thirteen months into the sample and the pre-2007 cash leg is a splice.
A sleeve without enough history returns NO score — NaN, with a
companion boolean frame saying so — never 0.5 and never 0.0. Those
three answers are different claims: "the trend is neutral", "there is
no trend", and "we have not earned an opinion". Collapsing the third
into either of the first two is how a backtest acquires a view it
could not have held.

**A signal that peeks.** The score for date T is computed from bars up
to and including the close of T and not one bar more. Everything below
is a trailing window or a positive `shift`; there is no `shift(-1)`,
no `center=True`, no reindex that could pull tomorrow backwards. This
is asserted rather than reviewed: `tests/test_trend.py` truncates the
frame after T, recomputes, and requires the score at T to be identical
bit for bit. An off-by-one here is invisible to a reader and
manufactures a beautiful backtest.

That property also licenses the obvious optimisation: because every
cell is strictly backward-looking, the panel may be computed once over
the whole sample and read row by row inside a backtest, and the result
is provably the same as recomputing it each day on the truncated
frame. `score_asof` exists for the callers that want the cheap path.

**Being fitted in company.** Nothing in this module imports another
signal, runs a portfolio, or has ever been measured in a blend. A
signal chosen because it lifted a combination is fitted to the
combination, and its apparent contribution is the fit rather than the
edge.

One last note on provenance, because it is the point of the whole
exercise. No number in this file was chosen by watching a performance
figure improve. There was no performance figure to watch: the price
cache was cold and the free endpoint blocked when this was written,
which is the best moment there will ever be to fix a parameter. Every
constant below carries the argument for its own value, written before
anything was run.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

from ..config import ETFS
from ..engine import metrics
from ..engine.metrics import REPORT_PERIODS, NamedPeriod
from ..portfolio.sleeves import CASH_SLEEVE_KEY, SLEEVE_BY_KEY

__all__ = [
    "BOOTSTRAP_SEED",
    "DEFAULT_HORIZONS",
    "FILL_LAG_SESSIONS",
    "LOOKBACKS",
    "MIN_BLOCKS_FOR_CI",
    "NOT_A_TREND_ASSET",
    "N_BOOTSTRAP",
    "ONE_WAY_COST_BPS",
    "SESSIONS_PER_MONTH",
    "TrendError",
    "TrendEvaluation",
    "TrendPanel",
    "attainable_levels",
    "close_adj_panel",
    "default_periods",
    "evaluate",
    "score_asof",
    "trend_scores",
]


class TrendError(ValueError):
    """The signal was handed something it must not silently work around."""


# -- the parameters, and the argument for each one ----------------------

#: A trading month, in sessions. 252 sessions a year over twelve months
#: is 21, and it is the number every lookback below is a multiple of.
SESSIONS_PER_MONTH = 21

#: Three, six and twelve months, in sessions.
#:
#: The SET is the parameter, not the individual values, and the prior is
#: about coverage rather than about any one horizon being best. The
#: documented persistence runs from roughly one month to roughly twelve;
#: past two or three years it reverses. So the set has to span the
#: interior of that range and stop short of the reversal, and 3/6/12 is
#: the conventional choice that does — it is what Moskowitz, Ooi and
#: Pedersen report their headline results on and what practitioner
#: implementations have used for thirty years. Nothing here was
#: selected by trying sets and keeping the winner, and if a later
#: reader is tempted to, the honest move is to add the alternative as a
#: recorded trial in `metrics.TrialCounter` rather than to swap it in.
#:
#: Sessions rather than calendar months because the panel is indexed by
#: sessions: a fixed session count is a fixed amount of information,
#: whereas a calendar month is 19 bars in February and 23 in March.
#:
#: Nothing is skipped at the near end. Cross-sectional single-stock
#: momentum conventionally drops the most recent month to dodge
#: short-term reversal; index-level series show little of it, and this
#: signal's job is to be the book's only brake. Throwing away the
#: freshest month of evidence to chase a single-name effect would blunt
#: the one thing trend is here to do.
LOOKBACKS: tuple[int, ...] = (
    3 * SESSIONS_PER_MONTH,
    6 * SESSIONS_PER_MONTH,
    12 * SESSIONS_PER_MONTH,
)

#: Assets for which a trend score is meaningless, excluded by default
#: from `evaluate`. The cash sleeve is the residual — whatever the
#: process does not allocate lands there — so asking whether cash is
#: trending is asking whether the short rate went up, which is a
#: statement about the hurdle and not about an opportunity. Both the
#: sleeve key and its vehicle ticker, because a panel may be columned
#: by either.
NOT_A_TREND_ASSET: frozenset[str] = frozenset(
    {CASH_SLEEVE_KEY, SLEEVE_BY_KEY[CASH_SLEEVE_KEY].ticker}
)

#: One-way trading cost for the standalone diagnostic curve, in basis
#: points. Anchored to `config.EtfRules.max_median_spread_bps` rather
#: than invented: that is the widest median spread a sleeve vehicle is
#: allowed to have, so charging the WHOLE of it one-way is roughly
#: double the half-spread a marketable order actually pays. A
#: diagnostic that flatters the signal is worse than no diagnostic, and
#: the engine's real cost model is the authority for anything that
#: matters.
ONE_WAY_COST_BPS: float = ETFS.max_median_spread_bps

#: Sessions between the score and the position it produces, in the
#: standalone curve only.
#:
#: The engine decides at the close of T and fills at the open of T+1, so
#: the position earns from the open of T+1. A close-to-close curve has
#: no opens in it, and the tempting one-session lag would credit the
#: whole close-T-to-close-T+1 move — including the overnight gap, in the
#: direction of our own signal, most generously in exactly the fast
#: markets that matter. Two sessions forfeits the T+1 intraday move
#: instead. It understates, which is the only direction a standalone
#: diagnostic is allowed to be wrong in.
FILL_LAG_SESSIONS = 2

#: The forward windows the information coefficient is measured against.
#: One session because it is the finest resolution the panel has, and
#: twenty-one because that is the month over which a signal built from
#: multi-month windows should actually be expected to say something.
DEFAULT_HORIZONS: tuple[int, ...] = (1, SESSIONS_PER_MONTH)

#: Bootstrap resamples behind every confidence interval. A thousand is
#: the round figure at which a 2.5% percentile is stable to about a
#: percent of itself; more buys precision the underlying data does not
#: have.
N_BOOTSTRAP = 1000

#: Fixed, and fixed in the source rather than passed in. A diagnostic
#: whose interval moves between runs invites re-running it until the
#: interval reads well, which is a search nobody records.
BOOTSTRAP_SEED = 20050103

#: Two-sided coverage of the reported interval.
CI_LEVEL = 0.95

#: A percentile interval assembled from fewer than five blocks is a
#: number with no sampling content in it. Below this the interval is
#: NaN and the row says why, which is more useful than a wide interval
#: that looks computed.
MIN_BLOCKS_FOR_CI = 5


def attainable_levels(lookbacks: Sequence[int] = LOOKBACKS) -> tuple[float, ...]:
    """The discrete values a score can actually take.

    The blend is an average of one vote per lookback, so with three
    lookbacks the score is one of 0, 1/3, 2/3, 1. The range is [0, 1]
    and the interior is not dense — a sizing layer that wants to
    interpolate should know that before it tries.
    """
    n = len(lookbacks)
    return tuple(i / n for i in range(n + 1))


# -- the score ----------------------------------------------------------


@dataclass(frozen=True, eq=False)
class TrendPanel:
    """Scores, and the record of where there is no score.

    `score` is NaN wherever the signal declines to have an opinion, and
    `known` is the boolean twin that says so out loud. Both exist
    because NaN is one `fillna` away from becoming a neutral 0.5 in
    somebody's downstream frame, and the whole point of the abstention
    is that it is not a middling opinion.

    `votes` keeps the per-lookback decisions, which is the only way to
    see WHY a score is 2/3 — a sleeve that is up over three and six
    months and down over twelve is a different animal from one that is
    up over twelve and rolling over.
    """

    score: pd.DataFrame
    known: pd.DataFrame
    votes: Mapping[int, pd.DataFrame]
    lookbacks: tuple[int, ...]
    levels: tuple[float, ...]
    rf_convention: str

    @property
    def assets(self) -> tuple[str, ...]:
        return tuple(str(c) for c in self.score.columns)

    @property
    def latest(self) -> pd.Series:
        """The last row — the decision available at the final close."""
        return self.score.iloc[-1]

    def as_of(self, day: Any) -> pd.Series:
        """The scores available at the close of `day`.

        Raises rather than reaching for the nearest session. A caller
        asking for a date that is not in the panel has either a
        calendar bug or a holiday, and answering with a neighbouring
        day's score would resolve a holiday into lookahead half the
        time.
        """
        stamp = pd.Timestamp(day).normalize()
        if stamp not in self.score.index:
            raise TrendError(
                f"{stamp.date()} is not a session in this panel. Refusing to "
                "snap to the nearest one: half the time the nearest one is "
                "in the future."
            )
        return self.score.loc[stamp]

    def coverage(self) -> pd.DataFrame:
        """Per asset: when the signal started speaking, and how often.

        `blocked` counts the sessions where a score was withheld. It is
        not a failure count — a sleeve that lists in 2006 is going to
        be blocked for its first 253 sessions and that is the signal
        working — but a number that climbs later in the sample means a
        hole in the price frame, which is.
        """
        rows: list[dict[str, Any]] = []
        for col in self.score.columns:
            k = self.known[col]
            scored = self.score.index[k.to_numpy()]
            rows.append(
                {
                    "asset": str(col),
                    "sessions": int(len(k)),
                    "scored": int(k.sum()),
                    "blocked": int((~k).sum()),
                    "first_scored": scored[0] if len(scored) else pd.NaT,
                    "last_scored": scored[-1] if len(scored) else pd.NaT,
                    "mean_score": float(self.score[col].mean()),
                }
            )
        return pd.DataFrame(rows)


def trend_scores(
    close_adj: pd.DataFrame,
    *,
    lookbacks: Sequence[int] = LOOKBACKS,
    risk_free: float | pd.Series = 0.0,
    periods_per_year: int = metrics.TRADING_DAYS_PER_YEAR,
) -> TrendPanel:
    """Time-series momentum on total returns, blended across horizons.

    One vote per lookback: did this asset's TOTAL return over the last
    L sessions beat what cash paid over the same L sessions? The score
    is the plain average of the votes.

    Votes rather than magnitudes, and the reason is a prior rather than
    a result. The evidence for momentum is evidence about the SIGN of
    the next move persisting; the magnitude of a past return is a much
    weaker predictor of the magnitude of the next one, and scaling by
    it drags the asset's own volatility into a signal that is supposed
    to be about direction. A continuous version also needs a squashing
    scale — how many percent of trailing return maps to a full-size
    position — and there is no prior that fixes that number, so it
    could only ever be chosen by testing. A vote has no such dial. The
    price is a coarse score, and that is a price worth paying: the
    attainable values are `attainable_levels()`.

    `risk_free` is the ANNUALISED rate as a decimal (0.0525 for 5.25%),
    float or Series, converted geometrically to a per-session hurdle
    and compounded across each lookback. It defaults to zero, and zero
    is not neutral: with a zero hurdle any asset that drifted upward at
    all reads as trending, which in a positive-drift world is most of
    them most of the time. The convention travels with the panel in
    `rf_convention` for the same reason `metrics` makes it travel with
    a Sharpe.

    A column is scored on date T only if EVERY lookback is computable
    there — that is, the longest window ending at T is complete, with a
    finite positive price on every session in it. Partial scoring is
    refused on purpose: two votes out of two and two votes out of three
    are the same number and different claims, and a score whose meaning
    changes with how much history happens to exist is not a score.
    """
    frame = _as_close_frame(close_adj)
    lbs = _clean_lookbacks(lookbacks)
    rf_daily = _rf_per_session(risk_free, frame.index, periods_per_year)

    # A price is usable if it is finite and positive. Non-positive is
    # not merely odd here: it makes the ratio below meaningless and
    # would produce a confident vote out of a data error.
    usable = frame.notna() & (frame > 0.0)
    usable_f = usable.astype("float64")
    log_rf = np.log1p(rf_daily)

    known = pd.DataFrame(True, index=frame.index, columns=frame.columns)
    votes: dict[int, pd.DataFrame] = {}
    total = pd.DataFrame(0.0, index=frame.index, columns=frame.columns)

    for lb in lbs:
        window = lb + 1
        # Every bar in the window, not just the endpoints. A hole in the
        # middle means the vehicle was not trading, and a point-to-point
        # return across it is a number computed over a period we did not
        # observe.
        complete = (
            usable_f.rolling(window, min_periods=window).sum() >= window - 0.5
        )

        gross = frame / frame.shift(lb)
        # The hurdle covers the same L sessions the return does: the
        # rolling sum at row T spans rows T-L+1..T, which are exactly
        # the sessions between the two prices.
        hurdle = np.expm1(log_rf.rolling(lb, min_periods=lb).sum())

        vote = (gross.sub(1.0).sub(hurdle, axis=0) > 0.0).astype("float64")
        vote = vote.where(complete)
        votes[lb] = vote
        known = known & complete
        total = total.add(vote.fillna(0.0))

    score = (total / float(len(lbs))).where(known)
    votes = {lb: v.where(known) for lb, v in votes.items()}

    return TrendPanel(
        score=score,
        known=known,
        votes=votes,
        lookbacks=lbs,
        levels=attainable_levels(lbs),
        rf_convention=metrics.rf_convention(risk_free),
    )


def score_asof(
    close_adj: pd.DataFrame,
    *,
    lookbacks: Sequence[int] = LOOKBACKS,
    risk_free: float | pd.Series = 0.0,
    periods_per_year: int = metrics.TRADING_DAYS_PER_YEAR,
) -> pd.Series:
    """The score at the final close, computed from that tail alone.

    The cheap path for a strategy inside the engine, which is handed a
    growing view every session and would otherwise pay for the whole
    history each day. It is exactly the last row of `trend_scores`,
    and that is not an approximation to be trusted on inspection — it
    holds because the longest window is `max(lookbacks) + 1` bars and
    nothing here looks further back than that. The test suite pins the
    two together.
    """
    frame = _as_close_frame(close_adj)
    lbs = _clean_lookbacks(lookbacks)
    tail = frame.iloc[-(max(lbs) + 1) :]
    rf = risk_free
    if isinstance(rf, pd.Series):
        # Keep whatever sits before the slice: the conversion ffills,
        # and lopping off the earlier quotes would turn a covered
        # sample into an uncovered one.
        rf = rf.loc[: tail.index[-1]]
    panel = trend_scores(
        tail,
        lookbacks=lbs,
        risk_free=rf,
        periods_per_year=periods_per_year,
    )
    return panel.score.iloc[-1]


# -- getting a panel out of the price frame -----------------------------


def close_adj_panel(prices: pd.DataFrame, *, key: str = "ticker") -> pd.DataFrame:
    """Pivot the long `schema.PRICES` frame to wide TOTAL-RETURN closes.

    `close_adj` and nothing else, which is the whole argument of the
    measured fact this project keeps restating: on price alone TLT
    returned -2.6% over 2004-2026 and LQD -3.2%, and a trend signal fed
    those numbers concludes the defensive sleeves are dead weight.

    The duplicate check is the recycled-symbol trap, borrowed verbatim
    in spirit from `MarketData.from_prices`. Two entities can share a
    ticker across time, and a pivot on the symbol grafts a dead
    company's history onto a living one's.
    """
    for col in ("date", key, "close_adj"):
        if col not in prices.columns:
            raise TrendError(
                f"price frame has no {col!r} column; got "
                f"{sorted(prices.columns)}"
            )
    dupes = int(prices.duplicated(subset=["date", key]).sum())
    if dupes:
        raise TrendError(
            f"{dupes:,} duplicate ({key}, date) row(s). If the key is a "
            "ticker this is the recycled-symbol trap: two entities sharing "
            "a symbol, spliced by the pivot into one impossible price "
            "history. Pivot on permaticker."
        )
    wide = prices.pivot(index="date", columns=key, values="close_adj")
    return _as_close_frame(wide.sort_index())


# -- the standalone diagnostics -----------------------------------------


@dataclass(frozen=True, eq=False)
class TrendEvaluation:
    """Everything the standalone assessment produced, in one object.

    Deliberately several frames rather than one headline. A signal that
    earned its entire information coefficient in 2008 and nothing since
    is a different animal from one that worked throughout, and a single
    pooled number cannot tell them apart — so every table is broken out
    by sub-period and the reader has to look at the breakout to reach
    the summary.
    """

    ic: pd.DataFrame
    hit_rate: pd.DataFrame
    spread: pd.DataFrame
    curve_summary: pd.DataFrame
    coverage: pd.DataFrame
    curves: Mapping[str, pd.Series]
    benchmarks: Mapping[str, pd.Series]
    weights: pd.DataFrame
    periods: tuple[NamedPeriod, ...]
    conventions: Mapping[str, str]

    def headline(self) -> pd.DataFrame:
        """The pooled full-sample rows only — for reading last, not first.

        Provided because somebody will want one line, and withheld from
        being the default so that wanting it costs a method call. The
        sub-period tables are the finding; this is the abstract.
        """
        return self.ic.loc[
            (self.ic["scope"] == "pooled") & (self.ic["period"] == "full sample")
        ].reset_index(drop=True)


def default_periods(index: pd.DatetimeIndex) -> tuple[NamedPeriod, ...]:
    """Full sample, every calendar year, then the named stress windows.

    Three kinds on purpose, and the middle one is the one that answers
    the question. Calendar years are an exhaustive partition nobody can
    be accused of having chosen — they are the only slicing that was
    fixed before the data existed — so a signal that only worked in one
    regime has nowhere to hide in that table. The named windows from
    `metrics.REPORT_PERIODS` overlap each other and the years, and are
    carried because the rest of the project reports on them; they are
    labelled `stress` so nobody sums them.

    Two of the named windows ARE calendar years — 2008 and 2022 — and
    they are dropped here rather than printed twice. Two rows with the
    same label and the same dates invite a reader to treat them as two
    pieces of evidence.
    """
    if len(index) == 0:
        raise TrendError("cannot build periods from an empty index")
    first = index[0]
    out: list[NamedPeriod] = [
        NamedPeriod(
            "full sample",
            first.date().isoformat(),
            None,
            "everything, and the least informative row in the table",
        )
    ]
    for year in sorted({int(y) for y in index.year}):
        out.append(
            NamedPeriod(
                str(year),
                f"{year}-01-01",
                f"{year}-12-31",
                "calendar year; an exhaustive partition of the sample",
            )
        )
    seen = {w.name for w in out}
    out.extend(p for p in REPORT_PERIODS if p.name not in seen)
    return tuple(out)


def evaluate(
    prices: pd.DataFrame,
    *,
    key: str = "ticker",
    lookbacks: Sequence[int] = LOOKBACKS,
    risk_free: float | pd.Series = 0.0,
    horizons: Sequence[int] = DEFAULT_HORIZONS,
    exclude: Iterable[str] = NOT_A_TREND_ASSET,
    cost_bps: float = ONE_WAY_COST_BPS,
    periods: Sequence[NamedPeriod] | None = None,
    n_bootstrap: int = N_BOOTSTRAP,
    seed: int = BOOTSTRAP_SEED,
    periods_per_year: int = metrics.TRADING_DAYS_PER_YEAR,
) -> TrendEvaluation:
    """Measure this signal alone, per sleeve and pooled, by sub-period.

    `prices` is either the long `schema.PRICES` frame or a wide frame
    of total-return closes already pivoted. Nothing else is read: no
    other signal, no portfolio, no combination. A signal evaluated in
    company is being measured together with whatever it was combined
    with, and the number that comes back is the fit.

    What lands in each table:

    **`ic`** — the rank correlation between the score at the close of T
    and the excess return over the next `h` sessions, per asset and
    pooled, with a moving-block bootstrap interval. Spearman rather
    than Pearson because the score takes four values and forward
    returns are fat-tailed, so a product-moment correlation between
    them is dominated by a handful of days. A BLOCK bootstrap rather
    than Newey-West for two reasons: the 21-session windows overlap, so
    the observations carry twenty lags of induced dependence and an
    IID resample would understate the standard error by roughly
    sqrt(21); and Newey-West's asymptotics are derived for a mean or a
    regression coefficient, not for a rank correlation of a
    four-valued variable, which is doing more distributional work than
    this data supports. The block length is twice the horizon, floored
    at one month — twice the dependence length is the standard rule of
    thumb and needs no tuning. Pooled resampling draws whole DATES
    rather than individual cells, because nine sleeves on one day are
    not nine independent observations and treating them as such would
    shrink the interval by about a factor of three.

    **`hit_rate`** — measured only at the two ends of the score's
    range, where the signal is unambiguous: how often a full-conviction
    score of 1.0 is followed by a positive excess return, and how often
    a score of 0.0 is followed by a negative one. Choosing an interior
    threshold would be choosing a parameter. The unconditional base
    rate sits in the same row, because a 60% hit rate against a 58%
    base rate is nothing at all, and a hit rate printed alone always
    reads as skill.

    **`spread`** — mean forward excess return on full-on days minus the
    mean on full-off days, with the count on each side. `annualised` is
    a readability scaling of an overlapping-window mean and is not a
    return anybody could have collected.

    **`curve_summary`** — a long/flat curve for each sleeve on its own,
    weight equal to the score (the score IS the fraction of the cap to
    take, so this is the faithful reading), charged `cost_bps` one-way
    on every weight change, held against a costless buy-and-hold of the
    same sleeve. One variant only. Shipping a scaled curve and a binary
    curve and letting a reader pick the better is a two-trial search
    that nobody would record.

    The forward returns behind `ic`, `hit_rate` and `spread` run from
    the close of T, which includes the overnight gap the engine cannot
    trade. Those three tables are therefore an UPPER bound on what is
    collectable. The curve uses the two-session lag described at
    `FILL_LAG_SESSIONS` and is the lower one. Both conventions are
    recorded in `conventions` so the gap between the tables is a known
    quantity rather than a puzzle.
    """
    wide = _panel_from(prices, key=key)
    dropped = [c for c in wide.columns if str(c) in set(exclude)]
    if dropped:
        wide = wide.drop(columns=dropped)
    if wide.shape[1] == 0:
        raise TrendError(
            "every column was excluded; there is nothing left to evaluate"
        )

    hs = tuple(int(h) for h in horizons)
    if any(h < 1 for h in hs):
        raise TrendError(f"horizons must be at least one session, got {horizons!r}")
    if n_bootstrap < 1:
        raise TrendError("n_bootstrap must be positive")

    panel = trend_scores(
        wide,
        lookbacks=lookbacks,
        risk_free=risk_free,
        periods_per_year=periods_per_year,
    )
    rf_daily = _rf_per_session(risk_free, wide.index, periods_per_year)
    simple = wide / wide.shift(1) - 1.0

    windows = tuple(periods) if periods is not None else default_periods(wide.index)
    rng = np.random.default_rng(int(seed))

    ic_rows: list[dict[str, Any]] = []
    hit_rows: list[dict[str, Any]] = []
    spread_rows: list[dict[str, Any]] = []

    assets = [str(c) for c in wide.columns]
    scopes: list[tuple[str, list[str]]] = [("pooled", assets)]
    scopes += [(a, [a]) for a in assets]

    for h in hs:
        forward = _forward_excess(simple, rf_daily, h)
        block = max(2 * h, SESSIONS_PER_MONTH)
        for window in windows:
            mask = _period_mask(wide.index, window)
            if not mask.any():
                continue
            s_win = panel.score.loc[mask]
            f_win = forward.loc[mask]
            for scope, cols in scopes:
                ic_rows.append(
                    _ic_row(
                        s_win[cols],
                        f_win[cols],
                        scope=scope,
                        window=window,
                        horizon=h,
                        block=block,
                        n_bootstrap=n_bootstrap,
                        rng=rng,
                    )
                )
                hit, spr = _hit_and_spread(
                    s_win[cols],
                    f_win[cols],
                    scope=scope,
                    window=window,
                    horizon=h,
                    levels=panel.levels,
                    periods_per_year=periods_per_year,
                )
                hit_rows.append(hit)
                spread_rows.append(spr)

    curves, benchmarks, weights, summary = _curves(
        panel=panel,
        simple=simple,
        rf_daily=rf_daily,
        risk_free=risk_free,
        cost_bps=float(cost_bps),
        windows=windows,
        periods_per_year=periods_per_year,
    )

    conventions = {
        "risk_free": panel.rf_convention,
        "prices": (
            "close_adj only. On close_unadj the bond and credit sleeves "
            "return roughly nothing over the sample and the signal would "
            "learn that coupons do not exist."
        ),
        "forward_returns": (
            f"close of T to close of T+h, excess of cash — includes the "
            f"overnight gap the engine cannot trade, so the IC, hit rate "
            f"and spread tables are an upper bound"
        ),
        "curve_fill": (
            f"weight decided at the close of T takes effect "
            f"{FILL_LAG_SESSIONS} sessions later, forfeiting the fill "
            f"session's intraday move rather than claiming an overnight "
            f"gap in the signal's own direction"
        ),
        "costs": (
            f"{cost_bps:.2f} bps one-way on every weight change, against a "
            f"costless buy-and-hold benchmark"
        ),
        "interval": (
            f"{CI_LEVEL:.0%} moving-block bootstrap, {n_bootstrap:,} "
            f"resamples, seed {seed}; blocks are whole dates so the "
            f"cross-sectional correlation between sleeves survives "
            f"resampling"
        ),
        "excluded": (
            ", ".join(sorted(dropped)) if dropped else "nothing"
        ),
    }

    return TrendEvaluation(
        ic=pd.DataFrame(ic_rows),
        hit_rate=pd.DataFrame(hit_rows),
        spread=pd.DataFrame(spread_rows),
        curve_summary=summary,
        coverage=panel.coverage(),
        curves=curves,
        benchmarks=benchmarks,
        weights=weights,
        periods=tuple(windows),
        conventions=conventions,
    )


# -- inputs -------------------------------------------------------------


def _as_close_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """A float panel on a clean, sorted, unique DatetimeIndex.

    Every one of these raises rather than repairing. An unsorted index
    silently reverses the sign of every lookback return; a duplicated
    session double-counts a bar inside every rolling window. Both are
    upstream bugs, and both look like data.
    """
    if not isinstance(frame, pd.DataFrame):
        raise TrendError(f"expected a DataFrame of closes, got {type(frame)!r}")
    if frame.shape[1] == 0:
        raise TrendError("price panel has no assets")
    if not isinstance(frame.index, pd.DatetimeIndex):
        raise TrendError("price panel must be indexed by date")
    idx = pd.DatetimeIndex(frame.index).normalize()
    if not idx.is_monotonic_increasing:
        raise TrendError(
            "price panel index is not sorted ascending. Sorting it here "
            "would hide the upstream bug and every lookback return above "
            "would already have been computed backwards."
        )
    if idx.has_duplicates:
        n = int(idx.duplicated().sum())
        raise TrendError(f"price panel has {n:,} duplicate session(s)")
    out = frame.astype("float64")
    out.index = idx
    return out


def _panel_from(prices: pd.DataFrame, *, key: str) -> pd.DataFrame:
    """Accept the long price frame or an already-wide one."""
    if "date" in prices.columns and key in prices.columns:
        return close_adj_panel(prices, key=key)
    if "close_adj" in prices.columns and "date" in prices.columns:
        raise TrendError(
            f"the long price frame has no {key!r} column to pivot on; pass "
            "key= the column that identifies the instrument"
        )
    return _as_close_frame(prices)


def _clean_lookbacks(lookbacks: Sequence[int]) -> tuple[int, ...]:
    lbs = tuple(int(lb) for lb in lookbacks)
    if not lbs:
        raise TrendError(
            "a blend needs at least one lookback; an empty set would score "
            "every asset zero and read as a signal saying sell everything"
        )
    if any(lb < 1 for lb in lbs):
        raise TrendError(f"lookbacks must be at least one session, got {lookbacks!r}")
    if len(set(lbs)) != len(lbs):
        # A repeated lookback is a silent reweighting of the blend: pass
        # (63, 63, 252) and the three-month horizon gets two thirds of
        # the vote while the docstring still says simple average.
        raise TrendError(
            f"duplicate lookback in {lookbacks!r}; a repeat is a hidden "
            "reweighting of what this file calls a simple average"
        )
    return lbs


def _rf_per_session(
    risk_free: float | pd.Series,
    index: pd.DatetimeIndex,
    periods_per_year: int,
) -> pd.Series:
    """Annualised decimal rate to a per-session one, geometrically.

    The same convention `metrics._rf_per_period` uses, restated here
    rather than reached into, and with the same two refusals. A rate
    series that does not reach the start of the sample is not
    forward-filled from the first quote we happen to hold — that is how
    a 2005 window ends up measured against 2008's cash rate. And a
    figure above 1.0 is percent that forgot to be divided by a hundred,
    which would set a hurdle no asset ever clears and turn the whole
    signal off.
    """
    idx = pd.DatetimeIndex(index)
    if isinstance(risk_free, pd.Series):
        annual = risk_free.astype("float64").sort_index()
        annual.index = pd.DatetimeIndex(annual.index).normalize()
        annual = annual.reindex(idx.union(annual.index)).ffill().reindex(idx)
        if annual.isna().any():
            first_bad = annual.index[annual.isna()][0]
            raise TrendError(
                "risk-free series does not cover the sample; no rate on or "
                f"before {first_bad.date()}"
            )
    else:
        annual = pd.Series(float(risk_free), index=idx, dtype="float64")

    if len(annual) and float(annual.abs().max()) > 1.0:
        raise TrendError(
            f"risk-free rate reaches {float(annual.abs().max()):.4g}, over "
            "100% a year as a decimal. This is percent — divide by 100."
        )
    return (1.0 + annual) ** (1.0 / float(periods_per_year)) - 1.0


# -- forward returns and windows ----------------------------------------


def _forward_excess(
    simple: pd.DataFrame, rf_daily: pd.Series, horizon: int
) -> pd.DataFrame:
    """Excess total return over the h sessions AFTER each row.

    `rolling(h).sum().shift(-h)` and not the other order. The rolling
    sum at row X covers X-h+1..X; shifting it back by h parks it at row
    X-h, so the value sitting on row T is the sum over T+1..T+h. Doing
    the shift first and the rolling second would include T's own return
    in T's forward window, which is the whole lookahead this project
    exists to refuse — and the two spellings differ by exactly one bar,
    which is invisible in a print.
    """
    def ahead(logs: Any) -> Any:
        rolled = logs.rolling(horizon, min_periods=horizon).sum()
        return np.expm1(rolled.shift(-horizon))

    return ahead(np.log1p(simple)).sub(ahead(np.log1p(rf_daily)), axis=0)


def _period_mask(index: pd.DatetimeIndex, window: NamedPeriod) -> np.ndarray:
    start = pd.Timestamp(window.start)
    end = pd.Timestamp(window.end) if window.end else index[-1]
    return np.asarray((index >= start) & (index <= end), dtype=bool)


def _period_kind(window: NamedPeriod) -> str:
    """full / year / stress, read off the label.

    Only the `year` rows partition the sample. The distinction is
    carried into every table because summing overlapping windows is an
    easy mistake to make from a frame and an impossible one to spot
    afterwards.
    """
    if window.name == "full sample":
        return "full"
    return "year" if window.name.isdigit() and len(window.name) == 4 else "stress"


# -- correlation, ranks, bootstrap --------------------------------------


def _average_ranks(x: np.ndarray) -> np.ndarray:
    """Ranks with ties averaged, vectorised.

    Ties are not an edge case here: the score takes four values, so a
    twenty-year pooled sample has four enormous tie groups. Ordinal
    ranking would break them in whatever order the array happened to be
    in, which makes the correlation depend on the sort's stability
    rather than on the data.
    """
    n = x.size
    if n == 0:
        return np.empty(0, dtype="float64")
    order = np.argsort(x, kind="stable")
    sx = x[order]
    fresh = np.r_[True, sx[1:] != sx[:-1]]
    group = np.cumsum(fresh) - 1
    starts = np.flatnonzero(fresh)
    ends = np.r_[starts[1:], n] - 1
    avg = 0.5 * (starts + ends) + 1.0
    out = np.empty(n, dtype="float64")
    out[order] = avg[group]
    return out


def _pearson(a: np.ndarray, b: np.ndarray) -> float:
    if a.size < 3:
        return float("nan")
    da = a - a.mean()
    db = b - b.mean()
    na = math.sqrt(float(da @ da))
    nb = math.sqrt(float(db @ db))
    if not (na > 0.0 and nb > 0.0):
        # One side never varied. NaN rather than zero: "the signal was
        # constant here" and "the signal was uncorrelated here" are
        # different findings, and a printed zero reads as the second.
        return float("nan")
    return float((da @ db) / (na * nb))


def _ic_row(
    score: pd.DataFrame,
    forward: pd.DataFrame,
    *,
    scope: str,
    window: NamedPeriod,
    horizon: int,
    block: int,
    n_bootstrap: int,
    rng: np.random.Generator,
) -> dict[str, Any]:
    """One information-coefficient row, with its bootstrap interval.

    The ranks are computed ONCE over the whole window and the blocks
    then resample ranked pairs, which bootstraps the product-moment
    correlation of the rank transform rather than re-ranking inside
    every resample. The distinction is second order; re-ranking a
    forty-thousand-element pooled sample a thousand times per window
    per horizon is a diagnostic slow enough that nobody runs it, and a
    diagnostic nobody runs is worth less than a second-order
    approximation.
    """
    s = score.to_numpy(dtype="float64")
    f = forward.to_numpy(dtype="float64")
    cell = np.isfinite(s) & np.isfinite(f)
    rows = np.flatnonzero(cell.any(axis=1))

    row: dict[str, Any] = {
        "scope": scope,
        "period": window.name,
        "kind": _period_kind(window),
        "horizon": int(horizon),
        "n": 0,
        "n_dates": int(rows.size),
        "ic": float("nan"),
        "ci_low": float("nan"),
        "ci_high": float("nan"),
        "block": int(block),
        "n_blocks": 0,
        "method": (
            f"Spearman; {CI_LEVEL:.0%} moving-block bootstrap, "
            f"block {block} sessions"
        ),
        "note": "",
    }
    if rows.size == 0:
        row["note"] = "no scored session with a forward return in this window"
        return row

    s, f, cell = s[rows], f[rows], cell[rows]
    n_obs = int(cell.sum())
    row["n"] = n_obs
    if n_obs < 3:
        row["note"] = "fewer than three observations"
        return row

    rank_s = np.full(s.shape, np.nan)
    rank_f = np.full(f.shape, np.nan)
    rank_s[cell] = _average_ranks(s[cell])
    rank_f[cell] = _average_ranks(f[cell])
    row["ic"] = _pearson(rank_s[cell], rank_f[cell])

    n_rows = int(rows.size)
    n_blocks = n_rows // int(block)
    row["n_blocks"] = n_blocks
    if n_blocks < MIN_BLOCKS_FOR_CI:
        row["note"] = (
            f"{n_blocks} block(s) of {block} sessions — fewer than "
            f"{MIN_BLOCKS_FOR_CI}, so no interval is reported rather than a "
            "wide one that looks computed"
        )
        return row
    if math.isnan(row["ic"]):
        row["note"] = "the score or the forward return never varied here"
        return row

    draws = np.empty(int(n_bootstrap), dtype="float64")
    take = n_blocks * int(block)
    highest = n_rows - int(block)
    for i in range(int(n_bootstrap)):
        starts = rng.integers(0, highest + 1, size=n_blocks)
        idx = (starts[:, None] + np.arange(int(block))[None, :]).ravel()[:take]
        sel = cell[idx]
        draws[i] = _pearson(rank_s[idx][sel], rank_f[idx][sel])

    good = draws[np.isfinite(draws)]
    if good.size < int(n_bootstrap) // 2:
        row["note"] = "over half the resamples were degenerate; interval withheld"
        return row
    lo = (1.0 - CI_LEVEL) / 2.0 * 100.0
    row["ci_low"] = float(np.percentile(good, lo))
    row["ci_high"] = float(np.percentile(good, 100.0 - lo))
    return row


def _hit_and_spread(
    score: pd.DataFrame,
    forward: pd.DataFrame,
    *,
    scope: str,
    window: NamedPeriod,
    horizon: int,
    levels: Sequence[float],
    periods_per_year: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Hit rate at the two ends of the range, and the spread between them.

    Only the endpoints, because any interior cut-off is a parameter and
    a parameter chosen here would be chosen by looking at the answer.
    The base rate travels in the same row: a hit rate quoted alone
    always reads as skill, and in a sample where two thirds of months
    are positive a 66% hit rate is the market, not the signal.
    """
    s = score.to_numpy(dtype="float64").ravel()
    f = forward.to_numpy(dtype="float64").ravel()
    ok = np.isfinite(s) & np.isfinite(f)
    s, f = s[ok], f[ok]

    top = float(max(levels))
    bottom = float(min(levels))
    on = s >= top - 1e-12
    off = s <= bottom + 1e-12

    base = float((f > 0.0).mean()) if f.size else float("nan")
    mean_on = float(f[on].mean()) if on.any() else float("nan")
    mean_off = float(f[off].mean()) if off.any() else float("nan")
    spread = mean_on - mean_off

    hit = {
        "scope": scope,
        "period": window.name,
        "kind": _period_kind(window),
        "horizon": int(horizon),
        "n": int(s.size),
        "n_on": int(on.sum()),
        "n_off": int(off.sum()),
        "hit_rate_on": float((f[on] > 0.0).mean()) if on.any() else float("nan"),
        "hit_rate_off": float((f[off] < 0.0).mean()) if off.any() else float("nan"),
        "base_rate_positive": base,
        # Lift is the number to read. A hit rate is a level and a level
        # is meaningless without the market's own.
        "lift_on": (
            float((f[on] > 0.0).mean()) - base if on.any() else float("nan")
        ),
        "lift_off": (
            float((f[off] < 0.0).mean()) - (1.0 - base)
            if off.any()
            else float("nan")
        ),
    }

    scale = float(periods_per_year) / float(horizon)
    spread_row = {
        "scope": scope,
        "period": window.name,
        "kind": _period_kind(window),
        "horizon": int(horizon),
        "n_on": int(on.sum()),
        "n_off": int(off.sum()),
        "mean_on": mean_on,
        "mean_off": mean_off,
        "spread": spread,
        # A scaling of an overlapping-window mean, for reading aloud.
        # Nobody collected this.
        "spread_annualised": (
            float((1.0 + spread) ** scale - 1.0)
            if np.isfinite(spread) and spread > -1.0
            else float("nan")
        ),
    }
    return hit, spread_row


# -- the standalone curves ----------------------------------------------


def _curves(
    *,
    panel: TrendPanel,
    simple: pd.DataFrame,
    rf_daily: pd.Series,
    risk_free: float | pd.Series,
    cost_bps: float,
    windows: Sequence[NamedPeriod],
    periods_per_year: int,
) -> tuple[
    dict[str, pd.Series], dict[str, pd.Series], pd.DataFrame, pd.DataFrame
]:
    """Long/flat on each sleeve alone, against costless buy-and-hold.

    An unscored session is held FLAT rather than at some prior weight,
    and that is a claim worth being explicit about: with no opinion the
    money sits in cash, which is a position this account can actually
    hold and which asserts nothing about the sleeve. The count of those
    sessions rides along in the summary, because a curve that is
    two-thirds cash-by-abstention is not really a test of the signal.
    """
    weights = panel.score.shift(FILL_LAG_SESSIONS).fillna(0.0)
    asset_r = simple.fillna(0.0)

    curves: dict[str, pd.Series] = {}
    benchmarks: dict[str, pd.Series] = {}
    rows: list[dict[str, Any]] = []

    prev = weights.shift(1).fillna(0.0)
    churn = (weights - prev).abs()
    charge = churn * (cost_bps / 1e4)

    for col in weights.columns:
        w = weights[col]
        net = w * asset_r[col] + (1.0 - w) * rf_daily - charge[col]
        net.name = str(col)
        curves[str(col)] = (1.0 + net).cumprod()
        benchmarks[str(col)] = (1.0 + asset_r[col]).cumprod()

        for window in windows:
            mask = _period_mask(weights.index, window)
            if mask.sum() < 2:
                continue
            rows.append(
                _curve_row(
                    asset=str(col),
                    window=window,
                    net=net.loc[mask],
                    gross=asset_r[col].loc[mask],
                    weight=w.loc[mask],
                    churn=churn[col].loc[mask],
                    charge=charge[col].loc[mask],
                    known=panel.known[col].loc[mask],
                    risk_free=risk_free,
                    periods_per_year=periods_per_year,
                )
            )

    return curves, benchmarks, weights, pd.DataFrame(rows)


def _curve_row(
    *,
    asset: str,
    window: NamedPeriod,
    net: pd.Series,
    gross: pd.Series,
    weight: pd.Series,
    churn: pd.Series,
    charge: pd.Series,
    known: pd.Series,
    risk_free: float | pd.Series,
    periods_per_year: int,
) -> dict[str, Any]:
    """One (asset, period) row of the curve table.

    Compounded from the RETURN series sliced to the window rather than
    from a NAV curve sliced to it, which sidesteps the anchoring
    problem `metrics.period_breakout` has to solve by hand: a NAV
    slice has to reach back one bar to keep the window's own first
    session, and forgetting to leaks the same way in every window.
    """
    strat_nav = _nav(net)
    bench_nav = _nav(gross)
    years = (strat_nav.index[-1] - strat_nav.index[0]).days / metrics.DAYS_PER_YEAR

    return {
        "asset": asset,
        "period": window.name,
        "kind": _period_kind(window),
        "sessions": int(len(net)),
        "unscored_sessions": int((~known).sum()),
        "time_in_market": float(weight.mean()),
        "annual_turnover": float(churn.sum() / years) if years > 0 else float("nan"),
        "cost_drag_bps": (
            float(charge.sum() / years * 1e4) if years > 0 else float("nan")
        ),
        "strat_total_return": float(strat_nav.iloc[-1] - 1.0),
        "strat_cagr": metrics.cagr(strat_nav),
        "strat_vol": metrics.annualised_volatility(
            net, periods_per_year=periods_per_year
        ),
        "strat_sharpe": metrics.sharpe_ratio(
            net, rf=risk_free, periods_per_year=periods_per_year
        ),
        "strat_max_drawdown": metrics.max_drawdown(strat_nav).depth,
        "bh_total_return": float(bench_nav.iloc[-1] - 1.0),
        "bh_cagr": metrics.cagr(bench_nav),
        "bh_vol": metrics.annualised_volatility(
            gross, periods_per_year=periods_per_year
        ),
        "bh_sharpe": metrics.sharpe_ratio(
            gross, rf=risk_free, periods_per_year=periods_per_year
        ),
        "bh_max_drawdown": metrics.max_drawdown(bench_nav).depth,
    }


def _nav(returns: pd.Series) -> pd.Series:
    """Compound a return series into a NAV curve that starts at one.

    The leading 1.0 is not decoration. Without it the curve's first
    value is already the first session's result, so a window that opens
    with a fall has no peak to fall FROM and its drawdown is understated
    by exactly that session — which is the one session a stress window
    like 2020Q1 is most likely to have been chosen for.
    """
    idx = pd.DatetimeIndex(returns.index)
    anchor = idx[0] - pd.Timedelta(days=1)
    values = np.r_[1.0, (1.0 + returns.to_numpy(dtype="float64")).cumprod()]
    return pd.Series(
        values,
        index=pd.DatetimeIndex([anchor]).append(idx),
        dtype="float64",
        name="nav",
    )
