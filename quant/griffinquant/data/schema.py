"""Frame schemas for everything a data source hands back.

The schemas are enforced, not documented. An adapter that returns a
column of the wrong dtype gets a loud error at the boundary rather
than a subtly wrong number four layers downstream, which is the
failure mode this whole repository exists to avoid.

Two conventions run through every frame here and both are load-bearing:

`permaticker` is the primary key, never `ticker`. Ticker strings are
recycled. GM was old General Motors until June 2009 and new General
Motors from November 2010; CC was Circuit City until it liquidated and
Chemours from 2015; WB was Wachovia until Wells Fargo took it and
Weibo from 2014. Any join on the symbol grafts a dead company's price
history onto a living one's, and the resulting series looks like a
stock that fell 99% and then recovered — which backtests beautifully.

Prices are carried BOTH adjusted and as-traded. This matters more than
it looks. A survivorship-free dataset still leaks the future if you
apply a $5 price floor to a back-adjusted series: a stock that actually
traded at $2 in 2009 and has since split 1-for-4 shows up at $8 in
adjusted terms and passes a filter it could never have passed on the
day. Liquidity and price screens read `*_unadj`; return calculations
read `close_adj`. Mixing them is the bug.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd


class SchemaError(ValueError):
    """An adapter returned a frame that does not meet its contract."""


@dataclass(frozen=True)
class FrameSpec:
    """A named set of columns with required dtypes.

    `optional` columns are permitted to be absent entirely, but if a
    source supplies one it still has to be the right type — a half-
    populated column of the wrong dtype is worse than no column.
    """

    name: str
    required: dict[str, str]
    optional: dict[str, str] = field(default_factory=dict)
    primary_key: tuple[str, ...] = ()

    def validate(self, df: pd.DataFrame, *, source: str = "?") -> pd.DataFrame:
        where = f"{source}.{self.name}"

        if not isinstance(df, pd.DataFrame):
            raise SchemaError(f"{where}: expected DataFrame, got {type(df)!r}")

        missing = [c for c in self.required if c not in df.columns]
        if missing:
            raise SchemaError(
                f"{where}: missing required column(s) {missing}. "
                f"Got: {sorted(df.columns)}"
            )

        wrong: list[str] = []
        for col, want in {**self.required, **self.optional}.items():
            if col not in df.columns:
                continue
            got = str(df[col].dtype)
            if not _dtype_ok(got, want):
                wrong.append(f"{col}: want {want}, got {got}")
        if wrong:
            raise SchemaError(f"{where}: dtype mismatch — " + "; ".join(wrong))

        # A duplicated primary key is not a style problem. Two rows for
        # one security-day means every groupby below this point silently
        # double-counts, and the first place it shows up is a portfolio
        # weight that doesn't sum to one.
        if self.primary_key and all(k in df.columns for k in self.primary_key):
            dupes = df.duplicated(subset=list(self.primary_key)).sum()
            if dupes:
                raise SchemaError(
                    f"{where}: {dupes:,} duplicate row(s) on primary key "
                    f"{self.primary_key}"
                )

        return df

    def empty(self) -> pd.DataFrame:
        """A correctly-typed empty frame, for the no-rows path.

        Sources hit ranges with genuinely nothing in them. Returning a
        bare DataFrame() there would fail validation on dtype, so every
        adapter can reach for this instead of hand-building one.
        """
        cols = {**self.required, **self.optional}
        return pd.DataFrame({c: pd.Series([], dtype=t) for c, t in cols.items()})


def _dtype_ok(got: str, want: str) -> bool:
    """Accept the dtype spellings that mean the same thing.

    pandas 3 reports plain object-backed strings as `str`, arrow-backed
    ones as `string`, and either is fine for our purposes. Likewise a
    tz-naive datetime prints with or without a unit depending on how it
    was built.
    """
    if got == want:
        return True
    families = [
        {"str", "string", "object", "string[python]", "string[pyarrow]"},
        {"datetime64[ns]", "datetime64[us]", "datetime64[ms]", "datetime64[s]"},
        {"bool", "boolean"},
        {"int64", "Int64"},
        {"float64", "Float64"},
    ]
    return any(got in f and want in f for f in families)


# The security master. One row per entity, not per symbol — see the
# permaticker note in the module docstring.
SECURITY_MASTER = FrameSpec(
    name="security_master",
    primary_key=("permaticker",),
    required={
        "permaticker": "int64",
        "ticker": "str",
        "name": "str",
        "exchange": "str",
        "category": "str",
        "is_delisted": "bool",
        "first_price_date": "datetime64[ns]",
        "last_price_date": "datetime64[ns]",
    },
    optional={
        "sic_code": "Int64",
        "sector": "str",
        "industry": "str",
        "currency": "str",
        "location": "str",
        "delisted_from": "str",
        "related_tickers": "str",
        "cusips": "str",
        "scale_marketcap": "str",
    },
)

# Daily bars. `close_adj` is the only column safe for returns; the
# `*_unadj` columns are the only ones safe for price and liquidity
# screens. Nothing here is safe for both.
PRICES = FrameSpec(
    name="prices",
    primary_key=("permaticker", "date"),
    required={
        "permaticker": "int64",
        "ticker": "str",
        "date": "datetime64[ns]",
        "open_unadj": "float64",
        "high_unadj": "float64",
        "low_unadj": "float64",
        "close_unadj": "float64",
        "volume_unadj": "float64",
        "close_adj": "float64",
    },
    optional={
        "dividends": "float64",
        "split_factor": "float64",
        "last_updated": "datetime64[ns]",
    },
)

# Corporate actions, including the one that matters most here: the
# delisting itself, with the reason attached. A dataset that knows a
# name stopped trading but not why cannot distinguish an acquisition at
# a premium from a bankruptcy at zero, and those are opposite returns.
ACTIONS = FrameSpec(
    name="actions",
    required={
        "date": "datetime64[ns]",
        "action": "str",
        "ticker": "str",
    },
    optional={
        "permaticker": "Int64",
        "name": "str",
        "value": "float64",
        "contra_ticker": "str",
        "reason": "str",
    },
)

# Fundamentals. `period_end` is when the quarter closed; `date_public`
# is when the filing carrying it reached EDGAR. Only the second one is
# usable as an availability date, and the gap between them is routinely
# 30-90 days and occasionally much longer.
#
# `dimension` decides whether this frame is point-in-time at all.
# As-reported (AR*) is what the filer said at the time. Most-recent-
# reported (MR*) silently substitutes later restatements, which is
# lookahead of the purest kind: it tells you in 2011 what the company
# would admit in 2013.
FUNDAMENTALS = FrameSpec(
    name="fundamentals",
    primary_key=("permaticker", "dimension", "date_public"),
    required={
        "permaticker": "int64",
        "ticker": "str",
        "dimension": "str",
        "period_end": "datetime64[ns]",
        "date_public": "datetime64[ns]",
    },
    optional={
        "report_period": "datetime64[ns]",
        "last_updated": "datetime64[ns]",
        "revenue": "float64",
        "netinc": "float64",
        "equity": "float64",
        "assets": "float64",
        "liabilities": "float64",
        "ebitda": "float64",
        "ncfo": "float64",
        "capex": "float64",
        "sharesbas": "float64",
        "shareswa": "float64",
        "marketcap": "float64",
        "ev": "float64",
        "gp": "float64",
        "opinc": "float64",
        "debt": "float64",
        "cashneq": "float64",
    },
)

ALL_SPECS: dict[str, FrameSpec] = {
    s.name: s for s in (SECURITY_MASTER, PRICES, ACTIONS, FUNDAMENTALS)
}
