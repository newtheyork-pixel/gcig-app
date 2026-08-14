"""The ETF universe, exercised without a key and without a network.

Nothing here touches Tiingo. The directory is built as a real zip in
memory and the price endpoint is a handler function, because a suite
that needed a token would only run on the machine that has one — which
is the same as not running.

Six things are on trial, and every one of them produces a clean,
well-typed frame when it goes wrong. That is what makes each worth a
test rather than a comment.

**The start dates.** Eighty-seven of these hundred and forty-two funds
list after 2005. A universe that carries the tickers and not the dates
lets a backtest begin in 2005, run to 2026, and silently be a nine-year
study of anything factor-shaped. `first_available` is recorded for
every name, `universe_as_of` answers which existed on a day, and
`late_arrivals` turns the column into a sentence somebody has to read.

**The allowlist is extended, not defeated.** A single name raises before
any HTTP happens, even though the same key would serve it and the
directory lists it. The wall moved outward by a hundred and thirty
funds and did not come down.

**An outage is never an empty answer.** An unreachable archive, a body
that is not a zip, a zip with no CSV, a CSV with a header and no rows —
all raise. Each would otherwise report that the vendor covers nothing,
which reads downstream as every ticker being unknown and no ETF having
ever closed.

**A symbol that means two things is a refusal.** Where the catalogue
holds two different securities under one ticker the resolver raises
rather than picking. Picking is the recycled-symbol graft `schema.py`
opens by describing, and the resulting series backtests beautifully.

**`assetType` is corroboration, not proof.** Tiingo files closed-end
funds and at least one operating company under ETF, so the test asserts
what the check actually buys: agreement between the vendor and a
hand-written list, not an identification.

**The survivorship probe must distinguish an unknown symbol from a dead
vendor.** Both arrive as a failed fetch and they mean opposite things.
A symbol the catalogue does not list is recorded absent with no call
made; a symbol it lists is fetched and any failure raises.
"""

from __future__ import annotations

import io
import zipfile
from datetime import date, datetime, timezone
from typing import Any, Callable

import pandas as pd
import pytest

from griffinquant.data import etfuniverse as eu
from griffinquant.data import keyedsleeves, schema
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.etfuniverse import (
    ABSENT,
    DECEASED,
    UNIVERSE,
    ETFUniverseSource,
    UniverseNotResolved,
)
from griffinquant.data.keyedsleeves import TIINGO_KEY_VAR
from griffinquant.data.sleevedata import TickerNotAllowed, synthetic_permaticker

CLOCK = datetime(2026, 8, 2, 17, 0, tzinfo=timezone.utc)
ASOF = CLOCK.date()


# -- stand-ins for the network -------------------------------------------


class _Response:
    def __init__(
        self, status: int = 200, payload: Any = None, content: bytes = b"", text: str = ""
    ) -> None:
        self.status_code = status
        self._payload = payload
        self.content = content
        self.text = text

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _Session:
    def __init__(self, handler: Callable[..., _Response]) -> None:
        self._handler = handler
        self.calls: list[tuple[str, dict, dict]] = []

    def get(
        self,
        url: str,
        params: dict | None = None,
        headers: dict | None = None,
        timeout: float | None = None,
    ) -> _Response:
        params = dict(params or {})
        headers = dict(headers or {})
        self.calls.append((url, params, headers))
        return self._handler(url, params, headers)


class _RefusingSession:
    """Fails the test if anything reaches it."""

    def get(self, *args: Any, **kwargs: Any) -> _Response:
        raise AssertionError("no HTTP call should have been made")


def _zip_of(csv_text: str, *, name: str = "supported_tickers.csv") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, csv_text)
    return buf.getvalue()


_HEADER = "ticker,exchange,assetType,priceCurrency,startDate,endDate\n"


def _directory_csv(rows: list[tuple[str, str, str, str, str, str]]) -> str:
    return _HEADER + "".join(",".join(r) + "\n" for r in rows)


#: A catalogue small enough to read and shaped like the real one: two
#: live funds, one dead one, a single name, a foreign line, an OTC husk
#: and a closed-end fund the vendor types ETF.
_ROWS: list[tuple[str, str, str, str, str, str]] = [
    ("SPY", "NYSE", "ETF", "USD", "1993-01-29", "2026-07-31"),
    ("MTUM", "BATS", "ETF", "USD", "2013-04-18", "2026-07-31"),
    ("RSX", "BATS", "ETF", "USD", "2007-04-30", "2023-01-13"),
    ("AAPL", "NASDAQ", "Stock", "USD", "1980-12-12", "2026-07-31"),
    ("HUSK", "PINK", "ETF", "USD", "2009-01-02", "2015-06-30"),
    ("FOREIGN", "SHG", "ETF", "CNY", "2015-01-02", "2026-07-31"),
    # A closed-end fund typed ETF, which is the real file's habit and
    # the reason the asset-type check is corroboration and not proof.
    ("JEQ", "NYSE", "ETF", "USD", "1992-08-14", "2025-10-10"),
]


def _directory(rows: list[tuple[str, str, str, str, str, str]] | None = None) -> pd.DataFrame:
    body = _zip_of(_directory_csv(rows if rows is not None else _ROWS))
    session = _Session(lambda *a, **k: _Response(200, content=body))
    return eu.fetch_directory(session=session, sleep=lambda _s: None)


def _tiingo_bar(day: str, close: float, adj: float, *, volume: float = 1e6) -> dict:
    return {
        "date": f"{day}T00:00:00.000Z",
        "open": close - 1.0,
        "high": close + 1.0,
        "low": close - 2.0,
        "close": close,
        "volume": volume,
        "adjClose": adj,
        "divCash": 0.0,
        "splitFactor": 1.0,
    }


def _price_handler(
    bars_by_symbol: dict[str, list[dict]],
) -> Callable[..., _Response]:
    def handler(url: str, params: dict, headers: dict) -> _Response:
        symbol = url.rstrip("/").split("/")[-2 if url.endswith("/prices") else -1]
        if url.endswith("/prices"):
            return _Response(200, bars_by_symbol.get(symbol, []))
        return _Response(
            200,
            {
                "ticker": symbol,
                "name": f"{symbol} FUND  ",
                "exchangeCode": "NYSE ARCA",
                "startDate": "2000-01-03",
                "endDate": ASOF.isoformat(),
            },
        )

    return handler


def _source(
    handler: Callable[..., _Response] | None = None,
    *,
    allowed: tuple[str, ...] = ("SPY", "MTUM"),
    directory: pd.DataFrame | None = None,
    fetch_names: bool = True,
    cache: ParquetCache | None = None,
) -> tuple[ETFUniverseSource, Any]:
    session: Any = _Session(handler) if handler else _RefusingSession()
    src = ETFUniverseSource(
        allowed=allowed,
        directory=directory,
        fetch_names=fetch_names,
        cache=cache,
        session=session,
        sleep=lambda _s: None,
        clock=lambda: CLOCK,
    )
    return src, session


# -- the list itself ------------------------------------------------------


def test_the_universe_is_the_size_it_claims_and_carries_no_duplicates() -> None:
    assert 80 <= len(UNIVERSE) <= 150
    tickers = [e.ticker for e in UNIVERSE]
    assert len(set(tickers)) == len(tickers)
    assert all(t == t.strip().upper() for t in tickers)


def test_every_declared_group_actually_has_funds_in_it() -> None:
    """A group with no members is a shelf label on an empty shelf.

    It reads in a report as a covered exposure and produces no rows, so
    the absence surfaces as a sleeve that never trades rather than as a
    universe that never had it.
    """
    present = {e.group for e in UNIVERSE}
    assert present == set(eu.GROUPS)


def test_the_dead_are_kept_apart_from_the_living() -> None:
    """A closed fund in the live panel widens the cross-section for free.

    Every screen holds it at zero weight, so it never trades and never
    shows up as a position — while still being counted in any breadth,
    dispersion or correlation figure computed across the universe.
    """
    assert not (eu.UNIVERSE_TICKERS & eu.DECEASED_TICKERS)
    assert eu.UNIVERSE_WITH_DECEASED == eu.UNIVERSE_TICKERS | eu.DECEASED_TICKERS
    assert len(DECEASED) >= 10


def test_the_absent_list_names_nothing_the_universe_asks_for() -> None:
    absent = {a.ticker for a in ABSENT}
    assert not (absent & eu.UNIVERSE_WITH_DECEASED)
    # Renames must say where the history went, or the note is a shrug.
    assert all(a.successor for a in ABSENT if a.fate == "renamed")
    assert all(a.successor is None for a in ABSENT if a.fate == "closed")


def test_every_rename_successor_is_a_ticker_we_actually_hold_or_name() -> None:
    """The rename note only means something if the successor is reachable.

    RYT is absent and RSPT carries its bars. Saying the first half
    without the second is a curiosity; saying both is the warning that
    every symbol in this file is TODAY's name for a series.
    """
    successors = {a.successor for a in ABSENT if a.fate == "renamed"}
    held = successors & eu.UNIVERSE_TICKERS
    assert held, f"no renamed successor is in the universe: {successors}"


# -- the directory --------------------------------------------------------


def test_the_directory_parses_into_the_columns_everything_else_reads() -> None:
    d = _directory()
    assert list(d.columns) == [
        "ticker",
        "exchange",
        "asset_type",
        "currency",
        "start_date",
        "end_date",
    ]
    assert str(d["start_date"].dtype).startswith("datetime64")
    spy = d.loc[d["ticker"] == "SPY"].iloc[0]
    assert spy["start_date"] == pd.Timestamp("1993-01-29")
    # Venue strings are normalised onto config.ALLOWED_EXCHANGES.
    assert set(d["exchange"]) >= {"NYSE", "NASDAQ", "BATS"}


@pytest.mark.parametrize(
    "response",
    [
        _Response(503, text="down"),
        _Response(200, content=b"<html>not a zip</html>"),
        _Response(200, content=_zip_of("nothing here", name="readme.txt")),
        _Response(200, content=_zip_of(_HEADER)),
        _Response(200, content=_zip_of("a,b,c\n1,2,3\n")),
    ],
    ids=["http-503", "not-a-zip", "no-csv", "header-only", "wrong-columns"],
)
def test_an_unreachable_or_unreadable_catalogue_raises(response: _Response) -> None:
    """Five ways to get nothing, and not one of them is an empty shelf.

    A catalogue reported as empty makes `resolve_universe` declare all
    142 tickers unknown to the vendor and `directory_survivorship`
    report that no ETF has ever closed. Both are conclusions about the
    world, drawn from an outage.
    """
    session = _Session(lambda *a, **k: response)
    with pytest.raises(SourceUnavailable):
        eu.fetch_directory(session=session, sleep=lambda _s: None)


def test_the_catalogue_is_fetched_once_and_read_from_disk_after(
    tmp_path: Any,
) -> None:
    cache = ParquetCache(tmp_path)
    body = _zip_of(_directory_csv(_ROWS))
    session = _Session(lambda *a, **k: _Response(200, content=body))

    first = eu.fetch_directory(
        cache=cache, session=session, sleep=lambda _s: None, clock=lambda: CLOCK
    )
    second = eu.fetch_directory(
        cache=cache,
        session=_RefusingSession(),
        sleep=lambda _s: None,
        clock=lambda: CLOCK,
    )
    assert len(session.calls) == 1
    pd.testing.assert_frame_equal(first, second)


def test_survivorship_is_measured_off_the_shelf_we_would_shop_from() -> None:
    """OTC husks and foreign lines are not part of the retention figure.

    Counting them would inflate both sides of a ratio that exists to say
    how much of the tradable dead the vendor keeps.
    """
    stats = eu.directory_survivorship(_directory(), asof=ASOF)
    # SPY, MTUM, RSX, JEQ. Not AAPL (a stock), not HUSK (PINK), not the
    # CNY line.
    assert stats["etf_rows"] == 4
    assert stats["ended"] == 2  # RSX and JEQ
    assert stats["still_listed"] == 2
    assert stats["share_ended"] == pytest.approx(0.5)


# -- resolving ------------------------------------------------------------


def test_resolve_records_the_first_available_date_for_every_ticker() -> None:
    """The column the whole file exists to produce.

    Without it a panel of today's tickers hands a 2005-2026 backtest a
    factor sleeve that is really nine years long, and nothing anywhere
    downstream can notice.
    """
    entries = (eu.Etf("SPY", eu.GROUP_BROAD_US), eu.Etf("MTUM", eu.GROUP_FACTOR))
    out = eu.resolve_universe(_directory(), entries, asof=ASOF)

    assert set(out["ticker"]) == {"SPY", "MTUM"}
    assert out["first_available"].notna().all()
    mtum = out.loc[out["ticker"] == "MTUM"].iloc[0]
    assert mtum["first_available"] == pd.Timestamp("2013-04-18")
    assert bool(mtum["still_listed"]) is True


def test_a_fund_whose_tape_stopped_is_not_reported_as_listed() -> None:
    entries = (eu.Etf("RSX", eu.GROUP_INTERNATIONAL),)
    out = eu.resolve_universe(_directory(), entries, asof=ASOF)
    row = out.iloc[0]
    assert row["last_available"] == pd.Timestamp("2023-01-13")
    assert bool(row["still_listed"]) is False


@pytest.mark.parametrize(
    "entry,fragment",
    [
        (eu.Etf("NOSUCH", eu.GROUP_BROAD_US), "not in the directory"),
        (eu.Etf("AAPL", eu.GROUP_BROAD_US), "ETFs only"),
        (eu.Etf("FOREIGN", eu.GROUP_INTERNATIONAL), "currency bet"),
        (eu.Etf("HUSK", eu.GROUP_BROAD_US), "fills are not real"),
    ],
    ids=["absent", "single-name", "foreign-currency", "otc-venue"],
)
def test_a_ticker_that_does_not_check_out_raises_rather_than_disappearing(
    entry: eu.Etf, fragment: str
) -> None:
    """A filtered-down universe is a smaller cross-section nobody chose.

    The name would leave the panel without leaving anything that reads
    the panel, and a missing fund arrives downstream as a slightly
    cleaner result rather than as a problem.
    """
    with pytest.raises(UniverseNotResolved) as exc:
        eu.resolve_universe(_directory(), (entry,), asof=ASOF)
    assert fragment in str(exc.value)


def test_every_bad_ticker_is_named_in_one_raise() -> None:
    """Four typos should cost one run, not four."""
    entries = (
        eu.Etf("NOSUCH", eu.GROUP_BROAD_US),
        eu.Etf("AAPL", eu.GROUP_BROAD_US),
        eu.Etf("SPY", eu.GROUP_BROAD_US),
    )
    with pytest.raises(UniverseNotResolved) as exc:
        eu.resolve_universe(_directory(), entries, asof=ASOF)
    message = str(exc.value)
    assert "NOSUCH" in message and "AAPL" in message
    assert "2 of 3" in message


def test_one_symbol_holding_two_securities_is_refused_not_picked() -> None:
    """The graft in `schema.py`'s opening paragraph, caught at the door.

    Two histories under one string, joined on the string, produce a
    series that fell 99% and recovered. Choosing between them quietly is
    how that happens; choosing by hand and pinning the choice is the
    only safe version.
    """
    rows = _ROWS + [("SPY", "NASDAQ", "ETF", "USD", "1970-01-02", "1990-12-31")]
    with pytest.raises(UniverseNotResolved) as exc:
        eu.resolve_universe(
            _directory(rows), (eu.Etf("SPY", eu.GROUP_BROAD_US),), asof=ASOF
        )
    assert "2 different securities" in str(exc.value)


def test_identical_duplicate_rows_are_not_treated_as_a_conflict() -> None:
    """The real catalogue repeats some rows verbatim — SLYV is one.

    A repeat says nothing about the security; only a disagreement does.
    """
    rows = _ROWS + [("SPY", "NYSE", "ETF", "USD", "1993-01-29", "2026-07-31")]
    out = eu.resolve_universe(
        _directory(rows), (eu.Etf("SPY", eu.GROUP_BROAD_US),), asof=ASOF
    )
    assert len(out) == 1


def test_an_empty_directory_raises_rather_than_failing_every_ticker() -> None:
    empty = _directory().iloc[0:0]
    with pytest.raises(UniverseNotResolved, match="our outage"):
        eu.resolve_universe(empty, UNIVERSE, asof=ASOF)


def test_the_asset_type_check_buys_agreement_and_not_identification() -> None:
    """JEQ is a closed-end fund and the vendor types it ETF.

    So passing this check is the vendor and the hand-written list
    agreeing, nothing more. The identification lives in the list, which
    is why `UNIVERSE` is written by hand and not swept out of the
    catalogue with a filter.
    """
    out = eu.resolve_universe(
        _directory(), (eu.Etf("JEQ", eu.GROUP_INTERNATIONAL),), asof=ASOF
    )
    assert out.iloc[0]["asset_type"] == "ETF"
    assert "JEQ" not in eu.UNIVERSE_WITH_DECEASED


# -- the dates, used --------------------------------------------------------


def test_universe_as_of_excludes_funds_that_did_not_exist_yet() -> None:
    """A rebalance reaching for MTUM in 2008 is not a gap to forward-fill.

    It is a trade in a fund that would not exist for five more years,
    and the only defence is asking before the weights are computed.
    """
    entries = (eu.Etf("SPY", eu.GROUP_BROAD_US), eu.Etf("MTUM", eu.GROUP_FACTOR))
    out = eu.resolve_universe(_directory(), entries, asof=ASOF)

    assert eu.universe_as_of(out, date(2008, 6, 30)) == ("SPY",)
    assert eu.universe_as_of(out, date(2020, 6, 30)) == ("MTUM", "SPY")


def test_universe_as_of_also_drops_funds_that_have_already_closed() -> None:
    entries = (eu.Etf("SPY", eu.GROUP_BROAD_US), eu.Etf("RSX", eu.GROUP_INTERNATIONAL))
    out = eu.resolve_universe(_directory(), entries, asof=ASOF)

    assert eu.universe_as_of(out, date(2015, 6, 30)) == ("RSX", "SPY")
    assert eu.universe_as_of(out, date(2025, 6, 30)) == ("SPY",)


def test_late_arrivals_names_the_funds_a_stated_start_would_invent() -> None:
    entries = (eu.Etf("SPY", eu.GROUP_BROAD_US), eu.Etf("MTUM", eu.GROUP_FACTOR))
    out = eu.resolve_universe(_directory(), entries, asof=ASOF)

    late = eu.late_arrivals(out, date(2005, 1, 1))
    assert list(late["ticker"]) == ["MTUM"]
    # Roughly eight and a half years of a window it cannot cover.
    assert int(late.iloc[0]["missing_days"]) == 3029


def test_a_fund_with_no_known_start_sorts_above_the_biggest_measured_hole() -> None:
    """An unmeasured gap is not a small gap, and pandas disagrees.

    `missing_days` is NA for a fund whose coverage start the catalogue
    never gave, and the default sort files NA last — at the bottom of a
    worst-first table, beside the funds that barely miss the window.
    That reads as the mildest case when it is the only one nobody has
    measured.
    """
    rows = [
        ("SPY", "NYSE", "ETF", "USD", "1993-01-29", "2026-07-31"),
        ("MTUM", "BATS", "ETF", "USD", "2013-04-18", "2026-07-31"),
        ("MYSTERY", "NYSE", "ETF", "USD", "", "2026-07-31"),
    ]
    entries = (
        eu.Etf("SPY", eu.GROUP_BROAD_US),
        eu.Etf("MTUM", eu.GROUP_FACTOR),
        eu.Etf("MYSTERY", eu.GROUP_BROAD_US),
    )
    out = eu.resolve_universe(_directory(rows), entries, asof=ASOF)
    late = eu.late_arrivals(out, date(2005, 1, 1))

    assert list(late["ticker"]) == ["MYSTERY", "MTUM"]
    assert pd.isna(late.iloc[0]["missing_days"])
    # And it is never counted as tradable on a day it cannot be shown
    # to have existed.
    assert "MYSTERY" not in eu.universe_as_of(out, date(2020, 6, 30))


def test_the_whole_shipped_list_resolves_against_a_well_formed_catalogue() -> None:
    """Every one of the 142, end to end, with no network anywhere.

    The live check happens against Tiingo and cannot run here. What can
    run is the rest of it: that no entry in the shipped list is
    misspelled into an empty string, duplicated, filed under a group
    that does not exist, or otherwise unable to survive the resolver.
    A typo caught here costs a second; caught in a pull it costs an
    hour of somebody else's rate limit.
    """
    rows = [
        (t, "NYSE", "ETF", "USD", "2010-01-04", "2026-07-31")
        for t in sorted(eu.UNIVERSE_TICKERS)
    ]
    out = eu.resolve_universe(_directory(rows), UNIVERSE, asof=ASOF)
    assert len(out) == len(UNIVERSE)
    assert out["first_available"].notna().all()


def test_the_late_arrival_warning_fires_across_the_whole_shipped_list() -> None:
    """The finding stated as a test, so it cannot quietly stop being true.

    Against the real catalogue eighty-seven of these hundred and
    forty-two list after the 2005 sample start. The synthetic dates here
    are not that measurement — they are the guarantee that the machinery
    which produces it is wired to the shipped list rather than to a
    two-row fixture, so a future edit cannot leave a young universe
    reporting no late arrivals at all.
    """
    from griffinquant.config import SAMPLE_START

    rows = [
        (t, "NYSE", "ETF", "USD", "2010-01-04", "2026-07-31")
        for t in sorted(eu.UNIVERSE_TICKERS)
    ]
    out = eu.resolve_universe(_directory(rows), UNIVERSE, asof=ASOF)
    late = eu.late_arrivals(out, date.fromisoformat(SAMPLE_START))

    assert len(late) == len(UNIVERSE)
    assert set(late["ticker"]) == eu.UNIVERSE_TICKERS
    # Worst-first, so the reader meets the biggest hole before the rest.
    assert late["missing_days"].is_monotonic_decreasing
    assert eu.universe_as_of(out, date(2005, 6, 30)) == ()


# -- the wall -------------------------------------------------------------


def test_a_single_name_raises_before_any_http_happens() -> None:
    """The key would serve AAPL and the catalogue lists it. Still no.

    A hundred and forty hand-checked funds make the survivorship bias
    visible and bounded. Eight thousand equities pulled from a feed that
    answers only for live symbols make it invisible and total.
    """
    src, session = _source(_price_handler({}), allowed=("SPY", "MTUM"))
    with pytest.raises(TickerNotAllowed) as exc:
        src.require_allowed("AAPL")
    assert "survivorship" in str(exc.value)
    assert session.calls == []


def test_an_unknown_permaticker_never_reaches_the_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    src, session = _source(_price_handler({}))
    with pytest.raises(TickerNotAllowed):
        src.prices(date(2020, 1, 1), ASOF, permatickers=[123456])
    assert session.calls == []


def test_a_second_backend_is_refused_by_name() -> None:
    """There is no Alpha Vantage version of this pull, at any speed.

    Its adjusted close is premium and its free key allows 25 requests a
    day; naming it as an option would imply a 142-name universe is
    merely slower there.
    """
    with pytest.raises(ValueError, match="premium|impossible"):
        ETFUniverseSource(backend="alphavantage")


def test_the_source_does_not_claim_to_be_survivorship_free() -> None:
    """The list is the biased thing, and the flag has to say so.

    Claiming the capability would let `data_audit` grade a check that
    only passes because the panel contains nothing that could fail it.
    """
    src, _ = _source()
    assert src.capabilities.claims_survivorship_free is False
    assert src.capabilities.provides_delisting_dates is False
    assert src.capabilities.provides_permanent_ids is False
    # And the half it does earn, structurally: no frame is produced at
    # all unless the payload carried an as-traded block beside the
    # adjusted one.
    assert src.capabilities.provides_unadjusted_prices is True


# -- pulling --------------------------------------------------------------


def test_prices_come_back_on_the_schema_with_both_series(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = {
        "SPY": [
            _tiingo_bar("2026-07-30", 640.0, 640.0),
            _tiingo_bar("2026-07-31", 642.0, 642.0),
        ]
    }
    src, _ = _source(_price_handler(bars), allowed=("SPY",))
    out = src.prices(date(1990, 1, 1), ASOF)

    schema.PRICES.validate(out, source="test")
    assert list(out["close_unadj"]) == [640.0, 642.0]
    assert out["permaticker"].iloc[0] == synthetic_permaticker("SPY")


def test_the_coverage_table_reports_first_and_last_and_a_row_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = {
        "SPY": [_tiingo_bar("2026-07-30", 640.0, 640.0)],
        "MTUM": [
            _tiingo_bar("2026-07-30", 299.0, 299.0),
            _tiingo_bar("2026-07-31", 300.0, 300.0),
        ],
    }
    src, _ = _source(_price_handler(bars))
    cov = eu.pull_universe(src, date(1990, 1, 1), ASOF, sleep=lambda _s: None, pause=0.0)

    assert set(cov["ticker"]) == {"SPY", "MTUM"}
    mtum = cov.loc[cov["ticker"] == "MTUM"].iloc[0]
    assert int(mtum["rows"]) == 2
    assert mtum["first_bar"] == pd.Timestamp("2026-07-30")
    assert mtum["last_bar"] == pd.Timestamp("2026-07-31")

    totals = eu.coverage_summary(cov)
    assert totals["tickers"] == 2 and totals["total_rows"] == 3


def test_a_mid_pull_outage_stops_the_pull_rather_than_shortening_the_table(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Eighty names with bars and sixty without reads as a real universe.

    It looks exactly like a cross-section in which sixty funds never
    traded, and that reading survives into every count downstream. The
    cache is what makes raising cheap: whatever was fetched is on disk.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")

    def handler(url: str, params: dict, headers: dict) -> _Response:
        if "/MTUM/" in url:
            return _Response(500, text="boom")
        return _Response(200, [_tiingo_bar("2026-07-31", 640.0, 640.0)])

    src, _ = _source(handler)
    with pytest.raises(SourceUnavailable):
        eu.pull_universe(src, date(1990, 1, 1), ASOF, sleep=lambda _s: None, pause=0.0)


def test_an_empty_ticker_list_is_refused() -> None:
    src, _ = _source()
    with pytest.raises(ValueError, match="nothing has any history"):
        eu.pull_universe(src, date(1990, 1, 1), ASOF, tickers=[])


def test_a_pull_of_nothing_cannot_be_summarised() -> None:
    empty = pd.DataFrame({"rows": pd.Series([], dtype="int64")})
    with pytest.raises(ValueError, match="fetched nothing"):
        eu.coverage_summary(empty)


# -- the cache ------------------------------------------------------------


def test_the_universe_and_the_sleeve_source_share_one_tiingo_entry(
    tmp_path: Any,
) -> None:
    """Same vendor, same endpoint, same parse — so pulling twice is rude.

    The slug separation `keyedsleeves` keeps is between VENDORS, where a
    shared entry would make `reconcile_sources` diff a frame against
    itself and report perfect agreement. Nothing like that is at stake
    between two readers of one Tiingo response.
    """
    cache = ParquetCache(tmp_path)
    sleeve = keyedsleeves.KeyedSleeveSource(
        "tiingo",
        allowed=("SPY",),
        cache=cache,
        session=_RefusingSession(),
        sleep=lambda _s: None,
        clock=lambda: CLOCK,
    )
    universe, _ = _source(allowed=("SPY", "MTUM"), cache=cache)

    warm = pd.DataFrame(
        {
            "permaticker": [synthetic_permaticker("SPY")],
            "ticker": ["SPY"],
            "date": [pd.Timestamp("2026-07-31")],
            "open_unadj": [639.0],
            "high_unadj": [643.0],
            "low_unadj": [638.0],
            "close_unadj": [642.0],
            "volume_unadj": [5e7],
            "close_adj": [642.0],
        }
    )
    cache.put(
        cache.key("tiingo-sleeve-etf", "prices", ticker="SPY", end=ASOF),
        warm,
        stamped=CLOCK,
    )

    # Neither source touches the network, and both read the same bar.
    a = sleeve.prices(date(2026, 1, 1), ASOF)
    b = universe.prices(date(2026, 1, 1), ASOF, permatickers=[synthetic_permaticker("SPY")])
    assert len(a) == len(b) == 1
    assert a["close_adj"].iloc[0] == b["close_adj"].iloc[0]


def test_a_warm_cache_is_readable_with_no_credentials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """The reviewer's path: the saved pull and no key.

    Inherited from `keyedsleeves` and worth re-asserting here, because
    this source is the one that produces a directory big enough to be
    worth handing to somebody else.
    """
    monkeypatch.delenv(TIINGO_KEY_VAR, raising=False)
    cache = ParquetCache(tmp_path)
    src, _ = _source(allowed=("SPY",), cache=cache)

    warm = pd.DataFrame(
        {
            "permaticker": [synthetic_permaticker("SPY")],
            "ticker": ["SPY"],
            "date": [pd.Timestamp("2026-07-31")],
            "open_unadj": [639.0],
            "high_unadj": [643.0],
            "low_unadj": [638.0],
            "close_unadj": [642.0],
            "volume_unadj": [5e7],
            "close_adj": [642.0],
        }
    )
    cache.put(
        cache.key("tiingo-sleeve-etf", "prices", ticker="SPY", end=ASOF),
        warm,
        stamped=CLOCK,
    )
    out = src.prices(date(2026, 1, 1), ASOF)
    assert len(out) == 1


# -- metadata without a second round trip ---------------------------------


def test_the_catalogue_serves_the_master_with_no_per_symbol_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One request bought the venue and the window for every ticker.

    Asking the metadata endpoint again for facts already on disk would
    be a hundred and forty round trips of pure noise. `fetch_names=False`
    is the honest trade: the vendor's fund name is given up and the
    ticker stands in, which is an obviously derived name rather than a
    plausible invented one.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = {"SPY": [_tiingo_bar("2026-07-31", 642.0, 642.0)]}
    src, session = _source(
        _price_handler(bars),
        allowed=("SPY",),
        directory=_directory(),
        fetch_names=False,
    )
    master = src.security_master()

    schema.SECURITY_MASTER.validate(master, source="test")
    row = master.iloc[0]
    assert row["exchange"] == "NYSE"
    assert row["first_price_date"] == pd.Timestamp("1993-01-29")
    assert row["name"] == "SPY"
    # Exactly one call, and it is the bar request the master needs anyway.
    assert [u for u, _p, _h in session.calls] == [
        "https://api.tiingo.com/tiingo/daily/SPY/prices"
    ]


def test_an_ambiguous_symbol_is_left_out_of_the_catalogue_shortcut(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The constructor must not quietly settle what the resolver refuses.

    Two securities under one ticker is a raise in `resolve_universe`.
    Picking one here to fill in a venue would route around that refusal
    in the place nobody thinks to look — so the shortcut declines and
    the vendor's own metadata answers instead.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    rows = _ROWS + [("SPY", "NASDAQ", "ETF", "USD", "1970-01-02", "1990-12-31")]
    bars = {"SPY": [_tiingo_bar("2026-07-31", 642.0, 642.0)]}
    src, _ = _source(
        _price_handler(bars),
        allowed=("SPY",),
        directory=_directory(rows),
        fetch_names=True,
    )
    master = src.security_master()
    # NYSE ARCA is the metadata endpoint's answer, not either catalogue
    # row's — so the ambiguous pair was declined rather than resolved.
    assert master.iloc[0]["exchange"] == "NYSEARCA"


def test_asking_for_names_costs_one_extra_call_and_gets_the_vendor_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = {"SPY": [_tiingo_bar("2026-07-31", 642.0, 642.0)]}
    src, session = _source(
        _price_handler(bars),
        allowed=("SPY",),
        directory=_directory(),
        fetch_names=True,
    )
    master = src.security_master()

    assert master.iloc[0]["name"] == "SPY FUND"  # whitespace collapsed
    # The catalogue still wins on venue and coverage; the metadata call
    # is there for the one field it cannot supply.
    assert master.iloc[0]["exchange"] == "NYSE"
    assert master.iloc[0]["first_price_date"] == pd.Timestamp("1993-01-29")
    assert len(session.calls) == 2


# -- the survivorship evidence --------------------------------------------


def test_a_dead_fund_that_the_vendor_still_serves_is_recorded_as_served(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The only survivorship-free evidence in the repository.

    Bars, ending years ago, for a fund that no longer exists. Reported
    as a measurement rather than promoted into a capability flag,
    because what it demonstrates is that the VENDOR retains its dead —
    not that this panel does.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = {
        "RSX": [
            _tiingo_bar("2022-02-24", 20.0, 20.0, volume=1e8),
            # The real final print: a zero-volume mark carried through a
            # halt. It is not a delisting date and nothing here says so.
            _tiingo_bar("2023-01-13", 5.6187, 5.6187, volume=0.0),
        ]
    }
    src, _ = _source(_price_handler(bars), allowed=("RSX",))
    out = eu.deceased_evidence(
        src, _directory(), tickers=["RSX"], asof=ASOF, sleep=lambda _s: None, pause=0.0
    )

    row = out.iloc[0]
    assert bool(row["served"]) is True
    assert row["last_bar"] == pd.Timestamp("2023-01-13")
    assert int(row["days_dark"]) > 1000
    # The tell that the last bar is a mark and not a trade.
    assert row["final_volume"] == 0.0


def test_a_fund_the_catalogue_drops_is_recorded_absent_with_no_call_made() -> None:
    """An unknown symbol and an unreachable vendor are opposite findings.

    Both arrive as a failed fetch. Deciding from the catalogue, before
    any request goes out, is what keeps them apart — and the absence is
    itself the measurement of how biased this universe is.
    """
    src, session = _source(allowed=("GONE",))  # a session that fails if touched
    out = eu.deceased_evidence(
        src, _directory(), tickers=["GONE"], asof=ASOF, sleep=lambda _s: None, pause=0.0
    )
    row = out.iloc[0]
    assert bool(row["served"]) is False
    assert int(row["rows"]) == 0
    assert pd.isna(row["last_bar"])


def test_the_probe_refuses_to_run_without_a_catalogue() -> None:
    src, _ = _source(allowed=("RSX",))
    with pytest.raises(SourceUnavailable, match="unknown symbol"):
        eu.deceased_evidence(src, pd.DataFrame(), tickers=["RSX"], asof=ASOF)


def test_the_absence_report_rechecks_the_claims_instead_of_trusting_them() -> None:
    """`ABSENT` is a claim about somebody else's data, and those go stale.

    A ticker we told the reader is dropped, which the vendor has since
    started carrying, is good news and a wrong comment — and the only
    way to find out is to look every time.
    """
    report = eu.absence_report(_directory())
    assert set(report["ticker"]) == {a.ticker for a in ABSENT}
    assert bool(report["still_absent"].all())

    # And the mechanism itself: a catalogue that DID carry one flips it.
    rows = _ROWS + [("RYT", "NYSE", "ETF", "USD", "2006-11-07", "2023-03-31")]
    flipped = eu.absence_report(_directory(rows))
    assert not bool(flipped.loc[flipped["ticker"] == "RYT", "still_absent"].iloc[0])
