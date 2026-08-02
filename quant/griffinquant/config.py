"""Tradability thresholds, in one place.

These numbers are stated here rather than inline at each use because
the audit and the universe function have to agree exactly. An audit
that reports "12% of held names sat below the liquidity floor" while
the universe function used a different floor is worse than no audit —
it reads as reassurance about a screen that was never applied.

Every value is round on purpose. None of them was chosen by seeing
which one backtested better, and the moment one is, it stops being a
prior and becomes a fitted parameter that has to be counted as a
trial.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class UniverseRules:
    """Single-name equity tradability, all evaluated as of the date."""

    # Below five dollars the tick is a meaningful fraction of the
    # price and the borrow, spread and halt behaviour all change.
    # Applied to the AS-TRADED close, never the back-adjusted one.
    min_price: float = 5.00

    # Twenty sessions of median dollar volume. Median rather than mean
    # because a single index-rebalance print otherwise qualifies a
    # name that is untradable on all nineteen other days.
    min_median_dollar_volume: float = 5_000_000.0
    dollar_volume_window: int = 20

    min_market_cap: float = 500_000_000.0

    # One trading year. Anything younger has no volatility estimate
    # worth having and no momentum history at all.
    min_history_days: int = 252

    # The cap that makes the whole thing scale. A position may not
    # exceed this share of the name's own median daily dollar volume,
    # which in thin names binds long before any percentage-of-NAV cap
    # does — and that is the intended ordering.
    max_participation_of_adv: float = 0.01


@dataclass(frozen=True)
class EtfRules:
    """Sleeve-vehicle tradability."""

    min_aum: float = 500_000_000.0
    max_median_spread_bps: float = 5.0
    min_live_history_years: int = 5


#: Instrument categories that never enter any universe, at any layer.
#:
#: Each of these breaks the backtest in a specific way rather than
#: merely being undesirable. Leveraged and inverse products smuggle in
#: the leverage and the shorting the account cannot have. Volatility
#: ETPs have a structural downward drift that a long-only optimiser
#: reads as a short opportunity it is not allowed to take, and any
#: process that wants to hold them long has found a bug rather than a
#: trade. Closed-end funds trade at persistent discounts to NAV, and a
#: backtest marking them at NAV manufactures alpha that no one could
#: collect.
HARD_EXCLUDED_CATEGORIES: frozenset[str] = frozenset(
    {
        "leveraged_etp",
        "inverse_etp",
        "volatility_etp",
        "closed_end_fund",
        "spac",
        "blank_check",
        "trust",
        "preferred_share",
        "convertible_preferred",
        "warrant",
        "right",
        "unit",
    }
)

#: Venues we will trade. Anything else — OTC, pink, grey — is out, and
#: not because of quality: the fills are not real.
ALLOWED_EXCHANGES: frozenset[str] = frozenset({"NYSE", "NASDAQ", "NYSEMKT", "NYSEARCA", "BATS"})

#: Substrings that mark a Sharadar `category` as ineligible. Kept
#: separate from the canonical set above because vendor category
#: strings are prose and change; the canonical set is ours.
VENDOR_CATEGORY_EXCLUSIONS: tuple[str, ...] = (
    "ETF",  # only for the single-name layer; sleeves handle ETFs apart
    "ETN",
    "ETMF",
    "CEF",
    "Closed-End Fund",
    "Preferred",
    "Warrant",
    "Unit",
    "Right",
    "Trust",
)

#: Categories that ARE eligible for the single-name equity layer.
#: An allowlist, because the exclusion list can never be complete and
#: a new vendor category should default to out rather than in.
SINGLE_NAME_CATEGORIES: frozenset[str] = frozenset(
    {
        "Domestic Common Stock",
        "Domestic Common Stock Primary Class",
        "Domestic Common Stock Secondary Class",
        "ADR Common Stock",
        "ADR Common Stock Primary Class",
        "ADR Common Stock Secondary Class",
        "Canadian Common Stock",
        "Canadian Common Stock Primary Class",
    }
)

#: Fundamental data has to be lagged to the day it became public. Where
#: the source carries an actual filing date we use it and this constant
#: is irrelevant. Where it does not, we assume a filing took this long
#: to appear — deliberately conservative, since being early is a leak
#: and being late merely costs a little edge.
FALLBACK_FUNDAMENTAL_LAG_DAYS: int = 90

#: The sample has to contain the episodes that break things. Starting
#: in 2005 buys 2008, 2018Q4, 2020Q1 and 2022; starting later buys a
#: backtest that has never seen a real crisis.
SAMPLE_START = "2005-01-01"

#: Reserved and untouched until the very end. Three years, one look.
HOLDOUT_YEARS: int = 3

UNIVERSE = UniverseRules()
ETFS = EtfRules()
