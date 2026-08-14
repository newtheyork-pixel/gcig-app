"""Tests that try to make the sequence model cheat, and to make its
reporting flatter it.

A confirmatory test here would be close to worthless. Fit the net, watch
an AUC come back near 0.5, declare the pipeline sound — that passes for
a model reading tomorrow's price just as readily, because a leaky model
on a hard problem also scores near 0.5 and a leaky model is what this
file is for. So every assertion below starts from a specific window,
row or epoch that must exist or must not, and the ones about leakage are
paired with a deliberately leaky twin that has to be CAUGHT.

Five properties carry the weight.

**A window reaches backward and only backward.** Tested by the
structural check on the gather indices, by literal truncation of the
frame at T, and — twice — by handing both of those a builder that slides
every window one row to the right. A causality check that has never been
shown to fail is not evidence about anything. There is also a test for
what these checks CANNOT see, because the boundary of a guarantee is
worth pinning down before somebody assumes it is further out.

**Gaps are dropped, not bridged.** The assertion names the row on each
side of the seam: the target after a missing session must be refused,
and the one a full window later must be kept. "These rows are gone" on
its own passes for a builder that dropped everything.

**Early stopping cannot see the test fold.** The reason the video's
number was unreadable is that the epoch was chosen on the data the score
was reported from. Here the inner slice is asserted disjoint from the
test rows, later in time than the fit rows, and purged of every label
window that reaches into it — and a spy on the prediction path checks
that no test row is scored until the fit is over.

**Shuffled in training, never in evaluation.** Both directions are
asserted from the same spy, because a test for one is silent about the
other and they are opposite requirements.

**The reporting cannot print a bare number.** An accuracy without its
base rate, an AUC without the fund-identity baseline, a rank IC without
the horizon deflation — each of those is a way to make noise read as a
result, and each has a test.

Everything is synthetic and seeded. No claim here is about a market;
they are all about arithmetic on windows, rows and epochs, and real
prices would make none of them truer.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest
import torch

from griffinquant.engine.metrics import TrialCounter
from griffinquant.ml import lstm as L
from griffinquant.ml.labels import build_labels
from griffinquant.ml.splits import purged_folds, walk_forward_folds
from griffinquant.util.runs import Trials


# -- fixtures ------------------------------------------------------------
#
# Features are built here rather than through `features.build_features`
# on purpose. That module needs 252 sessions of warmup before it emits
# anything, which would put a thousand sessions of scaffolding in front
# of every test in this file and test its windows rather than ours. What
# matters downstream is only that the frame is long, causal and finite;
# a three-column stand-in with those properties makes the leak tests
# below possible, because a leak has to be plantable to be caught.

ASSETS = ("AAA", "BBB", "CCC", "DDD", "EEE", "FFF")


def prices(
    n_dates: int = 520,
    assets: tuple[str, ...] = ASSETS,
    *,
    seed: int = 0,
    drift: tuple[float, ...] | None = None,
) -> pd.DataFrame:
    index = pd.bdate_range("2010-01-04", periods=n_dates)
    rng = np.random.default_rng(seed)
    returns = rng.normal(0.0003, 0.011, size=(n_dates, len(assets)))
    if drift is not None:
        returns = returns + np.asarray(drift, dtype="float64")
    panel = 100.0 * np.exp(np.cumsum(returns, axis=0))
    return pd.DataFrame(panel, index=index, columns=list(assets))


def features(panel: pd.DataFrame, *, seed: int = 1, leak: str = "") -> pd.DataFrame:
    """A long feature frame: two trailing statistics and one noise column.

    `leak` plants a forward-looking column. `"hole"` makes the leaked
    value NaN at the end of any truncated frame, so truncation turns the
    window into a missing row; `"number"` leaves a perfectly plausible
    float there instead, which is the harder case and the one a sloppy
    check would wave through.
    """
    ret5 = panel / panel.shift(5) - 1.0
    vol21 = (panel / panel.shift(1) - 1.0).rolling(21, min_periods=21).std(ddof=1)
    rng = np.random.default_rng(seed)

    columns = {"ret5": ret5, "vol21": vol21}
    if leak == "hole":
        columns["cheat"] = panel.shift(-1) / panel - 1.0
    elif leak == "number":
        forward = panel.shift(-1)
        columns["cheat"] = forward.where(forward.notna(), panel) / panel - 1.0
    elif leak:
        raise AssertionError(f"unknown leak {leak!r}")

    frames = []
    for name, wide in columns.items():
        stacked = wide.stack()
        stacked.index = stacked.index.set_names(["date", "ticker"])
        frames.append(stacked.rename(name))
    out = pd.concat(frames, axis=1).reset_index()
    out["noise"] = rng.normal(size=len(out))
    return out.dropna(subset=["ret5", "vol21"]).reset_index(drop=True)


def feature_names(leak: str = "") -> tuple[str, ...]:
    return ("ret5", "vol21", "noise") + (("cheat",) if leak else ())


def labelled(panel: pd.DataFrame | None = None, *, horizon: int = 5):
    panel = prices() if panel is None else panel
    return build_labels(panel, horizon=horizon)


def sequenced(
    panel: pd.DataFrame | None = None,
    *,
    horizon: int = 5,
    lookback: int = 10,
    leak: str = "",
):
    panel = prices() if panel is None else panel
    labels = build_labels(panel, horizon=horizon)
    frame = features(panel, leak=leak)
    # The feature frame warms up 21 sessions and the labels do not, so
    # the labelled rows are trimmed to what the features can describe.
    # Real runs do this by construction; here it is explicit so the
    # trimming is visible rather than a surprise inside a helper.
    have = pd.MultiIndex.from_arrays(
        [frame["date"], frame["ticker"]], names=["date", "asset"]
    )
    labels = _restrict(labels, labels.y.index.isin(have))
    seq = L.build_sequences(
        frame, labels.y.index, lookback=lookback, feature_columns=feature_names(leak)
    )
    return labels, frame, seq


def _restrict(labels, mask: np.ndarray):
    """The same LabelSet over a subset of its rows.

    A helper rather than a rebuild, because rebuilding would recompute
    the cross-sectional median over the surviving names and quietly
    change the labels the test is reasoning about.
    """
    from dataclasses import replace

    return replace(
        labels,
        y=labels.y[mask],
        forward_return=labels.forward_return[mask],
        benchmark=labels.benchmark[mask],
    )


def tiny(**overrides) -> L.LSTMConfig:
    """A config small enough to fit in a test and shaped like the real one."""
    base = dict(
        lookback=10,
        hidden_size=4,
        num_layers=1,
        dropout=0.2,
        batch_size=64,
        max_epochs=2,
        patience=2,
        n_seeds=1,
        validation_fraction=0.25,
        device="cpu",
    )
    base.update(overrides)
    return L.LSTMConfig(**base)


# -- a window reaches backward and only backward -------------------------


def test_a_window_ends_on_its_own_decision_date_and_climbs_in_time() -> None:
    _, _, seq = sequenced()
    L.assert_backward_only(seq)

    i = int(np.flatnonzero(seq.valid)[len(seq.valid) // 2])
    dates = seq.window_dates(i)
    assert dates[-1] == seq.target_dates[i]
    assert (np.diff(dates.astype("int64")) > 0).all()
    assert len(dates) == seq.lookback


def test_the_structural_check_catches_a_window_nudged_one_row_forward() -> None:
    """The check has to be able to fail or it is decoration.

    One position to the right is the whole of the bug: every value in
    the sequence is real, the shapes are right, nothing is NaN, and the
    model is reading tomorrow.
    """
    _, _, seq = sequenced()
    valid = np.flatnonzero(seq.valid)
    shifted = seq.gather.copy()
    shifted[valid] = np.minimum(shifted[valid] + 1, len(seq.values) - 1)
    leaky = L.SequenceIndex(
        feature_names=seq.feature_names,
        lookback=seq.lookback,
        values=seq.values,
        source_dates=seq.source_dates,
        source_assets=seq.source_assets,
        gather=shifted,
        valid=seq.valid,
        target_dates=seq.target_dates,
        target_assets=seq.target_assets,
        dropped=seq.dropped,
    )
    with pytest.raises(L.LSTMError, match="last row of a sequence"):
        L.assert_backward_only(leaky)


def test_windows_at_T_survive_the_frame_being_truncated_at_T() -> None:
    labels, frame, seq = sequenced()
    dates = pd.DatetimeIndex(seq.target_dates)
    at = dates[seq.valid][len(dates[seq.valid]) // 2]

    report = L.sequence_causality_report(
        frame, labels.y.index, [at], lookback=10, feature_columns=feature_names()
    )
    assert report.empty, report.head().to_dict("records")


def test_the_truncation_check_catches_a_builder_that_reaches_one_row_forward() -> None:
    """The check has to be shown failing or it is not evidence.

    The leaky twin is the canonical off-by-one: every window slid one
    position to the right. On the whole frame it produces real,
    finite, well-shaped values, which is why nothing downstream would
    notice. On the frame truncated at T the row it wanted is not there
    any more, so the window it builds is a different one — and that is
    the difference the report is looking for.
    """
    labels, frame, _ = sequenced()

    def leaky(features_frame, targets, **kwargs):
        honest = L.build_sequences(features_frame, targets, **kwargs)
        rows = np.flatnonzero(honest.valid)
        gather = honest.gather.copy()
        gather[rows] = np.minimum(gather[rows] + 1, len(honest.values) - 1)
        return L.SequenceIndex(
            feature_names=honest.feature_names,
            lookback=honest.lookback,
            values=honest.values,
            source_dates=honest.source_dates,
            source_assets=honest.source_assets,
            gather=gather,
            valid=honest.valid,
            target_dates=honest.target_dates,
            target_assets=honest.target_assets,
            dropped=honest.dropped,
        )

    _, _, seq = sequenced()
    dates = pd.DatetimeIndex(seq.target_dates)
    at = dates[seq.valid][len(dates[seq.valid]) // 2]

    clean = L.sequence_causality_report(
        frame, labels.y.index, [at], lookback=10, feature_columns=feature_names()
    )
    assert clean.empty

    caught = L.sequence_causality_report(
        frame,
        labels.y.index,
        [at],
        lookback=10,
        feature_columns=feature_names(),
        build=leaky,
    )
    assert not caught.empty
    assert set(caught["date"]) == {at}


def test_a_leak_inside_a_feature_is_not_this_check_s_to_find() -> None:
    """Stated as a test so the boundary is a fact rather than a hope.

    A column holding tomorrow's return survives truncation unchanged,
    because truncating a computed frame does not recompute it. The
    windowing check passes and the panel is still poisoned; only
    `features.causality_report`, which cuts the PRICE panel and
    rebuilds, can see it. Reading this one as the whole guarantee is the
    comfortable mistake.
    """
    labels, frame, seq = sequenced(leak="number")
    dates = pd.DatetimeIndex(seq.target_dates)
    at = dates[seq.valid][len(dates[seq.valid]) // 2]

    report = L.sequence_causality_report(
        frame,
        labels.y.index,
        [at],
        lookback=10,
        feature_columns=feature_names("number"),
    )
    assert report.empty
    assert "cheat" in frame.columns


def test_a_date_with_no_valid_window_is_refused_rather_than_reported_clean() -> None:
    """The easiest clean result in the world, and it tests nothing."""
    labels, frame, _ = sequenced()
    first = pd.DatetimeIndex(labels.y.index.get_level_values("date")).min()
    with pytest.raises(L.LSTMError, match="carries no valid window"):
        L.sequence_causality_report(
            frame, labels.y.index, [first], lookback=10,
            feature_columns=feature_names()
        )


# -- gaps, holes and the rows that must survive them ---------------------


def test_a_missing_session_is_dropped_rather_than_bridged() -> None:
    """Named on both sides of the seam.

    Without the second assertion this passes for a builder that refused
    every window in the panel.
    """
    panel = prices()
    labels = build_labels(panel, horizon=5)
    frame = features(panel)

    victim = "CCC"
    dates = pd.DatetimeIndex(sorted(frame["date"].unique()))
    gap = dates[len(dates) // 2]
    frame = frame.loc[~((frame["ticker"] == victim) & (frame["date"] == gap))]

    have = pd.MultiIndex.from_arrays(
        [frame["date"], frame["ticker"]], names=["date", "asset"]
    )
    labels = _restrict(labels, labels.y.index.isin(have))
    seq = L.build_sequences(
        frame, labels.y.index, lookback=10, feature_columns=feature_names()
    )

    rows = pd.DataFrame(
        {
            "date": pd.DatetimeIndex(seq.target_dates),
            "asset": seq.target_assets,
            "valid": seq.valid,
        }
    )
    mine = rows.loc[rows["asset"] == victim].sort_values("date").reset_index(drop=True)
    after = mine.loc[mine["date"] > gap]

    # The nine sessions whose window still spans the hole are refused.
    assert not after["valid"].to_numpy()[:9].any()
    # And the tenth, whose window clears it, is kept.
    assert bool(after["valid"].to_numpy()[9])
    assert seq.dropped["gapped_history"] >= 9

    # Every other fund is untouched: a gap is one fund's problem.
    others = rows.loc[(rows["asset"] != victim) & (rows["date"] > gap)]
    assert others["valid"].mean() > 0.99


def test_a_nan_inside_a_window_drops_it_rather_than_being_filled() -> None:
    labels, frame, _ = sequenced()
    holed = frame.copy()
    day = holed["date"].iloc[len(holed) // 2]
    victim = (holed["ticker"] == "BBB") & (holed["date"] == day)
    holed.loc[victim, "noise"] = np.nan

    seq = L.build_sequences(
        holed, labels.y.index, lookback=10, feature_columns=feature_names()
    )
    baseline = L.build_sequences(
        frame, labels.y.index, lookback=10, feature_columns=feature_names()
    )
    assert seq.n_valid == baseline.n_valid - int(victim.sum()) * 10
    assert seq.dropped["warming_up"] > baseline.dropped["warming_up"]


def test_positions_stay_aligned_with_the_labels_rather_than_compacting() -> None:
    """Invalid rows keep their place, which is what lets folds index them."""
    labels, _, seq = sequenced()
    assert seq.n_targets == labels.n
    assert seq.valid.size == labels.n
    assert seq.n_valid < seq.n_targets
    assert (
        seq.n_valid
        + sum(seq.dropped.values())
        == seq.n_targets
    )


def test_a_labelled_row_with_no_feature_row_is_refused_by_name() -> None:
    labels, frame, _ = sequenced()
    thinned = frame.loc[frame["ticker"] != "AAA"]
    with pytest.raises(L.LSTMError, match="have no feature row"):
        L.build_sequences(
            thinned, labels.y.index, lookback=10, feature_columns=feature_names()
        )


def test_an_all_nan_feature_column_is_named_rather_than_read_as_warmup() -> None:
    """The `bill_rate` trap: a hundred per cent drop rate, wrong reason."""
    labels, frame, _ = sequenced()
    frame = frame.assign(bill_rate=np.nan)
    with pytest.raises(L.LSTMError, match="bill_rate"):
        L.build_sequences(
            frame,
            labels.y.index,
            lookback=10,
            feature_columns=(*feature_names(), "bill_rate"),
        )


def test_a_duplicated_session_is_refused() -> None:
    labels, frame, _ = sequenced()
    doubled = pd.concat([frame, frame.iloc[[100]]], ignore_index=True)
    with pytest.raises(L.LSTMError, match="duplicate"):
        L.build_sequences(
            doubled, labels.y.index, lookback=10, feature_columns=feature_names()
        )


# -- capacity ------------------------------------------------------------


def test_the_parameter_count_is_the_number_the_docstring_shouts() -> None:
    """2,257 at the shipped defaults over seventeen features.

    Counted off the built module, and checked against the arithmetic by
    hand so that a change to either one has to be a deliberate change to
    both.
    """
    assert L.parameter_count(17) == 2257
    hidden, features_in = L.HIDDEN_SIZE, 17
    by_hand = 4 * (hidden * (features_in + hidden) + 2 * hidden) + hidden + 1
    assert by_hand == 2257


def test_capacity_says_it_loudly_when_parameters_outnumber_observations() -> None:
    labels = labelled(horizon=5)
    report = L.capacity(labels, n_features=3, config=L.LSTMConfig(hidden_size=64))
    assert report.parameters > report.label_effective_n
    assert report.memorisation_risk == "guaranteed"
    assert "OUTNUMBER" in report.note
    assert report.strict_observations_per_parameter < 1.0

    # The generous denominator is reported beside the strict one rather
    # than instead of it, because they disagree by a factor of several
    # and only one of them flatters.
    assert report.effective_observations > report.label_effective_n
    assert f"{labels.horizon}-session" in report.note


def test_dropout_is_applied_where_a_one_layer_lstm_would_ignore_it() -> None:
    """The invisible error: `nn.LSTM(dropout=…)` at one layer is a no-op.

    A model that believed it had regularised and had not would show
    exactly the divergence this project is looking for, from the wrong
    cause.
    """
    model = L._SequenceClassifier(3, hidden_size=4, num_layers=1, dropout=0.3)
    assert model.lstm.dropout == 0.0
    assert model.dropout.p == pytest.approx(0.3)

    stacked = L._SequenceClassifier(3, hidden_size=4, num_layers=2, dropout=0.3)
    assert stacked.lstm.dropout == pytest.approx(0.3)


# -- early stopping never touches the test fold --------------------------


def test_the_inner_slice_is_the_tail_of_training_and_never_the_test_fold() -> None:
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]
    config = tiny()

    train_rows = L._valid(fold.train_rows, seq)
    fit_rows, val_rows = L._inner_split(
        train_rows, labels=labels, plan=plan, config=config
    )

    assert set(fit_rows).isdisjoint(set(fold.test_rows))
    assert set(val_rows).isdisjoint(set(fold.test_rows))
    assert set(fit_rows).isdisjoint(set(val_rows))
    assert set(fit_rows) | set(val_rows) <= set(train_rows)

    dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))
    # In time, not at random. A random split would put AAA's Tuesday in
    # the fit set and BBB's Tuesday in the validation set, which under
    # a cross-sectional label hands over the answer.
    assert dates[fit_rows].max() < dates[val_rows].min()


def test_the_inner_split_purges_its_own_seam_and_keeps_the_row_before_it() -> None:
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]
    train_rows = L._valid(fold.train_rows, seq)
    fit_rows, val_rows = L._inner_split(
        train_rows, labels=labels, plan=plan, config=tiny()
    )

    dates = pd.DatetimeIndex(labels.y.index.get_level_values("date"))
    val_start = dates[val_rows].min()
    ends = plan.label_end.reindex(dates[fit_rows]).to_numpy()
    assert (ends < val_start.to_datetime64()).all()

    # And the purge did not simply eat the training set: the last kept
    # date is the one whose window closes just before the slice opens.
    kept_last = dates[fit_rows].max()
    assert plan.label_end.loc[kept_last] < val_start
    dropped = set(dates[train_rows]) - set(dates[fit_rows]) - set(dates[val_rows])
    assert dropped, "nothing was purged at the inner seam"
    assert min(dropped) > kept_last


def test_no_test_row_is_scored_until_the_fit_is_over(monkeypatch) -> None:
    """A spy on the prediction path, because the property is temporal.

    Asserting the row sets are disjoint says the split is right. It says
    nothing about an epoch loop that peeked, and peeking is exactly what
    turns a reported AUC into a maximum over forty draws.
    """
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]
    test_rows = set(L._valid(fold.test_rows, seq).tolist())

    calls: list[set[int]] = []
    real = L._predict

    def spy(model, sequences, scaler, rows, config, device):
        calls.append(set(np.asarray(rows).tolist()))
        return real(model, sequences, scaler, rows, config, device)

    monkeypatch.setattr(L, "_predict", spy)
    L.fit_fold(fold, sequences=seq, labels=labels, plan=plan, config=tiny())

    assert calls, "nothing was predicted at all"
    # Exactly one call per ensemble member touches the test rows, and it
    # is the last one that member makes.
    touching = [i for i, c in enumerate(calls) if c & test_rows]
    assert touching == [len(calls) - 1]
    assert calls[-1] == test_rows


# -- shuffled in training, never in evaluation ---------------------------


def test_training_batches_are_permuted_and_evaluation_batches_are_not(
    monkeypatch,
) -> None:
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]

    seen: list[np.ndarray] = []
    real = L._tensor

    def spy(sequences, scaler, rows, device):
        seen.append(np.asarray(rows).copy())
        return real(sequences, scaler, rows, device)

    monkeypatch.setattr(L, "_tensor", spy)
    config = tiny(max_epochs=1, patience=1)
    L.fit_fold(fold, sequences=seq, labels=labels, plan=plan, config=config)

    train_rows = L._valid(fold.train_rows, seq)
    fit_rows, _ = L._inner_split(train_rows, labels=labels, plan=plan, config=config)

    # The training pass: batches that together cover the fit rows.
    n_batches = int(np.ceil(fit_rows.size / config.batch_size))
    training = np.concatenate(seen[:n_batches])
    assert sorted(training.tolist()) == sorted(fit_rows.tolist())
    assert not np.array_equal(training, fit_rows), "training was not shuffled"

    # Evaluation: every later call arrives in ascending row order, which
    # for a date-sorted label frame is time order.
    for batch in seen[n_batches:]:
        assert (np.diff(batch) > 0).all()


# -- determinism ---------------------------------------------------------


def test_one_seed_twice_is_the_same_run() -> None:
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]
    config = tiny()

    a = L.fit_fold(fold, sequences=seq, labels=labels, plan=plan, config=config)
    b = L.fit_fold(fold, sequences=seq, labels=labels, plan=plan, config=config)

    assert np.array_equal(a.predictions.to_numpy(), b.predictions.to_numpy())
    assert a.test_auc == b.test_auc
    pd.testing.assert_frame_equal(a.trajectory, b.trajectory)


def test_a_different_seed_is_a_different_fit() -> None:
    """Otherwise the ensemble's spread is an artefact of nothing."""
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]

    a = L.fit_fold(fold, sequences=seq, labels=labels, plan=plan, config=tiny(seed=0))
    b = L.fit_fold(fold, sequences=seq, labels=labels, plan=plan, config=tiny(seed=99))
    assert not np.array_equal(a.predictions.to_numpy(), b.predictions.to_numpy())


# -- the device ----------------------------------------------------------


def test_an_unreachable_device_is_a_refusal_rather_than_a_quiet_fallback(
    monkeypatch,
) -> None:
    """A silent fallback is an hour of wondering why the run is slow."""
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    with pytest.raises(L.LSTMError, match="device='mps'"):
        L.resolve_device("mps")
    assert L.resolve_device("auto") == torch.device("cpu")
    assert L.resolve_device("cpu") == torch.device("cpu")
    with pytest.raises(L.LSTMError, match="unknown device"):
        L.resolve_device("cuda")


def test_the_device_is_not_part_of_a_trial_s_identity() -> None:
    """MPS and CPU differ in the last bits of a float and in no finding.

    Hashing the device would file one experiment twice for having been
    run on two machines, which inflates the denominator every deflated
    Sharpe in this repository is divided by.
    """
    assert "device" not in L.LSTMConfig(device="cpu").config()
    assert L.LSTMConfig(device="cpu").config() == L.LSTMConfig(device="auto").config()


# -- uncertainty ---------------------------------------------------------


def test_mc_dropout_without_dropout_is_refused() -> None:
    """Zero spread reads as certainty rather than as a switch left off."""
    with pytest.raises(L.LSTMError, match="MC dropout"):
        L.LSTMConfig(dropout=0.0, mc_dropout_samples=10)


def test_the_ensemble_reports_a_spread_and_mc_dropout_a_second_one() -> None:
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]

    result = L.fit_fold(
        fold,
        sequences=seq,
        labels=labels,
        plan=plan,
        config=tiny(n_seeds=2, mc_dropout_samples=4),
    )
    assert result.ensemble_spread.gt(0.0).any()
    assert result.mc_spread is not None
    assert result.mc_spread.gt(0.0).any()
    assert result.ensemble_spread.index.equals(result.predictions.index)

    alone = L.fit_fold(fold, sequences=seq, labels=labels, plan=plan, config=tiny())
    assert alone.mc_spread is None
    assert (alone.ensemble_spread.to_numpy() == 0.0).all()


# -- the reporting contract ----------------------------------------------


def test_the_accuracy_cannot_be_read_without_its_base_rate() -> None:
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    result = L.fit_fold(
        plan[1], sequences=seq, labels=labels, plan=plan, config=tiny()
    )
    row = result.accuracy_row()

    assert {"base_rate", "majority_accuracy", "accuracy", "edge", "auc"} <= set(
        row.columns
    )
    assert int(row["n"].iloc[0]) == result.n_test
    assert row["base_rate"].iloc[0] == pytest.approx(result.test_base_rate)
    assert row["accuracy"].iloc[0] == pytest.approx(result.test_accuracy)
    assert "constant baseline" in row["verdict"].iloc[0] or "at or below" in row[
        "verdict"
    ].iloc[0]


def test_the_auc_is_reported_against_the_fund_identity_baseline() -> None:
    """A panel where identity IS the answer, so the baseline must see it.

    Three funds drift up and three drift down for twenty years. Nothing
    about timing is learnable, and a lookup table of per-fund base rates
    scores near a perfect one.
    """
    panel = prices(drift=(0.004, 0.004, 0.004, -0.004, -0.004, -0.004))
    labels = build_labels(panel, horizon=5)
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]

    identity = L.identity_baseline_auc(labels, fold.train_rows, fold.test_rows)
    # Not 1.0, and it should not be: the score is a lookup table of six
    # numbers, so every pair of funds on the same side of the drift is a
    # tie and contributes a half. What it must do is see the structure,
    # and 0.87 out of a possible 0.5 baseline is seeing it.
    assert identity > 0.85

    # And on a panel with no such structure it says so.
    flat = labelled()
    flat_plan = purged_folds(flat, n_splits=4)
    flat_identity = L.identity_baseline_auc(
        flat, flat_plan[1].train_rows, flat_plan[1].test_rows
    )
    assert abs(flat_identity - 0.5) < 0.1


def test_a_fold_carries_the_identity_baseline_beside_its_own_auc() -> None:
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    result = L.fit_fold(
        plan[1], sequences=seq, labels=labels, plan=plan, config=tiny()
    )
    described = result.describe()
    assert "identity_auc" in described.columns
    assert described["auc_over_identity"].iloc[0] == pytest.approx(
        result.test_auc - result.identity_auc
    )


def test_a_single_class_fold_scores_nan_rather_than_a_plausible_half() -> None:
    """0.5 is the number this project expects to find honestly.

    Handing it back for "there was nothing to score" is the worst
    available way to be wrong.
    """
    assert np.isnan(L._auc(np.zeros(50), np.random.default_rng(0).random(50)))
    assert np.isnan(L._auc(np.array([]), np.array([])))
    assert L._auc(np.array([0.0, 1.0]), np.array([0.1, 0.9])) == 1.0


def test_the_trajectory_carries_every_epoch_of_every_seed() -> None:
    """The finding is the shape of the two curves, not their mean."""
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    result = L.fit_fold(
        plan[1],
        sequences=seq,
        labels=labels,
        plan=plan,
        config=tiny(n_seeds=2, max_epochs=3, patience=3),
    )
    traj = result.trajectory
    assert set(traj.columns) >= {
        "epoch",
        "train_auc",
        "val_auc",
        "train_loss",
        "val_loss",
        "seed",
        "fold",
    }
    assert len(traj) == sum(result.epochs_run)
    assert traj["seed"].nunique() == 2
    for _, block in traj.groupby("seed"):
        assert block["epoch"].tolist() == list(range(1, len(block) + 1))


def test_the_rank_ic_t_is_deflated_by_the_overlap_it_was_measured_over() -> None:
    rng = np.random.default_rng(3)
    dates = pd.bdate_range("2015-01-01", periods=200)
    index = pd.MultiIndex.from_product([dates, list(ASSETS)], names=["date", "asset"])
    forward = pd.Series(rng.normal(size=len(index)), index=index)
    scores = forward + rng.normal(scale=0.5, size=len(index))

    ic = L.rank_information_coefficient(scores, forward, horizon=21)
    assert ic.mean > 0.5
    assert ic.n_dates == len(dates)
    assert ic.t_adjusted == pytest.approx(ic.t_naive / np.sqrt(21))
    assert "still generous" in ic.note


def test_the_rank_ic_refuses_rows_that_are_not_the_same_observations() -> None:
    labels, _, _ = sequenced()
    with pytest.raises(L.LSTMError, match="different rows"):
        L.rank_information_coefficient(
            labels.y.astype("float64"),
            labels.forward_return.iloc[::-1],
            horizon=5,
        )


# -- the ledger ----------------------------------------------------------


def test_the_configuration_is_logged_before_a_single_fold_is_fitted(
    tmp_path, monkeypatch
) -> None:
    """A trial that only counts when it finishes does not count.

    The disappointing runs are the whole point of a denominator.
    """
    labels, frame, _ = sequenced()
    plan = purged_folds(labels, n_splits=4)
    trials = Trials(
        path=tmp_path / "trials.jsonl",
        when=datetime(2026, 8, 2, tzinfo=timezone.utc),
    )

    def explode(*args, **kwargs):
        raise RuntimeError("the fit fell over")

    monkeypatch.setattr(L, "fit_fold", explode)
    with pytest.raises(RuntimeError, match="fell over"):
        L.run_lstm(
            frame,
            labels,
            plan,
            config=tiny(),
            feature_columns=feature_names(),
            trials=trials,
        )
    assert trials.total == 1
    assert trials.distinct == 1


def test_two_widths_are_two_trials_and_the_same_width_is_one() -> None:
    labels, _, _ = sequenced()
    plan = purged_folds(labels, n_splits=4)

    def key(config):
        return TrialCounter.hash_config({**plan.config(), "model": config.config()})

    assert key(tiny()) == key(tiny())
    assert key(tiny()) != key(tiny(hidden_size=8))
    assert key(tiny()) != key(tiny(lookback=20))
    assert key(tiny()) != key(tiny(seed=1))


def test_a_plan_built_from_other_labels_is_refused() -> None:
    """Its folds index that panel's rows, not this one's."""
    labels, frame, _ = sequenced()
    other = labelled(prices(seed=7))
    plan = purged_folds(other, n_splits=4)
    with pytest.raises(L.LSTMError, match="different LabelSet"):
        L.run_lstm(
            frame, labels, plan, config=tiny(), feature_columns=feature_names()
        )


# -- the whole run -------------------------------------------------------


def test_a_run_reports_every_fold_and_prints_the_capacity_above_the_score(
    tmp_path,
) -> None:
    labels, frame, _ = sequenced()
    plan = walk_forward_folds(labels, refit_frequency=1, min_train_years=1)
    trials = Trials(
        path=tmp_path / "trials.jsonl",
        when=datetime(2026, 8, 2, tzinfo=timezone.utc),
    )

    report = L.run_lstm(
        frame,
        labels,
        plan,
        config=tiny(),
        feature_columns=feature_names(),
        trials=trials,
        description="LSTM smoke",
    )
    described = report.describe()
    assert len(described) == len(plan)
    assert described["test_base_rate"].between(0.3, 0.7).all()
    assert (described["n_test"] > 0).all()

    summary = report.summary()
    assert "parameters" in summary
    assert "base rate" in summary
    assert "lookup table" in summary
    assert str(report.capacity.parameters) in summary.replace(",", "")

    # The trajectory survives the trip through the report.
    assert set(report.trajectory()["fold"]) == {f.fold for f in plan}
    assert trials.total == 1


def test_a_fold_whose_windows_all_fail_is_a_refusal_not_a_score() -> None:
    """A model scored on the rows that happened to survive is a model
    scored on a universe nobody chose."""
    labels, frame, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    blanked = L.SequenceIndex(
        feature_names=seq.feature_names,
        lookback=seq.lookback,
        values=seq.values,
        source_dates=seq.source_dates,
        source_assets=seq.source_assets,
        gather=seq.gather,
        valid=np.zeros_like(seq.valid),
        target_dates=seq.target_dates,
        target_assets=seq.target_assets,
        dropped=seq.dropped,
    )
    with pytest.raises(L.LSTMError, match="no complete window survives"):
        L.fit_fold(
            plan[1], sequences=blanked, labels=labels, plan=plan, config=tiny()
        )


def test_an_inner_split_too_thin_to_choose_an_epoch_on_is_refused() -> None:
    """The alternative is stopping on the test fold, which spends the
    out-of-sample this whole scheme exists to protect."""
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    with pytest.raises(L.LSTMError, match="under the floor"):
        L._inner_split(
            L._valid(plan[1].train_rows, seq)[:50],
            labels=labels,
            plan=plan,
            config=tiny(),
        )


def test_a_lookback_of_one_is_not_a_sequence() -> None:
    labels, frame, _ = sequenced()
    with pytest.raises(L.LSTMError, match="not a sequence"):
        L.build_sequences(
            frame, labels.y.index, lookback=1, feature_columns=feature_names()
        )
    with pytest.raises(L.LSTMError):
        L.LSTMConfig(lookback=1)


def test_labels_and_features_must_be_the_same_rows_in_the_same_order() -> None:
    """Positional slicing across a reordering fits on scrambled targets,
    and the AUC it produces is 0.5 — the answer we expect to find
    honestly, which is why it has to raise."""
    labels, frame, _ = sequenced()
    with pytest.raises(L.LSTMError, match="MultiIndex"):
        L.build_sequences(
            frame,
            pd.Index(labels.y.index.get_level_values("date")),
            lookback=10,
            feature_columns=feature_names(),
        )


def test_the_scaler_is_fit_on_training_rows_only() -> None:
    """Standardising on the whole panel is the smallest possible leak and
    the hardest to see: it moves every number by a fraction of a sigma
    and changes no shape."""
    labels, _, seq = sequenced()
    plan = purged_folds(labels, n_splits=4)
    fold = plan[1]
    train_rows = L._valid(fold.train_rows, seq)
    fit_rows, _ = L._inner_split(train_rows, labels=labels, plan=plan, config=tiny())

    scaler = L._Scaler.fit(seq, fit_rows, clip=5.0)
    everything = L._Scaler.fit(seq, np.flatnonzero(seq.valid), clip=5.0)
    assert not np.allclose(scaler.mean, everything.mean)

    touched = np.unique(seq.gather[fit_rows])
    latest = seq.source_dates[touched].max()
    assert latest <= pd.DatetimeIndex(labels.y.index.get_level_values("date"))[
        fit_rows
    ].max().to_datetime64()


def test_a_feature_that_never_moved_does_not_divide_by_zero() -> None:
    labels, frame, _ = sequenced()
    frozen = frame.assign(noise=1.0)
    seq = L.build_sequences(
        frozen, labels.y.index, lookback=10, feature_columns=feature_names()
    )
    scaler = L._Scaler.fit(seq, np.flatnonzero(seq.valid), clip=5.0)
    block = seq.values[seq.gather[np.flatnonzero(seq.valid)[:16]]]
    assert np.isfinite(scaler.transform(block)).all()


def test_standardised_features_are_clipped_rather_than_propagated() -> None:
    """Sixty recurrent steps is sixty chances to build a state out of one
    outlier."""
    labels, frame, _ = sequenced()
    spiked = frame.copy()
    spiked.loc[spiked.index[len(spiked) // 2], "noise"] = 1e6
    seq = L.build_sequences(
        spiked, labels.y.index, lookback=10, feature_columns=feature_names()
    )
    rows = np.flatnonzero(seq.valid)
    scaler = L._Scaler.fit(seq, rows, clip=L.CLIP_SIGMA)
    block = seq.values[seq.gather[rows]]
    out = scaler.transform(block)
    assert np.abs(out).max() <= L.CLIP_SIGMA + 1e-6
