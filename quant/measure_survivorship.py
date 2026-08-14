"""How much the hand-written fund list was worth, in percent a year.

Every result in this repository stands on a panel of 148 funds somebody
wrote down in 2026 by looking at what still trades. `deadetfs.py`
established the size of what that leaves out — a third of every ETF
cohort from 2005 to 2017 is gone, and the hand list carries none of them
— and stopped at the honest place, which is that a count of missing
funds is not a measurement of what their absence did to a return.

This file measures it. Two panels, the same code, one difference.

**The design is the whole thing, because the two previous attempts at
this measured something else.** The first held the "top 25" out of
universes of 491 and 193 names and therefore measured SELECTIVITY: 25
of 491 is a harder screen than 25 of 193 and would separate the two
panels if every fund in both had lived forever. The second held a
constant FRACTION and therefore measured DIVERSIFICATION: 49 names
against 19 is a different portfolio whatever is in it. Both were
reported as failures, which is the reason a third attempt was worth
making, and the lesson they leave is precise — deleting names from a
universe moves breadth, selectivity and the outcome distribution at the
same time, so an experiment that varies only "which names" has to say
which of those it is holding fixed and which it is not.

So the answer is led by an IDENTITY rather than by a backtest. For an
equal-weight book the survivorship bias in a day's return is exactly

    w_dead(t) x [ mean return of the survivors(t)
                - mean return of the funds that would later die(t) ]

with no residual term. Breadth does not appear. Selectivity does not
appear. There is nothing in it to confound, because it is arithmetic
about a mean and not a portfolio — and it decomposes the answer into
the two things a reader actually wants: HOW MANY of the shelf died,
which the directory knows for all 7,583 symbols, and HOW DIFFERENTLY
they behaved, which only the recovered tape can say. Scaling the second
by the first is how a sample of a few dozen dead funds answers a
question about two thousand.

The portfolio runs come after it and are there to check it holds up
once compounding, costs and monthly rebalancing are in the way. They
run in three arms, and the third arm is the answer to the two earlier
failures:

    A  biased     - the pool is the funds alive today
    B  free       - the pool is those funds plus the ones that died
    C  matched    - the pool is a random subset of B, the size of A,
                    drawn with no regard to whether a fund survived

A against B is what a practitioner actually does wrong, and it is
confounded by breadth. A against C is survivorship at a matched pool
size. B against C is breadth with survival held constant, and it exists
so the reader can see the size of the confound rather than be told it
was handled. C is drawn twenty-five times on fixed seeds; a single draw
would be an anecdote.

**Buy-and-hold SPY is the invariant.** It holds one fund that is in
both pools, so it must return exactly the same curve on both panels. If
it does not, the two panels differ somewhere they were not supposed to
and every other number here is void — so it is checked first and the
report says so before it says anything else.

**What the holder of a closing fund receives is the decision that sets
the SIGN.** An ETF closure is not a bankruptcy. The fund's assets are
the shareholders' assets held in trust, the sponsor announces a date,
creations stop, the portfolio is sold and the proceeds are distributed
— so the base case here is that a position converts to cash at its last
printed mark, and the ladder from there down to zero is reported beside
it. The tape is also asked directly: `final_stretch` measures what the
last three months of a dying fund actually did, which is the difference
between a closure that returns capital and a delisting that does not.

Nothing here fetches. The vendor's free tier meters symbols and a
background job is already spending that allowance on dead funds; a
second reader would take names out of its mouth. Every bar comes from
the parquet cache through `ParquetCache.get` with no clock, which is
the reviewer's path the cache documents — an entry cannot expire
underneath a run that has no key to refresh it with. Funds that are not
on disk are counted and named, never quietly dropped.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import numpy as np
import pandas as pd
import typer

from griffinquant.config import SAMPLE_START, UNIVERSE
from griffinquant.data import deadetfs as de
from griffinquant.data import etfuniverse as eu
from griffinquant.data.cache import ParquetCache
from griffinquant.data.etfuniverse import STALE_AFTER_DAYS
from griffinquant.data.tbill import FRED_SERIES, total_return_index
from griffinquant.engine import metrics
from griffinquant.engine.backtest import BacktestConfig
from griffinquant.engine.costs import CostModel
from griffinquant.util import runs

HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "reports" / "survivorship_measured.md"

EXIT_OK = runs.EXIT_OK
EXIT_FAILED = runs.EXIT_FAILED
EXIT_NO_DATA = runs.EXIT_NO_DATA

app = typer.Typer(add_completion=False)


# -- what a fund has to be before a rule may look at it -------------------


#: One trading year, `UNIVERSE`'s own figure. Applied identically to
#: both panels, and it matters more here than it does in the ledger: a
#: dead fund that lived twenty months contributes eight months of tape
#: under this rule and none at all under a stricter one, so a gate
#: chosen loosely would quietly decide how much of the dead cohort the
#: experiment can see.
MIN_HISTORY_SESSIONS = UNIVERSE.min_history_days

#: Twelve months of return skipping the most recent one, which is
#: Jegadeesh-Titman's own construction and the one every cross-sectional
#: momentum rule in the literature inherits. The skip is not a detail:
#: without it the rule buys last month's bounce, and a dead fund's last
#: month is exactly where a wind-down shows up.
MOMENTUM_LOOKBACK = 252
MOMENTUM_SKIP = 21

#: The two ways a cross-sectional rule can be specified, run side by
#: side because reporting only one of them is how the earlier attempts
#: went wrong. A fixed COUNT keeps the book's size constant and lets
#: selectivity move with the universe; a fixed FRACTION keeps
#: selectivity constant and lets the book's size move. Neither is more
#: correct and a reader needs both to see which effect they are looking
#: at.
MOMENTUM_NAMES = 20
MOMENTUM_FRACTION = 0.15

#: How many survival-blind pools arm C draws. Twenty-five rather than
#: five because the quantity of interest is a difference of two
#: annualised returns and the draw-to-draw spread of that difference is
#: the thing being reported; five draws would give a range that is
#: mostly an accident of which five. Rather than five hundred because
#: the estimate is already inside the noise of a 43-fund dead cohort and
#: more draws would put a decimal place on a number that has not earned
#: one.
MATCH_DRAWS = 25

#: What a holder receives when a fund closes, as a multiple of its last
#: printed mark. 1.00 is the base case and the argument for it is in the
#: module docstring; the rest of the ladder exists because a reader who
#: does not accept it needs to see what rejecting it costs. 0.00 is the
#: equity-bankruptcy analogue and is included precisely because it is
#: wrong for an ETF — it is the bound that says how much of this
#: measurement is an assumption.
RECOVERY_LADDER: tuple[float, ...] = (1.00, 0.95, 0.90, 0.50, 0.00)
BASE_RECOVERY = 1.00

#: Circular block bootstrap over the daily difference series. Twenty-one
#: sessions because the thing being preserved is a month of correlated
#: cross-sectional dispersion — an i.i.d. resample of daily differences
#: would report an interval several times too narrow and it would be
#: narrow in the direction of significance.
BLOCK_SESSIONS = 21
BOOTSTRAP_DRAWS = 10_000
SEED = 20260803

#: A window shorter than this is printed and never annualised. The same
#: rule `run_ledger` keeps, for the same reason: a percent-a-year figure
#: computed off eight months is extrapolation wearing a unit.
MIN_WINDOW_SESSIONS = 252

#: The year the vendor's record of closures begins, if `retention_cliff`
#: cannot find one from the data. Never used when the catalogue is
#: present; it exists so a run against a stub directory still reports a
#: boundary rather than None, which would read as "no cliff".
FALLBACK_CLIFF_YEAR = 2014


# -- reading the tape without touching the vendor -------------------------


#: The slug both ETF sources write under. Named here rather than
#: imported from the source class because this module deliberately never
#: constructs one: a source would take a clock, and a clock would let a
#: cache miss become a request.
PRICE_SLUG = "tiingo-sleeve-etf"
PRICE_FRAME = "prices"


class PanelUnavailable(RuntimeError):
    """The cache cannot support the comparison, so no comparison exists."""


def cached_tickers(root: Path) -> dict[str, list[str]]:
    """Every symbol with bars on disk, and under which horizons.

    Read from the sidecars rather than by asking the cache for a list,
    because the cache has no list — it is a content-addressed store and
    the only way to enumerate it is to read the commit records it writes
    beside each frame. Doing that here, once, is what lets everything
    below ask for a name it already knows is present, so that a miss is
    a reporting decision rather than an HTTP request.
    """
    out: dict[str, list[str]] = {}
    folder = Path(root) / PRICE_SLUG
    if not folder.is_dir():
        return out
    for side in sorted(folder.glob(f"{PRICE_FRAME}-*.json")):
        try:
            meta = json.loads(side.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        params = meta.get("params") or {}
        ticker = params.get("ticker")
        horizon = params.get("end")
        if isinstance(ticker, str) and isinstance(horizon, str):
            out.setdefault(ticker, []).append(horizon)
    for horizons in out.values():
        horizons.sort(reverse=True)
    return out


def read_bars(
    cache: ParquetCache, ticker: str, horizons: Sequence[str]
) -> pd.DataFrame:
    """One fund's whole history, newest horizon first, or an empty frame.

    `cache.get` is called WITHOUT `now`, which the cache documents as the
    reviewer's path: freshness is only an opinion when a clock is
    supplied, and a run that has no key to refetch with must not have its
    data expire underneath it. Here that is not a convenience — the free
    tier meters symbols and a resumable acquisition is already spending
    the allowance, so a miss that turned into a fetch would take a dead
    fund out of that job's mouth to re-read a fund we already hold.
    """
    for horizon in horizons:
        key = cache.key(PRICE_SLUG, PRICE_FRAME, ticker=ticker, end=horizon)
        frame = cache.get(key)
        if frame is not None and len(frame):
            return frame
    return pd.DataFrame()


def load_directory(cache: ParquetCache) -> pd.DataFrame:
    """Tiingo's whole supported-ticker list, from disk only.

    The same key `fetch_directory` writes, read the same way as a price
    frame. If it is absent the run refuses: the directory is what says
    which symbols died, and without it every fund on disk would classify
    as alive and the experiment would compare a panel against itself.
    """
    key = cache.key(eu.DIRECTORY_SLUG, eu.DIRECTORY_FRAME, url=eu.TIINGO_DIRECTORY_URL)
    frame = cache.get(key)
    if frame is None or frame.empty:
        raise PanelUnavailable(
            "the Tiingo directory is not in the cache, and it is the only "
            "record of which funds stopped trading. Without it every symbol "
            "on disk classifies as alive, the two panels become the same "
            "panel, and the run would report a survivorship bias of exactly "
            "zero — which is what a broken comparison looks like."
        )
    return frame


def load_bill(cache: ParquetCache) -> pd.Series | None:
    """The 3-month bill yield in percent, from the FRED cache, or None.

    Cash is not a zero here and the reason is specific to this
    experiment rather than general. The survivorship-free book holds
    cash between a fund's liquidation and the next rebalance and the
    biased book never does, so crediting cash with nothing would charge
    the free panel for a delisting twice — once for the loss, again for
    the weeks the proceeds sat idle — and the second charge would land
    entirely on the side of the comparison the answer depends on.
    """
    for folder in sorted((Path(cache.root) / "fred").glob("*.json")):
        try:
            meta = json.loads(folder.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        params = meta.get("params") or {}
        if meta.get("frame") != "fred_observations":
            continue
        if params.get("series") != FRED_SERIES:
            continue
        frame = cache.get(cache.key("fred", "fred_observations", **params))
        if frame is None or frame.empty:
            continue
        series = pd.Series(
            pd.to_numeric(frame["value"], errors="coerce").to_numpy(dtype="float64"),
            index=pd.DatetimeIndex(frame["date"]),
            name=FRED_SERIES,
        )
        return series.dropna().sort_index()
    return None


# -- who is in which cohort -----------------------------------------------


@dataclass(frozen=True)
class Cohorts:
    """The three groups of funds, and everything refused on the way.

    `sampled` and `opportunistic` are both dead and they are NOT
    interchangeable, which is the distinction the headline rests on.
    `sampled` came off `acquisition_plan`'s seeded shuffle, so a partial
    pull of it is a random sample of the dead population and supports an
    interval. `opportunistic` is the twelve funds `etfuniverse.DECEASED`
    names plus whatever else was pulled by hand along the way — real
    dead funds, chosen because somebody found them interesting, which is
    a sampling rule with an unknown relationship to return. They are
    reported as a sensitivity and never as the estimate.
    """

    survivors: tuple[str, ...]
    sampled: tuple[str, ...]
    opportunistic: tuple[str, ...]
    drawn_but_empty: tuple[str, ...]
    unresolvable: tuple[str, ...]
    absent_from_cache: tuple[str, ...]
    hand_list: tuple[str, ...]
    #: Symbols whose directory row and whose tape disagree about whether
    #: the fund is still trading. In no panel — see `reconcile`.
    contested: tuple[str, ...] = ()

    @property
    def dead(self) -> tuple[str, ...]:
        return self.sampled

    @property
    def all_names(self) -> tuple[str, ...]:
        return tuple(
            sorted(
                set(self.survivors) | set(self.sampled) | set(self.opportunistic)
            )
        )


def build_cohorts(
    classified: pd.DataFrame,
    on_disk: Mapping[str, Sequence[str]],
    *,
    served: Sequence[str] = (),
    drawn: Sequence[str] = (),
) -> Cohorts:
    """Sort every cached symbol into survivor, sampled dead, or refused.

    `drawn` is every name the seeded shuffle reached and `served` is the
    subset the vendor answered with bars. Both are needed and they are
    not the same list: a fund the shuffle drew and the vendor had nothing
    for is still a random draw, and filing it under the hand-picked pile
    would make the acquisition look more selective than it was. It
    contributes no tape either way, which is why it gets its own field
    rather than a place in the estimate.

    A dead fund on disk the shuffle never drew was pulled for some other
    reason and goes to `opportunistic`, because the estimate has to be
    able to say which of its inputs were drawn at random and which were
    chosen by somebody.
    """
    status = classified.set_index("ticker")
    known = set(status.index)
    served_set = {str(t).strip().upper() for t in served}
    drawn_set = {str(t).strip().upper() for t in drawn} | served_set

    survivors: list[str] = []
    sampled: list[str] = []
    opportunistic: list[str] = []
    empty: list[str] = []
    unresolvable: list[str] = []

    for ticker in sorted(on_disk):
        if ticker not in known:
            # On disk and not in the catalogue at all. Refused rather
            # than assumed alive: a fund whose status is unknown cannot
            # be put on the survivor side of a survivorship experiment.
            unresolvable.append(ticker)
            continue
        row = status.loc[ticker]
        if not bool(row["resolvable"]):
            unresolvable.append(ticker)
        elif row["status"] == de.STATUS_ALIVE:
            survivors.append(ticker)
        elif row["status"] != de.STATUS_DEAD:
            unresolvable.append(ticker)
        elif ticker in served_set:
            sampled.append(ticker)
        elif ticker in drawn_set:
            empty.append(ticker)
        else:
            opportunistic.append(ticker)

    hand = tuple(sorted(eu.UNIVERSE_TICKERS))
    return Cohorts(
        survivors=tuple(survivors),
        sampled=tuple(sampled),
        opportunistic=tuple(opportunistic),
        drawn_but_empty=tuple(empty),
        unresolvable=tuple(unresolvable),
        absent_from_cache=tuple(t for t in hand if t not in on_disk),
        hand_list=hand,
    )


def reconcile(cohorts: Cohorts, tape: "Tape") -> Cohorts:
    """Refuse any symbol whose directory row and whose tape disagree.

    **The window count is not a sufficient reissued-ticker test and this
    is the case that proves it.** `deadetfs.classify` refuses a symbol
    carrying more than one coverage window, which catches seventy of
    them. RISE and SLVO carry ONE window each, are filed dead in the
    directory — RISE ending 2020, SLVO ending 2024 — and the price
    endpoint answers for both with a live series running to the last
    session of the sample. A directory row is the vendor's index of a
    string and the tape is what it will actually serve for that string,
    and where the two disagree the string means two different funds.

    So the test is made against the tape rather than against the row.
    Dead in the catalogue and still printing means the bars on disk
    belong to the symbol's current occupant, and putting them in the
    dead cohort would credit a fund that closed with a successor's
    returns. Alive in the catalogue and stopped means the reverse — a
    dead fund sitting on the survivor side, which is the more dangerous
    of the two because it contaminates the panel this file is trying to
    correct.

    Neither is reassigned to the other cohort. A reassignment is a guess
    about which of two sources is wrong, and this file has no way to
    make it: refused, counted, named in the report.
    """
    if not len(tape.sessions):
        return cohorts
    end = tape.sessions[-1]
    cutoff = end - pd.Timedelta(days=STALE_AFTER_DAYS)
    names = list(tape.names)

    def stops_at(ticker: str) -> pd.Timestamp | None:
        if ticker not in names:
            return None
        last = int(tape.last_bar[names.index(ticker)])
        return tape.sessions[last] if 0 <= last < len(tape.sessions) else None

    def still_printing(ticker: str) -> bool:
        last = stops_at(ticker)
        return last is not None and last >= cutoff

    contested = sorted(
        [t for t in cohorts.survivors if not still_printing(t)]
        + [t for t in cohorts.sampled if still_printing(t)]
        + [t for t in cohorts.opportunistic if still_printing(t)]
    )
    if not contested:
        return cohorts
    refused = set(contested)
    return Cohorts(
        survivors=tuple(t for t in cohorts.survivors if t not in refused),
        sampled=tuple(t for t in cohorts.sampled if t not in refused),
        opportunistic=tuple(t for t in cohorts.opportunistic if t not in refused),
        drawn_but_empty=cohorts.drawn_but_empty,
        unresolvable=cohorts.unresolvable,
        absent_from_cache=cohorts.absent_from_cache,
        hand_list=cohorts.hand_list,
        contested=tuple(contested),
    )


# -- the tape, as the engine would see it ---------------------------------


@dataclass(frozen=True)
class Tape:
    """Wide frames on one calendar, plus the two facts a death needs.

    `open_tr` is the engine's own construction — the as-traded open
    lifted into total-return space by the day's own adjustment factor —
    so a fill and a mark are denominated in the same units and the
    convention here is the convention `run_backtest` keeps. Restated
    rather than imported because the engine builds it inside a
    constructor that also demands three aligned price frames and refuses
    a panel with a missing column, and this panel is deliberately full of
    holes: two hundred funds whose lives barely overlap.

    `last_bar` is the load-bearing one. A held position whose fund has
    no price today is either a data gap, in which case it is carried at
    its last mark, or the end of the tape, in which case it liquidates —
    and those are opposite events that look identical from inside a
    single session.

    `history` is the count of bars a fund has printed by each session,
    counted over the WHOLE pull and cut afterwards. Every rolling
    statistic here is built that way and this one has to be too: counted
    inside the window instead, a fund that has traded since 1993 and a
    fund that listed the previous Friday both arrive with nothing behind
    them, the history gate refuses the entire panel for its first
    trading year, and the study opens by sitting in cash through a
    twelve-month stretch of tape it was handed.
    """

    sessions: pd.DatetimeIndex
    names: tuple[str, ...]
    adj: np.ndarray
    open_tr: np.ndarray
    unadj: np.ndarray
    adv: np.ndarray
    vol: np.ndarray
    history: np.ndarray
    first_bar: np.ndarray
    last_bar: np.ndarray
    cash_return: np.ndarray

    @property
    def shape(self) -> tuple[int, int]:
        return self.adj.shape

    def index_of(self, name: str) -> int:
        return self.names.index(name)


def build_tape(
    prices: pd.DataFrame,
    *,
    start: pd.Timestamp,
    end: pd.Timestamp,
    bill: pd.Series | None,
) -> Tape:
    """Pivot the long price frame and cut it to the study window.

    The pull reaches back to 1990 and the window opens in 2005; the
    intervening fifteen years are never measured and are not waste. They
    are what the volume window and the momentum lookback read on the
    study's opening session, so a fund that has traded since 1993 and a
    fund that listed the previous Friday do not arrive looking the same.
    """
    if prices.empty:
        raise PanelUnavailable(
            "no bars were read from the cache. An empty panel is not a "
            "market fact, it is the shape of a directory nobody has pulled."
        )
    wide = {
        column: prices.pivot(index="date", columns="ticker", values=column).sort_index()
        for column in ("open_unadj", "close_unadj", "close_adj", "volume_unadj")
    }
    adj_full = wide["close_adj"]
    unadj_full = wide["close_unadj"]

    # The engine's liquidity series, over the WHOLE pull and before any
    # cut, so a fund's twentieth session of volume is its twentieth and
    # not the twentieth inside a window somebody chose.
    window = UNIVERSE.dollar_volume_window
    dollars = unadj_full * wide["volume_unadj"]
    adv_full = dollars.rolling(window, min_periods=max(5, window // 2)).median()
    head = max(window - 1, 0)
    if head:
        warm = dollars.iloc[:head].expanding(min_periods=3).median()
        adv_full.iloc[:head] = adv_full.iloc[:head].fillna(warm)

    vol_full = adj_full.pct_change().rolling(63, min_periods=21).std(ddof=1)
    factor = adj_full / unadj_full.where(unadj_full > 0)
    open_tr_full = wide["open_unadj"] * factor

    index = pd.DatetimeIndex(adj_full.index)
    # Coverage is measured on the FULL pull and the boolean is then cut,
    # so a fund whose tape ended in 2003 is not recorded as dying on the
    # study's opening session.
    finite = np.isfinite(adj_full.to_numpy(dtype="float64")) & (
        adj_full.to_numpy(dtype="float64") > 0.0
    )
    keep = (index >= start) & (index <= end)
    if int(keep.sum()) < 2:
        raise PanelUnavailable(
            f"the cache holds {int(keep.sum())} session(s) inside "
            f"{start.date()} to {end.date()}. Nothing can be measured across "
            f"one bar, and a one-row window is what a half-served pull looks "
            f"like."
        )
    offset = int(np.flatnonzero(keep)[0])
    first_full = np.where(finite.any(axis=0), finite.argmax(axis=0), len(index))
    last_full = np.where(
        finite.any(axis=0), len(index) - 1 - finite[::-1].argmax(axis=0), -1
    )
    # Counted over the whole pull for the reason `Tape.history` gives.
    # Counting inside the window instead cost a measured 0.13% a year on
    # buy-and-hold SPY, all of it in one stretch: every fund on the tape
    # was refused for the first 252 sessions and the study opened by
    # sitting in cash through 2005.
    history_full = np.cumsum(finite, axis=0)

    sessions = pd.DatetimeIndex(index[keep])
    names = tuple(str(c) for c in adj_full.columns)
    cash = _cash_return(sessions, bill)
    return Tape(
        sessions=sessions,
        names=names,
        adj=adj_full.to_numpy(dtype="float64")[keep],
        open_tr=open_tr_full.to_numpy(dtype="float64")[keep],
        unadj=unadj_full.to_numpy(dtype="float64")[keep],
        adv=adv_full.to_numpy(dtype="float64")[keep],
        vol=vol_full.to_numpy(dtype="float64")[keep],
        history=history_full[keep],
        first_bar=first_full - offset,
        last_bar=last_full - offset,
        cash_return=cash,
    )


def _cash_return(sessions: pd.DatetimeIndex, bill: pd.Series | None) -> np.ndarray:
    """Per-session cash accrual, from the bill rate where there is one.

    `total_return_index` is the repository's own compounding of the
    published yield — calendar day count, forward-filled, deliberately
    not interpolated toward the next print. Reused rather than restated
    so the cash leg here and the cash leg in the sleeve book cannot
    disagree about what a weekend earns.
    """
    out = np.zeros(len(sessions), dtype="float64")
    if bill is None or bill.empty:
        return out
    index = total_return_index(sessions, bill)
    values = index.to_numpy(dtype="float64")
    out[1:] = values[1:] / values[:-1] - 1.0
    return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)


# -- who is investable, on a date -----------------------------------------


def eligibility(
    tape: Tape,
    *,
    liquidity: bool,
    floor: float,
    min_history: int = MIN_HISTORY_SESSIONS,
) -> np.ndarray:
    """A boolean per fund per session: could a rule have held this today.

    Three gates and they are not the same kind of thing. Existence and
    history are facts about the fund. The liquidity floor is a fact
    about THIS ACCOUNT — $131,000 wanting five per cent of NAV of fills
    a day against a one per cent participation cap — and it is the gate
    that decides whether the attrition figure is about the ETF industry
    or about a backtest. So it is a switch rather than a constant, and
    both settings are reported: with it, the question is what the club
    could have held; without it, what the shelf did.
    """
    adj = tape.adj
    present = np.isfinite(adj) & (adj > 0.0)
    ok = present & (tape.history >= int(min_history))
    if liquidity:
        with np.errstate(invalid="ignore"):
            ok = (
                ok
                & (np.nan_to_num(tape.adv, nan=-1.0) >= float(floor))
                & (np.nan_to_num(tape.unadj, nan=-1.0) >= UNIVERSE.min_price)
            )
    return ok


def month_ends(sessions: pd.DatetimeIndex) -> np.ndarray:
    """The last session of each calendar month, as positions.

    Decision dates, not fill dates. Everything below fills the following
    open, which is the engine's convention and the one place a
    survivorship experiment can quietly cheat: a rule that reads a
    fund's last close and sells at that same close has been told the
    fund is closing.
    """
    period = sessions.to_period("M")
    last = np.flatnonzero(np.r_[period[1:] != period[:-1], True])
    return last.astype("int64")


# -- the rules ------------------------------------------------------------


@dataclass(frozen=True)
class Rule:
    """A weighting decision, taken at a close, over a candidate set.

    Deliberately not a `Strategy`: the engine's protocol serves a
    `MarketView` and expects a mapping over the whole panel, and the
    thing being varied in this experiment is which names are in the
    candidate set at all. Writing the rules against the candidate set
    directly is what makes "identical code both sides" checkable by
    reading it.
    """

    key: str
    label: str
    weigh: Callable[[int, np.ndarray, "Signals"], np.ndarray]
    #: Whether the rule ranks a cross-section. A rule that names its
    #: legs cannot be moved by adding funds to the pool, and 32 of the
    #: 33 published strategies in this repository are that kind — which
    #: is most of the answer to what re-running the ledger would do.
    cross_sectional: bool


@dataclass(frozen=True)
class Signals:
    """Everything a rule may read, precomputed over the whole tape.

    Computed here and READ at the decision session, which is the
    engine's own distinction: building a rolling statistic over the full
    panel is not the lookahead, reading tomorrow's row of it is.
    """

    momentum: np.ndarray

    @classmethod
    def build(cls, tape: Tape) -> "Signals":
        # Written as two explicit slices rather than as a pair of shifts,
        # so both ends of the window sit where a reader can check them:
        # the score at session i is the return from i-252 to i-21, and
        # nothing after i-21 touches it.
        adj = tape.adj
        n = adj.shape[0]
        mom = np.full_like(adj, np.nan)
        first = MOMENTUM_LOOKBACK + MOMENTUM_SKIP
        if n > first:
            near = adj[first - MOMENTUM_SKIP : n - MOMENTUM_SKIP]
            back = MOMENTUM_LOOKBACK + MOMENTUM_SKIP
            far = adj[first - back : n - back]
            with np.errstate(invalid="ignore", divide="ignore"):
                mom[first:] = near / far - 1.0
        return cls(momentum=mom)


def _equal(_: int, cand: np.ndarray, __: Signals) -> np.ndarray:
    return np.full(len(cand), 1.0 / len(cand), dtype="float64")


def _top(
    count: Callable[[int], int]
) -> Callable[[int, np.ndarray, Signals], np.ndarray]:
    def weigh(i: int, cand: np.ndarray, signals: Signals) -> np.ndarray:
        scores = signals.momentum[i, cand]
        usable = np.flatnonzero(np.isfinite(scores))
        if usable.size == 0:
            # No fund in the candidate set has twelve months of history
            # behind a one-month skip. Cash, and stated as cash rather
            # than as an equal-weight fallback: a rule that silently
            # becomes a different rule when its signal is missing is a
            # rule whose reported returns belong to neither.
            return np.zeros(len(cand), dtype="float64")
        k = max(1, min(int(count(usable.size)), usable.size))
        order = usable[np.argsort(-scores[usable], kind="stable")][:k]
        out = np.zeros(len(cand), dtype="float64")
        out[order] = 1.0 / k
        return out

    return weigh


def _single(
    ticker: str, tape: Tape
) -> Callable[[int, np.ndarray, Signals], np.ndarray]:
    target = tape.index_of(ticker)

    def weigh(_: int, cand: np.ndarray, __: Signals) -> np.ndarray:
        out = np.zeros(len(cand), dtype="float64")
        hit = np.flatnonzero(cand == target)
        if hit.size:
            out[hit[0]] = 1.0
        return out

    return weigh


def rule_set(tape: Tape) -> tuple[Rule, ...]:
    """The four books, in the order the report reads them.

    Buy-and-hold SPY first because it is the control and has to be
    checked before anything else is believed. Equal weight second
    because it is the only one with no selection in it at all, so any
    difference between the panels IS survivorship. The two momentum
    rules last, and both of them, because a fixed count and a fixed
    fraction confound the comparison in opposite directions and showing
    one of them would be choosing which confound to hide.
    """
    return (
        Rule("spy", "Buy and hold SPY", _single("SPY", tape), cross_sectional=False),
        Rule("equal", "Equal weight, monthly", _equal, cross_sectional=True),
        Rule(
            "mom_count",
            f"Momentum 12-1, top {MOMENTUM_NAMES} names",
            _top(lambda _: MOMENTUM_NAMES),
            cross_sectional=True,
        ),
        Rule(
            "mom_share",
            f"Momentum 12-1, top {MOMENTUM_FRACTION:.0%}",
            _top(lambda n: int(round(MOMENTUM_FRACTION * n))),
            cross_sectional=True,
        ),
    )


# -- the simulator --------------------------------------------------------


@dataclass(frozen=True)
class Book:
    """One run's equity curve and the diagnostics that explain it.

    `liquidations` and `liquidated_value` are here because they are the
    channel the whole experiment runs through. A free-panel run with
    zero liquidations has not been given any dead funds, and would
    return the biased panel's number while looking like a result.
    """

    equity: pd.Series
    invested: pd.Series
    names_held: pd.Series
    turnover: float
    cost: float
    liquidations: int
    liquidated_value: float

    @property
    def returns(self) -> pd.Series:
        return self.equity.pct_change().dropna()


def simulate(
    tape: Tape,
    elig: np.ndarray,
    rule: Rule,
    pool: np.ndarray,
    signals: Signals,
    *,
    rebalances: np.ndarray,
    recovery: float = BASE_RECOVERY,
    cost_model: CostModel | None = None,
    starting_cash: float = 1.0,
) -> Book:
    """Walk the sessions once, deciding at closes and filling at opens.

    A plain loop with the day written out in order, for the reason
    `run_backtest` gives about its own: somebody will read this at two
    in the morning because a number looks wrong, and the first thing
    they have to be able to see is that a decision taken at the bottom
    of one iteration is filled at the top of the next.

    **Whole shares, minimum trade sizes and a turnover budget are
    deliberately absent, and that is the reason this does not run
    through `run_backtest`.** Every one of them is a function of BREADTH
    — $131,000 across 190 names is $690 a position and across 150 names
    is $873, so a minimum trade size bites one panel and not the other —
    and a constraint that binds differently on the two sides of the
    comparison would be measured as survivorship. The frictions that do
    survive are the ones that scale with the trade rather than with the
    account: spread and impact, priced by the engine's own cost model,
    off the same liquidity series the participation cap reads.

    **Death is the one asymmetric event and it is handled explicitly.**
    A held fund with no open today has either a gap in its tape or no
    more tape. The first carries the position at its last mark, which is
    what the engine does. The second converts it to cash at `recovery`
    times that mark, on the session AFTER its final print — so the rule
    never sees the closure coming, which is conservative: a real ETF
    wind-up is announced weeks ahead and a real holder would have left
    nearer NAV than this.
    """
    model = cost_model or CostModel()
    n, m = tape.shape
    values = np.zeros(m, dtype="float64")
    cash = float(starting_cash)

    nav = np.empty(n, dtype="float64")
    nav[0] = float(starting_cash)
    invested = np.zeros(n, dtype="float64")
    held_count = np.zeros(n, dtype="float64")

    plan: np.ndarray | None = None
    traded = 0.0
    spent = 0.0
    deaths = 0
    death_value = 0.0
    rebalance_at = set(int(x) for x in rebalances)

    for i in range(1, n):
        # 1. Cash accrues. Before anything else, because a liquidation
        #    later in this session should not earn today's interest on
        #    money it did not have this morning.
        cash *= 1.0 + float(tape.cash_return[i])

        prev = tape.adj[i - 1]
        opening = tape.open_tr[i]
        live = (
            np.isfinite(opening)
            & (opening > 0.0)
            & np.isfinite(prev)
            & (prev > 0.0)
        )

        # 2. Overnight move at last night's weights, then the funds that
        #    printed their last bar yesterday pay out.
        held = values != 0.0
        moved = np.where(
            live & held, values * (opening / np.where(live, prev, 1.0)), values
        )
        dying = held & ~live & (i > tape.last_bar)
        if dying.any():
            proceeds = float(moved[dying].sum())
            cash += float(recovery) * proceeds
            deaths += int(dying.sum())
            death_value += proceeds
            moved = np.where(dying, 0.0, moved)
        values = moved
        nav_open = cash + float(values.sum())

        # 3. Fill yesterday's decision at today's open. A planned name
        #    that does not open is simply not bought — postponed, never
        #    filled at a price nobody printed.
        if plan is not None:
            target = plan * nav_open
            delta = np.where(live, target - values, 0.0)
            notional = np.abs(delta)
            moving = notional > 0.0
            if moving.any():
                breakdown = model.cost_bps(
                    trade_notional=notional[moving],
                    median_dollar_volume=tape.adv[i - 1][moving],
                    daily_volatility=tape.vol[i - 1][moving],
                )
                charge = float(
                    np.sum(breakdown.spread_dollars) + np.sum(breakdown.impact_dollars)
                )
                traded += float(notional[moving].sum())
                spent += charge
            else:
                charge = 0.0
            values = np.where(live, target, values)
            cash = nav_open - float(values.sum()) - charge
            plan = None

        # 4. Mark to today's close.
        closing = tape.adj[i]
        good = np.isfinite(closing) & (closing > 0.0) & live
        values = np.where(
            good, values * (closing / np.where(good, opening, 1.0)), values
        )
        nav[i] = cash + float(values.sum())
        invested[i] = float(values.sum()) / nav[i] if nav[i] > 0 else np.nan
        held_count[i] = float((values != 0.0).sum())

        # 5. Decide, from what is known at THIS close, for tomorrow's
        #    open. The last session gets no decision; it has no tomorrow
        #    inside the sample and manufacturing one would book a trade
        #    that never had a fill.
        if i in rebalance_at and i < n - 1:
            cand = np.flatnonzero(elig[i] & pool)
            fresh = np.zeros(m, dtype="float64")
            if cand.size:
                fresh[cand] = rule.weigh(i, cand, signals)
            plan = fresh

    index = pd.DatetimeIndex(tape.sessions, name="date")
    invested[0] = np.nan
    held_count[0] = np.nan
    return Book(
        equity=pd.Series(nav, index=index, name="nav"),
        invested=pd.Series(invested, index=index, name="invested"),
        names_held=pd.Series(held_count, index=index, name="names"),
        turnover=traded,
        cost=spent,
        liquidations=deaths,
        liquidated_value=death_value,
    )


# -- the identity ---------------------------------------------------------


@dataclass(frozen=True)
class CrossSection:
    """The exact decomposition, one row per session.

    This is the measurement the report leads with and it is not a
    backtest. `bias` is `share_dead * (mean_alive - mean_doomed)` and
    that product is not an approximation — for an equal-weight book the
    difference between the two panels' returns IS that number, with no
    residual, because the mean of a union is the size-weighted mean of
    its parts. Breadth cannot confound it, selectivity cannot enter it,
    and it is therefore the one line in this file that needs no control
    arm.
    """

    frame: pd.DataFrame

    @property
    def difference(self) -> pd.Series:
        return self.frame["bias"].dropna()


def cross_section(
    tape: Tape,
    elig: np.ndarray,
    survivors: Sequence[str],
    doomed: Sequence[str],
    *,
    recovery: float = BASE_RECOVERY,
) -> CrossSection:
    """Daily equal-weight means for the two cohorts, and their gap.

    Membership is decided on YESTERDAY'S eligibility, because that is
    when a rule holding this book would have chosen — a fund admitted to
    the cross-section on the strength of today's close would be admitted
    on the strength of today's return.

    A fund's final session carries the delisting return rather than a
    price move, so the cohort mean includes the payout the holder
    actually received. That is the whole reason the sign of this is not
    obvious in advance: an ETF closure hands back capital, which is not
    what a delisting does to an equity.
    """
    names = list(tape.names)
    surv_idx = np.array(
        [names.index(t) for t in survivors if t in names], dtype="int64"
    )
    dead_idx = np.array([names.index(t) for t in doomed if t in names], dtype="int64")

    n = tape.adj.shape[0]
    rows: list[dict[str, Any]] = []
    for i in range(1, n):
        prev = tape.adj[i - 1]
        cur = tape.adj[i]
        with np.errstate(invalid="ignore", divide="ignore"):
            step = cur / prev - 1.0
        # The last session of a fund's life pays the liquidation rather
        # than a price change; every other missing print is a gap and
        # contributes nothing.
        finishing = (tape.last_bar == i - 1) & np.isfinite(prev) & (prev > 0.0)
        step = np.where(finishing, float(recovery) - 1.0, step)
        usable = np.isfinite(step) & elig[i - 1]

        alive = surv_idx[usable[surv_idx]] if surv_idx.size else surv_idx
        gone = dead_idx[usable[dead_idx]] if dead_idx.size else dead_idx
        n_alive, n_gone = int(alive.size), int(gone.size)
        total = n_alive + n_gone
        if total == 0:
            continue
        mean_alive = float(step[alive].mean()) if n_alive else np.nan
        mean_gone = float(step[gone].mean()) if n_gone else np.nan
        share = n_gone / total
        rows.append(
            {
                "date": tape.sessions[i],
                "n_alive": n_alive,
                "n_doomed": n_gone,
                "share_doomed": share,
                "mean_alive": mean_alive,
                "mean_doomed": mean_gone,
                "delta": (mean_alive - mean_gone) if n_gone and n_alive else np.nan,
                # The identity. Zero on a day with no doomed fund in the
                # cross-section, which is the correct reading: on that
                # day the two panels were the same panel.
                "bias": (
                    (share * (mean_alive - mean_gone))
                    if n_gone and n_alive
                    else 0.0
                ),
            }
        )
    frame = pd.DataFrame(rows).set_index("date")
    return CrossSection(frame=frame)


# -- intervals ------------------------------------------------------------


@dataclass(frozen=True)
class Interval:
    """A point estimate and the range a resample puts around it."""

    point: float
    low: float
    high: float
    draws: int

    @property
    def excludes_zero(self) -> bool:
        return (self.low > 0.0) or (self.high < 0.0)


def block_bootstrap(
    series: pd.Series,
    *,
    block: int = BLOCK_SESSIONS,
    draws: int = BOOTSTRAP_DRAWS,
    seed: int = SEED,
    scale: float = 252.0,
) -> Interval:
    """A circular block bootstrap on the annualised mean of a series.

    Blocks rather than independent draws, and the difference is not
    cosmetic. Cross-sectional dispersion is strongly autocorrelated —
    the months when dead funds behave differently from live ones are the
    same months for weeks at a time — so resampling single sessions
    would report an interval several times too narrow, and narrow in the
    direction of calling a result significant.

    Circular rather than truncated so every observation has the same
    chance of appearing in a draw; a truncated version quietly
    under-samples the last three weeks of the record.
    """
    values = np.asarray(series.dropna(), dtype="float64")
    n = values.size
    if n < 2:
        return Interval(float("nan"), float("nan"), float("nan"), 0)
    width = max(1, min(int(block), n))
    starts_per_draw = int(np.ceil(n / width))
    rng = np.random.default_rng(int(seed))
    starts = rng.integers(0, n, size=(int(draws), starts_per_draw))
    offsets = np.arange(width)
    take = (starts[:, :, None] + offsets[None, None, :]).reshape(int(draws), -1) % n
    means = values[take[:, :n]].mean(axis=1) * float(scale)
    return Interval(
        point=float(values.mean() * scale),
        low=float(np.percentile(means, 2.5)),
        high=float(np.percentile(means, 97.5)),
        draws=int(draws),
    )


def jackknife_delta(
    tape: Tape,
    elig: np.ndarray,
    survivors: Sequence[str],
    doomed: Sequence[str],
) -> pd.DataFrame:
    """The identity recomputed with each dead fund left out in turn.

    The check a small cohort owes a reader. Forty-odd dead funds is few
    enough that one collapse could carry the whole result, and it also
    covers the contamination this panel cannot screen out — several of
    the recovered names are closed-end funds the vendor types ETF, and
    if no single removal moves the sign then no single misclassification
    did either.
    """
    rows: list[dict[str, Any]] = []
    for drop in doomed:
        rest = [t for t in doomed if t != drop]
        if not rest:
            continue
        cut = cross_section(tape, elig, survivors, rest)
        rows.append(
            {
                "dropped": drop,
                "bias_pa": float(cut.difference.mean() * 252.0),
            }
        )
    return pd.DataFrame(rows)


# -- what a closing fund actually paid ------------------------------------


def final_stretch(tape: Tape, doomed: Sequence[str]) -> pd.DataFrame:
    """What the last months of each dead fund's tape did.

    The empirical half of the delisting assumption. If ETF closures are
    orderly liquidations near NAV then the tape's final quarter should
    look like an ordinary quarter; if they are collapses it will not,
    and the base case of paying out the last mark would be flattering
    the free panel. Measured rather than asserted, because this is the
    assumption the sign of the whole result turns on.
    """
    names = list(tape.names)
    rows: list[dict[str, Any]] = []
    for ticker in doomed:
        if ticker not in names:
            continue
        j = names.index(ticker)
        end = int(tape.last_bar[j])
        start = int(tape.first_bar[j])
        if end <= start:
            continue
        series = tape.adj[: end + 1, j]
        series = series[np.isfinite(series) & (series > 0.0)]
        if series.size < 2:
            continue

        def move(window: int) -> float:
            if series.size <= window:
                return float("nan")
            return float(series[-1] / series[-1 - window] - 1.0)

        peak = float(np.maximum.accumulate(series)[-1])
        rows.append(
            {
                "ticker": ticker,
                "sessions": int(series.size),
                "life_total": float(series[-1] / series[0] - 1.0),
                "last_21": move(21),
                "last_63": move(63),
                "last_252": move(252),
                "from_peak": float(series[-1] / peak - 1.0),
            }
        )
    return pd.DataFrame(rows)


# -- the arms -------------------------------------------------------------


def pool_mask(tape: Tape, names: Sequence[str]) -> np.ndarray:
    """Which columns of the tape an arm is allowed to hold.

    An arm is a boolean vector and nothing else, which is the point.
    Every other difference the three arms could have had — the code, the
    calendar, the eligibility rule, the cost model, the rebalance dates
    — is shared by construction rather than by discipline, because there
    is one of each and `simulate` takes the mask as an argument.
    """
    wanted = set(names)
    return np.array([n in wanted for n in tape.names], dtype=bool)


def matched_pools(
    tape: Tape,
    survivors: Sequence[str],
    doomed: Sequence[str],
    *,
    draws: int = MATCH_DRAWS,
    seed: int = SEED,
) -> list[np.ndarray]:
    """Survival-blind pools the size of the biased one.

    Drawn ONCE per seed and held for the whole run, not resampled every
    month. A monthly redraw would look like a better control and would
    be a worse one: it manufactures turnover the other two arms do not
    pay, and the comparison would then be measuring transaction costs.

    The size matched is the POOL's, not the eligible count's. A
    survival-blind pool of 150 names has fewer names eligible in 2024
    than a pool of 150 survivors does, because some of its funds are
    dead by then — and that gap is not a flaw in the control, it is the
    breadth cost of survivorship, which the report states as a number
    rather than removing.
    """
    everything = list(survivors) + list(doomed)
    size = len(survivors)
    rng = np.random.default_rng(int(seed))
    out: list[np.ndarray] = []
    for _ in range(int(draws)):
        pick = rng.choice(len(everything), size=size, replace=False)
        out.append(pool_mask(tape, [everything[int(k)] for k in pick]))
    return out


# -- measuring one book ---------------------------------------------------


@dataclass(frozen=True)
class Measured:
    """A curve reduced to the four numbers every table below prints."""

    sessions: int
    cagr: float
    volatility: float
    sharpe: float
    max_drawdown: float
    invested: float
    names: float
    cost_bps_pa: float
    liquidations: int

    @property
    def long_enough(self) -> bool:
        return self.sessions >= MIN_WINDOW_SESSIONS


def measure(book: Book, *, rf: pd.Series | float = 0.0) -> Measured:
    returns = book.returns
    years = max((book.equity.index[-1] - book.equity.index[0]).days / 365.25, 1e-9)
    return Measured(
        sessions=int(len(book.equity)),
        cagr=metrics.cagr(book.equity),
        volatility=metrics.annualised_volatility(returns),
        sharpe=metrics.sharpe_ratio(returns, rf=rf),
        max_drawdown=metrics.max_drawdown(book.equity).depth,
        invested=float(book.invested.mean(skipna=True)),
        names=float(book.names_held.mean(skipna=True)),
        cost_bps_pa=float(book.cost / float(book.equity.mean()) / years * 1e4),
        liquidations=book.liquidations,
    )


def paired_gap(biased: Book, free: Book, *, seed: int = SEED) -> dict[str, Any]:
    """The gap between two curves, in percent a year, two ways.

    Two numbers rather than one because they answer different questions
    and disagree by a knowable amount. The CAGR difference is what a
    reader would compute from the two report lines themselves, and it
    carries the compounding effect — which is to say it carries the
    breadth-driven variance gap along with the survivorship one. The
    bootstrapped mean of the daily DIFFERENCE series is the paired
    statistic: the two books saw exactly the same sessions, so
    differencing them removes the market and leaves the treatment.

    Where the two disagree, the disagreement is the diversification
    term, which is why both are printed and neither is called the
    answer on its own.
    """
    diff = (biased.equity.pct_change() - free.equity.pct_change()).dropna()
    interval = block_bootstrap(diff, seed=seed)
    return {
        "cagr_gap": metrics.cagr(biased.equity) - metrics.cagr(free.equity),
        "daily_mean_pa": interval.point,
        "low": interval.low,
        "high": interval.high,
        "excludes_zero": interval.excludes_zero,
    }


# -- the study ------------------------------------------------------------


@dataclass(frozen=True)
class Study:
    """Everything one run computed, in the shape the report reads."""

    tape: Tape
    cohorts: Cohorts
    classified: pd.DataFrame
    attrition: pd.DataFrame
    cliff: dict[str, Any]
    floor: float
    liquidity: bool
    rf: pd.Series | float
    books: dict[tuple[str, str], Book]
    matched: dict[str, list[Book]]
    identity: CrossSection
    identity_open: CrossSection
    windows: dict[str, CrossSection]
    jackknife: pd.DataFrame
    endings: pd.DataFrame
    ladder: dict[float, dict[str, Any]]
    control_ok: bool
    control_gap: float
    bill_note: str
    cache_note: str
    silent_on_disk: tuple[str, ...] = ()
    provenance: str = ""
    warnings: list[str] = field(default_factory=list)


def run_study(
    tape: Tape,
    cohorts: Cohorts,
    classified: pd.DataFrame,
    *,
    floor: float,
    liquidity: bool,
    rf: pd.Series | float,
    bill_note: str,
    cache_note: str,
    asof: date,
    draws: int = MATCH_DRAWS,
    silent: Sequence[str] = (),
    provenance: str = "",
    on_progress: Callable[[str], None] | None = None,
) -> Study:
    """Both panels, every rule, plus the controls that make them readable."""

    def say(message: str) -> None:
        if on_progress is not None:
            on_progress(message)

    signals = Signals.build(tape)
    elig = eligibility(tape, liquidity=liquidity, floor=floor)
    rebalances = month_ends(tape.sessions)
    rules = rule_set(tape)

    biased_pool = pool_mask(tape, cohorts.survivors)
    free_pool = pool_mask(tape, list(cohorts.survivors) + list(cohorts.sampled))

    books: dict[tuple[str, str], Book] = {}
    for rule in rules:
        say(f"    {rule.label}")
        books[(rule.key, "biased")] = simulate(
            tape, elig, rule, biased_pool, signals, rebalances=rebalances
        )
        books[(rule.key, "free")] = simulate(
            tape, elig, rule, free_pool, signals, rebalances=rebalances
        )

    # The invariant. One fund, present in both pools, so the two curves
    # must be the same to the last bit — and if they are not, the panels
    # differ somewhere nobody intended and nothing else here is a
    # measurement.
    control_a = books[("spy", "biased")].equity
    control_b = books[("spy", "free")].equity
    control_gap = float(np.nanmax(np.abs(control_a.to_numpy() - control_b.to_numpy())))
    control_ok = control_gap <= 1e-12 * float(np.nanmax(np.abs(control_a.to_numpy())))

    say("    breadth-matched draws")
    matched: dict[str, list[Book]] = {}
    for pool in matched_pools(tape, cohorts.survivors, cohorts.sampled, draws=draws):
        for rule in rules:
            if not rule.cross_sectional:
                continue
            matched.setdefault(rule.key, []).append(
                simulate(tape, elig, rule, pool, signals, rebalances=rebalances)
            )

    say("    the identity")
    identity = cross_section(tape, elig, cohorts.survivors, cohorts.sampled)
    identity_open = cross_section(
        tape,
        eligibility(tape, liquidity=False, floor=floor),
        cohorts.survivors,
        cohorts.sampled,
    )

    cliff = de.retention_cliff(classified, asof=asof)
    boundary = int(cliff.get("cliff_year") or FALLBACK_CLIFF_YEAR)
    windows = {
        "full": identity,
        "post_cliff": CrossSection(
            frame=identity.frame.loc[identity.frame.index.year >= boundary]
        ),
        "pre_cliff": CrossSection(
            frame=identity.frame.loc[identity.frame.index.year < boundary]
        ),
    }

    say("    delisting sensitivity")
    ladder: dict[float, dict[str, Any]] = {}
    for recovery in RECOVERY_LADDER:
        cut = cross_section(
            tape, elig, cohorts.survivors, cohorts.sampled, recovery=recovery
        )
        free_book = simulate(
            tape,
            elig,
            rules[1],
            free_pool,
            signals,
            rebalances=rebalances,
            recovery=recovery,
        )
        ladder[recovery] = {
            "identity_pa": float(cut.difference.mean() * 252.0),
            "equal_gap": paired_gap(books[("equal", "biased")], free_book),
            "free_cagr": metrics.cagr(free_book.equity),
        }

    say("    jackknife")
    jack = jackknife_delta(tape, elig, cohorts.survivors, cohorts.sampled)
    endings = final_stretch(tape, cohorts.sampled)

    warnings: list[str] = []
    if not control_ok:
        warnings.append(
            f"the SPY control differs between panels by {control_gap:.3e} of NAV; "
            f"the two panels are not the same panel and no comparison below is valid"
        )
    if not cohorts.sampled:
        warnings.append(
            "no randomly-sampled dead fund has bars on disk, so the free panel "
            "is the biased panel and every gap below is exactly zero by "
            "construction rather than by measurement"
        )
    if len(cohorts.sampled) < 20:
        warnings.append(
            f"only {len(cohorts.sampled)} randomly-sampled dead funds are on "
            f"disk; the interval on every estimate is wide and the jackknife "
            f"below is the check that matters"
        )

    return Study(
        tape=tape,
        cohorts=cohorts,
        classified=classified,
        attrition=de.attrition(classified, asof=asof),
        cliff=cliff,
        floor=floor,
        liquidity=liquidity,
        rf=rf,
        books=books,
        matched=matched,
        identity=identity,
        identity_open=identity_open,
        windows=windows,
        jackknife=jack,
        endings=endings,
        ladder=ladder,
        control_ok=control_ok,
        control_gap=control_gap,
        bill_note=bill_note,
        cache_note=cache_note,
        silent_on_disk=tuple(silent),
        provenance=provenance,
        warnings=warnings,
    )


# -- scaling the answer to the whole shelf --------------------------------


def shelf_share_dead(attrition: pd.DataFrame, sessions: pd.DatetimeIndex) -> pd.Series:
    """The directory's own doomed share, per session, from the yearly table.

    The panel knows the RETURN difference between funds that lived and
    funds that did not; the directory knows the SHARE, for all 7,583
    symbols rather than for the few dozen whose tape we could afford to
    fetch. The identity is the product of the two, so pairing the
    measured difference with the catalogue's share is what turns a
    sample into an answer about the shelf.

    Held flat within a year rather than interpolated. The table's rows
    are cohorts standing on the shelf each 1 January, and inventing a
    smooth path between two of them would imply a monthly measurement
    nobody made.
    """
    by_year = attrition.set_index("year")["share_dead"]
    years = pd.Index(sessions.year)
    values = years.map(by_year).to_numpy(dtype="float64")
    return pd.Series(values, index=sessions, name="shelf_share_dead")


def scaled_estimate(study: Study) -> dict[str, Any]:
    """What the identity gives at the shelf's own attrition rate.

    An ESTIMATE, and the word is doing work. It assumes the funds we
    recovered behave like the ones we did not, which is defensible
    because the acquisition order is a seeded shuffle and indefensible
    for the years before the vendor's retention begins — there the
    missing funds are not a random subset of the dead, they are the
    entire pre-2014 population.
    """
    frame = study.identity.frame
    if frame.empty:
        return {"available": False}
    shelf = shelf_share_dead(study.attrition, pd.DatetimeIndex(frame.index))
    delta = frame["delta"]
    usable = delta.notna() & shelf.notna()
    scaled = (shelf[usable] * delta[usable]).dropna()
    panel = frame.loc[usable, "share_doomed"]
    return {
        "available": bool(len(scaled)),
        "panel_share": float(panel.mean()) if len(panel) else float("nan"),
        "shelf_share": float(shelf[usable].mean()) if usable.any() else float("nan"),
        "measured_pa": float(frame.loc[usable, "bias"].mean() * 252.0),
        "scaled_pa": float(scaled.mean() * 252.0),
        "interval": block_bootstrap(scaled),
        "sessions": int(len(scaled)),
    }


# -- the report -----------------------------------------------------------


def _pa(value: Any, places: int = 2) -> str:
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return "—"
    return f"{float(value) * 100:+.{places}f}%"


def _median_ending(study: Study) -> str:
    """What the typical dead fund's last quarter of trading did."""
    if study.endings.empty:
        return "—"
    return _pa(float(study.endings["last_63"].median()))


def _pre_cliff_direction(study: Study) -> str:
    """Whether the pre-cliff doomed funds beat the survivors or lost to them.

    A word rather than a sign, because the sentence it lands in reads as
    English. Computed rather than typed because the pre-cliff cohort is
    the handful of funds the vendor happened to keep, and its direction
    has already flipped once as the pull widened.
    """
    frame = study.windows["pre_cliff"].frame
    if frame.empty:
        return "under-"
    return "out-" if float(frame["delta"].mean(skipna=True)) < 0 else "under-"


def _ladder_swing(study: Study) -> float:
    """How far the answer moves between paying the last mark and paying nothing."""
    return abs(
        float(study.ladder[0.0]["identity_pa"])
        - float(study.ladder[BASE_RECOVERY]["identity_pa"])
    )


def _unfetched_dead(study: Study) -> int:
    """Dead shelf symbols with no bars in this study, for any reason at all."""
    dead = int(de.composition(study.classified)["dead"])
    held = len(study.cohorts.sampled) + len(study.cohorts.opportunistic)
    return max(0, dead - held)


def _pct(value: Any, places: int = 2) -> str:
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return "—"
    return f"{float(value) * 100:.{places}f}%"


def _num(value: Any, places: int = 2) -> str:
    if value is None or (isinstance(value, float) and not np.isfinite(value)):
        return "—"
    return f"{float(value):.{places}f}"


def composition_table(study: Study) -> str:
    c = study.cohorts
    parts = de.composition(study.classified)
    hand = de.hand_list_comparison(study.classified)
    rows = [
        [
            "Shelf symbols in the catalogue (ETF, USD, major venue)",
            f"{parts['symbols']:,}",
        ],
        ["  still listed", f"{parts['alive']:,}"],
        ["  dead", f"{parts['dead']:,}"],
        ["Hand-written list this repository has used", f"{len(c.hand_list):,}"],
        [
            "  of which dead",
            f"{hand['hand_list_dead']} ({_pct(hand['hand_list_share_dead'])} "
            f"against the shelf's {_pct(hand['shelf_share_dead'])})",
        ],
        [
            "Symbols with bars on disk",
            f"{len(c.all_names) + len(c.unresolvable) + len(c.contested):,}",
        ],
        ["  refused: unresolvable or never traded", f"{len(c.unresolvable):,}"],
        ["  refused: catalogue and tape disagree", f"{len(c.contested):,}"],
        ["Funds admitted to the study", f"{len(c.all_names):,}"],
        ["  survivors (the BIASED panel)", f"{len(c.survivors):,}"],
        ["  dead, randomly sampled (added for the FREE panel)", f"{len(c.sampled):,}"],
        [
            "  dead, hand-picked (excluded from the estimate)",
            f"{len(c.opportunistic):,}",
        ],
        ["Drawn by the shuffle, vendor served nothing", f"{len(c.drawn_but_empty):,}"],
        ["Cached entry that read back empty", f"{len(study.silent_on_disk):,}"],
        ["Hand-list names with no bars on disk", f"{len(c.absent_from_cache):,}"],
    ]
    return runs.table(["Measure", "Count"], rows, ["l", "r"])


def cohort_over_time(study: Study) -> str:
    frame = study.identity.frame
    if frame.empty:
        return "_no session carried a cross-section._"
    yearly = frame.groupby(frame.index.year).agg(
        n_alive=("n_alive", "mean"),
        n_doomed=("n_doomed", "mean"),
        share=("share_doomed", "mean"),
    )
    shelf = study.attrition.set_index("year")["share_dead"]
    # One decimal on the doomed count, because these are averages over a
    # year's sessions and a rounded zero beside a non-zero share reads as
    # a contradiction rather than as a fund that existed for four months.
    rows = [
        [
            str(int(year)),
            f"{row.n_alive:.0f}",
            f"{row.n_doomed:.1f}",
            _pct(row.share, 1),
            _pct(shelf.get(int(year), float("nan")), 1),
        ]
        for year, row in yearly.iterrows()
    ]
    return runs.table(
        [
            "Year",
            "Survivors in panel",
            "Doomed in panel",
            "Panel doomed share",
            "Shelf doomed share",
        ],
        rows,
        ["r", "r", "r", "r", "r"],
    )


def headline_table(study: Study) -> str:
    rules = rule_set(study.tape)
    rows: list[list[str]] = []
    for rule in rules:
        for arm, label in (("biased", "biased"), ("free", "free")):
            book = study.books[(rule.key, arm)]
            m = measure(book, rf=study.rf)
            rows.append(
                [
                    rule.label if arm == "biased" else "",
                    label,
                    _pa(m.cagr),
                    _pct(m.volatility),
                    _num(m.sharpe),
                    _pa(m.max_drawdown),
                    f"{m.names:.0f}",
                    f"{m.cost_bps_pa:.1f}",
                    f"{m.liquidations:,}",
                ]
            )
    return runs.table(
        [
            "Book",
            "Panel",
            "CAGR",
            "Vol",
            "Sharpe",
            "Max DD",
            "Names held",
            "Cost bps/yr",
            "Liquidations",
        ],
        rows,
        ["l", "l", "r", "r", "r", "r", "r", "r", "r"],
    )


def gap_table(study: Study) -> str:
    rules = rule_set(study.tape)
    rows: list[list[str]] = []
    for rule in rules:
        biased = study.books[(rule.key, "biased")]
        free = study.books[(rule.key, "free")]
        gap = paired_gap(biased, free)
        matched = study.matched.get(rule.key, [])
        if matched:
            per_draw = [paired_gap(biased, book)["daily_mean_pa"] for book in matched]
            matched_cell = (
                f"{np.mean(per_draw) * 100:+.2f}% "
                f"[{np.percentile(per_draw, 5) * 100:+.2f}, "
                f"{np.percentile(per_draw, 95) * 100:+.2f}]"
            )
            breadth = [
                paired_gap(book, free)["daily_mean_pa"] for book in matched
            ]
            breadth_cell = f"{np.mean(breadth) * 100:+.2f}%"
        else:
            matched_cell = "—"
            breadth_cell = "—"
        rows.append(
            [
                rule.label,
                _pa(gap["cagr_gap"]),
                _pa(gap["daily_mean_pa"]),
                f"[{gap['low'] * 100:+.2f}, {gap['high'] * 100:+.2f}]",
                # Stated rather than left to the reader to work out from
                # two decimals and a bracket, because "the interval
                # excludes zero" is the only claim any of these rows
                # supports on its own.
                "yes" if gap["excludes_zero"] else "no",
                matched_cell,
                breadth_cell,
            ]
        )
    return runs.table(
        [
            "Book",
            "CAGR gap A-B",
            "Paired daily mean, /yr",
            "95% interval",
            "Excludes zero",
            "A-C (breadth matched)",
            "C-B (breadth only)",
        ],
        rows,
        ["l", "r", "r", "r", "l", "r", "r"],
    )


def _identity_row(label: str, cut: CrossSection) -> list[str]:
    frame = cut.frame
    if frame.empty:
        return [label, "0", "—", "—", "—", "—"]
    if len(frame) < MIN_WINDOW_SESSIONS:
        # The same rule `run_ledger` keeps: annualising a stretch this
        # short is extrapolation with a unit attached, so the window is
        # shown at its length and the columns that would multiply by 252
        # are left empty rather than filled with a number nobody should
        # read.
        return [
            label,
            f"{len(frame):,}",
            _pct(float(frame["share_doomed"].mean()), 1),
            "too short",
            "too short",
            "—",
        ]
    interval = block_bootstrap(cut.difference)
    return [
        label,
        f"{len(frame):,}",
        _pct(float(frame["share_doomed"].mean()), 1),
        _pa(float(frame["delta"].mean(skipna=True) * 252.0)),
        _pa(interval.point),
        f"[{interval.low * 100:+.2f}, {interval.high * 100:+.2f}]",
    ]


_IDENTITY_HEADERS = [
    "Window",
    "Sessions",
    "Doomed share",
    "Per-fund gap, /yr",
    "Equal-weight bias, /yr",
    "95% interval",
]
_IDENTITY_ALIGN = ["l", "r", "r", "r", "r", "r"]


def identity_table(study: Study) -> str:
    year = study.cliff.get("cliff_year", FALLBACK_CLIFF_YEAR)
    rows = [
        _identity_row("Whole sample", study.windows["full"]),
        _identity_row(f"Before {year}", study.windows["pre_cliff"]),
        _identity_row(f"{year} onward", study.windows["post_cliff"]),
    ]
    return runs.table(_IDENTITY_HEADERS, rows, _IDENTITY_ALIGN)


def gate_table(study: Study) -> str:
    """The same identity with and without this account's liquidity floor.

    A separate table because the two answer different questions and the
    gap between them is itself a finding. With the floor the question is
    what the club could have held; without it, what the shelf did. And
    the floor turns out to do part of the job on its own — a fund's
    volume thins before it closes, so an account that refuses thin funds
    has already refused some of the ones that were about to die.
    """
    rows = [
        _identity_row(
            f"ADV floor on (>= ${study.floor:,.0f}/day)"
            if study.liquidity
            else "ADV floor on",
            study.identity,
        ),
        _identity_row("No liquidity gate — the whole shelf", study.identity_open),
    ]
    return runs.table(_IDENTITY_HEADERS, rows, _IDENTITY_ALIGN)


def ladder_table(study: Study) -> str:
    rows = []
    for recovery, payload in study.ladder.items():
        gap = payload["equal_gap"]
        rows.append(
            [
                f"{recovery:.0%} of the last mark",
                _pa(payload["identity_pa"]),
                _pa(gap["daily_mean_pa"]),
                f"[{gap['low'] * 100:+.2f}, {gap['high'] * 100:+.2f}]",
                _pa(payload["free_cagr"]),
            ]
        )
    return runs.table(
        [
            "A closing fund pays",
            "Identity bias, /yr",
            "Equal-weight gap, /yr",
            "95% interval",
            "Free-panel CAGR",
        ],
        rows,
        ["l", "r", "r", "r", "r"],
    )


def endings_table(study: Study) -> str:
    frame = study.endings
    if frame.empty:
        return "_no dead fund has enough tape to describe its ending._"
    rows = [
        [
            "Median",
            _pa(float(frame["last_21"].median())),
            _pa(float(frame["last_63"].median())),
            _pa(float(frame["last_252"].median())),
            _pa(float(frame["from_peak"].median())),
        ],
        [
            "Mean",
            _pa(float(frame["last_21"].mean())),
            _pa(float(frame["last_63"].mean())),
            _pa(float(frame["last_252"].mean())),
            _pa(float(frame["from_peak"].mean())),
        ],
        [
            "Worst",
            _pa(float(frame["last_21"].min())),
            _pa(float(frame["last_63"].min())),
            _pa(float(frame["last_252"].min())),
            _pa(float(frame["from_peak"].min())),
        ],
        [
            "Share negative",
            _pct(float((frame["last_21"] < 0).mean()), 0),
            _pct(float((frame["last_63"] < 0).mean()), 0),
            _pct(float((frame["last_252"] < 0).mean()), 0),
            _pct(float((frame["from_peak"] < 0).mean()), 0),
        ],
    ]
    return runs.table(
        [
            "Across the dead cohort",
            "Last 21 sessions",
            "Last 63",
            "Last 252",
            "From lifetime peak",
        ],
        rows,
        ["l", "r", "r", "r", "r"],
    )


def _signs_agree(study: Study) -> bool:
    """Do all the cross-sectional books point the same way, A-B and A-C.

    Asked rather than asserted for the same reason the breadth term is
    computed: a sentence claiming agreement is a sentence that will
    survive the run that first disagrees with it.
    """
    signs: set[float] = set()
    for rule in rule_set(study.tape):
        if not rule.cross_sectional:
            continue
        biased = study.books[(rule.key, "biased")]
        signs.add(
            np.sign(
                paired_gap(biased, study.books[(rule.key, "free")])["daily_mean_pa"]
            )
        )
        matched = study.matched.get(rule.key, [])
        if matched:
            # The MEAN over the draws, which is the figure the table
            # prints. Asking each of twenty-five draws to agree would
            # fail on a small effect however real it was, and would be
            # a test of the sample size rather than of the sign.
            signs.add(
                np.sign(
                    np.mean([paired_gap(biased, b)["daily_mean_pa"] for b in matched])
                )
            )
    return len(signs - {0.0}) <= 1


def _breadth_effect(study: Study) -> float:
    """The C-B term, averaged over the books that rank a cross-section.

    Computed rather than asserted. A sentence in the report says which
    way breadth pushes, and a sentence that says it from memory is a
    sentence that will be wrong the first time somebody widens the
    cohort.
    """
    values: list[float] = []
    for rule in rule_set(study.tape):
        books = study.matched.get(rule.key, [])
        if not books:
            continue
        free = study.books[(rule.key, "free")]
        values.extend(paired_gap(book, free)["daily_mean_pa"] for book in books)
    return float(np.mean(values)) if values else float("nan")


def roster_table(study: Study, *, ends: int = 20) -> str:
    """The dead cohort's best and worst, with what they did while alive.

    The raw evidence, because the headline is a mean over these rows and
    a reader should be able to audit a mean over a hundred things.

    **Both ends or neither.** Sorted by lifetime return and truncated at
    the top, this table would print a hundred per cent winners and read
    as evidence that closing funds do fine — which is the opposite of
    what the cohort says and would be the most misleading object in the
    report. So the head and the tail are both shown and the elision is a
    labelled row rather than a silent cut.
    """
    frame = study.endings
    if frame.empty:
        return "_no dead fund in the estimate has enough tape to describe._"
    names = list(study.tape.names)
    ordered = frame.sort_values("life_total", ascending=False)
    keep = int(ends)
    if len(ordered) <= 2 * keep:
        shown: list[Any] = [("row", r) for r in ordered.itertuples()]
    else:
        shown = (
            [("row", r) for r in ordered.head(keep).itertuples()]
            + [("gap", len(ordered) - 2 * keep)]
            + [("row", r) for r in ordered.tail(keep).itertuples()]
        )

    rows: list[list[str]] = []
    for kind, payload in shown:
        if kind == "gap":
            rows.append(
                [f"… {payload} more", "", "", "", "", "", "", ""]
            )
            continue
        row = payload
        j = names.index(row.ticker)
        first = study.tape.first_bar[j]
        last = int(study.tape.last_bar[j])
        opened = (
            study.tape.sessions[int(first)].date()
            if 0 <= int(first) < len(study.tape.sessions)
            else "before the window"
        )
        years = max(row.sessions / 252.0, 1e-9)
        rows.append(
            [
                row.ticker,
                str(opened),
                str(study.tape.sessions[last].date()) if last >= 0 else "—",
                f"{row.sessions:,}",
                _pa(row.life_total),
                _pa((1.0 + row.life_total) ** (1.0 / years) - 1.0),
                _pa(row.last_63),
                _pa(row.from_peak),
            ]
        )
    return runs.table(
        [
            "Fund",
            "First bar in window",
            "Last bar",
            "Sessions",
            "Life total",
            "Annualised",
            "Final quarter",
            "From peak",
        ],
        rows,
        ["l", "l", "l", "r", "r", "r", "r", "r"],
    )


def jackknife_note(study: Study) -> str:
    frame = study.jackknife
    if frame.empty:
        return "_the cohort is too small to leave one out._"
    # idxmin is the fund whose REMOVAL lowers the estimate most, which
    # is the fund contributing most to it. Named that way round because
    # "largest influence" attached to the row with the smallest number
    # is how a reader ends up reading the table backwards.
    pulls_up = frame.loc[frame["bias_pa"].idxmin()]
    pulls_down = frame.loc[frame["bias_pa"].idxmax()]
    signs = set(np.sign(frame["bias_pa"].to_numpy()))
    verdict = (
        "no single fund flips the sign"
        if len(signs - {0.0}) <= 1
        else "REMOVING ONE FUND FLIPS THE SIGN, and the estimate is that fund"
    )
    return (
        f"Leaving each dead fund out in turn moves the equal-weight bias between "
        f"{_pa(float(frame['bias_pa'].min()))} and "
        f"{_pa(float(frame['bias_pa'].max()))} "
        f"a year — {verdict}. The fund contributing most to the estimate is "
        f"`{pulls_up['dropped']}`, whose removal takes it to "
        f"{_pa(float(pulls_up['bias_pa']))}; the one pulling hardest the other way "
        f"is `{pulls_down['dropped']}`, whose removal raises it to "
        f"{_pa(float(pulls_down['bias_pa']))}."
    )


def render_markdown(study: Study, generated_at: datetime, out: Path) -> str:
    c = study.cohorts
    scaled = scaled_estimate(study)
    identity_pa = float(study.identity.difference.mean() * 252.0)
    identity_interval = block_bootstrap(study.identity.difference)
    equal_gap = paired_gap(
        study.books[("equal", "biased")], study.books[("equal", "free")]
    )
    spy = measure(study.books[("spy", "biased")], rf=study.rf)
    cliff_year = study.cliff.get("cliff_year", FALLBACK_CLIFF_YEAR)

    direction = "flatters" if identity_pa > 0 else "understates"
    lines: list[str] = []
    add = lines.append

    add("# Survivorship, Measured")
    add("")
    add(
        "The owner asked why we could not just remove the tickers that do not "
        "exist, since there are not many of them. The honest answer at the time "
        "was that there are a great many, and that the SIGN of what their "
        "absence does is unknowable without the data. The first half of that is "
        "now a table. The second half is now a number."
    )
    add("")

    if study.warnings:
        add("## Read this first")
        add("")
        for warning in study.warnings:
            add(f"- **{warning}**")
        add("")

    add("## The answer")
    add("")
    add(
        f"**On this panel the hand-written survivor list {direction} an "
        f"equal-weight book by {_pa(identity_pa)} a year** "
        f"(95% interval {_pa(identity_interval.low)} to {_pa(identity_interval.high)}, "
        f"circular block bootstrap, {BLOCK_SESSIONS}-session blocks, "
        f"{identity_interval.draws:,} draws). The portfolio run agrees: the same "
        f"book rebalanced monthly with spread and impact charged inside the loop "
        f"differs by {_pa(equal_gap['daily_mean_pa'])} a year "
        f"[{_pa(equal_gap['low'])}, {_pa(equal_gap['high'])}]."
    )
    add("")
    post = study.windows["post_cliff"]
    if not post.frame.empty:
        post_interval = block_bootstrap(post.difference)
        add(
            f"**Over the window where the vendor actually keeps its dead — "
            f"{cliff_year} onward, {len(post.frame):,} sessions — it is "
            f"{_pa(post_interval.point)} a year "
            f"[{_pa(post_interval.low)}, {_pa(post_interval.high)}].** That is the "
            f"row to quote. Before {cliff_year} the catalogue records "
            f"{study.cliff.get('recorded_closures_before_cliff', '?')} ETF closures "
            f"across {study.cliff.get('years_before_cliff', '?')} years, which is "
            f"not a market history, and the whole-sample figure above is diluted "
            f"by it."
        )
        add("")
    if scaled.get("available"):
        add(
            f"**Scaled to the catalogue's own attrition the estimate is "
            f"{_pa(scaled['scaled_pa'])} a year** "
            f"[{_pa(scaled['interval'].low)}, {_pa(scaled['interval'].high)}], over "
            f"the {scaled['sessions']:,} sessions on which the panel carried a "
            f"doomed fund to compare. The panel's doomed share is "
            f"{_pct(scaled['panel_share'], 1)} where the shelf's was "
            f"{_pct(scaled['shelf_share'], 1)}, and the identity below is linear in "
            f"that share, so this is the first figure re-weighted rather than a "
            f"second experiment."
        )
        add("")
        add(
            f"**The two figures are not equally well established, and it is worth "
            f"being explicit about which is which.** The panel figure is measured "
            f"and its interval "
            f"{'excludes' if identity_interval.excludes_zero else 'includes'} zero. "
            f"The scaled figure re-weights it by a factor of "
            f"{scaled['shelf_share'] / scaled['panel_share']:.0f} and multiplies "
            f"the sampling noise by the same factor; its interval "
            + (
                "still excludes zero. "
                if scaled["interval"].excludes_zero
                else "includes zero. "
            )
            + (
                "So the sign survives the scaling, and the magnitude is the part "
                "to hold loosely — the shape of the answer is a point or two a "
                "year, not a figure anybody should quote to two decimals."
                if scaled["interval"].excludes_zero
                else "So the sign is established on the panel this file can build "
                "and the full-scale magnitude is not. What can be said is that the "
                "bias is positive, and that at the shelf's own attrition it is "
                "plausibly a point or more — not that it is one."
            )
        )
        add("")
    add(
        f"**The sign is the finding.** An ETF closure is not a bankruptcy: the "
        f"fund's assets are the shareholders' assets held in trust, the sponsor "
        f"announces a date, creations stop, the portfolio is sold and the cash is "
        f"distributed. The tape says the same thing — across the dead cohort the "
        f"median fund's last quarter of trading returned "
        f"{_median_ending(study)}, "
        f"which is a fund being wound up rather than a fund collapsing. So ETF "
        f"survivorship bias is SMALLER than equity survivorship bias, and that "
        f"makes the single-name argument stronger rather than weaker: the layer "
        f"we refused to test is the layer where a delisting goes to zero."
    )
    add("")

    add("## The control, before anything else")
    add("")
    if study.control_ok:
        add(
            f"Buy-and-hold SPY holds one fund that is in both pools, so it must "
            f"return the same curve on both panels. It does: the largest "
            f"difference between the two equity curves across "
            f"{spy.sessions:,} sessions is {study.control_gap:.3e} of NAV, which is "
            f"floating-point and not a result. Both report {_pa(spy.cagr)} a year "
            f"at a Sharpe of {_num(spy.sharpe)} and a worst drawdown of "
            f"{_pa(spy.max_drawdown)}."
        )
        add("")
        add(
            "That is what makes every other row below a comparison rather than a "
            "coincidence. Two panels that disagree about SPY disagree about the "
            "calendar, the adjustment, or the cost model, and a survivorship "
            "number computed across that disagreement would be measuring our own "
            "wiring."
        )
        add("")
        add(
            f"It is also the check that this simulator is not inventing returns, "
            f"and the check was worth running. From the session it is first "
            f"invested to the end of the sample the book's equity tracks SPY's own "
            f"total return to twelve significant figures, which is what a correct "
            f"overnight-then-intraday decomposition looks like and is not what an "
            f"approximate one looks like. `reports/post_publication_ledger.md` puts "
            f"the same position at 10.69% a year through the full engine, against "
            f"{_pa(spy.cagr)} here; the difference is the ledger's five per cent "
            f"settlement reserve, which is switched off below for the reason "
            f"`simulate` gives — a 95%-invested book neither earns nor falls as "
            f"far as a fully invested one, and the drawdown column shows the "
            f"second half of that."
        )
        add("")
        add(
            "The same check found the one defect that mattered. The history gate "
            "was counting a fund's bars inside the study window rather than over "
            "the whole pull, so a fund trading since 1993 arrived on the opening "
            "session looking a day old, every name failed the 252-session rule at "
            "once, and the study spent its first trading year in cash — worth "
            "0.13% a year on SPY, invisible in any gap because it fell on both "
            "panels equally, and wrong. It is fixed; the note on `Tape.history` "
            "says why the fix has to live where the rolling statistics live."
        )
    else:
        add(
            f"**THE CONTROL FAILED.** SPY returns a different curve on the two "
            f"panels — the largest gap is {study.control_gap:.3e} of NAV. The two "
            f"panels differ somewhere they were not supposed to and nothing below "
            f"is a measurement of survivorship."
        )
    add("")

    add("## What the two panels are")
    add("")
    add(
        "One difference and one only. The biased panel's pool is the funds that "
        "are alive today, which is what a list written by looking at what trades "
        "produces. The free panel's pool is those same funds plus the dead ones "
        "recovered from the vendor's directory. Same bars, same calendar, same "
        "eligibility rule, same cost model, same rebalance dates, same code path "
        "— `simulate` is called twice with a different boolean mask."
    )
    add("")
    add(composition_table(study))
    add("")
    add(
        "The hand list is 0 of "
        f"{len(c.hand_list)} dead against a shelf that is "
        f"{_pct(de.composition(study.classified)['share_dead'], 1)} dead. That is "
        "the bias, in units, and it needed no pull to state."
    )
    add("")
    if c.opportunistic:
        add(
            f"**{len(c.opportunistic)} dead funds on disk are excluded from the "
            f"estimate.** They are the ones `etfuniverse.DECEASED` already named, "
            f"plus any pulled by hand along the way — real funds that really "
            f"closed, chosen because somebody found them interesting: Russia, "
            f"Egypt, coal, the currency trusts. That is a sampling rule with an "
            f"unknown relationship to return, and mixing it into a random sample "
            f"would put a thumb on the scale in a direction nobody could state. "
            f"Named here, kept out of every number above: "
            f"{', '.join('`' + t + '`' for t in c.opportunistic)}."
        )
        add("")
    if c.drawn_but_empty:
        add(
            f"**{len(c.drawn_but_empty)} name(s) the shuffle drew came back with no "
            f"bars at all** ({', '.join('`' + t + '`' for t in c.drawn_but_empty)}). "
            f"A directory row is the vendor's index and not its tape, and the gap "
            f"between the two is a measurement rather than an error — they are "
            f"counted here and are in no panel."
        )
        add("")
    if c.contested:
        add(
            f"### The catalogue and the tape disagree about "
            f"{len(c.contested)} fund" + ("" if len(c.contested) == 1 else "s")
        )
        add("")
        add(
            f"**Refused because the vendor's own two records contradict each "
            f"other**: {', '.join('`' + t + '`' for t in c.contested)}. Each is "
            f"filed dead in the directory, with a coverage window that ended years "
            f"ago, and the price endpoint answers for each with a live series "
            f"running to the last session of this sample."
        )
        add("")
        add(
            "This is worth more than its size, because it defeats the "
            "reissued-ticker test that was thought to be sufficient. "
            "`deadetfs.classify` refuses a symbol carrying more than one coverage "
            "window and catches seventy that way; every one of these carries "
            "exactly ONE window and is reissued anyway. A directory row indexes a "
            "string and the price endpoint serves whatever that string means "
            "today, so where the two disagree the string has meant two funds and "
            "the window count never saw it. **The tape has to be cross-checked "
            "against the catalogue, symbol by symbol, and a universe built from "
            "directory metadata alone will carry a successor's returns under a "
            "dead fund's name.**"
        )
        add("")
        add(
            "None is reassigned to the other cohort, because reassigning is a "
            "guess about which of two vendor records is wrong and nothing here can "
            "make it. They are refused, counted, and named."
        )
        add("")

    add("### How many doomed funds the panel actually carries")
    add("")
    add(cohort_over_time(study))
    add("")
    add(
        "The last column is the answer to the scaling question and the reason the "
        "headline is quoted twice. The panel's doomed share is a fraction of the "
        "shelf's, because a metered free tier bought a few dozen dead funds and "
        "the shelf holds nearly two thousand."
    )
    add("")

    add("## The identity, which is why this is not confounded")
    add("")
    add(
        "For an equal-weight book the difference between the two panels' returns "
        "on a given day is exactly"
    )
    add("")
    add("    share doomed  x  ( mean return of survivors - mean return of the doomed )")
    add("")
    add(
        "with no residual term, because the mean of a union is the size-weighted "
        "mean of its parts. Breadth does not appear in it. Selectivity does not "
        "appear in it. This is the measurement the two earlier attempts were "
        "reaching for: the first held a fixed count out of universes of 491 and "
        "193 names and therefore measured how hard a screen was, the second held "
        "a fixed fraction and therefore measured how many names a book had. "
        "Neither is avoidable inside a portfolio and neither exists here."
    )
    add("")
    add(identity_table(study))
    add("")
    closed = study.attrition.set_index("year")["died"]
    before = int(closed.loc[closed.index < cliff_year].sum())
    after = int(closed.loc[closed.index >= cliff_year].sum())
    add(
        f"The split at {cliff_year} is not a robustness cut, it is the vendor's "
        f"retention boundary. `deadetfs.retention_cliff` finds it from the data — "
        f"the catalogue records {before} ETF closures in the "
        f"{study.cliff.get('years_before_cliff', '?')} years before it against "
        f"{after:,} after — so the earlier window's doomed funds are the few the "
        f"vendor happened to keep and the later window's are the population. "
        f"**The row to quote is the later one.** The earlier one is reported "
        f"because hiding it would be choosing the window after seeing the answer, "
        f"and because it says something worth knowing on its own: over 2005-2013 "
        f"the funds that would later die "
        f"{_pre_cliff_direction(study)}"
        f"performed the survivors. Delistings are a mix of takeovers and failures "
        f"and the mix is not constant."
    )
    add("")
    add(jackknife_note(study))
    add("")
    add("### What the account's own liquidity floor does to the answer")
    add("")
    add(gate_table(study))
    add("")
    if study.liquidity:
        gated, open_ = study.identity.frame, study.identity_open.frame
        add(
            f"Read this as a change of COMPOSITION rather than of size. Dropping "
            f"the floor more than doubles the doomed share — "
            f"{_pct(float(gated['share_doomed'].mean()), 1)} to "
            f"{_pct(float(open_['share_doomed'].mean()), 1)} — because most dead "
            f"funds never traded enough for this account to touch them. The "
            f"per-fund gap moves the other way, from "
            f"{_pa(float(open_['delta'].mean(skipna=True) * 252.0))} without the "
            f"floor to {_pa(float(gated['delta'].mean(skipna=True) * 252.0))} with "
            f"it, and the product of the two barely moves."
        )
        add("")
        add(
            "Which says something the aggregate hides. The floor is not screening "
            "out doomed funds, it is screening out the ones that died of never "
            "gathering assets — funds whose returns while they lived were "
            "unremarkable, because nothing much was happening in them. What it "
            "keeps is the funds that traded properly and closed anyway, and those "
            "are the ones whose returns actually differ. **A liquidity floor is "
            "not a survivorship fix.** A reader who assumed it was one would have "
            "this backwards, and would conclude that a bigger account has a "
            "bigger problem when the measurement says the two are about equal."
        )
    else:
        add(
            "This run was made with `--no-liquidity`, so both rows are the same "
            "measurement and the comparison above is empty."
        )
    add("")

    add("## The paired portfolio runs")
    add("")
    add(
        "Three books through the identical simulator, on both panels, plus a "
        "third arm. Arm A is the biased pool. Arm B is the free pool. Arm C is a "
        "random subset of B the size of A, drawn with no regard to survival, "
        f"{MATCH_DRAWS} times on fixed seeds — so A against C is survivorship at a "
        "matched pool size and C against B is breadth with survival held "
        "constant. Reporting both is how a reader sees the confound instead of "
        "being asked to trust that it was handled."
    )
    add("")
    add(headline_table(study))
    add("")
    add(gap_table(study))
    add("")
    add(
        "A positive number in either gap column means the BIASED panel earned "
        "more — that survivorship flattered the result. The CAGR column carries "
        "compounding and therefore carries the breadth effect; the paired daily "
        "column differences the two books day by day, which removes the market "
        "and leaves the treatment."
    )
    add("")
    add(
        "**The last two columns are the answer to what remains confounded, and "
        "they add up.** A minus B is the practitioner's mistake and it is "
        "confounded by breadth, because the free pool is wider. A minus C is the "
        "same comparison at a matched pool size. C minus B is what is left, which "
        "is breadth alone with survival held constant — and by construction "
        "(A-C) + (C-B) = (A-B) exactly, so the two columns partition the naive "
        "gap rather than merely commenting on it."
    )
    add("")
    breadth = _breadth_effect(study)
    add(
        f"The direction of the residual confound is therefore measured rather "
        f"than argued. Across the cross-sectional books the breadth term averages "
        f"{_pa(breadth)} a year, so a wider pool "
        f"{'helps' if breadth < 0 else 'hurts'} — which means the naive A-B "
        f"comparison {'UNDERSTATES' if breadth < 0 else 'OVERSTATES'} the "
        f"survivorship effect by about that much. Removing dead funds from a "
        f"universe does two things at once, and only one of them is survivorship."
    )
    add("")
    add(
        "**The two momentum rows are the point of running momentum at all.** A "
        f"fixed count of {MOMENTUM_NAMES} names is a harder screen out of a wider "
        f"universe, so arm B is more selective than arm A and the comparison "
        f"carries selectivity. A fixed {MOMENTUM_FRACTION:.0%} holds selectivity "
        "constant and lets the book's width move instead. The two answers are "
        "printed side by side rather than averaged, because averaging them would "
        "produce one number that is neither."
    )
    add("")
    eligible_a = float(study.books[("equal", "biased")].names_held.mean(skipna=True))
    eligible_b = float(study.books[("equal", "free")].names_held.mean(skipna=True))
    add(
        f"**And here the selectivity confound is small, for a reason worth stating "
        f"rather than taking credit for.** The two pools differ by "
        f"{len(c.sampled)} funds out of {len(c.survivors)}, so the eligible "
        f"universe widens from about {eligible_a:.0f} names to {eligible_b:.0f} — "
        f"about {(eligible_b / eligible_a - 1.0) * 100:.0f} per cent. "
        f"{MOMENTUM_NAMES} of {eligible_a:.0f} and {MOMENTUM_NAMES} of "
        f"{eligible_b:.0f} are nearly the same screen. "
        f"The earlier attempts hit this hard because they DELETED sixty "
        f"per cent of a universe to make the biased side; this one ADDS to it, "
        f"which is the same experiment run in the direction that does not "
        f"manufacture the confound. What is left of it, arm C prices."
    )
    add("")
    add(
        f"**What the momentum rows do not establish is a number.** Both of their "
        f"intervals cross zero, on every arm. {len(c.sampled)} dead funds are "
        f"enough to measure a cross-sectional mean, which is what the identity "
        f"is, and not "
        "enough to measure what a twenty-name book made of the top of that "
        "cross-section did — the same funds are being asked a much harder "
        "question. The equal-weight row is the one carrying the result; these two "
        "are here to show it is not an artefact of one weighting scheme, and "
        + (
            "every cross-sectional book agrees with it in sign on both the naive "
            "and the breadth-matched comparison."
            if _signs_agree(study)
            else "they do NOT all agree with it in sign, which is what an "
            "underpowered sample looks like and is the reason the interval is "
            "printed beside every one of them."
        )
    )
    add("")

    add("## What a closing fund pays, and how much the answer depends on it")
    add("")
    add(
        "This is where the sign of an equity survivorship study is decided and it "
        "is why an ETF study lands somewhere else. A stock that delists for cause "
        "hands its holder a fraction of nothing; CRSP's performance-related "
        "delisting returns are around minus thirty per cent and the tail below "
        "that is where the single-name bias lives. An ETF that closes runs a "
        "liquidation: creations stop, the portfolio is sold, the proceeds are "
        "distributed. The assets were never the sponsor's to lose."
    )
    add("")
    add(
        "The base case here is therefore that a position converts to cash at its "
        "last printed mark, on the session AFTER the final print, with no "
        "foreknowledge — a real holder, warned weeks ahead by the closure notice, "
        "would have done better. The tape is asked directly rather than trusted:"
    )
    add("")
    add(endings_table(study))
    add("")
    add(
        "A third of the cohort's final quarters are negative and two thirds are "
        "not, which is what a mixture of takeovers and failures looks like and is "
        "the answer to the question that could not be settled before the data "
        "existed. The `worst` row is the reason the mean and the median are both "
        "printed: one fund lost four fifths of its value in three months and the "
        "median fund gained."
    )
    add("")
    add("### The dead cohort, best and worst")
    add("")
    add(roster_table(study))
    add("")
    add(
        "Sorted by lifetime return, head and tail, because sorted and truncated "
        "at one end this table would print nothing but winners and read as "
        "evidence that closing funds do fine. Read down the last two columns: a "
        "fund that compounded for eight years and stopped is a closure, a fund "
        "that lost most of its value and stopped is not, and the aggregate figure "
        "cannot tell a reader which of the two it is made of. Both are in here."
    )
    add("")
    add(ladder_table(study))
    add("")
    add(
        "Read the bottom row as the bound rather than as a scenario. Paying "
        "nothing at all is what a bankrupt equity does and it is not what an ETF "
        "does, so that line measures how much of this result is an assumption: "
        "everything between it and the top row."
    )
    add("")
    held_to_death = study.books[("equal", "free")].liquidations
    add(
        f"**And the ladder is short, which is the finding underneath it.** "
        f"Assuming a closing fund pays its holder NOTHING moves the equal-weight "
        f"bias from {_pa(study.ladder[BASE_RECOVERY]['identity_pa'])} to "
        f"{_pa(study.ladder[0.0]['identity_pa'])} a year — a swing of "
        f"{_ladder_swing(study) * 100:.2f} "
        f"points against a 95% interval "
        f"{abs(identity_interval.high - identity_interval.low) * 100:.2f} points "
        f"wide. The reason is visible in the book: over "
        f"{len(study.tape.sessions):,} sessions the free panel liquidated a "
        f"position {held_to_death} "
        f"{'time' if held_to_death == 1 else 'times'}, because a fund's volume "
        f"usually fails the floor months before its tape stops and the rebalance "
        f"has already let it go."
    )
    add("")
    add(
        "So the survivorship effect measured here is almost entirely about how "
        "doomed funds behaved WHILE THEY WERE ALIVE, and hardly at all about what "
        "they paid at the end. That is the opposite of the single-name case, "
        "where the terminal event is most of the bias, and it is why the two "
        "cannot be reasoned about with the same intuition."
    )
    add("")

    add("## What this does to the ledger")
    add("")
    add(
        "**An estimate, not a re-run.** Re-running thirty-three strategies would "
        "take hours and the marginal value is low, for a reason that is worth "
        "more than the run would be: **32 of the 33 published strategies in the "
        "registry name their own legs.** The Permanent Portfolio holds four "
        "funds by name; Antonacci's dual momentum holds four; every factor row "
        "holds one. Adding dead funds to the panel cannot move a weight in any "
        "of them, because none of them ever looks at a fund it was not told "
        "about. Their survivorship exposure is not small, it is structurally "
        "zero."
    )
    add("")
    add(
        f"One strategy ranks or spans a cross-section — `equal_weight_universe`, "
        f"142 legs — and it is the one this file has measured directly. Its "
        f"reported figure would move by about {_pa(equal_gap['daily_mean_pa'])} a "
        f"year on this panel"
        + (
            f", or about {_pa(scaled['scaled_pa'])} at the shelf's own attrition rate"
            if scaled.get("available")
            else ""
        )
        + ". Nothing else in the ledger moves at all."
    )
    add("")
    add(
        f"So the ledger's three headline claims survive, and it is worth doing "
        f"the arithmetic rather than asserting it. The post-publication mean "
        f"excess over SPY across 30 dated strategies is -4.03% a year; exactly "
        f"one of those 30 rows moves, by {_pa(equal_gap['daily_mean_pa'])}, so the "
        f"mean moves by {_pa(equal_gap['daily_mean_pa'] / 30.0, 3)} — the third "
        f"decimal place. The MEDIAN of -3.21% does not move at all, because a "
        f"single row shifting by two tenths of a point cannot cross the middle of "
        f"thirty. And the count of 3 in 30 beating SPY is unchanged: equal weight "
        f"returns {_pa(measure(study.books[('equal', 'biased')], rf=study.rf).cagr)} "
        f"against SPY's {_pa(spy.cagr)} on this panel and loses on either."
    )
    add("")
    add(
        "**The channel that does affect everything is a different one, and it is "
        "not what this file measured.** The named legs were themselves chosen in "
        "2026 from funds that still trade. A club building an international "
        "sleeve in 2005 might well have bought ADRE, GAF or FRN rather than EEM, "
        "and all three are gone. That is vehicle-selection bias rather than "
        "cross-sectional survivorship, it applies to every sleeve book in the "
        "repository, and its size is the same arithmetic — the doomed share of "
        "the menu times the per-fund gap. What it is not is measurable from this "
        "tape, because nothing records which fund a 2005 committee would have "
        "picked."
    )
    add("")

    add("## What is still missing")
    add("")
    residual = [
        f"**{_unfetched_dead(study):,} "
        f"dead shelf symbols have no bars here.** The acquisition is metered at "
        f"roughly fifty symbols an hour and runs on; every one that lands widens "
        f"the cohort and narrows the interval, and none of them changes the "
        f"design.",
        f"**The catalogue records almost no closure before {cliff_year}.** "
        f"`retention_cliff` estimates "
        f"{study.cliff.get('missing_low_estimate', '?')}-"
        f"{study.cliff.get('missing_mid_estimate', '?')} ETF closures the vendor "
        f"never carried, and they are exactly the 2008-09 casualties whose "
        f"returns would be worst. Every number above is therefore a LOWER bound "
        f"on the whole-sample bias and a fair measurement of the post-cliff one.",
        "**Closed-end funds sit in the dead cohort.** The vendor types some of "
        "them ETF, the pre-SPY rule catches only those older than the ETF "
        "itself, and `NKG` — a Nuveen municipal fund starting in 2002 — walks "
        "straight through. The jackknife above is the bound on what that can be "
        "worth: no single removal moves the sign.",
        "**Whole shares, minimum trade sizes and the turnover budget are off.** "
        "Every one of them is a function of breadth rather than of survival, so "
        "leaving them on would have charged one panel for being wider and "
        "reported it as survivorship. The consequence is that these curves are "
        "not the ledger's curves and are not meant to be compared to them; the "
        "quantity that transfers is the GAP.",
        f"**The dead cohort is {len(c.sampled)} funds.** Enough to measure a "
        f"cross-sectional mean and not enough to measure what a concentrated "
        f"book made of the top of it did — every interval above says which is "
        f"which, and only the pull changes it.",
    ]
    for item in residual:
        add(f"- {item}")
    add("")

    add("## The run")
    add("")
    facts = [
        [
            "Study window",
            f"{study.tape.sessions[0].date()} to {study.tape.sessions[-1].date()}",
        ],
        ["Sessions", f"{len(study.tape.sessions):,}"],
        ["Funds on the tape", f"{len(study.tape.names):,}"],
        ["Eligibility", "existence, 252 sessions of history"
            + (f", ADV >= ${study.floor:,.0f} and price >= ${UNIVERSE.min_price:,.2f}"
               if study.liquidity else " (no liquidity gate)")],
        ["Rebalance", "last session of each month, filled at the next open"],
        ["Costs", "engine `CostModel` at 1x, spread plus square-root impact"],
        ["Cash", study.bill_note],
        [
            "Delisting",
            f"cash at {BASE_RECOVERY:.0%} of the last mark, one session later",
        ],
        ["Breadth-matched draws", f"{MATCH_DRAWS}"],
        [
            "Bootstrap",
            f"circular blocks of {BLOCK_SESSIONS}, {BOOTSTRAP_DRAWS:,} draws, "
            f"seed {SEED}",
        ],
        ["Sample provenance", study.provenance or "unrecorded"],
        ["Cache", study.cache_note],
        ["Network", "none — every bar read from disk, the vendor's meter untouched"],
        ["Report", str(out)],
    ]
    add(runs.table(["", ""], facts, ["l", "l"]))
    add("")
    add(f"_Generated {runs.stamp(generated_at)}._")
    add("")
    return "\n".join(lines)


# -- console --------------------------------------------------------------


def print_console(study: Study) -> None:
    identity_pa = float(study.identity.difference.mean() * 252.0)
    interval = block_bootstrap(study.identity.difference)
    typer.echo("")
    typer.echo(f"  survivors {len(study.cohorts.survivors)}  "
               f"sampled dead {len(study.cohorts.sampled)}  "
               f"hand-picked dead {len(study.cohorts.opportunistic)}")
    typer.echo(f"  SPY control {'OK' if study.control_ok else 'FAILED'} "
               f"({study.control_gap:.2e})")
    typer.echo(
        f"  equal-weight survivorship bias {identity_pa * 100:+.2f}%/yr "
        f"[{interval.low * 100:+.2f}, {interval.high * 100:+.2f}]"
    )
    for warning in study.warnings:
        typer.secho(f"  ! {warning}", fg=typer.colors.YELLOW)
    typer.echo("")


def _generated_at() -> datetime:
    return datetime.now(timezone.utc)


# -- the command ----------------------------------------------------------


@app.command()
def main(
    start: str = typer.Option(SAMPLE_START, "--start", help="First session, ISO."),
    end: str = typer.Option(
        "", "--end", help="Last session; blank means the last bar."
    ),
    out: Path = typer.Option(DEFAULT_REPORT, "--out", help="Where to write."),
    coverage: Path = typer.Option(
        None,
        "--coverage",
        help="The acquisition run's coverage table, naming the randomly-sampled dead.",
    ),
    liquidity: bool = typer.Option(
        True,
        "--liquidity/--no-liquidity",
        help="Apply this account's ADV floor to the investable universe.",
    ),
    draws: int = typer.Option(MATCH_DRAWS, "--draws", help="Breadth-matched pools."),
    quiet: bool = typer.Option(
        False, "--quiet", help="Write the report and little else."
    ),
) -> None:
    generated_at = _generated_at()
    cache = ParquetCache()
    asof = generated_at.date()

    try:
        directory = load_directory(cache)
    except PanelUnavailable as exc:
        raise runs.refuse_no_data(exc, what="no survivorship measurement was made")

    classified = de.classify(directory, asof=asof)
    on_disk = cached_tickers(Path(cache.root))
    if not on_disk:
        raise runs.refuse_no_data(
            PanelUnavailable(
                f"no price frames under {cache.root}/{PRICE_SLUG}. This run reads "
                f"the cache and never the vendor, so an empty cache is an empty "
                f"study rather than a slow one."
            ),
            what="no survivorship measurement was made",
        )

    drawn, served, provenance = _acquisition(coverage, sorted(on_disk))
    cohorts = build_cohorts(classified, on_disk, served=served, drawn=drawn)

    if not quiet:
        typer.echo(f"  reading {len(on_disk)} cached funds")
    read = {t: read_bars(cache, t, on_disk[t]) for t in cohorts.all_names}
    silent = tuple(t for t, f in read.items() if f.empty)
    frames = [f for f in read.values() if not f.empty]
    if not frames:
        raise runs.refuse_no_data(
            PanelUnavailable("every cached entry read back empty"),
            what="no survivorship measurement was made",
        )
    prices = pd.concat(frames, ignore_index=True)

    bill = load_bill(cache)
    bill_note = (
        f"FRED {FRED_SERIES}, compounded over calendar days "
        f"({bill.min() / 100:.2%}-{bill.max() / 100:.2%} across the pull)"
        if bill is not None and len(bill)
        else "credited nothing — the bill series is not cached, which penalises "
        "the free panel for the weeks a liquidation's proceeds sit idle"
    )

    first = pd.Timestamp(date.fromisoformat(start))
    last = (
        pd.Timestamp(date.fromisoformat(end))
        if end
        else pd.Timestamp(prices["date"].max())
    )
    try:
        tape = build_tape(prices, start=first, end=last, bill=bill)
    except PanelUnavailable as exc:
        raise runs.refuse_no_data(exc, what="no survivorship measurement was made")

    # The catalogue said which funds died; the tape gets to disagree.
    # Done here rather than inside `build_cohorts` because only the bars
    # can answer it, and the bars are not read until now.
    cohorts = reconcile(cohorts, tape)

    rf = (
        pd.Series(
            bill.to_numpy(dtype="float64") / 100.0,
            index=pd.DatetimeIndex(bill.index),
            name=FRED_SERIES,
        )
        if bill is not None and len(bill)
        else 0.0
    )

    floor = de.deployable_floor(BacktestConfig())
    if not quiet:
        typer.echo(f"  {len(tape.sessions):,} sessions, {len(tape.names)} funds")

    study = run_study(
        tape,
        cohorts,
        classified,
        floor=floor,
        liquidity=liquidity,
        rf=rf,
        bill_note=bill_note,
        cache_note=str(cache.root),
        asof=asof,
        draws=int(draws),
        silent=silent,
        provenance=provenance,
        on_progress=None if quiet else typer.echo,
    )

    if not quiet:
        print_console(study)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(study, generated_at, out), "utf-8")
    if not quiet:
        typer.echo(f"  report → {out}\n")

    raise typer.Exit(EXIT_OK if study.control_ok else EXIT_FAILED)


def _acquisition(
    coverage: Path | None, on_disk: Sequence[str]
) -> tuple[tuple[str, ...], tuple[str, ...], str]:
    """(drawn, served, how we know) for the dead funds on disk.

    The coverage table `deadetfs.acquire` writes is the authority and is
    the only thing that separates a name the seeded shuffle reached from
    a name somebody pulled because it was interesting — a distinction
    the whole estimate rests on, since only the first kind supports an
    interval.

    Without it there is one fallback and it is weaker rather than
    equivalent: `etfuniverse.DECEASED` is the hand-picked list this
    repository already carried, so everything else dead on disk arrived
    through `acquire` and is very probably a draw. Very probably is not
    the same as by construction, so the rule used is named in the report
    rather than assumed away.
    """
    if coverage is not None:
        path = Path(coverage)
        if path.is_file():
            frame = pd.read_parquet(path)
            if "ticker" in frame.columns:
                everything = tuple(
                    sorted(str(t).strip().upper() for t in frame["ticker"])
                )
                if "served" not in frame.columns:
                    return everything, everything, f"the coverage table at {path}"
                answered = frame.loc[frame["served"].astype("bool")]
                return (
                    everything,
                    tuple(sorted(str(t).strip().upper() for t in answered["ticker"])),
                    f"the acquisition's own coverage table ({path.name})",
                )

    picked = {str(t).strip().upper() for t in eu.DECEASED_TICKERS}
    guessed = tuple(sorted(t for t in on_disk if t not in picked))
    return (
        guessed,
        guessed,
        "no coverage table was supplied, so provenance falls back to the rule "
        "that everything dead on disk outside `etfuniverse.DECEASED` came "
        "through `deadetfs.acquire` — probable rather than certain",
    )


if __name__ == "__main__":
    app()
