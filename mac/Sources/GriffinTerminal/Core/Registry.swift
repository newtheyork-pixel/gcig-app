import SwiftUI

// The function registry, ported from client/src/terminal/registry.js.
//
// Every mnemonic the web terminal answers to appears here, including the
// ones this app has not implemented natively yet. That is on purpose:
// typing `SPLC` should say "not built here yet, it is on the web" rather
// than "unknown command", because those are different facts and only one
// of them is the user's mistake.
struct TerminalFunction: Identifiable, Equatable {
    let id: String
    var aliases: [String] = []
    let label: String
    let help: String
    /// "ticker" when the function cannot run without one.
    var requires: String? = nil
    var width: CGFloat = 580
    var height: CGFloat = 460
    /// False for functions still only on the web.
    var native: Bool = false

    static func == (a: TerminalFunction, b: TerminalFunction) -> Bool { a.id == b.id }
}

enum Registry {
    static let all: [TerminalFunction] = [
        .init(id: "DES", label: "Description",
              help: "Company snapshot: quote, fundamentals, business summary.",
              requires: "ticker", width: 620, height: 520, native: true),
        .init(id: "PM", label: "Portfolio Manager",
              help: "The whole book: positions, weights, live value & P&L.",
              width: 900, height: 600, native: true),
        .init(id: "MOVR", label: "Movers",
              help: "Day's biggest gainers and losers.",
              width: 560, height: 520, native: true),
        .init(id: "TOP", label: "Top News",
              help: "Market-wide top headlines.",
              width: 780, height: 620, native: true),
        .init(id: "RSCH", aliases: ["FLD"], label: "Research",
              help: "Everything on one name: brief and questions, outreach, interviews, valuation, claim ledger.",
              width: 900, height: 700, native: true),
        .init(id: "HELP", label: "Help",
              help: "List of available terminal functions.",
              width: 640, height: 560, native: true),

        // Known to the parser, not yet native. Listed so the command bar
        // can tell the truth about why nothing opened.
        .init(id: "GP", label: "Chart", help: "Price chart with selectable interval.", requires: "ticker"),
        .init(id: "GIP", label: "Intraday Price", help: "Today's intraday line vs prior close.", requires: "ticker"),
        .init(id: "CN", label: "Company News", help: "Latest headlines for the focused ticker.", requires: "ticker", width: 720, height: 560),
        .init(id: "BI", label: "Bloomberg Intelligence", help: "Free-form research chat with workspace context."),
        .init(id: "FA", label: "Financial Analysis", help: "Income, balance sheet & cash flow (SEC XBRL).", requires: "ticker"),
        .init(id: "GF", label: "Graph Fundamentals", help: "Revenue, margins, EPS & cash flow over time.", requires: "ticker"),
        .init(id: "PEER", label: "Peers", help: "Sector peer comparison table.", requires: "ticker"),
        .init(id: "INSDR", label: "Insider Activity", help: "Form 4 insider buys/sells on the price chart.", requires: "ticker"),
        .init(id: "FIL", label: "Filings", help: "Recent SEC filings with an AI read.", requires: "ticker"),
        .init(id: "EARN", label: "Earnings", help: "Next report + trailing EPS beat/miss history.", requires: "ticker"),
        .init(id: "CON", label: "Analyst Consensus", help: "Buy/hold/sell breakdown & trend.", requires: "ticker"),
        .init(id: "CMP", label: "Compare", help: "2-4 tickers side by side."),
        .init(id: "ICLUSTER", label: "Insider Clusters", help: "Multi-insider buy clusters across the book."),
        .init(id: "NOTE", label: "Notes", help: "Your private research notes for this ticker.", requires: "ticker"),
        .init(id: "ARCH", label: "Archive", help: "The club's own reports & pitch decks.", width: 800, height: 640),
        .init(id: "MGMT", label: "Management & Board", help: "CEO, board, comp from the latest DEF 14A.", requires: "ticker"),
        .init(id: "WEI", label: "World Indices", help: "Global index snapshot."),
        .init(id: "SPLC", label: "Supply Chain", help: "Customers, suppliers & key inputs from the 10-K.", requires: "ticker"),
        .init(id: "ECO", label: "Economic Calendar", help: "Upcoming releases and central bank events."),
        .init(id: "WX", label: "Weather Impact", help: "Named-storm impact on Gulf O&G + insurer exposure."),
        .init(id: "RDR", label: "Weather Radar", help: "Live US NEXRAD radar + active NWS warnings."),
        .init(id: "MACRO", label: "Macro Sensitivity", help: "Portfolio sensitivity to 10Y, oil, USD, VIX, SPY."),
    ]

    /// Aliases resolve to the same function but stay out of `all`, so a
    /// retired code keeps working without showing up twice in HELP.
    static let byID: [String: TerminalFunction] = {
        var m: [String: TerminalFunction] = [:]
        for f in all {
            m[f.id] = f
            for a in f.aliases { m[a] = f }
        }
        return m
    }()

    static let ids: Set<String> = Set(byID.keys)

    static func function(_ id: String) -> TerminalFunction? {
        byID[id.uppercased()]
    }
}
