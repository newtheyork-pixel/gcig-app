"""The fixture list, which is the one thing in the audit that can be
wrong in a way the audit itself cannot detect.

Every other check compares the data against itself. `decedent_trace`
compares it against these rows, so a mistyped date here does not
produce a wrong number — it produces a FAIL against a dataset that was
telling the truth, and the natural response to that is to widen a
tolerance until the fixture goes quiet. Once that happens the file has
stopped testing anything and still prints green.

So the assertions are about the fixture's own discipline rather than
about any panel: every row cites a primary source, every tolerance is
sized for the genuine ambiguity in an exchange date rather than for the
OTC tail, every death falls inside the sample, and a ticker appearing
twice has to be explained by the recycling the file is built around
instead of by a copy-paste.
"""

from __future__ import annotations

from datetime import date

import pytest

from griffinquant import config
from griffinquant.audit.decedents import (
    BY_TICKER,
    DECEDENTS,
    INDEX_EVENTS,
    RECYCLED_TICKERS,
    Decedent,
)
from griffinquant.audit.survivorship import _DEFAULT_TOLERANCE_DAYS


#: The vocabulary the file documents. `reason` is not decorative — an
#: acquisition and a bankruptcy are opposite returns into the same
#: terminating price series, and a panel that records the date but not
#: the reason cannot tell them apart.
REASONS = frozenset(
    {
        "bankruptcy",
        "acquisition",
        "merger",
        "seizure",
        "going_private",
        "liquidation",
        "regulatory_delisting",
    }
)

SAMPLE_START = date.fromisoformat(config.SAMPLE_START)

IDS = [d.ticker for d in DECEDENTS]


def test_the_list_is_not_empty():
    # An empty fixture list passes every row-wise test below trivially,
    # which is the failure mode the trace check reports as UNPROVABLE
    # rather than as a pass. Same reasoning applies here.
    assert len(DECEDENTS) >= 10


@pytest.mark.parametrize("d", DECEDENTS, ids=IDS)
def test_every_row_cites_something_a_reader_can_open(d: Decedent):
    parts = [p.strip() for p in d.source.split(";")]
    assert parts and all(parts)
    for part in parts:
        assert part.startswith("http"), f"{d.ticker}: {part!r}"
    # A row whose symbol was reused needs the successor's start date
    # backed as well, because that date is what makes the two tenancies
    # non-overlapping rather than a matter of assertion.
    if d.successor_ticker is not None:
        assert len(parts) == 2, f"{d.ticker} cites {len(parts)} source(s)"


@pytest.mark.parametrize("d", DECEDENTS, ids=IDS)
def test_every_row_says_why_it_died_in_the_documented_vocabulary(d: Decedent):
    assert d.reason in REASONS, f"{d.ticker}: {d.reason!r}"


@pytest.mark.parametrize("d", DECEDENTS, ids=IDS)
def test_every_row_carries_a_name_and_a_note_worth_reading(d: Decedent):
    assert d.name.strip()
    # The note is where the trap lives — which session was the last one,
    # what the OTC tail did, who took the symbol afterwards. A row
    # without one is a date nobody can argue with.
    assert len(d.note.strip()) > 40, d.ticker


@pytest.mark.parametrize("d", DECEDENTS, ids=IDS)
def test_the_tolerance_is_sized_for_an_exchange_date_not_an_otc_tail(d: Decedent):
    # Zero would demand the panel agree to the session, which no two
    # vendors do. Anything past a fortnight stops being a disagreement
    # about the last print and starts excusing a series that ran on for
    # weeks after the exchange threw the name out.
    assert 1 <= d.tolerance_days <= _DEFAULT_TOLERANCE_DAYS, d.ticker


@pytest.mark.parametrize("d", DECEDENTS, ids=IDS)
def test_every_death_falls_inside_the_sample_and_in_the_past(d: Decedent):
    # The lower bound is the sample start, because a fixture the audit
    # can never reach is a row that always reports as skipped. The upper
    # bound is the only place a clock belongs in this repository: it
    # asserts a property of the date rather than generating one, and a
    # death dated in the future is a typo however it got there.
    assert SAMPLE_START <= d.last_trade_on_or_about, d.ticker
    assert d.last_trade_on_or_about <= date.today(), d.ticker


def test_the_list_reads_in_chronological_order():
    # Reading them in order is reading the crisis, and an out-of-order
    # insertion is usually a row somebody pasted rather than researched.
    dates = [d.last_trade_on_or_about for d in DECEDENTS]
    assert dates == sorted(dates)


# -- the recycled symbols ------------------------------------------------


def test_no_ticker_appears_twice_unless_a_reuse_explains_it():
    seen: dict[str, list[Decedent]] = {}
    for d in DECEDENTS:
        seen.setdefault(d.ticker, []).append(d)
    for ticker, rows in seen.items():
        if len(rows) == 1:
            continue
        # A symbol may legitimately kill two companies — GM did — but
        # then every row but the last has to name the reuse, or the
        # duplicate is a copy-paste rather than a tenancy.
        assert all(r.successor_ticker == ticker for r in rows[:-1]), ticker
        starts = [r.last_trade_on_or_about for r in rows]
        assert starts == sorted(starts), ticker


def test_by_ticker_does_not_silently_lose_a_row():
    # It is a dict comprehension over the tuple, so a duplicated ticker
    # collapses without a word and the lost row simply stops being
    # tested.
    assert len(BY_TICKER) == len(DECEDENTS)
    assert set(BY_TICKER) == set(IDS)


def test_a_recycled_row_names_its_own_symbol_as_the_successor():
    # The obvious filter — comparing successor_ticker to ticker — is
    # wrong precisely because the two are the same string, which is what
    # makes a symbol-keyed join splice the two companies together.
    for d in DECEDENTS:
        if d.successor_ticker is None:
            continue
        assert d.successor_ticker == d.ticker


def test_recycled_tickers_is_the_set_it_claims_to_be():
    assert RECYCLED_TICKERS == tuple(
        d.ticker for d in DECEDENTS if d.successor_ticker is not None
    )
    assert len(RECYCLED_TICKERS) >= 4
    assert set(RECYCLED_TICKERS) <= set(IDS)


# -- the tolerance window ------------------------------------------------


@pytest.mark.parametrize("d", DECEDENTS, ids=IDS)
def test_the_window_is_symmetric_and_accepts_its_own_date(d: Decedent):
    assert d.earliest < d.last_trade_on_or_about < d.latest
    assert d.accepts(d.last_trade_on_or_about)
    assert d.accepts(d.earliest)
    assert d.accepts(d.latest)


def test_the_window_is_closed_at_both_ends():
    from datetime import timedelta

    d = DECEDENTS[0]
    assert not d.accepts(d.earliest - timedelta(days=1))
    assert not d.accepts(d.latest + timedelta(days=1))


def test_no_two_windows_overlap_on_the_same_symbol():
    # Two tenancies of one symbol whose acceptance windows touch would
    # let the trace check resolve either row to either entity.
    by_symbol: dict[str, list[Decedent]] = {}
    for d in DECEDENTS:
        by_symbol.setdefault(d.ticker, []).append(d)
    for rows in by_symbol.values():
        rows = sorted(rows, key=lambda r: r.last_trade_on_or_about)
        for earlier, later in zip(rows, rows[1:]):
            assert earlier.latest < later.earliest


# -- the index events ----------------------------------------------------


def test_index_events_exist_only_to_state_what_cannot_be_asked():
    # Nothing in this project's design needs index membership — the
    # universe is computed from tradability — so these are here to give
    # an UNPROVABLE verdict a concrete unanswered question rather than a
    # shrug about missing metadata.
    assert len(INDEX_EVENTS) >= 3
    for e in INDEX_EVENTS:
        assert e.action in {"added", "removed"}
        assert e.source.startswith("http")
        # The gap between announcement and effect is the whole reason
        # "as of" is the only honest way to ask about membership.
        assert e.announced < e.effective
        assert SAMPLE_START <= e.effective <= date.today()
