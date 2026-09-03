import Foundation

// Decodables are written from the server handler, never from the JSX.
// Every field optional: this app must render something useful against a
// payload that gained or lost a key, rather than failing the whole screen.

// MARK: The book

/// Everything sheetPortfolio.js:218 actually sends. The first version
/// decoded two of these six and rendered one, which is why the holdings
/// visibly did not sum to the total on screen.
struct Totals: Decodable {
    let totalValue: Double?
    let totalCost: Double?
    let totalGainLoss: Double?
    let totalGainLossPct: Double?
    let cashValue: Double?
    /// Positions the sheet could not price. Non-zero means the total below
    /// is missing those positions entirely, and the server refuses to write
    /// a snapshot on such a read. A screen that shows the total without
    /// saying so is presenting a known-short number as the book.
    let unpricedCount: Int?

    var equityValue: Double? {
        guard let totalValue else { return nil }
        return totalValue - (cashValue ?? 0)
    }
}

struct Holding: Decodable, Identifiable {
    let ticker: String?
    let name: String?
    let shares: Double?
    let price: Double?
    let marketValue: Double?
    let costBasis: Double?
    /// The server sends dayChange, an absolute per-share dollar move, and no
    /// percentage anywhere. dayChangePct exists only as a local inside
    /// HoldingDetailModal.jsx, which is exactly the JSX this file is
    /// forbidden to read models from: the wrong key decodes to nil and the
    /// column silently never renders.
    let dayChange: Double?
    let isCash: Bool?

    /// Identity must be stable across reads. A UUID() fallback mints a new
    /// one every diff pass, so SwiftUI tears the row down and rebuilds it
    /// forever. Two malformed sheet rows with no ticker and no name would
    /// previously collide on the same literal id and give ForEach duplicate
    /// identities, so the index is folded in by the caller via `keyed`.
    var id: String { ticker ?? name ?? "unidentified" }

    /// The ticker, uppercased, for the one comparison that matters.
    var symbol: String? { ticker?.uppercased() }

    /// Position-level day move in dollars: per-share change times shares.
    var dayChangeValue: Double? {
        guard let dayChange, let shares else { return nil }
        return dayChange * shares
    }

    /// Percent, derived rather than trusted, and nil unless every half is
    /// present and the base is real.
    var dayChangePct: Double? {
        guard let dc = dayChange, let p = price, p != 0 else { return nil }
        let prior = p - dc
        guard prior > 0 else { return nil }
        return dc / prior * 100
    }

    /// Unrealised gain against the sheet's average cost.
    var gainLoss: Double? {
        guard let mv = marketValue, let sh = shares, let cb = costBasis else { return nil }
        return mv - (sh * cb)
    }

    var gainLossPct: Double? {
        guard let sh = shares, let cb = costBasis, let g = gainLoss else { return nil }
        let cost = sh * cb
        guard cost > 0 else { return nil }
        return g / cost * 100
    }
}

struct Book: Decodable {
    let holdings: [Holding]?
    let totals: Totals?
    /// When the sheet was read. The Mac surfaces this; the first iOS build
    /// decoded nothing and so presented an hour-old GOOGLEFINANCE mark as
    /// current. Staleness is not only a failed refresh.
    let fetchedAt: String?

    var equities: [Holding] { (holdings ?? []).filter { $0.isCash != true } }
    var cash: [Holding] { (holdings ?? []).filter { $0.isCash == true } }
}

extension Array where Element == Holding {
    /// The stable, unique identity `Holding.id`'s own comment promises and
    /// nothing ever provided — there was no `keyed` anywhere in the app.
    ///
    /// Rendering by array offset instead, which is what the Book did, means
    /// identity is POSITION: when the sheet reorders, row 3 keeps its
    /// identity while its contents change from one company to another, so
    /// the price-flash animation compares the old holding's price to the new
    /// holding's and flashes green on a name that did not move. Keyed on the
    /// ticker, a reordered row travels with its own identity.
    ///
    /// Two malformed sheet rows carrying neither ticker nor name collapse to
    /// the same literal, so first-seen ordinal disambiguates them. That is
    /// the only case where position enters, and it is the case where there
    /// is nothing else to go on.
    var keyed: [(key: String, holding: Holding)] {
        var seen: [String: Int] = [:]
        return map { h in
            let base = h.id
            let n = (seen[base] ?? 0) + 1
            seen[base] = n
            return (key: n == 1 ? base : "\(base)#\(n)", holding: h)
        }
    }
}

// MARK: One name

/// /holdings/info/:ticker. Finnhub first, Yahoo as fallback, so any field
/// can be absent on any read.
struct TickerInfo: Decodable {
    let name: String?
    let sector: String?
    let industry: String?
    let price: Double?
    let previousClose: Double?
    let marketCap: Double?
    let trailingPE: Double?
    let forwardPE: Double?
    /// A FRACTION on the wire. Both server branches agree: the Finnhub path
    /// divides `currentDividendYieldTTM` by 100 and Yahoo's own field is
    /// already fractional. Read it through `dividendYieldPct` and never
    /// directly — passing the raw value to `Fmt.pct` printed a 2.34% yield
    /// as "0.02%", which is the Mac's DescriptionPanel bug in reverse: that
    /// client multiplies by 100 and this one had simply never been told to.
    let dividendYield: Double?
    let fiftyTwoWeekLow: Double?
    let fiftyTwoWeekHigh: Double?
    let beta: Double?
    let exchange: String?
    /// The LLM rewrite of Item 1 in data-provider register. Preferred over
    /// `summary`, which is the company's own brochure copy.
    let description: String?
    let summary: String?

    var prose: String? {
        let d = description?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let d, !d.isEmpty { return d }
        let s = summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (s?.isEmpty == false) ? s : nil
    }

    /// The wire fraction, as a whole percent, ready for `Fmt.pct`.
    var dividendYieldPct: Double? { dividendYield.map { $0 * 100 } }

    var dayChange: Double? {
        guard let price, let previousClose, previousClose != 0 else { return nil }
        return price - previousClose
    }

    var dayChangePct: Double? {
        guard let dayChange, let previousClose, previousClose > 0 else { return nil }
        return dayChange / previousClose * 100
    }

    /// Where today's price sits in the 52-week band, 0 to 1. The band is the
    /// one piece of context a price has on its own.
    var rangePosition: Double? {
        guard let price, let lo = fiftyTwoWeekLow, let hi = fiftyTwoWeekHigh,
              hi > lo else { return nil }
        return min(max((price - lo) / (hi - lo), 0), 1)
    }
}

/// /holdings/coverage/:ticker. The club's own record on a name: what we
/// pitched, what we voted, what we wrote. This is the part no market data
/// app can show, and the reason to open ours instead of Yahoo.
struct Coverage: Decodable {
    let pitches: [Pitch]?
    let reports: [Report]?
    let research: [Research]?
    let decisions: [Decision]?

    /// Do we own it, and what did we pay. The screen only knew about a
    /// position when a `Holding` had been handed to it by the Book, so the
    /// same ticker opened from the wire or the watchlist claimed we held
    /// nothing. The coverage payload has carried this all along.
    let holding: Position?

    /// Rewritten from the handler in routes/holdings.js. The previous shape
    /// asked for `title` and `recommendation`, which that route has never
    /// sent — so every pitch rendered as the literal word "Pitch" over a
    /// blank subtitle. The house rule says decodables come from the server
    /// handler and not from the JSX; this is what happens when the rule is
    /// followed once and never checked again.
    struct Pitch: Decodable, Identifiable {
        let id: Int?
        let date: String?
        let location: String?
        let industry: Industry?
        let presenters: [String]?

        struct Industry: Decodable { let id: Int?; let name: String? }

        var stableId: String { id.map(String.init) ?? (date ?? "pitch") }
        var who: String? {
            let names = (presenters ?? []).compactMap { $0.isEmpty ? nil : $0 }
            return names.isEmpty ? nil : names.joined(separator: ", ")
        }
        var where_: String? {
            [industry?.name, location].compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
                .nilIfEmpty
        }
    }
    struct Report: Decodable {
        let id: Int?
        let title: String?
        let author: String?
        let date: String?
        let description: String?
    }
    struct Research: Decodable {
        let id: Int?
        let name: String?
        let status: String?
        /// When the work was STARTED. The server picks createdAt over
        /// updatedAt on purpose: relabelling a row moved updatedAt, which
        /// is how thirty-nine projects all came to read "August 6".
        let initiatedAt: String?
        let analyst: String?
        let buyBelow: Double?
        let currency: String?
    }

    /// What the club decided, recomputed server-side from the same tally
    /// function the votes page uses. Fetched since this screen was written
    /// and never once rendered.
    struct Decision: Decodable, Identifiable {
        let id: Int?
        let ticker: String?
        let kind: String?
        let closedAt: String?
        let decision: String?
        let ballots: Int?
        let proposed: Proposed?
        let synthesis: String?
        let pitchId: Int?

        struct Proposed: Decodable {
            let count: Int?
            let avg: Double?
            let min: Double?
            let max: Double?
            let fixed: Bool?
        }

        var stableId: String { id.map(String.init) ?? (closedAt ?? "decision") }
        /// A sell vote offers Sell or Hold; a buy vote offers Buy, Hold or
        /// Sell. The word alone does not say which question was asked.
        var question: String { kind == "sell" ? "Exit vote" : "Pitch vote" }
    }

    struct Position: Decodable {
        let shares: Double?
        let costBasis: Double?
        let name: String?
        let sector: String?
        let addedAt: String?
    }

    var isEmpty: Bool {
        (pitches ?? []).isEmpty && (reports ?? []).isEmpty
            && (research ?? []).isEmpty && (decisions ?? []).isEmpty
    }
}

// MARK: Outreach

struct ChaseRow: Decodable, Identifiable {
    let targetId: Int?
    let name: String?
    let state: String?
    let dueAt: String?
    /// The server's own pre-formatted day. Rendering the server's sentence
    /// rather than re-deriving it locally is the house rule, and the first
    /// build decoded this and then formatted `dueAt` itself anyway.
    let dueDay: String?
    let recommendation: String?
    let attempts: Int?

    var id: String { targetId.map(String.init) ?? "n:\(name ?? "?")" }

    /// The server's ranking, restated so the client cannot invent its own.
    /// followUp.js orders overdue(0) before due(1) before owed(2); the first
    /// build put `owed` on top and disagreed with the desk about which chase
    /// mattered most.
    var rank: Int {
        switch state {
        case "overdue": return 0
        case "due":     return 1
        case "owed":    return 2
        default:        return 3
        }
    }

    /// `owed` means they answered and we have not. It carries no dueAt at
    /// all (followUp.js returns none), so the first build's approach of
    /// colouring the due-date text red rendered red onto an empty string and
    /// the most urgent state in the app had no visible marker whatsoever.
    var isOwed: Bool { state == "owed" }
    var isOverdue: Bool { state == "overdue" }
    var isDue: Bool { state == "due" }
}

struct FollowUps: Decodable {
    let rows: [ChaseRow]?
    /// When the next chase comes due. The server ships this precisely so an
    /// empty panel can say when that changes instead of being a dead end.
    let nextDueAt: String?
}

struct ProjectStub: Decodable, Identifiable {
    let id: Int
    let ticker: String?
    let name: String?
    let status: String?
}

struct ProjectFull: Decodable {
    let id: Int
    let ticker: String?
    let name: String?
    let followUps: FollowUps?
}

/// One line of work, whatever produced it. Today is a task list, and a task
/// list does not care which table a row came from.
///
/// Named WorkItem, not Task: a type called Task shadows the concurrency Task
/// in every file that can see it, so `Task { await … }` silently resolves to
/// this struct's memberwise init and the errors land on unrelated lines.
struct WorkItem: Identifiable {
    enum Kind { case owed, overdue, due }

    let id: String
    let title: String
    let detail: String
    let due: String?
    let kind: Kind
    let source: String
    let projectId: Int?

    var rank: Int {
        switch kind {
        case .overdue: return 0
        case .due:     return 1
        case .owed:    return 2
        }
    }
}

// MARK: The wire

struct Wire: Decodable {
    let articles: [Article]?
    /// False means nobody scored these headlines, which is a different
    /// fact from "nothing is breaking today" and must not be shown as one.
    let classified: Bool?
    let sources: Sources?

    struct Sources: Decodable { let feeds: [Feed]? }
}

struct Article: Decodable, Identifiable {
    let title: String?
    let url: String?
    let source: String?
    let publishedAt: String?
    /// 0 to 10, how genuinely breaking the headline is. Scored on the
    /// headline text alone, which is why the server age-gates the merge
    /// first: the scorer cannot know a crash headline is stale.
    let breaking: Double?
    let breakingReason: String?
    /// Set when the headline mentions a portfolio company, so the club's
    /// own names stand out on the wire.
    let heldTicker: String?

    var id: String { url ?? title ?? UUID().uuidString }
    var isBreaking: Bool { (breaking ?? 0) >= 7 }
}

/// Per-feed roll call. A wire that returns zero items is not an error and
/// will never throw, which is exactly how one served the same fifteen
/// headlines for eighteen months and counted as healthy throughout.
struct Feed: Decodable, Identifiable {
    let id: String?
    let source: String?
    let items: Int?
    let newest: String?
}

// MARK: The watchlist

struct Watchlist: Decodable {
    let items: [WatchItem]?
    let quotesAvailable: Bool?
}

struct WatchItem: Decodable, Identifiable {
    let id: String?
    let ticker: String?
    let name: String?
    /// holding | seg13f | manual. Three different claims about how much
    /// attention a name deserves, which is why the screen groups rather
    /// than sorts.
    let source: String?
    let note: String?
    let weight: Double?
    let alsoHeld: Bool?
    let quote: Quote?
    let stats: Stats?

    struct Quote: Decodable {
        let last: Double?
        let changePct: Double?
        let prevClose: Double?
        let asOf: String?
        let stale: Bool?
    }
    struct Stats: Decodable {
        let avgVolume20d: Double?
        let pct1m: Double?
        let pct3m: Double?
        let pct1y: Double?
        let ytd: Double?
    }
}

// MARK: One contact

struct Target: Decodable {
    let id: Int?
    let name: String?
    let relationship: String?
    let employer: String?
    let role: String?
    let channel: String?
    let email: String?
    let tier: String?
    let status: String?
    let project: Project?
    let messages: [TargetMessage]?
    let drafts: [Draft]?
    let followUp: FollowUpState?

    struct Project: Decodable {
        let id: Int?
        let name: String?
        let ticker: String?
    }
}

struct FollowUpState: Decodable {
    let state: String?
    let recommendation: String?
    let dueAt: String?
    let dueDay: String?
}

struct TargetMessage: Decodable {
    /// "in" or "out". The single most important fact about a message and
    /// the one a wall of grey text hides.
    let direction: String?
    let kind: String?
    let subject: String?
    let body: String?
    let occurredAt: String?
}

/// Read-only, deliberately. The phone shows what state a draft is in and
/// offers no way to act on it: sending lives at the desk, where the
/// screening and the approvals are.
struct Draft: Decodable {
    let id: Int?
    let subject: String?
    let stage: String?
    let sentAt: String?
    let screenedAt: String?
    let screenRisk: String?
    let fullyApproved: Bool?
}

// MARK: Dashboard glances

/// The post-close summary. Written once a day by a cron at 4:05pm ET and
/// served from cache, which is exactly the shape of a thing worth putting
/// on a phone: one paragraph, after the close, that you read and close.
struct DayInReview: Decodable {
    let dayInReview: String?
    let dayInReviewAt: String?
    let reviewDay: String?
}

/// MOVR. `rows` arrives already sorted by the day's move, best first, so
/// the top and bottom of the same array are the gainers and the losers.
struct Movers: Decodable {
    let rows: [Mover]?
    let asOf: String?
    let positions: Int?
    /// Positions the sheet could not price. A panel showing three of
    /// thirteen holdings must not read as a three-holding book.
    let unpriced: Int?
}

struct Mover: Decodable, Identifiable {
    let ticker: String?
    let name: String?
    /// A FRACTION here, not a percentage. sheetPortfolio computes it as
    /// dayUsd / prior and does not scale it, while /quotes and
    /// /period-returns hand back percent — the units genuinely differ by
    /// endpoint, and passing this straight to Fmt.pct renders a 2.34% move
    /// as "+0.02%".
    let changePct: Double?
    /// The wire name is `dayUsd`. This decoded as `dayChange` and therefore
    /// as nil on every row since it was written — silently, because the
    /// field is not rendered anywhere yet. Named correctly now so that the
    /// first screen to show a dollar move gets a number instead of a dash.
    let dayUsd: Double?
    let last: Double?
    let source: String?

    var id: String { ticker ?? name ?? "?" }
    var changePercent: Double? { changePct.map { $0 * 100 } }
}

// MARK: Price history

struct ChartPayload: Decodable {
    let ticker: String?
    let range: String?
    let points: [Point]?
    /// The handler forwards the whole OHLCV bar. Only the close is decoded
    /// here: a phone line chart has no use for the other four, and every
    /// field decoded is a field that can change shape underneath us.
    struct Point: Decodable {
        let t: Double?
        let close: Double?
    }
}

/// What a watchlist add returns. Not depended on: the screen re-reads the
/// list afterwards, so this only has to decode without throwing.
struct AddReceipt: Decodable {
    let id: Int?
    let ticker: String?
}

// MARK: What a company files and reports

struct FilingsPayload: Decodable {
    let ticker: String?
    let filings: [Filing]?
}

struct Filing: Decodable, Identifiable {
    let form: String?
    let filingDate: String?
    let description: String?
    let accessionNumber: String?
    let url: String?
    /// The accession number is the only genuinely unique thing here: one
    /// company files several 8-Ks on one day, so form-plus-date collides.
    var id: String { accessionNumber ?? "\(form ?? "?")-\(filingDate ?? "?")" }

    /// The forms worth noticing at a glance. An 8-K is an event, and an
    /// event is the only filing that behaves like news.
    var isEvent: Bool { (form ?? "").hasPrefix("8-K") }
    var isAnnual: Bool { (form ?? "").hasPrefix("10-K") }
}

struct Estimates: Decodable {
    let upcoming: Upcoming?
    let history: [Past]?

    struct Upcoming: Decodable {
        let date: String?
        let epsEstimate: Double?
    }
    struct Past: Decodable, Identifiable {
        let period: String?
        let date: String?
        let epsEstimate: Double?
        let epsActual: Double?
        let surprisePct: Double?
        var id: String { period ?? date ?? "?" }
        /// Beat, missed, or neither. Derived from the two numbers rather
        /// than from surprisePct, which is absent on older rows.
        var beat: Bool? {
            guard let a = epsActual, let e = epsEstimate else { return nil }
            return a == e ? nil : a > e
        }
    }
}

struct Consensus: Decodable {
    let latest: Row?
    struct Row: Decodable {
        let strongBuy: Int?
        let buy: Int?
        let hold: Int?
        let sell: Int?
        let strongSell: Int?
        var total: Int {
            (strongBuy ?? 0) + (buy ?? 0) + (hold ?? 0) + (sell ?? 0) + (strongSell ?? 0)
        }
        var bullish: Int { (strongBuy ?? 0) + (buy ?? 0) }
        var bearish: Int { (sell ?? 0) + (strongSell ?? 0) }
    }
}
