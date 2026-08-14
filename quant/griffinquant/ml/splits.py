"""Folds for a panel whose answers arrive a month late, and the proof
that they hold.

`validation/purged_cv.py` and `validation/walkforward.py` already do the
hard part. Nothing here re-implements a splitter; this file is the
adapter between them and a labelled panel, and it exists because the
adapter is where the leak actually happens.

**The trap is splitting ROWS.** A labelled panel is long — one row per
`(date, asset)` — so a naive `train_test_split` over rows puts SPY's
2019-03-14 in training and TLT's 2019-03-14 in test. Under the
cross-sectional label that is not a near miss, it is handing over the
answer: the two rows were compared against the same median, computed
from each other, so knowing one constrains the other arithmetically.
Under any label it is still a same-day feature overlap. So every split
below is made on the DATE index and then expanded to rows, and a date
is in training or in test or in neither, never in both. `verify()`
asserts that at the row level as well as the date level, because it is
the one failure `assert_no_leakage` cannot see — it is handed positions
and has no idea a panel was involved.

**The purge distance is the label horizon.** An observation dated T
carries information through T+H, so training rows whose window reaches
a test fold have to go, plus an embargo band behind the fold for
features built from trailing windows. That is `PurgedKFold`'s job and
it is given `label_end` — the real session each window closes on, off
the price calendar — rather than a bar count, because a date dropped
for a thin cross-section leaves a gap and a bar count would then purge
a window shorter than the label's while reporting the right number.

**Two schemes, answering two different questions.** `purged_folds` asks
whether the relationship exists in the data; its middle folds train on
the future of the fold they are testing, which is legitimate for that
question and is not a simulation of trading. `walk_forward_folds` asks
whether it could have been traded: training expands, testing is always
forward, and the trailing H sessions of every training window are
purged because their labels reach across the seam. The forward embargo
`PurgedKFold` needs is structurally vacuous there — there is no
training data after a test window to embargo — so it is fixed at zero
and `verify()` checks with the zero it applied. Checking with more
embargo than was applied cries wolf; checking with less hands back a
clearance for a property nobody tested.

One honest limitation, stated because a fold count reads as
independence: under walk-forward the test windows tile the sample, so
a test observation in the last month of fold k has a label window
reaching into fold k+1's test period. That is not leakage — no model
sees its own answer — but it does mean consecutive folds' scores are
not independent draws, and a run of good ones is worth less than it
looks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator, Mapping

import numpy as np
import pandas as pd

from ..validation.purged_cv import (
    DEFAULT_EMBARGO_PCT,
    PurgedCVError,
    PurgedKFold,
    _end_positions,
    assert_no_leakage,
    check_leakage,
)
from ..validation.walkforward import WalkForward, WalkForwardError
from .labels import LabelSet

__all__ = [
    "DEFAULT_MIN_TRAIN_YEARS",
    "DEFAULT_N_SPLITS",
    "DEFAULT_REFIT_FREQUENCY_YEARS",
    "PanelFold",
    "SplitError",
    "SplitPlan",
    "purged_folds",
    "walk_forward_folds",
]


#: Five folds on twenty-one years is about four years a fold, which is
#: long enough that a fold contains a crisis and short enough that the
#: purge does not eat the training set. Not tuned — no number in this
#: file was chosen by seeing which one scored better, and the moment
#: one is it becomes a fitted parameter owing the trial ledger a row.
DEFAULT_N_SPLITS = 5

#: `walkforward.MIN_REFIT_FREQUENCY_YEARS` is the floor and this is the
#: same number: annual. More often than that and the model re-estimates
#: from mostly the same history plus a sliver of new tape, and tracks
#: the sliver.
DEFAULT_REFIT_FREQUENCY_YEARS = 1

#: Five years before the first blind trade. Fewer and the first model
#: has never seen a bad year; more and the out-of-sample period this
#: whole exercise is measured on gets shorter.
DEFAULT_MIN_TRAIN_YEARS = 5


class SplitError(ValueError):
    """The panel and the requested scheme cannot make an honest fold."""


# -- one fold ------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class PanelFold:
    """One split, in dates and in rows, with the base rate on each side.

    The base rates are on the fold rather than left to the caller
    because they are what a fold's accuracy has to be read against, and
    they move: a walk-forward fold covering 2008 under the `zero` label
    has a test base rate near 0.25, so a model scoring 0.70 there has
    done worse than answering "no" to everything. Under the
    cross-sectional label they sit at 0.5 in every fold, which is the
    property that makes the label worth having, and printing them is
    how that stops being an assertion.
    """

    fold: int
    kind: str
    train_dates: pd.DatetimeIndex
    test_dates: pd.DatetimeIndex
    dropped_dates: pd.DatetimeIndex
    train_positions: np.ndarray = field(repr=False)
    test_positions: np.ndarray = field(repr=False)
    train_rows: np.ndarray = field(repr=False)
    test_rows: np.ndarray = field(repr=False)
    train_base_rate: float
    test_base_rate: float
    embargo_bars: int
    #: Set by the plan that built the fold, so `take` can refuse a
    #: frame of the wrong height without the caller passing it in.
    _n_rows: int = 0

    @property
    def n_train(self) -> int:
        return int(self.train_rows.size)

    @property
    def n_test(self) -> int:
        return int(self.test_rows.size)

    def take(self, frame: pd.DataFrame | pd.Series) -> tuple[Any, Any]:
        """`(train, test)` slices of anything on the label's row order.

        Positional, and it insists the object is the right length
        rather than aligning by index. Alignment would silently reorder
        a feature matrix built in a different order from the labels,
        which produces a model fitted on scrambled targets and an AUC
        of exactly 0.5 — indistinguishable, on this project, from the
        result we expect to find honestly.
        """
        n = len(frame)
        if n != self._n_rows:
            raise SplitError(
                f"this fold indexes {self._n_rows:,} labelled rows and was "
                f"handed {n:,}. Features and labels must be on the same rows "
                "in the same order; slicing positionally across a mismatch "
                "would fit the model on scrambled targets"
            )
        return frame.iloc[self.train_rows], frame.iloc[self.test_rows]


# -- the plan ------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class SplitPlan:
    """Every fold of one scheme, plus the means to disprove it.

    Iterating yields `PanelFold`s rather than the `(train, test)` pairs
    sklearn's splitters hand back, and the difference is deliberate: a
    bare pair of arrays is what somebody unpacks in the wrong order at
    2am, and it carries neither the base rate the fold must be scored
    against nor the height check in `take`. Read `describe()` before
    trusting any of them, and call `verify()` — which is cheap — from
    the runner as well as from the tests, because a purge that is
    intended is not a purge that has been asked about.
    """

    kind: str
    folds: tuple[PanelFold, ...]
    dates: pd.DatetimeIndex
    label_end: pd.Series = field(repr=False)
    horizon: int
    embargo_pct: float
    labels: LabelSet = field(repr=False)
    settings: Mapping[str, Any] = field(default_factory=dict, repr=False)

    def __len__(self) -> int:
        return len(self.folds)

    def __getitem__(self, i: int) -> PanelFold:
        return self.folds[i]

    def __iter__(self) -> Iterator[PanelFold]:
        return iter(self.folds)

    # -- the audit ------------------------------------------------------

    def verify(self) -> None:
        """Re-derive the no-leak property over the folds as generated.

        Three checks, and the third is the one this file owes.

        `assert_no_leakage` tests the defining property pairwise from
        the label windows, not from anything the splitter recorded, and
        it is passed the embargo that was actually applied — its
        default is a real default and passing less than was applied
        returns a clean report having tested half the property.

        The date check catches an off-by-one in the fold boundaries.

        The ROW check catches this module: a date correctly held out of
        the test fold and then mapped into it through the panel expansion
        is invisible to everything above, because by then it is just a
        position.
        """
        row_dates = pd.DatetimeIndex(self.labels.y.index.get_level_values("date"))
        for fold in self.folds:
            assert_no_leakage(
                self.dates,
                fold.train_positions,
                fold.test_positions,
                label_end=self.label_end,
                embargo_pct=self.embargo_pct,
                context=f"{self.kind} fold {fold.fold} of {len(self.folds)}",
            )
            overlap = fold.train_dates.intersection(fold.test_dates)
            if len(overlap):
                raise SplitError(
                    f"{self.kind} fold {fold.fold}: {len(overlap)} date(s) are "
                    f"in both sets, the first {overlap[0].date()}"
                )
            shared = row_dates[fold.train_rows].intersection(
                row_dates[fold.test_rows]
            )
            if len(shared):
                raise SplitError(
                    f"{self.kind} fold {fold.fold}: the row expansion put "
                    f"{shared[0].date()} on both sides. A panel is split by "
                    "date because two assets on one date were measured "
                    "against each other"
                )

    def leakage_reports(self) -> pd.DataFrame:
        """The same check, as a frame rather than a raise.

        For a notebook, and for the case where somebody wants to see
        the clean message rather than infer it from nothing happening.
        """
        rows = []
        for fold in self.folds:
            report = check_leakage(
                self.dates,
                fold.train_positions,
                fold.test_positions,
                label_end=self.label_end,
                embargo_pct=self.embargo_pct,
                context=f"{self.kind} fold {fold.fold}",
            )
            rows.append(
                {
                    "fold": fold.fold,
                    "clean": report.clean,
                    "n_train_dates": report.n_train,
                    "n_test_dates": report.n_test,
                    "overlapping": int(report.overlapping.size),
                    "inside_embargo": int(report.inside_embargo.size),
                    "embargo_bars": report.embargo_size,
                    "message": report.message,
                }
            )
        return pd.DataFrame(rows)

    # -- reporting ------------------------------------------------------

    def describe(self) -> pd.DataFrame:
        """One row per fold: what it cost, and what it is measured against.

        `test_base_rate` is the column to read beside any accuracy the
        fold produces, and `n_dropped_dates` is the bill for purging —
        a fold retaining a fifth of the sample is a different experiment
        from one retaining four fifths, whatever the score says.
        """
        n_dates = len(self.dates)
        rows = [
            {
                "fold": f.fold,
                "kind": f.kind,
                "train_start": f.train_dates[0] if len(f.train_dates) else pd.NaT,
                "train_end": f.train_dates[-1] if len(f.train_dates) else pd.NaT,
                "test_start": f.test_dates[0] if len(f.test_dates) else pd.NaT,
                "test_end": f.test_dates[-1] if len(f.test_dates) else pd.NaT,
                "n_train_dates": len(f.train_dates),
                "n_test_dates": len(f.test_dates),
                "n_dropped_dates": len(f.dropped_dates),
                "n_train": f.n_train,
                "n_test": f.n_test,
                "train_base_rate": f.train_base_rate,
                "test_base_rate": f.test_base_rate,
                "embargo_bars": f.embargo_bars,
                "train_date_fraction": len(f.train_dates) / n_dates,
            }
            for f in self.folds
        ]
        return pd.DataFrame(rows)

    def config(self) -> dict[str, Any]:
        """The scheme's identity, for `metrics.TrialCounter`.

        The label's config is folded in, because the same model scored
        over a different horizon or against a different threshold is a
        different configuration and the ledger has to see that from the
        hash rather than from a description somebody wrote.
        """
        return {
            "split": {
                "kind": self.kind,
                "horizon_sessions": self.horizon,
                "embargo_pct": self.embargo_pct,
                "n_folds": len(self.folds),
                **dict(self.settings),
            },
            "label": self.labels.config(),
        }

    def __repr__(self) -> str:
        return (
            f"SplitPlan({self.kind}, {len(self.folds)} folds, "
            f"horizon={self.horizon}, embargo_pct={self.embargo_pct}, "
            f"{len(self.dates):,} dates)"
        )


# -- the two schemes -----------------------------------------------------


def purged_folds(
    labels: LabelSet,
    *,
    n_splits: int = DEFAULT_N_SPLITS,
    embargo_pct: float = DEFAULT_EMBARGO_PCT,
) -> SplitPlan:
    """k contiguous test folds over the dates, purged and embargoed.

    The question this answers is "does the relationship hold in this
    data?". It is NOT a simulation of trading: a middle fold trains on
    data from after the period it tests, which no purge makes into
    something you could have done in December with March's tape. For
    "could this have been traded", use `walk_forward_folds` and report
    that one as the tradable number.
    """
    dates, label_end = _date_index(labels)
    try:
        cv = PurgedKFold(
            n_splits=n_splits, label_horizon=labels.horizon, embargo_pct=embargo_pct
        )
        plan = cv.describe(dates, label_end=label_end)
        splits = list(cv.split(dates, label_end=label_end))
    except PurgedCVError as exc:
        raise SplitError(
            f"{len(dates):,} labelled dates at a {labels.horizon}-session "
            f"horizon cannot make {n_splits} purged folds: {exc}"
        ) from exc

    row_date = _row_date_positions(labels, dates)
    folds = [
        _panel_fold(
            fold=i,
            kind="purged_kfold",
            labels=labels,
            dates=dates,
            train_positions=train,
            test_positions=test,
            row_date=row_date,
            embargo_bars=int(plan.loc[i - 1, "embargo_bars"]),
        )
        for i, (train, test) in enumerate(splits, start=1)
    ]
    return SplitPlan(
        kind="purged_kfold",
        folds=tuple(folds),
        dates=dates,
        label_end=label_end,
        horizon=labels.horizon,
        embargo_pct=float(embargo_pct),
        labels=labels,
        settings={"n_splits": int(n_splits)},
    )


def walk_forward_folds(
    labels: LabelSet,
    *,
    refit_frequency: int = DEFAULT_REFIT_FREQUENCY_YEARS,
    min_train_years: int = DEFAULT_MIN_TRAIN_YEARS,
) -> SplitPlan:
    """Expanding training, forward testing, trailing windows purged.

    `WalkForward` supplies the schedule and nothing else — it is pure
    date arithmetic and touches no data, which is what lets the plan be
    printed and argued with before a model exists. The purge is applied
    here because that module is written for a daily-decision engine
    where one day of separation is the whole of the leakage; a label
    reaching H sessions forward is a different problem, and the last H
    training dates before every seam carry answers from inside the test
    window.

    There is no `embargo_pct`. The embargo is a band AFTER a test fold,
    and under expanding training there is never any training data after
    a test fold to fall in it — so the argument would be a knob that
    changed the number in the report and nothing in the split. It is
    fixed at zero and `verify()` checks against zero, which is the same
    zero that was applied.
    """
    dates, label_end = _date_index(labels)
    try:
        schedule = WalkForward(
            start=dates[0],
            end=dates[-1],
            refit_frequency=refit_frequency,
            min_train_years=min_train_years,
        )
        scheduled = schedule.folds()
    except WalkForwardError as exc:
        raise SplitError(
            f"labelled dates run {dates[0].date()}..{dates[-1].date()}; that "
            f"schedule is impossible: {exc}"
        ) from exc

    end_pos = _end_positions(dates, label_end)
    row_date = _row_date_positions(labels, dates)
    stamps = dates.to_numpy()

    folds: list[PanelFold] = []
    for k, fold in enumerate(scheduled, start=1):
        in_test = (stamps >= fold.test.start.to_datetime64()) & (
            stamps <= fold.test.end.to_datetime64()
        )
        in_train = (stamps >= fold.train.start.to_datetime64()) & (
            stamps <= fold.train.end.to_datetime64()
        )
        test_positions = np.flatnonzero(in_test)
        if test_positions.size == 0:
            raise SplitError(
                f"walk-forward fold {k} covers {fold.test} and no labelled "
                "date falls inside it"
            )

        # Contaminated is defined against the fold's first TEST POSITION
        # rather than its window start, which is the same statement
        # `check_leakage` makes when it re-derives the property from
        # scratch. Sharing the arithmetic with the splitter is
        # deliberate; sharing it with the CHECK would not be.
        reaches_in = end_pos >= int(test_positions[0])
        train_positions = np.flatnonzero(in_train & ~reaches_in)
        if train_positions.size == 0:
            raise SplitError(
                f"walk-forward fold {k} has no training dates left once the "
                f"{labels.horizon}-session label window is purged from "
                f"{fold.train}. The sample is too short for this horizon at "
                f"min_train_years={min_train_years}"
            )

        folds.append(
            _panel_fold(
                fold=k,
                kind="walk_forward",
                labels=labels,
                dates=dates,
                train_positions=train_positions,
                test_positions=test_positions,
                row_date=row_date,
                embargo_bars=0,
                # Only the training window's own dates count as a cost;
                # everything after the test fold is simply not yet in
                # scope for this refit rather than something purging took.
                dropped=np.flatnonzero(in_train & reaches_in),
            )
        )

    return SplitPlan(
        kind="walk_forward",
        folds=tuple(folds),
        dates=dates,
        label_end=label_end,
        horizon=labels.horizon,
        # Zero, and it is the value `verify` checks with. See the
        # docstring: a forward embargo has nothing to bite on here.
        embargo_pct=0.0,
        labels=labels,
        settings={
            "refit_frequency_years": int(refit_frequency),
            "min_train_years": int(min_train_years),
            "training": "expanding",
        },
    )


# -- plumbing ------------------------------------------------------------


def _date_index(labels: LabelSet) -> tuple[pd.DatetimeIndex, pd.Series]:
    """The unique decision dates and the session each window closes on."""
    if not isinstance(labels, LabelSet):
        raise SplitError(
            f"expected a LabelSet, got {type(labels).__name__}. The split "
            "needs the label horizon and the price calendar, and reading "
            "either off a bare frame would be a guess"
        )
    dates = labels.dates
    if len(dates) < 2:
        raise SplitError(f"{len(dates)} labelled date(s) cannot be split")
    return dates, labels.label_end


def _row_date_positions(labels: LabelSet, dates: pd.DatetimeIndex) -> np.ndarray:
    """Each labelled row's position in the date index.

    The whole panel expansion is this array plus a boolean lookup. A
    merge or an `isin` would do the same job and would also quietly
    survive a date that is in the rows and not in `dates` — which is
    the state in which a row belongs to no fold and simply vanishes
    from every count.
    """
    row_dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))
    pos = dates.get_indexer(row_dates)
    if (pos < 0).any():
        raise SplitError(
            "a labelled row is dated outside the date index built from those "
            "same labels; the panel expansion would drop it silently"
        )
    return pos.astype(np.int64)


def _rows_for(positions: np.ndarray, row_date: np.ndarray, n_dates: int) -> np.ndarray:
    selected = np.zeros(n_dates, dtype=bool)
    selected[positions] = True
    return np.flatnonzero(selected[row_date]).astype(np.int64)


def _panel_fold(
    *,
    fold: int,
    kind: str,
    labels: LabelSet,
    dates: pd.DatetimeIndex,
    train_positions: np.ndarray,
    test_positions: np.ndarray,
    row_date: np.ndarray,
    embargo_bars: int,
    dropped: np.ndarray | None = None,
) -> PanelFold:
    n_dates = len(dates)
    train_rows = _rows_for(train_positions, row_date, n_dates)
    test_rows = _rows_for(test_positions, row_date, n_dates)
    if dropped is None:
        taken = np.zeros(n_dates, dtype=bool)
        taken[train_positions] = True
        taken[test_positions] = True
        dropped = np.flatnonzero(~taken)

    y = labels.y.to_numpy()
    train_rate = float(y[train_rows].mean()) if train_rows.size else float("nan")
    test_rate = float(y[test_rows].mean()) if test_rows.size else float("nan")
    return PanelFold(
        fold=fold,
        kind=kind,
        train_dates=dates[train_positions],
        test_dates=dates[test_positions],
        dropped_dates=dates[dropped],
        train_positions=np.asarray(train_positions, dtype=np.int64),
        test_positions=np.asarray(test_positions, dtype=np.int64),
        train_rows=train_rows,
        test_rows=test_rows,
        train_base_rate=train_rate,
        test_base_rate=test_rate,
        embargo_bars=int(embargo_bars),
        _n_rows=int(labels.n),
    )
