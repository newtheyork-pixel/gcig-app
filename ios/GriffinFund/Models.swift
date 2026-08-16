import Foundation

// Decodables are written from the server handler, never from the JSX.
// Every field optional: this app must render something useful against a
// payload that gained or lost a key, rather than failing the whole screen.

struct Totals: Decodable { let totalValue: Double?; let cashValue: Double? }
struct Holding: Decodable, Identifiable {
    let ticker: String?; let name: String?; let shares: Double?
    let price: Double?; let marketValue: Double?; let costBasis: Double?
    let dayChangePct: Double?; let isCash: Bool?
    var id: String { (ticker ?? name ?? UUID().uuidString) }
}
struct Book: Decodable { let holdings: [Holding]?; let totals: Totals? }

struct ChaseRow: Decodable, Identifiable {
    let targetId: Int?; let name: String?; let state: String?
    let dueAt: String?; let dueDay: String?; let recommendation: String?
    let attempts: Int?; let autoReplyReset: Bool?
    var id: Int { targetId ?? name.hashValue }
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
