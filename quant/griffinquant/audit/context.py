"""What every check gets handed.

The frames are loaded once and shared. Checks are pure functions of
this context — no check reaches back to the network, so the audit is
reproducible from a cached pull and a reviewer can rerun it without
credentials.

`AuditContext.capability` is the gate that produces UNPROVABLE. A check
asks whether the source claims the thing it needs; if not, the check
returns UNPROVABLE with that as the reason instead of quietly passing
on absent evidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from functools import cached_property

import pandas as pd

from ..data.base import DataSource
from ..data import schema
from .result import CheckResult, Verdict


@dataclass
class AuditContext:
    source: DataSource
    start: date
    end: date

    master: pd.DataFrame
    prices: pd.DataFrame
    actions: pd.DataFrame
    fundamentals: pd.DataFrame | None = None

    #: Anything the loader wants the report to record about the pull.
    provenance: dict[str, str] = field(default_factory=dict)

    # -- helpers used by more than one check family ---------------------

    @cached_property
    def sessions(self) -> pd.DatetimeIndex:
        """Real NYSE sessions over the audited range.

        Used to tell a market holiday apart from a hole in the data.
        Without a real calendar every Good Friday looks like a gap and
        the quality checks cry wolf until nobody reads them.
        """
        import exchange_calendars as xcals

        cal = xcals.get_calendar("XNYS")
        sess = cal.sessions_in_range(
            pd.Timestamp(self.start), pd.Timestamp(self.end)
        )
        return pd.DatetimeIndex(sess).tz_localize(None).normalize()

    @cached_property
    def price_years(self) -> pd.Series:
        return self.prices["date"].dt.year

    def capability(self, name: str) -> bool:
        return bool(getattr(self.source.capabilities, name, False))

    def require(
        self,
        key: str,
        title: str,
        needed: list[str],
        *,
        blocking: bool = True,
    ) -> CheckResult | None:
        """Return an UNPROVABLE result if the source can't feed the check.

        Returning None means go ahead. The caller reads it as a guard
        clause, which keeps the "we could not test this" path from
        being an afterthought at the bottom of each check.
        """
        missing = self.source.capabilities.unmet(needed)
        if not missing:
            return None
        pretty = ", ".join(m.replace("_", " ") for m in missing)
        return CheckResult(
            key=key,
            title=title,
            verdict=Verdict.UNPROVABLE,
            blocking=blocking,
            headline=f"{self.source.label} does not supply: {pretty}.",
            unprovable_reason=(
                f"The check needs {pretty}, which this source does not "
                f"provide. Nothing was tested — this is not a pass."
            ),
        )


def load_context(
    source: DataSource,
    start: date,
    end: date,
    *,
    with_fundamentals: bool = True,
) -> AuditContext:
    """Pull the four frames and validate each at the boundary."""
    master = schema.SECURITY_MASTER.validate(
        source.security_master(), source=type(source).__name__
    )
    prices = schema.PRICES.validate(
        source.prices(start, end), source=type(source).__name__
    )
    actions = schema.ACTIONS.validate(
        source.actions(start, end), source=type(source).__name__
    )

    fundamentals = None
    if with_fundamentals:
        try:
            fundamentals = schema.FUNDAMENTALS.validate(
                source.fundamentals(start, end, dimension="ARQ"),
                source=type(source).__name__,
            )
        except NotImplementedError:
            fundamentals = None

    return AuditContext(
        source=source,
        start=start,
        end=end,
        master=master,
        prices=prices,
        actions=actions,
        fundamentals=fundamentals,
        provenance={
            "source": source.label,
            "range": f"{start.isoformat()} to {end.isoformat()}",
            "entities": f"{len(master):,}",
            "price_rows": f"{len(prices):,}",
            "action_rows": f"{len(actions):,}",
            "fundamental_rows": (
                f"{len(fundamentals):,}" if fundamentals is not None else "none"
            ),
        },
    )
