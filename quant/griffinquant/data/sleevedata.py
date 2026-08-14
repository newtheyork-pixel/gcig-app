"""Sleeve ETF prices from a free endpoint, behind a locked door.

`pyproject.toml` rules out free price APIs and gives four reasons: no
permanent entity id, no delisted names, no as-reported fundamentals,
and an adjusted series offered without an as-traded partner. Every one
of those is a statement about a survivorship-biased panel of single
names, and every one of them is right. None of them is a statement
about nine named, living, very large exchange-traded funds.

That is the entire argument for this file, and it holds only while the
list stays nine names long. So the list is not a convention here, it is
a wall. `SLEEVE_TICKERS` is taken at construction, every request is
checked against it, and anything else raises `TickerNotAllowed`. A rule
written as a warning gets skipped by somebody in a hurry in six months,
and what it lets through is silent: a scraped panel of survivors that
audits clean and backtests beautifully, because the names that would
have hurt were never served. A rule written as a raise cannot be
skipped in a hurry.

Three traps, each measured against the live endpoint rather than
assumed.

**`close` is not the as-traded price.** Yahoo split-adjusts the OHLC,
the volume and the dividend amounts, and dividend-adjusts only
`adjclose`. Mapping `close` onto `close_unadj` is right for six of the
nine and wrong for EFA, EEM and BIL: EEM's first bar reads $11.22
against a real launch price near $101, two 3-for-1 splits' worth of
every price screen reading a number nobody could trade. The as-traded
bar is recovered exactly from the split events, which is what makes
`provides_unadjusted_prices` a fact instead of an aspiration.

**A missing User-Agent comes back 429.** Not 401, not 403 — the status
a genuine rate limit uses. A retry loop backs off politely and forever
against a header it never sent. The Mozilla string is therefore a
requirement, and the throttling message says out loud that the header
is the first thing to check.

**Returns come from `close_adj`, always.** TLT returned -2.6% on price
and +105.8% on total return over 2004-2026; LQD -3.2% and +141.4%. A
sleeve return computed from `close_unadj` does not understate the
defensive half of this strategy, it deletes it. So a payload with no
`adjclose` block is a hard error here and never a quiet fallback to
`close` — the fallback would produce a complete, plausible, ruinous
frame.

The cash leg is separate and is not a ticker. It compounds FRED's
`DTB3` into a total-return index for the years before BIL listed, read
through the keyless graph endpoint in `tbill.py` — the authenticated
observations API serves the same numbers and adds a credential that can
be missing on the one machine running the backtest. If FRED is
unreachable the leg raises rather than reaching for SHY or any other
duration-carrying stand-in; see the cash splice in
`portfolio/sleeves.py` for why every ETF substitute is the wrong
instrument.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Callable, Iterable, Sequence
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

import numpy as np
import pandas as pd
import requests

from ..portfolio.sleeves import CASH_FRED_SERIES, SLEEVE_TICKERS
from . import schema
from .base import DataSource, SourceCapabilities, SourceUnavailable
from .tbill import TbillUnavailable, fetch_observations, total_return_index

if TYPE_CHECKING:
    from .cache import ParquetCache


CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"

#: The cache directory this source owns. A slug rather than the
#: capability name, because the name carries prose that may be reworded
#: and a reworded directory is a cache nobody hits again.
SOURCE_SLUG = "yahoo-sleeve-etf"

#: Required, and the reason is in the module docstring: without it the
#: endpoint answers 429, which reads as throughput and is not.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

#: 429 plus the 5xx range. A 404 is an answer — the symbol does not
#: resolve — and retrying it just says so again, more slowly.
RETRY_STATUSES = frozenset({429, *range(500, 512)})

#: Patient on purpose. The whole panel is nine calls that are then
#: cached for good, so waiting half a minute once is free, and the
#: alternative is failing an audit over a throttle that would have
#: lifted. 2, 4, 8, 16 seconds.
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 2.0
BACKOFF_CAP_SECONDS = 30.0

#: A floor on the gap between calls, because the throttle above is not
#: hypothetical — a burst of full-history pulls provoked it during
#: development, and nine back-to-back requests is exactly that burst.
#: Four seconds spread across a pull that happens once is a better
#: trade than a retry loop that has already been refused.
MIN_REQUEST_INTERVAL_SECONDS = 0.5

#: Where synthesised entity ids live. Chosen high and round so that a
#: collision with a real vendor id is obvious on sight rather than
#: silent: Sharadar's permatickers are six and seven digits, so a
#: nine-digit id starting with a 9 cannot be mistaken for one.
PERMATICKER_BASE = 900_000_000
PERMATICKER_SPAN = 10_000_000

#: DTB3 is quoted as a DISCOUNT rate against face value on a 360-day
#: year, which is not a number that can be compounded as it stands.
#: `tbill.py` sidesteps the conversion by reading the constant-maturity
#: series instead; this file cannot, because `sleeves.py` pins
#: `CASH_FRED_SERIES` to DTB3 and the cash splice's written
#: justification names it. Code that read a different series than the
#: audit trail claims would make the trail a lie, so the conversion is
#: done here instead. A 13-week bill runs 91 days.
BILL_TENOR_DAYS = 91
DISCOUNT_YEAR = 360.0
INVESTMENT_YEAR = 365.0

#: Yahoo's venue strings mapped onto `config.ALLOWED_EXCHANGES`. An
#: unmapped venue passes through under its own name rather than
#: defaulting to a plausible one — being visibly unrecognised is worth
#: more than being quietly wrong.
_EXCHANGES = {
    "NYSEArca": "NYSEARCA",
    "PCX": "NYSEARCA",
    "NasdaqGM": "NASDAQ",
    "NasdaqGS": "NASDAQ",
    "NasdaqCM": "NASDAQ",
    "NMS": "NASDAQ",
    "NYSE": "NYSE",
    "NYSEAmerican": "NYSEMKT",
    "BATS": "BATS",
}

#: Every sleeve vehicle is a fund, and saying so in the vendor's own
#: vocabulary is what keeps them out of the single-name layer:
#: `config.SINGLE_NAME_CATEGORIES` does not contain this string and
#: `VENDOR_CATEGORY_EXCLUSIONS` does.
ETF_CATEGORY = "ETF"


class TickerNotAllowed(ValueError):
    """A symbol was requested that this source is not permitted to serve.

    A caller bug, deliberately loud. The allowlist is the only thing
    standing between "nine funds that happen to have survived" and a
    free quote endpoint pointed at whatever a strategy asked for, and
    the second of those cannot be detected downstream — it looks like
    data.
    """


class SleeveETFSource(DataSource):
    """Daily bars for the sleeve ETFs, and nothing else, ever."""

    capabilities = SourceCapabilities(
        name="Yahoo chart endpoint (sleeve ETFs only)",
        # False, and the reason matters more than the flag. This panel
        # loses no dead names because the allowlist contains no dead
        # names — it is nine funds that are all still trading. That is
        # a property of the LIST, not of the source: point the same
        # endpoint at a universe and every name that failed is simply
        # absent, with nothing in the payload to say so. Claiming the
        # capability would let the survivorship checks run and report a
        # pass earned by a tautology.
        claims_survivorship_free=False,
        provides_filing_dates=False,
        provides_as_reported=False,
        # Nothing here has stopped trading, so nothing here has a
        # delisting date to carry. An empty answer is not a capability.
        provides_delisting_dates=False,
        provides_delisting_reasons=False,
        # False, despite `permaticker` being populated on every row.
        # The ids below are a hash OF THE TICKER STRING, so they carry
        # exactly the information the string already carried and cannot
        # survive a symbol change — which is the one thing the
        # capability is about. See `synthetic_permaticker`.
        provides_permanent_ids=False,
        provides_index_membership=False,
        # True on the strength of the split-event reconstruction, not
        # of a vendor column: Yahoo publishes no as-traded series, and
        # the events block is what makes one recoverable exactly.
        provides_unadjusted_prices=True,
        # Not a smoke test. This is the production source for the
        # sleeve layer — narrow, but real.
        is_smoke_test_only=False,
    )

    def __init__(
        self,
        *,
        allowed: Iterable[str] = SLEEVE_TICKERS,
        cache: "ParquetCache | None" = None,
        session: requests.Session | None = None,
        timeout: float = 30.0,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._allowed = frozenset(str(t).strip().upper() for t in allowed)
        if not self._allowed:
            raise ValueError(
                "an empty allowlist is not a narrower source, it is a source "
                "that can answer nothing; pass the tickers you mean"
            )

        # Synthesised ids are only usable as a key if they are unique.
        # Nine names will never collide in ten million slots, but the
        # allowlist is an argument and a caller may widen it, and a
        # collision would silently merge two funds' price histories
        # into one series — the exact failure the permaticker exists to
        # prevent, reintroduced by the thing meant to prevent it.
        self._by_permaticker: dict[int, str] = {}
        for ticker in sorted(self._allowed):
            pid = synthetic_permaticker(ticker)
            clash = self._by_permaticker.get(pid)
            if clash is not None:
                raise ValueError(
                    f"synthesised permaticker {pid} collides between "
                    f"{clash!r} and {ticker!r}; widen PERMATICKER_SPAN "
                    f"rather than letting two funds share an id"
                )
            self._by_permaticker[pid] = ticker
        self._permaticker_of = {t: p for p, t in self._by_permaticker.items()}

        self._cache = cache
        self._session = session or requests.Session()
        self._timeout = timeout
        self._sleep = sleep
        self._clock = clock or (lambda: datetime.now(timezone.utc))

        # One HTTP call per (ticker, through) for the life of the
        # instance. The master, the bars and the actions all read the
        # same payload, and three round trips for one answer is how a
        # polite client becomes a rude one.
        self._payloads: dict[tuple[str, date], dict[str, Any]] = {}
        self._last_request: float = float("-inf")

        # Drops, counted. A drop nobody counts is a drop nobody finds.
        self.null_bars: int = 0
        self.unmatched_dividends: int = 0

    # -- the door -------------------------------------------------------

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
                f"purpose: a free adjusted-close endpoint only answers for "
                f"symbols that still resolve today, so a universe pulled "
                f"through it is survivorship-biased by construction and "
                f"nothing downstream can tell. The exemption is for a "
                f"hand-checked list of large living funds; widening it here "
                f"would quietly withdraw the exemption's whole basis."
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
                    f"synthesised from the ticker and are OURS — a "
                    f"permaticker from another vendor will never match one."
                )
            out.append(ticker)
        return tuple(sorted(set(out)))

    # -- the four frames ------------------------------------------------

    def security_master(self) -> pd.DataFrame:
        rows = [self._profile(t) for t in self.allowed_tickers]
        out = _typed(pd.DataFrame(rows), schema.SECURITY_MASTER)
        out = out.sort_values("permaticker").reset_index(drop=True)
        return self._check(out, schema.SECURITY_MASTER)

    def prices(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
    ) -> pd.DataFrame:
        _check_window(start, end)
        tickers = self._resolve(permatickers)
        frames = [self._bars(t) for t in tickers]
        frames = [f for f in frames if not f.empty]
        if not frames:
            return self._check(schema.PRICES.empty(), schema.PRICES)

        out = pd.concat(frames, ignore_index=True)
        out = _typed(out, schema.PRICES)
        out = out.loc[out["date"].between(pd.Timestamp(start), pd.Timestamp(end))]
        out = out.sort_values(["permaticker", "date"]).reset_index(drop=True)
        # No duplicate collapse. The endpoint has never returned two
        # bars for one session, and if it starts, the schema's primary
        # key should say so loudly rather than have this file pick a
        # survivor on a rule nobody wrote down.
        return self._check(out, schema.PRICES)

    def actions(self, start: date, end: date) -> pd.DataFrame:
        _check_window(start, end)
        frames = [self._events(t) for t in self.allowed_tickers]
        frames = [f for f in frames if not f.empty]
        if not frames:
            return self._check(schema.ACTIONS.empty(), schema.ACTIONS)

        out = pd.concat(frames, ignore_index=True)
        out = _typed(out, schema.ACTIONS)
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
        # than SourceUnavailable. `audit.context.load_context` catches
        # exactly this and records `fundamentals=None`, which is what
        # makes every point-in-time check report UNPROVABLE — the true
        # answer. A correctly-typed empty frame would instead read as
        # "these entities filed nothing in this range", and the checks
        # would grade that as data.
        raise NotImplementedError(
            "this source serves sleeve ETF prices only. An ETF files no "
            "as-reported income statement, and there is no free feed of "
            "filing dates behind it — so there are no fundamentals here to "
            "return, and an empty frame would be read as a market fact "
            "rather than as the shape of the source."
        )

    # -- the cash leg ---------------------------------------------------

    def cash_rate(self, start: date, end: date) -> pd.Series:
        """Daily 3-month bill yield in percent, on an investment basis.

        DTB3 arrives on a 360-day discount basis and leaves here as an
        annualised investment yield, because the caller's next move is
        to compound it and a discount rate cannot be compounded as it
        stands. At 5% the two differ by about 13bp a year — small, real,
        and free to get right.
        """
        _check_window(start, end)
        raw = self._cached(
            "cash_rate",
            {"series": CASH_FRED_SERIES, "start": start, "end": end},
            # Read through the keyless graph endpoint rather than the
            # authenticated observations API. Both serve the same
            # numbers; only one of them can be missing a credential on
            # the machine that happens to be running the backtest.
            lambda: fetch_observations(
                CASH_FRED_SERIES, start, end, timeout=int(self._timeout)
            ),
        )
        if raw.empty:
            raise SourceUnavailable(
                f"FRED returned no usable {CASH_FRED_SERIES} observations "
                f"between {start.isoformat()} and {end.isoformat()}. That is "
                f"an outage or a bad range, not a period without interest "
                f"rates — do not let a cash sleeve fall back to zero on it."
            )

        discount = pd.Series(
            raw["value"].to_numpy(dtype="float64"),
            index=pd.DatetimeIndex(raw["date"]),
            name=CASH_FRED_SERIES,
        )
        return discount_to_investment_yield(discount).sort_index()

    def cash_total_return(
        self, sessions: pd.DatetimeIndex, *, base: float = 100.0
    ) -> pd.Series:
        """The pre-BIL cash sleeve: the bill rate compounded over sessions.

        Returned as a plain series and never dressed up as a row in the
        prices frame. `sleeves.py` keeps DTB3 out of `SLEEVE_TICKERS`
        because it is not tradable and does not come from the price
        source; emitting it as a bar would put it back in through a
        side door, where the next reader has no way to tell a
        hand-built index from a fund somebody could have bought.
        """
        sessions = pd.DatetimeIndex(sessions).normalize()
        if len(sessions) == 0:
            return pd.Series([], dtype="float64", name="cash_index")

        first = sessions.min().date()
        last = sessions.max().date()
        # Reach back a fortnight. A window opening on a Monday after a
        # holiday has no quote on its own first day, and `ffill` cannot
        # invent one out of a series that starts alongside it.
        rate = self.cash_rate(first - timedelta(days=14), last)
        try:
            return total_return_index(sessions, rate, base=base)
        except TbillUnavailable as exc:
            # Re-typed at the boundary: a caller of a DataSource catches
            # SourceUnavailable, and an exception class from a sibling
            # module would sail straight past that handler.
            raise SourceUnavailable(str(exc)) from exc

    # -- per-ticker frames ----------------------------------------------

    def _horizon(self) -> date:
        """How far forward every pull reaches: always today.

        Deliberately NOT the caller's `end`. The fetch returns the whole
        history whatever is asked, so keying the cache on the requested
        window would store the same twenty years again under a new name
        every time somebody moved a date — and "fetch once" would be a
        claim the file kept breaking. One horizon means one entry per
        ticker per day, and every window is a slice of it.

        The narrowing to the caller's range still happens, in `prices`
        and `actions`, before a row is handed out. Bars past the
        requested end sit in the cache and never reach a result.
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
            "profile",
            {"ticker": symbol, "end": through},
            lambda: self._build_profile(symbol, through),
        )
        return {c: frame[c].iloc[0] for c in frame.columns}

    def _build_bars(self, symbol: str, through: date) -> pd.DataFrame:
        result = self._payload(symbol, through)
        stamps = result.get("timestamp") or []
        if not stamps:
            return schema.PRICES.empty()

        indicators = result.get("indicators") or {}
        quote = (indicators.get("quote") or [{}])[0]
        adjblock = indicators.get("adjclose")
        if not adjblock or not adjblock[0].get("adjclose"):
            # The one column that cannot be reconstructed from the rest,
            # and the one carrying the entire return of the two credit
            # and duration sleeves. Falling back to `close` here would
            # hand back a full, well-typed, catastrophic frame.
            raise SourceUnavailable(
                f"{symbol}: the chart payload carried no adjclose block, so "
                f"there is no total-return series. Refusing to substitute "
                f"`close`: it is dividend-unadjusted, and for the bond "
                f"sleeves essentially all of the return is the coupon — the "
                f"substitution would not be approximate, it would delete "
                f"the defensive half of the strategy and look fine."
            )

        dates = _session_dates(stamps)
        close = _num(quote.get("close"), len(dates))
        adjclose = _num(adjblock[0]["adjclose"], len(dates))

        # A null bar is not a price. Yahoo has not produced one for
        # these nine, which is precisely why a silent NaN would go
        # unnoticed if it ever did.
        live = close.notna() & adjclose.notna()
        self.null_bars += int((~live).sum())

        splits = _split_events(result)
        # The cumulative multiplier that turns a split-adjusted price
        # back into the price that printed: the product of every split
        # ratio dated STRICTLY AFTER the bar. Strictly, because the
        # ex-date's own bar already trades post-split.
        forward = _forward_factor(dates, splits)

        frame = pd.DataFrame(
            {
                "permaticker": self._permaticker_of[symbol],
                "ticker": symbol,
                "date": dates,
                "open_unadj": _num(quote.get("open"), len(dates)) * forward,
                "high_unadj": _num(quote.get("high"), len(dates)) * forward,
                "low_unadj": _num(quote.get("low"), len(dates)) * forward,
                "close_unadj": close * forward,
                # Volume moves the other way. A 3-for-1 split triples
                # the share count in the adjusted history, so the count
                # that actually changed hands is the adjusted one
                # divided by the same factor the prices are multiplied
                # by.
                "volume_unadj": _num(quote.get("volume"), len(dates)) / forward,
                "close_adj": adjclose,
                # Stored the way `sharadar.py` stores it — split-adjusted
                # close over as-traded close — so the two producers of
                # this column mean the same thing by it. Below one before
                # a forward split, exactly one after the last.
                "split_factor": 1.0 / forward,
                "dividends": self._dividends(result, dates, forward),
            }
        )
        return _typed(frame.loc[live], schema.PRICES)

    def _dividends(
        self,
        result: dict[str, Any],
        dates: pd.Series,
        forward: np.ndarray,
    ) -> np.ndarray:
        """Cash paid per as-traded share on each ex-date, zero elsewhere.

        Yahoo publishes dividend amounts SPLIT-ADJUSTED, which is
        checkable rather than a guess: EEM's 2003-12-31 distribution
        comes back as 0.013444, an exact ninth of the 0.121 that was
        paid, and EEM has since split 3-for-1 twice. Left on that basis
        the column would sit beside an as-traded `close_unadj` and
        quietly divide a ninth of a dividend by a whole price, so the
        amounts are put back on the as-traded basis here and a yield
        against `close_unadj` is correct by construction.

        Undoing the vendor's arithmetic inherits the vendor's rounding:
        that same 0.013444 recovers as 0.120996 rather than 0.121,
        being a truncated repeating decimal multiplied back up. Four
        parts in a million on a figure that is itself a fraction of a
        percent of the price, so nothing here can feel it — recorded
        because a reader checking the column against a fund's own
        distribution history will find the discrepancy and should not
        have to work out whether it is a bug.

        Zero on a non-dividend day is a positive assertion, not a fill:
        the events block is the complete list, so "no distribution that
        session" is something we know. GLD's column is all zeros for
        the same reason — it distributes nothing, meeting its expenses
        by selling gold.
        """
        by_date = _dividend_events(result)
        if not by_date:
            return np.zeros(len(dates), dtype="float64")

        paid = dates.map(by_date).astype("float64").fillna(0.0)
        # An ex-date with no bar under it is money we have recorded in
        # `actions()` and cannot attach to a session here.
        matched = {d for d in dates if d in by_date}
        self.unmatched_dividends += len(by_date) - len(matched)
        return paid.to_numpy() * forward

    def _build_events(self, symbol: str, through: date) -> pd.DataFrame:
        result = self._payload(symbol, through)
        name = _fund_name(result, symbol)
        pid = self._permaticker_of[symbol]

        rows: list[dict[str, Any]] = []
        splits = _split_events(result)
        for when, ratio in splits:
            rows.append(
                {
                    "date": when,
                    "action": "split",
                    "ticker": symbol,
                    "permaticker": pid,
                    "name": name,
                    # New shares per old share: 3.0 for a 3-for-1, 0.5
                    # for BIL's 1-for-2 reverse. One number, signed by
                    # which side of one it falls on.
                    "value": ratio,
                }
            )

        # Dates and amounts are paired before either is used. Filtering
        # them into two separate lists and zipping the results is how a
        # single unparseable date silently shifts every later dividend
        # onto the wrong day.
        paid = sorted(_dividend_events(result).items())
        if paid:
            stamps = pd.Series([when for when, _ in paid])
            forward = _forward_factor(stamps, splits)
            for (when, amount), factor in zip(paid, forward):
                rows.append(
                    {
                        "date": when,
                        "action": "dividend",
                        "ticker": symbol,
                        "permaticker": pid,
                        "name": name,
                        # As-paid, matching the prices frame. See
                        # `_dividends` for why the vendor's figure is
                        # not the one that was written on the cheque.
                        "value": amount * float(factor),
                    }
                )

        if not rows:
            return schema.ACTIONS.empty()
        return _typed(pd.DataFrame(rows), schema.ACTIONS)

    def _build_profile(self, symbol: str, through: date) -> pd.DataFrame:
        result = self._payload(symbol, through)
        meta = result.get("meta") or {}
        stamps = result.get("timestamp") or []
        dates = _session_dates(stamps) if stamps else pd.Series(dtype="datetime64[ns]")

        first = _session_date(meta.get("firstTradeDate"))
        if first is None and len(dates):
            first = dates.iloc[0]
        last = dates.iloc[-1] if len(dates) else pd.NaT

        venue = str(meta.get("fullExchangeName") or meta.get("exchangeName") or "")
        row = {
            "permaticker": self._permaticker_of[symbol],
            "ticker": symbol,
            "name": _fund_name(result, symbol),
            # Today's listing venue, with no history behind it — the
            # two Treasury sleeves report Nasdaq while the other seven
            # report NYSE Arca, and the payload says nothing about when
            # that became true. So this column is NOT point-in-time and
            # nothing needing a venue as of a past date may read it.
            "exchange": _EXCHANGES.get(venue, venue),
            "category": ETF_CATEGORY,
            # Always False, and it is a tautology rather than a finding:
            # the allowlist holds nine funds that are all still
            # trading. See the capabilities block.
            "is_delisted": False,
            "first_price_date": first,
            "last_price_date": last,
            "currency": str(meta.get("currency") or "USD").upper(),
        }
        return _typed(pd.DataFrame([row]), schema.SECURITY_MASTER)

    # -- transport ------------------------------------------------------

    def _payload(self, symbol: str, through: date) -> dict[str, Any]:
        memo = (symbol, through)
        if memo not in self._payloads:
            self._payloads[memo] = self._fetch(symbol, through)
        return self._payloads[memo]

    def _fetch(self, symbol: str, through: date) -> dict[str, Any]:
        """The whole history to `through`, in one call.

        `period1=0` on purpose, and `through` is always today — see
        `_horizon`. The pull is a few thousand rows either way, so
        fetching everything once and slicing in memory costs nothing
        and spares the endpoint a request per window.
        """
        url = f"{CHART_BASE}/{symbol}"
        params = {
            "period1": "0",
            "period2": str(_unix(through) + 86_400),
            "interval": "1d",
            "events": "div,split",
        }
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
                    url,
                    params=params,
                    timeout=self._timeout,
                    headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                )
            except requests.RequestException as exc:
                last_reason = f"{type(exc).__name__}: {exc}"
                continue

            if response.status_code == 200:
                return _unwrap(response.json(), symbol)

            if response.status_code == 429:
                # Two failures wear this one status. A request with no
                # browser UA is refused 429 immediately, which is a bug
                # in the caller and fixed in a second. A real throttle
                # was measured lasting over ten minutes, which no
                # backoff inside one call can outlast — so the answer
                # there is to come back later, not to retry harder, and
                # the cache means whatever already landed is kept.
                last_reason = (
                    "HTTP 429. Check the User-Agent first: this endpoint "
                    "refuses a request without a browser UA using the same "
                    "status a genuine rate limit uses. If the header is "
                    "present then it is a real throttle, and those have been "
                    "seen to run past ten minutes — wait and rerun rather "
                    "than retrying, the pull is cached once it succeeds"
                )
                continue
            if response.status_code in RETRY_STATUSES:
                last_reason = f"HTTP {response.status_code}"
                continue
            if response.status_code == 404:
                raise SourceUnavailable(
                    f"{symbol}: the chart endpoint does not know this symbol "
                    f"(404). For a sleeve vehicle that is a delisting, a "
                    f"ticker change or a typo in the allowlist — never an "
                    f"empty range."
                )
            raise SourceUnavailable(
                f"{symbol}: chart endpoint returned HTTP "
                f"{response.status_code} — {(response.text or '')[:200]}"
            )

        raise SourceUnavailable(
            f"{symbol}: chart endpoint unreachable after {MAX_ATTEMPTS} "
            f"attempts. Last: {last_reason}. No rows were returned and none "
            f"were claimed — this is not an empty range."
        )

    def _pace(self) -> None:
        """Keep our own burst under the rate the endpoint tolerates.

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
        if self._cache is None:
            return loader()
        key = self._cache.key(SOURCE_SLUG, frame, **params)
        now = self._clock()
        # `end` is today, so cache.py reads every entry here as an open
        # range and gives it a one-day life. That is the right answer
        # rather than a missed optimisation: this history grows a bar
        # each session, and the alternative — an entry that never ages
        # — would quietly stop at whichever afternoon it was written.
        # A loader that raises leaves no entry at all, by doing nothing.
        return self._cache.get_or_load(key, loader, stamped=now, now=now)


# -- module helpers -----------------------------------------------------


def synthetic_permaticker(ticker: str) -> int:
    """A stable id for a symbol, minted by us and meaningless elsewhere.

    These are OURS. They are not a vendor's ids and carry no
    cross-vendor meaning whatsoever — Sharadar's permaticker for SPY is
    a different number, and joining a frame from this source to one
    from that one on `permaticker` would silently produce nothing, or
    worse, something.

    sha256 rather than `hash()`, which for a str is salted per
    interpreter run: the same ticker would mint a different id in every
    process, and every parquet in the cache would stop joining to the
    frame that wrote it — after a restart, which is when nobody is
    looking for a data bug.
    """
    digest = hashlib.sha256(str(ticker).strip().upper().encode("utf-8")).digest()
    return PERMATICKER_BASE + int.from_bytes(digest[:8], "big") % PERMATICKER_SPAN


def discount_to_investment_yield(discount_pct: pd.Series) -> pd.Series:
    """Turn a 360-day discount rate into a compoundable annual yield.

    A bill quoted at discount `d` costs `1 - d*t/360` per unit of face
    and pays face at maturity, so what the holder actually earns over
    those `t` days is the gain divided by the PRICE PAID, annualised on
    a 365-day year. Compounding the discount rate directly instead
    understates cash by roughly 13bp a year at 5% — not enough to
    change a conclusion, and not a reason to be wrong in the direction
    that flatters an allocation away from cash.
    """
    d = discount_pct.astype("float64") / 100.0
    price = 1.0 - d * (BILL_TENOR_DAYS / DISCOUNT_YEAR)
    yld = d * (INVESTMENT_YEAR / DISCOUNT_YEAR) / price
    # A non-positive price needs a discount rate near 400%. If one ever
    # appears it is a corrupt observation, and NaN is the honest read.
    return (yld * 100.0).where(price > 0)




def _unwrap(payload: dict[str, Any], symbol: str) -> dict[str, Any]:
    chart = (payload or {}).get("chart") or {}
    error = chart.get("error")
    if error:
        raise SourceUnavailable(
            f"{symbol}: chart endpoint returned an error — "
            f"{error.get('code')}: {error.get('description')}"
        )
    results = chart.get("result") or []
    if not results:
        raise SourceUnavailable(
            f"{symbol}: chart endpoint returned no result block at all. Not "
            f"an empty range — an empty range still carries meta."
        )
    return results[0]


def _session_dates(stamps: Sequence[int]) -> pd.Series:
    """Unix instants to session dates.

    Each daily bar is stamped at the OPEN in exchange local time, which
    is 13:30 or 14:30 UTC depending on daylight saving — never near
    midnight — so normalising the UTC instant recovers the session date
    exactly. That is checked against the live payload rather than
    assumed: were the stamp local midnight instead, a UTC read would
    file every bar one day early.
    """
    utc = pd.to_datetime(pd.Series(list(stamps), dtype="int64"), unit="s", utc=True)
    return utc.dt.tz_localize(None).dt.normalize()


def _session_date(stamp: Any) -> pd.Timestamp | None:
    if stamp is None:
        return None
    return pd.Timestamp(int(stamp), unit="s").normalize()


def _split_events(result: dict[str, Any]) -> list[tuple[pd.Timestamp, float]]:
    """Ex-date and new-shares-per-old-share, oldest first."""
    out: list[tuple[pd.Timestamp, float]] = []
    for entry in ((result.get("events") or {}).get("splits") or {}).values():
        when = _session_date(entry.get("date"))
        numerator = entry.get("numerator")
        denominator = entry.get("denominator")
        if when is None or not numerator or not denominator:
            continue
        out.append((when, float(numerator) / float(denominator)))
    return sorted(out)


def _dividend_events(result: dict[str, Any]) -> dict[pd.Timestamp, float]:
    """Ex-date to cash amount, on the vendor's split-adjusted basis.

    Summed where two land on one date rather than one overwriting the
    other — a special distribution alongside a regular one is money
    that was actually paid twice.
    """
    out: dict[pd.Timestamp, float] = {}
    for entry in ((result.get("events") or {}).get("dividends") or {}).values():
        when = _session_date(entry.get("date"))
        amount = entry.get("amount")
        if when is None or amount is None:
            continue
        out[when] = out.get(when, 0.0) + float(amount)
    return out


def _forward_factor(
    dates: pd.Series, splits: Sequence[tuple[pd.Timestamp, float]]
) -> np.ndarray:
    """Multiply a split-adjusted price by this to get the printed one.

    A loop over the events rather than a clever suffix product: no
    sleeve vehicle has had more than two splits in twenty years, and
    the readable version is the one that will still be checkable when
    somebody comes to it after a bad print.
    """
    factor = np.ones(len(dates), dtype="float64")
    if not splits:
        return factor
    as_np = pd.DatetimeIndex(dates).to_numpy()
    for when, ratio in splits:
        factor = np.where(as_np < np.datetime64(when), factor * ratio, factor)
    return factor


def _fund_name(result: dict[str, Any], symbol: str) -> str:
    meta = result.get("meta") or {}
    # Non-breaking spaces turn up in these (SPDR's gold fund ships one),
    # and a name that does not match itself across two pulls is a join
    # waiting to fail.
    name = str(meta.get("longName") or meta.get("shortName") or symbol)
    return " ".join(name.split())


def _num(values: Any, length: int) -> pd.Series:
    """One OHLCV column, or a column of NaN where the vendor sent none.

    NaN rather than zero for an absent column: a volume of zero is a
    session in which nothing traded, which is a claim, and a high of
    zero would pass a price floor from the wrong side.
    """
    if values is None or len(values) == 0:
        return pd.Series([float("nan")] * length, dtype="float64")
    return pd.to_numeric(pd.Series(list(values)), errors="coerce").astype("float64")


def _unix(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


def _check_window(start: date, end: date) -> None:
    if start > end:
        # An empty frame here would report a caller's reversed window as
        # "nothing traded in that period", which is the most expensive
        # sentence this file could say quietly.
        raise ValueError(
            f"start {start.isoformat()} is after end {end.isoformat()}"
        )


def _typed(df: pd.DataFrame, spec: schema.FrameSpec) -> pd.DataFrame:
    """Coerce to the spec's dtypes, dropping anything it does not name."""
    wanted = {**spec.required, **spec.optional}
    built = {
        column: _cast(df[column], dtype)
        for column, dtype in wanted.items()
        if column in df.columns
    }
    out = pd.DataFrame(built)
    out.index = pd.RangeIndex(len(out))
    return out


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
