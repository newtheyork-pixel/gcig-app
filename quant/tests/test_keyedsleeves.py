"""The keyed second source, exercised without a key and without a network.

Nothing in this file touches either vendor. `KeyedSleeveSource` takes
its `requests.Session`, its `sleep` and its clock as constructor
arguments precisely so a test can stand in for all three, and a suite
that needed a real token would only ever run on the machine that has
one — which is the same as not running.

Six vendor facts are on trial, and every one of them produces a clean
frame when it goes wrong. That is the whole reason they are worth a
test each: none of these failures announces itself.

**A missing key is not an empty result.** They look identical one layer
down and mean opposite things, so the source raises and names the
variable and the free signup page rather than handing back a frame with
no rows in it. The mirror of that is also tested: a genuinely empty
range really does return an empty frame, and a warm cache is readable
with no credentials at all, because the reviewer holding the saved pull
is exactly who the cache exists for.

**The allowlist is a wall, and holding a token does not lower it.** A
free adjusted-close feed only answers for symbols that still resolve
today, so a universe pulled through one is survivorship-biased by
construction whether or not the request carried credentials. The tests
check that a foreign symbol raises before any HTTP happens.

**Half an adjusted series is a refusal in both directions.** No
adjusted close deletes the coupon, which for TLT and LQD is the entire
return. No as-traded close hands the price and participation screens
back-adjusted numbers. Both raise; neither degrades.

**Alpha Vantage's adjusted close is premium and its failures are HTTP
200.** A free key asking for TIME_SERIES_DAILY_ADJUSTED gets a 200
carrying `Information`. The test asserts the message says so, and — the
part that matters — that nothing falls back to the free
TIME_SERIES_DAILY, which carries no adjusted close at all.

**`split_factor` means the same thing here as it does next door.** Both
vendors publish a per-event ratio; the schema wants the cumulative
form. Two sources meaning different things by one column name is how a
reconciliation reports a fault that is really a convention.

**A reconciliation must never be able to report a clean by accident.**
Empty frames, mismatched tickers and non-overlapping windows all raise,
and adjusted closes are compared as returns rather than levels —
because back-adjusted series are anchored at whichever bar the vendor
last had, so two identical histories pulled a day apart differ by a
constant factor at every point.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pandas as pd
import pytest

from griffinquant.data import keyedsleeves, schema
from griffinquant.data.base import SourceUnavailable
from griffinquant.data.cache import ParquetCache
from griffinquant.data.keyedsleeves import (
    ALPHAVANTAGE_FUNCTION,
    ALPHAVANTAGE_KEY_VAR,
    TIINGO_KEY_VAR,
    KeyedSleeveSource,
    reconcile_sources,
)
from griffinquant.data.sleevedata import TickerNotAllowed, synthetic_permaticker

CLOCK = datetime(2024, 3, 15, 17, 0, tzinfo=timezone.utc)
TODAY = CLOCK.date()


# -- the stand-in for requests -------------------------------------------


class _Response:
    def __init__(self, status: int = 200, payload: Any = None, text: str = "") -> None:
        self.status_code = status
        self._payload = payload
        self.text = text

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _Session:
    """A requests.Session with the network taken out.

    `handler` sees the url and the query and decides what came back,
    which is enough to model an error envelope, a premium refusal and a
    throttle — all three of which these vendors deliver as JSON.
    """

    def __init__(self, handler: Callable[[str, dict, dict], _Response]) -> None:
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


def _source(
    backend: str,
    handler: Callable[[str, dict, dict], _Response] | None = None,
    *,
    allowed: tuple[str, ...] = ("SPY",),
    cache: ParquetCache | None = None,
) -> tuple[KeyedSleeveSource, Any]:
    session: Any = _Session(handler) if handler else _RefusingSession()
    src = KeyedSleeveSource(
        backend,
        allowed=allowed,
        cache=cache,
        session=session,
        sleep=lambda _s: None,
        clock=lambda: CLOCK,
    )
    return src, session


# -- payload builders ----------------------------------------------------


def _tiingo_bar(
    day: str,
    close: float,
    adj_close: float,
    *,
    div: float = 0.0,
    split: float = 1.0,
    volume: float = 1_000_000.0,
) -> dict[str, Any]:
    return {
        "date": f"{day}T00:00:00.000Z",
        "open": close - 1.0,
        "high": close + 1.0,
        "low": close - 2.0,
        "close": close,
        "volume": volume,
        "adjOpen": adj_close - 0.5,
        "adjHigh": adj_close + 0.5,
        "adjLow": adj_close - 1.0,
        "adjClose": adj_close,
        "adjVolume": volume,
        "divCash": div,
        "splitFactor": split,
    }


def _av_bar(
    close: float,
    adj_close: float,
    *,
    div: float = 0.0,
    split: float = 1.0,
    volume: float = 1_000_000.0,
) -> dict[str, str]:
    return {
        "1. open": f"{close - 1.0:.4f}",
        "2. high": f"{close + 1.0:.4f}",
        "3. low": f"{close - 2.0:.4f}",
        "4. close": f"{close:.4f}",
        "5. adjusted close": f"{adj_close:.4f}",
        "6. volume": f"{int(volume)}",
        "7. dividend amount": f"{div:.4f}",
        "8. split coefficient": f"{split:.4f}",
    }


def _tiingo_handler(
    bars: list[dict[str, Any]], meta: dict[str, Any] | None = None
) -> Callable[[str, dict, dict], _Response]:
    profile = meta if meta is not None else {
        "ticker": "SPY",
        "name": "SPDR S&P 500 ETF Trust",
        "exchangeCode": "NYSE ARCA",
        "startDate": "1993-01-29",
        "endDate": TODAY.isoformat(),
    }

    def handler(url: str, params: dict, headers: dict) -> _Response:
        return _Response(200, bars if url.endswith("/prices") else profile)

    return handler


def _av_handler(
    series: dict[str, dict[str, str]] | None = None,
    *,
    body: dict[str, Any] | None = None,
) -> Callable[[str, dict, dict], _Response]:
    payload = body if body is not None else {
        "Meta Data": {"2. Symbol": "SPY"},
        "Time Series (Daily)": series or {},
    }

    def handler(url: str, params: dict, headers: dict) -> _Response:
        return _Response(200, payload)

    return handler


# -- the missing key -----------------------------------------------------


@pytest.mark.parametrize(
    "backend,var,where",
    [
        ("tiingo", TIINGO_KEY_VAR, "tiingo.com"),
        ("alphavantage", ALPHAVANTAGE_KEY_VAR, "alphavantage.co"),
    ],
)
def test_missing_key_raises_and_names_the_variable_and_the_free_signup(
    monkeypatch: pytest.MonkeyPatch, backend: str, var: str, where: str
) -> None:
    monkeypatch.delenv(var, raising=False)
    # Deleting the variable is not enough. The lookup also falls back to
    # `quant/.env`, which exists on any machine where somebody has
    # actually configured this. Without redirecting it, the test passes
    # on a bare checkout and quietly stops testing anything the moment
    # the repo is set up — which is exactly when a broken missing-key
    # message would ship unnoticed.
    monkeypatch.setattr(
        keyedsleeves, "DOTENV_PATH", Path("/nonexistent/quant/.env")
    )
    src, _ = _source(backend)

    with pytest.raises(SourceUnavailable) as exc:
        src.prices(date(2024, 1, 1), date(2024, 3, 1))

    message = str(exc.value)
    assert var in message
    assert where in message
    # The distinction the whole exception exists to make.
    assert "empty date range" in message or "empty range" in message


def test_missing_key_is_distinguishable_from_an_empty_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An outage raises; a quiet window returns rows the schema accepts.

    These are the two states that look identical one layer down. A
    source that answered both with an empty frame would report a
    credential problem as a period in which the market did not trade.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    src, _ = _source("tiingo", _tiingo_handler([]))

    out = src.prices(date(2024, 1, 1), date(2024, 3, 1))
    assert out.empty
    schema.PRICES.validate(out, source="test")
    assert list(out.columns)[:3] == ["permaticker", "ticker", "date"]


def test_a_warm_cache_is_readable_with_no_credentials_at_all(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """The reviewer's path: the saved pull and no key.

    The key check lives in the fetch and not in the constructor on
    purpose. `cache.py` exists so an audit outlives its credentials, and
    demanding a token up front would make the saved directory unreadable
    to exactly the person it was written for.
    """
    monkeypatch.delenv(TIINGO_KEY_VAR, raising=False)
    cache = ParquetCache(tmp_path)
    src, _ = _source("tiingo", cache=cache)  # a session that fails if touched

    warm = pd.DataFrame(
        {
            "permaticker": [synthetic_permaticker("SPY")],
            "ticker": ["SPY"],
            "date": [pd.Timestamp("2024-02-01")],
            "open_unadj": [100.0],
            "high_unadj": [101.0],
            "low_unadj": [99.0],
            "close_unadj": [100.5],
            "volume_unadj": [1_000_000.0],
            "close_adj": [95.0],
        }
    )
    cache.put(
        cache.key("tiingo-sleeve-etf", "prices", ticker="SPY", end=TODAY),
        warm,
        stamped=CLOCK,
    )

    out = src.prices(date(2024, 1, 1), date(2024, 3, 1))
    assert len(out) == 1
    assert out["close_adj"].iloc[0] == pytest.approx(95.0)


def test_the_two_sleeve_sources_never_share_a_cache_entry(tmp_path: Any) -> None:
    """One root, two slugs, and the second half is the load-bearing one.

    A warm entry from the free endpoint serving a keyed request would
    make `reconcile_sources` diff a frame against itself and report
    perfect agreement — a reconciliation's most dangerous possible
    output, because it is indistinguishable from the real thing.
    """
    cache = ParquetCache(tmp_path)
    yahoo = cache.key("yahoo-sleeve-etf", "prices", ticker="SPY", end=TODAY)
    tiingo = cache.key("tiingo-sleeve-etf", "prices", ticker="SPY", end=TODAY)
    alpha = cache.key("alphavantage-sleeve-etf", "prices", ticker="SPY", end=TODAY)

    assert len({yahoo.digest, tiingo.digest, alpha.digest}) == 3
    # Same root, so a reviewer still gets the whole pull in one place.
    assert cache.root == tmp_path


# -- the allowlist -------------------------------------------------------


def test_a_symbol_outside_the_allowlist_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    src, session = _source("tiingo", _tiingo_handler([]), allowed=("SPY", "TLT"))

    with pytest.raises(TickerNotAllowed) as exc:
        src.require_allowed("AAPL")

    assert "survivorship" in str(exc.value)
    # The wall stands in front of the transport, not behind it.
    assert session.calls == []


def test_holding_a_key_does_not_widen_the_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A token makes a biased pull faster and more reliable, not safer."""
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    src, session = _source("tiingo", _tiingo_handler([]))

    with pytest.raises(TickerNotAllowed):
        src.prices(date(2024, 1, 1), date(2024, 3, 1), permatickers=[123456])
    assert session.calls == []


def test_an_empty_allowlist_is_refused() -> None:
    with pytest.raises(ValueError, match="empty allowlist"):
        KeyedSleeveSource("tiingo", allowed=[])


def test_an_unknown_backend_is_refused_rather_than_guessed() -> None:
    with pytest.raises(ValueError, match="unknown backend"):
        KeyedSleeveSource("quandl")


def test_permatickers_agree_with_the_free_source() -> None:
    """Ids must match `sleevedata.py` or the reconciliation joins to nothing."""
    src, _ = _source("tiingo", allowed=("SPY", "TLT"))
    assert src.permaticker_for("SPY") == synthetic_permaticker("SPY")
    assert src.permaticker_for("TLT") == synthetic_permaticker("TLT")


# -- column mapping: Tiingo ----------------------------------------------


def test_tiingo_columns_map_onto_the_prices_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = [
        _tiingo_bar("2024-02-01", close=100.0, adj_close=95.0, volume=2_000_000.0),
        _tiingo_bar("2024-02-02", close=101.0, adj_close=96.0, div=0.25),
    ]
    src, _ = _source("tiingo", _tiingo_handler(bars))

    out = src.prices(date(2024, 1, 1), date(2024, 3, 1))
    schema.PRICES.validate(out, source="test")

    assert list(out["date"]) == [pd.Timestamp("2024-02-01"), pd.Timestamp("2024-02-02")]
    # Tiingo's raw block is as-traded, so nothing is reconstructed — the
    # split arithmetic sleevedata.py needs is simply absent here.
    assert list(out["close_unadj"]) == [100.0, 101.0]
    assert list(out["close_adj"]) == [95.0, 96.0]
    assert list(out["volume_unadj"]) == [2_000_000.0, 1_000_000.0]
    assert list(out["dividends"]) == [0.0, 0.25]
    assert out["permaticker"].unique().tolist() == [synthetic_permaticker("SPY")]


def test_tiingo_split_factor_is_the_cumulative_convention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per-event ratio in, split-adjusted-over-as-traded out.

    Both vendors publish the ratio on the ex-date and 1.0 elsewhere; the
    schema's column is cumulative and below one before a forward split.
    Two producers meaning different things by one name is how a
    reconciliation reports a fault that is really a convention.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = [
        _tiingo_bar("2024-02-01", close=300.0, adj_close=95.0),
        _tiingo_bar("2024-02-02", close=303.0, adj_close=96.0),
        _tiingo_bar("2024-02-05", close=101.0, adj_close=96.0, split=3.0),
        _tiingo_bar("2024-02-06", close=102.0, adj_close=97.0),
    ]
    src, _ = _source("tiingo", _tiingo_handler(bars))

    out = src.prices(date(2024, 1, 1), date(2024, 3, 1))
    assert list(out["split_factor"]) == pytest.approx([1 / 3, 1 / 3, 1.0, 1.0])
    # The ex-date's own bar already trades post-split.
    assert out.loc[out["date"] == pd.Timestamp("2024-02-05"), "close_unadj"].iloc[
        0
    ] == pytest.approx(101.0)


def test_tiingo_actions_carry_the_split_and_the_dividend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = [
        _tiingo_bar("2024-02-01", close=300.0, adj_close=95.0, div=1.5),
        _tiingo_bar("2024-02-05", close=101.0, adj_close=96.0, split=3.0),
    ]
    src, _ = _source("tiingo", _tiingo_handler(bars))

    out = src.actions(date(2024, 1, 1), date(2024, 3, 1))
    schema.ACTIONS.validate(out, source="test")

    kinds = dict(zip(out["action"], out["value"]))
    assert kinds["dividend"] == pytest.approx(1.5)
    # New shares per old share, one number signed by which side of one.
    assert kinds["split"] == pytest.approx(3.0)
    # An absence produced by the allowlist is never reported as a
    # delisting observed in the market.
    assert "delisting" not in set(out["action"])


def test_tiingo_security_master_maps_the_venue_and_keeps_the_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bars = [_tiingo_bar("2024-02-01", close=100.0, adj_close=95.0)]
    src, _ = _source("tiingo", _tiingo_handler(bars))

    out = src.security_master()
    schema.SECURITY_MASTER.validate(out, source="test")

    row = out.iloc[0]
    assert row["ticker"] == "SPY"
    assert row["name"] == "SPDR S&P 500 ETF Trust"
    assert row["exchange"] == "NYSEARCA"
    assert row["category"] == "ETF"
    assert bool(row["is_delisted"]) is False


# -- column mapping: Alpha Vantage ---------------------------------------


def test_alphavantage_columns_map_onto_the_prices_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(ALPHAVANTAGE_KEY_VAR, "tok")
    series = {
        "2024-02-01": _av_bar(100.0, 95.0, volume=2_000_000.0),
        "2024-02-02": _av_bar(101.0, 96.0, div=0.25),
        "2024-02-05": _av_bar(34.0, 96.5, split=3.0),
    }
    src, session = _source("alphavantage", _av_handler(series))

    out = src.prices(date(2024, 1, 1), date(2024, 3, 1))
    schema.PRICES.validate(out, source="test")

    assert list(out["close_unadj"]) == [100.0, 101.0, 34.0]
    assert list(out["close_adj"]) == [95.0, 96.0, 96.5]
    assert list(out["volume_unadj"])[0] == 2_000_000.0
    assert list(out["dividends"]) == [0.0, 0.25, 0.0]
    assert list(out["split_factor"]) == pytest.approx([1 / 3, 1 / 3, 1.0])
    # Only the adjusted function is ever asked for.
    assert session.calls[0][1]["function"] == ALPHAVANTAGE_FUNCTION
    assert session.calls[0][1]["outputsize"] == "full"


def test_alphavantage_derives_a_master_without_inventing_a_fund_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A plausible invented name invites a join; an obviously derived one
    refuses it on sight."""
    monkeypatch.setenv(ALPHAVANTAGE_KEY_VAR, "tok")
    series = {"2024-02-01": _av_bar(100.0, 95.0)}
    src, _ = _source("alphavantage", _av_handler(series))

    out = src.security_master()
    schema.SECURITY_MASTER.validate(out, source="test")
    assert out["name"].iloc[0] == "SPY"
    assert out["first_price_date"].iloc[0] == pd.Timestamp("2024-02-01")


@pytest.mark.parametrize("key", ["Error Message", "Note", "Information"])
def test_alphavantage_reports_failure_with_http_200(
    monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    """Throttling and a bad symbol both arrive as a successful response.

    A client that switches on the status code reads each of them as an
    empty range, which is the shape of a quiet market rather than of an
    exhausted quota.
    """
    monkeypatch.setenv(ALPHAVANTAGE_KEY_VAR, "tok")
    src, _ = _source(
        "alphavantage",
        _av_handler(body={key: "our standard API rate limit is 25 requests per day"}),
    )

    with pytest.raises(SourceUnavailable) as exc:
        src.prices(date(2024, 1, 1), date(2024, 3, 1))
    assert "Not an empty range" in str(exc.value)


def test_alphavantage_premium_wall_refuses_rather_than_dropping_to_price_return(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one failure a free Alpha Vantage key will actually hit.

    `TIME_SERIES_DAILY_ADJUSTED` is premium and `TIME_SERIES_DAILY` — the
    free sibling — carries no adjusted close at all. Falling back would
    return a price-return series for a strategy whose defensive half is
    entirely coupon.
    """
    monkeypatch.setenv(ALPHAVANTAGE_KEY_VAR, "tok")
    src, session = _source(
        "alphavantage",
        _av_handler(
            body={
                "Information": (
                    "Thank you for using Alpha Vantage! This is a premium "
                    "endpoint. You may subscribe to any of the premium plans."
                )
            }
        ),
    )

    with pytest.raises(SourceUnavailable) as exc:
        src.prices(date(2024, 1, 1), date(2024, 3, 1))

    message = str(exc.value)
    assert "premium" in message
    assert "TIME_SERIES_DAILY" in message
    assert "105.8%" in message  # the coupon argument, stated not gestured at
    assert "Tiingo" in message  # and the way out
    # Exactly one request, and it was not the free function.
    assert len(session.calls) == 1
    assert session.calls[0][1]["function"] == ALPHAVANTAGE_FUNCTION


# -- half an adjusted series is a refusal --------------------------------


def test_tiingo_price_only_payload_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No adjusted close deletes the coupon, which is the bond sleeves."""
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bar = _tiingo_bar("2024-02-01", close=100.0, adj_close=95.0)
    bar.pop("adjClose")
    src, _ = _source("tiingo", _tiingo_handler([bar]))

    with pytest.raises(SourceUnavailable) as exc:
        src.prices(date(2024, 1, 1), date(2024, 3, 1))

    message = str(exc.value)
    assert "adjClose" in message
    assert "coupon" in message
    assert "Refusing to substitute" in message


def test_tiingo_adjusted_only_payload_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No as-traded close hands the screens back-adjusted numbers.

    A vehicle that traded at $11 and has since split 3-for-1 twice reads
    at $101 adjusted and passes a floor it could never have passed on
    the day. That is lookahead wearing a price's clothes, so the
    adjusted-only feed is a refusal and not a degraded mode.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    bar = _tiingo_bar("2024-02-01", close=100.0, adj_close=95.0)
    bar.pop("close")
    src, _ = _source("tiingo", _tiingo_handler([bar]))

    with pytest.raises(SourceUnavailable) as exc:
        src.prices(date(2024, 1, 1), date(2024, 3, 1))

    message = str(exc.value)
    assert "'close'" in message
    assert "participation" in message
    assert "not a degraded mode" in message


def test_alphavantage_adjusted_only_payload_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(ALPHAVANTAGE_KEY_VAR, "tok")
    bar = _av_bar(100.0, 95.0)
    bar.pop("4. close")
    src, _ = _source("alphavantage", _av_handler({"2024-02-01": bar}))

    with pytest.raises(SourceUnavailable, match="not a degraded mode"):
        src.prices(date(2024, 1, 1), date(2024, 3, 1))


def test_alphavantage_price_only_payload_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What the free TIME_SERIES_DAILY would look like if it were wired up."""
    monkeypatch.setenv(ALPHAVANTAGE_KEY_VAR, "tok")
    bar = _av_bar(100.0, 95.0)
    bar.pop("5. adjusted close")
    src, _ = _source("alphavantage", _av_handler({"2024-02-01": bar}))

    with pytest.raises(SourceUnavailable, match="coupon"):
        src.prices(date(2024, 1, 1), date(2024, 3, 1))


# -- the shape of the source ---------------------------------------------


def test_capabilities_stay_honest() -> None:
    """The allowlist merely contains survivors; that is not a capability."""
    src, _ = _source("tiingo")
    caps = src.capabilities
    assert caps.claims_survivorship_free is False
    assert caps.provides_delisting_dates is False
    # False despite every row carrying one: the ids are a hash of the
    # ticker string and cannot survive a symbol change, which is the one
    # thing the capability is about.
    assert caps.provides_permanent_ids is False
    # True, and structurally: no frame exists unless the payload carried
    # an as-traded block beside the adjusted one.
    assert caps.provides_unadjusted_prices is True
    assert caps.is_smoke_test_only is False


def test_fundamentals_raise_rather_than_returning_an_empty_frame() -> None:
    """`load_context` catches this and records UNPROVABLE — the true answer.

    A correctly-typed empty frame would instead read as "these entities
    filed nothing in this range", and every point-in-time check would
    grade that as data.
    """
    src, _ = _source("tiingo")
    with pytest.raises(NotImplementedError, match="market fact"):
        src.fundamentals(date(2024, 1, 1), date(2024, 3, 1))


def test_a_reversed_window_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    src, _ = _source("tiingo", _tiingo_handler([]))
    with pytest.raises(ValueError, match="is after end"):
        src.prices(date(2024, 3, 1), date(2024, 1, 1))


# -- reconciliation ------------------------------------------------------


def _frame(
    ticker: str,
    days: list[str],
    close_unadj: list[float],
    close_adj: list[float],
) -> pd.DataFrame:
    n = len(days)
    return pd.DataFrame(
        {
            "permaticker": [synthetic_permaticker(ticker)] * n,
            "ticker": [ticker] * n,
            "date": pd.to_datetime(pd.Series(days)),
            "open_unadj": [c - 1.0 for c in close_unadj],
            "high_unadj": [c + 1.0 for c in close_unadj],
            "low_unadj": [c - 2.0 for c in close_unadj],
            "close_unadj": close_unadj,
            "volume_unadj": [1_000_000.0] * n,
            "close_adj": close_adj,
        }
    )


DAYS = ["2024-02-01", "2024-02-02", "2024-02-05"]


def test_reconcile_agreeing_sources_returns_an_empty_typed_frame() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    out = reconcile_sources(a, a.copy(), 10.0)

    assert out.empty
    assert list(out.columns) == [
        "ticker",
        "date",
        "column",
        "basis",
        "kind",
        "a",
        "b",
        "diff_bps",
    ]


def test_reconcile_flags_a_close_that_disagrees() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("SPY", DAYS, [100.0, 102.0, 102.0], [95.0, 96.0, 97.0])

    out = reconcile_sources(a, b, 10.0)
    hits = out.loc[out["column"] == "close_unadj"]
    assert len(hits) == 1
    assert hits["date"].iloc[0] == pd.Timestamp("2024-02-02")
    assert hits["kind"].iloc[0] == "value"
    assert hits["basis"].iloc[0] == "level"
    # (101 - 102) / 101.5 in bps, and negative because a is the lower.
    assert hits["diff_bps"].iloc[0] == pytest.approx(-98.522, abs=0.01)


def test_reconcile_ignores_a_constant_scale_on_the_adjusted_series() -> None:
    """The single most important behaviour in this function.

    A back-adjusted series is anchored at whichever bar the vendor last
    had, so two pulls that ended on different days differ by a constant
    factor at every point while being identical in every way that
    matters. Comparing those levels would report 100% disagreement on
    the one column the entire strategy's return comes out of, and a
    check that cries wolf there is a check nobody runs twice.
    """
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [47.5, 48.0, 48.5])

    assert reconcile_sources(a, b, 1.0).empty


def test_reconcile_flags_an_adjusted_return_that_differs() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 98.0])

    out = reconcile_sources(a, b, 10.0)
    hits = out.loc[out["column"] == "close_adj"]
    assert len(hits) == 1
    assert hits["basis"].iloc[0] == "return"
    assert hits["date"].iloc[0] == pd.Timestamp("2024-02-05")
    # A return is already a fraction, so the honest unit is the
    # arithmetic gap: 1/96 against 2/96, about 104bp apart.
    assert hits["diff_bps"].iloc[0] == pytest.approx(-104.17, abs=0.05)


def test_reconcile_reports_a_session_one_source_does_not_have() -> None:
    """An inner join would call this agreement on a shortened window."""
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("SPY", DAYS[:2], [100.0, 101.0], [95.0, 96.0])

    out = reconcile_sources(a, b, 10.0)
    calendar = out.loc[out["basis"] == "calendar"]
    assert len(calendar) == 1
    assert calendar["kind"].iloc[0] == "only_in_a"
    assert calendar["date"].iloc[0] == pd.Timestamp("2024-02-05")
    # No magnitude exists, so the tolerance cannot suppress it.
    assert pd.isna(calendar["diff_bps"].iloc[0])
    assert reconcile_sources(a, b, 10_000.0).loc[
        lambda f: f["basis"] == "calendar"
    ].shape[0] == 1


def test_reconcile_flags_a_value_one_source_left_null() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("SPY", DAYS, [100.0, float("nan"), 102.0], [95.0, 96.0, 97.0])

    out = reconcile_sources(a, b, 10.0)
    missing = out.loc[out["kind"] == "missing_value"]
    assert len(missing) == 1
    assert missing["column"].iloc[0] == "close_unadj"
    assert missing["date"].iloc[0] == pd.Timestamp("2024-02-02")


def test_reconcile_honours_the_tolerance() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("SPY", DAYS, [100.0, 101.01, 102.0], [95.0, 96.0, 97.0])

    # About one basis point. A penny on a hundred-dollar fund is mostly
    # the vendors' rounding, not a disagreement about the market.
    assert reconcile_sources(a, b, 10.0).empty
    assert not reconcile_sources(a, b, 0.5).empty


def test_reconcile_is_symmetric_in_its_arguments() -> None:
    """Nobody should have to remember which frame was the reference."""
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("SPY", DAYS, [100.0, 102.0, 102.0], [95.0, 96.0, 97.0])

    forward = reconcile_sources(a, b, 10.0)
    backward = reconcile_sources(b, a, 10.0)
    assert len(forward) == len(backward)
    assert forward["diff_bps"].abs().tolist() == pytest.approx(
        backward["diff_bps"].abs().tolist()
    )


def test_reconcile_refuses_windows_that_do_not_overlap() -> None:
    """Returning empty here would be indistinguishable from agreement."""
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame(
        "SPY",
        ["2025-02-01", "2025-02-03", "2025-02-04"],
        [100.0, 101.0, 102.0],
        [95.0, 96.0, 97.0],
    )
    with pytest.raises(ValueError, match="share no dates"):
        reconcile_sources(a, b, 10.0)


def test_reconcile_refuses_an_empty_frame() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    with pytest.raises(ValueError, match="no rows"):
        reconcile_sources(a, a.iloc[0:0], 10.0)


def test_reconcile_refuses_two_different_securities() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = _frame("TLT", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    with pytest.raises(ValueError, match="different securities"):
        reconcile_sources(a, b, 10.0)


def test_reconcile_refuses_a_frame_holding_more_than_one_ticker() -> None:
    """A merge across tickers on date alone cross-joins."""
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = pd.concat(
        [a, _frame("TLT", DAYS, [90.0, 91.0, 92.0], [85.0, 86.0, 87.0])],
        ignore_index=True,
    )
    with pytest.raises(ValueError, match="expected one ticker"):
        reconcile_sources(a, b, 10.0)


def test_reconcile_refuses_duplicate_sessions() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    doubled = pd.concat([a, a.iloc[[1]]], ignore_index=True)
    with pytest.raises(ValueError, match="duplicate date"):
        reconcile_sources(a, doubled, 10.0)


def test_reconcile_refuses_a_column_it_was_asked_for_and_cannot_see() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    with pytest.raises(ValueError, match="missing column"):
        reconcile_sources(a, a.drop(columns=["close_adj"]), 10.0)


def test_reconcile_refuses_a_negative_tolerance() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    with pytest.raises(ValueError, match="non-negative"):
        reconcile_sources(a, a.copy(), -1.0)


def test_reconcile_can_be_pointed_at_other_columns() -> None:
    a = _frame("SPY", DAYS, [100.0, 101.0, 102.0], [95.0, 96.0, 97.0])
    b = a.copy()
    b.loc[1, "volume_unadj"] = 2_000_000.0

    assert reconcile_sources(a, b, 10.0).empty  # not compared by default
    out = reconcile_sources(a, b, 10.0, columns=("volume_unadj",))
    assert len(out) == 1
    assert out["column"].iloc[0] == "volume_unadj"
    assert out["basis"].iloc[0] == "level"


def test_reconcile_runs_end_to_end_across_two_backends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The shape the caller actually writes: two sources, one loop.

    Both frames come out of real adapters here rather than being
    hand-built, so a mapping change in either backend shows up as a
    reconciliation failure — which is exactly what the function is for.
    """
    monkeypatch.setenv(TIINGO_KEY_VAR, "tok")
    monkeypatch.setenv(ALPHAVANTAGE_KEY_VAR, "tok")

    tiingo, _ = _source(
        "tiingo",
        _tiingo_handler(
            [
                _tiingo_bar("2024-02-01", close=100.0, adj_close=95.0),
                _tiingo_bar("2024-02-02", close=101.0, adj_close=96.0),
            ]
        ),
    )
    alpha, _ = _source(
        "alphavantage",
        _av_handler(
            {
                # Half a point out on the second close, which is what a
                # genuine vendor disagreement looks like. The adjusted
                # series is anchored differently — 47.5 against 95.0 —
                # and must NOT be reported, because in return terms the
                # two are identical.
                "2024-02-01": _av_bar(100.0, 47.5),
                "2024-02-02": _av_bar(101.5, 48.0),
            }
        ),
    )

    window = (date(2024, 1, 1), date(2024, 3, 1))
    out = reconcile_sources(tiingo.prices(*window), alpha.prices(*window), 10.0)

    assert set(out["column"]) == {"close_unadj"}
    assert out["date"].iloc[0] == pd.Timestamp("2024-02-02")
    assert out["diff_bps"].iloc[0] == pytest.approx(-49.38, abs=0.05)
