"""FrameSpec is the only place a bad frame can still be stopped cheaply.

Everything downstream of `validate` treats its input as true, so the
tests here are less about the happy path than about the three ways a
frame gets past a boundary check while being wrong: a column that is
absent, a column of the wrong type, and a primary key that repeats. The
third is the quiet one. A duplicated (permaticker, date) breaks nothing
visibly — every groupby below it simply counts one security-day twice,
and the first symptom is a weight vector that does not sum to one, four
layers away from the cause.

The dtype-family tests exist because pandas 3 spells the same thing
several ways depending on how a frame was built. `pd.Series([...])` of
python strings is `str`, an arrow-backed one is `string`, an older
pickle is `object`, and a datetime built from Timestamps is
`datetime64[us]` where one built from a numpy array is
`datetime64[ns]`. A validator that insisted on the literal spelling in
the spec would reject correct frames constructed the ordinary way, and
the fix somebody would reach for is loosening the check entirely.
"""

from __future__ import annotations

import pandas as pd
import pytest

from griffinquant.data import schema
from griffinquant.data.schema import FrameSpec, SchemaError


TOY = FrameSpec(
    name="toy",
    required={"permaticker": "int64", "ticker": "str", "date": "datetime64[ns]"},
    optional={"value": "float64"},
    primary_key=("permaticker", "date"),
)


def _toy(rows: int = 2, **overrides: object) -> pd.DataFrame:
    base = {
        "permaticker": pd.Series(range(rows), dtype="int64"),
        "ticker": pd.Series([f"T{i}" for i in range(rows)], dtype="str"),
        "date": pd.Series(
            pd.date_range("2020-01-02", periods=rows, freq="D"),
            dtype="datetime64[ns]",
        ),
    }
    base.update(overrides)
    return pd.DataFrame(base)


# -- the three ways a bad frame gets through -----------------------------


def test_missing_required_column_is_refused_and_names_what_it_wanted():
    df = _toy().drop(columns=["ticker"])
    with pytest.raises(SchemaError) as exc:
        TOY.validate(df, source="vendor")
    message = str(exc.value)
    assert "vendor.toy" in message
    assert "ticker" in message
    # The got-list matters as much as the want-list: half these failures
    # are a vendor renaming a column, and the answer is in the diff.
    assert "permaticker" in message


def test_missing_optional_column_is_fine():
    TOY.validate(_toy(), source="vendor")


def test_wrong_dtype_is_refused_even_on_an_optional_column():
    # An optional column that arrives with the wrong type is worse than
    # one that never arrives: it populates, it validates by name, and it
    # silently changes the arithmetic of anything that reads it.
    df = _toy().assign(value=pd.Series(["1.0", "2.0"], dtype="str"))
    with pytest.raises(SchemaError) as exc:
        TOY.validate(df)
    assert "value" in str(exc.value)
    assert "want float64" in str(exc.value)


def test_wrong_dtype_on_a_required_column_is_refused():
    df = _toy().assign(permaticker=pd.Series(["1", "2"], dtype="str"))
    with pytest.raises(SchemaError) as exc:
        TOY.validate(df)
    assert "permaticker" in str(exc.value)


def test_duplicate_primary_key_is_refused_and_counted():
    df = pd.concat([_toy(1), _toy(1)], ignore_index=True)
    with pytest.raises(SchemaError) as exc:
        TOY.validate(df)
    assert "duplicate" in str(exc.value)
    assert "('permaticker', 'date')" in str(exc.value)


def test_duplicate_on_only_part_of_the_key_is_allowed():
    # Two bars for one entity on different days is the normal case, and
    # a key check that fired on it would be unusable.
    df = _toy(2).assign(permaticker=pd.Series([7, 7], dtype="int64"))
    TOY.validate(df)


def test_primary_key_is_not_checked_when_a_key_column_is_absent():
    # ACTIONS declares no key at all and several frames carry optional
    # ids, so the guard has to be "check what is here" rather than
    # "raise on what is missing" — the missing-column error above is the
    # one that owns that failure.
    spec = FrameSpec(
        name="partial",
        required={"a": "int64"},
        optional={"b": "int64"},
        primary_key=("a", "b"),
    )
    spec.validate(pd.DataFrame({"a": pd.Series([1, 1], dtype="int64")}))


def test_a_non_frame_is_refused_before_anything_else():
    with pytest.raises(SchemaError) as exc:
        TOY.validate({"permaticker": [1]}, source="vendor")
    assert "expected DataFrame" in str(exc.value)


# -- the no-rows path ----------------------------------------------------


@pytest.mark.parametrize("name", sorted(schema.ALL_SPECS))
def test_empty_round_trips_through_its_own_validator(name: str):
    # The point of `empty()` is that a source hitting a genuinely empty
    # range can return it without hand-building a frame that then fails
    # on dtype. If this ever breaks, every adapter's no-rows branch does.
    spec = schema.ALL_SPECS[name]
    frame = spec.empty()
    assert len(frame) == 0
    assert list(frame.columns) == list({**spec.required, **spec.optional})
    assert spec.validate(frame, source="empty") is frame


def test_empty_carries_the_optional_columns_too():
    frame = TOY.empty()
    assert "value" in frame.columns
    assert str(frame["value"].dtype) == "float64"


# -- dtype families ------------------------------------------------------


@pytest.mark.parametrize("spelling", ["str", "string", "object"])
def test_string_spellings_are_interchangeable(spelling: str):
    df = _toy().assign(ticker=pd.Series(["A", "B"], dtype=spelling))
    TOY.validate(df)


@pytest.mark.parametrize("unit", ["ns", "us", "ms", "s"])
def test_datetime_resolutions_are_interchangeable(unit: str):
    # A frame built from Timestamps comes back as datetime64[us] in
    # pandas 3 while one built from a numpy array is [ns]. Both are the
    # same instant and neither is worth a boundary failure.
    df = _toy().assign(date=_toy()["date"].astype(f"datetime64[{unit}]"))
    TOY.validate(df)


@pytest.mark.parametrize(
    ("dtype", "want"),
    [("bool", "bool"), ("boolean", "bool"), ("int64", "int64"), ("Int64", "int64"),
     ("float64", "float64"), ("Float64", "float64")],
)
def test_nullable_and_numpy_spellings_are_interchangeable(dtype: str, want: str):
    spec = FrameSpec(name="one", required={"x": want})
    spec.validate(pd.DataFrame({"x": pd.Series([1], dtype=dtype)}))


def test_families_do_not_leak_into_each_other():
    # The equivalences are generous on purpose; they must not become a
    # licence for an int column to stand in for a float one, which is
    # where a silently truncated price would come from.
    spec = FrameSpec(name="one", required={"x": "float64"})
    with pytest.raises(SchemaError):
        spec.validate(pd.DataFrame({"x": pd.Series([1], dtype="int64")}))


# -- the real specs ------------------------------------------------------


def test_prices_rejects_two_bars_for_one_security_day():
    row = {
        "permaticker": pd.Series([9_000_001], dtype="int64"),
        "ticker": pd.Series(["AAA"], dtype="str"),
        "date": pd.Series([pd.Timestamp("2010-06-01")], dtype="datetime64[ns]"),
        **{
            c: pd.Series([1.0], dtype="float64")
            for c in (
                "open_unadj",
                "high_unadj",
                "low_unadj",
                "close_unadj",
                "volume_unadj",
                "close_adj",
            )
        },
    }
    one = pd.DataFrame(row)
    schema.PRICES.validate(one)
    with pytest.raises(SchemaError):
        schema.PRICES.validate(pd.concat([one, one], ignore_index=True))


def test_actions_has_no_primary_key_so_repeats_are_legal():
    # A company can genuinely file two actions on one day, and the frame
    # carries no id strong enough to key on anyway.
    assert schema.ACTIONS.primary_key == ()
    row = pd.DataFrame(
        {
            "date": pd.Series([pd.Timestamp("2008-09-25")] * 2, dtype="datetime64[ns]"),
            "action": pd.Series(["delisted", "split"], dtype="str"),
            "ticker": pd.Series(["WM", "WM"], dtype="str"),
        }
    )
    schema.ACTIONS.validate(row)


def test_fundamentals_keys_on_the_publication_date_not_the_period():
    # Keying on period_end would collapse a delinquent filer's catch-up
    # into one row and lose the day the market actually learned it.
    assert schema.FUNDAMENTALS.primary_key == (
        "permaticker",
        "dimension",
        "date_public",
    )


def test_every_spec_names_a_dtype_pandas_can_actually_build():
    # A typo in a spec's dtype string does not fail here — it fails in
    # `empty()`, on the no-rows path, months later, in whichever adapter
    # first hits a quiet range.
    for spec in schema.ALL_SPECS.values():
        for column, dtype in {**spec.required, **spec.optional}.items():
            built = pd.Series([], dtype=dtype)
            assert schema._dtype_ok(str(built.dtype), dtype), f"{spec.name}.{column}"
