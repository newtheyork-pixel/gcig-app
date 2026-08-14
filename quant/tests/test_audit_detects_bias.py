"""Proof that the audit can fail, and proof that it does not fail on
everything.

An audit that has only ever printed PASS is indistinguishable from a
broken one, so the synthetic panel exists to put exactly one nameable
defect into an otherwise honest fixture and watch a specific check go
red. That is the first half of what is tested here, and it is the half
people expect.

The second half matters as much and is easier to skip. A check that
fires on everything carries no information: if deleting the graveyard
also reddens the filing-lag distribution and the calendar alignment,
the report has stopped naming causes and started registering that
something, somewhere, is wrong. So every bias is also tested for what
it does NOT move, and the control panel is tested for moving nothing at
all — no FAIL anywhere, and no blocking check quietly declining to sit
the test.

Two facts about this file are load-bearing.

The date range is fixed and the seed is fixed, so a red run means the
code changed. `conftest.py` widens the calendar's default bounds for
the same reason: without that, the window would drift with the machine
clock and the early years of a good fixture would be reported as
fabricated sessions.

And the contract being asserted is `synthetic.EXPECTED_TRIPS`, read as
a value rather than transcribed from its docstring. A check renamed on
one side and not the other then breaks the harness loudly instead of
quietly certifying a panel it can no longer read.
"""

from __future__ import annotations

from datetime import date

import pytest

from griffinquant.audit import pointintime, quality, survivorship
from griffinquant.audit.context import load_context
from griffinquant.audit.result import AuditReport, CheckResult, Verdict
from griffinquant.data.synthetic import EXPECTED_TRIPS, Bias, SyntheticSource


#: Twelve years, which is what the audit's most diagnostic instruments
#: need before they will speak: the entity-count curve reads a trend
#: across years, and the attrition median wants a denominator of names
#: that were already trading when each year opened. The window contains
#: the 2008-09 wave and eleven of the named decedents, and eight full
#: audits over it still run in a few seconds.
AUDIT_START = date(2008, 1, 1)
AUDIT_END = date(2019, 12, 31)

CHECK_MODULES = (survivorship, pointintime, quality)

#: Checks a bias is permitted to redden, beyond the ones it must.
#:
#: Deleting every dead company is supposed to break several survivorship
#: instruments at once — that is four instruments agreeing, not four
#: bugs. `universe_count_by_year` is the one that is allowed but not
#: promised: the count curve has to grow 40% before it will call a panel
#: backfilled, so it fails on a decade and only warns on an eight-year
#: window. Promising it in EXPECTED_TRIPS would buy a flaky test in
#: exchange for hiding a true and slightly uncomfortable fact about the
#: audit.
ALSO_ALLOWED: dict[Bias, frozenset[str]] = {
    Bias.SURVIVORSHIP: frozenset({"survivorship.universe_count_by_year"}),
}


def _audit(bias: Bias) -> AuditReport:
    source = SyntheticSource(AUDIT_START, AUDIT_END, bias=bias)
    ctx = load_context(source, AUDIT_START, AUDIT_END)
    report = AuditReport(source_label=source.label)
    for module in CHECK_MODULES:
        for check in module.CHECKS:
            # Deliberately not swallowed the way the CLI does. Here a
            # check that raises is a defect in the audit and must stop
            # the suite, not turn into an UNPROVABLE somebody reads as a
            # statement about the panel.
            report.add(check(ctx))
    return report


_MEMO: dict[Bias, AuditReport] = {}


def audit(bias: Bias) -> AuditReport:
    """One full audit per bias, built once and shared.

    The panels are deterministic, so rebuilding one for every assertion
    would only make the suite slower at saying the same thing.
    """
    if bias not in _MEMO:
        _MEMO[bias] = _audit(bias)
    return _MEMO[bias]


def failing(report: AuditReport) -> set[str]:
    return {c.key for c in report.checks if c.verdict is Verdict.FAIL}


def by_key(report: AuditReport, key: str) -> CheckResult:
    for c in report.checks:
        if c.key == key:
            return c
    ran = sorted(c.key for c in report.checks)
    raise AssertionError(f"no check named {key!r} ran; keys were {ran}")


TREATMENTS = [b for b in Bias if b is not Bias.NONE]
IDS = [b.name for b in TREATMENTS]


# -- the control ---------------------------------------------------------


def test_the_honest_panel_produces_no_failures():
    report = audit(Bias.NONE)
    assert failing(report) == set()
    assert report.verdict is Verdict.PASS
    assert report.usable_for_research


def test_every_blocking_check_on_the_control_actually_ran():
    # A panel that passes because eleven checks declined to sit the test
    # is not a demonstration of anything, and UNPROVABLE is exactly the
    # verdict that would hide it — it never rolls up to a pass, but it
    # also never names a defect.
    report = audit(Bias.NONE)
    declined = [
        c.key
        for c in report.checks
        if c.blocking and c.verdict in (Verdict.UNPROVABLE, Verdict.SKIPPED)
    ]
    assert declined == []


def test_the_screen_leak_stands_at_warn_on_the_control_and_does_not_block():
    # Not a defect and not a regression. It measures how much of the
    # future a price floor read off back-adjusted closes would import,
    # and a non-zero answer is the correct one — this panel contains
    # reverse splits. A harness reporting zero here would mean the
    # reverse splits had gone missing, which is a worse fixture.
    leak = by_key(audit(Bias.NONE), "pit_adjusted_price_screen_leak")
    assert leak.verdict is Verdict.WARN
    assert not leak.blocking


# -- the treatments ------------------------------------------------------


@pytest.mark.parametrize("bias", TREATMENTS, ids=IDS)
def test_the_injected_defect_is_caught_by_the_checks_that_own_it(bias: Bias):
    report = audit(bias)
    for key in EXPECTED_TRIPS[bias]:
        assert by_key(report, key).verdict is Verdict.FAIL, key


@pytest.mark.parametrize("bias", TREATMENTS, ids=IDS)
def test_nothing_outside_the_family_moves(bias: Bias):
    # The negative half. Without it, a check that reddened on every
    # panel would look like eight successful detections.
    allowed = set(EXPECTED_TRIPS[bias]) | ALSO_ALLOWED.get(bias, frozenset())
    assert failing(audit(bias)) <= allowed


@pytest.mark.parametrize("bias", TREATMENTS, ids=IDS)
def test_a_blocking_defect_costs_the_dataset_its_certificate(bias: Bias):
    report = audit(bias)
    tripped = [by_key(report, k) for k in EXPECTED_TRIPS[bias]]
    if any(c.blocking for c in tripped):
        assert report.verdict is Verdict.FAIL
        assert not report.usable_for_research


def test_an_unrecorded_split_costs_the_dataset_its_certificate():
    # Advisory until the reasoning was looked at again, and the tiering
    # is what makes blocking safe: a handful of odd bars in a million
    # lands on WARN and only colours the report. Getting past WARN means
    # the gap between the prices and the action record is systematic,
    # and that is nearly always splits nobody wrote down. Those print a
    # 75% single-session loss on a day nothing happened — the largest
    # fake returns in the panel, and exactly what a cross-sectional
    # strategy hunts. Momentum reads catastrophe, reversion reads a
    # screaming buy, and both of them trade it.
    report = audit(Bias.UNRECORDED_SPLITS)
    jumps = by_key(report, "quality.unexplained_jumps")
    assert jumps.verdict is Verdict.FAIL
    assert jumps.blocking
    assert report.verdict is Verdict.FAIL
    assert not report.usable_for_research


# -- the biases are distinguishable from one another ---------------------


def test_each_bias_leaves_its_own_signature():
    # Two biases that redden the same set of checks are, from the
    # report's point of view, the same defect — and the report is what
    # somebody uses to decide what to fix.
    signatures = {bias: frozenset(failing(audit(bias))) for bias in Bias}
    assert signatures[Bias.NONE] == frozenset()
    # TICKER_COLLISION and SURVIVORSHIP both reach decedent_trace, which
    # is the point of that check: it is the only instrument that can see
    # a recycled symbol. They are still told apart by everything else.
    assert signatures[Bias.TICKER_COLLISION] < signatures[Bias.SURVIVORSHIP]
    treatments = [signatures[b] for b in TREATMENTS]
    assert len(set(treatments)) == len(treatments)


def test_deleting_the_graveyard_leaves_the_survivorship_checks_nothing_to_read():
    # The escalation the survivorship module is built around: a vendor
    # can list the dead and store no prices for them, so "are they
    # priced?" has to report UNPROVABLE rather than pass once the names
    # are gone entirely. Absence of evidence, said out loud.
    report = audit(Bias.SURVIVORSHIP)
    priced = by_key(report, "survivorship.dead_names_priced")
    assert priced.verdict is Verdict.UNPROVABLE
    assert priced.unprovable_reason


def test_the_collision_is_invisible_to_everything_but_an_identity():
    # The merge happens before the back-adjustment is derived, so the
    # spliced series is arithmetically flawless: no gap, no jump, no
    # inconsistent factor. The only surviving evidence is that a company
    # whose funeral is on the public record is still trading.
    report = audit(Bias.TICKER_COLLISION)
    assert failing(report) == {"survivorship.decedent_trace"}
    for key in (
        "quality.adjustment_consistency",
        "quality.unexplained_jumps",
        "pit_prices_within_listing_window",
    ):
        assert by_key(report, key).verdict is not Verdict.FAIL, key


def test_one_series_under_two_names_cannot_be_used_to_certify_itself():
    # The failure this guards is subtle and was live: ADJUSTED_ONLY does
    # not withdraw the vendor's claim to as-traded prices, so both of
    # these checks cleared their capability gate, compared close_adj
    # against a copy of close_adj, and reported perfect agreement — one
    # of them a blocking PASS over a million-odd session pairs, the
    # other a $5 price screen leaking exactly 0.000% of its universe.
    # Two confident green sections corroborating, in the most
    # quantitative language in the report, the very defect failing three
    # inches above them. Neither number was measured; both must decline.
    report = audit(Bias.ADJUSTED_ONLY)
    assert by_key(report, "pit_unadjusted_prices_available").verdict is Verdict.FAIL
    for key in ("quality.adjustment_consistency", "pit_adjusted_price_screen_leak"):
        res = by_key(report, key)
        assert res.verdict is Verdict.UNPROVABLE, key
        assert res.unprovable_reason, key


def test_the_screen_leak_is_only_declined_when_it_really_cannot_be_read():
    # The other half of the assertion above. A guard that returned
    # UNPROVABLE whenever the number came out small would have bought the
    # honesty by making the check useless, and the control panel is where
    # that shows up: real as-traded closes, a real answer, still WARN.
    leak = by_key(audit(Bias.NONE), "pit_adjusted_price_screen_leak")
    assert leak.verdict is Verdict.WARN
    assert leak.unprovable_reason is None


# -- the harness's own contract ------------------------------------------


def test_every_bias_carries_a_stated_expectation():
    # A new Bias member with no entry would be injected by the harness
    # and asserted about by nobody.
    assert set(EXPECTED_TRIPS) == set(Bias)


def test_every_promised_key_names_a_check_that_exists():
    keys = {c.key for c in audit(Bias.NONE).checks}
    promised = {k for trips in EXPECTED_TRIPS.values() for k in trips}
    assert promised <= keys


def test_check_keys_are_unique_across_the_three_modules():
    # The report is indexed by key and a collision would silently drop
    # one check's section into another's.
    keys = [c.key for c in audit(Bias.NONE).checks]
    assert len(keys) == len(set(keys))


@pytest.mark.parametrize("bias", list(Bias), ids=[b.name for b in Bias])
def test_a_bias_never_walks_back_the_vendors_claims(bias: Bias):
    # The capabilities are the marketing copy and the marketing copy
    # never changes. A source that quietly withdrew its claim to
    # as-reported fundamentals while serving restated ones would turn a
    # FAIL into an UNPROVABLE — declining the test rather than sitting
    # it and getting the answer wrong, which is a much weaker
    # demonstration.
    assert SyntheticSource(
        AUDIT_START, AUDIT_END, bias=bias
    ).capabilities is SyntheticSource.capabilities


@pytest.mark.parametrize("bias", list(Bias), ids=[b.name for b in Bias])
def test_the_panel_says_out_loud_that_it_is_not_research_data(bias: Bias):
    source = SyntheticSource(AUDIT_START, AUDIT_END, bias=bias)
    assert source.capabilities.is_smoke_test_only
    assert "SMOKE TEST ONLY" in source.label
    if bias is not Bias.NONE:
        # The report header has to name the injected defect, or a smoke
        # run reads exactly like an audit of a real dataset.
        assert bias.name in source.label


def test_the_panel_is_reproducible_from_its_seed():
    a = SyntheticSource(AUDIT_START, AUDIT_END, bias=Bias.NONE)
    b = SyntheticSource(AUDIT_START, AUDIT_END, bias=Bias.NONE)
    import pandas.testing as pdt

    pdt.assert_frame_equal(a.security_master(), b.security_master())
    pdt.assert_frame_equal(
        a.prices(AUDIT_START, AUDIT_END), b.prices(AUDIT_START, AUDIT_END)
    )


def test_a_different_seed_is_a_different_panel_and_still_clean():
    # Guards the other direction: a harness whose seed did nothing would
    # pass every test above while generating one memorised fixture.
    other = SyntheticSource(AUDIT_START, AUDIT_END, seed=19870119, bias=Bias.NONE)
    assert not other.security_master().equals(
        SyntheticSource(AUDIT_START, AUDIT_END, bias=Bias.NONE).security_master()
    )
    ctx = load_context(other, AUDIT_START, AUDIT_END)
    report = AuditReport(source_label=other.label)
    for module in CHECK_MODULES:
        for check in module.CHECKS:
            report.add(check(ctx))
    assert failing(report) == set()


def test_the_fundamentals_frame_refuses_a_dimension_it_does_not_generate():
    # Returning an empty frame would read one layer up as "these
    # companies file nothing", which is a statement about the market
    # rather than about the request.
    source = SyntheticSource(AUDIT_START, AUDIT_END)
    with pytest.raises(ValueError) as exc:
        source.fundamentals(AUDIT_START, AUDIT_END, dimension="ARY")
    assert "quarterly fundamentals only" in str(exc.value)
