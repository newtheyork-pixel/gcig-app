"""Companies whose funerals are a matter of public record.

A vendor saying "survivorship-bias-free" is a claim. This file is what
turns it into a demonstration: named companies, dates checked against
primary sources, and a stated tolerance for how far a panel may be off
before we call it wrong. If Lehman Brothers is missing from the
security master, or its price series runs to today, no amount of
marketing copy survives contact with that.

Two traps are encoded in the data rather than left to the reader.

**The pink sheets.** Almost every bankruptcy here went on trading over
the counter under a Q-suffixed symbol after the exchange threw it out
— LEHMQ, WAMUQ, CCTYQ, SHLDQ, BBBYQ, RADCQ — sometimes for years, and
not always at zero. The date on each row is the last day of NORMAL
EXCHANGE trading, because that is the last day a position could have
been closed at a fill anyone would honour, and it is the only date the
strategies in this repository can act on. A source whose series runs
past that date is not wrong; it answered a different question, and the
audit should say which. So `tolerance_days` is sized for the genuine
ambiguity in the exchange date — halted intraday, suspended on the
tape at the close, suspended before the next open, Form 25 filed a
fortnight later — and never for the OTC tail. Late is a remark. Early,
or absent altogether, is the failure this file exists to catch.

**The recycled symbol.** Six of these tickers are alive today on a
different company. WM was Washington Mutual until the FDIC took it in
September 2008 and Waste Management from August 2009, on the same
exchange, ten months apart. Join on the string and you get a series
that fell 100% and then recovered, which backtests wonderfully. Those
rows carry `successor_ticker`; they are the sharpest test in the file,
because a source with real permanent ids passes them without noticing
and a source without them cannot pass at all.

Every date below was taken from an exchange Form 25 notice, a company
8-K or a company press release, and the citation is on the row. Where
the record was ambiguous about which session was the last one, the
tolerance was widened rather than the date guessed — the point of a
fixture is to be right, and a fixture with an invented date turns a
good dataset into a reported failure.

`reason` is drawn from a small vocabulary: bankruptcy, acquisition,
merger, seizure, going_private, liquidation, regulatory_delisting.
The distinction is not decorative. An acquisition and a bankruptcy are
opposite returns into the delisting, and a panel that records the date
but not the reason cannot tell them apart.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class Decedent:
    """One company, one death, one date somebody can check."""

    ticker: str
    name: str
    #: Last session of normal trading on a real exchange. Never the OTC
    #: tail, never the Form 25 date.
    last_trade_on_or_about: date
    #: How far the panel may be off before the row counts against it.
    tolerance_days: int
    reason: str
    note: str
    #: URL or citation backing the date. Two, semicolon-separated, on
    #: the rows where the successor's start date also needs backing.
    source: str
    #: Set when the SYMBOL was later carried by a different company.
    successor_ticker: str | None = None

    @property
    def earliest(self) -> date:
        slack = timedelta(days=self.tolerance_days)
        return self.last_trade_on_or_about - slack

    @property
    def latest(self) -> date:
        slack = timedelta(days=self.tolerance_days)
        return self.last_trade_on_or_about + slack

    def accepts(self, observed: date) -> bool:
        return self.earliest <= observed <= self.latest


# Chronological, because reading them in order is reading the crisis.
DECEDENTS: tuple[Decedent, ...] = (
    Decedent(
        ticker="BSC",
        name="The Bear Stearns Companies Inc.",
        last_trade_on_or_about=date(2008, 5, 30),
        tolerance_days=3,
        reason="acquisition",
        note=(
            "JPMorgan's merger took effect at 11:59 p.m. EDT on a Friday, so "
            "the symbol simply stops with no bankruptcy tail behind it — the "
            "cleanest possible test of whether a panel keeps entities that "
            "were absorbed rather than wound up."
        ),
        source=(
            "https://jpmorganchaseco.gcs-web.com/news-releases/"
            "news-release-details/jpmorgan-chase-completes-bear-stearns-"
            "acquisition"
        ),
    ),
    Decedent(
        ticker="CFC",
        name="Countrywide Financial Corporation",
        last_trade_on_or_about=date(2008, 6, 30),
        tolerance_days=3,
        reason="acquisition",
        note=(
            "Countrywide asked to cease trading at the close of business on "
            "30 June and the Bank of America merger became effective at 12:01 "
            "a.m. the next day, which is why a panel stamped 1 July is "
            "off-by-one rather than wrong."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/25191/"
            "000095014408005376/g14113k2e8vk.htm"
        ),
    ),
    Decedent(
        ticker="LEH",
        name="Lehman Brothers Holdings Inc.",
        last_trade_on_or_about=date(2008, 9, 17),
        tolerance_days=4,
        reason="bankruptcy",
        note=(
            "Traded three full sessions AFTER the 15 September Chapter 11 "
            "filing; NYSE announced the suspension on the tape at the close "
            "on the 17th, so a panel that stops on the 12th has quietly "
            "deleted the days on which the loss was actually taken. Continued "
            "OTC as LEHMQ for years."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/876661/"
            "000087666108000403/ruleprovisionnotice.htm"
        ),
    ),
    Decedent(
        ticker="WM",
        name="Washington Mutual, Inc.",
        last_trade_on_or_about=date(2008, 9, 25),
        tolerance_days=4,
        reason="seizure",
        note=(
            "The single best ticker-recycling test in the file, and the claim "
            "checks out: the thrift was seized after the close on 25 "
            "September, NYSE halted WM at the open on the 26th after "
            "pre-market prints as low as $0.15, and Waste Management moved "
            "from WMI to the freed-up WM on the same exchange on 5 August "
            "2009. Any panel keyed on the symbol has Waste Management's 2008 "
            "prices sitting where a total loss belongs."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/933136/"
            "000087666108000446/ruleprovisionnotice.htm ; "
            "https://investors.wm.com/news-releases/news-release-details/"
            "waste-management-announces-ticker-change-wm"
        ),
        successor_ticker="WM",
    ),
    Decedent(
        ticker="CC",
        name="Circuit City Stores, Inc.",
        last_trade_on_or_about=date(2008, 11, 10),
        tolerance_days=5,
        reason="bankruptcy",
        note=(
            "Filed Chapter 11 on the Monday morning and NYSE suspended it the "
            "same day; contemporaneous reports disagree on what the final "
            "consolidated print was, hence the wider tolerance back to the "
            "$0.25 close of Friday the 7th. Liquidated outright in March "
            "2009, and "
            "Chemours took the CC symbol on the NYSE on 1 July 2015."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/104599/"
            "000087666108000522/ruleprovisionnotice.htm ; "
            "https://www.prnewswire.com/news-releases/dupont-completes-spin-"
            "off-of-the-chemours-company-300107397.html"
        ),
        successor_ticker="CC",
    ),
    Decedent(
        ticker="WB",
        name="Wachovia Corporation",
        last_trade_on_or_about=date(2008, 12, 31),
        tolerance_days=3,
        reason="acquisition",
        note=(
            "Merged into Wells Fargo on the last trading day of 2008, so the "
            "series ends exactly on a year boundary — the place an annual "
            "rebalance is most likely to paper over a missing name. Weibo "
            "took WB on Nasdaq on 17 April 2014; different exchange, same "
            "string, and a symbol-keyed join splices them anyway."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/72971/"
            "000089882209000002/wellsfargo_8k.htm ; "
            "https://weibocorporation.gcs-web.com/news-releases/"
            "news-release-details/weibo-announces-pricing-initial-public-"
            "offering/"
        ),
        successor_ticker="WB",
    ),
    Decedent(
        ticker="GM",
        name="General Motors Corporation (old GM)",
        last_trade_on_or_about=date(2009, 6, 1),
        tolerance_days=3,
        reason="bankruptcy",
        note=(
            "The canonical permaticker test. Old GM traded down to $0.75 on "
            "the day it filed, NYSE suspended it before the open on 2 June, "
            "the shell became Motors Liquidation (GMGMQ, then MTLQQ), and a "
            "brand-new company listed under GM after the 18 November 2010 "
            "IPO. One symbol, two entities, seventeen months apart, and the "
            "spliced series looks like a 99% drawdown that recovered."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/876661/"
            "000087666109000303/ruleprovisionnotice.htm ; "
            "https://money.cnn.com/2010/11/18/news/companies/gm_ipo_akerson/"
            "index.htm"
        ),
        successor_ticker="GM",
    ),
    Decedent(
        ticker="DELL",
        name="Dell Inc.",
        last_trade_on_or_about=date(2013, 10, 29),
        tolerance_days=3,
        reason="going_private",
        note=(
            "Went private at $13.75 a share plus a $0.13 special dividend, "
            "trading concluding at the end of business that day — a delisting "
            "with a known cash terminal value, which is the case a panel is "
            "most tempted to treat as a data gap. Dell Technologies took DELL "
            "back, on the NYSE this time, on 28 December 2018."
        ),
        source=(
            "https://www.dell.com/learn/us/en/uscorp1/secure/"
            "2013-10-29-dell-completes-go-private-transaction ; "
            "https://investors.delltechnologies.com/news-releases/"
            "news-release-details/dell-technologies-completes-class-v-"
            "transaction"
        ),
        successor_ticker="DELL",
    ),
    Decedent(
        ticker="DOW",
        name="The Dow Chemical Company (old Dow)",
        last_trade_on_or_about=date(2017, 8, 31),
        tolerance_days=3,
        reason="merger",
        note=(
            "Dow and DuPont both stopped at the close on 31 August 2017 and "
            "reopened as DowDuPont (DWDP) the next morning; nineteen months "
            "later DWDP spun the materials business back out and Dow Inc. "
            "began regular-way trading under DOW on 2 April 2019. A symbol "
            "that dies into a merger and is reborn out of a spin-off, with a "
            "gap short enough that a lazy forward-fill hides it entirely."
        ),
        source=(
            "https://corporate.dow.com/en-us/news/press-releases/"
            "dowdupont-merger-successfully-completed ; "
            "https://www.businesswire.com/news/home/20190401005899/en/"
            "Dow-completes-separation-DowDuPont"
        ),
        successor_ticker="DOW",
    ),
    Decedent(
        ticker="SHLD",
        name="Sears Holdings Corporation",
        last_trade_on_or_about=date(2018, 10, 23),
        tolerance_days=3,
        reason="bankruptcy",
        note=(
            "Filed on 15 October but kept trading on Nasdaq for another week; "
            "the suspension came at the opening of business on the 24th, so "
            "the last real session is the 23rd rather than the filing date "
            "everyone remembers. Continued OTC as SHLDQ."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/1310067/"
            "000135445718000476/shlddelistreason.txt"
        ),
    ),
    Decedent(
        ticker="AABA",
        name="Altaba Inc. (formerly Yahoo! Inc.)",
        last_trade_on_or_about=date(2019, 10, 2),
        tolerance_days=4,
        reason="liquidation",
        note=(
            "Nasdaq halted the shares after the close on 2 October and the "
            "fund dissolved two days later, paying holders out in liquidating "
            "distributions. A delisting with a large POSITIVE terminal "
            "payment: a panel that just stops the price series here records a "
            "loss that nobody took."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/1011006/"
            "000119312519262790/d794671dex991.htm"
        ),
    ),
    Decedent(
        ticker="CHL",
        name="China Mobile Limited (ADR)",
        last_trade_on_or_about=date(2021, 1, 8),
        tolerance_days=3,
        reason="regulatory_delisting",
        note=(
            "Suspended at 4:00 a.m. on 11 January 2021 under Executive Order "
            "13959 — a profitable, solvent issuer that went on trading in "
            "Hong Kong throughout. Delisting is not distress, and a panel "
            "that carries no reason code cannot tell this apart from a "
            "bankruptcy."
        ),
        source=(
            "https://ir.theice.com/press/news-details/2021/"
            "NYSE-Announces-Suspension-Date-for-Securities-of-Three-Issuers-"
            "and-Proceeds-with-Delisting/default.aspx"
        ),
    ),
    Decedent(
        ticker="TWTR",
        name="Twitter, Inc.",
        last_trade_on_or_about=date(2022, 10, 27),
        tolerance_days=3,
        reason="acquisition",
        note=(
            "Closed at $53.70 and was suspended before the open the next "
            "morning, holders taking $54.20 in cash. The return INTO the "
            "delisting is positive, unlike every bankruptcy above, which is "
            "why a panel that treats 'delisted' as a synonym for 'went to "
            "zero' gets this one exactly backwards."
        ),
        source=(
            "https://www.sec.gov/Archives/edgar/data/1418091/"
            "000087666122000890/ruleprovisionnotice.htm"
        ),
    ),
    Decedent(
        ticker="SIVB",
        name="SVB Financial Group",
        last_trade_on_or_about=date(2023, 3, 9),
        tolerance_days=3,
        reason="seizure",
        note=(
            "Fell 60% on the 9th and was halted at 08:35 the next morning at "
            "a last sale of $106.04 — the previous close, so the regular "
            "session of the 10th never happened. The bank was seized that "
            "day; the holding company filed Chapter 11 a week later."
        ),
        source=(
            "https://www.nasdaq.com/press-release/"
            "nasdaq-halts-svb-financial-group-2023-03-10"
        ),
    ),
    Decedent(
        ticker="SBNY",
        name="Signature Bank",
        last_trade_on_or_about=date(2023, 3, 10),
        tolerance_days=3,
        reason="seizure",
        note=(
            "Closed at $70.00 on the Friday and was seized by New York State "
            "over the weekend; Nasdaq halted it on the Monday at that same "
            "last sale. A weekend failure leaves no declining tape at all, "
            "which is the shape a survivorship scan is least likely to spot."
        ),
        source=(
            "https://www.nasdaq.com/press-release/"
            "nasdaq-halts-signature-bank-2023-03-13"
        ),
    ),
    Decedent(
        ticker="FRC",
        name="First Republic Bank",
        last_trade_on_or_about=date(2023, 4, 28),
        tolerance_days=4,
        reason="seizure",
        note=(
            "Ended the Friday at $3.51, fell another 43% in Monday's "
            "pre-market before the halt, and was closed by California "
            "regulators that day. The tolerance covers panels that carry a "
            "1 May bar built from pre-market prints alone."
        ),
        source=(
            "https://ir.theice.com/press/news-details/2023/"
            "NYSE-to-Suspend-Trading-Immediately-in-First-Republic-Bank-FRC-"
            "and-Commence-Delisting-Proceedings/default.aspx"
        ),
    ),
    Decedent(
        ticker="BBBY",
        name="Bed Bath & Beyond Inc.",
        last_trade_on_or_about=date(2023, 5, 2),
        tolerance_days=3,
        reason="bankruptcy",
        note=(
            "Filed on 23 April but Nasdaq did not suspend until the opening "
            "of business on 3 May, so there are nine days of post-filing tape "
            "a panel can silently drop. Continued OTC as BBBYQ, where the "
            "meme bid kept it moving long after the equity was worthless."
        ),
        source=(
            "https://www.prnewswire.com/news-releases/"
            "bed-bath--beyond-inc-receives-nasdaq-delisting-notice-"
            "301807492.html"
        ),
    ),
    Decedent(
        ticker="RAD",
        name="Rite Aid Corporation",
        last_trade_on_or_about=date(2023, 10, 16),
        tolerance_days=3,
        reason="bankruptcy",
        note=(
            "Traded down to about $0.61 on the Monday the Chapter 11 was "
            "disclosed, NYSE suspended it the same day, and it reopened OTC "
            "as RADCQ on the Tuesday. The most recent name here, so a panel "
            "that gets the 2008 cohort right and this one wrong is stale "
            "rather than biased."
        ),
        source=(
            "https://ir.theice.com/press/news-details/2023/"
            "NYSE-to-Commence-Delisting-Proceedings-Against-Rite-Aid-"
            "Corporation-RAD/default.aspx"
        ),
    ),
)


BY_TICKER: dict[str, Decedent] = {d.ticker: d for d in DECEDENTS}

#: The rows where the symbol outlived the company. Named rather than
#: re-derived at each call site, because the obvious filter — comparing
#: `successor_ticker` to `ticker` — is wrong: the whole point is that
#: the two are the same string.
RECYCLED_TICKERS: tuple[str, ...] = tuple(
    d.ticker for d in DECEDENTS if d.successor_ticker is not None
)


@dataclass(frozen=True)
class IndexEvent:
    """A membership change, with the day it took effect."""

    index: str
    ticker: str
    #: "added" or "removed".
    action: str
    effective: date
    announced: date
    note: str
    source: str


#: Deliberately three rows. These are not a test of anything — nothing
#: in this project's design needs index membership, since the universe
#: is computed from tradability rather than inherited from an index.
#: They exist so a check can state precisely what a source without
#: historical constituents cannot be asked: reconstruct the DJIA as it
#: stood on 25 June 2018, or the S&P 500 the day before Tesla joined.
#: That question comes back UNPROVABLE, and the report should print
#: these dates as the concrete thing that went unasked rather than a
#: shrug about missing metadata.
INDEX_EVENTS: tuple[IndexEvent, ...] = (
    IndexEvent(
        index="DJIA",
        ticker="AAPL",
        action="added",
        effective=date(2015, 3, 19),
        announced=date(2015, 3, 6),
        note=(
            "Replaced AT&T, the addition made possible by Visa's 4:1 split "
            "cutting the index's technology weight — a reminder that Dow "
            "membership turns on share price, not size."
        ),
        source=(
            "https://press.spglobal.com/"
            "2015-03-06-Apple-Set-to-Join-the-Dow-Jones-Industrial-Average"
        ),
    ),
    IndexEvent(
        index="DJIA",
        ticker="GE",
        action="removed",
        effective=date(2018, 6, 26),
        announced=date(2018, 6, 19),
        note=(
            "The last original member to go, continuously in the index since "
            "1907 and out of it before the open on a Tuesday. A backtest that "
            "assumes today's constituents held in 2010 is holding Walgreens "
            "eight years early and has dropped GE from a decade it dominated."
        ),
        source=(
            "https://press.spglobal.com/"
            "2018-06-19-Walgreens-Boots-Alliance-Set-to-Join-"
            "Dow-Jones-Industrial-Average"
        ),
    ),
    IndexEvent(
        index="S&P 500",
        ticker="TSLA",
        action="added",
        effective=date(2020, 12, 21),
        announced=date(2020, 11, 16),
        note=(
            "The largest addition in the index's history, and five weeks "
            "between the announcement and the effective date — the gap that "
            "makes 'as of' the only honest way to ask about membership."
        ),
        source=(
            "https://press.spglobal.com/2020-11-16-Tesla-Set-to-Join-S-P-500"
        ),
    ),
)
