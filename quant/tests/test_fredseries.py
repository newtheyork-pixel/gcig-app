"""The macro catalogue, exercised without a network and without a key.

FRED is the easiest source in this repository to read and the easiest to
be quietly wrong about, because every one of its failures produces a
clean daily column of plausible numbers. So the tests here are not about
parsing CSV. They are about the four ways a well-formed FRED pull lies.

**A monthly observation is stamped on the FIRST day of its month.** Add
a two-week publication lag to that stamp and December's CPI becomes
knowable on 15 December — a fortnight before the month it measures has
ended. The arithmetic is right, the dtypes are right, the series looks
perfect, and the backtest is reading the future. Four tests hold the
line between a stamp and a period end.

**The lag is the whole subject, so it cannot have a default.** A default
is the one form of a publication lag that can be forgotten, and a
forgotten lag is indistinguishable from no lag at all. `as_of` refuses
to run without one, refuses a float, refuses None, and refuses a
negative number — which is what lookahead looks like when it is typed
out honestly.

**An outage is not a quiet regime.** A macro overlay handed an empty
series does not fail; it flattens, and a flat overlay reads as a calm
market. Every unreachable path raises. A 404 keeps a type of its own,
because "there is no such series" is an answer and sending somebody to
check the network for a typo wastes the afternoon.

**ALFRED's column is not named for the series.** A vintage pull comes
back as `CPIAUCSL_20200115`, so a reader keyed on the bare id finds
nothing and hands back an empty frame — seventy years reduced to zero
rows with no error anywhere. That one is pinned against the real parser
with the socket taken out, because it is the widening this module asked
of `tbill.py` and the failure is silent.

Two facts about the world are also pinned, deliberately, as tests. The
ICE credit series lost their history — pulled on 2026-08-02 they start
in August 2023, not 1996 — and TEDRATE is dead. Both are the kind of
thing somebody corrects back from memory a year later, and both are
measurements rather than opinions.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from typing import Any

import numpy as np
import pandas as pd
import pytest

from griffinquant.data import fredseries as fs
from griffinquant.data import tbill
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.fredseries import (
    CATALOGUE,
    CATALOGUE_LAG,
    FredUnavailable,
    UnknownSeries,
)
from griffinquant.data.tbill import ALFRED_CSV, FRED_CSV, FredNotPublished

CLOCK = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)
TODAY = CLOCK.date()


def _no_sleep(_seconds: float) -> None:
    return None


@pytest.fixture(autouse=True)
def _reset_pacer(monkeypatch):
    """Politeness is process-wide state; determinism is per test.

    `_pace` remembers the last request across the whole process on
    purpose — a rate limit does not reset because a new object was
    constructed. That makes it the one piece of module state a test has
    to clear, or the first call in a test inherits the previous one's
    clock and the pacing assertions become order-dependent.
    """
    monkeypatch.setattr(fs, "_last_request", float("-inf"), raising=False)


# -- fakes ----------------------------------------------------------------


def _frame(dates: list[str], values: list[float]) -> pd.DataFrame:
    return pd.DataFrame(
        {"date": pd.to_datetime(dates), "value": np.asarray(values, dtype="float64")}
    )


#: Six months of a monthly index, stamped the way FRED stamps one: on
#: the first of the month it measures, not the last.
CPI = _frame(
    [
        "2019-09-01",
        "2019-10-01",
        "2019-11-01",
        "2019-12-01",
        "2020-01-01",
        "2020-02-01",
    ],
    [256.4, 257.3, 257.9, 258.5, 258.8, 259.1],
)

#: Weekly claims, stamped on the week-ending Saturday.
CLAIMS = _frame(
    ["2020-03-07", "2020-03-14", "2020-03-21", "2020-03-28"],
    [211_000, 282_000, 3_307_000, 6_867_000],
)


class _Fetcher:
    """Stands in for `tbill.fetch_observations`, recording every call.

    Keyed on the series and, for an archive request, on the vintage —
    which is also how the test asserts that a vintage pull really did
    go to ALFRED with a vintage_date rather than to the live endpoint
    with a narrower window.
    """

    def __init__(self, payloads: dict[Any, Any]) -> None:
        self._payloads = payloads
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        series_id: str,
        start: date,
        end: date,
        *,
        timeout: int = 30,
        base: str = FRED_CSV,
        extra_params: dict[str, Any] | None = None,
        value_column: str | None = None,
    ) -> pd.DataFrame:
        vintage = (extra_params or {}).get("vintage_date")
        self.calls.append(
            {
                "series": series_id,
                "start": start,
                "end": end,
                "base": base,
                "vintage": vintage,
            }
        )
        key = (series_id, vintage) if vintage else series_id
        payload = self._payloads[key]
        if isinstance(payload, Exception):
            raise payload
        return payload.copy()


def _pull(series_id: str, payloads: dict[Any, Any], **kwargs: Any):
    fetcher = _Fetcher(payloads)
    return fs.fetch_series(
        series_id,
        today=TODAY,
        fetcher=fetcher,
        sleep=_no_sleep,
        clock=lambda: CLOCK,
        **kwargs,
    ), fetcher


# -- the shared reader, widened for ALFRED --------------------------------


class _Body:
    def __init__(self, text: str) -> None:
        self._text = text

    def read(self) -> bytes:
        return self._text.encode("utf-8")

    def __enter__(self) -> "_Body":
        return self

    def __exit__(self, *_exc: Any) -> None:
        return None


def test_an_alfred_vintage_column_is_read_despite_its_name(monkeypatch):
    """ALFRED names the column for the vintage, not for the series.

    `CPIAUCSL_20200115`. A reader keyed on the bare id matches nothing,
    drops every row, and returns an empty frame — which is a seventy-
    year history reduced to zero with no exception raised anywhere. The
    fallback is safe because it is not a guess: one date column and one
    value column is the entire shape of this CSV.
    """
    csv = (
        "observation_date,CPIAUCSL_20200115\n"
        "2019-11-01,257.936\n"
        "2019-12-01,258.501\n"
    )
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda req, timeout=None: _Body(csv)
    )
    out = tbill.fetch_observations(
        "CPIAUCSL",
        date(2019, 9, 1),
        date(2020, 1, 15),
        base=ALFRED_CSV,
        extra_params={"vintage_date": "2020-01-15"},
    )
    assert len(out) == 2
    assert out["value"].tolist() == [257.936, 258.501]


def test_a_csv_holding_several_series_is_refused(monkeypatch):
    """One id per request, and the reason is not tidiness.

    FRED's graph endpoint accepts a comma-separated list and then
    silently ignores cosd and coed, handing back every observation it
    has for the longest series. Picking a column here would make that
    look like a successful narrow pull.
    """
    csv = "observation_date,DGS2,DGS10\n2024-01-02,4.33,3.95\n"
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda req, timeout=None: _Body(csv)
    )
    with pytest.raises(tbill.TbillUnavailable, match="one id per request"):
        tbill.fetch_observations("DGS2X", date(2024, 1, 1), date(2024, 1, 3))


def test_a_404_is_an_answer_and_keeps_its_own_type(monkeypatch):
    """"No such series" is not "FRED is down".

    They arrive at the same handler and mean opposite things: one is a
    typo in an argument, the other is an outage. Collapsing them sends
    somebody to check the network for a spelling mistake.
    """

    def dead(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(urllib.request, "urlopen", dead)
    with pytest.raises(FredNotPublished, match="an answer rather than an outage"):
        tbill.fetch_observations("NOTASERIES", date(2020, 1, 1), date(2020, 2, 1))


def test_an_outage_raises_rather_than_returning_an_empty_series():
    """A flat macro overlay reads as a calm market, not as a broken pull."""
    boom = tbill.TbillUnavailable("could not read CPIAUCSL from FRED: timed out.")
    with pytest.raises(FredUnavailable, match="NOT an empty series"):
        _pull("CPIAUCSL", {"CPIAUCSL": boom})

    # And it is catchable as the project's own outage type, so a caller
    # of any data source handles it without importing this module.
    with pytest.raises(SourceUnavailable):
        _pull("CPIAUCSL", {"CPIAUCSL": boom})


def test_a_missing_series_stays_a_missing_series_through_the_module():
    """The 404 type survives the re-typing at the boundary."""
    gone = FredNotPublished("FRED has no series 'CPIAUCSL' at that vintage")
    with pytest.raises(FredNotPublished):
        _pull("CPIAUCSL", {"CPIAUCSL": gone})


# -- the catalogue --------------------------------------------------------


def test_every_catalogue_row_answers_the_questions_it_promises():
    """A row without a lag note is a row somebody will trust blindly."""
    for key, spec in CATALOGUE.items():
        assert key == spec.series_id
        assert spec.group in fs.GROUPS
        assert spec.question.strip(), f"{key} has no question"
        assert spec.lag_note.strip(), f"{key} has no lag note"
        assert spec.revision_note.strip(), f"{key} has no revision note"
        assert spec.licence in fs.LICENCE_URLS
        assert spec.release_lag_days >= 0
        assert spec.start < TODAY


def test_an_uncurated_id_is_refused_by_name():
    """FRED would serve GDP happily, and that is precisely the problem.

    An id with no recorded lag and no recorded revision behaviour is a
    point-in-time bug wearing a tidy column of numbers.
    """
    with pytest.raises(UnknownSeries, match="not in this catalogue"):
        fs.series("GDP")


def test_a_dead_series_stays_on_the_shelf():
    """TEDRATE is in the catalogue BECAUSE it died.

    A list of only living ids teaches the reader that ids do not die,
    and the next person builds a live feature on one that froze in 2022.
    """
    ted = fs.series("TEDRATE")
    assert ted.discontinued_on == date(2022, 1, 21)
    assert "DEAD" in ted.notes
    assert "LIBOR" in ted.notes


def test_the_credit_history_that_was_withdrawn_is_declared():
    """Measured on 2026-08-02: the ICE spreads start in August 2023.

    The indices are documented back to 1996 and FRED served that history
    for years; asking explicitly for 2008 now returns the same 787 rows
    beginning 2023-08-01. Pinned as a test because it is a measurement,
    and because the obvious "fix" a year from now is to correct the
    start date back to 1996 from memory and hand a credit study three
    years of data it thinks are thirty.
    """
    for sid in ("BAMLH0A0HYM2", "BAMLC0A0CM"):
        spec = fs.series(sid)
        assert spec.start >= date(2023, 1, 1)
        assert spec.licence == "pre_approval_required"
        assert not spec.redistributable

    # And the long-history stand-in is present, with the warning that
    # its level is not the ICE level.
    baa = fs.series("BAA10Y")
    assert baa.start.year == 1986
    assert "NOT an option-adjusted spread" in baa.notes


def test_the_catalogue_table_carries_the_terms_it_was_served_under():
    frame = fs.catalogue_frame()
    assert len(frame) == len(CATALOGUE)
    ice = frame.loc[frame["series_id"] == "BAMLH0A0HYM2"].iloc[0]
    assert not bool(ice["redistributable"])
    assert frame["question"].str.len().min() > 0


def test_describe_names_the_licence_url():
    text = fs.describe("VIXCLS")
    assert "citation_required" in text
    assert fs.LICENCE_URLS["citation_required"] in text


# -- a stamp is not a period end ------------------------------------------


def test_a_monthly_stamp_is_the_start_of_its_period():
    """The single most expensive line in the file, tested directly.

    FRED stamps December's CPI 2019-12-01. Adding sixteen days to the
    stamp puts publication on 17 December, a fortnight before the month
    it measures has finished.
    """
    cpi = fs.series("CPIAUCSL")
    assert cpi.period_end("2019-12-01") == pd.Timestamp("2019-12-31")
    assert cpi.knowable_on("2019-12-01", 16) == pd.Timestamp("2020-01-16")


def test_a_weekly_stamp_is_already_the_period_end():
    """ICSA is stamped on the week-ending Saturday; NFCI on the Friday.

    Verified against the served data on 2026-08-02. Treating these like
    monthly stamps would push every weekly release a week early.
    """
    claims = fs.series("ICSA")
    assert claims.period_end("2020-03-21") == pd.Timestamp("2020-03-21")
    assert claims.knowable_on("2020-03-21", 7) == pd.Timestamp("2020-03-28")


def test_december_cpi_is_not_knowable_in_december():
    """The sentence the whole module exists to make true."""
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})

    inside = fs.as_of(
        "CPIAUCSL", "2019-12-20", lag_days=CATALOGUE_LAG, history=history
    )
    assert inside is not None
    assert inside.period == pd.Timestamp("2019-11-01")

    after = fs.as_of(
        "CPIAUCSL", "2020-01-16", lag_days=CATALOGUE_LAG, history=history
    )
    assert after.period == pd.Timestamp("2019-12-01")
    assert after.published_on == pd.Timestamp("2020-01-16")


def test_the_observation_reports_how_old_the_fact_is():
    """Not how recently it was printed — how old the world it describes is."""
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    obs = fs.as_of("CPIAUCSL", "2020-01-31", lag_days=16, history=history)
    assert obs.period_end == pd.Timestamp("2019-12-31")
    assert obs.staleness_days == 31


def test_as_of_never_reaches_past_its_own_publication_date():
    """Swept over every day in the window rather than spot-checked.

    A lag bug that is right at the boundary and wrong in the middle is
    the kind that survives three examples.
    """
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    for day in pd.date_range("2019-09-01", "2020-04-01", freq="D"):
        obs = fs.as_of("CPIAUCSL", day, lag_days=16, history=history)
        if obs is None:
            continue
        assert obs.published_on <= day
        assert obs.period_end + pd.Timedelta(days=16) == obs.published_on


def test_nothing_knowable_yet_is_none_and_not_the_earliest_value():
    """Silently reaching back is how a 1990 backtest holds a 2003 number."""
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    assert fs.as_of("CPIAUCSL", "2019-10-01", lag_days=16, history=history) is None


# -- the lag is required --------------------------------------------------


def test_as_of_will_not_run_without_a_stated_lag():
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    with pytest.raises(TypeError):
        fs.as_of("CPIAUCSL", "2020-01-20", history=history)  # type: ignore[call-arg]


@pytest.mark.parametrize("bad", [None, 16.0, "soon", True])
def test_a_vague_lag_is_refused(bad):
    """None, a float, a word and a bool all mean "I did not decide"."""
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    with pytest.raises((TypeError, ValueError)):
        fs.as_of("CPIAUCSL", "2020-01-20", lag_days=bad, history=history)


def test_a_negative_lag_is_refused_as_lookahead_typed_out():
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    with pytest.raises(ValueError, match="reads the future"):
        fs.as_of("CPIAUCSL", "2020-01-20", lag_days=-3, history=history)


def test_the_catalogue_sentinel_resolves_to_the_documented_number():
    """Explicit at the call site, and still only written down once."""
    assert fs.resolve_lag(fs.series("PAYEMS"), CATALOGUE_LAG) == 11
    assert fs.resolve_lag(fs.series("PAYEMS"), 3) == 3


def test_a_series_row_cannot_carry_a_negative_lag():
    with pytest.raises(ValueError, match="indistinguishable"):
        fs.FredSeries(
            series_id="X",
            title="t",
            group="rates",
            frequency="daily",
            units="u",
            start=date(2000, 1, 1),
            release_lag_days=-1,
            revision="none",
            question="q",
            lag_note="l",
            revision_note="r",
            licence="public_domain",
        )


# -- alignment ------------------------------------------------------------


def test_available_history_stops_at_what_had_been_published():
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    known = fs.available_history(
        "CPIAUCSL", "2020-01-20", lag_days=16, history=history
    )
    assert list(known.index) == [
        pd.Timestamp("2019-09-01"),
        pd.Timestamp("2019-10-01"),
        pd.Timestamp("2019-11-01"),
        pd.Timestamp("2019-12-01"),
    ]


def test_on_calendar_does_not_backfill():
    """A window opening before the series does must look empty, not flat."""
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    cal = pd.bdate_range("2019-09-02", "2019-12-31")
    aligned = fs.on_calendar("CPIAUCSL", cal, lag_days=16, history=history)
    # September's index is published on 2019-10-16; nothing before it.
    assert aligned.loc[: pd.Timestamp("2019-10-15")].isna().all()
    assert aligned.loc[pd.Timestamp("2019-10-16")] == 256.4


def test_on_calendar_holds_the_last_known_figure_and_steps_on_release():
    """Forward-filling is the state of knowledge; interpolation is not.

    A monthly figure holds its level until the next release because that
    IS what a reader knew. Sliding it toward the next print would use a
    number nobody had.
    """
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    cal = pd.bdate_range("2020-01-10", "2020-01-22")
    aligned = fs.on_calendar("CPIAUCSL", cal, lag_days=16, history=history)
    before = aligned.loc[pd.Timestamp("2020-01-15")]
    after = aligned.loc[pd.Timestamp("2020-01-16")]
    assert before == 257.9  # November's index, still the freshest
    assert after == 258.5  # December lands on the 16th
    assert aligned.loc[pd.Timestamp("2020-01-22")] == 258.5


def test_two_observations_publishing_together_collapse_to_the_later_period():
    """Defensive, and the defence is worth having.

    FRED does not stamp two observations inside one month today. If it
    ever did, the alternatives are worse than they look: a duplicated
    publication date makes the reindex raise, and picking whichever row
    pandas reached first would silently quote a superseded period.
    """
    odd = _frame(["2019-12-01", "2019-12-15"], [258.5, 259.9])
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": odd})
    cal = pd.DatetimeIndex(["2020-01-20"])
    aligned = fs.on_calendar("CPIAUCSL", cal, lag_days=16, history=history)
    assert aligned.iloc[0] == 259.9


def test_a_weekly_series_aligns_on_the_week_it_was_released():
    """The step lands on the publication date, not on the week it covers.

    Claims for the week ending 21 March 2020 — the week the number went
    from 282,000 to 3.3 million — were not readable until the following
    Thursday. A series aligned on the week END rather than the release
    hands a strategy the largest print in the record five days early.
    """
    history, _ = _pull("ICSA", {"ICSA": CLAIMS})
    cal = pd.bdate_range("2020-03-25", "2020-04-03")
    aligned = fs.on_calendar("ICSA", cal, lag_days=CATALOGUE_LAG, history=history)
    assert aligned.loc[pd.Timestamp("2020-03-26")] == 282_000
    assert aligned.loc[pd.Timestamp("2020-03-27")] == 3_307_000
    assert aligned.loc[pd.Timestamp("2020-04-03")] == 6_867_000


def test_an_empty_calendar_is_an_empty_answer_not_a_crash():
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    out = fs.on_calendar(
        "CPIAUCSL", pd.DatetimeIndex([]), lag_days=16, history=history
    )
    assert out.empty


# -- caching --------------------------------------------------------------


def test_a_second_read_of_the_same_day_does_not_touch_the_network(tmp_path):
    """A source pulled twice is a source we were rude to twice."""
    cache = ParquetCache(tmp_path, ttl_days=fs.CACHE_TTL_DAYS)
    fetcher = _Fetcher({"CPIAUCSL": CPI})
    for _ in range(3):
        out = fs.fetch_series(
            "CPIAUCSL",
            cache=cache,
            today=TODAY,
            fetcher=fetcher,
            sleep=_no_sleep,
            clock=lambda: CLOCK,
        )
        assert len(out) == len(CPI)
    assert len(fetcher.calls) == 1


def test_an_outage_is_never_cached(tmp_path):
    """One throttled minute must not cost a week of missing rows."""
    cache = ParquetCache(tmp_path, ttl_days=fs.CACHE_TTL_DAYS)
    boom = tbill.TbillUnavailable("timed out")
    with pytest.raises(FredUnavailable):
        fs.fetch_series(
            "CPIAUCSL",
            cache=cache,
            today=TODAY,
            fetcher=_Fetcher({"CPIAUCSL": boom}),
            sleep=_no_sleep,
            clock=lambda: CLOCK,
        )
    assert cache.stats().entries == 0

    healed = fs.fetch_series(
        "CPIAUCSL",
        cache=cache,
        today=TODAY,
        fetcher=_Fetcher({"CPIAUCSL": CPI}),
        sleep=_no_sleep,
        clock=lambda: CLOCK,
    )
    assert len(healed) == len(CPI)


def test_the_whole_history_is_asked_for_once_rather_than_per_window():
    """Keying the cache on a window stores seventy years again per date."""
    _, fetcher = _pull("CPIAUCSL", {"CPIAUCSL": CPI})
    call = fetcher.calls[0]
    assert call["start"] == fs.HISTORY_START
    assert call["end"] == TODAY
    assert call["base"] == FRED_CSV


def test_a_failed_id_in_a_batch_stops_the_batch():
    """A dict quietly missing a key runs the overlay on five of six inputs."""
    payloads = {"CPIAUCSL": CPI, "ICSA": tbill.TbillUnavailable("dark")}
    with pytest.raises(FredUnavailable):
        fs.fetch_many(
            ["CPIAUCSL", "ICSA"],
            today=TODAY,
            fetcher=_Fetcher(payloads),
            sleep=_no_sleep,
            clock=lambda: CLOCK,
        )


def test_consecutive_pulls_are_paced():
    """FRED publishes no rate limit; that is not permission to hammer it."""
    waits: list[float] = []
    fetcher = _Fetcher({"CPIAUCSL": CPI, "ICSA": CLAIMS})
    fs.fetch_many(
        ["CPIAUCSL", "ICSA"],
        today=TODAY,
        fetcher=fetcher,
        sleep=waits.append,
        clock=lambda: CLOCK,
    )
    assert len(fetcher.calls) == 2
    # The first call has nothing to wait behind; the second does.
    assert len(waits) == 1
    assert 0 < waits[0] <= fs.MIN_REQUEST_INTERVAL_SECONDS


# -- the archive, which is the real fix -----------------------------------


def test_a_vintage_request_goes_to_alfred_and_names_the_morning():
    """The vintage is the point; a live pull with a short window is not."""
    archive = _frame(["2019-11-01", "2019-12-01"], [257.936, 258.501])
    fetcher = _Fetcher({("CPIAUCSL", "2020-01-15"): archive})
    out = fs.vintage(
        "CPIAUCSL",
        "2020-01-15",
        fetcher=fetcher,
        sleep=_no_sleep,
        clock=lambda: CLOCK,
    )
    call = fetcher.calls[0]
    assert call["base"] == ALFRED_CSV
    assert call["vintage"] == "2020-01-15"
    assert call["end"] == date(2020, 1, 15)
    assert out.iloc[-1] == 258.501


def test_the_audit_reports_a_lag_that_claims_too_much_as_positive():
    """Positive `periods_off` is lookahead, and it is the whole alarm.

    Here the rule says December's CPI was readable on 5 January; the
    archive for that morning carries November and nothing after it.
    """
    archive = _frame(["2019-10-01", "2019-11-01"], [257.3, 257.9])
    fetcher = _Fetcher({("CPIAUCSL", "2020-01-05"): archive})
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})

    audit = fs.lag_audit(
        "CPIAUCSL",
        ["2020-01-05"],
        lag_days=5,
        history=history,
        fetcher=fetcher,
        sleep=_no_sleep,
        clock=lambda: CLOCK,
    )
    row = audit.iloc[0]
    assert row["claimed_period"] == pd.Timestamp("2019-12-01")
    assert row["vintage_period"] == pd.Timestamp("2019-11-01")
    assert row["periods_off"] == 1.0


def test_the_audit_separates_a_revision_from_a_lag_error():
    """Two ways to be wrong, reported apart.

    A lag can be exactly right about which period was readable and still
    be reading a number that has been restated twice since.
    """
    archive = _frame(["2019-11-01", "2019-12-01"], [257.936, 258.501])
    fetcher = _Fetcher({("CPIAUCSL", "2020-01-20"): archive})
    history, _ = _pull("CPIAUCSL", {"CPIAUCSL": CPI})

    audit = fs.lag_audit(
        "CPIAUCSL",
        ["2020-01-20"],
        lag_days=16,
        history=history,
        fetcher=fetcher,
        sleep=_no_sleep,
        clock=lambda: CLOCK,
    )
    row = audit.iloc[0]
    assert row["periods_off"] == 0.0
    assert row["vintage_value"] == 258.501
    assert row["current_value"] == 258.5
    assert row["revised_by"] == pytest.approx(-0.001)


def test_the_honesty_notes_travel_with_the_numbers():
    """A claim that lives only in a docstring is a claim nobody reads."""
    assert "vintage" in fs.SURVIVORSHIP_NOTE
    assert "TEDRATE" in fs.SURVIVORSHIP_NOTE
    assert "vintage_date" in fs.ALFRED_NOTE
