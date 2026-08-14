"""Cross-validation for series whose answers arrive late.

Ordinary k-fold leaks on financial data, and it leaks silently. A label
that spans 21 days is not known on the day it is dated: an observation
dated T carries information through T+21. Leave that observation in a
training fold and every test observation falling between T and T+21 has
been partly answered before the model ever sees it. Nothing raises,
nothing comes back NaN, no column is obviously wrong — the only symptom
is that the out-of-sample numbers are better than they should be, which
is the one symptom nobody investigates. A failure that announces itself
costs an afternoon; this one costs a strategy.

**Purging** drops the training observations whose label windows overlap
the test fold. **Embargoing** drops a further band immediately after
the fold, because serial correlation does not stop at a boundary: the
bars just after a test period carry features built from trailing
windows that reach into it, and are nearly as contaminated as the bars
inside it.

Both are Marcos Lopez de Prado's, and this follows his treatment:
*Advances in Financial Machine Learning* (Wiley, 2018), chapter 7 for
purging and embargoing, chapter 12 for the combinatorial variant.

Five things here are decisions rather than transcription.

**The purge runs against the fold's INFORMATION SPAN, not its dates.**
A test observation on the fold's last bar has a label reaching h bars
past it, so the training observation immediately after the fold has a
label window overlapping a test label window — even though its date is
outside the test period entirely. Purging on dates alone leaves exactly
h contaminated rows on the right-hand seam of every fold, which is the
subtle version of the bug this file exists to prevent, wearing the
costume of the fix.

**The embargo is measured from the end of that span**, not from the
last test date, or the first h bars of the band would be spent on bars
the purge had already taken and the embargo would be shorter than the
number printed next to it.

**The embargo is a fraction of the WHOLE sample**, which is Lopez de
Prado's convention and is worth saying out loud: 1% across ten folds is
about a tenth of a fold, not a hundredth. It rounds UP, and a requested
embargo never silently becomes zero — truncating 0.01 x 60 bars to
nothing while the report still says `embargo_pct=0.01` is how a split
comes to be described as embargoed when it is not. It is also always in
BARS, including under `horizon_unit="calendar_days"`, where the label
window beside it is not; see `HorizonUnit` before reading the two
integers as though they agreed.

**Nothing is shuffled and no `shuffle` argument is offered.** Folds are
contiguous blocks of the index. Shuffling scatters every fold across
the sample, which multiplies the seams a purge has to close by roughly
the fold size and destroys the only structure that makes purging
meaningful in the first place.

**The leak check is a public function and derives its answer its own
way.** `check_leakage` does not ask the splitter what it purged; it
takes a train set, a test set and the label windows, and tests the
defining property pairwise — no training window may intersect ANY test
window, and no training observation may sit in an embargo band. A
self-check that reuses the splitter's arithmetic can only catch a
caller's mistake, never the splitter's, and the splitter is the thing
worth doubting. Because it takes the embargo as an argument rather than
reading it off the split, its default matches the splitters' — checking
with too much embargo cries wolf, checking with too little hands back a
clearance it never tested for.

One discipline this file cannot enforce. Cross-validation happens
inside the training sample, and nothing here knows where that stops —
pass an index that already ends at `validation.holdout.training_window`
rather than trusting a fold boundary to fall somewhere polite.
`config.HOLDOUT_YEARS` is not a fold, and a splitter handed the whole
sample will happily test on the reserved years and spend the one honest
look this project gets. And every configuration scored through these
splits is a trial that owes `engine.metrics.TrialCounter` a row —
including, especially, the ones that scored badly.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from itertools import combinations
from typing import Iterator, Literal

import numpy as np
import pandas as pd

__all__ = [
    "CombinatorialPurgedCV",
    "LeakageError",
    "LeakageReport",
    "PurgedCVError",
    "PurgedKFold",
    "assert_no_leakage",
    "check_leakage",
    "label_end_times",
]

#: `bars` counts positions in the supplied index, `calendar_days` counts
#: wall-clock days. On a session index the same integer means a longer
#: span under `bars` — 21 bars is a month, 21 calendar days is fifteen
#: sessions — which is why `bars` is the default: it is both the natural
#: reading of a forward-return label and the more conservative of the
#: two. A horizon that under-purges is a leak; one that over-purges
#: costs data.
#:
#: **Under `calendar_days` the two arguments in the same call speak
#: different units, and nothing anywhere converts between them.** The
#: label window is calendar days; the embargo is, always and in both
#: modes, a fraction of the OBSERVATION COUNT and therefore a number of
#: bars. So `PurgedKFold(5, 21, 0.01, horizon_unit="calendar_days")` on a
#: thousand sessions purges a fifteen-session window and then embargoes
#: ten SESSIONS behind it, which is a fortnight of tape. This follows
#: Lopez de Prado, who defines the embargo as a fraction of the sample
#: and says nothing about the calendar, and it is not a bug — but it is
#: the one place in this file where reading either integer in the other's
#: unit gives an answer that is wrong and plausible at the same time. If
#: the two need to mean the same thing, pass `label_end` and build the
#: windows yourself.
HorizonUnit = Literal["bars", "calendar_days"]

#: Lopez de Prado's figure, and the default here for the same reason he
#: gives it: some embargo is nearly always right, and a caller who wants
#: none should have to type the zero.
DEFAULT_EMBARGO_PCT = 0.01

#: C(n, k) grows fast enough to turn a typo into a machine that fits
#: models until Tuesday. C(20, 10) is 184,756 splits.
MAX_COMBINATORIAL_SPLITS = 20_000


class PurgedCVError(ValueError):
    """The splitter was asked for something it cannot do honestly."""


class LeakageError(AssertionError):
    """A split that would train on the answer.

    An `AssertionError` rather than a `ValueError`, because it is not a
    complaint about an argument — it is a statement that a property the
    rest of this file promises does not hold. A test suite catching
    `PurgedCVError` for malformed inputs should not swallow this.
    """


# -- label windows ------------------------------------------------------


def label_end_times(
    index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
    *,
    label_horizon: int,
    horizon_unit: HorizonUnit = "bars",
) -> pd.Series:
    """When each observation's label stops being unknown.

    This is the series everything else in the file is derived from, and
    it is exposed so a reader can look at it rather than trust it. An
    observation dated T with a 21-bar horizon has a window of
    [T, T+21 bars]; anything overlapping that window has seen part of
    its answer.

    The final `label_horizon` observations get a window clamped to the
    last bar in the sample. Their labels are in fact incomplete and a
    caller building labels should have dropped them; clamping is the
    only honest thing available to a splitter, which cannot purge
    against data that does not exist. It errs the safe way — the clamped
    window is shorter than the true one, so those rows are the last
    candidates to be purged and the first to be caught by the embargo.
    """
    idx = _as_index(index)
    h = int(label_horizon)
    if h < 0:
        raise PurgedCVError(
            f"label_horizon must be zero or more, got {label_horizon!r}. "
            "A negative horizon is a label that resolves before its own "
            "observation, which is not a leak to be purged but a bug "
            "upstream in how the label was built."
        )
    n = len(idx)
    if horizon_unit == "bars":
        ends = idx.to_numpy()[np.minimum(np.arange(n) + h, n - 1)]
    elif horizon_unit == "calendar_days":
        ends = (idx + pd.Timedelta(days=h)).to_numpy()
    else:
        raise PurgedCVError(
            f"horizon_unit must be 'bars' or 'calendar_days', got "
            f"{horizon_unit!r}"
        )
    return pd.Series(ends, index=idx, name="label_end")


def _end_positions(idx: pd.DatetimeIndex, label_end: pd.Series) -> np.ndarray:
    """Map each label end to the last index position it reaches.

    Everything downstream compares positions rather than timestamps, and
    that is exact rather than convenient: because the fold boundaries
    are themselves index elements, flooring a label end to the last bar
    at or before it preserves every comparison the purge makes. A label
    ending between two sessions genuinely reaches only the earlier one.
    """
    ends = _as_end_series(idx, label_end)
    pos = np.asarray(idx.searchsorted(ends.to_numpy(), side="right")) - 1
    own = np.arange(len(idx))
    behind = np.flatnonzero(pos < own)
    if behind.size:
        i = int(behind[0])
        raise PurgedCVError(
            f"the label for {idx[i].date()} ends at "
            f"{pd.Timestamp(ends.iloc[i]).date()}, before the observation "
            "itself. A label window that runs backwards would purge the "
            "wrong side of every fold."
        )
    return pos.astype(np.int64)


def _as_end_series(idx: pd.DatetimeIndex, label_end: pd.Series) -> pd.Series:
    if not isinstance(label_end, pd.Series):
        return pd.Series(
            np.asarray(label_end, dtype="datetime64[ns]"), index=idx
        )
    if not label_end.index.equals(idx):
        # Reindexing here would align some rows and quietly invent NaT
        # for the rest, and a missing label window purges nothing.
        raise PurgedCVError(
            f"label_end is indexed by {len(label_end):,} timestamps that do "
            f"not match the {len(idx):,} being split. Supply one label end "
            "per observation, on the same index, in the same order."
        )
    return label_end


# -- index and position plumbing ----------------------------------------


def _as_index(
    obj: pd.DatetimeIndex | pd.Series | pd.DataFrame,
) -> pd.DatetimeIndex:
    idx = obj.index if isinstance(obj, (pd.Series, pd.DataFrame)) else obj
    if not isinstance(idx, pd.DatetimeIndex):
        raise PurgedCVError(
            f"purged CV needs a DatetimeIndex (or a Series/DataFrame carrying "
            f"one), got {type(idx).__name__}. Purging is a statement about "
            "time; an integer index cannot say when a label ended."
        )
    if len(idx) == 0:
        raise PurgedCVError("nothing to split: the index is empty")
    if not idx.is_monotonic_increasing or idx.has_duplicates:
        raise PurgedCVError(
            "the index must be strictly increasing. Position IS time in this "
            "file — every fold is a contiguous run of positions and every "
            "embargo is counted in them — so an unsorted or duplicated index "
            "produces folds that look contiguous and are not."
        )
    return idx


def _contiguous_runs(positions: np.ndarray) -> tuple[tuple[int, int], ...]:
    """Split sorted positions into `(first, last)` inclusive runs.

    A k-fold test set is one run. A combinatorial test set is up to k of
    them, and two groups that happen to be adjacent merge into one here
    — which they must, or the gap between them would be treated as
    trainable ground that does not exist.
    """
    p = np.unique(np.asarray(positions, dtype=np.int64))
    if p.size == 0:
        return ()
    breaks = np.flatnonzero(np.diff(p) > 1)
    starts = np.concatenate(([p[0]], p[breaks + 1]))
    stops = np.concatenate((p[breaks], [p[-1]]))
    return tuple((int(a), int(b)) for a, b in zip(starts, stops))


def _embargo_size(n_observations: int, embargo_pct: float) -> int:
    """Bars of embargo, rounded UP whenever any was asked for."""
    if embargo_pct <= 0.0:
        return 0
    return max(1, math.ceil(int(n_observations) * float(embargo_pct)))


@dataclass(frozen=True)
class _FoldPlan:
    """One split, with the reason every dropped row was dropped.

    The accounting is kept because purging is not free and the bill
    should be readable. A fold that retains 12% of the sample is not
    wrong, but it is a different experiment from one that retains 80%,
    and `describe` is where that becomes visible instead of inferred.
    """

    fold: int
    blocks: tuple[tuple[int, int], ...]
    test: np.ndarray
    train: np.ndarray
    purged: np.ndarray
    embargoed: np.ndarray
    span_end: int
    embargo_size: int


# -- the splitters ------------------------------------------------------


class _BasePurgedCV:
    """Shared machinery: purge, embargo, account, verify.

    Subclasses decide only which positions are the test set. Everything
    that could leak lives here, once, so that the combinatorial variant
    cannot drift away from the simple one — two implementations of a
    purge is one implementation and one liability.
    """

    def __init__(
        self,
        *,
        label_horizon: int,
        embargo_pct: float = DEFAULT_EMBARGO_PCT,
        horizon_unit: HorizonUnit = "bars",
    ) -> None:
        self.label_horizon = int(label_horizon)
        self.embargo_pct = float(embargo_pct)
        self.horizon_unit = horizon_unit
        if self.label_horizon < 0:
            raise PurgedCVError(
                f"label_horizon must be zero or more, got {label_horizon!r}"
            )
        if not 0.0 <= self.embargo_pct < 1.0:
            raise PurgedCVError(
                f"embargo_pct must be in [0, 1), got {embargo_pct!r}. It is a "
                "fraction of the WHOLE sample, not of a fold — a value near "
                "one embargoes the entire history after every test set."
            )
        if horizon_unit not in ("bars", "calendar_days"):
            raise PurgedCVError(
                f"horizon_unit must be 'bars' or 'calendar_days', got "
                f"{horizon_unit!r}"
            )

    # -- the contract ---------------------------------------------------

    @property
    def n_splits(self) -> int:
        raise NotImplementedError

    def get_n_splits(self, index: object = None) -> int:
        """sklearn's spelling, for callers that expect it."""
        return self.n_splits

    def _test_blocks(self, n: int) -> list[np.ndarray]:
        raise NotImplementedError

    def split(
        self,
        index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
        *,
        label_end: pd.Series | None = None,
    ) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """Yield `(train_idx, test_idx)` as positions into the index.

        Positions rather than dates because that is what a caller slices
        an array with, and because a date-based train set silently drops
        rows when a date is missing. `split_dates` is the other spelling
        for callers holding frames.

        `label_end` overrides the horizon with a per-observation window
        end — a triple-barrier label ends when a barrier is touched,
        which is not a fixed number of bars away. It must be one
        timestamp per observation, on the same index.
        """
        for plan in self._plan(index, label_end=label_end):
            yield plan.train, plan.test

    def split_dates(
        self,
        index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
        *,
        label_end: pd.Series | None = None,
    ) -> Iterator[tuple[pd.DatetimeIndex, pd.DatetimeIndex]]:
        """The same folds as dates, for slicing frames by label."""
        idx = _as_index(index)
        for train, test in self.split(idx, label_end=label_end):
            yield idx[train], idx[test]

    # -- the accounting -------------------------------------------------

    def describe(
        self,
        index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
        *,
        label_end: pd.Series | None = None,
    ) -> pd.DataFrame:
        """One row per fold: what was kept, and what each rule cost.

        `label_span_end` is the point the fold's own labels stop
        reaching, and the gap between it and `test_end` is the part of
        the leak that purging on dates alone would have missed.
        """
        idx = _as_index(index)
        n = len(idx)
        rows = []
        for plan in self._plan(idx, label_end=label_end):
            first = plan.blocks[0][0]
            last = plan.blocks[-1][1]
            rows.append(
                {
                    "fold": plan.fold,
                    "n_blocks": len(plan.blocks),
                    "test_start": idx[first],
                    "test_end": idx[last],
                    "label_span_end": idx[plan.span_end],
                    "n_test": int(plan.test.size),
                    "n_train": int(plan.train.size),
                    "n_purged": int(plan.purged.size),
                    "n_embargoed": int(plan.embargoed.size),
                    "embargo_bars": plan.embargo_size,
                    "train_fraction": float(plan.train.size) / n,
                }
            )
        return pd.DataFrame(rows).astype(
            {
                "fold": "int64",
                "n_blocks": "int64",
                "n_test": "int64",
                "n_train": "int64",
                "n_purged": "int64",
                "n_embargoed": "int64",
                "embargo_bars": "int64",
                "train_fraction": "float64",
            }
        )

    def verify(
        self,
        index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
        *,
        label_end: pd.Series | None = None,
    ) -> None:
        """Run the independent leak check over every fold. Raises or not.

        Cheap enough to call in a test and in a notebook, and worth
        calling in both. It is the difference between a splitter that
        intends not to leak and one that has been asked.
        """
        idx = _as_index(index)
        ends = self._label_end(idx, label_end)
        for plan in self._plan(idx, label_end=ends):
            assert_no_leakage(
                idx,
                plan.train,
                plan.test,
                label_end=ends,
                embargo_pct=self.embargo_pct,
                context=f"fold {plan.fold} of {self.n_splits}",
            )

    # -- the work -------------------------------------------------------

    def _label_end(
        self, idx: pd.DatetimeIndex, label_end: pd.Series | None
    ) -> pd.Series:
        if label_end is not None:
            return _as_end_series(idx, label_end)
        return label_end_times(
            idx,
            label_horizon=self.label_horizon,
            horizon_unit=self.horizon_unit,
        )

    def _plan(
        self,
        index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
        *,
        label_end: pd.Series | None = None,
    ) -> list[_FoldPlan]:
        idx = _as_index(index)
        n = len(idx)
        end_pos = _end_positions(idx, self._label_end(idx, label_end))
        embargo = _embargo_size(n, self.embargo_pct)
        positions = np.arange(n)

        plans: list[_FoldPlan] = []
        for fold, test in enumerate(self._test_blocks(n), start=1):
            is_test = np.zeros(n, dtype=bool)
            is_test[test] = True
            purge = np.zeros(n, dtype=bool)
            embargoed = np.zeros(n, dtype=bool)
            span_end = -1

            for a, b in _contiguous_runs(test):
                # The block's information span runs from its first
                # observation to the furthest point any of its labels
                # reaches — which is past its last date, and is the whole
                # reason the right-hand seam of a fold is dangerous.
                block_end = int(end_pos[a : b + 1].max())
                span_end = max(span_end, block_end)

                # Two intervals overlap when each begins before the other
                # ends. That single condition covers all three of Lopez
                # de Prado's cases: a training window that starts inside
                # the span, one that ends inside it, and one long enough
                # to swallow it whole.
                purge |= (end_pos >= a) & (positions <= block_end)

                if embargo:
                    stop = min(block_end + embargo, n - 1)
                    embargoed[block_end + 1 : stop + 1] = True

            # Attribution, not logic: a bar the purge already took is not
            # also an embargo cost, and counting it twice would make the
            # embargo look like it was doing work that purging did.
            embargoed &= ~purge & ~is_test
            train = np.flatnonzero(~(is_test | purge | embargoed))
            if train.size == 0:
                raise PurgedCVError(
                    f"fold {fold} of {self.n_splits} leaves no training "
                    f"observations at all. {n:,} bars, a "
                    f"{self.label_horizon}-{self.horizon_unit[:-1]} label "
                    f"window and a {embargo}-bar embargo remove everything "
                    "outside the fold. Nothing is broken — the sample is too "
                    "short for this many folds at this horizon, and the fix "
                    "is fewer folds, a shorter label, or more history."
                )

            plans.append(
                _FoldPlan(
                    fold=fold,
                    blocks=_contiguous_runs(test),
                    test=np.asarray(test, dtype=np.int64),
                    train=train,
                    purged=np.flatnonzero(purge & ~is_test),
                    embargoed=np.flatnonzero(embargoed),
                    span_end=span_end,
                    embargo_size=embargo,
                )
            )
        return plans


class PurgedKFold(_BasePurgedCV):
    """k contiguous test folds, each purged and embargoed.

    The simple path, and the one to reach for. Folds run in time order
    and the test fold moves forward through the sample; the training set
    is everything on both sides that the label windows and the embargo
    leave standing, which means a middle fold trains on data from before
    AND after it.

    That is worth being clear-eyed about. Training on the future of the
    test fold is not lookahead in the sense this repository usually
    means — no single observation sees its own answer, which is what
    purging guarantees — but it is not a simulation of trading either,
    because in December you do not have March. `PurgedKFold` answers
    "does this relationship hold in the data?". It does not answer "could
    this have been traded?", and only a walk-forward run answers that.
    Reporting one as the other is a category error no amount of purging
    will catch.

    The embargo is one-sided, forward, following Lopez de Prado. The
    backward direction is already covered: a training observation before
    the fold reaches it only through its label window, and that is
    exactly what the purge removes. Forward is different, because a
    feature computed from a trailing window reaches back into the test
    period without any label being involved at all.
    """

    def __init__(
        self,
        n_splits: int,
        label_horizon: int,
        embargo_pct: float = DEFAULT_EMBARGO_PCT,
        *,
        horizon_unit: HorizonUnit = "bars",
    ) -> None:
        super().__init__(
            label_horizon=label_horizon,
            embargo_pct=embargo_pct,
            horizon_unit=horizon_unit,
        )
        self._n_splits = int(n_splits)
        if self._n_splits < 2:
            raise PurgedCVError(
                f"n_splits must be at least 2, got {n_splits!r}"
            )

    @property
    def n_splits(self) -> int:
        return self._n_splits

    def _test_blocks(self, n: int) -> list[np.ndarray]:
        if n < self._n_splits:
            raise PurgedCVError(
                f"{n:,} observations cannot make {self._n_splits} folds"
            )
        return [
            np.asarray(block, dtype=np.int64)
            for block in np.array_split(np.arange(n), self._n_splits)
        ]

    def __repr__(self) -> str:
        return (
            f"PurgedKFold(n_splits={self._n_splits}, "
            f"label_horizon={self.label_horizon}, "
            f"embargo_pct={self.embargo_pct}, "
            f"horizon_unit={self.horizon_unit!r})"
        )


class CombinatorialPurgedCV(_BasePurgedCV):
    """Test on k of N groups at a time, purged and embargoed the same way.

    Worth having, and cheap to have, because the purge logic above
    already handles a test set made of several disjoint blocks — the
    only thing this class adds is which groups to pick. Lopez de Prado's
    chapter 12.

    What it buys is not a better single number. Splitting the sample
    into N groups and testing k at a time gives C(N, k) splits, and
    those splits can be reassembled into C(N-1, k-1) complete
    out-of-sample PATHS through the history — so instead of one equity
    curve you get several, and the spread between them is a measurement
    of how much the single curve owed to where the fold boundaries
    happened to fall. A strategy whose paths disagree wildly has not
    been tested once well, it has been tested once luckily.

    Two cautions, both of which cost money if ignored.

    **The paths are not independent.** They overlap heavily by
    construction — every path is built from the same groups in different
    combinations. Their dispersion is a lower bound on real uncertainty,
    not a confidence interval, and the path count is emphatically NOT
    the N to hand `metrics.deflated_sharpe_ratio`. Trials are
    configurations you chose between; paths are re-cuts of one
    configuration, and inflating N with them would deflate a Sharpe
    against a hurdle nobody searched.

    **Every split is a model fit.** C(10, 3) is 120 of them, C(20, 10)
    is 184,756, and the constructor refuses the ones that would run
    until Tuesday.
    """

    def __init__(
        self,
        n_groups: int,
        n_test_groups: int,
        label_horizon: int,
        embargo_pct: float = DEFAULT_EMBARGO_PCT,
        *,
        horizon_unit: HorizonUnit = "bars",
    ) -> None:
        super().__init__(
            label_horizon=label_horizon,
            embargo_pct=embargo_pct,
            horizon_unit=horizon_unit,
        )
        self.n_groups = int(n_groups)
        self.n_test_groups = int(n_test_groups)
        if self.n_groups < 2:
            raise PurgedCVError(
                f"n_groups must be at least 2, got {n_groups!r}"
            )
        if not 1 <= self.n_test_groups < self.n_groups:
            raise PurgedCVError(
                f"n_test_groups must be in [1, {self.n_groups - 1}], got "
                f"{n_test_groups!r}. Testing on every group leaves nothing "
                "to train on."
            )
        total = math.comb(self.n_groups, self.n_test_groups)
        if total > MAX_COMBINATORIAL_SPLITS:
            raise PurgedCVError(
                f"C({self.n_groups}, {self.n_test_groups}) is {total:,} "
                "splits, and each one is a model fit. Reduce n_groups, or "
                "move n_test_groups away from the middle."
            )

    @property
    def n_splits(self) -> int:
        return math.comb(self.n_groups, self.n_test_groups)

    @property
    def n_paths(self) -> int:
        """Complete out-of-sample paths the splits reassemble into.

        C(N-1, k-1), which is k/N of the splits: each group is tested in
        exactly that many of them, so that many full traversals of the
        history can be laid end to end.
        """
        return math.comb(self.n_groups - 1, self.n_test_groups - 1)

    def _test_blocks(self, n: int) -> list[np.ndarray]:
        if n < self.n_groups:
            raise PurgedCVError(
                f"{n:,} observations cannot make {self.n_groups} groups"
            )
        groups = np.array_split(np.arange(n), self.n_groups)
        return [
            np.concatenate([groups[g] for g in combo]).astype(np.int64)
            for combo in combinations(range(self.n_groups), self.n_test_groups)
        ]

    def __repr__(self) -> str:
        return (
            f"CombinatorialPurgedCV(n_groups={self.n_groups}, "
            f"n_test_groups={self.n_test_groups}, "
            f"label_horizon={self.label_horizon}, "
            f"embargo_pct={self.embargo_pct}, "
            f"horizon_unit={self.horizon_unit!r}) "
            f"-> {self.n_splits} splits, {self.n_paths} paths"
        )


# -- the leak check -----------------------------------------------------


@dataclass(frozen=True)
class LeakageReport:
    """What the check found, whether or not it found anything.

    `overlapping` and `inside_embargo` are POSITIONS in the index, not
    counts, because a count sends somebody looking and gives them
    nowhere to look. `message` is populated on a clean report too — a
    verification that prints nothing when it passes is one nobody can
    tell from a verification that never ran.
    """

    clean: bool
    n_train: int
    n_test: int
    overlapping: np.ndarray
    inside_embargo: np.ndarray
    embargo_size: int
    message: str


def check_leakage(
    index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
    train_idx: np.ndarray,
    test_idx: np.ndarray,
    *,
    label_horizon: int | None = None,
    label_end: pd.Series | None = None,
    horizon_unit: HorizonUnit = "bars",
    embargo_pct: float = DEFAULT_EMBARGO_PCT,
    context: str = "",
) -> LeakageReport:
    """Test the property directly: no training window touches a test one.

    Deliberately derived from the definition rather than from the
    splitter's masks. For each training observation i, the check asks
    whether ANY test observation j satisfies both `t_j <= end_i` and
    `end_j >= t_i` — the pairwise statement of overlap, evaluated in one
    pass via a running maximum of test label ends rather than by
    reproducing the interval arithmetic the splitter used. If the two
    ever disagree, the splitter is wrong and this says so.

    The embargo half needs the fold structure and takes it from the test
    positions themselves, one band per contiguous block. Only the
    training observation's own date is checked against the band: a
    training window that reached into it from before would first have to
    cross the test span, and would already be an overlap.

    **`embargo_pct` must be the value the split being checked was made
    with**, and it defaults to `DEFAULT_EMBARGO_PCT` because the two ways
    of getting it wrong are not each other's mirror image. Check with
    more embargo than was applied and the report names rows the splitter
    kept on purpose: a false alarm, annoying, and it sends somebody to
    look at a specific dated row where they will see within a minute that
    the band was drawn wider than the split's. Check with LESS and the
    report comes back clean having tested half the property — a false
    clearance, from the one function in the file whose entire job is
    catching leakage, and nothing about it looks any different from a
    real one. So the default is the one the splitters default to, which
    makes the silent-and-wrong case require the caller to type a number
    rather than omit one. A caller who really did split with no embargo
    passes `embargo_pct=0.0` and says so.

    Supply exactly one of `label_horizon` or `label_end`. `context` is
    prefixed to the message — a leak reported without saying which fold
    it came from sends somebody through all of them.
    """
    idx = _as_index(index)
    n = len(idx)
    if (label_horizon is None) == (label_end is None):
        raise PurgedCVError(
            "supply exactly one of label_horizon or label_end. With neither "
            "there is no window to check; with both, the check would be "
            "testing a different label from the one the split used."
        )
    ends = (
        _as_end_series(idx, label_end)
        if label_end is not None
        else label_end_times(
            idx, label_horizon=int(label_horizon), horizon_unit=horizon_unit
        )
    )
    end_pos = _end_positions(idx, ends)

    train = _positions(train_idx, n, "train_idx")
    test = _positions(test_idx, n, "test_idx")
    where = f"{context}: " if context else ""
    if test.size == 0:
        raise PurgedCVError(f"{where}the test set is empty")

    # The running maximum of test label ends. `reach[p]` is the furthest
    # position any test observation dated at or before p touches, so a
    # training observation leaks precisely when the reach at the far end
    # of its own window comes back as far as itself. A shared position
    # between the two sets falls out of this as an overlap, which is the
    # right answer to the bluntest version of the question.
    ladder = np.full(n, -1, dtype=np.int64)
    ladder[test] = end_pos[test]
    reach = np.maximum.accumulate(ladder)
    overlaps = train[reach[end_pos[train]] >= train]

    size = _embargo_size(n, embargo_pct)
    banded = np.zeros(n, dtype=bool)
    bands: list[tuple[int, int]] = []
    if size:
        for a, b in _contiguous_runs(test):
            block_end = int(end_pos[a : b + 1].max())
            stop = min(block_end + size, n - 1)
            if stop > block_end:
                banded[block_end + 1 : stop + 1] = True
                bands.append((block_end, stop))
    in_band = train[banded[train] & ~np.isin(train, overlaps)]

    clean = overlaps.size == 0 and in_band.size == 0
    return LeakageReport(
        clean=clean,
        n_train=int(train.size),
        n_test=int(test.size),
        overlapping=overlaps,
        inside_embargo=in_band,
        embargo_size=size,
        message=_leak_message(
            idx, ends, end_pos, test, overlaps, in_band, bands, size, where
        ),
    )


def assert_no_leakage(
    index: pd.DatetimeIndex | pd.Series | pd.DataFrame,
    train_idx: np.ndarray,
    test_idx: np.ndarray,
    *,
    label_horizon: int | None = None,
    label_end: pd.Series | None = None,
    horizon_unit: HorizonUnit = "bars",
    embargo_pct: float = DEFAULT_EMBARGO_PCT,
    context: str = "",
) -> None:
    """`check_leakage`, raising `LeakageError` on anything it finds.

    Same default and the same reason: this is the spelling that gets
    called from a test, where a clean pass is read as a guarantee and
    nobody re-derives what it was checked against.
    """
    report = check_leakage(
        index,
        train_idx,
        test_idx,
        label_horizon=label_horizon,
        label_end=label_end,
        horizon_unit=horizon_unit,
        embargo_pct=embargo_pct,
        context=context,
    )
    if not report.clean:
        raise LeakageError(report.message)


def _positions(raw: np.ndarray, n: int, name: str) -> np.ndarray:
    pos = np.asarray(raw, dtype=np.int64).ravel()
    if pos.size and (pos.min() < 0 or pos.max() >= n):
        raise PurgedCVError(
            f"{name} contains positions outside [0, {n - 1}]; these are "
            "positions into the index, not labels"
        )
    return np.unique(pos)


def _leak_message(
    idx: pd.DatetimeIndex,
    ends: pd.Series,
    end_pos: np.ndarray,
    test: np.ndarray,
    overlaps: np.ndarray,
    in_band: np.ndarray,
    bands: list[tuple[int, int]],
    size: int,
    where: str,
) -> str:
    """One sentence naming a specific offender, or saying there is none.

    An offender named by date is a row somebody can go and look at. A
    count is a number somebody argues with.
    """
    if overlaps.size:
        i = int(overlaps[0])
        near = test[(test <= end_pos[i]) & (end_pos[test] >= i)]
        j = int(near[0]) if near.size else int(test[0])
        return (
            f"{where}{overlaps.size:,} training observation(s) carry labels "
            f"that reach into the test fold. The first: {idx[i].date()} has a "
            f"label through {pd.Timestamp(ends.iloc[i]).date()}, which "
            f"overlaps the test observation {idx[j].date()} (label through "
            f"{pd.Timestamp(ends.iloc[j]).date()}). The purge did not run, "
            "or ran against the test DATES rather than the span its labels "
            "reach."
        )
    if in_band.size:
        i = int(in_band[0])
        after = next(
            (i - end for end, stop in bands if end < i <= stop),
            0,
        )
        return (
            f"{where}{in_band.size:,} training observation(s) sit inside the "
            f"{size}-bar embargo. The first: {idx[i].date()}, {after} bar(s) "
            "after the test fold's labels stop. Their features are built from "
            "trailing windows that reach into the test period."
        )
    return (
        f"{where}clean: no training label window touches the test fold, and "
        f"nothing sits in the {size}-bar embargo behind it."
    )
