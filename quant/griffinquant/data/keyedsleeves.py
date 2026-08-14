"""The same nine sleeve ETFs from a keyed free tier, so one endpoint
having a bad afternoon is not the project having an outage.

`sleevedata.py` reads an unauthenticated chart endpoint, and on the day
this file was written that endpoint answered 429 to every request from
this address for longer than a working session — with a cold cache,
which put the SPY reconciliation and everything after it on hold. There
was no keyless alternative to fall back to, because the constraint is
not "a price feed", it is "a DIVIDEND-ADJUSTED price feed", and almost
nothing gives that away without a token. A free key from either vendor
below takes under a minute to obtain and costs nothing, so the single
point of failure was never a budget decision; it was an unmade
decision. This file is the second leg, written so that the moment a key
exists in the environment nothing else anywhere has to change.

The allowlist is the same wall it is next door, for the same reason and
with the same shape: constructed with an explicit list defaulting to
`SLEEVE_TICKERS`, checked on every request, raising on anything else.
Adding a source does not widen the exemption. A free adjusted-close
endpoint only answers for symbols that still resolve today, so a
universe pulled through one is survivorship-biased by construction
whether the request carried a token or not — and a token makes the
biased pull faster and more reliable, which is worse. The single-name
layer stays structurally unreachable from here.

**What each backend actually gives, which is the whole question.**

Tiingo's daily bars carry both series honestly: `open/high/low/close/
volume` are as-traded, `adjOpen/adjHigh/adjLow/adjClose/adjVolume` are
adjusted for splits AND dividends on CRSP conventions, and `divCash` /
`splitFactor` sit alongside. That is exactly the PRICES schema's shape
with no reconstruction needed — note that the split-event arithmetic
`sleevedata.py` has to do to recover an as-traded bar is simply absent
here, which is an argument for this source and not merely a convenience.

Alpha Vantage splits the two across a paywall. `TIME_SERIES_DAILY` is
free and carries as-traded OHLCV and NOTHING adjusted.
`TIME_SERIES_DAILY_ADJUSTED` carries both and is a premium endpoint; a
free key asking for it gets HTTP 200 and a JSON body explaining that it
is premium. So this file asks for the adjusted function and, when the
key cannot buy it, RAISES — naming the premium wall. It does not fall
back to the free function. Over 2004-2026 TLT returned -2.6% on price
and +105.8% on total return, LQD -3.2% and +141.4%; for the duration
and credit sleeves essentially all of the return is coupon. A price-
return fallback would not be an approximation of this strategy, it
would delete its defensive half and hand back a complete, well-typed,
plausible frame while doing it. The refusal runs the other way too: a
backend offering only an adjusted series is refused just as hard,
because without an as-traded price the participation and price screens
silently read back-adjusted numbers and pass filters no one could have
passed on the day.

Three smaller traps, each of which produces a clean-looking frame.

**Alpha Vantage reports failure with HTTP 200.** Throttling, an unknown
symbol and the premium wall all arrive as a 200 carrying `Information`,
`Note` or `Error Message` and no time series. A client that switches on
the status code reads every one of those as success and then as an
empty range. The body is inspected before the status is trusted.

**Tiingo returns one bar when `startDate` is omitted.** Not an error, not
an empty answer — the latest session, which validates cleanly and is a
twenty-year history silently reduced to yesterday. Every pull here
states its start date explicitly.

**A shared cache root is not a shared cache entry.** Both sources write
under one root, so a reviewer gets the whole pull in one directory and
neither source needs the network twice. They write under DIFFERENT
source slugs, and that half is not tidiness: if a warm Yahoo entry
could serve a Tiingo request, `reconcile_sources` would compare a frame
against itself and report perfect agreement, which is the one answer a
reconciliation must never be able to give by accident.

`reconcile_sources` at the bottom is the other half of the point.
`LIMITATIONS.md` says the cheapest thing that would raise confidence in
this data is an independent second source and a bar-for-bar diff,
because every check that exists today compares the data against itself
and a consistently wrong close passes all of them. For nine ETFs that
work is a loop and this function.
"""

from __future__ import annotations

import os
from pathlib import Path
import time
from collections.abc import Callable, Iterable, Sequence
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any

import numpy as np
import pandas as pd
import requests

from ..portfolio.sleeves import SLEEVE_TICKERS
from . import schema
from .base import DataSource, SourceCapabilities, SourceUnavailable
from .sleevedata import TickerNotAllowed, synthetic_permaticker

if TYPE_CHECKING:
    from .cache import ParquetCache


#: Reused rather than re-minted, and it matters more than it looks. Ids
#: here must equal `sleevedata.py`'s for the same symbol, or a frame
#: from one source and a frame from the other join on `permaticker` to
#: nothing — and the reconciliation this file exists to enable would
#: quietly have no rows to compare. Note this does NOT make them
#: permanent ids: they are a hash of the ticker string and carry exactly
#: what the string carried, which is why the capability stays False.
_permaticker = synthetic_permaticker

TIINGO_BASE = "https://api.tiingo.com/tiingo/daily"
TIINGO_KEY_VAR = "TIINGO_API_KEY"


#: `quant/.env`, gitignored. A module-level name rather than a literal
#: computed inside the reader, because a test that cannot redirect this
#: cannot test the missing-key path at all on a machine that happens to
#: have a real key on disk — and the missing-key path is the one whose
#: whole job is telling the truth about an unconfigured source.
DOTENV_PATH = Path(__file__).resolve().parents[2] / ".env"


def _key_from_dotenv(var: str) -> str:
    """Fall back to `quant/.env` when the variable is not exported.

    Shell state does not survive between invocations, so an `export`
    typed once is gone by the next command and the failure looks exactly
    like a missing key. A gitignored file in the repository is the thing
    that actually persists, and it is where a credential belongs anyway.

    Read on demand rather than at import: a module that reaches for a
    dotfile the moment it is imported will surprise somebody, and an
    unreadable or malformed file must degrade to "no key" rather than
    taking down a run that had one exported all along.
    """
    try:
        for line in DOTENV_PATH.read_text("utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            if name.strip() == var:
                return value.strip().strip("'\"")
    except OSError:
        pass
    return ""
TIINGO_SIGNUP = "https://www.tiingo.com/account/api/token"

ALPHAVANTAGE_BASE = "https://www.alphavantage.co/query"
ALPHAVANTAGE_KEY_VAR = "ALPHAVANTAGE_API_KEY"
ALPHAVANTAGE_SIGNUP = "https://www.alphavantage.co/support/#api-key"

#: The only Alpha Vantage function this file will call. Its free
#: sibling, TIME_SERIES_DAILY, is deliberately not named as a constant
#: anywhere: a constant is an invitation, and the one thing that must
#: never happen here is somebody wiring up the price-return endpoint as
#: a graceful degradation on an afternoon when the adjusted one is
#: refused. See the module docstring for what that would cost.
ALPHAVANTAGE_FUNCTION = "TIME_SERIES_DAILY_ADJUSTED"

#: Earlier than SPY's 1993 listing, which is the oldest thing the
#: allowlist can contain. Fixed rather than derived from `SLEEVES` so
#: that a widened allowlist cannot silently shorten a pull.
HISTORY_START = date(1990, 1, 1)

#: 429 plus the 5xx range, matching `sleevedata.py`. A 404 is an answer.
RETRY_STATUSES = frozenset({429, *range(500, 512)})

#: Patient, because the whole panel is nine calls that are then cached.
#: Alpha Vantage's free key allows 25 requests a day and five a minute,
#: so a retry there is expensive in a way a retry against Tiingo is not
#: — which is the argument for the cache, not against the retry.
MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 2.0
BACKOFF_CAP_SECONDS = 30.0
MIN_REQUEST_INTERVAL_SECONDS = 0.5

#: Vendor venue strings onto `config.ALLOWED_EXCHANGES`. An unmapped
#: venue passes through under its own name rather than defaulting to a
#: plausible one — visibly unrecognised beats quietly wrong.
_EXCHANGES = {
    "NYSE ARCA": "NYSEARCA",
    "NYSEARCA": "NYSEARCA",
    "ARCA": "NYSEARCA",
    "PCX": "NYSEARCA",
    "NASDAQ": "NASDAQ",
    "NMS": "NASDAQ",
    "NYSE": "NYSE",
    "AMEX": "NYSEMKT",
    "NYSE MKT": "NYSEMKT",
    "BATS": "BATS",
}

#: Said in the vendor's own vocabulary because that is what keeps these
#: out of the single-name layer: `config.SINGLE_NAME_CATEGORIES` does
#: not contain this string and `VENDOR_CATEGORY_EXCLUSIONS` does.
ETF_CATEGORY = "ETF"

#: The normalised tape every backend parses into, before any of it
#: becomes a schema frame. Splits arrive as PER-EVENT ratios here
#: (1.0 on an ordinary session) because that is what both vendors
#: publish; the cumulative form the PRICES schema wants is derived.
_TAPE_COLUMNS: dict[str, str] = {
    "date": "datetime64[ns]",
    "open": "float64",
    "high": "float64",
    "low": "float64",
    "close": "float64",
    "volume": "float64",
    "adj_close": "float64",
    "div_cash": "float64",
    "split_ratio": "float64",
}


# -- backends -------------------------------------------------------------


class _Backend:
    """One vendor's free tier, reduced to what this file needs of it.

    Deliberately thin. Everything that is a decision about the DATA —
    the allowlist, the permaticker, the refusal to serve a half-adjusted
    series, the schema — lives in the source class and is therefore
    identical across backends. A backend only knows how to ask and how
    to read the answer, so adding a third vendor cannot accidentally
    come with a third opinion about what a price is.
    """

    name: str
    slug: str
    key_var: str
    signup_url: str
    capability_name: str

    #: Whether `profile_request` will ever produce a call. Read before
    #: the key is demanded, so a backend with no metadata endpoint does
    #: not ask for credentials it has no request to spend them on.
    has_profile_endpoint: bool = False

    def bars_request(
        self, symbol: str, api_key: str, through: date
    ) -> tuple[str, dict[str, str], dict[str, str]]:
        raise NotImplementedError

    def parse_bars(self, payload: Any, symbol: str) -> pd.DataFrame:
        raise NotImplementedError

    def profile_request(
        self, symbol: str, api_key: str
    ) -> tuple[str, dict[str, str], dict[str, str]] | None:
        """A second call for fund metadata, or None to derive it.

        None is the honest answer for a vendor with no ETF profile
        endpoint. Deriving first/last date from the bars we already hold
        costs nothing; inventing a fund name would cost the reader's
        trust in a column they might otherwise join on.
        """
        return None

    def parse_profile(self, payload: Any, symbol: str) -> dict[str, Any]:
        return {}


class _TiingoBackend(_Backend):
    """Both series, published side by side, with nothing to reconstruct."""

    name = "tiingo"
    slug = "tiingo-sleeve-etf"
    key_var = TIINGO_KEY_VAR
    signup_url = TIINGO_SIGNUP
    capability_name = "Tiingo daily EOD (sleeve ETFs only)"
    has_profile_endpoint = True

    def bars_request(
        self, symbol: str, api_key: str, through: date
    ) -> tuple[str, dict[str, str], dict[str, str]]:
        return (
            f"{TIINGO_BASE}/{symbol}/prices",
            {
                # Not optional. Omit it and the endpoint answers with
                # the most recent session alone — a well-formed
                # one-row history that passes every check below.
                "startDate": HISTORY_START.isoformat(),
                "endDate": through.isoformat(),
                "format": "json",
                "resampleFreq": "daily",
            },
            # The header form rather than `?token=`, so the key stays
            # out of anything that logs a URL.
            {"Authorization": f"Token {api_key}", "Accept": "application/json"},
        )

    def parse_bars(self, payload: Any, symbol: str) -> pd.DataFrame:
        rows = _tiingo_rows(payload, symbol)
        if not rows:
            return _empty_tape()

        # Structural, before any values are looked at. A vendor that
        # stopped publishing one of the two series would otherwise show
        # up as a column of NaN, and a column of NaN reads as a quiet
        # data gap rather than as the source changing shape.
        _require_both_series(
            rows[0],
            symbol=symbol,
            backend=self.name,
            adjusted_key="adjClose",
            as_traded_key="close",
        )

        frame = pd.DataFrame(rows)
        return _typed(
            pd.DataFrame(
                {
                    # Tiingo stamps a bar with an ISO instant carrying a
                    # UTC offset. Normalising after the parse recovers
                    # the session date; parsing as naive would be fine
                    # today and wrong the first time they change the
                    # offset they publish.
                    "date": pd.to_datetime(
                        frame["date"], utc=True, errors="coerce"
                    ).dt.tz_localize(None).dt.normalize(),
                    "open": _col(frame, "open"),
                    "high": _col(frame, "high"),
                    "low": _col(frame, "low"),
                    "close": _col(frame, "close"),
                    "volume": _col(frame, "volume"),
                    "adj_close": _col(frame, "adjClose"),
                    # Absent means no distribution, which for these
                    # rows is something the vendor knows rather than
                    # something we are filling in.
                    "div_cash": _col(frame, "divCash").fillna(0.0),
                    # splitTo/splitFrom on the ex-date, 1.0 otherwise.
                    "split_ratio": _col(frame, "splitFactor").fillna(1.0),
                }
            ),
            _TAPE_COLUMNS,
        )

    def profile_request(
        self, symbol: str, api_key: str
    ) -> tuple[str, dict[str, str], dict[str, str]]:
        return (
            f"{TIINGO_BASE}/{symbol}",
            {},
            {"Authorization": f"Token {api_key}", "Accept": "application/json"},
        )

    def parse_profile(self, payload: Any, symbol: str) -> dict[str, Any]:
        meta = payload if isinstance(payload, dict) else {}
        return {
            "name": _clean_name(meta.get("name"), symbol),
            "exchange": _venue(meta.get("exchangeCode")),
            # Deliberately NOT read as the fund's inception. This is the
            # date the vendor's coverage starts, and the two differ.
            # `sleeves.py` holds a probed inception per vehicle and that
            # remains the authority for anything deciding availability.
            "first_price_date": _stamp(meta.get("startDate")),
            "last_price_date": _stamp(meta.get("endDate")),
        }


class _AlphaVantageBackend(_Backend):
    """Both series, behind a paywall, and a 200 for every failure."""

    name = "alphavantage"
    slug = "alphavantage-sleeve-etf"
    key_var = ALPHAVANTAGE_KEY_VAR
    signup_url = ALPHAVANTAGE_SIGNUP
    capability_name = "Alpha Vantage daily adjusted (sleeve ETFs only)"

    def bars_request(
        self, symbol: str, api_key: str, through: date
    ) -> tuple[str, dict[str, str], dict[str, str]]:
        return (
            ALPHAVANTAGE_BASE,
            {
                "function": ALPHAVANTAGE_FUNCTION,
                "symbol": symbol,
                # The endpoint takes no date range at all, so `through`
                # narrows nothing on the wire and everything in the
                # cache key. `full` is the whole history; `compact`
                # would be a hundred sessions dressed as an answer.
                "outputsize": "full",
                "datatype": "json",
                "apikey": api_key,
            },
            {"Accept": "application/json"},
        )

    def parse_bars(self, payload: Any, symbol: str) -> pd.DataFrame:
        series = _alphavantage_series(payload, symbol)
        if not series:
            return _empty_tape()

        first = next(iter(series.values()))
        _require_both_series(
            first,
            symbol=symbol,
            backend=self.name,
            adjusted_key="5. adjusted close",
            as_traded_key="4. close",
        )

        # `from_dict(orient="index")` keys the frame BY DATE STRING, and
        # every column below is then assembled beside a freshly-built
        # date series on a RangeIndex. pandas aligns on the index when a
        # DataFrame is built from Serieses, so leaving the two disagreeing
        # produces a frame of NaN with the right shape and the right
        # dtypes — which the schema accepts and `live` then drops in
        # silence. Both sides are put on the same index first.
        frame = pd.DataFrame.from_dict(series, orient="index")
        stamps = pd.to_datetime(pd.Series(list(frame.index)), errors="coerce")
        frame = frame.reset_index(drop=True)
        return _typed(
            pd.DataFrame(
                {
                    "date": stamps,
                    # The raw block is as-traded and is NOT split
                    # adjusted, which is a complaint people file as a
                    # bug and is exactly the column this schema wants.
                    "open": _col(frame, "1. open"),
                    "high": _col(frame, "2. high"),
                    "low": _col(frame, "3. low"),
                    "close": _col(frame, "4. close"),
                    "volume": _col(frame, "6. volume"),
                    "adj_close": _col(frame, "5. adjusted close"),
                    "div_cash": _col(frame, "7. dividend amount").fillna(0.0),
                    "split_ratio": _col(frame, "8. split coefficient").fillna(1.0),
                }
            ),
            _TAPE_COLUMNS,
        )


_BACKENDS: dict[str, _Backend] = {
    b.name: b for b in (_TiingoBackend(), _AlphaVantageBackend())
}


def _resolve_backend(name: str) -> _Backend:
    key = "".join(ch for ch in str(name).lower() if ch.isalnum())
    backend = _BACKENDS.get(key)
    if backend is None:
        raise ValueError(
            f"unknown backend {name!r}; this source speaks "
            f"{sorted(_BACKENDS)}. Both are free to obtain and neither is "
            f"a default worth guessing at on a caller's behalf — the two "
            f"differ in what they will sell a free key."
        )
    return backend


# -- the source -----------------------------------------------------------


class KeyedSleeveSource(DataSource):
    """Daily bars for the sleeve ETFs from a keyed vendor, and nothing else.

    The same nine names, the same schema and the same wall as
    `SleeveETFSource`, reached through a token so that an anonymous
    endpoint's throttle is an inconvenience rather than a stop.
    """

    def __init__(
        self,
        backend: str = "tiingo",
        *,
        allowed: Iterable[str] = SLEEVE_TICKERS,
        cache: "ParquetCache | None" = None,
        session: requests.Session | None = None,
        timeout: float = 30.0,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._backend = _resolve_backend(backend)

        self._allowed = frozenset(str(t).strip().upper() for t in allowed)
        if not self._allowed:
            raise ValueError(
                "an empty allowlist is not a narrower source, it is a source "
                "that can answer nothing; pass the tickers you mean"
            )

        # Same collision check as next door and for the same reason: a
        # widened allowlist that hashed two funds onto one id would
        # merge their price histories, which is precisely the failure
        # the permaticker exists to prevent, reintroduced by the thing
        # meant to prevent it.
        self._by_permaticker: dict[int, str] = {}
        for ticker in sorted(self._allowed):
            pid = _permaticker(ticker)
            clash = self._by_permaticker.get(pid)
            if clash is not None:
                raise ValueError(
                    f"synthesised permaticker {pid} collides between "
                    f"{clash!r} and {ticker!r}; widen the id space in "
                    f"sleevedata rather than letting two funds share an id"
                )
            self._by_permaticker[pid] = ticker
        self._permaticker_of = {t: p for p, t in self._by_permaticker.items()}

        self._cache = cache
        self._session = session or requests.Session()
        self._timeout = timeout
        self._sleep = sleep
        self._clock = clock or (lambda: datetime.now(timezone.utc))

        self._tapes: dict[tuple[str, date], pd.DataFrame] = {}
        self._profiles: dict[tuple[str, date], dict[str, Any]] = {}
        self._last_request: float = float("-inf")

        # Drops, counted. A drop nobody counts is a drop nobody finds.
        self.null_bars: int = 0

        self.capabilities = SourceCapabilities(
            name=self._backend.capability_name,
            # False, and the reason is the list rather than the vendor.
            # This panel loses no dead names because it contains none —
            # nine funds, all still trading. Point the same key at a
            # universe and every name that failed is simply absent, with
            # nothing in the payload to say so. Claiming the capability
            # would let the survivorship checks report a pass earned by
            # a tautology.
            claims_survivorship_free=False,
            provides_filing_dates=False,
            provides_as_reported=False,
            # Nothing here has stopped trading, so nothing here carries
            # a delisting date. An empty answer is not a capability.
            provides_delisting_dates=False,
            provides_delisting_reasons=False,
            # False despite every row carrying one — see `_permaticker`.
            provides_permanent_ids=False,
            provides_index_membership=False,
            # True, and structurally so rather than on trust: the
            # constructor cannot produce a frame at all unless the
            # payload carried an as-traded block beside the adjusted
            # one. See `_require_both_series`.
            provides_unadjusted_prices=True,
            is_smoke_test_only=False,
        )

    # -- the door -------------------------------------------------------

    @property
    def backend(self) -> str:
        return self._backend.name

    @property
    def key_var(self) -> str:
        return self._backend.key_var

    @property
    def allowed_tickers(self) -> tuple[str, ...]:
        return tuple(sorted(self._allowed))

    def require_allowed(self, ticker: str) -> str:
        """The canonical symbol, or a raise. The only way in."""
        symbol = str(ticker).strip().upper()
        if symbol not in self._allowed:
            raise TickerNotAllowed(
                f"{symbol!r} is not a sleeve vehicle. This source serves "
                f"{sorted(self._allowed)} and refuses everything else on "
                f"purpose, and holding a paid-for-free API key changes "
                f"nothing about why: a vendor's free adjusted-close feed "
                f"only answers for symbols that still resolve today, so a "
                f"universe pulled through it is survivorship-biased by "
                f"construction and nothing downstream can tell. A key makes "
                f"that pull faster and more reliable, which is worse rather "
                f"than better. The exemption is for a hand-checked list of "
                f"large living funds; widening it here would quietly "
                f"withdraw the exemption's whole basis."
            )
        return symbol

    def permaticker_for(self, ticker: str) -> int:
        return self._permaticker_of[self.require_allowed(ticker)]

    def _resolve(self, permatickers: Iterable[int] | None) -> tuple[str, ...]:
        if permatickers is None:
            return self.allowed_tickers
        out: list[str] = []
        for raw in permatickers:
            pid = int(raw)
            ticker = self._by_permaticker.get(pid)
            if ticker is None:
                raise TickerNotAllowed(
                    f"permaticker {pid} is not one of this source's "
                    f"{len(self._allowed)} sleeve vehicles. Ids here are "
                    f"synthesised from the ticker and are shared with "
                    f"sleevedata.py by design; a permaticker from an actual "
                    f"vendor will never match one."
                )
            out.append(ticker)
        return tuple(sorted(set(out)))

    # -- the four frames ------------------------------------------------

    def security_master(self) -> pd.DataFrame:
        rows = [self._profile(t) for t in self.allowed_tickers]
        out = _typed_spec(pd.DataFrame(rows), schema.SECURITY_MASTER)
        out = out.sort_values("permaticker").reset_index(drop=True)
        return self._check(out, schema.SECURITY_MASTER)

    def prices(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
    ) -> pd.DataFrame:
        _check_window(start, end)
        frames = [self._bars(t) for t in self._resolve(permatickers)]
        frames = [f for f in frames if not f.empty]
        if not frames:
            return self._check(schema.PRICES.empty(), schema.PRICES)

        out = _typed_spec(pd.concat(frames, ignore_index=True), schema.PRICES)
        out = out.loc[out["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        out = out.sort_values(["permaticker", "date"]).reset_index(drop=True)
        # No duplicate collapse. If a vendor ever returns two bars for
        # one session the schema's primary key should say so loudly
        # rather than have this file pick a survivor on a rule nobody
        # wrote down.
        return self._check(out, schema.PRICES)

    def actions(self, start: date, end: date) -> pd.DataFrame:
        _check_window(start, end)
        frames = [self._events(t) for t in self.allowed_tickers]
        frames = [f for f in frames if not f.empty]
        if not frames:
            return self._check(schema.ACTIONS.empty(), schema.ACTIONS)

        out = _typed_spec(pd.concat(frames, ignore_index=True), schema.ACTIONS)
        out = out.loc[out["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        out = out.sort_values(["date", "ticker", "action"]).reset_index(drop=True)
        # Deliberately no delisting rows, ever. Not because none
        # happened in the window — because this source could not carry
        # one if it had. An absence produced by the allowlist must not
        # be presented as an absence observed in the market.
        return self._check(out, schema.ACTIONS)

    def fundamentals(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
        dimension: str = "ARQ",
    ) -> pd.DataFrame:
        # NotImplementedError rather than an empty frame, and rather
        # than SourceUnavailable: `audit.context.load_context` catches
        # exactly this and records `fundamentals=None`, which makes
        # every point-in-time check report UNPROVABLE — the true answer.
        # A correctly-typed empty frame would read as "these entities
        # filed nothing in this range", and the checks would grade that
        # as data.
        raise NotImplementedError(
            "this source serves sleeve ETF prices only. An ETF files no "
            "as-reported income statement, and neither vendor's free tier "
            "carries filing dates behind one — so there are no fundamentals "
            "here to return, and an empty frame would be read as a market "
            "fact rather than as the shape of the source."
        )

    # -- per-ticker frames ----------------------------------------------

    def _horizon(self) -> date:
        """How far forward every pull reaches: always today.

        Deliberately NOT the caller's `end`. Both backends hand back the
        whole history whatever is asked, so keying the cache on the
        requested window would store the same twenty years again under a
        new name every time somebody moved a date. One horizon means one
        entry per ticker per day, and every window is a slice of it. The
        narrowing to the caller's range still happens in `prices` and
        `actions`, before a row is handed out.
        """
        return self._clock().date()

    def _bars(self, ticker: str) -> pd.DataFrame:
        symbol = self.require_allowed(ticker)
        through = self._horizon()
        return self._cached(
            "prices",
            {"ticker": symbol, "end": through},
            lambda: self._build_bars(symbol, through),
        )

    def _events(self, ticker: str) -> pd.DataFrame:
        symbol = self.require_allowed(ticker)
        through = self._horizon()
        return self._cached(
            "actions",
            {"ticker": symbol, "end": through},
            lambda: self._build_events(symbol, through),
        )

    def _profile(self, ticker: str) -> dict[str, Any]:
        symbol = self.require_allowed(ticker)
        through = self._horizon()
        frame = self._cached(
            "security_master",
            {"ticker": symbol, "end": through},
            lambda: self._build_profile(symbol, through),
        )
        return {c: frame[c].iloc[0] for c in frame.columns}

    def _build_bars(self, symbol: str, through: date) -> pd.DataFrame:
        tape = self._tape(symbol, through)
        if tape.empty:
            return schema.PRICES.empty()

        # The cumulative multiplier that turns a split-adjusted price
        # back into the one that printed. Nothing here needs it to
        # RECOVER a price — both vendors publish the as-traded bar — it
        # exists only so `split_factor` carries the same units the other
        # two producers of this column use: split-adjusted close over
        # as-traded close, below one before a forward split and exactly
        # one after the last. Two sources meaning different things by
        # one column name is how a reconciliation reports a fault that
        # is really a convention.
        forward = _forward_factor(tape["date"], _split_events(tape))

        close = tape["close"]
        adj = tape["adj_close"]
        # A null bar is not a price. Neither vendor has produced one for
        # these nine, which is precisely why a silent NaN would go
        # unnoticed if one did.
        live = close.notna() & adj.notna()
        self.null_bars += int((~live).sum())

        frame = pd.DataFrame(
            {
                "permaticker": self._permaticker_of[symbol],
                "ticker": symbol,
                "date": tape["date"],
                "open_unadj": tape["open"],
                "high_unadj": tape["high"],
                "low_unadj": tape["low"],
                "close_unadj": close,
                "volume_unadj": tape["volume"],
                "close_adj": adj,
                "split_factor": 1.0 / forward,
                # Taken as-paid and left on the as-traded basis its
                # neighbouring `close_unadj` is on, which is what both
                # vendors appear to publish and is NOT what Yahoo does
                # (it back-adjusts dividend amounts through later
                # splits, so `sleevedata.py` has to undo the
                # arithmetic). This is the one field here nobody has
                # measured against a fund's own distribution history,
                # and the check that would settle it is a diff of the
                # two sources' `dividends` on EEM, which has split
                # 3-for-1 twice. It is safe to leave open only because
                # nothing computes a return from this column — returns
                # read `close_adj` — so a wrong basis here shows up as a
                # wrong yield and never as a wrong performance number.
                "dividends": tape["div_cash"],
            }
        )
        return _typed_spec(frame.loc[live], schema.PRICES)

    def _build_events(self, symbol: str, through: date) -> pd.DataFrame:
        tape = self._tape(symbol, through)
        if tape.empty:
            return schema.ACTIONS.empty()

        pid = self._permaticker_of[symbol]
        name = self._profile_fields(symbol, through).get("name") or symbol

        rows: list[dict[str, Any]] = []
        for when, ratio in _split_events(tape):
            rows.append(
                {
                    "date": when,
                    "action": "split",
                    "ticker": symbol,
                    "permaticker": pid,
                    "name": name,
                    # New shares per old share: 3.0 for a 3-for-1, 0.5
                    # for a 1-for-2 reverse. One number, signed by which
                    # side of one it falls on.
                    "value": float(ratio),
                }
            )

        paid = tape.loc[tape["div_cash"].fillna(0.0) != 0.0]
        for when, amount in zip(paid["date"], paid["div_cash"]):
            rows.append(
                {
                    "date": when,
                    "action": "dividend",
                    "ticker": symbol,
                    "permaticker": pid,
                    "name": name,
                    "value": float(amount),
                }
            )

        if not rows:
            return schema.ACTIONS.empty()
        return _typed_spec(pd.DataFrame(rows), schema.ACTIONS)

    def _build_profile(self, symbol: str, through: date) -> pd.DataFrame:
        fields = self._profile_fields(symbol, through)
        tape = self._tape(symbol, through)

        first = fields.get("first_price_date")
        last = fields.get("last_price_date")
        if not tape.empty:
            # The bars are the better witness where both exist: a
            # vendor's stated coverage window and the rows it actually
            # served have been known to disagree, and the rows are the
            # thing every downstream check reads.
            first = tape["date"].iloc[0] if first is None else min(
                first, tape["date"].iloc[0]
            )
            last = tape["date"].iloc[-1] if last is None else max(
                last, tape["date"].iloc[-1]
            )

        row = {
            "permaticker": self._permaticker_of[symbol],
            "ticker": symbol,
            # The ticker where the vendor publishes no fund name, which
            # is the case for Alpha Vantage's ETF coverage. A plausible
            # invented name is worse than an obviously derived one: the
            # first invites a join, the second refuses it on sight.
            "name": fields.get("name") or symbol,
            # Today's listing venue with no history behind it. This
            # column is NOT point-in-time and nothing needing a venue as
            # of a past date may read it.
            "exchange": fields.get("exchange") or "",
            "category": ETF_CATEGORY,
            # Always False, and a tautology rather than a finding — see
            # the capabilities block.
            "is_delisted": False,
            "first_price_date": first,
            "last_price_date": last,
            "currency": "USD",
        }
        return _typed_spec(pd.DataFrame([row]), schema.SECURITY_MASTER)

    def _profile_fields(self, symbol: str, through: date) -> dict[str, Any]:
        memo = (symbol, through)
        if memo not in self._profiles:
            if not self._backend.has_profile_endpoint:
                self._profiles[memo] = {}
                return self._profiles[memo]
            request = self._backend.profile_request(symbol, self._require_key())
            if request is None:
                self._profiles[memo] = {}
            else:
                url, params, headers = request
                payload = self._get(url, params, headers, symbol)
                self._profiles[memo] = self._backend.parse_profile(payload, symbol)
        return self._profiles[memo]

    # -- transport ------------------------------------------------------

    def _tape(self, symbol: str, through: date) -> pd.DataFrame:
        """The normalised bar tape, one HTTP call per ticker per day.

        Memoised on the instance because the bars, the actions and the
        master all read the same payload, and three round trips for one
        answer is how a polite client becomes a rude one — against Alpha
        Vantage's twenty-five requests a day it is also how a nine-name
        pull fails a third of the way through.
        """
        memo = (symbol, through)
        if memo not in self._tapes:
            url, params, headers = self._backend.bars_request(
                symbol, self._require_key(), through
            )
            payload = self._get(url, params, headers, symbol)
            tape = self._backend.parse_bars(payload, symbol)
            self._tapes[memo] = tape.sort_values("date").reset_index(drop=True)
        return self._tapes[memo]

    def _require_key(self) -> str:
        """The key, or a raise that says which one and where it is free.

        Checked here rather than in the constructor, on purpose. A
        reviewer holding the cached parquet directory and no credentials
        must still be able to build this object and read every frame out
        of it — that is the whole argument `cache.py` makes for existing.
        Demanding a key up front would make the saved pull unreadable to
        exactly the person it was saved for.
        """
        key = os.environ.get(self._backend.key_var, "").strip()
        if not key:
            key = _key_from_dotenv(self._backend.key_var)
        if not key:
            raise SourceUnavailable(
                f"{self._backend.key_var} is not set, so the "
                f"{self._backend.name} backend cannot be reached. This is an "
                f"unconfigured source and NOT an empty date range — the two "
                f"look identical one layer down and mean opposite things, and "
                f"a missing key reported as a quiet period is how an outage "
                f"becomes a fact about the market. A key is free and takes "
                f"under a minute: {self._backend.signup_url}. Set it and "
                f"nothing else in this repository has to change."
            )
        return key

    def _get(
        self,
        url: str,
        params: dict[str, str],
        headers: dict[str, str],
        symbol: str,
    ) -> Any:
        last_reason = "no attempt was made"

        for attempt in range(MAX_ATTEMPTS):
            if attempt:
                self._sleep(
                    min(BACKOFF_BASE_SECONDS * 2 ** (attempt - 1), BACKOFF_CAP_SECONDS)
                )
            else:
                self._pace()
            try:
                response = self._session.get(
                    url, params=params, headers=headers, timeout=self._timeout
                )
            except requests.RequestException as exc:
                last_reason = f"{type(exc).__name__}: {exc}"
                continue

            if response.status_code == 200:
                try:
                    return response.json()
                except ValueError as exc:
                    raise SourceUnavailable(
                        f"{symbol}: {self._backend.name} answered 200 with a "
                        f"body that is not JSON — {(response.text or '')[:200]}"
                    ) from exc

            if response.status_code in (401, 403):
                raise SourceUnavailable(
                    f"{symbol}: {self._backend.name} refused the key (HTTP "
                    f"{response.status_code}). {self._backend.key_var} is set "
                    f"but is not being accepted — check it against "
                    f"{self._backend.signup_url}. This is a credential "
                    f"problem, not an empty range."
                )
            if response.status_code == 404:
                raise SourceUnavailable(
                    f"{symbol}: {self._backend.name} does not know this "
                    f"symbol (404). For a sleeve vehicle that is a ticker "
                    f"change or a typo in the allowlist — never an empty "
                    f"range."
                )
            if response.status_code in RETRY_STATUSES:
                last_reason = f"HTTP {response.status_code}"
                continue

            raise SourceUnavailable(
                f"{symbol}: {self._backend.name} returned HTTP "
                f"{response.status_code} — {(response.text or '')[:200]}"
            )

        raise SourceUnavailable(
            f"{symbol}: {self._backend.name} unreachable after "
            f"{MAX_ATTEMPTS} attempts. Last: {last_reason}. No rows were "
            f"returned and none were claimed — this is not an empty range."
        )

    def _pace(self) -> None:
        """Keep our own burst under the rate the vendor tolerates.

        `monotonic` rather than the injected clock: that one exists so
        cache stamps can be made deterministic in a test, and a frozen
        clock must not silently become a decision about how fast we are
        allowed to talk to somebody else's server.
        """
        waited = time.monotonic() - self._last_request
        if 0.0 <= waited < MIN_REQUEST_INTERVAL_SECONDS:
            self._sleep(MIN_REQUEST_INTERVAL_SECONDS - waited)
        self._last_request = time.monotonic()

    def _cached(
        self,
        frame: str,
        params: dict[str, Any],
        loader: Callable[[], pd.DataFrame],
    ) -> pd.DataFrame:
        """Read through the shared cache root, under our OWN source slug.

        The root is shared with `sleevedata.py` so a reviewer gets one
        directory and neither source needs the network twice. The slug
        is not shared, and that is the load-bearing half: an entry
        written by one source serving the other would make
        `reconcile_sources` diff a frame against itself and report
        perfect agreement — a reconciliation's most dangerous possible
        output, since it is indistinguishable from the real thing.
        """
        if self._cache is None:
            return loader()
        key = self._cache.key(self._backend.slug, frame, **params)
        now = self._clock()
        # `end` is today, so cache.py reads every entry here as an open
        # range and gives it a one-day life — right rather than a missed
        # optimisation, since this history grows a bar each session. A
        # loader that raises leaves no entry at all, by doing nothing.
        return self._cache.get_or_load(key, loader, stamped=now, now=now)


# -- the refusal ----------------------------------------------------------


def _require_both_series(
    row: dict[str, Any],
    *,
    symbol: str,
    backend: str,
    adjusted_key: str,
    as_traded_key: str,
) -> None:
    """Refuse a half-adjusted tape, in either direction.

    Not a degraded mode and not a warning. Both failures produce a
    complete, well-typed, entirely plausible frame, and each deletes a
    different half of the work:

    No adjusted close and every return in the system becomes a price
    return. Over 2004-2026 TLT returned -2.6% on price and +105.8% on
    total return; LQD -3.2% and +141.4%. For the duration and credit
    sleeves nearly all of the return is coupon, so this is not an
    approximation — it removes the defensive half of the strategy and
    leaves the numbers looking fine.

    No as-traded close and the price and liquidity screens read
    back-adjusted numbers. A vehicle that actually traded at $11 in 2003
    and has split 3-for-1 twice reads at $101 in adjusted terms and
    passes a floor it could never have passed on the day, which is
    lookahead wearing a price's clothes.
    """
    has_adjusted = adjusted_key in row and row[adjusted_key] is not None
    has_as_traded = as_traded_key in row and row[as_traded_key] is not None

    if not has_adjusted:
        raise SourceUnavailable(
            f"{symbol}: the {backend} payload carries {as_traded_key!r} but "
            f"no {adjusted_key!r}, so there is no total-return series. "
            f"Refusing to substitute the as-traded close: it is "
            f"dividend-unadjusted, and for the bond and credit sleeves "
            f"essentially all of the return is the coupon — TLT returned "
            f"-2.6% on price and +105.8% on total return over 2004-2026. "
            f"The substitution would not be approximate, it would delete "
            f"the defensive half of the strategy and look fine doing it. A "
            f"source that cannot supply a dividend-adjusted series is "
            f"useless to this project however good its prices are."
        )
    if not has_as_traded:
        raise SourceUnavailable(
            f"{symbol}: the {backend} payload carries {adjusted_key!r} but "
            f"no {as_traded_key!r}, so there is no as-traded price. Refusing "
            f"to map the adjusted series onto both columns: the price and "
            f"participation screens read the unadjusted close, and a "
            f"back-adjusted number passes floors the security could never "
            f"have passed on the day. An adjusted-only feed is a refusal "
            f"here, not a degraded mode."
        )


def _tiingo_rows(payload: Any, symbol: str) -> list[dict[str, Any]]:
    """The bar list, or a raise that names what came back instead.

    A dict here is Tiingo's error envelope (`{"detail": ...}`) delivered
    where a list was expected. An empty list is a genuinely empty range
    and is allowed through — that distinction is the whole reason this
    function exists rather than an `or []`.
    """
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        detail = payload.get("detail") or payload.get("message") or payload
        raise SourceUnavailable(
            f"{symbol}: Tiingo answered with an error object rather than a "
            f"bar list — {str(detail)[:200]}"
        )
    raise SourceUnavailable(
        f"{symbol}: Tiingo returned {type(payload).__name__}, not a bar list."
    )


def _alphavantage_series(payload: Any, symbol: str) -> dict[str, dict[str, Any]]:
    """The time series, after the body has been read for a refusal.

    Alpha Vantage answers HTTP 200 to everything. Throttling, an unknown
    symbol and the premium wall all arrive as a 200 carrying
    `Information`, `Note` or `Error Message` and no series at all, so a
    client that trusts the status code reads each of them as a
    successful empty range. The body is therefore inspected first, and
    the premium case is called out by name because it is the one a free
    key will actually hit.
    """
    if not isinstance(payload, dict):
        raise SourceUnavailable(
            f"{symbol}: Alpha Vantage returned {type(payload).__name__}, "
            f"not a JSON object."
        )

    series = payload.get("Time Series (Daily)")
    if isinstance(series, dict) and series:
        # A body carrying real bars is the answer, even when a courtesy
        # note rides along with it. The message keys are read only when
        # there is nothing to read instead — otherwise an advisory about
        # quota would throw away a pull that arrived intact.
        return {str(k): v for k, v in series.items() if isinstance(v, dict)}

    for key in ("Error Message", "Information", "Note"):
        message = payload.get(key)
        if not message:
            continue
        text = str(message)
        if "premium" in text.lower():
            raise SourceUnavailable(
                f"{symbol}: {ALPHAVANTAGE_FUNCTION} is a premium Alpha "
                f"Vantage endpoint and {ALPHAVANTAGE_KEY_VAR} is a free key "
                f"— {text[:200]}. This is the whole shape of Alpha Vantage's "
                f"free tier: TIME_SERIES_DAILY is free and carries as-traded "
                f"OHLCV with NOTHING adjusted, and the adjusted close sits "
                f"behind the paywall. Deliberately not falling back to the "
                f"free function: it would hand back a price-return series, "
                f"and TLT returned -2.6% on price against +105.8% on total "
                f"return over 2004-2026 — for the bond sleeves the coupon is "
                f"the entire return. Use the Tiingo backend, which gives "
                f"both series on a free key, or buy the premium plan."
            )
        raise SourceUnavailable(
            f"{symbol}: Alpha Vantage answered HTTP 200 with {key!r} and no "
            f"time series — {text[:200]}. The free key allows 25 requests a "
            f"day and 5 a minute, and exhausting either is reported exactly "
            f"like this. Not an empty range."
        )

    if series is None:
        raise SourceUnavailable(
            f"{symbol}: Alpha Vantage returned no 'Time Series (Daily)' "
            f"block and no error to explain it. Keys present: "
            f"{sorted(payload)[:10]}."
        )
    if not isinstance(series, dict):
        raise SourceUnavailable(
            f"{symbol}: Alpha Vantage's time series is a "
            f"{type(series).__name__}, not an object keyed by date."
        )
    # Present and empty, with nothing above explaining it. Genuinely an
    # empty range, and the caller's frame says so.
    return {}


# -- module helpers -------------------------------------------------------


def _empty_tape() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in _TAPE_COLUMNS.items()})


def _col(frame: pd.DataFrame, name: str) -> pd.Series:
    """One numeric column, or a column of NaN where the vendor sent none.

    NaN rather than zero for an absent column: a volume of zero is a
    session in which nothing traded, which is a claim, and a high of
    zero would pass a price floor from the wrong side.
    """
    if name not in frame.columns:
        return pd.Series([float("nan")] * len(frame), dtype="float64")
    return pd.to_numeric(frame[name], errors="coerce").astype("float64")


def _split_events(tape: pd.DataFrame) -> list[tuple[pd.Timestamp, float]]:
    """Ex-date and new-shares-per-old-share, oldest first.

    A ratio of exactly one is an ordinary session, which is how both
    vendors spell "no split" — so the events are the rows that differ
    from one, and a float comparison is not good enough to decide that.
    """
    ratios = tape["split_ratio"].fillna(1.0).to_numpy(dtype="float64")
    moved = ~np.isclose(ratios, 1.0, rtol=0.0, atol=1e-9)
    dates = pd.DatetimeIndex(tape["date"])
    return sorted(
        (dates[i], float(ratios[i])) for i in np.flatnonzero(moved) if ratios[i] > 0.0
    )


def _forward_factor(
    dates: pd.Series, splits: Sequence[tuple[pd.Timestamp, float]]
) -> np.ndarray:
    """Multiply a split-adjusted price by this to get the printed one.

    The product of every split ratio dated STRICTLY AFTER the bar.
    Strictly, because the ex-date's own bar already trades post-split. A
    loop over the events rather than a clever suffix product: no sleeve
    vehicle has had more than two splits in twenty years, and the
    readable version is the one still checkable at 2am after a bad print.
    """
    factor = np.ones(len(dates), dtype="float64")
    if not splits:
        return factor
    as_np = pd.DatetimeIndex(dates).to_numpy()
    for when, ratio in splits:
        factor = np.where(as_np < np.datetime64(when), factor * ratio, factor)
    return factor


def _clean_name(raw: Any, symbol: str) -> str:
    if raw is None:
        return symbol
    # Non-breaking spaces turn up in fund names, and a name that does
    # not match itself across two pulls is a join waiting to fail.
    return " ".join(str(raw).split()) or symbol


def _venue(raw: Any) -> str:
    if raw is None:
        return ""
    text = " ".join(str(raw).split()).upper()
    return _EXCHANGES.get(text, text)


def _stamp(raw: Any) -> pd.Timestamp | None:
    if raw in (None, ""):
        return None
    stamp = pd.to_datetime(raw, errors="coerce", utc=True)
    if pd.isna(stamp):
        return None
    return stamp.tz_localize(None).normalize()


def _check_window(start: date, end: date) -> None:
    if start > end:
        # An empty frame here would report a caller's reversed window as
        # "nothing traded in that period", which is the most expensive
        # sentence this file could say quietly.
        raise ValueError(f"start {start.isoformat()} is after end {end.isoformat()}")


def _typed(df: pd.DataFrame, dtypes: dict[str, str]) -> pd.DataFrame:
    built = {
        column: _cast(df[column], dtype)
        for column, dtype in dtypes.items()
        if column in df.columns
    }
    out = pd.DataFrame(built)
    out.index = pd.RangeIndex(len(out))
    return out


def _typed_spec(df: pd.DataFrame, spec: schema.FrameSpec) -> pd.DataFrame:
    """Coerce to a schema spec's dtypes, dropping anything it does not name.

    A near-twin of `sleevedata._typed`, written out again rather than
    imported. The shared authority between the two sources is the SPEC,
    which pins every dtype and is validated on the way out of both; a
    private helper is not a contract, and importing one would create a
    coupling that the next person editing either file cannot see.
    """
    return _typed(df, {**spec.required, **spec.optional})


def _cast(series: pd.Series, dtype: str) -> pd.Series:
    if dtype.startswith("datetime64"):
        return pd.to_datetime(series, errors="coerce").astype("datetime64[ns]")
    if dtype == "float64":
        return pd.to_numeric(series, errors="coerce").astype("float64")
    if dtype == "Int64":
        return pd.to_numeric(series, errors="coerce").astype("Int64")
    if dtype == "int64":
        return pd.to_numeric(series, errors="coerce").astype("int64")
    if dtype == "bool":
        return series.astype("bool")
    return series.astype("str")


# -- reconciliation -------------------------------------------------------


#: What gets compared unless the caller says otherwise. Both, and the
#: pairing is the point: `close_adj` is what every return is computed
#: from and `close_unadj` is what every price and participation screen
#: reads, so checking one of them leaves half the system unverified.
RECONCILE_COLUMNS: tuple[str, ...] = ("close_unadj", "close_adj")

#: Columns compared as levels — an as-traded price is a number that
#: printed, and two vendors reporting it differently is a fault.
_LEVEL_COLUMNS = frozenset(
    {"open_unadj", "high_unadj", "low_unadj", "close_unadj", "volume_unadj"}
)

#: Columns compared as RETURNS. A back-adjusted series is anchored at
#: whichever bar the vendor last had, so two pulls that ended on
#: different days differ by a constant factor at every point while being
#: identical in every way that matters. Diffing those levels reports
#: 100% disagreement on two series that agree perfectly, which is the
#: fastest way to make a reconciliation useless: it cries wolf on the
#: one column the whole strategy's return comes out of.
_RETURN_COLUMNS = frozenset({"close_adj", "adj_close"})

_RECONCILIATION_DTYPES: dict[str, str] = {
    "ticker": "str",
    "date": "datetime64[ns]",
    "column": "str",
    "basis": "str",
    "kind": "str",
    "a": "float64",
    "b": "float64",
    "diff_bps": "float64",
}


def reconcile_sources(
    a: pd.DataFrame,
    b: pd.DataFrame,
    tolerance_bps: float = 10.0,
    *,
    columns: Sequence[str] = RECONCILE_COLUMNS,
) -> pd.DataFrame:
    """Where two sources disagree about one ticker, and by how much.

    `LIMITATIONS.md` names an independent second price source and a
    bar-for-bar diff as the cheapest thing that would raise confidence
    in this data, because every check that exists today compares the
    data against itself: a consistently wrong close, a stale bar carried
    across a halt, an adjustment factor mis-scaled the same way
    everywhere — all of them preserve internal consistency and pass. Two
    vendors making the identical mistake is the residual risk and it is
    a much smaller one.

    Returns one row per disagreement, never a verdict. Columns:
    `ticker`, `date`, `column`, `basis`, `kind`, `a`, `b`, `diff_bps`.
    An empty frame means the two agreed everywhere inside the tolerance
    AND on which days existed at all.

    Four decisions shape it, and each closes a way of reporting a false
    clean.

    **The calendars are compared before the values.** A date one source
    has and the other does not is reported as `only_in_a` / `only_in_b`
    rather than dropped, because an inner join reconciles the
    intersection and calls it agreement on a window where one source is
    missing a third of its sessions. Those rows carry no `diff_bps` —
    there is no magnitude — so they ignore the tolerance entirely.

    **Adjusted columns are compared as returns, level columns as
    levels.** See `_RETURN_COLUMNS`. Both series' returns are taken over
    the SHARED date index rather than each vendor's own, so a session
    they both lack cannot manufacture a difference.

    **The magnitude is symmetric.** A level difference is divided by the
    mean of the two absolute values, not by one of them, so
    `reconcile_sources(a, b)` and `reconcile_sources(b, a)` report the
    same number and nobody has to remember which argument was the
    reference. A return difference is not divided at all: a return is
    already a fraction, so the honest unit is the arithmetic gap in
    basis points, and dividing two near-zero returns by each other
    produces enormous numbers on days when nothing happened.

    **Nothing empty is allowed to look like agreement.** An empty frame,
    a mismatched ticker, or windows that do not overlap all raise. A
    reconciliation that ran against nothing must never be able to return
    the same value as one that ran and found nothing.
    """
    if tolerance_bps < 0:
        raise ValueError(f"tolerance_bps must be non-negative, got {tolerance_bps}")
    wanted = tuple(dict.fromkeys(columns))
    if not wanted:
        raise ValueError("no columns to compare; pass at least one")

    left, ticker_a = _reconcilable(a, "a", wanted)
    right, ticker_b = _reconcilable(b, "b", wanted)

    if ticker_a != ticker_b:
        raise ValueError(
            f"these frames are about different securities: a holds "
            f"{ticker_a!r} and b holds {ticker_b!r}. Reconciling across "
            f"tickers would compare one fund's Tuesday with another's."
        )

    left = left.set_index("date").sort_index()
    right = right.set_index("date").sort_index()

    rows: list[dict[str, Any]] = []
    only_a = left.index.difference(right.index)
    only_b = right.index.difference(left.index)
    for when in only_a:
        rows.append(_calendar_row(ticker_a, when, "only_in_a"))
    for when in only_b:
        rows.append(_calendar_row(ticker_a, when, "only_in_b"))

    shared = left.index.intersection(right.index)
    if len(shared) == 0:
        raise ValueError(
            f"{ticker_a}: these two frames share no dates at all "
            f"(a: {left.index.min().date()}..{left.index.max().date()}, "
            f"b: {right.index.min().date()}..{right.index.max().date()}). "
            f"Returning an empty result here would be indistinguishable "
            f"from two sources agreeing on every bar."
        )

    for column in wanted:
        basis = "return" if column in _RETURN_COLUMNS else "level"
        sa = left.loc[shared, column].astype("float64")
        sb = right.loc[shared, column].astype("float64")
        if basis == "return":
            # Taken over the shared index for both, so a session
            # neither vendor has is a gap they cross identically. The
            # first shared date has no predecessor and drops out —
            # which means a one-day overlap yields nothing on an
            # adjusted column, and that is the correct answer rather
            # than a silent pass.
            sa, sb = _returns(sa), _returns(sb)

        rows.extend(_value_rows(ticker_a, column, basis, sa, sb, tolerance_bps))

    if not rows:
        return _empty_reconciliation()
    out = _typed(pd.DataFrame(rows), _RECONCILIATION_DTYPES)
    return out.sort_values(["date", "column", "kind"]).reset_index(drop=True)


def _reconcilable(
    df: pd.DataFrame, side: str, columns: Sequence[str]
) -> tuple[pd.DataFrame, str]:
    if not isinstance(df, pd.DataFrame):
        raise TypeError(f"{side}: expected a DataFrame, got {type(df).__name__}")

    needed = ["ticker", "date", *columns]
    missing = [c for c in dict.fromkeys(needed) if c not in df.columns]
    if missing:
        raise ValueError(
            f"{side}: missing column(s) {missing}. A reconciliation that "
            f"silently skipped a column it was asked for would report "
            f"agreement it never tested."
        )
    if df.empty:
        raise ValueError(
            f"{side}: no rows. An empty frame cannot disagree with anything, "
            f"so reconciling one would return the same clean result as a "
            f"pull that matched bar for bar."
        )

    out = df.loc[:, list(dict.fromkeys(needed))].copy()

    # Which security, before which sessions. Ordered that way because a
    # frame holding two tickers also holds every date twice, and
    # reporting that as a duplicated session would send the reader
    # looking for a vendor fault that is really a caller passing the
    # whole panel where one name was wanted.
    names = sorted({str(t) for t in out["ticker"].unique()})
    if len(names) != 1:
        raise ValueError(
            f"{side}: expected one ticker, found {names}. Reconcile one "
            f"security at a time and loop — for nine ETFs that is three "
            f"lines, and a merge across tickers on date alone cross-joins."
        )

    out["date"] = pd.to_datetime(out["date"], errors="coerce").dt.normalize()
    if out["date"].isna().any():
        raise ValueError(f"{side}: {int(out['date'].isna().sum())} unparseable date(s)")

    dupes = int(out.duplicated(subset=["date"]).sum())
    if dupes:
        # A duplicated date fans the alignment out and every downstream
        # count doubles. Loud here rather than as a strange row count.
        raise ValueError(
            f"{side}: {dupes} duplicate date(s). Two bars for one session "
            f"cannot be reconciled without first deciding which one is the "
            f"bar, and that decision does not belong in a diff."
        )
    return out, names[0]


def _returns(series: pd.Series) -> pd.Series:
    prior = series.shift(1)
    # A non-positive prior close is a corrupt bar, and a return computed
    # from one is a number with no meaning rather than a large one.
    return ((series / prior) - 1.0).where(prior > 0.0)


def _value_rows(
    ticker: str,
    column: str,
    basis: str,
    sa: pd.Series,
    sb: pd.Series,
    tolerance_bps: float,
) -> list[dict[str, Any]]:
    va = sa.to_numpy(dtype="float64")
    vb = sb.to_numpy(dtype="float64")
    both_nan = np.isnan(va) & np.isnan(vb)
    one_nan = (np.isnan(va) ^ np.isnan(vb))

    if basis == "return":
        diff = (va - vb) * 10_000.0
    else:
        denom = (np.abs(va) + np.abs(vb)) / 2.0
        with np.errstate(divide="ignore", invalid="ignore"):
            diff = np.where(denom > 0.0, (va - vb) / denom * 10_000.0, 0.0)

    rows: list[dict[str, Any]] = []
    for i, when in enumerate(sa.index):
        if both_nan[i]:
            # Neither vendor claims a value. Nothing to reconcile, and
            # on a return basis this is just the first shared session.
            continue
        if one_nan[i]:
            rows.append(
                {
                    "ticker": ticker,
                    "date": when,
                    "column": column,
                    "basis": basis,
                    "kind": "missing_value",
                    "a": va[i],
                    "b": vb[i],
                    "diff_bps": float("nan"),
                }
            )
            continue
        if abs(diff[i]) > tolerance_bps:
            rows.append(
                {
                    "ticker": ticker,
                    "date": when,
                    "column": column,
                    "basis": basis,
                    "kind": "value",
                    "a": va[i],
                    "b": vb[i],
                    "diff_bps": float(diff[i]),
                }
            )
    return rows


def _calendar_row(ticker: str, when: pd.Timestamp, kind: str) -> dict[str, Any]:
    return {
        "ticker": ticker,
        "date": when,
        "column": "",
        "basis": "calendar",
        "kind": kind,
        "a": float("nan"),
        "b": float("nan"),
        "diff_bps": float("nan"),
    }


def _empty_reconciliation() -> pd.DataFrame:
    return pd.DataFrame(
        {c: pd.Series([], dtype=t) for c, t in _RECONCILIATION_DTYPES.items()}
    )
