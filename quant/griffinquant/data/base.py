"""The contract every data source signs.

Two things live here. `SourceCapabilities` is what a source *claims*
about itself. `DataSource` is the interface it has to implement.

The distinction between a claim and a demonstration is the entire
point of the audit that runs on top of this. A vendor's marketing page
saying "survivorship-bias-free" is a claim. Ten thousand rows of price
history for companies that no longer exist, ending on the dates they
actually stopped trading, is a demonstration. `data_audit.py` exists to
turn the first into the second, and to say plainly when it cannot.

So capabilities are never read as evidence. They are read to decide
which checks are even answerable, and a check the source cannot feed
is reported UNPROVABLE — never PASS. A source that carries no
delisting dates has not passed the delisting test; it has declined to
sit it.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from datetime import date
from typing import Iterable

import pandas as pd

from . import schema


@dataclass(frozen=True)
class SourceCapabilities:
    """What a source says it can supply. Claims, not findings."""

    name: str

    # Does the vendor assert the panel retains securities that stopped
    # trading, at the prices and dates that were true then?
    claims_survivorship_free: bool = False

    # Does every fundamental row carry the date its filing became
    # public, as opposed to the date the period ended?
    provides_filing_dates: bool = False

    # Can the source distinguish as-reported figures from later
    # restatements? Without this, fundamentals are not point-in-time
    # no matter how carefully the dates are handled.
    provides_as_reported: bool = False

    # Delisting dates, and ideally the reason — acquired at a premium
    # and wound up at zero are opposite outcomes.
    provides_delisting_dates: bool = False
    provides_delisting_reasons: bool = False

    # Stable entity ids that survive a ticker change, so a recycled
    # symbol cannot splice two companies into one series.
    provides_permanent_ids: bool = False

    # Historical index constituents as of a past date. Nothing in this
    # project's design needs it — the universe is computed from
    # tradability, not membership — but its absence rules out ever
    # cross-checking against an index-based universe.
    provides_index_membership: bool = False

    # Raw as-traded prices alongside the adjusted series. Without
    # these, price and liquidity screens are silently applied to
    # back-adjusted numbers and leak the future.
    provides_unadjusted_prices: bool = False

    # Set on anything that must never reach a reported result.
    is_smoke_test_only: bool = False

    def unmet(self, needed: Iterable[str]) -> list[str]:
        """Which of `needed` this source does not claim to provide."""
        return [n for n in needed if not getattr(self, n, False)]


class DataSource(abc.ABC):
    """Read-only access to a point-in-time securities panel.

    Every method returns a frame validated against the specs in
    `schema.py`. Implementations should call `self._check` on the way
    out rather than trusting themselves.

    Note what is deliberately absent: there is no `get_universe`. The
    universe is a function of this data evaluated on a date, and it
    lives in the layer above. A source that hands back a ready-made
    universe list is a source that has already made the survivorship
    decision for you, somewhere you cannot see it.
    """

    #: Filled in by each concrete adapter.
    capabilities: SourceCapabilities

    # -- the four frames ------------------------------------------------

    @abc.abstractmethod
    def security_master(self) -> pd.DataFrame:
        """Every entity the source knows about, living and dead.

        Must include delisted names. A master that only contains
        currently-tradable securities is the survivorship bug in its
        original form, and the audit will say so.
        """

    @abc.abstractmethod
    def prices(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
    ) -> pd.DataFrame:
        """Daily bars over a date range, all entities unless narrowed."""

    @abc.abstractmethod
    def actions(self, start: date, end: date) -> pd.DataFrame:
        """Corporate actions: delistings, splits, mergers, ticker changes."""

    @abc.abstractmethod
    def fundamentals(
        self,
        start: date,
        end: date,
        permatickers: Iterable[int] | None = None,
        dimension: str = "ARQ",
    ) -> pd.DataFrame:
        """Fundamentals, filtered on the date the filing went public.

        `start`/`end` bound `date_public`, not `period_end`. Bounding
        the period end is how you accidentally pull a filing that had
        not been published yet on the date you are simulating.

        `dimension` defaults to as-reported quarterly. Passing an MR*
        dimension is legitimate for descriptive work and never for a
        backtest; the audit flags it either way.
        """

    # -- helpers --------------------------------------------------------

    def _check(self, df: pd.DataFrame, spec: schema.FrameSpec) -> pd.DataFrame:
        return spec.validate(df, source=type(self).__name__)

    @property
    def label(self) -> str:
        tag = " [SMOKE TEST ONLY]" if self.capabilities.is_smoke_test_only else ""
        return f"{self.capabilities.name}{tag}"


class SourceUnavailable(RuntimeError):
    """The source exists but cannot be reached or is not configured.

    Kept distinct from an empty result on purpose. "No API key" and
    "no rows in that range" look identical downstream and mean
    completely different things; conflating them is how an outage gets
    reported as a fact about the market.
    """
