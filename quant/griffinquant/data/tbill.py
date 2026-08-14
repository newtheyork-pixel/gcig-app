"""The cash sleeve's return, from the Treasury bill rate.

Cash is not a zero. Over 2005-2007 bills paid 3-5%, and a backtest that
credits cash with nothing does not merely understate the result — it
biases every allocation decision above it, because Layer 2 is choosing
between sleeves and one of them has been handed an artificial penalty.
The strategy would learn to avoid cash for a reason that lives in our
code rather than in the market.

BIL is the obvious instrument and it is the wrong one for the early
sample: it lists in May 2007, two and a half years after the window
opens. So the cash leg is built from the rate itself and spliced to BIL
where BIL exists, which is the treatment the brief asks for whenever an
index proxy stands in for a vehicle that did not yet trade.

No API key. FRED's graph endpoint serves the same series as CSV over
plain HTTPS, which is worth knowing before anyone signs up for
credentials to read a number the St. Louis Fed publishes to the world.
"""

from __future__ import annotations

import csv
import io
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from typing import Any, Mapping

import pandas as pd

#: Constant-maturity rather than the discount-basis DTB3. A discount
#: rate is quoted against face value on a 360-day year and is not
#: something you can compound without converting it first; the constant
#: maturity series is already an investment yield, so the arithmetic
#: below is the arithmetic a reader expects.
FRED_SERIES = "DGS3MO"

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv"

#: ALFRED serves the same CSV shape from a different host, with a
#: `vintage_date` that answers "what did this series look like on that
#: morning". Named here rather than in the caller because it is the same
#: reader, the same parse and the same failure modes — a second copy of
#: this function pointed at a second host is how two callers end up
#: disagreeing about what a missing observation looks like.
ALFRED_CSV = "https://alfred.stlouisfed.org/graph/alfredgraph.csv"

#: Who we are and where to complain. The St. Louis Fed does not demand a
#: contact the way SEC does, but a bulk reader that cannot be identified
#: is a bulk reader that gets blocked as a class rather than asked to
#: slow down.
USER_AGENT = "GriffinFund-Research/0.1 (+newtheyork@gmail.com)"

#: T-bills accrue over calendar days, not sessions, so a rate held over
#: a long weekend earns three days. Using a 252-session convention here
#: would quietly lose the weekends.
DAY_COUNT = 365.0


class TbillUnavailable(RuntimeError):
    """FRED could not be reached. Distinct from a range with no rows."""


class FredNotPublished(TbillUnavailable):
    """FRED answered 404: it does not publish that id, or not yet.

    A subclass rather than a sibling so every existing handler keeps
    catching it, and a distinct type because a 404 here is an ANSWER —
    a typo'd series id, a series that never existed, or an ALFRED
    vintage dated before the series had its first release. Treating that
    as an outage sends somebody to check the network for a mistake that
    is in the argument they passed.
    """


def fetch_observations(
    series: str,
    start: date,
    end: date,
    *,
    timeout: int = 30,
    base: str = FRED_CSV,
    extra_params: Mapping[str, Any] | None = None,
    value_column: str | None = None,
) -> pd.DataFrame:
    """Any FRED series as a date/value frame, without an API key.

    The graph endpoint serves the same numbers as the authenticated
    observations API and asks for nothing. That is worth knowing before
    anyone provisions a credential to read a series the St. Louis Fed
    publishes openly — a key we do not need is a key that can expire,
    leak, or be missing on the one machine that mattered.

    Holidays come back as a literal '.', which is a missing observation
    rather than a zero rate. Reading it as zero would print a day of no
    interest in the middle of a 5% regime, so those rows are dropped
    here and filled by the caller's reindex.

    `base` and `extra_params` exist so ALFRED's vintage endpoint is
    reached through THIS reader rather than a second one written beside
    it — same CSV shape, same '.' convention, same 404 semantics, and
    one place where all three are handled. `fredseries.py` is the caller
    that needs them.
    """
    query: dict[str, Any] = {
        "id": series,
        "cosd": start.isoformat(),
        "coed": end.isoformat(),
    }
    query.update(extra_params or {})
    url = f"{base}?{urllib.parse.urlencode(query)}"

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise FredNotPublished(
                f"FRED has no series {series!r} at {base} for this request "
                f"(HTTP 404). That is an answer rather than an outage: an id "
                f"that does not exist, or a vintage dated before the series "
                f"had its first release."
            ) from exc
        raise TbillUnavailable(
            f"could not read {series} from FRED: HTTP {exc.code}. This is "
            f"our outage, not a statement about interest rates — do not let "
            f"a cash sleeve fall back to zero on the strength of it."
        ) from exc
    except Exception as exc:  # network, DNS, TLS, timeout
        raise TbillUnavailable(
            f"could not read {series} from FRED: {exc}. This is our "
            f"outage, not a statement about interest rates — do not let a "
            f"cash sleeve fall back to zero on the strength of it."
        ) from exc

    rows = list(csv.DictReader(io.StringIO(body)))
    if not rows:
        raise TbillUnavailable(f"FRED returned no rows for {series}")

    # The date column was renamed from DATE to observation_date at some
    # point; accept either rather than breaking on a cosmetic change.
    date_col = "observation_date" if "observation_date" in rows[0] else "DATE"
    value_col = value_column or _value_column(rows[0], series, date_col)

    dates: list[str] = []
    vals: list[float] = []
    for r in rows:
        raw = (r.get(value_col) or "").strip()
        if raw in ("", "."):
            continue
        dates.append(r[date_col])
        vals.append(float(raw))

    out = pd.DataFrame({"date": pd.to_datetime(dates), "value": vals})
    return out.sort_values("date").reset_index(drop=True)


def _value_column(row: Mapping[str, Any], series: str, date_col: str) -> str:
    """Which column holds the numbers, when it is not named for the series.

    ALFRED stamps a vintage pull `CPIAUCSL_20200115`, so a reader keyed
    on the bare id finds nothing and hands back an empty frame — a
    twenty-year history reduced to zero rows with no error anywhere.
    Falling back to the single remaining column is safe precisely
    because it is not a guess: one date column and one value column is
    the whole shape of this CSV. Two value columns means somebody asked
    for several ids at once, which this reader does not support, and
    saying so is better than picking one.
    """
    if series in row:
        return series
    others = [c for c in row if c != date_col]
    if len(others) == 1:
        return others[0]
    raise TbillUnavailable(
        f"FRED's CSV for {series!r} carries columns {sorted(row)}, and none "
        f"of them is the series. Ask for one id per request — a multi-id "
        f"graph URL also silently ignores cosd/coed and hands back every "
        f"observation ever published."
    )


def fetch_rate(start: date, end: date, *, timeout: int = 30) -> pd.Series:
    """Daily annualised 3-month yield, in percent, indexed by date.

    Constant maturity rather than the discount-basis DTB3, so the value
    is already an investment yield and the caller can compound it as it
    stands. Callers that want DTB3 and its discount conversion should
    reach for `fetch_observations` directly.
    """
    obs = fetch_observations(FRED_SERIES, start, end, timeout=timeout)
    s = pd.Series(
        obs["value"].to_numpy(dtype="float64"),
        index=pd.DatetimeIndex(obs["date"]),
        name=FRED_SERIES,
    )
    return s.sort_index()


def total_return_index(
    sessions: pd.DatetimeIndex,
    rate_pct: pd.Series,
    *,
    base: float = 100.0,
) -> pd.Series:
    """Compound the rate into a cash total-return index over `sessions`.

    The rate is forward-filled, which is the right reading: a bill yield
    published on Friday is the yield that accrues over the weekend. It
    is deliberately NOT interpolated toward the next observation, since
    that would use Monday's rate to earn Saturday's interest and is a
    small, tidy piece of lookahead.
    """
    if len(sessions) == 0:
        return pd.Series([], dtype="float64", name="cash_index")

    sessions = pd.DatetimeIndex(sessions).normalize()
    r = rate_pct.reindex(sessions.union(rate_pct.index)).ffill().reindex(sessions)

    # A leading gap means the series starts before FRED has a quote. Back-
    # filling one value is honest; inventing a rate for a year is not, so
    # anything longer is the caller's problem and is left as NaN.
    r = r.bfill(limit=5)
    if r.isna().any():
        first_ok = r.first_valid_index()
        raise TbillUnavailable(
            f"no bill rate available at the start of the requested window; "
            f"first usable observation is {first_ok}. Shorten the window "
            f"rather than assuming a rate."
        )

    days = pd.Series(sessions, index=sessions).diff().dt.days
    # The first session accrues nothing — the index starts at par on it,
    # and crediting a day of interest before the clock starts would show
    # up as a free basis point at every backtest's inception.
    days = days.fillna(0.0)

    daily = (r.to_numpy() / 100.0) * (days.to_numpy() / DAY_COUNT)
    idx = base * (1.0 + pd.Series(daily, index=sessions)).cumprod()
    idx.name = "cash_index"
    return idx


def cash_series(
    sessions: pd.DatetimeIndex, start: date, end: date
) -> tuple[pd.Series, pd.Series]:
    """Convenience: the rate and the compounded index over `sessions`."""
    rate = fetch_rate(start, end)
    return rate, total_return_index(sessions, rate)
