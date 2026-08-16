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

    struct Pitch: Decodable, Identifiable {
        let id: Int?
        let date: String?
        let recommendation: String?
        let title: String?
        var stableId: String { id.map(String.init) ?? (date ?? "pitch") }
    }
    struct Report: Decodable {
        let title: String?
        let author: String?
        let date: String?
    }
    struct Research: Decodable {
        let name: String?
        let status: String?
        let analyst: String?
        let buyBelow: Double?
    }
    struct Decision: Decodable {
        let date: String?
        let action: String?
        let outcome: String?
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
