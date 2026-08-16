import Foundation

// Decodables are written from the server handler, never from the JSX.
// Every field optional: this app must render something useful against a
// payload that gained or lost a key, rather than failing the whole screen.

struct Totals: Decodable { let totalValue: Double?; let cashValue: Double? }
struct Holding: Decodable, Identifiable {
    let ticker: String?; let name: String?; let shares: Double?
    let price: Double?; let marketValue: Double?; let costBasis: Double?
    // The server sends dayChange, an absolute per-share dollar move, and
    // no percentage anywhere. dayChangePct exists only as a local inside
    // HoldingDetailModal.jsx, which is exactly the JSX this file is
    // forbidden to read models from: the wrong key decodes to nil and the
    // column silently never renders.
    let dayChange: Double?; let isCash: Bool?
    /// Identity must be stable across reads. A UUID() fallback mints a new
    /// one on every diff pass, so SwiftUI tears the row down and rebuilds
    /// it forever. Absent both keys, the row has no identity and says so.
    var id: String { ticker ?? name ?? "unidentified" }
    /// Percent of position value, derived rather than trusted, and nil
    /// unless both halves are present and the base is real.
    var dayChangePct: Double? {
        guard let dc = dayChange, let sh = shares, let mv = marketValue,
              mv != 0, sh != 0 else { return nil }
        let prior = mv - (dc * sh)
        guard prior > 0 else { return nil }
        return (mv - prior) / prior * 100
    }
}
struct Book: Decodable { let holdings: [Holding]?; let totals: Totals? }

struct ChaseRow: Decodable, Identifiable {
    let targetId: Int?; let name: String?; let state: String?
    let dueAt: String?; let dueDay: String?; let recommendation: String?
    let attempts: Int?; let autoReplyReset: Bool?
    /// String.hashValue is seeded per process, so it is not stable across
    /// launches and collides for two rows with the same nil targetId.
    var id: String { targetId.map(String.init) ?? "n:\(name ?? "?")" }
    /// The three states worth a colour. `owed` means they answered and we
    /// have not, which outranks anything on a clock.
    var urgent: Bool { state == "overdue" || state == "owed" }
    var due: Bool { state == "due" }
}
struct FollowUps: Decodable { let rows: [ChaseRow]?; let nextDueAt: String? }
struct ProjectStub: Decodable, Identifiable {
    let id: Int; let ticker: String?; let name: String?; let status: String?
}
struct ProjectFull: Decodable {
    let id: Int; let ticker: String?; let name: String?
    let followUps: FollowUps?
}

/// One line of work, whatever produced it. Today is a task list, and a
/// task list does not care which table a row came from.
///
/// Named WorkItem, not Task: a type called Task shadows the concurrency
/// Task in every file that can see it, so `Task { await … }` silently
/// resolves to this struct's memberwise init and the errors land on
/// unrelated lines.
struct WorkItem: Identifiable {
    let id: String
    let title: String
    let detail: String
    let due: String?
    let urgent: Bool
    let source: String
}
