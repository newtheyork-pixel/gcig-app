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
    /// Phase-2 mnemonics: reserved in the grammar so typing ALRT gets
    /// "planned, not built" instead of a quote for some ticker-shaped
    /// stranger — which is exactly what happened (ALRT parsed as a
    /// security and DES tried to price it).
    var planned: Bool = false

    static func == (a: TerminalFunction, b: TerminalFunction) -> Bool { a.id == b.id }
}

enum Registry {
    static let all: [TerminalFunction] = [
        .init(id: "DES", label: "Description",
              help: "Company snapshot: quote, fundamentals, business summary.",
              requires: "ticker", width: 620, height: 520, native: true),
        .init(id: "PM", label: "Portfolio Manager",
              help: "The whole book: cost, weights, live value, P&L, YTD.",
              // Sized to the table's own minimum, so a freshly opened PM
              // shows all twelve columns without scrolling sideways.
              width: 1040, height: 600, native: true),
        .init(id: "MOVR", label: "Movers",
              help: "Day's biggest gainers and losers.",
              width: 560, height: 520, native: true),
        .init(id: "TOP", label: "Top News",
              help: "Market-wide top headlines.",
              width: 780, height: 620, native: true),
        .init(id: "RSCH", aliases: ["FLD"], label: "Research",
              help: "Everything on one name: brief and questions, outreach, interviews, valuation, claim ledger.",
              width: 900, height: 700, native: true),
        .init(id: "SUBS", label: "Subscriptions",
              help: "What the club pays for, and the shared logins. Credentials live on the server, never in the app.",
              width: 780, height: 460, native: true),
        .init(id: "WL", aliases: ["WATCH"], label: "Watchlist",
              help: "Names worth following: what we hold, what Select Equity disclosed, and anything typed in.",
              width: 1020, height: 620, native: true),
        .init(id: "WEB", aliases: ["BRWS"], label: "Reader",
              help: "Read a story in the terminal. Opened for you when you click a headline.",
              width: 900, height: 700, native: true),
        .init(id: "SMENU", label: "Security Menu",
              help: "Everything you can run on the loaded security, numbered. A bare ticker lands here.",
              requires: "ticker", width: 560, height: 620, native: true),
        .init(id: "MAIN", aliases: ["MENU", "HOME"], label: "Main Menu",
              help: "Every function, by category, numbered. The top of the tree.",
              width: 620, height: 680, native: true),
        .init(id: "LAST", label: "Last Screens",
              help: "The last eight screens you ran, numbered for recall.",
              width: 480, height: 340, native: true),
        .init(id: "HELP", label: "Help",
              help: "List of available terminal functions.",
              width: 640, height: 560, native: true),

        // Known to the parser, not yet native. Listed so the command bar
        // can tell the truth about why nothing opened.
        .init(id: "GP", label: "Chart", help: "Price chart with selectable interval.", requires: "ticker", width: 760, height: 540, native: true),
        .init(id: "GIP", label: "Intraday Price", help: "Today's intraday line vs prior close.", requires: "ticker", width: 640, height: 460, native: true),
        .init(id: "CN", label: "Company News", help: "Latest headlines for the focused ticker.", requires: "ticker", width: 720, height: 560, native: true),
        .init(id: "BI", label: "Bloomberg Intelligence", help: "Free-form research chat with workspace context.", width: 640, height: 540, native: true),
        .init(id: "FA", label: "Financial Analysis", help: "Income, balance sheet & cash flow (SEC XBRL).", requires: "ticker", width: 860, height: 640, native: true),
        .init(id: "GF", label: "Graph Fundamentals", help: "Revenue, margins, EPS & cash flow over time.", requires: "ticker", width: 820, height: 620, native: true),
        .init(id: "PEER", label: "Peers", help: "Sector peer comparison table.", requires: "ticker", width: 780, height: 480, native: true),
        .init(id: "INSDR", label: "Insider Activity", help: "Form 4 insider buys/sells on the price chart.", requires: "ticker", width: 760, height: 640, native: true),
        .init(id: "FIL", label: "Filings", help: "Recent SEC filings with an AI read.", requires: "ticker", width: 760, height: 600, native: true),
        .init(id: "EARN", label: "Earnings", help: "Next report + trailing EPS beat/miss history.", requires: "ticker", width: 640, height: 520, native: true),
        .init(id: "CON", label: "Analyst Consensus", help: "Buy/hold/sell breakdown & trend.", requires: "ticker", width: 620, height: 500, native: true),
        .init(id: "CMP", label: "Compare", help: "2-4 tickers side by side.", width: 660, height: 500, native: true),
        .init(id: "ICLUSTER", label: "Insider Clusters", help: "Multi-insider buy clusters across the book.", width: 660, height: 520, native: true),
        .init(id: "NOTE", label: "Notes", help: "Your private research notes for this ticker.", requires: "ticker", width: 620, height: 520, native: true),
        .init(id: "ARCH", label: "Archive", help: "The club's own reports & pitch decks.", width: 800, height: 640, native: true),
        .init(id: "MGMT", label: "Management & Board", help: "CEO, board, comp from the latest DEF 14A.", requires: "ticker", width: 780, height: 620, native: true),
        .init(id: "WEI", label: "World Indices", help: "Global index snapshot.", width: 600, height: 560, native: true),
        .init(id: "SPLC", label: "Supply Chain", help: "Customers, suppliers & key inputs from the 10-K.", requires: "ticker", width: 660, height: 560, native: true),
        .init(id: "ECO", label: "Economic Calendar", help: "Upcoming releases and central bank events.", native: true),
        .init(id: "WX", label: "Weather Impact", help: "Named-storm impact on Gulf O&G + insurer exposure.", width: 640, height: 640, native: true),
        .init(id: "RDR", label: "Weather Radar", help: "Live US NEXRAD radar + active NWS warnings.", width: 780, height: 640, native: true),
        .init(id: "ORG", label: "Organization", help: "The club org chart: leadership tiers, industry groups, profiles one click away. PM and above.", width: 720, height: 660, native: true),
        .init(id: "MACRO", label: "Macro Sensitivity", help: "Portfolio sensitivity to 10Y, oil, USD, VIX, SPY.", width: 660, height: 720, native: true),

        // Phase 2 — reserved, not built. The grammar knows them so the
        // command line can say so.
        .init(id: "MON", aliases: ["W"], label: "Club Monitor", help: "The shared coverage watchlist.", planned: true),
        .init(id: "ALRT", label: "Alerts", help: "Price and news alerts to your inbox.", planned: true),
        .init(id: "EVTS", aliases: ["ERN"], label: "Earnings Calendar", help: "Earnings keyed to the book and watchlist.", planned: true),
        .init(id: "HDS", label: "Holders", help: "13F holders and insider filings.", planned: true),
        .init(id: "EQS", label: "Equity Screener", help: "Screen the universe, funnel-style.", planned: true),
        .init(id: "DAYB", label: "Morning Page", help: "The auto-composed pre-meeting brief.", planned: true),
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
