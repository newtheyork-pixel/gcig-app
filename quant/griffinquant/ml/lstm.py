"""The video's architecture, built so that its failure mode is visible
instead of surprising.

A single LSTM layer over a trailing window of the same seventeen
features `features.py` hands the trees, a dropout, a linear head, one
logit. That is the shape the source project used and it is kept, because
the question this file exists to answer is whether a recurrent net finds
something a boosted tree does not on the same inputs and the same folds.
Changing the inputs at the same time as the model would make the
comparison unreadable in whichever direction it came out.

**THE LOOKBACK: 60 sessions.** Round, roughly a quarter, and fixed
before anything was run. The prior is that the features are already
summaries — `mom_12_1` reaches back a year on its own, `drawdown_252`
reaches back a year — so the sequence does not need to span a year to
have seen one. What it adds over a single row is the recent PATH of
those summaries: whether volatility is arriving or leaving, whether the
drawdown is deepening or healing. Sixty daily observations of a
252-session statistic is already ninety-five per cent redundant with
itself; six hundred would be redundant, four times more expensive, and
would delete the first two and a half years of every fund's history to
buy it. If this number is ever changed by looking at a score it stops
being a prior and owes `metrics.TrialCounter` a row.

**THE CAPACITY ARITHMETIC, which is the whole finding in advance.** At
the default width the model holds 2,257 parameters: the LSTM's four
gates over seventeen inputs and sixteen hidden units is 4 x (16 x 33) +
4 x 32 = 2,240, and the head adds 17. Against that, the cached 22-name
panel labelled at a 21-session horizon carries 117,814 rows — and 117,814
rows are not 117,814 observations. Consecutive windows overlap by twenty
of their twenty-one sessions, so the row count divided by the horizon is
about **5,610 effective observations**, which is roughly two and a half
per parameter. The conventional comfort zone is ten. And `LabelSet.
effective_sample()` applies a second reduction this file does not — the
twenty-two funds move together, and the participation ratio of their
correlation matrix says they amount to about 5.6 distinct series, which
takes the same sample down to about 1,434. **On that measure the
parameters outnumber the observations by more than half again.**

Say it plainly, because it is the point: at this width, on this panel,
the model has enough capacity to memorise its training set, and a
training curve that climbs while a validation curve sags is the
*expected* consequence rather than a bug to be tuned away. That is what
the source project's 0.60 -> 0.50 drift over twenty-five epochs was
showing, and it reported the drift without doing this arithmetic.
`capacity()` recomputes both ratios for whatever panel is handed in and
`LSTMReport.summary()` prints them above every score, so the number is
never left for the reader to reconstruct.

**EARLY STOPPING NEVER TOUCHES THE TEST FOLD.** This is the quiet one.
"Train with early stopping on validation" and "report the validation
AUC" are the two sentences everybody writes, and together they mean the
reported number was chosen by looking at the data it is reported on —
the epoch that scored best out of forty is a maximum over forty draws,
not a sample from them. So the inner validation slice is carved off the
END of the training window, the fit portion is purged of every row whose
label window reaches into that slice, and the fold's test set is scored
exactly once, at the epoch the inner slice chose. The trajectory this
file records is therefore the honest picture: train and inner-validation
AUC per epoch, per seed, and a test number that no epoch was selected
against.

**Shuffled in training, never in evaluation.** Training windows are
permuted within each epoch, because the alternative is batches that are
each one month of one market and gradients that track the calendar.
Validation and test are evaluated in date order and never permuted —
not because order changes an AUC (it does not) but because every
evaluation path in this file must be the one live trading would take,
and a path that only works when the rows are shuffled is a path nobody
noticed was wrong.

**Sequences look backward and gaps are dropped, never spliced.** A
window is valid only when its sixty rows are sixty CONSECUTIVE sessions
on the panel calendar and every feature in every one of them is finite.
A missing session bridged by adjacency would hand the model a sixty-day
window covering ninety days; a NaN filled with a zero would hand it a
fabricated observation it cannot distinguish from a real one. Both are
counted and reported rather than papered over.

**AN AUC IS READ AGAINST FUND IDENTITY, NOT AGAINST 0.5.** The labels
module insists an accuracy be printed beside its base rate; the same
discipline applied to AUC on a panel means printing it beside what a
lookup table of per-fund training base rates scores on the same rows.
That is not a formality here. Over 2005-2026 QQQ beat the
cross-sectional median 61% of the time and TIP 37%, because the sample
holds one of the great equity bull markets and the universe is funds
that all survived to be chosen in 2026 — so a model that learns "this
one is an equity fund" from its volatility and drawdown clears 0.55
without any view about when to own it. `identity_baseline_auc` is that
number and every fold carries it. An LSTM at 0.53 beside an identity
baseline of 0.55 has found nothing, and the two figures reported apart
would have looked like a finding.

**Uncertainty is disagreement, not confidence.** Predictions are the
mean over an ensemble of seeds, and the spread across those seeds — plus
optional MC dropout within each of them — is reported beside it. Read it
for what it is: the ensemble members differ only in initialisation and
batch order, so their agreement measures the stability of the fit, and
says nothing whatever about the risk that the model class is wrong or
that twenty-one years of one historical path was not enough. A tight
ensemble around a coin flip is a well-fitted coin flip.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import roc_auc_score
from torch import nn

from .features import FEATURE_COLUMNS
from .labels import LabelSet, accuracy_report
from .splits import PanelFold, SplitPlan

__all__ = [
    "BASE_SEED",
    "BATCH_SIZE",
    "CLIP_SIGMA",
    "Capacity",
    "DROPOUT",
    "ENSEMBLE_SEEDS",
    "FoldResult",
    "HIDDEN_SIZE",
    "LEARNING_RATE",
    "LOOKBACK_SESSIONS",
    "LSTMConfig",
    "LSTMError",
    "LSTMReport",
    "MAX_EPOCHS",
    "MC_DROPOUT_SAMPLES",
    "NUM_LAYERS",
    "PATIENCE",
    "RankIC",
    "SequenceIndex",
    "VALIDATION_FRACTION",
    "assert_backward_only",
    "build_sequences",
    "capacity",
    "fit_fold",
    "identity_baseline_auc",
    "parameter_count",
    "rank_information_coefficient",
    "resolve_device",
    "run_lstm",
    "sequence_causality_report",
]


# -- the priors, each one round and each one written down first ---------
#
# Nothing below was chosen by comparing results. Every one of them is a
# knob that could be turned until an AUC improved, which is why they are
# constants with arguments attached rather than defaults with none: a
# number that moves in response to a score is a fitted parameter and
# owes `metrics.TrialCounter` a row of its own.

#: Sessions of feature history in one sequence. See the module
#: docstring; the short version is that the features already summarise
#: a year each, so the window's job is to show their recent path.
LOOKBACK_SESSIONS: int = 60

#: Hidden units. Small on purpose and still too big — see the capacity
#: arithmetic. Sixteen is the smallest width at which this is
#: recognisably the video's model rather than a logistic regression
#: wearing a recurrent costume.
HIDDEN_SIZE: int = 16

#: One layer. Stacking is where the video's parameter count came from
#: and a second layer here would roughly double ours against a sample
#: that cannot support the first.
NUM_LAYERS: int = 1

#: Dropout on the final hidden state before the head. With one layer
#: `nn.LSTM`'s own dropout argument is a no-op, so it is applied
#: explicitly — which also gives MC dropout something to sample.
DROPOUT: float = 0.2

LEARNING_RATE: float = 1e-3
BATCH_SIZE: int = 256

#: Forty epochs and a patience of five. The source project ran
#: twenty-five and watched validation drift the whole way; forty is
#: enough to see the same shape settle and cheap enough to run five
#: folds by three seeds without an afternoon disappearing.
MAX_EPOCHS: int = 40
PATIENCE: int = 5

#: Three fits per fold, differing only in seed. Enough for a spread to
#: mean something, few enough that the run is affordable.
ENSEMBLE_SEEDS: int = 3

#: MC dropout is opt-in. It is a second, weaker uncertainty measure —
#: dropout sits on one layer here, so the posterior it approximates is
#: correspondingly thin — and it multiplies inference cost.
MC_DROPOUT_SAMPLES: int = 0

#: The tail of the training window kept back to choose an epoch on. A
#: fifth, which on a five-year expanding fold is about a year.
VALIDATION_FRACTION: float = 0.2

#: Standardised features are clipped here. `turnover_surge` is a log
#: ratio of medians and does produce genuine ten-sigma days; a recurrent
#: net handed one propagates it through sixty steps. Clipping keeps the
#: outlier's SIGN and its position at the extreme, which is all a rank
#: -flavoured feature was ever carrying, and drops only the claim that
#: this particular Tuesday was twelve times worse than that one.
CLIP_SIGMA: float = 5.0

#: Seeds are `BASE_SEED + member`. Fixed so a rerun of a configuration
#: is the same run and not a fresh draw that quietly counts as
#: confirmation.
BASE_SEED: int = 0

#: Below this many labelled rows on either side of the inner split the
#: epoch choice is noise and the fold is refused rather than reported.
MIN_INNER_ROWS: int = 200


class LSTMError(ValueError):
    """The panel, the fold or the configuration cannot fit an honest net."""


# -- sequences ----------------------------------------------------------


@dataclass(frozen=True, eq=False)
class SequenceIndex:
    """Every labelled row's lookback window, as indices rather than data.

    `gather` is `(n_targets, lookback)` positions into `values`, so the
    windows are materialised a batch at a time. Storing the windows
    themselves would be `lookback` copies of the panel — 117,814 rows by
    sixty by seventeen in float32 is 480MB, for a panel whose features
    fit in 8MB — and the copy would then be a second thing that can
    drift from the frame it came from.

    `valid` is the row-level answer to "does this target have a complete
    window". False rows keep their place in the array so that positions
    stay aligned with `LabelSet.y` and a `PanelFold`'s row indices; they
    are filtered at use, never compacted away, because compaction is how
    a feature matrix ends up on different rows from its labels.
    """

    feature_names: tuple[str, ...]
    lookback: int
    values: np.ndarray = field(repr=False)
    source_dates: np.ndarray = field(repr=False)
    source_assets: np.ndarray = field(repr=False)
    gather: np.ndarray = field(repr=False)
    valid: np.ndarray = field(repr=False)
    target_dates: np.ndarray = field(repr=False)
    target_assets: np.ndarray = field(repr=False)
    dropped: Mapping[str, int] = field(default_factory=dict)

    @property
    def n_targets(self) -> int:
        return int(self.gather.shape[0])

    @property
    def n_valid(self) -> int:
        return int(self.valid.sum())

    @property
    def n_features(self) -> int:
        return int(self.values.shape[1])

    def window(self, i: int) -> np.ndarray:
        """One `(lookback, n_features)` window, for reading and testing."""
        if not self.valid[i]:
            raise LSTMError(
                f"target {i} has no complete window; its history is short, "
                "gapped or holed. Invalid rows are excluded rather than "
                "materialised — a window that had to be repaired is not the "
                "window the model would have had."
            )
        return self.values[self.gather[i]]

    def window_dates(self, i: int) -> np.ndarray:
        return self.source_dates[self.gather[i]]

    def describe(self) -> pd.DataFrame:
        row = {
            "lookback": self.lookback,
            "n_features": self.n_features,
            "n_targets": self.n_targets,
            "n_valid": self.n_valid,
            "valid_fraction": self.n_valid / max(self.n_targets, 1),
            **{f"dropped_{k}": int(v) for k, v in sorted(self.dropped.items())},
        }
        return pd.DataFrame([row])

    def __repr__(self) -> str:
        return (
            f"SequenceIndex(lookback={self.lookback}, "
            f"{self.n_valid:,}/{self.n_targets:,} valid, "
            f"{self.n_features} features)"
        )


def build_sequences(
    features: pd.DataFrame,
    targets: pd.MultiIndex,
    *,
    lookback: int = LOOKBACK_SESSIONS,
    feature_columns: Sequence[str] = FEATURE_COLUMNS,
    key: str = "ticker",
) -> SequenceIndex:
    """A backward-looking window per labelled row, or a counted refusal.

    `features` is the long frame `features.build_features` returns and
    `targets` is `LabelSet.y.index` — the same `(date, asset)` pairs in
    the same order, because everything downstream slices both by
    position and a positional slice across a reordering fits the model
    on scrambled targets.

    Three ways a window fails to exist, all counted:

    `short_history` — the fund has not yet traded `lookback` sessions.
    `gapped_history` — the sixty rows are not sixty consecutive sessions
    on the panel calendar. A fund that missed a session and a fund that
    traded through it are different objects, and bridging the hole would
    quietly widen the window rather than shorten it.
    `warming_up` — some feature in the window is NaN, which for this
    panel is almost always the 252-session features still filling. An
    imputed value here is not a small error: the model has no way to
    tell a filled zero from a measured one, and sixty steps of recurrence
    is sixty chances to build a state out of it.

    A labelled row with no feature row at all is a raise rather than a
    drop. That state means the labels and the features were built from
    different panels, and the only thing worse than the mismatch is
    scoring around it.
    """
    lb = int(lookback)
    if lb < 2:
        raise LSTMError(
            f"lookback {lookback!r} is not a sequence. One step through an "
            "LSTM is a very expensive linear layer"
        )
    columns = [str(c) for c in feature_columns]
    if not columns:
        raise LSTMError("no feature columns")

    frame = _validated_features(features, columns, key=key)
    index = pd.MultiIndex.from_arrays(
        [frame["date"].to_numpy(), frame[key].to_numpy()], names=["date", "asset"]
    )
    wanted = _validated_targets(targets)

    position = index.get_indexer(wanted)
    if (position < 0).any():
        missing = int((position < 0).sum())
        first = wanted[int(np.argmax(position < 0))]
        raise LSTMError(
            f"{missing:,} labelled row(s) have no feature row — the first is "
            f"{first[1]} on {pd.Timestamp(first[0]).date()}. Labels and "
            "features must come off the same panel; scoring the rows that "
            "happen to line up would report a result for a universe nobody "
            "chose"
        )

    values = frame[columns].to_numpy(dtype="float32", copy=True)
    # One all-NaN column voids every window in the panel, and the
    # symptom is identical to a warmup that never finished: a hundred
    # per cent drop rate and a message about needing more history. The
    # usual cause is `bill_rate`, which `build_features` emits as NaN
    # when no rate series was passed, so the column is named here rather
    # than left for somebody to find by elimination.
    empty = [c for c, ok in zip(columns, np.isfinite(values).any(axis=0)) if not ok]
    if empty:
        raise LSTMError(
            f"{empty} carr{'ies' if len(empty) == 1 else 'y'} no finite value "
            "in this frame, so every window contains a NaN and no sequence "
            "can be built. Supply the missing series or leave the column out "
            "of feature_columns — filling it would hand the model a constant "
            "it cannot tell from a measurement"
        )
    dates = frame["date"].to_numpy()
    assets = frame[key].to_numpy()

    calendar = pd.DatetimeIndex(np.unique(dates)).sort_values()
    calendar_pos = calendar.get_indexer(pd.DatetimeIndex(dates)).astype(np.int64)
    finite = np.isfinite(values).all(axis=1)

    n_rows = len(frame)
    gather_all = np.zeros((n_rows, lb), dtype=np.int64)
    valid_all = np.zeros(n_rows, dtype=bool)
    reason = np.zeros(n_rows, dtype=np.int8)  # 1 short, 2 gapped, 3 warming

    order = np.argsort(assets, kind="stable")
    boundaries = np.flatnonzero(
        np.r_[True, assets[order][1:] != assets[order][:-1], True]
    )
    for start, stop in zip(boundaries[:-1], boundaries[1:]):
        rows = order[start:stop]
        # Within an asset the frame is already date-sorted by
        # `build_features`, but sorting again costs nothing and removes
        # the dependency on that staying true.
        rows = rows[np.argsort(calendar_pos[rows], kind="stable")]
        n = rows.size
        if n < lb:
            reason[rows] = 1
            continue

        cpos = calendar_pos[rows]
        windows = np.lib.stride_tricks.sliding_window_view(rows, lb)
        ends = np.arange(lb - 1, n)

        contiguous = (cpos[lb - 1 :] - cpos[: n - lb + 1]) == (lb - 1)
        # A prefix sum over the per-row finite flag turns "is every row
        # in this window finite" into one subtraction per window.
        cumulative = np.r_[0, np.cumsum(finite[rows].astype(np.int64))]
        whole = (cumulative[lb:] - cumulative[: n - lb + 1]) == lb

        good = contiguous & whole
        gather_all[rows[ends]] = windows
        valid_all[rows[ends[good]]] = True
        reason[rows[: lb - 1]] = 1
        reason[rows[ends[~contiguous]]] = 2
        reason[rows[ends[contiguous & ~whole]]] = 3

    gather = gather_all[position]
    valid = valid_all[position]
    codes = reason[position]

    dropped = {
        "short_history": int((codes == 1).sum()),
        "gapped_history": int((codes == 2).sum()),
        "warming_up": int((codes == 3).sum()),
    }
    if int(valid.sum()) + sum(dropped.values()) != len(position):
        raise LSTMError("sequence accounting lost a row")
    if not valid.any():
        raise LSTMError(
            f"no labelled row has {lb} consecutive finite sessions behind it "
            f"({dropped}). The features warm up over 252 sessions and the "
            f"window adds {lb} more, so a panel needs about "
            f"{252 + lb} sessions per name before this produces anything"
        )

    return SequenceIndex(
        feature_names=tuple(columns),
        lookback=lb,
        values=values,
        source_dates=dates,
        source_assets=assets,
        gather=gather,
        valid=valid,
        target_dates=pd.DatetimeIndex(wanted.get_level_values("date")).to_numpy(),
        target_assets=wanted.get_level_values("asset").astype(str).to_numpy(),
        dropped=dropped,
    )


def assert_backward_only(sequences: SequenceIndex) -> None:
    """Every window ends on its own target and reaches only backward.

    Cheap, structural, and run from the runner as well as the tests. It
    cannot see a feature that leaked inside `features.py` — that is what
    `features.causality_report` is for — but it is the only thing that
    can see this module putting a window one row to the right.
    """
    rows = np.flatnonzero(sequences.valid)
    if rows.size == 0:
        raise LSTMError("no valid window to check")

    ends = sequences.gather[rows, -1]
    end_dates = sequences.source_dates[ends]
    end_assets = sequences.source_assets[ends]
    target_dates = sequences.target_dates[rows]
    target_assets = sequences.target_assets[rows]

    wrong_date = end_dates != target_dates
    if wrong_date.any():
        i = int(rows[int(np.argmax(wrong_date))])
        ends_on = pd.Timestamp(sequences.source_dates[sequences.gather[i, -1]])
        raise LSTMError(
            f"a window ends on {ends_on.date()} for a target dated "
            f"{pd.Timestamp(sequences.target_dates[i]).date()}. The last row "
            "of a sequence is the decision date itself"
        )
    wrong_asset = end_assets.astype(str) != target_assets.astype(str)
    if wrong_asset.any():
        i = int(rows[int(np.argmax(wrong_asset))])
        raise LSTMError(
            f"a window built from {sequences.source_assets[sequences.gather[i, -1]]!r} "
            f"is attached to {sequences.target_assets[i]!r}. One sequence is "
            "one fund's history"
        )

    starts = sequences.source_dates[sequences.gather[rows, 0]]
    if (starts > target_dates).any():
        raise LSTMError("a window begins after the date it is meant to predict")

    # The strong version: the window is ordered and strictly increasing
    # within itself, so no row is repeated to fill a hole.
    sample = rows if rows.size <= 4096 else rows[:: max(rows.size // 4096, 1)]
    stamps = sequences.source_dates[sequences.gather[sample]]
    if not (np.diff(stamps.astype("int64"), axis=1) > 0).all():
        raise LSTMError(
            "a window repeats or reverses a session. Sequences are strictly "
            "increasing in time; a repeated row is a hole somebody filled"
        )


def sequence_causality_report(
    features: pd.DataFrame,
    targets: pd.MultiIndex,
    ats: Iterable[Any],
    *,
    lookback: int = LOOKBACK_SESSIONS,
    feature_columns: Sequence[str] = FEATURE_COLUMNS,
    key: str = "ticker",
    build: Callable[..., SequenceIndex] = build_sequences,
) -> pd.DataFrame:
    """Where a window at T changed once the rows after T were deleted.

    Build the sequences on the whole frame, build them again on the
    frame literally truncated after T, and demand the materialised
    windows at T match bit for bit. Truncation rather than masking, for
    the reason `features.causality_report` gives — a masked future
    leaves the rows in place and a window that had reached forward would
    still find them.

    **What this covers and what it cannot.** It is handed a feature
    frame that has already been computed, so it tests THIS module:
    whether the windowing reaches forward, and whether a window's
    contents or its very existence depend on rows dated after its
    target. It cannot see a leak inside a FEATURE — a column secretly
    holding tomorrow's return carries the same value before and after
    the frame is cut, because cutting the frame does not recompute it.
    That is `features.causality_report`'s question, and it answers it by
    truncating the price panel and rebuilding. The two together are the
    guarantee; reading either one as the whole of it is the comfortable
    mistake.

    `build` is injectable so a test can point the same machinery at a
    deliberately leaky twin and confirm the check fails. A causality
    check that has never been shown to fail is not evidence.

    Returns one row per disagreement and an empty frame when nothing
    moved. A date with no valid window at all is a raise, not a pass: a
    comparison of nothing to nothing is the easiest clean result in the
    world to obtain and it tests exactly nothing.
    """
    wanted = [pd.Timestamp(a).normalize() for a in ats]
    if not wanted:
        raise LSTMError(
            "no dates to check. An empty report from an empty request looks "
            "exactly like an empty report from a clean run"
        )

    frame = _validated_features(features, [str(c) for c in feature_columns], key=key)
    full = build(
        frame, targets, lookback=lookback, feature_columns=feature_columns, key=key
    )
    target_dates = pd.DatetimeIndex(full.target_dates)

    rows: list[dict[str, Any]] = []
    for at in wanted:
        here = np.flatnonzero((target_dates == at) & full.valid)
        if here.size == 0:
            raise LSTMError(
                f"{at.date()} carries no valid window, so comparing it would "
                f"pass without testing anything. Pick a date at least "
                f"{lookback} sessions past the end of the feature warmup"
            )

        cut_frame = frame.loc[frame["date"] <= at]
        cut_targets = targets[pd.DatetimeIndex(targets.get_level_values("date")) <= at]
        cut = build(
            cut_frame,
            cut_targets,
            lookback=lookback,
            feature_columns=feature_columns,
            key=key,
        )
        cut_dates = pd.DatetimeIndex(cut.target_dates)
        cut_at = {
            (str(cut.target_assets[i])): i
            for i in np.flatnonzero((cut_dates == at) & cut.valid)
        }

        for i in here:
            asset = str(full.target_assets[i])
            j = cut_at.pop(asset, None)
            if j is None:
                rows.append(_finding(at, asset, "present", "absent"))
                continue
            before = full.window(int(i))
            after = cut.window(int(j))
            if before.shape != after.shape or not np.array_equal(
                before, after, equal_nan=True
            ):
                rows.append(_finding(at, asset, "differs", "differs"))
        for asset in cut_at:
            rows.append(_finding(at, asset, "absent", "present"))

    if not rows:
        return pd.DataFrame(
            {
                "date": pd.Series([], dtype="datetime64[ns]"),
                "asset": pd.Series([], dtype="str"),
                "full": pd.Series([], dtype="str"),
                "truncated": pd.Series([], dtype="str"),
            }
        )
    return pd.DataFrame(rows).sort_values(["date", "asset"]).reset_index(drop=True)


def _finding(at: pd.Timestamp, asset: str, full: str, truncated: str) -> dict[str, Any]:
    return {"date": at, "asset": asset, "full": full, "truncated": truncated}


# -- the model ----------------------------------------------------------


class _SequenceClassifier(nn.Module):
    """One LSTM, one dropout, one logit. The video's shape, sized down.

    The head reads the LAST hidden state rather than pooling the whole
    output sequence, which is the conventional spelling and also the
    honest one here: the question is about the state the fund is in on
    the decision date, and a mean over sixty steps would answer a
    different one while looking like the same model.
    """

    def __init__(
        self,
        n_features: int,
        *,
        hidden_size: int = HIDDEN_SIZE,
        num_layers: int = NUM_LAYERS,
        dropout: float = DROPOUT,
    ) -> None:
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=n_features,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            # `nn.LSTM`'s dropout applies BETWEEN layers and is silently
            # a no-op at one layer — passing it there and believing it
            # had regularised anything is a common and invisible error.
            dropout=float(dropout) if num_layers > 1 else 0.0,
        )
        self.dropout = nn.Dropout(float(dropout))
        self.head = nn.Linear(hidden_size, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        _, (hidden, _) = self.lstm(x)
        return self.head(self.dropout(hidden[-1])).squeeze(-1)


def parameter_count(
    n_features: int,
    *,
    hidden_size: int = HIDDEN_SIZE,
    num_layers: int = NUM_LAYERS,
) -> int:
    """Trainable parameters, counted by building the thing.

    Derived from the module rather than from the textbook formula so it
    cannot drift from what is actually fitted — a capacity figure that
    describes an older architecture is worse than none, because it
    argues the wrong way with total confidence.
    """
    model = _SequenceClassifier(
        int(n_features), hidden_size=int(hidden_size), num_layers=int(num_layers)
    )
    return int(sum(p.numel() for p in model.parameters() if p.requires_grad))


@dataclass(frozen=True)
class Capacity:
    """Parameters against observations, on two definitions of the latter.

    `effective_observations` is the brief's arithmetic — rows over the
    label horizon, because consecutive windows overlap by H-1 sessions.
    `label_effective_n` is `LabelSet.effective_sample()`'s stricter
    figure, which applies a second discount for the cross-section moving
    together. Both are reported because they disagree by a factor of
    four on this panel and a reader who sees only the generous one has
    been handed the flattering half of the argument.
    """

    parameters: int
    rows: int
    horizon: int
    effective_observations: float
    label_effective_n: float
    observations_per_parameter: float
    strict_observations_per_parameter: float
    memorisation_risk: str
    note: str


def capacity(labels: LabelSet, *, n_features: int, config: LSTMConfig) -> Capacity:
    """The arithmetic the module docstring shouts about, for this panel."""
    params = parameter_count(
        n_features, hidden_size=config.hidden_size, num_layers=config.num_layers
    )
    rows = int(labels.n)
    effective = rows / float(labels.horizon)
    strict = float(labels.effective_sample().effective_n)
    per = effective / params if params else float("inf")
    strict_per = strict / params if params else float("inf")

    if strict_per < 1.0:
        risk = "guaranteed"
        verdict = (
            f"the {params:,} parameters OUTNUMBER the {strict:,.0f} "
            "observations the label module counts. Memorisation is not a "
            "risk here, it is the arithmetic: a training curve that climbs "
            "while validation sags is the expected picture"
        )
    elif per < 10.0:
        risk = "likely"
        verdict = (
            f"{per:.1f} effective observations per parameter, against the "
            "ten a fit of this shape would want. Expect the training and "
            "validation curves to separate"
        )
    else:
        risk = "unlikely"
        verdict = (
            f"{per:.1f} effective observations per parameter, which is "
            "enough room for the fit not to be memorisation on its face"
        )

    return Capacity(
        parameters=params,
        rows=rows,
        horizon=int(labels.horizon),
        effective_observations=effective,
        label_effective_n=strict,
        observations_per_parameter=per,
        strict_observations_per_parameter=strict_per,
        memorisation_risk=risk,
        note=(
            f"{rows:,} rows at a {labels.horizon}-session horizon are about "
            f"{effective:,.0f} non-overlapping observations, and about "
            f"{strict:,.0f} once the cross-section's shared movement is taken "
            f"out. The model holds {params:,} parameters: {verdict}."
        ),
    )


# -- configuration -------------------------------------------------------


@dataclass(frozen=True)
class LSTMConfig:
    """Everything that makes one run a distinct trial.

    Frozen, and `config()` is what goes to the ledger. Two runs that
    differ in width, in lookback, in seed count or in the inner
    validation fraction are two configurations — not one run and a
    correction — and the hash has to see that without anybody writing a
    sentence about it.
    """

    lookback: int = LOOKBACK_SESSIONS
    hidden_size: int = HIDDEN_SIZE
    num_layers: int = NUM_LAYERS
    dropout: float = DROPOUT
    learning_rate: float = LEARNING_RATE
    batch_size: int = BATCH_SIZE
    max_epochs: int = MAX_EPOCHS
    patience: int = PATIENCE
    n_seeds: int = ENSEMBLE_SEEDS
    mc_dropout_samples: int = MC_DROPOUT_SAMPLES
    validation_fraction: float = VALIDATION_FRACTION
    clip_sigma: float = CLIP_SIGMA
    seed: int = BASE_SEED
    device: str = "auto"

    def __post_init__(self) -> None:
        if self.lookback < 2:
            raise LSTMError("lookback must be at least two sessions")
        if self.hidden_size < 1 or self.num_layers < 1:
            raise LSTMError("the model needs at least one unit in one layer")
        if not 0.0 <= self.dropout < 1.0:
            raise LSTMError(f"dropout {self.dropout!r} is not a probability")
        if self.batch_size < 1 or self.max_epochs < 1 or self.patience < 1:
            raise LSTMError("batch size, epochs and patience are all positive")
        if self.n_seeds < 1:
            raise LSTMError("an ensemble of zero members predicts nothing")
        if self.mc_dropout_samples < 0:
            raise LSTMError("mc_dropout_samples cannot be negative")
        if self.dropout == 0.0 and self.mc_dropout_samples > 0:
            raise LSTMError(
                "MC dropout with dropout=0 samples the same deterministic "
                "network repeatedly and reports a spread of exactly zero, "
                "which reads as certainty rather than as a switch left off"
            )
        if not 0.0 < self.validation_fraction < 0.9:
            raise LSTMError(
                f"validation_fraction {self.validation_fraction!r} must leave "
                "both a fit set and a slice to choose an epoch on"
            )
        if self.clip_sigma <= 0.0:
            raise LSTMError("clip_sigma must be positive")

    def config(self) -> dict[str, Any]:
        return {
            "model": "lstm",
            "lookback": int(self.lookback),
            "hidden_size": int(self.hidden_size),
            "num_layers": int(self.num_layers),
            "dropout": float(self.dropout),
            "learning_rate": float(self.learning_rate),
            "batch_size": int(self.batch_size),
            "max_epochs": int(self.max_epochs),
            "patience": int(self.patience),
            "n_seeds": int(self.n_seeds),
            "mc_dropout_samples": int(self.mc_dropout_samples),
            "validation_fraction": float(self.validation_fraction),
            "clip_sigma": float(self.clip_sigma),
            "seed": int(self.seed),
            # Deliberately NOT the resolved device. MPS and CPU differ
            # in the last bits of a float and not in any finding, and
            # hashing the device would file the same experiment twice
            # for having been run on a different machine.
        }


def resolve_device(preference: str = "auto") -> torch.device:
    """MPS when it is really there, CPU otherwise, and never a surprise.

    `is_available()` alone is not the check: a torch built without MPS
    returns False from it for a reason worth distinguishing from a
    machine that simply has no GPU, and an explicit `device="mps"` on
    such a build should fail loudly rather than fall back silently and
    have somebody wonder for an hour why the run took the same time.

    For a net this small CPU is usually the faster of the two — sixty
    sequential steps at sixteen units is a chain of tiny kernels, and
    the launch overhead dominates the arithmetic. "Use it if it helps"
    is therefore a measurement, not a default, which is why `auto`
    exists and why it is honest about picking either one.
    """
    want = str(preference).strip().lower()
    if want == "cpu":
        return torch.device("cpu")
    available = torch.backends.mps.is_built() and torch.backends.mps.is_available()
    if want == "mps":
        if not available:
            raise LSTMError(
                "device='mps' was asked for and this torch cannot reach it "
                f"(built={torch.backends.mps.is_built()}, "
                f"available={torch.backends.mps.is_available()}). Falling "
                "back quietly would hide the reason the run is slow"
            )
        return torch.device("mps")
    if want != "auto":
        raise LSTMError(f"unknown device {preference!r}; use auto, cpu or mps")
    return torch.device("mps" if available else "cpu")


# -- scoring -------------------------------------------------------------


@dataclass(frozen=True)
class RankIC:
    """Cross-sectional rank correlation of score against what happened.

    The t-statistic comes in two forms and the second is the one to
    quote. Daily ICs computed over 21-session forward windows overlap by
    twenty sessions, so consecutive values are very nearly the same
    measurement; treating them as independent inflates the t by roughly
    the square root of the horizon. `t_adjusted` divides it back out,
    which is a crude correction and still generous — it assumes windows
    a month apart are independent, and regimes run longer than a month.
    """

    mean: float
    std: float
    n_dates: int
    horizon: int
    t_naive: float
    t_adjusted: float
    note: str


def rank_information_coefficient(
    scores: pd.Series,
    forward_returns: pd.Series,
    *,
    horizon: int,
    min_names: int = 3,
) -> RankIC:
    """Per-date Spearman correlation, averaged, with an honest t.

    Both series are indexed by `(date, asset)`. The correlation is taken
    WITHIN a date and never pooled: a pooled correlation over twenty-one
    years is mostly the statement that some years were good for
    everything, which is a fact about the calendar and not about the
    score.
    """
    if not scores.index.equals(forward_returns.index):
        raise LSTMError(
            "scores and forward returns are on different rows; a rank "
            "correlation across a misalignment is a number about nothing"
        )
    frame = pd.DataFrame(
        {"score": scores.to_numpy(dtype="float64"),
         "forward": forward_returns.to_numpy(dtype="float64")},
        index=scores.index,
    ).dropna()
    if frame.empty:
        return _empty_ic(horizon)

    dates = frame.index.get_level_values("date")
    per_date = []
    for _, block in frame.groupby(dates, sort=True):
        if len(block) < min_names:
            continue
        a = block["score"].rank().to_numpy(dtype="float64")
        b = block["forward"].rank().to_numpy(dtype="float64")
        if a.std() == 0.0 or b.std() == 0.0:
            continue
        per_date.append(float(np.corrcoef(a, b)[0, 1]))

    if not per_date:
        return _empty_ic(horizon)

    series = np.asarray(per_date, dtype="float64")
    mean = float(series.mean())
    std = float(series.std(ddof=1)) if series.size > 1 else float("nan")
    n = int(series.size)
    standard_error = std / np.sqrt(n) if np.isfinite(std) else float("nan")
    t_naive = (
        float(mean / standard_error)
        if np.isfinite(standard_error) and standard_error > 0
        else float("nan")
    )
    t_adjusted = t_naive / float(np.sqrt(horizon)) if np.isfinite(t_naive) else t_naive
    return RankIC(
        mean=mean,
        std=std,
        n_dates=n,
        horizon=int(horizon),
        t_naive=t_naive,
        t_adjusted=t_adjusted,
        note=(
            f"mean IC {mean:+.4f} over {n:,} dates. The naive t of "
            f"{t_naive:.2f} treats {n:,} overlapping {horizon}-session "
            f"windows as independent draws; dividing by sqrt({horizon}) "
            f"gives {t_adjusted:.2f}, which is the number to read and is "
            "still generous"
        ),
    )


def identity_baseline_auc(
    labels: LabelSet, train_rows: np.ndarray, test_rows: np.ndarray
) -> float:
    """The AUC available from knowing WHICH FUND this is and nothing else.

    Score every test row by the base rate its asset had in TRAINING, and
    take the AUC of that. It uses no feature, no date and no market
    state — it is a lookup table of twenty-two numbers — so whatever it
    scores is the part of a model's AUC that is fund identity rather
    than timing.

    On this panel that is not a small correction. Over 2005-2026 QQQ
    beat the cross-sectional median 61% of the time and TIP 37%, because
    the sample contains one of the great equity bull markets and the
    universe is twenty-two funds that all still existed in 2026 to be
    chosen. A classifier that learns "this one is an equity fund" from
    its volatility and drawdown scores comfortably above 0.5 and has
    learned nothing whatever about when to own it.

    This is to AUC what `LabelSet.majority_accuracy` is to accuracy, and
    it is reported for the same reason: the number beside the result is
    what makes the result readable. An LSTM at 0.56 against an identity
    baseline of 0.56 has found nothing, and the two figures printed
    apart look like a finding.
    """
    y = labels.y.to_numpy().astype("float64")
    assets = labels.y.index.get_level_values("asset").astype(str).to_numpy()

    train_rows = np.asarray(train_rows, dtype=np.int64)
    test_rows = np.asarray(test_rows, dtype=np.int64)
    if train_rows.size == 0 or test_rows.size == 0:
        return float("nan")

    frame = pd.DataFrame({"asset": assets[train_rows], "y": y[train_rows]})
    rate = frame.groupby("asset")["y"].mean()
    # A fund the training window never saw gets the pooled rate rather
    # than a NaN. Dropping it instead would score the baseline on a
    # different, easier set of rows than the model was scored on.
    scores = pd.Series(assets[test_rows]).map(rate).fillna(float(y[train_rows].mean()))
    return _auc(y[test_rows], scores.to_numpy(dtype="float64"))


def _empty_ic(horizon: int) -> RankIC:
    return RankIC(
        mean=float("nan"),
        std=float("nan"),
        n_dates=0,
        horizon=int(horizon),
        t_naive=float("nan"),
        t_adjusted=float("nan"),
        note="no date carried enough names to rank",
    )


# -- one fold ------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class FoldResult:
    """What one fold produced, and everything needed to disbelieve it.

    `trajectory` is the reason this dataclass is wide. One AUC per fold
    is the summary the source project reported and it is the summary
    that hides the finding: the shape of the two curves over forty
    epochs says whether the model learned something that generalised or
    learned the training set, and no single number distinguishes those.
    """

    fold: int
    kind: str
    n_fit: int
    n_val: int
    n_test: int
    n_dropped_no_window: int
    fit_base_rate: float
    val_base_rate: float
    test_base_rate: float
    test_auc: float
    test_accuracy: float
    majority_accuracy: float
    #: What a lookup table of per-fund training base rates scores on the
    #: same rows. Read `test_auc` against this, not against 0.5.
    identity_auc: float
    val_auc_at_stop: float
    best_epochs: tuple[int, ...]
    epochs_run: tuple[int, ...]
    rank_ic: RankIC
    trajectory: pd.DataFrame = field(repr=False)
    predictions: pd.Series = field(repr=False)
    ensemble_spread: pd.Series = field(repr=False)
    truth: pd.Series = field(repr=False)
    mc_spread: pd.Series | None = field(default=None, repr=False)

    def accuracy_row(self) -> pd.DataFrame:
        """The accuracy WITH its base rate, from the label module.

        Routed through `labels.accuracy_report` rather than reimplemented
        so that there is exactly one function in this repository capable
        of printing an accuracy, and it is one that cannot print it
        alone.
        """
        return accuracy_report(
            self.truth,
            (self.predictions.to_numpy() > 0.5).astype("int8"),
            auc=self.test_auc,
            label=f"{self.kind} fold {self.fold}",
        )

    def describe(self) -> pd.DataFrame:
        row = {
            "fold": self.fold,
            "kind": self.kind,
            "n_fit": self.n_fit,
            "n_val": self.n_val,
            "n_test": self.n_test,
            "n_dropped_no_window": self.n_dropped_no_window,
            "fit_base_rate": self.fit_base_rate,
            "val_base_rate": self.val_base_rate,
            "test_base_rate": self.test_base_rate,
            "test_auc": self.test_auc,
            "identity_auc": self.identity_auc,
            "auc_over_identity": self.test_auc - self.identity_auc,
            "test_accuracy": self.test_accuracy,
            "majority_accuracy": self.majority_accuracy,
            "accuracy_edge": self.test_accuracy - self.majority_accuracy,
            "val_auc_at_stop": self.val_auc_at_stop,
            "best_epoch_mean": float(np.mean(self.best_epochs)),
            "epochs_run_mean": float(np.mean(self.epochs_run)),
            "rank_ic": self.rank_ic.mean,
            "rank_ic_t_adjusted": self.rank_ic.t_adjusted,
            "ensemble_spread_mean": float(self.ensemble_spread.mean()),
        }
        return pd.DataFrame([row])


def fit_fold(
    fold: PanelFold,
    *,
    sequences: SequenceIndex,
    labels: LabelSet,
    plan: SplitPlan,
    config: LSTMConfig = LSTMConfig(),
    device: torch.device | None = None,
) -> FoldResult:
    """Fit the ensemble on one fold and score its test set exactly once.

    The order matters and is the methodological claim of the file:

    1. Drop the rows with no complete window. Counted, never repaired.
    2. Cut the tail of the TRAINING dates off as an inner validation
       slice, and purge from the fit set every row whose label window
       reaches into it. That purge is the same rule `splits.py` applies
       at the outer seam, applied at the inner one, for the same reason.
    3. Standardise on the fit rows only — on the source rows the fit
       sequences actually touch, which are all dated on or before the
       last fit date.
    4. Train, choosing the epoch on the inner slice.
    5. Score the test set once, at that epoch.

    Step 4 is where most reproductions of this experiment lose their
    out-of-sample without noticing. Choosing the epoch on the test fold
    turns the reported AUC into a maximum over forty draws, which on a
    coin-flip problem reliably prints something above 0.5.
    """
    device = device or resolve_device(config.device)
    y = labels.y.to_numpy().astype("float32")

    train_rows = _valid(fold.train_rows, sequences)
    test_rows = _valid(fold.test_rows, sequences)
    dropped = int(fold.n_train + fold.n_test - train_rows.size - test_rows.size)
    if train_rows.size == 0 or test_rows.size == 0:
        raise LSTMError(
            f"{fold.kind} fold {fold.fold}: no complete window survives on "
            f"{'the training' if train_rows.size == 0 else 'the test'} side. "
            f"A {sequences.lookback}-session window on top of the feature "
            "warmup eats the start of the sample"
        )

    fit_rows, val_rows = _inner_split(
        train_rows, labels=labels, plan=plan, config=config
    )

    scaler = _Scaler.fit(sequences, fit_rows, clip=config.clip_sigma)
    fit_y, val_y, test_y = y[fit_rows], y[val_rows], y[test_rows]

    members: list[np.ndarray] = []
    mc_members: list[np.ndarray] = []
    trajectories: list[pd.DataFrame] = []
    best_epochs: list[int] = []
    epochs_run: list[int] = []
    val_at_stop: list[float] = []

    for member in range(config.n_seeds):
        seed = int(config.seed) + member
        trained = _train_one(
            sequences=sequences,
            scaler=scaler,
            fit_rows=fit_rows,
            fit_y=fit_y,
            val_rows=val_rows,
            val_y=val_y,
            config=config,
            device=device,
            seed=seed,
        )
        trajectories.append(trained.trajectory.assign(seed=seed, fold=fold.fold))
        best_epochs.append(trained.best_epoch)
        epochs_run.append(trained.epochs_run)
        val_at_stop.append(trained.best_val_auc)
        members.append(
            _predict(trained.model, sequences, scaler, test_rows, config, device)
        )
        if config.mc_dropout_samples > 0:
            mc_members.append(
                _mc_dropout_spread(
                    trained.model, sequences, scaler, test_rows, config, device, seed
                )
            )

    stacked = np.vstack(members)
    mean = stacked.mean(axis=0)
    spread = (
        stacked.std(axis=0, ddof=1) if stacked.shape[0] > 1
        else np.zeros_like(mean)
    )

    index = labels.y.index[test_rows]
    predictions = pd.Series(mean, index=index, name="p_up")
    ensemble_spread = pd.Series(spread, index=index, name="ensemble_spread")
    mc_spread = (
        pd.Series(np.vstack(mc_members).mean(axis=0), index=index, name="mc_spread")
        if mc_members
        else None
    )

    auc = _auc(test_y, mean)
    accuracy = float(((mean > 0.5).astype("float32") == test_y).mean())
    base = float(test_y.mean())

    return FoldResult(
        fold=fold.fold,
        kind=fold.kind,
        n_fit=int(fit_rows.size),
        n_val=int(val_rows.size),
        n_test=int(test_rows.size),
        n_dropped_no_window=dropped,
        fit_base_rate=float(fit_y.mean()),
        val_base_rate=float(val_y.mean()),
        test_base_rate=base,
        test_auc=auc,
        test_accuracy=accuracy,
        majority_accuracy=float(max(base, 1.0 - base)),
        identity_auc=identity_baseline_auc(labels, fit_rows, test_rows),
        val_auc_at_stop=float(np.mean(val_at_stop)),
        best_epochs=tuple(best_epochs),
        epochs_run=tuple(epochs_run),
        rank_ic=rank_information_coefficient(
            predictions,
            labels.forward_return.iloc[test_rows],
            horizon=labels.horizon,
        ),
        trajectory=pd.concat(trajectories, ignore_index=True),
        predictions=predictions,
        ensemble_spread=ensemble_spread,
        truth=pd.Series(test_y.astype("int8"), index=index, name="label"),
        mc_spread=mc_spread,
    )


# -- the run -------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class LSTMReport:
    """Every fold of one configuration, with the capacity above it."""

    config: LSTMConfig
    plan: SplitPlan = field(repr=False)
    sequences: SequenceIndex = field(repr=False)
    capacity: Capacity
    device: str
    folds: tuple[FoldResult, ...] = field(repr=False)

    def describe(self) -> pd.DataFrame:
        return pd.concat([f.describe() for f in self.folds], ignore_index=True)

    def trajectory(self) -> pd.DataFrame:
        """Every epoch of every seed of every fold, long.

        The frame the whole exercise exists to produce. Pivot it by fold
        and read the two AUC columns against each other: the source
        project's finding was the SHAPE of those curves, and a mean over
        them is precisely the summary that erases it.
        """
        return pd.concat([f.trajectory for f in self.folds], ignore_index=True)

    def accuracy_rows(self) -> pd.DataFrame:
        return pd.concat([f.accuracy_row() for f in self.folds], ignore_index=True)

    def trial_config(self) -> dict[str, Any]:
        return {**self.plan.config(), "model": self.config.config()}

    def summary(self) -> str:
        described = self.describe()
        auc = described["test_auc"].to_numpy(dtype="float64")
        identity = described["identity_auc"].to_numpy(dtype="float64")
        base = described["test_base_rate"].to_numpy(dtype="float64")
        accuracy = described["test_accuracy"].to_numpy(dtype="float64")
        drift = self._drift()

        headline = (
            f"{len(self.folds)} {self.plan.kind} folds, test AUC "
            f"{np.nanmean(auc):.3f} "
            f"(per fold {', '.join(f'{a:.3f}' for a in auc)}); accuracy "
            f"{np.nanmean(accuracy):.1%} against a base rate of "
            f"{np.nanmean(base):.1%}"
        )
        if abs(float(np.nanmean(auc)) - 0.5) < 0.02:
            headline += ". That is a coin flip, and it is the measurement"

        over = float(np.nanmean(auc) - np.nanmean(identity))
        against = (
            f"A lookup table of per-fund training base rates scores "
            f"{np.nanmean(identity):.3f} on the same rows, so the model is "
            f"{over:+.3f} on top of knowing nothing but which fund this is"
        )
        if over < 0.01:
            against += " — which is to say it has learned identity, not timing"
        return (
            f"{headline}.\n{against}.\n{self.capacity.note}\n{drift}\n"
            f"Trained on {self.device}; predictions are the mean of "
            f"{self.config.n_seeds} seeds and the spread across them measures "
            "how stable the fit is, not how likely it is to be right."
        )

    def _drift(self) -> str:
        """The one sentence the video's chart was worth."""
        traj = self.trajectory()
        if traj.empty:
            return "no epochs recorded"
        first = traj.groupby("fold", sort=True).first()
        last = traj.groupby("fold", sort=True).last()
        train_move = float((last["train_auc"] - first["train_auc"]).mean())
        val_move = float((last["val_auc"] - first["val_auc"]).mean())
        if train_move > 0.01 and val_move < 0.0:
            shape = (
                "training AUC climbed while validation fell — the divergence "
                "the capacity arithmetic predicts"
            )
        elif train_move > 0.01 and val_move < train_move / 2.0:
            shape = "training AUC climbed roughly twice as fast as validation"
        else:
            shape = "training and validation moved together"
        return (
            f"Across the run training AUC moved {train_move:+.3f} and "
            f"validation {val_move:+.3f}: {shape}."
        )


def run_lstm(
    features: pd.DataFrame,
    labels: LabelSet,
    plan: SplitPlan,
    *,
    config: LSTMConfig = LSTMConfig(),
    feature_columns: Sequence[str] = FEATURE_COLUMNS,
    key: str = "ticker",
    trials: Any | None = None,
    description: str | None = None,
    on_fold: Callable[[FoldResult], None] | None = None,
) -> LSTMReport:
    """Fit the configuration over every fold of a plan and report it.

    `trials` is a `util.runs.Trials` (or anything with the same `log`)
    and it is logged BEFORE a single fold is fitted. The ordering is
    deliberate: a configuration that is written down only if it finishes
    is a configuration that quietly does not count when it disappoints,
    and the whole value of the ledger is that it counts the
    disappointments.

    `plan.verify()` is re-run here rather than trusted. It is cheap, and
    a purge that was intended is not a purge that has been asked about.
    """
    if not isinstance(labels, LabelSet):
        raise LSTMError(f"expected a LabelSet, got {type(labels).__name__}")
    if not isinstance(plan, SplitPlan):
        raise LSTMError(f"expected a SplitPlan, got {type(plan).__name__}")
    if plan.labels is not labels:
        raise LSTMError(
            "the plan was built from a different LabelSet. Its folds index "
            "that one's rows, and slicing this one by them would fit the "
            "model on somebody else's targets"
        )

    plan.verify()
    sequences = build_sequences(
        features,
        labels.y.index,
        lookback=config.lookback,
        feature_columns=feature_columns,
        key=key,
    )
    assert_backward_only(sequences)

    device = resolve_device(config.device)
    cap = capacity(labels, n_features=sequences.n_features, config=config)

    if trials is not None:
        trials.log(
            {**plan.config(), "model": config.config()},
            description or (
                f"LSTM h{config.hidden_size} lookback {config.lookback} over "
                f"{plan.kind}, {len(plan)} folds, {cap.parameters:,} parameters"
            ),
        )

    results = []
    for fold in plan:
        result = fit_fold(
            fold,
            sequences=sequences,
            labels=labels,
            plan=plan,
            config=config,
            device=device,
        )
        results.append(result)
        if on_fold is not None:
            on_fold(result)

    return LSTMReport(
        config=config,
        plan=plan,
        sequences=sequences,
        capacity=cap,
        device=str(device),
        folds=tuple(results),
    )


# -- training machinery --------------------------------------------------


@dataclass(frozen=True)
class _Scaler:
    """Per-feature mean and standard deviation, fit on training rows only.

    Fit on the source rows the FIT sequences touch rather than on the
    fit targets' own rows, because a sequence's earlier steps are inputs
    too and standardising them by statistics they were not part of is
    the sort of small inconsistency that shows up as a model that works
    in backtest and not on the next month. Every touched row is dated on
    or before the last fit date, so nothing here reaches forward.
    """

    mean: np.ndarray
    std: np.ndarray
    clip: float

    @classmethod
    def fit(
        cls, sequences: SequenceIndex, rows: np.ndarray, *, clip: float
    ) -> _Scaler:
        touched = np.unique(sequences.gather[rows])
        block = sequences.values[touched]
        mean = block.mean(axis=0)
        std = block.std(axis=0)
        # A feature that never moved in this training window carries no
        # information and dividing by its zero would carry a great deal.
        std = np.where(std > 1e-12, std, 1.0)
        return cls(
            mean=mean.astype("float32"),
            std=std.astype("float32"),
            clip=float(clip),
        )

    def transform(self, block: np.ndarray) -> np.ndarray:
        out = (block - self.mean) / self.std
        return np.clip(out, -self.clip, self.clip, out=out)


@dataclass
class _Trained:
    model: _SequenceClassifier
    trajectory: pd.DataFrame
    best_epoch: int
    epochs_run: int
    best_val_auc: float


def _train_one(
    *,
    sequences: SequenceIndex,
    scaler: _Scaler,
    fit_rows: np.ndarray,
    fit_y: np.ndarray,
    val_rows: np.ndarray,
    val_y: np.ndarray,
    config: LSTMConfig,
    device: torch.device,
    seed: int,
) -> _Trained:
    """One member: train, record every epoch, keep the best by inner AUC."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)

    model = _SequenceClassifier(
        sequences.n_features,
        hidden_size=config.hidden_size,
        num_layers=config.num_layers,
        dropout=config.dropout,
    ).to(device)
    optimiser = torch.optim.Adam(model.parameters(), lr=config.learning_rate)
    criterion = nn.BCEWithLogitsLoss()

    rows: list[dict[str, Any]] = []
    best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
    best_auc = -np.inf
    best_epoch = 0
    since_best = 0

    for epoch in range(1, config.max_epochs + 1):
        model.train()
        # Shuffled every epoch, and only here. Unshuffled batches are
        # each one month of one market, and the gradient then tracks the
        # calendar rather than the cross-section.
        order = rng.permutation(fit_rows.size)
        running = 0.0
        for start in range(0, order.size, config.batch_size):
            take = order[start : start + config.batch_size]
            x = _tensor(sequences, scaler, fit_rows[take], device)
            target = torch.from_numpy(fit_y[take]).to(device)
            optimiser.zero_grad(set_to_none=True)
            loss = criterion(model(x), target)
            loss.backward()
            optimiser.step()
            running += float(loss.detach().cpu()) * take.size
        train_loss = running / max(order.size, 1)

        # Evaluation is in row order, which for a label frame sorted by
        # date is time order. Never permuted: every evaluation path here
        # has to be the one live trading would take.
        train_p = _predict(model, sequences, scaler, fit_rows, config, device)
        val_p = _predict(model, sequences, scaler, val_rows, config, device)
        train_auc = _auc(fit_y, train_p)
        val_auc = _auc(val_y, val_p)
        rows.append(
            {
                "epoch": epoch,
                "train_loss": train_loss,
                "val_loss": _bce(val_y, val_p),
                "train_auc": train_auc,
                "val_auc": val_auc,
            }
        )

        if np.isfinite(val_auc) and val_auc > best_auc:
            best_auc = float(val_auc)
            best_epoch = epoch
            since_best = 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        else:
            since_best += 1
            if since_best >= config.patience:
                break

    model.load_state_dict(best_state)
    return _Trained(
        model=model,
        trajectory=pd.DataFrame(rows),
        best_epoch=best_epoch,
        epochs_run=len(rows),
        best_val_auc=float(best_auc) if np.isfinite(best_auc) else float("nan"),
    )


def _tensor(
    sequences: SequenceIndex,
    scaler: _Scaler,
    rows: np.ndarray,
    device: torch.device,
) -> torch.Tensor:
    block = sequences.values[sequences.gather[rows]]
    return torch.from_numpy(scaler.transform(block)).to(device)


@torch.no_grad()
def _predict(
    model: _SequenceClassifier,
    sequences: SequenceIndex,
    scaler: _Scaler,
    rows: np.ndarray,
    config: LSTMConfig,
    device: torch.device,
) -> np.ndarray:
    model.eval()
    out = np.empty(rows.size, dtype="float64")
    step = max(config.batch_size * 4, 1)
    for start in range(0, rows.size, step):
        take = rows[start : start + step]
        logits = model(_tensor(sequences, scaler, take, device))
        out[start : start + take.size] = torch.sigmoid(logits).cpu().numpy()
    return out


@torch.no_grad()
def _mc_dropout_spread(
    model: _SequenceClassifier,
    sequences: SequenceIndex,
    scaler: _Scaler,
    rows: np.ndarray,
    config: LSTMConfig,
    device: torch.device,
    seed: int,
) -> np.ndarray:
    """Standard deviation over T stochastic passes with dropout live.

    Everything except the dropout stays in eval mode, which matters:
    `model.train()` would also change any normalisation layer's
    behaviour, and a spread that includes batch-statistics noise is
    measuring the batch rather than the model.

    Read the number narrowly. Dropout sits on one layer here, so the
    posterior this approximates is thin, and like the ensemble spread it
    says nothing about the risk that twenty-one years of one historical
    path was the wrong evidence.
    """
    torch.manual_seed(seed + 10_000)
    model.eval()
    for module in model.modules():
        if isinstance(module, nn.Dropout):
            module.train()

    draws = np.empty((config.mc_dropout_samples, rows.size), dtype="float64")
    step = max(config.batch_size * 4, 1)
    for t in range(config.mc_dropout_samples):
        for start in range(0, rows.size, step):
            take = rows[start : start + step]
            logits = model(_tensor(sequences, scaler, take, device))
            draws[t, start : start + take.size] = torch.sigmoid(logits).cpu().numpy()
    model.eval()
    if config.mc_dropout_samples < 2:
        return np.zeros(rows.size)
    return draws.std(axis=0, ddof=1)


# -- splitting inside the training window --------------------------------


def _inner_split(
    train_rows: np.ndarray,
    *,
    labels: LabelSet,
    plan: SplitPlan,
    config: LSTMConfig,
) -> tuple[np.ndarray, np.ndarray]:
    """Fit rows and an inner validation slice, purged at the seam.

    The slice is the LAST dates of the training window rather than a
    random sample of its rows, because a random sample puts SPY's
    2019-03-14 in the fit set and TLT's in the validation set — the
    exact failure `splits.py` refuses at the outer seam, and it is no
    less of one for happening one level in. The fit rows are then purged
    of everything whose label window closes on or after the slice
    begins.
    """
    row_dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))
    dates = pd.DatetimeIndex(np.unique(row_dates[train_rows])).sort_values()
    if len(dates) < 2:
        raise LSTMError("a training window of one date cannot be split")

    cut = int(np.floor(len(dates) * (1.0 - config.validation_fraction)))
    cut = min(max(cut, 1), len(dates) - 1)
    val_start = dates[cut]

    label_end = plan.label_end.reindex(row_dates[train_rows]).to_numpy()
    in_val = row_dates[train_rows].to_numpy() >= val_start.to_datetime64()
    # A window closing exactly ON the slice's first session used that
    # session's price to become a label, so `>=` is the purge and `>`
    # would leave one day of the answer inside the fit set.
    reaches_in = label_end >= val_start.to_datetime64()

    fit_rows = train_rows[~in_val & ~reaches_in]
    val_rows = train_rows[in_val]

    if fit_rows.size < MIN_INNER_ROWS or val_rows.size < MIN_INNER_ROWS:
        raise LSTMError(
            f"the inner split leaves {fit_rows.size:,} fit rows and "
            f"{val_rows.size:,} validation rows, under the floor of "
            f"{MIN_INNER_ROWS:,}. Choosing an epoch on fewer than that is "
            "choosing it on noise, and the alternative — stopping on the "
            "test fold — would spend the out-of-sample this whole scheme "
            "exists to protect"
        )
    if len(np.unique(labels.y.to_numpy()[val_rows])) < 2:
        raise LSTMError(
            "the inner validation slice is one class, so its AUC is "
            "undefined and no epoch can be chosen on it"
        )
    return fit_rows, val_rows


# -- small helpers -------------------------------------------------------


def _valid(rows: np.ndarray, sequences: SequenceIndex) -> np.ndarray:
    return np.asarray(rows, dtype=np.int64)[sequences.valid[rows]]


def _auc(truth: np.ndarray, score: np.ndarray) -> float:
    """AUC, or NaN when the truth is one class rather than 0.5.

    A single-class fold has no AUC. Returning 0.5 would be a plausible
    number in exactly the place this project expects to find one, which
    is the worst available way to be wrong.
    """
    if truth.size == 0 or len(np.unique(truth)) < 2:
        return float("nan")
    return float(roc_auc_score(truth, score))


def _bce(truth: np.ndarray, probability: np.ndarray) -> float:
    p = np.clip(probability, 1e-7, 1.0 - 1e-7)
    return float(-(truth * np.log(p) + (1.0 - truth) * np.log(1.0 - p)).mean())


def _validated_features(
    features: pd.DataFrame, columns: Sequence[str], *, key: str
) -> pd.DataFrame:
    if not isinstance(features, pd.DataFrame):
        raise LSTMError(f"features must be a DataFrame, got {type(features).__name__}")
    need = ["date", key, *columns]
    missing = [c for c in need if c not in features.columns]
    if missing:
        raise LSTMError(
            f"feature frame is missing {missing}; got {sorted(features.columns)}"
        )
    out = features.loc[:, need].copy()
    out["date"] = pd.to_datetime(out["date"]).dt.normalize()
    out[key] = out[key].astype("str")
    if out.duplicated(subset=["date", key]).any():
        n = int(out.duplicated(subset=["date", key]).sum())
        raise LSTMError(
            f"{n:,} duplicate ({key}, date) row(s) in the feature frame. A "
            "window built over a duplicated session covers fewer days than "
            "it claims"
        )
    return out.sort_values([key, "date"]).reset_index(drop=True)


def _validated_targets(targets: pd.MultiIndex) -> pd.MultiIndex:
    """The label index, normalised the same way the frame's dates were.

    Order is preserved and never sorted. Fold row indices are positions
    into exactly this sequence, so a tidy-looking sort here would hand
    every model in the file somebody else's targets.
    """
    if not isinstance(targets, pd.MultiIndex) or targets.nlevels != 2:
        raise LSTMError(
            "targets must be the LabelSet's own (date, asset) MultiIndex; "
            "anything else loses the order the fold row indices are in"
        )
    return pd.MultiIndex.from_arrays(
        [
            pd.DatetimeIndex(targets.get_level_values(0)).normalize(),
            targets.get_level_values(1).astype(str),
        ],
        names=["date", "asset"],
    )
