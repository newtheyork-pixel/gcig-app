"""What a trade costs, charged from the first run rather than the last.

A cost model bolted on at the end is a cost model that gets tuned until
the result survives it. This one is wired in before there is a result to
protect, and it is deliberately unflattering in both of its halves.

The spread is a function of the name's own liquidity and never a
constant. The impact term is a square-root law whose coefficient is a
prior lifted from the published literature, not a measurement of our own
fills — and the honest response to a prior is `multiple`, which re-runs
the whole backtest at two and three times the base assumption. All three
get reported. A strategy that only works at 1x is not a strategy, it is
a bet that this file is exactly right, and nothing in this file is
exactly right.

Two conventions, both load-bearing:

Every number here is in basis points of the traded notional, and every
number is ONE SIDE. A round trip pays it twice. The calibration anchors
below are quoted round trip, because that is how spreads are quoted, so
they are the FULL quoted spread and a single execution is charged half.

Direction is irrelevant. Selling $1,300 costs what buying $1,300 costs,
so the notional is taken in absolute value. A model that charged only
buys would make the rebalance look half price.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np
import pandas as pd

Numeric = float | np.ndarray | pd.Series


# -- the spread curve ---------------------------------------------------

# Median daily dollar volume mapped to the FULL quoted spread, in basis
# points. Interpolated log-log between the anchors and flat outside
# them, which makes it monotone decreasing in liquidity by construction.
#
# A flat cost assumption across a wide universe is the most common way a
# backtest of this kind lies to itself, and the reason is that the error
# does not cancel. Charge everything a tidy 10bp and the sleeve ETFs are
# billed roughly seven times what they cost while the small caps are
# billed under a third — and the small caps are where the cross-
# sectional signal lives. The flat number therefore subsidises exactly
# the trades the backtest's excess return is coming from, and it does it
# invisibly, because 10bp sounds conservative right up until you notice
# which names it was conservative about.
#
# The three interior anchors are the brief's calibration points, taken
# at the middle of each stated band: 20-50bp round trip for a small cap
# sitting on the $5M liquidity floor, 3-8bp for a large cap, 1-2bp for a
# major sleeve ETF. The two outer anchors are refusals to extrapolate
# rather than observations, and are commented as such below.
_SPREAD_ANCHORS: tuple[tuple[float, float], ...] = (
    # Past here the curve is guessing about names the universe screen
    # already threw out, so it stops moving. A 1% round trip is not a
    # measurement, it is a number large enough that anything priced at
    # it should never have been sized in the first place.
    (500_000.0, 100.0),
    (5_000_000.0, 35.0),
    (150_000_000.0, 5.0),
    (1_000_000_000.0, 1.5),
    # The floor is the tick: one cent on a hundred-dollar tape is one
    # basis point, and no amount of volume buys a market tighter than
    # the minimum increment. SPY's real spread is nearer 0.2bp, so this
    # overcharges the most liquid thing we will ever trade — which is
    # the direction a cost model is allowed to be wrong in.
    (10_000_000_000.0, 1.0),
)

_ANCHOR_ADV = np.array([a for a, _ in _SPREAD_ANCHORS], dtype="float64")
_ANCHOR_BPS = np.array([s for _, s in _SPREAD_ANCHORS], dtype="float64")

# Monotonicity is the one property the curve has to have, and a
# mis-ordered edit to the table above would break it silently: np.interp
# demands only that the x-axis ascends, and would happily fit a spread
# that gets wider as the name gets more liquid.
if not (np.all(np.diff(_ANCHOR_ADV) > 0) and np.all(np.diff(_ANCHOR_BPS) < 0)):
    raise ValueError(
        "_SPREAD_ANCHORS must ascend in dollar volume and descend in "
        "spread; as written the curve is not monotone in liquidity"
    )

_LOG_ADV = np.log10(_ANCHOR_ADV)
_LOG_BPS = np.log10(_ANCHOR_BPS)

#: Substituted wherever liquidity is unknown, zero or not a number. The
#: alternative — treating a missing ADV as infinite depth — prices a
#: free trade in the one name we know least about, and the names with no
#: volume history are disproportionately the ones that should scare us.
_UNKNOWN_ADV = float(_ANCHOR_ADV[0])


def estimated_quoted_spread_bps(median_dollar_volume: Numeric) -> Numeric:
    """The full quoted spread implied by a name's median dollar volume.

    This is the proxy used when no real quote is available, which today
    is everywhere: the panel carries bars, not books. Crossing it once
    costs half of what this returns.
    """
    adv = _safe_adv(median_dollar_volume)
    bps = np.power(10.0, np.interp(np.log10(adv), _LOG_ADV, _LOG_BPS))
    return _like(bps, median_dollar_volume)


# -- the impact coefficient ---------------------------------------------

#: The Y in `impact = Y * sigma * sqrt(participation)`.
#:
#: This is a prior, not a measurement, and the distinction is the whole
#: reason `multiple` exists. We have no fills of our own. The only thing
#: that would turn this into a measurement is the Fund's own execution
#: record against arrival prices, and until that exists any figure here
#: is borrowed.
#:
#: What is borrowed: the square-root form and the rough size of the
#: coefficient are about as settled as anything in market microstructure
#: gets. Loeb (1983) tabulated it cross-sectionally, BARRA's market
#: impact model (Torre & Ferrari, 1997) built it in, Almgren, Thum,
#: Hauptmann and Li (2005) fitted it directly to some 700,000 Citigroup
#: US equity orders, and the wider square-root-law literature keeps
#: landing on a coefficient between roughly 0.5 and 1.0 when sigma is
#: daily volatility and participation is order size over daily volume.
#:
#: One is chosen because it is round, because it is the pessimistic end
#: of that range, and because a value with three decimal places would
#: imply we had fitted something. Almgren et al. actually prefer an
#: exponent near 0.6 for temporary impact; we keep 0.5, which is the
#: form everyone else states, and let the 2x and 3x runs absorb the
#: disagreement rather than pretending to resolve it.
DEFAULT_IMPACT_COEFFICIENT = 1.0

#: Used when a name's volatility is missing. Two percent a day is an
#: ordinary single stock and a wild sleeve ETF, so it is conservative
#: exactly where the data is thin.
DEFAULT_DAILY_VOLATILITY = 0.02

#: The brief requires all three reported, and the reason is that the
#: interesting question is not "what does it cost" but "how wrong can
#: the answer be before the result goes away".
STRESS_MULTIPLES: tuple[float, ...] = (1.0, 2.0, 3.0)


# -- results ------------------------------------------------------------


@dataclass(frozen=True)
class CostBreakdown:
    """Spread and impact kept apart, on purpose.

    One total is enough right until the cost drag turns out to dominate
    the backtest, at which point somebody has to work out which half to
    argue with — and they are different arguments. The spread number is
    a claim about a curve we fitted to three anchors; the impact number
    is a claim about a coefficient we took on trust. Collapsing them
    into a single figure makes the model unfalsifiable in exactly the
    situation where it most needs testing.

    Fields carry whatever shape went in: floats for a single trade,
    arrays or Series for a whole day's trade list.
    """

    spread_bps: Numeric
    impact_bps: Numeric
    #: Traded notional over median daily dollar volume. Diagnostic, but
    #: the first thing to look at when an impact number is a surprise.
    participation: Numeric
    notional: Numeric
    #: Which stress run produced this, so three sets of numbers on one
    #: page cannot be confused for each other.
    multiple: float

    @property
    def total_bps(self) -> Numeric:
        return self.spread_bps + self.impact_bps

    @property
    def spread_dollars(self) -> Numeric:
        return self.notional * self.spread_bps / 1e4

    @property
    def impact_dollars(self) -> Numeric:
        return self.notional * self.impact_bps / 1e4

    @property
    def total_dollars(self) -> Numeric:
        return self.notional * self.total_bps / 1e4

    def as_dict(self) -> dict[str, Numeric]:
        return {
            "spread_bps": self.spread_bps,
            "impact_bps": self.impact_bps,
            "total_bps": self.total_bps,
            "participation": self.participation,
            "notional": self.notional,
            "multiple": self.multiple,
        }


# -- the model ----------------------------------------------------------


@dataclass(frozen=True)
class CostModel:
    """The assumptions, in one immutable object.

    Frozen because a cost model that changes partway through a backtest
    produces a result no one can reproduce, and `scaled` returns a new
    one rather than mutating this.
    """

    #: 1x, 2x, 3x. Scales both components together — doubling only the
    #: half we happen to distrust today would be a different model, not
    #: a stress of this one.
    multiple: float = 1.0
    impact_coefficient: float = DEFAULT_IMPACT_COEFFICIENT
    default_daily_volatility: float = DEFAULT_DAILY_VOLATILITY

    def __post_init__(self) -> None:
        if not np.isfinite(self.multiple) or self.multiple <= 0:
            raise ValueError(f"multiple must be positive, got {self.multiple!r}")
        if not np.isfinite(self.impact_coefficient) or self.impact_coefficient < 0:
            raise ValueError(
                f"impact_coefficient must be non-negative, got "
                f"{self.impact_coefficient!r}"
            )

    @property
    def label(self) -> str:
        return (
            f"costs {self.multiple:g}x "
            f"(liquidity-scaled spread, sqrt impact Y={self.impact_coefficient:g})"
        )

    def scaled(self, multiple: float) -> CostModel:
        """The same assumptions at a different severity."""
        return replace(self, multiple=float(multiple))

    def cost_bps(
        self,
        *,
        trade_notional: Numeric,
        median_dollar_volume: Numeric,
        daily_volatility: Numeric | None = None,
        quoted_spread_bps: Numeric | None = None,
    ) -> CostBreakdown:
        """Cost of ONE execution, decomposed.

        Keyword-only because every argument is a number and three of
        them are dollar-ish; a transposed positional call would price a
        trade against a volatility and report a plausible figure.

        `quoted_spread_bps` is the real full quoted spread where a book
        is available. Rows where it is missing fall back to the
        liquidity proxy individually, so partial quote coverage does not
        have to be all-or-nothing.
        """
        notional = np.abs(_arr(trade_notional))
        adv = _safe_adv(median_dollar_volume)

        proxy = np.power(10.0, np.interp(np.log10(adv), _LOG_ADV, _LOG_BPS))
        if quoted_spread_bps is None:
            quoted = proxy
        else:
            # A quote we have beats a curve we fitted; a quote we are
            # missing must not turn into a free trade.
            supplied = _arr(quoted_spread_bps)
            quoted = np.where(
                np.isfinite(supplied) & (supplied >= 0.0), supplied, proxy
            )

        # Half the spread on the way in, half on the way out. The
        # anchors are round-trip figures, so the halving is what makes a
        # single execution cost what a single execution costs.
        spread = 0.5 * quoted * self.multiple

        # At the Fund's actual size this term is nearly nothing, and the
        # arithmetic is worth writing down so nobody deletes it as dead
        # weight. NAV is about $131,000. The universe's 1% participation
        # cap against the $5M median-dollar-volume floor permits a
        # $50,000 position; the strategy places roughly $1,300. That is
        # 0.026% of a day's volume, its square root is 1.6%, and against
        # a 2%-a-day single name the impact charge is about three basis
        # points at the very floor of the universe — well under one in a
        # large cap, under a tenth of one in a sleeve ETF.
        #
        # So the cap does not bind and it is not supposed to. The term
        # is here because the same code has to stay honest if the
        # endowment allocation grows an order of magnitude, or if some
        # later version concentrates $131K into three names instead of a
        # hundred. It costs nothing to carry and it is the only part of
        # the model that notices size at all.
        #
        # Unlike the spread curve there is no ceiling on this. The
        # spread stops extrapolating because the anchors run out; the
        # square root keeps returning an answer, and an order at three
        # times a day's volume should come back priced like the
        # impossibility it is rather than quietly clipped to something
        # a sizing routine would accept.
        participation = notional / adv

        vol = (
            np.full(np.shape(participation), self.default_daily_volatility)
            if daily_volatility is None
            else _arr(daily_volatility)
        )
        vol = np.where(
            np.isfinite(vol) & (vol >= 0.0), vol, self.default_daily_volatility
        )

        impact = (
            self.impact_coefficient
            * vol
            * np.sqrt(participation)
            * 1e4
            * self.multiple
        )

        template = _template(trade_notional, median_dollar_volume, daily_volatility)
        return CostBreakdown(
            spread_bps=_like(spread, template),
            impact_bps=_like(impact, template),
            participation=_like(participation, template),
            notional=_like(notional, template),
            multiple=self.multiple,
        )


def stress_ladder(base: CostModel | None = None) -> tuple[CostModel, ...]:
    """The three models the brief requires every result to be shown at.

    Returned as a tuple rather than generated at each call site so that
    "we ran it at 1x, 2x and 3x" is one object a report can iterate and
    label, rather than three loose numbers somebody has to remember to
    keep in step.
    """
    base = base or CostModel()
    return tuple(base.scaled(m) for m in STRESS_MULTIPLES)


# -- shape plumbing -----------------------------------------------------


def _arr(x: Numeric) -> np.ndarray:
    return np.asarray(x, dtype="float64")


def _safe_adv(median_dollar_volume: Numeric) -> np.ndarray:
    """Liquidity, with unknowns replaced by the least liquid anchor."""
    adv = _arr(median_dollar_volume)
    return np.where(np.isfinite(adv) & (adv > 0.0), adv, _UNKNOWN_ADV)


def _template(*args: Numeric | None) -> Numeric:
    """Whichever input decides the shape of the answer."""
    for a in args:
        if isinstance(a, pd.Series):
            return a
    for a in args:
        if a is not None and np.ndim(a) > 0:
            return a
    return 0.0


def _like(result: np.ndarray | np.floating, template: Numeric) -> Numeric:
    """Give the answer back in the shape the question was asked in.

    The Series branch is not cosmetic. Handing a bare ndarray back to a
    caller who passed a filtered Series lets it align positionally
    against the wrong rows the moment it is assigned into a frame, and
    that mistake produces a cost column that is merely shuffled — every
    value plausible, none attached to its own trade.
    """
    if isinstance(template, pd.Series):
        return pd.Series(
            np.broadcast_to(result, template.shape).astype("float64", copy=True),
            index=template.index,
        )
    if np.ndim(template) == 0:
        return float(result)
    return np.asarray(result, dtype="float64")
