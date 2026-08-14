"""The last three years, reserved, with a lock on the door.

The brief keeps the most recent three years out of every decision and
spends them exactly once, at the very end, with whatever they say
reported unchanged. That rule is easy to state and worth nothing on
its own, because the way it fails is not deceit. It is a person
looking, finding a disappointing number, changing something entirely
reasonable — a lookback, a cap, one line of the sizing rule — and
looking again. After the second look the holdout is training data,
every subsequent result is in-sample, and nobody involved has done
anything they would describe as cheating.

So the discipline is mechanical here rather than remembered.
Development is the default and reserved data RAISES inside it.
Releasing the holdout is a call somebody has to write, with a reason,
and it appends a row to a committed ledger. A second release under a
different configuration is the event this file exists to catch: it
raises, and it puts the date and hash of the access IN FORCE in the
message — plus how many looks have been spent and when the first one
was — because the person about to invalidate a result deserves to be
told what they are invalidating before they do it rather than after.

Three traps are handled explicitly.

  * **The guard that only guards the obvious path.** Reserved data
    does not usually arrive as somebody typing 2026 into a date field;
    it arrives as a panel that was never cut. `check` therefore takes
    frames, indexes and series rather than only dates, and the numeric
    input it refuses is the reason — a float column handed to
    `pd.to_datetime` becomes nanoseconds after 1970, sails through
    every date comparison in this file, and returns the most
    reassuring wrong answer available.

  * **A released flag inferred from the ledger.** It would be
    convenient for a second process to notice that the holdout has
    already been opened and let itself in. That is the whole failure
    mode with a helper function attached. Release state lives on the
    guard instance and is set by calling `release`, so every process
    that reads reserved data writes a row saying it did.

  * **The wall clock.** Nothing here calls `datetime.now()`. The
    timestamp on an access is an argument, for the same reason
    `metrics.TrialCounter.record` takes one: a record of when we
    looked cannot be tested for determinism if it invents the answer,
    and this is the one ledger in the project that has to be beyond
    argument.

Note what is deliberately NOT here: any way to un-release, delete an
access, or rewind the ledger. Those are not missing features.
"""

from __future__ import annotations

import json
import warnings
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import pandas as pd

from ..config import HOLDOUT_YEARS, SAMPLE_START
from ..engine.metrics import TrialCounter

__all__ = [
    "HOLDOUT_ACCESS_PATH",
    "HoldoutAccess",
    "HoldoutBreach",
    "HoldoutError",
    "HoldoutGuard",
    "HoldoutLedger",
    "HoldoutLogCorrupt",
    "HoldoutOverrideWarning",
    "HoldoutReuse",
    "HoldoutWindow",
    "hash_config",
    "holdout_window",
    "training_window",
]


#: Deliberately NOT in .gitignore, for the same reason `trials.jsonl`
#: is not. See `HoldoutLedger`.
HOLDOUT_ACCESS_PATH = Path(__file__).resolve().parents[2] / "holdout_access.jsonl"


class HoldoutError(RuntimeError):
    """The holdout was asked for something the discipline forbids."""


class HoldoutBreach(HoldoutError):
    """Reserved data was requested by a process still in development.

    Not a data error and not a bug in the caller's arithmetic — the
    caller asked a perfectly sensible question of days it is not
    allowed to see yet.
    """


class HoldoutReuse(HoldoutError):
    """A second release, under a configuration that is not the first's.

    The one this module exists for. Everything else here is plumbing
    around the moment somebody looks twice.
    """


class HoldoutLogCorrupt(RuntimeError):
    """The access ledger has a line that will not parse.

    Raised rather than skipped, and the reasoning is the same as the
    trial log's, one step more serious: a dropped line can erase the
    only record of a first access, and a second look with no first
    look on file is indistinguishable from an honest one.
    """


class HoldoutOverrideWarning(UserWarning):
    """Somebody invalidated a holdout result on purpose."""


def hash_config(config: Mapping[str, Any] | str) -> str:
    """The same configuration identity the trial ledger uses.

    Deliberately borrowed rather than reimplemented. The two files
    have to be joinable: reading `holdout_access.jsonl` next to
    `trials.jsonl` should answer "which of the N things we tried is
    the one we spent the holdout on", and it cannot if the same
    configuration hashes to two different strings in two places.
    """
    return TrialCounter.hash_config(config)


# -- the window ---------------------------------------------------------


@dataclass(frozen=True)
class HoldoutWindow:
    """The reserved range, inclusive at both ends.

    `start` and `end` are dates rather than sessions on purpose. A
    session index belongs to a particular panel and this boundary has
    to mean the same thing to the price frame, the fundamentals frame
    and a person reading the report.
    """

    start: pd.Timestamp
    end: pd.Timestamp
    years: int

    @property
    def training_end(self) -> pd.Timestamp:
        """The last day development is allowed to see.

        A calendar day before the window opens, not a session before:
        the boundary must not move when somebody hands this a panel
        with a different trading calendar in it.
        """
        return self.start - pd.Timedelta(days=1)

    def contains(self, when: Any) -> bool:
        ts = _timestamp(when)
        return bool(self.start <= ts <= self.end)

    def __contains__(self, when: Any) -> bool:
        return self.contains(when)

    def overlap(self, dates: pd.DatetimeIndex) -> pd.DatetimeIndex:
        """The dates that fall inside. Empty means nothing to answer for."""
        if len(dates) == 0:
            return pd.DatetimeIndex([], dtype="datetime64[ns]")
        inside = (dates >= self.start) & (dates <= self.end)
        return pd.DatetimeIndex(dates[inside])

    @property
    def key(self) -> str:
        """The window as one string, for the ledger and for messages."""
        return f"{self.start.date()}..{self.end.date()}"

    def describe(self) -> str:
        return (
            f"the reserved holdout {self.key} ({self.years} year(s); "
            f"development ends {self.training_end.date()})"
        )


def holdout_window(
    end: str | date | datetime | pd.Timestamp,
    years: int = HOLDOUT_YEARS,
) -> HoldoutWindow:
    """The last `years` of a sample ending at `end`, reserved.

    `end` is required and there is no default of "today". A reserved
    range whose boundary depends on when the script happened to run is
    a range that quietly grows a day of new out-of-sample every
    morning and quietly re-includes the day it dropped, which is a
    slower version of the failure this file is about.

    The window is inclusive at both ends, so a three-year holdout
    ending 31 December 2026 opens on 1 January 2024. One arithmetic
    wrinkle, stated rather than fought, and stated in the direction it
    actually goes: a sample ending 29 February has no anniversary to
    subtract to, so `DateOffset` clamps to the 28th and the window opens
    on 1 March of the earlier year. A one-year holdout ending 29
    February 2024 therefore runs 2023-03-01..2024-02-29 — 366 days, a
    day LONG of the round number rather than short, because the leap day
    it clamped past is inside the window and not outside it. Nothing
    downstream is sensitive to a day, and pretending otherwise would
    need a convention about leap years that no report would ever
    explain.
    """
    y = int(years)
    if y < 1:
        raise HoldoutError(
            f"a holdout of {y} year(s) reserves nothing. If the intention is "
            "to run without a holdout, that is a decision to write down in "
            "the report, not a zero to pass in here."
        )
    last = _timestamp(end)
    start = (last - pd.DateOffset(years=y)) + pd.Timedelta(days=1)
    return HoldoutWindow(start=pd.Timestamp(start).normalize(), end=last, years=y)


def training_window(
    end: str | date | datetime | pd.Timestamp,
    *,
    years: int = HOLDOUT_YEARS,
    sample_start: str | date | datetime | pd.Timestamp = SAMPLE_START,
) -> tuple[pd.Timestamp, pd.Timestamp]:
    """The other side of the same cut, so nobody derives it twice.

    Returned as a pair rather than a `HoldoutWindow` because it is not
    one — nothing guards it, and a type that looks like the reserved
    range but is not would be an unpleasant thing to mix up.
    """
    window = holdout_window(end, years=years)
    first = _timestamp(sample_start)
    if first > window.training_end:
        raise HoldoutError(
            f"the sample starts {first.date()} and the holdout opens "
            f"{window.start.date()}: there is no training period left. "
            "Either the sample is too short for a holdout this long or the "
            "end date is wrong."
        )
    return first, window.training_end


# -- the access ledger --------------------------------------------------


@dataclass(frozen=True)
class HoldoutAccess:
    """One release, as it appears on disk.

    Every field is a JSON scalar so a line stays readable in a diff by
    somebody who has never opened this file. `window` is recorded
    alongside the configuration hash because shrinking the holdout is
    another way to get a second look, and a reader comparing two rows
    should be able to see it without recomputing anything.
    """

    timestamp: str
    reason: str
    config_hash: str
    window: str
    override: bool
    override_reason: str
    supersedes: str

    def describe(self) -> str:
        stem = (
            f"{self.timestamp}: holdout {self.window} released against config "
            f"{self.config_hash[:12]} — {self.reason}"
        )
        if not self.override:
            return stem
        return (
            f"{stem} [OVERRIDE, superseding {self.supersedes[:12]}: "
            f"{self.override_reason}]"
        )


class HoldoutLedger:
    """Append-only record of every time the holdout was opened.

    The file at `holdout_access.jsonl` is deliberately NOT gitignored,
    and the reason is the one that keeps `trials.jsonl` in the
    repository too: a record that can be quietly deleted is not a
    record. The value of a holdout is entirely a claim about process —
    that these three years informed no decision — and that claim is
    unfalsifiable unless the history of who opened them, when, and
    against what configuration is somewhere a reader can check. In the
    tree, a second access shows up in a diff. Outside it, the reader
    has our word.

    The class enforces the same property mechanically. The file is
    opened in append mode and nowhere in this module is it opened any
    other way. There is no `reset`, no `clear` and no `remove`, and
    adding one would delete the only guarantee this class offers.
    """

    def __init__(self, path: Path | str = HOLDOUT_ACCESS_PATH) -> None:
        self.path = Path(path)

    # -- writing --------------------------------------------------------

    def append(self, access: HoldoutAccess) -> HoldoutAccess:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Mode "a" and only ever "a".
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(access), sort_keys=True) + "\n")
        return access

    # -- reading --------------------------------------------------------

    def accesses(self) -> list[HoldoutAccess]:
        """Every release, in the order it was written.

        File order, never sorted by the timestamp field. The timestamp
        is supplied by the caller and a caller who passed a wrong one
        — or a deliberately early one — must not be able to reorder
        history into a shape where their access looks like the first.
        """
        if not self.path.exists():
            return []
        out: list[HoldoutAccess] = []
        with self.path.open("r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, start=1):
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                    out.append(
                        HoldoutAccess(
                            timestamp=str(obj["timestamp"]),
                            reason=str(obj["reason"]),
                            config_hash=str(obj["config_hash"]),
                            window=str(obj["window"]),
                            override=bool(obj["override"]),
                            override_reason=str(obj.get("override_reason", "")),
                            supersedes=str(obj.get("supersedes", "")),
                        )
                    )
                except (ValueError, KeyError, TypeError) as exc:
                    raise HoldoutLogCorrupt(
                        f"{self.path}:{lineno} will not parse ({exc}). Refusing "
                        "to skip it — a dropped line can erase the record of a "
                        "first access, and a second look with no first look on "
                        "file reads exactly like an honest one."
                    ) from exc
        return out

    def first_access(self) -> HoldoutAccess | None:
        """The first look. None means the door is still shut.

        The moment these years stopped being untouched, and no later row
        gives that back — which is why it stays in the refusal message
        even though it is not what a new release is compared against.
        """
        recs = self.accesses()
        return recs[0] if recs else None

    def last_access(self) -> HoldoutAccess | None:
        """The access IN FORCE: the terms a new release has to match.

        Distinct from `first_access` only after an override, which is
        exactly the case where the difference decides whether somebody
        reproducing the reported number has to invalidate it again to do
        so. See `HoldoutGuard.release`.
        """
        recs = self.accesses()
        return recs[-1] if recs else None

    def count(self) -> int:
        return len(self.accesses())

    def frame(self) -> pd.DataFrame:
        recs = self.accesses()
        return pd.DataFrame(
            {
                "timestamp": pd.Series([r.timestamp for r in recs], dtype="str"),
                "reason": pd.Series([r.reason for r in recs], dtype="str"),
                "config_hash": pd.Series([r.config_hash for r in recs], dtype="str"),
                "window": pd.Series([r.window for r in recs], dtype="str"),
                "override": pd.Series([r.override for r in recs], dtype="bool"),
                "override_reason": pd.Series(
                    [r.override_reason for r in recs], dtype="str"
                ),
                "supersedes": pd.Series([r.supersedes for r in recs], dtype="str"),
            }
        )


# -- the guard ----------------------------------------------------------


class HoldoutGuard:
    """Development by default. Reserved data raises until released.

    The intended shape of a session with this object is short:

        guard = HoldoutGuard.for_sample("2026-12-31")
        train = guard.training_slice(panel)      # all development ever sees
        ...
        guard.release(reason=..., config=..., timestamp=...)
        final = guard.holdout_slice(panel)       # once, at the end

    `released` is instance state set by `release`, and is never
    inferred from the ledger having rows in it. Inferring it would let
    the second process through without writing anything down, which is
    the failure mode wearing a convenience feature.
    """

    def __init__(
        self,
        window: HoldoutWindow,
        *,
        ledger: HoldoutLedger | None = None,
        path: Path | str = HOLDOUT_ACCESS_PATH,
    ) -> None:
        self.window = window
        self.ledger = ledger if ledger is not None else HoldoutLedger(path)
        self._access: HoldoutAccess | None = None

    @classmethod
    def for_sample(
        cls,
        end: str | date | datetime | pd.Timestamp,
        *,
        years: int = HOLDOUT_YEARS,
        ledger: HoldoutLedger | None = None,
        path: Path | str = HOLDOUT_ACCESS_PATH,
    ) -> HoldoutGuard:
        return cls(holdout_window(end, years=years), ledger=ledger, path=path)

    # -- state ----------------------------------------------------------

    @property
    def released(self) -> bool:
        return self._access is not None

    @property
    def access(self) -> HoldoutAccess | None:
        """The release this guard made, or None while in development."""
        return self._access

    @property
    def mode(self) -> str:
        return "final evaluation" if self.released else "development"

    def __repr__(self) -> str:
        return f"HoldoutGuard({self.window.key}, mode={self.mode})"

    # -- checking -------------------------------------------------------

    def check(
        self,
        obj: Any,
        *,
        what: str = "the data supplied",
        column: str | None = None,
    ) -> None:
        """Raise if anything in `obj` falls inside the reserved window.

        Takes whatever the caller has in hand — a frame, an index, a
        series, a single date — because the realistic breach is not a
        typed-in date, it is a panel nobody remembered to cut.
        """
        if self.released:
            return
        offending = self.window.overlap(_dates(obj, column=column))
        if len(offending) == 0:
            return
        raise HoldoutBreach(
            f"{what} reaches into {self.window.describe()}: "
            f"{len(offending):,} observation(s) between "
            f"{offending.min().date()} and {offending.max().date()}. This "
            "process is in DEVELOPMENT, where those years do not exist — cut "
            f"the data at {self.window.training_end.date()} (that is what "
            "`training_slice` does). If this really is the final evaluation, "
            "call `release(reason=..., config=..., timestamp=...)` first: it "
            "is a one-time act and it writes a committed row saying so."
        )

    def require_released(self, what: str = "this step") -> None:
        """Assert the door is open, for code that must not run before it.

        The mirror of `check`, and it earns its place on the paths that
        take no data as an argument — writing the final report, say,
        where there is no frame to inspect and the only evidence that
        the run is legitimate is whether anyone released the holdout.
        """
        if self.released:
            return
        raise HoldoutBreach(
            f"{what} requires the holdout, and this process is in "
            f"development. Nothing has been released for {self.window.key}."
        )

    # -- slicing --------------------------------------------------------

    def training_slice(self, obj: Any, *, column: str | None = None) -> Any:
        """Everything strictly before the window. Never raises.

        Safe to call in either mode: taking the training slice during
        the final evaluation is an ordinary thing to want, usually for
        a chart that puts the two periods side by side.
        """
        return _restrict(obj, column=column, keep=lambda d: d < self.window.start)

    def holdout_slice(self, obj: Any, *, column: str | None = None) -> Any:
        """The reserved rows. Raises unless the holdout has been released.

        This is the call the whole file is arranged around, which is
        why it is a method and not a slice somebody writes inline: the
        one place the reserved data is handed over is a place that can
        refuse.
        """
        self.require_released("reading the holdout period")
        return _restrict(
            obj,
            column=column,
            keep=lambda d: (d >= self.window.start) & (d <= self.window.end),
        )

    # -- releasing ------------------------------------------------------

    def release(
        self,
        *,
        reason: str,
        config: Mapping[str, Any] | str,
        timestamp: datetime | date | str,
        override: bool = False,
        override_reason: str = "",
    ) -> HoldoutAccess:
        """Open the holdout, once, and write down that it happened.

        `config` is the strategy configuration being evaluated, hashed
        the same way the trial ledger hashes it. That hash is the whole
        mechanism: a release under a configuration the ledger has not
        seen is, by definition, a second look at these three years by
        something that changed after the first look — which is the
        thing the reserved period was reserved against.

        `override` exists because the legitimate case is real: a bug in
        the engine, a vendor restatement, a constraint that turned out
        to be wrong. What it does not do is let the invalidation happen
        quietly. It requires a written `override_reason`, it warns, and
        it records both the reason and the hash it superseded, so the
        result reported afterwards can be read next to the record of
        what it cost.

        The comparison is against the access IN FORCE — the last row on
        file — and not against the first one, and that is a judgement
        rather than an obvious reading. The case for the other answer is
        real: the first look is when these years stopped being
        untouched, and nothing later gives that back. But the first look
        is not what a release is being compared TO. It is compared to
        the configuration this period has already been spent on, and
        after a legitimate override that is the overriding one.
        Measuring against the first row forever costs two things and
        buys none. Reproducing the CURRENT reported result would need
        `override=True`, so the ledger fills with override rows
        recording supersessions that never happened and the flag stops
        meaning what it says — a control that has to stay rare becomes a
        keystroke. And `supersedes` would name a configuration two steps
        back, so a reader tracing the chain is sent to the wrong
        predecessor at every link after the first.

        Nothing is loosened. Each new configuration still costs exactly
        one written, warned override; what stops costing one is
        re-running the result already on file, which was never a second
        look at anything. The first access keeps its place — it is
        `first_access()`, it is named in the refusal, and the number of
        looks already spent is named beside it, because "you are the
        fourth person to open this" is the fact that actually matters.
        """
        if not reason or not reason.strip():
            raise HoldoutError(
                "a release needs a reason. An unexplained access to the "
                "holdout is the same event as an unrecorded one to anybody "
                "reading the ledger later."
            )

        config_hash = hash_config(config)
        # One read, so the row in force and the row that started it all
        # cannot come from two different states of the file.
        spent = self.ledger.accesses()
        prior = spent[-1] if spent else None
        changed = _differences(prior, config_hash, self.window.key)

        if prior is None and override:
            raise HoldoutError(
                "override=True with an empty ledger. There is no earlier "
                "access to supersede — this is the first look, and the first "
                "look does not need one."
            )
        if prior is not None and not changed and override:
            raise HoldoutError(
                "override=True but nothing changed: same configuration, same "
                f"window, recorded {prior.timestamp}. Re-running the recorded "
                "evaluation is reproduction, not a second look, and it needs "
                "no override. Drop the flag."
            )
        if changed and not override:
            # The row in force is what the refusal is about, but the
            # count and the first date are what tell somebody where in
            # the sequence they are standing.
            history = (
                ""
                if len(spent) < 2
                else (
                    f"\nThis would not be the second look either: "
                    f"{len(spent)} release(s) are already on file, the "
                    f"earliest on {spent[0].timestamp}."
                )
            )
            raise HoldoutReuse(
                f"the holdout was already released on {prior.timestamp} "
                f"against config {prior.config_hash} over {prior.window} "
                f'("{prior.reason}"), and {" and ".join(changed)}.\n'
                "Spending it again is not a smaller version of the first "
                "look — it makes every result since the first one in-sample, "
                "including the one you are about to compute. If that is "
                "genuinely the right call (an engine bug, a vendor "
                "restatement), pass override=True with an override_reason "
                "saying so; it will be recorded next to this row and the "
                f"write-up has to carry it.{history}"
            )

        if override:
            if not override_reason or not override_reason.strip():
                raise HoldoutError(
                    "override=True needs an override_reason. Invalidating a "
                    "holdout result is allowed and is not allowed to be "
                    "casual: write the sentence that will sit in the ledger "
                    "beside the number nobody can trust any more."
                )
            warnings.warn(
                f"HOLDOUT OVERRIDE: releasing {self.window.key} against config "
                f"{config_hash[:12]}, superseding the access of "
                f"{prior.timestamp} ({prior.config_hash[:12]}). Every result "
                "computed on this period from here on is in-sample. Reason: "
                f"{override_reason.strip()}",
                HoldoutOverrideWarning,
                stacklevel=2,
            )

        access = HoldoutAccess(
            timestamp=_iso(timestamp),
            reason=reason.strip(),
            config_hash=config_hash,
            window=self.window.key,
            override=bool(override),
            override_reason=override_reason.strip() if override else "",
            supersedes=prior.config_hash if (override and prior) else "",
        )
        self.ledger.append(access)
        self._access = access
        return access


def _differences(
    prior: HoldoutAccess | None, config_hash: str, window_key: str
) -> list[str]:
    """What a new release changes about the recorded one.

    The window is compared alongside the hash because a shorter
    holdout is a second look wearing the first look's configuration:
    re-run the same strategy over one reserved year instead of three
    and the ledger, checking only the hash, would call it a
    reproduction.
    """
    if prior is None:
        return []
    out: list[str] = []
    if prior.config_hash != config_hash:
        out.append(f"this release carries a different configuration ({config_hash})")
    if prior.window != window_key:
        out.append(f"this release reserves a different window ({window_key})")
    return out


# -- reading dates out of whatever the caller had -----------------------


#: Looked for in a frame, in this order, when no column is named. Both
#: are point-in-time dates: `date` is when a bar printed, `date_public`
#: when a filing became knowable. `period_end` is deliberately absent —
#: a quarter that ENDED inside the holdout may well have been filed
#: after it, and refusing that row would reserve data the reserved
#: period does not contain.
_DATE_COLUMNS: tuple[str, ...] = ("date", "date_public")


def _dates(obj: Any, *, column: str | None = None) -> pd.DatetimeIndex:
    """Every date in `obj`, normalised, NaT dropped.

    Numeric input is refused rather than converted, and that refusal is
    the most important line in this function. `pd.to_datetime` reads a
    float column as nanoseconds since 1970, so a mis-typed date column
    would arrive here as a set of dates in January 1970, fall outside
    every holdout ever configured, and return a clean bill of health
    for a panel nobody checked.
    """
    if obj is None:
        return pd.DatetimeIndex([], dtype="datetime64[ns]")

    if isinstance(obj, pd.DataFrame):
        if column is not None:
            if column not in obj.columns:
                raise HoldoutError(
                    f"no column {column!r} in the frame; got {sorted(obj.columns)}"
                )
            return _dates(obj[column])
        if isinstance(obj.index, pd.DatetimeIndex):
            return _dates(obj.index)
        found = next((c for c in _DATE_COLUMNS if c in obj.columns), None)
        if found is None:
            raise HoldoutError(
                "cannot tell which dates to check: the frame has no "
                f"DatetimeIndex and none of {list(_DATE_COLUMNS)}. Name the "
                "column explicitly rather than letting this guess — a guess "
                "that picks the wrong column checks the wrong thing and says "
                f"nothing. Columns: {sorted(obj.columns)}"
            )
        return _dates(obj[found])

    if isinstance(obj, pd.Series):
        if pd.api.types.is_datetime64_any_dtype(obj):
            return _clean(pd.DatetimeIndex(obj.dropna()))
        if isinstance(obj.index, pd.DatetimeIndex):
            return _clean(pd.DatetimeIndex(obj.index))
        return _dates(obj.to_numpy())

    if isinstance(obj, pd.DatetimeIndex):
        return _clean(obj)

    if isinstance(obj, pd.Index):
        return _dates(obj.to_numpy())

    if isinstance(obj, (pd.Timestamp, datetime, date, str)):
        return _clean(pd.DatetimeIndex([_timestamp(obj)]))

    if isinstance(obj, np.ndarray) or isinstance(obj, Iterable):
        arr = np.asarray(list(obj) if not isinstance(obj, np.ndarray) else obj)
        if arr.size == 0:
            return pd.DatetimeIndex([], dtype="datetime64[ns]")
        if arr.dtype.kind in "ifub":
            raise HoldoutError(
                f"refusing to read dates out of a {arr.dtype} array. Numbers "
                "convert to 1970 without complaining and then clear every "
                "holdout check ever written; pass real timestamps."
            )
        return _clean(pd.DatetimeIndex(pd.to_datetime(arr)))

    raise HoldoutError(f"cannot read dates from {type(obj)!r}")


def _clean(idx: pd.DatetimeIndex) -> pd.DatetimeIndex:
    out = pd.DatetimeIndex(idx).dropna()
    if getattr(out, "tz", None) is not None:
        # A tz-aware boundary against a tz-naive window compares as an
        # exception rather than as a date, and the whole panel is naive
        # NYSE sessions anyway.
        out = out.tz_localize(None)
    return pd.DatetimeIndex(out.normalize())


def _restrict(obj: Any, *, column: str | None, keep: Any) -> Any:
    """Return `obj` cut down to the dates `keep` accepts.

    Shaped as a mask rather than a `.loc[a:b]` slice because a long
    frame is not sorted by date in any way this module may assume, and
    a label slice on an unsorted index returns whatever happens to lie
    between the two labels.
    """
    if isinstance(obj, pd.DataFrame):
        if column is None and isinstance(obj.index, pd.DatetimeIndex):
            return obj.loc[np.asarray(keep(_clean(obj.index)))]
        col = column or next((c for c in _DATE_COLUMNS if c in obj.columns), None)
        if col is None:
            raise HoldoutError(
                "cannot cut this frame: no DatetimeIndex and no date column. "
                f"Name one. Columns: {sorted(obj.columns)}"
            )
        return obj.loc[np.asarray(keep(_clean(pd.DatetimeIndex(obj[col]))))]

    if isinstance(obj, pd.Series):
        if pd.api.types.is_datetime64_any_dtype(obj):
            return obj.loc[np.asarray(keep(_clean(pd.DatetimeIndex(obj))))]
        if isinstance(obj.index, pd.DatetimeIndex):
            return obj.loc[np.asarray(keep(_clean(pd.DatetimeIndex(obj.index))))]
        raise HoldoutError(
            "cannot cut a series that is neither dated nor indexed by date"
        )

    if isinstance(obj, pd.DatetimeIndex):
        cleaned = _clean(obj)
        return pd.DatetimeIndex(cleaned[np.asarray(keep(cleaned))])

    raise HoldoutError(
        f"cannot cut {type(obj)!r}; pass a frame, a series or a DatetimeIndex"
    )


def _timestamp(when: Any) -> pd.Timestamp:
    ts = pd.Timestamp(when)
    if ts is pd.NaT:
        raise HoldoutError(f"{when!r} is not a date")
    if ts.tz is not None:
        ts = ts.tz_localize(None)
    return ts.normalize()


def _iso(ts: datetime | date | str) -> str:
    """A caller-supplied timestamp, unchanged if it is already a string.

    No `now()` fallback and no default. A ledger entry that dates
    itself is a ledger entry no test can pin down, and this is the one
    file in the project where that matters most.
    """
    if isinstance(ts, str):
        if not ts.strip():
            raise HoldoutError("timestamp is empty")
        return ts
    if isinstance(ts, (datetime, date)):
        return ts.isoformat()
    raise HoldoutError(
        f"timestamp must be a datetime, date or ISO string, got {ts!r}"
    )
