"""The survivorship-free universe, exercised with no key and no network.

Nothing here reaches Tiingo. The directory is a small frame shaped like
the real one and the price endpoint is a stub, because a suite that
needed a token would only run on the machine that has one — which is the
same as not running.

Seven things are on trial and every one of them fails QUIETLY in
production, which is what makes each worth a test rather than a comment.

**A dead fund has to survive into the universe.** The whole point is
that `universe_on('2011-06-30')` names funds that closed in 2013, and
the failure mode is a filter written by somebody thinking about today
that silently drops them again.

**A reissued ticker is a refusal, never a pick.** ACTV traded to 2013
and a different fund wore the symbol from 2020. Tiingo serves one series
per string, so resolving it either way grafts one fund's bars onto
another's dates — the recycled-symbol failure, arriving through the
function written to remove survivorship bias.

**A venue migration is not a reissue.** AIEQ moved NYSEARCA to NYSE
contiguously. Refusing that would throw away a live fund to avoid a
problem it does not have.

**The vendor's death record has a beginning and the module must find
it.** Tiingo lists one ETF closure in 2010 and two hundred and
thirty-nine in 2020. `retention_cliff` reads that off the data, as the
last year before which under one per cent of the window's own closures
fall — a share of the record rather than a rate somebody had to pick.

**An outage and an empty answer are opposite findings.** A fund the
vendor serves nothing for is a measurement; a fund we never got to
because the meter refused is not. `pull_dead` keeps them apart and
`recovery_report` refuses to blur them.

**A partial pull must stay a random sample.** The plan is shuffled on a
fixed seed and a shorter limit is a PREFIX of a longer one, so a resumed
run neither re-samples nor skips.

**The floor is derived, not typed.** $655,000 is arithmetic on three
engine constants, and the test asserts the arithmetic rather than the
number, so moving the account size moves the floor.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Any, Callable

import pandas as pd
import pytest

from griffinquant.config import UNIVERSE as UNIVERSE_RULES
from griffinquant.data import deadetfs as de
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.sleevedata import TickerNotAllowed, synthetic_permaticker

ASOF = date(2026, 8, 3)


# -- a catalogue small enough to read -------------------------------------


#: Shaped like the real file and carrying every case that matters: a
#: living fund, a fund that closed in 2013, a fund that closed inside the
#: sample and lived only weeks, a symbol that migrated venue, a symbol
#: that was reissued to a different fund, a one-print row, and three rows
#: that are not on our shelf at all.
_ROWS: list[tuple[str, str, str, str, str, str]] = [
    ("SPY", "NYSE", "ETF", "USD", "1993-01-29", "2026-07-31"),
    ("ZOMB", "NYSEARCA", "ETF", "USD", "2006-05-01", "2013-09-20"),
    ("BRIEF", "BATS", "ETF", "USD", "2015-01-05", "2015-03-02"),
    # One series that moved venue, contiguous to the week.
    ("MIGR", "NYSEARCA", "ETF", "USD", "2009-03-02", "2019-12-31"),
    ("MIGR", "NYSE", "ETF", "USD", "2020-01-02", "2026-07-31"),
    # One string, two funds, seven years apart.
    ("REUSE", "NYSE", "ETF", "USD", "2007-04-02", "2012-11-16"),
    ("REUSE", "NYSEARCA", "ETF", "USD", "2019-10-01", "2026-07-31"),
    ("ONEDAY", "NASDAQ", "ETF", "USD", "2018-06-04", "2018-06-04"),
    ("AAPL", "NASDAQ", "Stock", "USD", "1980-12-12", "2026-07-31"),
    ("HUSK", "PINK", "ETF", "USD", "2009-01-02", "2015-06-30"),
    ("FOREIGN", "SHG", "ETF", "CNY", "2015-01-02", "2026-07-31"),
]


def _directory(
    rows: list[tuple[str, str, str, str, str, str]] | None = None,
) -> pd.DataFrame:
    raw = rows if rows is not None else _ROWS
    return pd.DataFrame(
        {
            "ticker": [r[0] for r in raw],
            "exchange": [r[1] for r in raw],
            "asset_type": [r[2] for r in raw],
            "currency": [r[3] for r in raw],
            "start_date": pd.to_datetime([r[4] for r in raw]),
            "end_date": pd.to_datetime([r[5] for r in raw]),
        }
    )


def _classified() -> pd.DataFrame:
    return de.classify(_directory(), asof=ASOF)


# -- a price source that never opens a socket -----------------------------


def _bars(
    ticker: str,
    *,
    sessions: int = 400,
    close: float = 20.0,
    volume: float = 200_000.0,
    start: str = "2010-01-04",
) -> pd.DataFrame:
    days = pd.bdate_range(start, periods=sessions)
    return pd.DataFrame(
        {
            "ticker": ticker,
            "date": days,
            "close_unadj": [close] * sessions,
            "volume_unadj": [volume] * sessions,
        }
    )


class _Fund:
    """Stands where `ETFUniverseSource` stands, and answers from a dict.

    A stub rather than the real class because what is on trial in the
    pull tests is the loop's bookkeeping — attempted against served,
    stopped against finished — and driving that through an HTTP fake
    would test the fake.
    """

    def __init__(
        self,
        bars: dict[str, pd.DataFrame],
        *,
        refuse: set[str] | None = None,
    ) -> None:
        self._bars = bars
        self._refuse = refuse or set()
        self.asked: list[str] = []

    def permaticker_for(self, ticker: str) -> int:
        return synthetic_permaticker(ticker)

    def prices(
        self, start: date, end: date, permatickers: Any = None
    ) -> pd.DataFrame:
        wanted = list(permatickers or [])
        symbol = next(
            t
            for t in {*self._bars, *self._refuse}
            if synthetic_permaticker(t) in wanted
        )
        self.asked.append(symbol)
        if symbol in self._refuse:
            raise SourceUnavailable(f"{symbol}: HTTP 429")
        return self._bars.get(symbol, _EMPTY)


_EMPTY = pd.DataFrame(
    {"ticker": [], "date": [], "close_unadj": [], "volume_unadj": []}
)


# -- the shelf ------------------------------------------------------------


def test_the_shelf_is_only_what_this_project_could_have_bought() -> None:
    shelf = de.etf_shelf(_directory())
    assert set(shelf["ticker"]) == {
        "SPY",
        "ZOMB",
        "BRIEF",
        "MIGR",
        "REUSE",
        "ONEDAY",
    }
    # A stock, a Shanghai line and a PINK husk are not narrower versions
    # of the shelf; they are a different shelf.
    assert "AAPL" not in set(shelf["ticker"])
    assert "FOREIGN" not in set(shelf["ticker"])
    assert "HUSK" not in set(shelf["ticker"])


def test_an_empty_directory_is_an_outage_and_never_an_industry_with_no_deaths() -> None:
    with pytest.raises(SourceUnavailable):
        de.etf_shelf(pd.DataFrame())
    with pytest.raises(SourceUnavailable):
        de.etf_shelf(pd.DataFrame({"ticker": ["SPY"]}))


# -- classification -------------------------------------------------------


def test_every_shelf_symbol_lands_in_exactly_one_state() -> None:
    frame = _classified()
    assert set(frame["status"]) <= set(de.STATUSES)
    assert len(frame) == frame["ticker"].nunique()

    by = frame.set_index("ticker")
    assert by.loc["SPY", "status"] == de.STATUS_ALIVE
    assert by.loc["ZOMB", "status"] == de.STATUS_DEAD
    assert by.loc["ZOMB", "last_available"] == pd.Timestamp("2013-09-20")
    # One print cannot produce a return, so it never had a life to lose
    # and counting it dead would inflate the attrition figure with
    # entities that never traded.
    assert by.loc["ONEDAY", "status"] == de.STATUS_NEVER_TRADED


def test_a_row_with_no_coverage_window_travels_through_every_function() -> None:
    """`_load_directory` coerces an unparseable date to NaT, so this happens.

    NaT is the honest value — a fabricated 1970 would read as "listed
    before anything else here" — but it has to survive the arithmetic
    downstream rather than raising halfway through a report or, worse,
    counting as a fund that existed on every date.
    """
    raw = pd.DataFrame(
        {
            "ticker": ["SPY", "BLANK"],
            "exchange": ["NYSE", "NYSE"],
            "asset_type": ["ETF", "ETF"],
            "currency": ["USD", "USD"],
            "start_date": pd.to_datetime(["2005-01-03", None]),
            "end_date": pd.to_datetime(["2026-07-31", None]),
        }
    )
    frame = de.classify(raw, asof=ASOF)
    by = frame.set_index("ticker")
    assert by.loc["BLANK", "status"] == de.STATUS_NEVER_TRADED
    assert by.loc["BLANK", "windows"] == 0
    assert pd.isna(by.loc["BLANK", "days_listed"])

    assert de.universe_on(frame, "2010-01-04") == ("SPY",)
    assert de.acquisition_plan(frame, asof=ASOF) == ()
    de.attrition(frame, first_year=2005, last_year=2007, asof=ASOF)
    de.plan_reach(frame, ())


def test_a_venue_migration_is_one_series_and_stays_resolvable() -> None:
    by = _classified().set_index("ticker")
    assert by.loc["MIGR", "windows"] == 1
    assert by.loc["MIGR", "resolvable"]
    assert by.loc["MIGR", "first_available"] == pd.Timestamp("2009-03-02")
    # Filed where it ended up rather than where it began.
    assert by.loc["MIGR", "exchange"] == "NYSE"


def test_a_reissued_ticker_is_refused_out_loud_rather_than_resolved() -> None:
    """One string, two funds, and the vendor serves one series for it.

    Picking either is the graft `schema.py` opens by describing: a dead
    fund's history welded onto a living one's dates, backtesting
    beautifully. The refusal has to be a counted row rather than a
    silent drop, or the panel shrinks without anything reading the panel
    shrinking.
    """
    frame = _classified()
    by = frame.set_index("ticker")
    assert by.loc["REUSE", "windows"] == 2
    assert not by.loc["REUSE", "resolvable"]
    assert "reissued" in by.loc["REUSE", "ambiguity"]
    assert "REUSE" in set(de.unresolvable(frame)["ticker"])


def test_a_dead_fund_hiding_behind_a_live_symbol_is_counted() -> None:
    """REUSE trades today and a fund that died in 2012 wore the string.

    Unreachable at any price — asking the vendor returns the live series
    — so it is a residual rather than a task, and a residual nobody
    counts is one nobody prices.
    """
    assert de.composition(_classified())["dead_behind_live_symbols"] == 1


# -- attrition ------------------------------------------------------------


def test_attrition_counts_the_cohort_that_stood_on_the_shelf_that_january() -> None:
    frame = de.attrition(_classified(), first_year=2010, last_year=2014, asof=ASOF)
    by = frame.set_index("year")
    # 2010: SPY, ZOMB, MIGR, REUSE — of which ZOMB is dead now and
    # REUSE is unresolvable but still a shelf row that died.
    assert by.loc[2010, "listed"] == 4
    assert by.loc[2010, "dead_now"] == 1
    # 2014 opens after ZOMB closed, so the cohort has lost it entirely
    # rather than carrying it as a survivor.
    assert by.loc[2014, "listed"] == 3
    assert by.loc[2013, "died"] == 1


def test_attrition_keeps_flow_and_stock_apart() -> None:
    frame = de.attrition(_classified(), first_year=2006, last_year=2020, asof=ASOF)
    by = frame.set_index("year")
    assert by.loc[2006, "born"] == 1
    assert by.loc[2015, "born"] == 1
    assert by.loc[2015, "died"] == 1
    assert (frame["share_dead"] <= 1.0).all()


def test_the_attrition_table_prints_a_row_per_year() -> None:
    frame = de.attrition(_classified(), first_year=2010, last_year=2013, asof=ASOF)
    text = de.render_attrition(frame)
    assert text.count("\n") == 5  # header, rule, four years
    assert "2010" in text and "2013" in text


# -- the retention cliff --------------------------------------------------


def _cliff_directory() -> pd.DataFrame:
    """A shelf whose deaths all fall after 2015, as the real one's do.

    Twenty long-lived funds listed in 2005, four of which close in each
    of 2016 through 2019 and none before. A catalogue with that shape is
    not a market in which nothing failed for eleven years.
    """
    rows: list[tuple[str, str, str, str, str, str]] = []
    for i in range(20):
        rows.append((f"LIVE{i}", "NYSE", "ETF", "USD", "2005-01-03", "2026-07-31"))
    for year in (2016, 2017, 2018, 2019):
        for i in range(4):
            rows.append(
                (
                    f"D{year}{i}",
                    "NYSE",
                    "ETF",
                    "USD",
                    "2005-01-03",
                    f"{year}-06-30",
                )
            )
    return _directory(rows)


def test_the_cliff_is_read_off_the_data_and_not_off_a_constant() -> None:
    frame = de.classify(_cliff_directory(), asof=ASOF)
    found = de.retention_cliff(frame, first_year=2005, last_year=2019, asof=ASOF)
    assert found["cliff_year"] == 2016
    assert found["recorded_closures_before_cliff"] == 0
    assert found["years_before_cliff"] == 11
    # The estimate is the catalogue's own post-cliff rates applied to
    # its own pre-cliff cohorts. No outside figure for industry
    # closures is used, so the argument survives a reader who trusts
    # none of them.
    assert found["missing_low_estimate"] > 0
    assert found["missing_mid_estimate"] >= found["missing_low_estimate"]


def test_the_partial_current_year_never_plants_a_cliff() -> None:
    """The as-of year is short and its closure count is low by construction.

    Counted, it would drag the median down and could put the cliff at
    the most recent year in the table — announcing that the vendor
    stopped retaining its dead this morning.
    """
    frame = de.classify(_cliff_directory(), asof=ASOF)
    through = de.retention_cliff(frame, first_year=2005, last_year=2026, asof=ASOF)
    assert through["cliff_year"] == 2016


def test_a_catalogue_with_no_death_record_says_so_rather_than_guessing() -> None:
    rows = [
        (f"LIVE{i}", "NYSE", "ETF", "USD", "2005-01-03", "2026-07-31")
        for i in range(10)
    ]
    frame = de.classify(_directory(rows), asof=ASOF)
    found = de.retention_cliff(frame, first_year=2005, last_year=2025, asof=ASOF)
    assert found["cliff_year"] is None
    assert "death record" in found["note"]


def test_a_healthy_record_reports_its_own_first_year_and_no_missing_funds() -> None:
    """A cliff detector that always finds a cliff has found nothing.

    Deaths spread evenly across the window cross the tail share in the
    second year, so the answer is the start of the window and an
    estimate of nought — which is what "the record begins where the
    window does" has to look like.
    """
    rows = [
        (f"LIVE{i}", "NYSE", "ETF", "USD", "2005-01-03", "2026-07-31")
        for i in range(40)
    ]
    for year in range(2006, 2020):
        rows.append(
            (f"D{year}", "NYSE", "ETF", "USD", "2005-01-03", f"{year}-06-30")
        )
    frame = de.classify(_directory(rows), asof=ASOF)
    found = de.retention_cliff(frame, first_year=2005, last_year=2019, asof=ASOF)
    assert found["cliff_year"] == 2006
    assert found["missing_low_estimate"] == 0
    assert found["missing_mid_estimate"] == 0


# -- the universe as a function of a date ---------------------------------


def test_a_fund_that_later_closed_is_in_the_universe_on_the_days_it_traded() -> None:
    """The whole module in one assertion.

    A list of what exists now, sliced by a date column, answers this
    with the survivors. Asking the catalogue what stood on the shelf
    that morning answers it with ZOMB, which closed in 2013 and was
    perfectly buyable in 2011.
    """
    frame = _classified()
    assert "ZOMB" in de.universe_on(frame, "2011-06-30")
    assert "ZOMB" not in de.universe_on(frame, "2014-06-30")
    assert "ZOMB" not in de.universe_on(frame, "2005-06-30")


def test_an_unresolvable_symbol_never_enters_a_universe() -> None:
    frame = _classified()
    for day in ("2010-06-30", "2021-06-30"):
        assert "REUSE" not in de.universe_on(frame, day)


def test_the_deployable_gate_turns_existed_into_could_have_been_bought() -> None:
    frame = _classified()
    listed = de.universe_on(frame, "2011-06-30")
    assert "SPY" in listed and "ZOMB" in listed

    gated = de.universe_on(
        frame,
        "2011-06-30",
        deployable={"SPY": pd.Timestamp("1993-02-01"),
                    "ZOMB": pd.Timestamp("2012-01-03")},
    )
    # ZOMB existed and its own tape could not yet carry the account.
    assert gated == ("SPY",)


# -- the floor ------------------------------------------------------------


def test_the_floor_is_the_engine_arithmetic_rather_than_a_number_we_typed() -> None:
    from griffinquant.engine.backtest import BacktestConfig

    config = BacktestConfig()
    expected = (
        config.starting_cash * config.max_daily_turnover / config.max_participation
    )
    assert de.deployable_floor() == pytest.approx(expected)
    # And it moves with the account rather than staying at the figure
    # that happened to be true when the module was written.
    bigger = BacktestConfig(starting_cash=config.starting_cash * 2)
    assert de.deployable_floor(bigger) == pytest.approx(expected * 2)


def test_no_participation_cap_means_no_floor() -> None:
    class _Uncapped:
        starting_cash = 131_000.0
        max_daily_turnover = 0.05
        max_participation = None

    assert de.deployable_floor(_Uncapped()) == 0.0


# -- the plan -------------------------------------------------------------


def _plan_directory(n: int = 40) -> pd.DataFrame:
    rows = [
        (f"D{i:03d}", "NYSE", "ETF", "USD", "2008-01-02", "2016-06-30")
        for i in range(n)
    ]
    rows.append(("SPY", "NYSE", "ETF", "USD", "1993-01-29", "2026-07-31"))
    rows.append(("SHORT", "NYSE", "ETF", "USD", "2015-01-05", "2015-04-02"))
    rows.append(("REUSE", "NYSE", "ETF", "USD", "2007-04-02", "2012-11-16"))
    rows.append(("REUSE", "NYSEARCA", "ETF", "USD", "2019-10-01", "2020-11-16"))
    # A closed-end fund the vendor types ETF, trading four years before
    # the first US ETF existed.
    rows.append(("OLDCEF", "NYSE", "ETF", "USD", "1989-03-01", "2016-08-11"))
    return _directory(rows)


def test_the_plan_is_the_same_list_on_every_machine() -> None:
    frame = de.classify(_plan_directory(), asof=ASOF)
    once = de.acquisition_plan(frame, asof=ASOF)
    twice = de.acquisition_plan(frame, asof=ASOF)
    assert once == twice
    # Shuffled, not sorted. A longest-lived-first order would sample the
    # dead population with exactly the bias being measured.
    assert list(once) != sorted(once)


def test_a_shorter_plan_is_a_prefix_of_a_longer_one() -> None:
    """What makes a metered pull resumable rather than merely restartable.

    At fifty symbols an hour a full plan is a day and a half, so runs
    stack. If the truncation re-shuffled, the second run would re-sample
    names the first already holds and never reach others at all.
    """
    frame = de.classify(_plan_directory(), asof=ASOF)
    short = de.acquisition_plan(frame, asof=ASOF, limit=5)
    longer = de.acquisition_plan(frame, asof=ASOF, limit=20)
    assert longer[: len(short)] == short


def test_the_plan_holds_only_dead_funds_a_rule_could_have_held() -> None:
    frame = de.classify(_plan_directory(), asof=ASOF)
    plan = de.acquisition_plan(frame, asof=ASOF)
    assert "SPY" not in plan          # alive
    assert "SHORT" not in plan        # never reached a year of tape
    assert "REUSE" not in plan        # one string, two funds
    assert "OLDCEF" not in plan       # older than the ETF itself
    assert len(plan) == 40


def test_a_fund_older_than_the_first_etf_is_not_an_etf() -> None:
    """The one contamination test the directory can support on its own.

    Widening from a hand-picked list removes a survivorship bias and
    admits a closed-end fund problem in its place: a CEF trades at a
    persistent discount to NAV and a backtest marking one at NAV
    manufactures alpha nobody could collect. SPY listed on 1993-01-29
    and nothing before it was an ETF, whatever `assetType` says.

    A floor and not a screen, which is why the count is reported as a
    lower bound: a CEF launched in 2002 walks straight through.
    """
    frame = de.classify(_plan_directory(), asof=ASOF)
    by = frame.set_index("ticker")
    assert bool(by.loc["OLDCEF", "predates_etfs"])
    assert not by.loc["OLDCEF", "resolvable"]
    assert "before the first US ETF" in by.loc["OLDCEF", "ambiguity"]
    # It is still dead and still counted; it is simply not ours to hold.
    assert by.loc["OLDCEF", "status"] == de.STATUS_DEAD
    assert de.composition(frame)["predate_etfs"] == 1
    assert "OLDCEF" not in de.universe_on(frame, "2010-06-30")
    # SPY's own first bar is the boundary and must not exclude SPY.
    assert not bool(by.loc["SPY", "predates_etfs"])


def test_plan_reach_accounts_for_every_dead_symbol() -> None:
    """The exclusions counted apart, because they are not equally forgivable.

    A short-lived fund no rule could hold is a defensible omission. A
    reissued symbol is an admission that a real fund's history exists
    and cannot be addressed. Collapsing them into "excluded" lets the
    second hide inside the first, and a total that does not reconcile is
    how a residual goes missing.
    """
    frame = de.classify(_plan_directory(), asof=ASOF)
    plan = de.acquisition_plan(frame, asof=ASOF)
    reach = de.plan_reach(frame, plan)
    assert reach["planned"] == 40
    assert reach["too_short_to_hold"] == 1
    assert reach["reissued_symbol"] == 1
    assert reach["predate_etfs"] == 1
    assert (
        reach["predate_etfs"]
        + reach["reissued_symbol"]
        + reach["too_short_to_hold"]
        + reach["planned"]
        + reach["outside_sample_or_capped"]
        == reach["dead_symbols"]
    )


# -- the pull -------------------------------------------------------------


def test_a_fund_the_vendor_serves_nothing_for_is_a_finding_not_a_failure() -> None:
    """A directory row is the vendor's index, not its tape.

    The gap between the two is the measurement, so the empty answer has
    to arrive as a row saying `served` False rather than as an absence
    that looks like a name nobody asked for.
    """
    source = _Fund({"ALIVE": _bars("ALIVE"), "GONE": _EMPTY})
    pull = de.pull_dead(
        source, ["ALIVE", "GONE"], end=ASOF, floor=0.0, sleep=lambda _s: None
    )
    assert pull.attempted == 2
    assert pull.served == 1
    assert not pull.stopped
    by = pull.coverage.set_index("ticker")
    assert bool(by.loc["ALIVE", "served"])
    assert not bool(by.loc["GONE", "served"])
    assert int(by.loc["GONE", "rows"]) == 0


def test_the_pull_stops_rather_than_raising_and_says_where() -> None:
    """A departure from `pull_universe` next door, and a deliberate one.

    There the table is the whole universe and a hole in it reads as
    funds that never traded, so an outage must raise. Here the plan is a
    random sample and partial completion is a defined state — so
    throwing away four hundred recovered histories because the four
    hundred and first hit a metered limit would be the more destructive
    behaviour.
    """
    source = _Fund({"A": _bars("A"), "C": _bars("C")}, refuse={"B"})
    pull = de.pull_dead(
        source, ["A", "B", "C"], end=ASOF, floor=0.0, sleep=lambda _s: None
    )
    assert pull.stopped
    assert "B" in pull.stop_reason
    # The refused name is NOT attempted. An attempt with no answer and
    # an attempt answered with nothing are opposite findings, and
    # `attempted - served` is how the second one is counted.
    assert pull.attempted == 1
    assert source.asked == ["A", "B"]


class _Ticking:
    """A clock that advances a fixed step on every reading."""

    def __init__(self, step: float) -> None:
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        self.now += self.step
        return self.now


def test_a_time_budget_stops_the_loop_and_reports_that_it_did() -> None:
    source = _Fund({t: _bars(t) for t in ("A", "B", "C")})
    pull = de.pull_dead(
        source,
        ["A", "B", "C"],
        end=ASOF,
        floor=0.0,
        sleep=lambda _s: None,
        clock=_Ticking(30.0),
        budget_seconds=50.0,
    )
    assert pull.stopped
    assert "time budget" in pull.stop_reason
    assert pull.attempted == 1


def test_a_cache_read_is_not_paused_after_and_a_request_is() -> None:
    """A resumed run walks the whole plan and most of it is on disk.

    Pausing a second before each of 1,600 cache reads spends twenty-eight
    minutes being polite to nobody, and a caller who noticed would reach
    for `pause=0` and lose the pacing on the requests that do go out.
    """
    source = _Fund({t: _bars(t) for t in ("A", "B", "C")})
    slept: list[float] = []
    de.pull_dead(
        source,
        ["A", "B", "C"],
        end=ASOF,
        floor=0.0,
        pause=1.0,
        sleep=slept.append,
        clock=_Ticking(0.0),
    )
    assert slept == []

    slept.clear()
    de.pull_dead(
        source,
        ["A", "B", "C"],
        end=ASOF,
        floor=0.0,
        pause=1.0,
        sleep=slept.append,
        clock=_Ticking(1.0),
    )
    # Two pauses for three names: the last one has nobody to be polite
    # to and a run that ends on a sleep is a run that reports a second
    # longer than it took.
    assert slept == [1.0, 1.0]


def test_deployability_is_measured_on_the_tape_and_not_assumed() -> None:
    """The measurement that decides how much of the attrition matters.

    A fund whose tape never carried the floor could not have entered the
    book on any day of its life, so its absence from a panel biases
    nothing at all.
    """
    floor = 1_000_000.0
    source = _Fund(
        {
            "FAT": _bars("FAT", close=50.0, volume=100_000.0),   # $5m a day
            "THIN": _bars("THIN", close=50.0, volume=1_000.0),   # $50k a day
            "PENNY": _bars("PENNY", close=1.0, volume=10_000_000.0),
        }
    )
    pull = de.pull_dead(
        source,
        ["FAT", "THIN", "PENNY"],
        end=ASOF,
        floor=floor,
        sleep=lambda _s: None,
    )
    by = pull.coverage.set_index("ticker")
    assert bool(by.loc["FAT", "ever_deployable"])
    assert not bool(by.loc["THIN", "ever_deployable"])
    # Ten million dollars a day and a one-dollar price: the tape is
    # thick and the instrument is one the single-name rule refuses, so
    # the price floor has to bind independently of the volume one.
    assert UNIVERSE_RULES.min_price > 1.0
    assert not bool(by.loc["PENNY", "ever_deployable"])
    assert pd.notna(by.loc["FAT", "first_deployable"])


# -- what we actually got -------------------------------------------------


def test_never_attempted_and_answered_with_nothing_stay_apart() -> None:
    source = _Fund({"A": _bars("A"), "B": _EMPTY}, refuse={"C"})
    pull = de.pull_dead(
        source, ["A", "B", "C", "D"], end=ASOF, floor=0.0, sleep=lambda _s: None
    )
    report = de.recovery_report(pull)
    assert report["planned"] == 4
    assert report["attempted"] == 2
    assert report["served"] == 1
    assert report["attempted_but_empty"] == 1
    assert report["never_attempted"] == 2
    assert report["stopped"]


def test_the_residual_is_a_number_rather_than_a_caveat() -> None:
    frame = de.classify(_plan_directory(), asof=ASOF)
    plan = de.acquisition_plan(frame, asof=ASOF)
    source = _Fund({t: _bars(t) for t in plan[:3]})
    pull = de.pull_dead(
        source, plan[:3], end=ASOF, floor=0.0, sleep=lambda _s: None
    )
    reach = de.plan_reach(frame, plan)
    report = de.recovery_report(pull, reach)
    assert report["residual_dead"] == reach["dead_symbols"] - 3
    assert 0.0 < report["share_of_dead_served"] < 1.0


def test_the_deployable_share_carries_an_interval_that_stays_a_share() -> None:
    """Wilson rather than the normal approximation.

    On a few hundred draws a share near zero or one puts the normal
    interval outside [0, 1], and "-2% to 6% of dead funds were
    deployable" is an arithmetic artefact printed as a measurement.
    """
    source = _Fund(
        {
            "FAT": _bars("FAT", close=50.0, volume=100_000.0),
            "THIN": _bars("THIN", close=50.0, volume=1_000.0),
        }
    )
    pull = de.pull_dead(
        source, ["FAT", "THIN"], end=ASOF, floor=1e6, sleep=lambda _s: None
    )
    found = de.deployable_estimate(pull)
    assert found["recovered"] == 2
    assert found["ever_deployable"] == 1
    assert 0.0 <= found["low"] <= found["share"] <= found["high"] <= 1.0

    nothing = de.deployable_estimate(de.Pull(coverage=_EMPTY.iloc[:0]))
    assert nothing["recovered"] == 0
    assert pd.isna(nothing["share"])


def test_the_hand_written_list_has_no_dead_and_the_shelf_it_came_from_does() -> None:
    """The bias, in the only units anybody should accept for it.

    No pull is needed to make this measurement: a list written by
    looking at what trades today contains no funds that stopped trading,
    while the shelf it was drawn from is a quarter dead.
    """
    rows = [
        (t, "NYSE", "ETF", "USD", "2005-01-03", "2026-07-31")
        for t in ("SPY", "QQQ", "IWM")
    ] + [
        (f"D{i}", "NYSE", "ETF", "USD", "2005-01-03", "2016-06-30") for i in range(6)
    ]
    frame = de.classify(_directory(rows), asof=ASOF)
    found = de.hand_list_comparison(frame)
    assert found["hand_list_dead"] == 0
    assert found["hand_list_share_dead"] == 0.0
    assert found["shelf_share_dead"] > 0.5
    # Names the catalogue does not carry are unmatched rather than filed
    # under either state; four real ETFs are missing from it outright.
    assert found["unmatched"] == found["hand_list"] - found["matched_on_shelf"]


def test_the_verdict_renders_without_deciding_anything_itself() -> None:
    frame = de.classify(_cliff_directory(), asof=ASOF)
    plan = de.acquisition_plan(frame, asof=ASOF)
    source = _Fund({t: _bars(t) for t in plan[:2]})
    pull = de.pull_dead(
        source, plan[:2], end=ASOF, floor=0.0, sleep=lambda _s: None
    )
    verdict = de.survivorship_verdict(frame, pull, plan, asof=ASOF)
    text = de.render_recovery(verdict)
    assert "RESIDUAL" in text
    assert "Vendor's death record begins" in text
    # Not a boolean. "Survivorship-free" is not a state this panel can
    # reach, so the output is the size of what remains missing.
    assert "still invisible" in verdict["verdict"]


# -- batching -------------------------------------------------------------


def test_acquire_batches_and_the_batches_join_back_into_one_table() -> None:
    names = [f"D{i:03d}" for i in range(7)]
    source = _Fund({t: _bars(t) for t in names})
    calls: list[int] = []

    def fake_open(plan: Any, **_kwargs: Any) -> Any:
        calls.append(len(tuple(plan)))
        return source

    original = de.open_pull_source
    de.open_pull_source = fake_open  # type: ignore[assignment]
    try:
        pull = de.acquire(
            names, asof=ASOF, batch=3, floor=0.0, sleep=lambda _s: None
        )
    finally:
        de.open_pull_source = original  # type: ignore[assignment]

    assert calls == [3, 3, 1]
    assert pull.attempted == 7
    assert len(pull.coverage) == 7
    assert list(pull.coverage["ticker"]) == sorted(names)


def test_a_hashed_id_collision_costs_the_batch_a_split_and_not_its_names() -> None:
    """The id space was sized for nine sleeve vehicles.

    sha256 truncated into ten million values collides at about
    n^2 / 2e7, which on the 1,677 names this plan actually holds is one
    run in seven — and it fired on the first attempt. Refusing the batch
    would lose 199 innocent histories to an accident of a hash.
    """
    names = [f"D{i:03d}" for i in range(4)]
    source = _Fund({t: _bars(t) for t in names})
    seen: list[tuple[str, ...]] = []

    def fake_open(plan: Any, **_kwargs: Any) -> Any:
        chunk = tuple(plan)
        seen.append(chunk)
        if len(chunk) == 4:
            raise ValueError(
                "synthesised permaticker 901368786 collides between 'DEWJ' "
                "and 'EMLB'"
            )
        return source

    original = de.open_pull_source
    de.open_pull_source = fake_open  # type: ignore[assignment]
    try:
        pull = de.acquire(
            names, asof=ASOF, batch=4, floor=0.0, sleep=lambda _s: None
        )
    finally:
        de.open_pull_source = original  # type: ignore[assignment]

    assert [len(c) for c in seen] == [4, 2, 2]
    assert pull.attempted == 4
    assert len(pull.coverage) == 4


# -- the source -----------------------------------------------------------


def test_the_wall_is_extended_and_not_taken_down() -> None:
    source = de.open_pull_source(["ZOMB", "KOL"])
    assert source.allowed_tickers == ("KOL", "ZOMB")
    with pytest.raises(TickerNotAllowed):
        source.require_allowed("AAPL")


def test_an_empty_plan_is_refused_rather_than_pulled() -> None:
    with pytest.raises(ValueError):
        de.open_pull_source([])
    with pytest.raises(ValueError):
        de.acquire([])


def test_the_cache_entry_is_pinned_to_the_asof_and_not_to_this_afternoon(
    tmp_path: Any,
) -> None:
    """A fund whose last bar printed in 2013 cannot gain one tomorrow.

    The parent keys a ticker's entry on the day the pull ran through,
    which is right for a live fund and turns a day of careful, metered,
    polite fetching into work that expires at midnight. Pinning makes
    the entry say what it is: this fund's whole history.
    """
    handler = _tiingo_handler({"ZOMB": [_tiingo_bar("2013-09-20", 12.0)]})
    cache = ParquetCache(tmp_path)
    source = de.open_pull_source(
        ["ZOMB"],
        cache=cache,
        horizon=date(2020, 1, 2),
        session=_Session(handler),
        sleep=lambda _s: None,
    )
    source.prices(
        date(1990, 1, 1), ASOF, permatickers=[source.permaticker_for("ZOMB")]
    )
    stamps = {
        json.loads(p.read_text("utf-8")).get("params", {}).get("end")
        for p in (tmp_path / "tiingo-sleeve-etf").glob("*.json")
    }
    assert "2020-01-02" in stamps
    assert ASOF.isoformat() not in stamps


# -- a stand-in for the vendor's own endpoint -----------------------------


class _Response:
    def __init__(self, status: int = 200, payload: Any = None) -> None:
        self.status_code = status
        self._payload = payload
        self.content = b""
        self.text = ""

    def json(self) -> Any:
        return self._payload


class _Session:
    def __init__(self, handler: Callable[..., _Response]) -> None:
        self._handler = handler

    def get(
        self,
        url: str,
        params: dict | None = None,
        headers: dict | None = None,
        timeout: float | None = None,
    ) -> _Response:
        return self._handler(url, dict(params or {}), dict(headers or {}))


def _tiingo_bar(day: str, close: float, *, volume: float = 1e6) -> dict:
    return {
        "date": f"{day}T00:00:00.000Z",
        "open": close - 1.0,
        "high": close + 1.0,
        "low": close - 2.0,
        "close": close,
        "volume": volume,
        "adjClose": close,
        "divCash": 0.0,
        "splitFactor": 1.0,
    }


def _tiingo_handler(bars: dict[str, list[dict]]) -> Callable[..., _Response]:
    def handler(url: str, params: dict, headers: dict) -> _Response:
        parts = url.rstrip("/").split("/")
        symbol = parts[-2] if url.endswith("/prices") else parts[-1]
        if url.endswith("/prices"):
            return _Response(200, bars.get(symbol, []))
        return _Response(
            200,
            {
                "ticker": symbol,
                "name": f"{symbol} FUND",
                "exchangeCode": "NYSE ARCA",
                "startDate": "2006-05-01",
                "endDate": "2013-09-20",
            },
        )

    return handler
