import SwiftUI

// RSCH / FLD — the research workspace, at parity with the web terminal.
//
// One fetch per project open: GET /research/projects/:id returns the
// whole workspace — questions with coverage, the outreach funnel with
// drafts and their approval state, interviews, visits, valuations, the
// claim ledger, artifacts. Every tab renders from that payload; writes
// re-fetch it, which is the web's onChanged pattern and the only way
// eight tabs stay in agreement about one project.
//
// The approval gate is re-implemented honestly rather than reproduced
// visually. Every rule that matters is enforced on the server, so this
// panel does not decide whether you may approve or send; it asks, shows
// what came back, and never renders a state as safer than the server
// called it. Two rules carried from the web that must never regress:
// `unscreened` and `clear-keyword-only` are never shown as a pass, and
// Copy — the de-facto send button — stays shut until both sign-offs are
// in.
//
// Sources are aliases everywhere. The server never sends a real name in
// a citation and this panel renders exactly what it sends.
struct ResearchPanel: View {
    let ticker: String?

    @State private var projects: Loadable<[Project]> = .loading
    @State private var openID: Int?

    var body: some View {
        Group {
            if let id = openID {
                ProjectDetail(projectId: id, onBack: { openID = nil })
            } else {
                list
            }
        }
        .task(id: ticker) { await loadProjects() }
    }

    private var list: some View {
        PanelState(state: projects,
                   emptyWhen: { $0.isEmpty },
                   emptyText: "No research projects yet.",
                   retry: { Task { await loadProjects() } }) { ps in
            let shown = ticker.map { t in
                ps.filter { $0.ticker?.uppercased() == t.uppercased() }
            } ?? ps
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    SectionLabel(text: "Research projects")
                    Spacer()
                    if let t = ticker {
                        Text("scoped to \(t)").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                Divider().overlay(Term.border)

                if shown.isEmpty {
                    PanelMessage(text: "No project for \(ticker ?? "that ticker"). Type RSCH for all of them.")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(shown) { p in
                                Button { openID = p.id } label: {
                                    HStack(spacing: 8) {
                                        Text(p.ticker ?? "—")
                                            .font(Term.mono(11, weight: .bold))
                                            .foregroundStyle(Term.amber)
                                            .frame(width: 62, alignment: .leading)
                                        Text(p.name)
                                            .font(Term.mono(11)).foregroundStyle(Term.white)
                                            .lineLimit(1)
                                        Spacer(minLength: 6)
                                        Text("\(p.counts?.interviews ?? 0) calls · \(p.counts?.artifacts ?? 0) files")
                                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                        Text(p.status)
                                            .font(Term.mono(9)).foregroundStyle(Term.fgDim)
                                            .frame(width: 62, alignment: .trailing)
                                        Text(Fmt.date(p.updatedAt))
                                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                            .frame(width: 66, alignment: .trailing)
                                    }
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                                .overlay(alignment: .bottom) {
                                    Rectangle().fill(Term.border).frame(height: 1)
                                }
                            }
                        }
                    }
                    Text("Projects are created on the web terminal.")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                }
            }
        }
    }

    private func loadProjects() async {
        projects = .loading
        do {
            let data = try await API.shared.get("/research/projects")
            if let list = try? await API.shared.decode([Project].self, from: data) {
                projects = .loaded(list)
            } else {
                struct Wrap: Decodable { let projects: [Project] }
                projects = .loaded(try await API.shared.decode(Wrap.self, from: data).projects)
            }
        } catch {
            projects = .failed(error.localizedDescription)
        }
    }
}

// MARK: Models
//
// Field names verified against server/src/routes/research.js — the
// decorate() shape on drafts, funnel() and assessCoverage() outputs, and
// the stamp/citation strings the claims are mapped through. Dates stay
// Strings and go through Fmt.date; nothing here does date math except
// the valuation staleness check, which parses deliberately.

struct Project: Decodable, Identifiable {
    let id: Int
    let name: String
    let ticker: String?
    let status: String
    let brief: String?
    let updatedAt: String?
    let counts: Counts?

    struct Counts: Decodable {
        let interviews: Int?
        let artifacts: Int?
    }

    enum CodingKeys: String, CodingKey {
        case id, name, ticker, status, brief, updatedAt
        case counts = "_count"
    }
}

/// An assumption value the server stored as a string, unless an older
/// row stored a bare number. Both render; neither crashes the decode of
/// the whole project.
struct FlexString: Decodable {
    let value: String
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else if let d = try? c.decode(Double.self) {
            value = d == d.rounded() ? String(Int(d)) : String(d)
        } else if let b = try? c.decode(Bool.self) { value = String(b) }
        else { value = "" }
    }
}

struct ProjectFull: Decodable {
    let id: Int
    let name: String
    let ticker: String?
    let brief: String?
    /// Three lines, newline-separated: what the project is trying to
    /// find out, shown above the question spine.
    let aims: String?
    let status: String?
    let transcriptionReady: Bool?
    let questions: [Question]?
    let targets: [Target]?
    let interviews: [Interview]?
    let visits: [Visit]?
    let valuations: [Valuation]?
    let artifacts: [Artifact]?
    let claims: [Claim]?
    let topics: [Topic]?
    let coverage: CoverageReport?
    let funnel: Funnel?
    let outreachQueue: Queue?

    struct Person: Decodable { let id: Int?; let name: String? }

    // SOURCE_PUBLIC on the server: alias, role, employer, relationship.
    // The real name is never in the payload, so it cannot leak here.
    struct Source: Decodable {
        let id: Int?
        let alias: String?
        let role: String?
        let employer: String?
        let relationship: String?
    }

    struct Question: Decodable, Identifiable {
        let id: Int
        let text: String
        let rationale: String?
        let rank: Int?
        let status: String?
    }

    struct CoverageReport: Decodable {
        let questions: [Row]?
        let summary: Summary?

        struct Row: Decodable, Identifiable {
            var id: Int { questionId }
            let questionId: Int
            let text: String?
            let status: String?
            let coverage: String?
            let claimCount: Int?
            let observationCount: Int?
            let distinctSources: Int?
            let independentLines: Int?
            let distinctLocations: Int?
            let factCount: Int?
            let opinionCount: Int?
            let forecastCount: Int?
        }

        struct Summary: Decodable {
            let total: Int?
            let unaddressed: Int?
            let thin: Int?
            let supported: Int?
            let contested: Int?
            let answeredByHuman: Int?
            let unlinkedClaims: Int?
            let openAndUnaddressed: Int?
        }
    }

    struct Claim: Decodable, Identifiable {
        let id: Int
        let text: String
        let quote: String?
        let topic: String?
        let kind: String?
        let origin: String?
        let questionId: Int?
        let verifiedById: Int?
        let extractionConfidence: Double?
        let stamp: String?
        let citation: String?
        let interview: InterviewRef?

        struct InterviewRef: Decodable {
            let id: Int?
            let title: String?
            let conductedAt: String?
            let source: Source?
        }
    }

    struct Topic: Decodable, Identifiable {
        var id: String { topic }
        let topic: String
        let support: String?
        let claimCount: Int?
        let distinctSources: Int?
        let independentLines: Int?
        let opinionCount: Int?
        let forecastCount: Int?
    }

    struct Interview: Decodable, Identifiable {
        let id: Int
        let title: String
        let conductedAt: String?
        let status: String?
        let durationMs: Int?
        let transcript: String?
        let transcriptModel: String?
        let consentObtained: Bool?
        let attestedAt: String?
        let mnpiRisk: String?
        let screenedAt: String?
        let quarantined: Bool?
        let quarantineNote: String?
        let reviewedAt: String?
        let reviewNote: String?
        let screenResult: ScreenResult?
        let source: Source?
        let counts: Counts?

        struct Counts: Decodable { let claims: Int? }

        struct ScreenResult: Decodable {
            let risk: String?
            let reason: String?
            let modelAvailable: Bool?
            let hits: [Hit]?
            struct Hit: Decodable { let why: String?; let excerpt: String? }
        }

        enum CodingKeys: String, CodingKey {
            case id, title, conductedAt, status, durationMs, transcript, transcriptModel,
                 consentObtained, attestedAt, mnpiRisk, screenedAt, quarantined,
                 quarantineNote, reviewedAt, reviewNote, screenResult, source
            case counts = "_count"
        }
    }

    struct Visit: Decodable, Identifiable {
        let id: Int
        let location: String
        let banner: String?
        let visitedAt: String?
        let dayPart: String?
        let weather: String?
        let notes: String?
        let visitor: Person?
        let siteObservations: [Observation]?

        struct Observation: Decodable, Identifiable {
            let id: Int
            let text: String
            let kind: String?
            let questionId: Int?
        }
    }

    struct Valuation: Decodable, Identifiable {
        let id: Int
        let kind: String?
        let name: String
        let bear: Double?
        let base: Double?
        let bull: Double?
        let priceAtWrite: Double?
        let currency: String?
        let buyBelow: Double?
        let reviewBy: String?
        let alertedAt: String?
        let watchers: [String]?
        let note: String?
        let asOf: String?
        let assumptions: [Assumption]?
        let createdBy: Person?

        struct Assumption: Decodable {
            let label: String?
            let value: FlexString?
            let unit: String?
            let note: String?
            let claimId: Int?
        }
    }

    struct Artifact: Decodable, Identifiable {
        let id: Int
        let kind: String?
        let title: String
        let fileRef: String?
        let filename: String?
        let body: String?
        let note: String?
        /// The handful that carry the argument. Absent on an older
        /// payload, so it decodes as nil and reads as false.
        let keyDoc: Bool?
        let createdAt: String?
        let uploadedBy: Person?
    }

    struct Funnel: Decodable {
        let identified: Int?
        let contacted: Int?
        let scheduled: Int?
        let completed: Int?
        let declined: Int?
        let unreachable: Int?
        let total: Int?
        let attempted: Int?
        let conversionPct: Int?

        enum CodingKeys: String, CodingKey {
            case identified = "Identified"
            case contacted = "Contacted"
            case scheduled = "Scheduled"
            case completed = "Completed"
            case declined = "Declined"
            case unreachable = "Unreachable"
            case total, attempted, conversionPct
        }
    }

    struct Queue: Decodable {
        let awaitingReview: Int?
        let awaitingMe: Int?
        let readyToSend: Int?
        let rejected: Int?
        let sent: Int?
        let screenBlocked: Int?
        let screenElevated: Int?
        let unscreened: Int?
        let keywordOnly: Int?
    }
}

struct Target: Decodable, Identifiable {
    let id: Int
    let name: String
    let employer: String?
    let role: String?
    let email: String?
    let channel: String?
    let tier: String?
    let relationship: String
    let status: String
    let priority: Int?
    let notes: String?
    let lastContactAt: String?
    let drafts: [Draft]?
    let messages: [Message]?
}

/// One message in the correspondence, either direction. Kinds rather
/// than free text because the ones that matter imply different next
/// moves: an out-of-office is not a no, a bounce is a dead address, a
/// decline is an answer, and only interest leads anywhere.
struct Message: Decodable, Identifiable {
    let id: Int
    let draftId: Int?
    let direction: String?
    let kind: String
    let occurredAt: String
    let body: String?
    let action: String?
    let recordedBy: ProjectFull.Person?

    var outbound: Bool { direction == "out" }

    /// Label, colour and the sentence explaining what the kind means.
    var display: (String, Color, String) {
        if outbound {
            switch kind {
            case "Scheduling": return ("WE SENT DATES", Term.blue, "Times offered, waiting on them to pick")
            case "Reply":      return ("WE REPLIED", Term.blue, "We answered something they asked")
            case "FollowUp":   return ("WE FOLLOWED UP", Term.blue, "A chase on an email with no answer")
            default:           return ("WE SENT", Term.fgMuted, "Anything else we sent")
            }
        }
        switch kind {
        case "Interested": return ("INTERESTED", Term.positive, "They are willing to talk")
        case "Declined":   return ("DECLINED", Term.negative, "They said no. The target closes")
        case "Bounce":     return ("BOUNCED", Term.negative, "Dead address. The target is unreachable")
        case "AutoReply":  return ("AUTO-REPLY", Term.amber, "Out of office. Nobody has read it yet, so this is still waiting")
        default:           return ("OTHER", Term.fgMuted, "Did not clearly fit the other kinds")
        }
    }
}

struct Draft: Decodable, Identifiable {
    let id: Int
    let subject: String
    let body: String
    let stage: String?
    let approvalCount: Int?
    let approvalsNeeded: Int?
    let approvedByNames: [String]?
    let canIApprove: Bool?
    let iApproved: Bool?
    let fullyApproved: Bool?
    let screenBlocked: Bool?
    let screenState: String?
    let screenReason: String?
    let screenFindings: Findings?
    let sentAt: String?
    let rejectedAt: String?
    let reviewNote: String?
    let sentBy: ProjectFull.Person?
    let rejectedBy: ProjectFull.Person?

    struct Findings: Decodable {
        let hits: [Hit]?
        let concerns: [String]?
        struct Hit: Decodable { let why: String?; let excerpt: String? }
    }
}

/// GET /terminal/quotes payload: ticker → {last, changePct, prevClose}
/// or null when the vendor had nothing. The route never 5xxs; a bad day
/// is an empty object.
struct LiveQuote: Decodable {
    let last: Double?
    let changePct: Double?
}

// MARK: Writes
//
// The shared API actor speaks GET and POST; the research routes also
// need PATCH (target status, question status, draft edits) and DELETE
// (withdrawing an approval). Its transport internals are private to
// Core, and this panel owns exactly one file — so the two extra verbs
// are implemented here with the same contract: Keychain token, silent
// X-New-Token rotation, and the server's own error sentence surfaced
// instead of a generic failure. If a third panel ever needs these verbs
// they belong on the actor, and this enum should be deleted.
private enum ResearchHTTP {
    struct WriteError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func patch(_ path: String, json: [String: Any]) async throws {
        try await send("PATCH", path, json: json)
    }

    static func delete(_ path: String) async throws {
        try await send("DELETE", path, json: nil)
    }

    private static func send(_ method: String, _ path: String, json: [String: Any]?) async throws {
        let base = ProcessInfo.processInfo.environment["GRIFFIN_API"]
            ?? "https://gcig-api.onrender.com/api"
        guard let url = URL(string: base + path) else {
            throw WriteError(message: "Bad URL for \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let t = TokenStore.read() {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }

        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw WriteError(message: "Could not reach the server. \(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse else {
            throw WriteError(message: "No HTTP response.")
        }
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token"), !fresh.isEmpty {
            TokenStore.write("jwt", fresh)
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw WriteError(message: "Session expired. Sign in again.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { $0?["error"] as? String } ?? "Server returned \(http.statusCode)."
            throw WriteError(message: msg)
        }
    }
}

/// The action runner every write goes through: do the thing, then
/// re-fetch the project so all eight tabs agree again.
private typealias RunAction = (@escaping @MainActor @Sendable () async throws -> Void) async -> Void

// MARK: Shared style tables
//
// Ported from the web's constant maps so a state renders identically in
// every tab that mentions it.

private enum CoverageStyle {
    static func tone(_ s: String?) -> Color {
        switch s {
        case "supported": return Term.positive
        case "thin":      return Term.amber
        case "contested": return Term.negative
        default:          return Term.fgMuted
        }
    }
    static func label(_ s: String?) -> String {
        switch s {
        case "supported": return "SUPPORTED"
        case "thin":      return "THIN"
        case "contested": return "CONTESTED"
        default:          return "NO EVIDENCE"
        }
    }
    static func edge(_ s: String?) -> Color {
        s == "unaddressed" || s == nil ? Term.border : tone(s)
    }
}

private enum SupportStyle {
    static func tone(_ s: String?) -> Color {
        switch s {
        case "corroborated": return Term.positive
        case "clustered":    return Term.amber
        case "contested":    return Term.negative
        default:             return Term.fgMuted
        }
    }
    static func label(_ s: String?) -> String {
        switch s {
        case "corroborated":  return "CORROBORATED"
        case "clustered":     return "SAME EMPLOYER"
        case "single-source": return "SINGLE SOURCE"
        case "contested":     return "CONTESTED"
        default:              return (s ?? "").uppercased()
        }
    }
}

// The compliance verdict on a draft, and the two states that must never
// be mistaken for a pass. `unscreened` means nothing has read this yet;
// `clear-keyword-only` means the model was unreachable and only the
// crude pass ran. Presenting either as "clear" is the failure this
// whole screen exists to avoid.
private enum ScreenStyle {
    static func label(_ s: String?) -> String {
        switch s {
        case "prohibited":         return "BLOCKED"
        case "elevated":           return "FLAGGED"
        case "clear":              return "screened"
        case "clear-keyword-only": return "part-screened"
        default:                   return "unscreened"
        }
    }
    static func tone(_ s: String?) -> Color {
        switch s {
        case "prohibited":         return Term.negative
        case "elevated":           return Term.orange
        case "clear":              return Term.positive
        case "clear-keyword-only": return Term.orange
        default:                   return Term.fgMuted
        }
    }
    /// The row-level explanation the web attaches to anything short of a
    /// clean screen — a flag that does not say what it caught reads as a
    /// vague accusation.
    static func caption(_ d: Draft) -> String? {
        switch d.screenState {
        case "elevated", "prohibited":
            return d.screenReason
        case "clear-keyword-only":
            return "Model was unreachable. Only the keyword pass ran, so this is not a clean read."
        case "unscreened":
            return "Nothing has read this yet."
        default:
            return nil
        }
    }
}

private enum StageStyle {
    static func label(_ d: Draft) -> String {
        switch d.stage {
        case "sent":         return "SENT"
        case "rejected":     return "REJECTED"
        case "blocked":      return "BLOCKED"
        case "ready":        return "READY"
        case "one-approval": return "1 of \(d.approvalsNeeded ?? 2)"
        default:             return "\(d.approvalCount ?? 0) of \(d.approvalsNeeded ?? 2)"
        }
    }
    static func tone(_ d: Draft) -> Color {
        switch d.stage {
        case "ready":               return Term.positive
        case "rejected", "blocked": return Term.negative
        case "sent":                return Term.fgMuted
        case "one-approval":        return Term.amber
        default:                    return Term.fgDim
        }
    }
}

// MARK: Small shared views and helpers

private struct Chip: View {
    let label: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Term.mono(9, weight: active ? .bold : .regular))
                .tracking(0.5)
                .foregroundStyle(active ? Term.white : Term.fgMuted)
                .underline(active)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A coloured left edge makes state scannable down a list without
/// reading a single label — the web leans on this everywhere.
private struct EdgeRow<Content: View>: View {
    let tone: Color
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Rectangle().fill(tone).frame(width: 2)
            content()
        }
    }
}

private struct TierChip: View {
    let tier: String?
    var body: some View {
        if let t = tier, !t.isEmpty {
            // White for the people who were actually there; everyone
            // else is context. The label is free text, so an
            // unrecognised tier still renders rather than vanishing.
            let tone: Color = {
                switch t.lowercased() {
                case "witness":  return Term.white
                case "baseline": return Term.cyan
                default:         return Term.fgDim
                }
            }()
            Text(t.uppercased())
                .font(Term.mono(9)).foregroundStyle(tone)
                .padding(.horizontal, 4).padding(.vertical, 1)
                .overlay(Rectangle().strokeBorder(tone, lineWidth: 1))
        }
    }
}

private struct ScreenChip: View {
    let draft: Draft
    var body: some View {
        if draft.screenState != nil {
            Text(ScreenStyle.label(draft.screenState))
                .font(Term.mono(9))
                .foregroundStyle(ScreenStyle.tone(draft.screenState))
                .help(draft.screenReason ?? "")
        }
    }
}

/// Where a draft has got to, at a glance, with anything short of a
/// clean screen explained on the row rather than behind a hover.
private struct StageChip: View {
    let draft: Draft?

    var body: some View {
        if let d = draft {
            VStack(alignment: .trailing, spacing: 1) {
                HStack(spacing: 6) {
                    Text(StageStyle.label(d))
                        .font(Term.mono(9, weight: .bold))
                        .foregroundStyle(StageStyle.tone(d))
                        .help(d.approvedByNames?.isEmpty == false
                              ? "Approved by \(d.approvedByNames!.joined(separator: ", "))" : "")
                    ScreenChip(draft: d)
                }
                if let why = ScreenStyle.caption(d) {
                    Text(why)
                        .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
            }
        } else {
            // "No draft" is a real state and gets said, rather than an
            // empty cell that reads like a rendering bug.
            Text("no draft").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
    }
}

private func fmtDuration(_ ms: Int?) -> String? {
    guard let ms, ms > 0 else { return nil }
    let m = ms / 60_000
    if m < 1 { return "<1m" }
    if m < 60 { return "\(m)m" }
    return "\(m / 60)h \(m % 60)m"
}

private func isPastISO(_ iso: String?) -> Bool {
    guard let iso else { return false }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let d else { return false }
    return d < Date()
}

private func moneyCcy(_ v: Double?, _ ccy: String?) -> String {
    guard let v else { return "—" }
    let c = (ccy ?? "USD").uppercased()
    return c == "USD" ? "$\(Fmt.money(v))" : "\(c) \(Fmt.money(v))"
}

/// Target notes are "HEADING\ntext" blocks separated by blank lines —
/// the whole correspondence record lives there. Anything that doesn't
/// match the shape is shown as-is rather than dropped, so an older
/// record stays readable.
private func noteSections(_ notes: String?) -> [(heading: String?, body: String)] {
    guard let notes, !notes.isEmpty else { return [] }
    func isHeading(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count >= 4, let f = t.first, f.isUppercase else { return false }
        return t.allSatisfy { ($0.isUppercase && $0.isASCII) || " -/&".contains($0) }
    }
    var out: [(String?, String)] = []
    for block in notes.components(separatedBy: "\n\n") {
        let b = block.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !b.isEmpty else { continue }
        if let nl = b.firstIndex(of: "\n") {
            let head = String(b[..<nl])
            if isHeading(head) {
                out.append((head.trimmingCharacters(in: .whitespaces),
                            String(b[b.index(after: nl)...]).trimmingCharacters(in: .whitespacesAndNewlines)))
                continue
            }
        }
        out.append((nil, b))
    }
    return out
}

// MARK: Detail

private enum RTab: String, CaseIterable {
    case questions, outreach, interviews, visits, valuation, ledger, files, compliance

    func title(_ p: ProjectFull) -> String {
        switch self {
        case .questions:  return "QUESTIONS (\(p.questions?.count ?? 0))"
        case .outreach:   return "OUTREACH (\(p.funnel?.total ?? p.targets?.count ?? 0))"
        case .interviews: return "INTERVIEWS (\(p.interviews?.count ?? 0))"
        case .visits:     return "VISITS (\(p.visits?.count ?? 0))"
        case .valuation:  return "VALUATION (\(p.valuations?.count ?? 0))"
        case .ledger:     return "LEDGER (\(p.claims?.count ?? 0))"
        case .files:      return "FILES (\(p.artifacts?.count ?? 0))"
        case .compliance: return "COMPLIANCE"
        }
    }

    /// Badge counts say where the work is, not how much furniture is
    /// behind a tab — mirrored from the web's tab computations.
    func badge(_ p: ProjectFull) -> Int {
        switch self {
        case .questions:
            return p.coverage?.summary?.unaddressed ?? 0
        case .outreach:
            // A draft waiting on YOUR signature blocks someone else, so
            // it outranks the funnel; falls back to ready-to-send.
            let q = p.outreachQueue
            let me = q?.awaitingMe ?? 0
            return me > 0 ? me : (q?.readyToSend ?? 0)
        case .compliance:
            return (p.interviews ?? []).filter {
                $0.reviewedAt == nil &&
                (($0.quarantined ?? false) || ($0.mnpiRisk ?? "low") != "low" || !($0.consentObtained ?? false))
            }.count
        default:
            return 0
        }
    }
}

private struct ProjectDetail: View {
    let projectId: Int
    let onBack: () -> Void

    @State private var state: Loadable<ProjectFull> = .loading
    @State private var tab: RTab = .questions
    @State private var busy = false
    @State private var err: String?
    @State private var openTargetID: Int?
    @State private var readerArtifactID: Int?
    /// A stored file being read in place. Identifiable so the viewer can
    /// be driven from one piece of state rather than two half-set ones.
    struct OpenFile: Identifiable { let itemId: String; let title: String; var id: String { itemId } }
    @State private var openFile: OpenFile?
    @State private var readerInterviewID: Int?
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button("← Projects", action: onBack).buttonStyle(TermButtonStyle())
                if case .loaded(let p) = state {
                    Text(p.ticker ?? "").font(Term.mono(12, weight: .bold)).foregroundStyle(Term.amber)
                    Text(p.name).font(Term.mono(11)).foregroundStyle(Term.fgDim).lineLimit(1)
                }
                Spacer()
                if busy {
                    ProgressView().controlSize(.small).tint(Term.amber)
                }
                Button("Refresh") { Task { await load(initial: false) } }
                    .buttonStyle(TermButtonStyle())
                    .disabled(busy)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Divider().overlay(Term.border)

            if let err {
                Text(err).font(Term.mono(10)).foregroundStyle(Term.negative)
                    .padding(.horizontal, 10).padding(.top, 4)
                    .textSelection(.enabled)
            }

            PanelState(state: state, retry: { Task { await load(initial: true) } }) { p in
                if let f = openFile {
                    DocumentViewer(itemId: f.itemId, title: f.title, onBack: { openFile = nil })
                } else if let a = (p.artifacts ?? []).first(where: { $0.id == readerArtifactID }) {
                    ArtifactReader(artifact: a, onBack: { readerArtifactID = nil })
                } else if let iv = (p.interviews ?? []).first(where: { $0.id == readerInterviewID }) {
                    TranscriptReader(interview: iv, onBack: { readerInterviewID = nil })
                } else if let t = (p.targets ?? []).first(where: { $0.id == openTargetID }) {
                    TargetDetailView(target: t, busy: $busy, run: run, onBack: { openTargetID = nil })
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        headerBlock(p)
                        searchBar
                        // Search reaches ACROSS the tabs, so it sits
                        // above them and replaces the body while active.
                        // Two answers on screen at once is how a reader
                        // loses track of which one they are reading.
                        if query.trimmingCharacters(in: .whitespaces).isEmpty {
                            tabBar(p)
                            Divider().overlay(Term.border)
                            ScrollView {
                                tabContent(p)
                                    .padding(10)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else {
                            Divider().overlay(Term.border)
                            ScrollView {
                                SearchResultsView(project: p, query: query) { t, id in
                                    tab = t
                                    query = ""
                                    // Open the record itself, not just
                                    // the tab it happens to live on.
                                    if let id {
                                        switch t {
                                        case .outreach:   openTargetID = id
                                        case .files:      readerArtifactID = id
                                        case .interviews: readerInterviewID = id
                                        default:          break
                                        }
                                    }
                                }
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
            }
        }
        .task { await load(initial: true) }
    }

    // Brief, standing, and the compliance strip — what the project IS,
    // above the tabs that hold what it contains.
    @ViewBuilder
    private func headerBlock(_ p: ProjectFull) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let brief = p.brief, !brief.isEmpty {
                Text(brief)
                    .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                    .lineLimit(2)
                    .help(brief)
            }
            ProjectStatusBar(p: p)
            ComplianceStripView(interviews: p.interviews ?? [], onOpen: { tab = .compliance })
            if p.transcriptionReady == false {
                // Say it here rather than letting someone find out at
                // the end of a long upload on the web.
                Text("Transcription is not configured on the API — recordings can still be attached as files.")
                    .font(Term.mono(9)).foregroundStyle(Term.negative)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    private func tabBar(_ p: ProjectFull) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(RTab.allCases, id: \.self) { t in
                    let badge = t.badge(p)
                    Button { tab = t } label: {
                        HStack(spacing: 4) {
                            Text(t.title(p))
                                .font(Term.mono(10, weight: tab == t ? .bold : .regular))
                                .tracking(0.5)
                                .foregroundStyle(tab == t ? Term.amber : Term.fgDim)
                            if badge > 0 {
                                Text("\(badge)")
                                    .font(Term.mono(9, weight: .bold))
                                    .foregroundStyle(Term.orange)
                                    .help("\(badge) outstanding")
                            }
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(tab == t ? Term.bgPanelHover : Color.clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private func tabContent(_ p: ProjectFull) -> some View {
        switch tab {
        case .questions:
            CoverageTab(p: p, busy: $busy, run: run)
        case .outreach:
            OutreachTab(p: p, busy: $busy, run: run, onOpenTarget: { openTargetID = $0 })
        case .interviews:
            InterviewsTab(p: p, onOpenTranscript: { readerInterviewID = $0 })
        case .visits:
            VisitsTab(p: p)
        case .valuation:
            ValuationTab(p: p)
        case .ledger:
            LedgerTab(p: p, busy: $busy, run: run)
        case .files:
            FilesTab(p: p, busy: $busy, run: run,
                     onOpenArtifact: { readerArtifactID = $0 },
                     onOpenFile: { id, title in openFile = OpenFile(itemId: id, title: title) })
        case .compliance:
            ComplianceTab(p: p)
        }
    }

    // One fetch per open; a soft reload after writes keeps the current
    // content on screen instead of flashing back to a spinner. The
    // three fetch states stay distinct: initial failures fail the
    // panel, refresh failures land in the error line above content the
    // reader can still see.
    private func load(initial: Bool) async {
        if initial { state = .loading }
        do {
            let data = try await API.shared.get("/research/projects/\(projectId)")
            let p = try await API.shared.decode(ProjectFull.self, from: data)
            state = .loaded(p)
            if !initial { err = nil }
        } catch {
            if initial { state = .failed(error.localizedDescription) }
            else { err = error.localizedDescription }
        }
    }

    private var searchBar: some View {
        HStack(spacing: 6) {
            Text("/").font(Term.mono(12, weight: .bold)).foregroundStyle(Term.orange)
            TextField("", text: $query,
                      prompt: Text("Search everything in this project")
                          .foregroundStyle(Term.fgMuted))
                .textFieldStyle(.plain)
                .font(Term.mono(11))
                .foregroundStyle(Term.amber)
                .onKeyPress(.escape) {
                    if query.isEmpty { return .ignored }
                    query = ""
                    return .handled
                }
            if !query.isEmpty {
                Button("clear") { query = "" }
                    .buttonStyle(.plain)
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Term.bg)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private func run(_ action: @escaping @MainActor @Sendable () async throws -> Void) async {
        busy = true; err = nil
        do { try await action(); await load(initial: false) }
        catch { err = error.localizedDescription }
        busy = false
    }
}

// Where the project actually stands: the questions in the proportion
// they are actually in, then the counts that represent outstanding work
// coloured so they do not compete with the furniture.
private struct ProjectStatusBar: View {
    let p: ProjectFull

    var body: some View {
        let s = p.coverage?.summary
        let supported = s?.supported ?? 0
        let thin = s?.thin ?? 0
        let contested = s?.contested ?? 0
        let none = s?.unaddressed ?? 0
        let total = supported + thin + contested + none

        let interviews = p.interviews?.count ?? 0
        let transcribed = (p.interviews ?? []).filter { $0.transcript?.isEmpty == false }.count
        let claims = p.claims?.count ?? 0
        let unlinked = s?.unlinkedClaims ?? 0

        VStack(alignment: .leading, spacing: 4) {
            if total > 0 {
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        Rectangle().fill(Term.positive)
                            .frame(width: geo.size.width * CGFloat(supported) / CGFloat(total))
                        Rectangle().fill(Term.amber)
                            .frame(width: geo.size.width * CGFloat(thin) / CGFloat(total))
                        Rectangle().fill(Term.negative)
                            .frame(width: geo.size.width * CGFloat(contested) / CGFloat(total))
                        Rectangle().fill(Term.border)
                            .frame(width: geo.size.width * CGFloat(none) / CGFloat(total))
                    }
                }
                .frame(height: 5)
                .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
            }
            HStack(spacing: 12) {
                if total > 0 {
                    stat(supported, "supported", Term.positive)
                    stat(thin, "thin", Term.amber)
                    if contested > 0 { stat(contested, "contested", Term.negative) }
                    stat(none, "no evidence", none > 0 ? Term.white : Term.fgMuted)
                }
                stat(interviews, interviews == 1 ? "interview" : "interviews", Term.white)
                // An interview with no transcript is logged work, not
                // evidence — the two counts drifting apart is the thing
                // worth seeing.
                if transcribed != interviews {
                    stat(interviews - transcribed, "awaiting transcript", Term.amber)
                }
                stat(claims, claims == 1 ? "claim" : "claims", Term.white)
                if unlinked > 0 { stat(unlinked, "answering nothing asked", Term.amber) }
                Spacer()
            }
        }
    }

    private func stat(_ n: Int, _ label: String, _ tone: Color) -> some View {
        HStack(spacing: 3) {
            Text("\(n)").font(Term.mono(10, weight: .bold)).foregroundStyle(tone)
            Text(label).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
        }
    }
}

// Compliance at a glance, above the tabs. Silence is the normal state
// and should read as reassurance, not as an absence of checking — the
// all-clear is stated, never implied by a blank strip.
private struct ComplianceStripView: View {
    let interviews: [ProjectFull.Interview]
    let onOpen: () -> Void

    var body: some View {
        if !interviews.isEmpty {
            let quarantined = interviews.filter { $0.quarantined ?? false }.count
            let elevated = interviews.filter { !($0.quarantined ?? false) && $0.mnpiRisk == "elevated" }.count
            let unscreened = interviews.filter { $0.screenedAt == nil }.count
            let noConsent = interviews.filter { !($0.consentObtained ?? false) }.count
            let clean = quarantined == 0 && elevated == 0 && unscreened == 0 && noConsent == 0

            HStack(spacing: 12) {
                Text("MNPI").font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.fgMuted)
                if clean {
                    Text("\(interviews.count) interview\(interviews.count == 1 ? "" : "s") screened · none flagged")
                        .font(Term.mono(9)).foregroundStyle(Term.positive)
                } else {
                    chip("QUARANTINED", quarantined, Term.negative,
                         "Screened as containing material non-public information. Claims excluded from the ledger.")
                    chip("ELEVATED", elevated, Term.amber,
                         "Brushes something sensitive, or the source is a current employee. Read before citing.")
                    chip("UNSCREENED", unscreened, Term.amber,
                         "No MNPI screen has run on this transcript yet.")
                    chip("NO CONSENT", noConsent, Term.negative,
                         "Consent to record was never recorded for this interview.")
                    Text("of \(interviews.count)").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                Spacer()
            }
            .padding(.vertical, 3)
            .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1) }
            .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
        }
    }

    // A count with no way through to the thing counted is a dead end —
    // every chip opens the tab that explains it.
    @ViewBuilder
    private func chip(_ label: String, _ n: Int, _ tone: Color, _ title: String) -> some View {
        if n > 0 {
            Button(action: onOpen) {
                Text("\(label): \(n)")
                    .font(Term.mono(9)).tracking(0.5)
                    .foregroundStyle(tone)
                    .underline(true, pattern: .dot)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("\(title) Click to review.")
        }
    }
}

// MARK: Questions / Coverage
//
// The question spine — the first thing a reader should see, because
// "which questions are still open with nothing behind them" is next
// week's call list.

private struct CoverageTab: View {
    let p: ProjectFull
    @Binding var busy: Bool
    let run: RunAction

    private enum QFilter: CaseIterable { case all, open, none, done }
    @State private var filter: QFilter = .all
    @State private var openQ: Int?
    @State private var newQ = ""
    /// The question being reworded, and the working text. A question is
    /// a hypothesis, and hypotheses get sharper as the evidence lands —
    /// a spine you can only append to silently rewards leaving a badly
    /// worded question up rather than fixing it.
    @State private var editingQ: Int?
    @State private var editText = ""
    @State private var editingAims = false
    @State private var aimsText = ""

    var body: some View {
        let rows = p.coverage?.questions ?? []
        let s = p.coverage?.summary

        VStack(alignment: .leading, spacing: 10) {
            aimsBlock

            // Adding a question is the one edit the spine needs weekly.
            HStack(spacing: 6) {
                TextField("What do we need to find out? (one question)", text: $newQ)
                    .textFieldStyle(.plain)
                    .font(Term.mono(11)).foregroundStyle(Term.white)
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .background(Term.bg).termBorder()
                    .onSubmit { if !newQ.isEmpty { addQuestion() } }
                Button("Add") { addQuestion() }
                    .buttonStyle(TermButtonStyle())
                    .disabled(busy || newQ.isEmpty)
            }

            if rows.count > 6 {
                HStack(spacing: 12) {
                    Chip(label: "ALL \(rows.count)", active: filter == .all) { filter = .all }
                    Chip(label: "STILL OPEN \(rows.filter { $0.coverage == "unaddressed" || $0.coverage == "thin" }.count)",
                         active: filter == .open) { filter = .open }
                    Chip(label: "NO EVIDENCE \(s?.unaddressed ?? 0)", active: filter == .none) { filter = .none }
                    Chip(label: "SUPPORTED \(s?.supported ?? 0)", active: filter == .done) { filter = .done }
                }
            }

            if rows.isEmpty {
                PanelMessage(text: "No questions yet. Write what the project is meant to answer before the calls start — it is what tells you when you are done.")
            } else {
                let shown = rows.filter(matches)
                if shown.isEmpty {
                    // A filter that matches nothing is good news here,
                    // and a blank pane does not say so.
                    Text(filter == .done ? "Nothing is fully supported yet." : "None — nothing outstanding in this bucket.")
                        .font(Term.mono(11)).foregroundStyle(Term.positive)
                } else {
                    ForEach(shown) { row in
                        questionRow(row)
                    }
                }
            }

            Text("Memo drafting and the tape scan for unanswered questions run on the web terminal.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
    }

    private func commitEdit(_ q: ProjectFull.CoverageReport.Row) {
        let t = editText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t != (q.text ?? "") else { editingQ = nil; return }
        editingQ = nil
        Task { await run {
            try await ResearchHTTP.patch("/research/questions/\(q.questionId)", json: ["text": t])
        } }
    }

    /// The point, above the questions that serve it. The brief is prose
    /// and gets read once; twenty questions are the work but not the
    /// point, and somebody opening this tab cannot see the point
    /// through them.
    private var aimsBlock: some View {
        let lines = (p.aims ?? "").split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                SectionLabel(text: "What we are trying to find out")
                Button(editingAims ? "cancel" : (lines.isEmpty ? "add" : "edit")) {
                    aimsText = p.aims ?? ""
                    editingAims.toggle()
                }
                .buttonStyle(.plain)
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                Spacer()
            }

            if editingAims {
                TextField("One aim per line, three at most.", text: $aimsText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(Term.mono(11)).foregroundStyle(Term.amber)
                    .lineLimit(3...6)
                    .padding(6).background(Term.bg)
                    .overlay(Rectangle().strokeBorder(Term.borderFocus, lineWidth: 1))
                HStack(spacing: 8) {
                    Button("Save") { saveAims() }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                    Text("\(aimsText.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count) of 3 · anything past the third line is dropped")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
            } else if lines.isEmpty {
                Text("Not stated yet. Three lines, before the questions — if it takes more than three, the project has not decided what it is.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(i + 1))").font(Term.mono(11)).foregroundStyle(Term.orange)
                        Text(line).font(Term.mono(11)).foregroundStyle(Term.white)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            Rectangle().fill(Term.border).frame(height: 1).padding(.top, 4)
        }
    }

    private func saveAims() {
        let next = aimsText.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.prefix(3).joined(separator: "\n")
        editingAims = false
        guard next != (p.aims ?? "") else { return }
        Task { await run {
            try await ResearchHTTP.patch("/research/projects/\(p.id)", json: ["aims": next])
        } }
    }

    private func matches(_ q: ProjectFull.CoverageReport.Row) -> Bool {
        switch filter {
        case .all:  return true
        case .open: return q.coverage == "unaddressed" || q.coverage == "thin"
        case .none: return q.coverage == "unaddressed"
        case .done: return q.coverage == "supported"
        }
    }

    private func questionRow(_ q: ProjectFull.CoverageReport.Row) -> some View {
        let claims = (p.claims ?? []).filter { $0.questionId == q.questionId }
        let expandable = !claims.isEmpty
        let expanded = openQ == q.questionId

        return EdgeRow(tone: CoverageStyle.edge(q.coverage)) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(CoverageStyle.label(q.coverage))
                        .font(Term.mono(9, weight: .bold)).tracking(0.5)
                        .foregroundStyle(CoverageStyle.tone(q.coverage))
                        .frame(width: 80, alignment: .leading)
                    // A coverage label is a summary of evidence, and a
                    // summary nobody can open is just an assertion.
                    if editingQ == q.questionId {
                        // Amber while editable, per the chrome contract.
                        TextField("", text: $editText, axis: .vertical)
                            .textFieldStyle(.plain)
                            .font(Term.mono(11)).foregroundStyle(Term.amber)
                            .padding(.horizontal, 5).padding(.vertical, 3)
                            .background(Term.bg)
                            .overlay(Rectangle().strokeBorder(Term.borderFocus, lineWidth: 1))
                            .onSubmit { commitEdit(q) }
                        Button("Save") { commitEdit(q) }
                            .buttonStyle(TermButtonStyle())
                            .disabled(busy || editText.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button("Cancel") { editingQ = nil }
                            .buttonStyle(.plain)
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    } else {
                        Button {
                            if expandable { openQ = expanded ? nil : q.questionId }
                        } label: {
                            Text((expandable ? (expanded ? "▾ " : "▸ ") : "") + (q.text ?? ""))
                                .font(Term.mono(11)).foregroundStyle(Term.white)
                                .multilineTextAlignment(.leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Spacer(minLength: 6)
                        Button {
                            editText = q.text ?? ""
                            editingQ = q.questionId
                        } label: {
                            Text("edit").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                        .help("Reword this question")
                    }
                    // The row keeps the one number that says whether
                    // there is anything here at all; the breakdown moves
                    // to the tooltip.
                    Text((q.claimCount ?? 0) > 0 ? "\(q.claimCount ?? 0)" : "—")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                        .help(detailTooltip(q))
                    // Closing a question is a person's call. Coverage
                    // informs it; it never makes it.
                    Button {
                        let next = q.status == "Answered" ? "Open" : "Answered"
                        Task { await run {
                            try await ResearchHTTP.patch("/research/questions/\(q.questionId)", json: ["status": next])
                        } }
                    } label: {
                        Text(q.status == "Answered" ? "✓ answered" : "mark answered")
                            .font(Term.mono(9))
                            .foregroundStyle(q.status == "Answered" ? Term.positive : Term.fgMuted)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .help(q.status == "Answered" ? "Reopen this question" : "Mark this question answered")
                }

                // The answer itself, not just a count of answers — the
                // best claim inline, the rest one click away.
                if !expanded, let top = claims.max(by: { ($0.extractionConfidence ?? 0) < ($1.extractionConfidence ?? 0) }) {
                    Text(top.text)
                        .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                        .lineLimit(1)
                        .padding(.leading, 88)
                        .help(top.quote.map { "“\($0)”" } ?? "")
                }

                if expanded {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(claims) { c in
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(c.origin == "answer-scan" ? "scan" : "extract")\(c.topic == "answer (partial)" ? " · answers part of it" : "") · \(c.stamp ?? "")")
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                Text(c.text).font(Term.mono(11)).foregroundStyle(Term.white)
                                    .textSelection(.enabled)
                                if let quote = c.quote {
                                    Text("“\(quote)”")
                                        .font(Term.mono(10)).italic().foregroundStyle(Term.fgDim)
                                        .textSelection(.enabled)
                                }
                                Text(c.citation ?? "")
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            }
                        }
                    }
                    .padding(.leading, 88)
                    .padding(.vertical, 4)
                }
            }
        }
        .padding(.vertical, 3)
        .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
    }

    private func detailTooltip(_ q: ProjectFull.CoverageReport.Row) -> String {
        var bits: [String] = []
        let n = q.claimCount ?? 0
        bits.append("\(n) claim\(n == 1 ? "" : "s")")
        bits.append("\(q.independentLines ?? 0) independent line\((q.independentLines ?? 0) == 1 ? "" : "s")")
        if let o = q.observationCount, o > 0 {
            bits.append("\(o) observed at \(q.distinctLocations ?? 0) site\((q.distinctLocations ?? 0) == 1 ? "" : "s")")
        }
        if let f = q.forecastCount, f > 0 { bits.append("\(f) forecast") }
        return bits.joined(separator: " · ")
    }

    private func addQuestion() {
        let text = newQ
        Task { await run {
            _ = try await API.shared.post("/research/projects/\(p.id)/questions",
                                          json: ["text": text, "rank": (p.questions?.count ?? 0) + 1])
            newQ = ""
        } }
    }
}

// MARK: Outreach

private struct OutreachTab: View {
    let p: ProjectFull
    @Binding var busy: Bool
    let run: RunAction
    let onOpenTarget: (Int) -> Void

    private enum TFilter: Equatable { case all, status(String), dead }
    @State private var only: TFilter = .all

    private static let statuses = [
        "Identified", "Contacted", "Scheduled", "Completed", "Declined", "Unreachable",
    ]

    var body: some View {
        let targets = p.targets ?? []
        let fn = p.funnel
        let q = p.outreachQueue

        VStack(alignment: .leading, spacing: 10) {
            // The funnel: "who haven't we tried yet" is the number that
            // actually paces a project.
            Text("\(fn?.identified ?? 0) not yet tried · \(fn?.contacted ?? 0) contacted · \(fn?.scheduled ?? 0) scheduled · \(fn?.completed ?? 0) done · \((fn?.declined ?? 0) + (fn?.unreachable ?? 0)) dead\(fn?.conversionPct.map { " · \($0)% conversion" } ?? "")")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)

            // Approval and compliance state on one line, because
            // "approved" and "screened" are different claims and a
            // reader who sees only the first will assume the second.
            queueLine(q)

            if targets.count > 8 {
                HStack(spacing: 12) {
                    Chip(label: "ALL \(targets.count)", active: only == .all) { only = .all }
                    Chip(label: "NOT TRIED \(fn?.identified ?? 0)", active: only == .status("Identified")) { only = .status("Identified") }
                    Chip(label: "WAITING \(fn?.contacted ?? 0)", active: only == .status("Contacted")) { only = .status("Contacted") }
                    Chip(label: "SCHEDULED \(fn?.scheduled ?? 0)", active: only == .status("Scheduled")) { only = .status("Scheduled") }
                    Chip(label: "DONE \(fn?.completed ?? 0)", active: only == .status("Completed")) { only = .status("Completed") }
                    Chip(label: "DEAD \((fn?.declined ?? 0) + (fn?.unreachable ?? 0))", active: only == .dead) { only = .dead }
                }
            }

            let shown = targets.filter(matches)
            if targets.isEmpty {
                PanelMessage(text: "No targets yet. The list is built on the web terminal — map the value chain, then work it.")
            } else if shown.isEmpty {
                // An empty bucket is good news here, and a blank table
                // does not say so.
                Text("None in this bucket.").font(Term.mono(11)).foregroundStyle(Term.positive)
            } else {
                ForEach(shown) { t in
                    targetRow(t)
                }
            }

            Text("Adding targets and writing first drafts happen on the web terminal; everything about working the list is here.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
    }

    private func matches(_ t: Target) -> Bool {
        switch only {
        case .all: return true
        case .dead: return t.status == "Declined" || t.status == "Unreachable"
        case .status(let s): return t.status == s
        }
    }

    @ViewBuilder
    private func queueLine(_ q: ProjectFull.Queue?) -> some View {
        let notScreened = (q?.unscreened ?? 0) + (q?.keywordOnly ?? 0)
        if let q, (q.awaitingReview ?? 0) + (q.readyToSend ?? 0) + (q.rejected ?? 0)
            + (q.screenBlocked ?? 0) + (q.screenElevated ?? 0) + notScreened > 0 {
            HStack(spacing: 12) {
                if let n = q.awaitingMe, n > 0 {
                    Text("\(n) waiting on your approval").foregroundStyle(Term.white)
                }
                if let n = q.awaitingReview, n > 0 {
                    Text("\(n) awaiting sign-off").foregroundStyle(Term.fgDim)
                }
                if let n = q.readyToSend, n > 0 {
                    Text("\(n) approved, ready to send").foregroundStyle(Term.positive)
                }
                if let n = q.rejected, n > 0 {
                    Text("\(n) rejected").foregroundStyle(Term.negative)
                }
                if let n = q.screenBlocked, n > 0 {
                    Text("\(n) blocked by the screen").foregroundStyle(Term.negative)
                }
                if let n = q.screenElevated, n > 0 {
                    Text("\(n) flagged for a read").foregroundStyle(Term.amber)
                }
                // Not-fully-screened is its own state and never folded
                // into "clear" — the whole point of the screen chips.
                if notScreened > 0 {
                    Text("\(notScreened) not fully screened").foregroundStyle(Term.orange)
                }
                Spacer()
            }
            .font(Term.mono(10))
        }
    }

    private func targetRow(_ t: Target) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(t.priority.map(String.init) ?? "—")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                .frame(width: 20, alignment: .trailing)
            Button { onOpenTarget(t.id) } label: {
                Text(t.name)
                    .font(Term.mono(11, weight: .medium)).foregroundStyle(Term.amber)
                    .lineLimit(1)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
            .help("Open the full record")
            .frame(width: 140, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                TierChip(tier: t.tier)
                Text(t.relationship).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            .frame(width: 110, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(t.employer ?? "—")
                    .font(Term.mono(10)).foregroundStyle(Term.fgDim).lineLimit(1)
                Text(t.email ?? (t.channel.map { String($0.prefix(40)) } ?? "no address"))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(1)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 6)
            StageChip(draft: t.drafts?.first)
                .frame(width: 160, alignment: .trailing)
            // The status writes straight through — moving a name off
            // "Identified" also stamps lastContactAt on the server.
            statusMenu(t)
                .frame(width: 92, alignment: .trailing)
            Text(t.lastContactAt.map { Fmt.date($0) } ?? "—")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                .frame(width: 62, alignment: .trailing)
        }
        .padding(.vertical, 4)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
    }

    private func statusMenu(_ t: Target) -> some View {
        Menu {
            ForEach(Self.statuses, id: \.self) { s in
                Button(s) {
                    Task { await run {
                        try await ResearchHTTP.patch("/research/targets/\(t.id)", json: ["status": s])
                    } }
                }
            }
        } label: {
            Text(t.status).font(Term.mono(9)).foregroundStyle(Term.fgDim)
        }
        .menuStyle(.borderlessButton)
        .disabled(busy)
        .help("Move \(t.name) through the funnel")
    }
}

// Everything held on one outreach contact. The notes field carries the
// whole correspondence in labelled sections — why they were approached,
// the email sent, their reply, the outcome — because the reply is the
// part that decides what to do next.
private struct TargetDetailView: View {
    let target: Target
    @Binding var busy: Bool
    let run: RunAction
    let onBack: () -> Void

    private static let statuses = [
        "Identified", "Contacted", "Scheduled", "Completed", "Declined", "Unreachable",
    ]

    var body: some View {
        let t = target
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Button("← Outreach", action: onBack).buttonStyle(TermButtonStyle())
                    Menu {
                        ForEach(Self.statuses, id: \.self) { s in
                            Button(s) {
                                Task { await run {
                                    try await ResearchHTTP.patch("/research/targets/\(t.id)", json: ["status": s])
                                } }
                            }
                        }
                    } label: {
                        Text("STATUS: \(t.status.uppercased())")
                            .font(Term.mono(10)).foregroundStyle(Term.white)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(busy)
                    Spacer()
                }

                HStack(spacing: 8) {
                    Text(t.name).font(Term.mono(13, weight: .bold)).foregroundStyle(Term.white)
                    if let pri = t.priority {
                        Text("#\(pri) TO CALL").font(Term.mono(9)).tracking(0.5).foregroundStyle(Term.fgMuted)
                    }
                }

                Text([t.role, t.employer].compactMap { $0 }.joined(separator: " · ").isEmpty
                     ? "No title or employer recorded"
                     : [t.role, t.employer].compactMap { $0 }.joined(separator: " · "))
                    .font(Term.mono(11)).foregroundStyle(Term.fgDim)

                HStack(spacing: 10) {
                    TierChip(tier: t.tier)
                    Text(t.relationship).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    if let email = t.email, let url = URL(string: "mailto:\(email)") {
                        Link(email, destination: url)
                            .font(Term.mono(10)).foregroundStyle(Term.white)
                    } else {
                        Text("no address on file").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    }
                    if let ch = t.channel {
                        Text(ch).font(Term.mono(10)).foregroundStyle(Term.fgMuted).lineLimit(1)
                    }
                    Text(t.lastContactAt.map { "last contact \(Fmt.date($0))" } ?? "never contacted")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    Spacer()
                }

                DraftsSection(target: t, busy: $busy, run: run)

                let sections = noteSections(t.notes)
                if sections.isEmpty {
                    Text("Nothing recorded beyond the name.")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                } else {
                    ForEach(Array(sections.enumerated()), id: \.offset) { _, s in
                        VStack(alignment: .leading, spacing: 2) {
                            if let h = s.heading {
                                Text(h).font(Term.mono(9, weight: .bold)).tracking(0.6)
                                    .foregroundStyle(Term.amber)
                            }
                            ScrollView {
                                Text(s.body)
                                    .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                                    .lineSpacing(3)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            // The sent email runs long; cap it so the
                            // reply below stays reachable.
                            .frame(maxHeight: 240)
                            .padding(.leading, 8)
                            .overlay(alignment: .leading) { Rectangle().fill(Term.border).frame(width: 2) }
                        }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// The outreach email and its two sign-offs. The app does not send the
// mail — it goes from a real person's school address — so what this
// panel owes the user is the text, verbatim and copyable, plus an
// honest account of who has signed off and who has not.
private struct DraftsSection: View {
    let target: Target
    @Binding var busy: Bool
    let run: RunAction

    @State private var composing = false
    @State private var subject = ""
    @State private var bodyText = ""

    var body: some View {
        let drafts = target.drafts ?? []
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("OUTREACH EMAIL").font(Term.mono(9, weight: .bold)).tracking(0.6)
                    .foregroundStyle(Term.white)
                if !composing {
                    Button(drafts.isEmpty ? "Write one" : "New draft") {
                        subject = ""; bodyText = ""; composing = true
                    }
                    .buttonStyle(TermButtonStyle())
                    .disabled(busy)
                }
                Spacer()
            }

            if composing {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Subject", text: $subject)
                        .textFieldStyle(.plain)
                        .font(Term.mono(11)).foregroundStyle(Term.white)
                        .padding(6).background(Term.bg).termBorder()
                    TextEditor(text: $bodyText)
                        .font(Term.mono(11)).foregroundStyle(Term.white)
                        .lineSpacing(3)
                        .scrollContentBackground(.hidden)
                        .autocorrectionDisabled()
                        .frame(minHeight: 160)
                        .padding(4).background(Term.bg).termBorder()
                    HStack(spacing: 6) {
                        Button("Save draft") {
                            let s = subject, b = bodyText
                            Task { await run {
                                _ = try await API.shared.post("/research/targets/\(target.id)/drafts",
                                                              json: ["subject": s, "body": b])
                                composing = false
                            } }
                        }
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy || subject.isEmpty || bodyText.isEmpty)
                        Button("Cancel") { composing = false }.buttonStyle(TermButtonStyle())
                        Text("Anything written here needs two sign-offs before it can go out.")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    }
                }
            } else if drafts.isEmpty {
                Text("Nothing drafted. Anything written here needs two sign-offs before it can go out.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }

            ForEach(drafts) { d in
                DraftCard(draft: d, target: target,
                          messages: (target.messages ?? []).filter { $0.draftId == d.id },
                          busy: $busy, run: run)
            }
        }
        .padding(.top, 8)
        .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1) }
    }
}

private struct DraftCard: View {
    let draft: Draft
    let target: Target
    /// Only this draft's messages. A target can carry several drafts and
    /// a message belongs under the email it answers, not under all of
    /// them. Declared here because the memberwise init follows
    /// declaration order and the call site passes it third.
    var messages: [Message] = []
    @Binding var busy: Bool
    let run: RunAction

    @State private var logging = false
    @State private var replyKind = "AutoReply"
    @State private var replyOut = false
    @State private var replyWhen = ""
    @State private var replyBody = ""
    @State private var replyAction = ""
    @State private var editing = false
    @State private var subject = ""
    @State private var bodyText = ""
    @State private var rejecting = false
    @State private var rejectNote = ""
    @State private var copied = false

    var body: some View {
        let d = draft
        VStack(alignment: .leading, spacing: 6) {
            // The state line must never overstate where a draft has got
            // to — "ready" on something with one approval is how an
            // unreviewed email goes out.
            stateLine(d)

            HStack(spacing: 6) {
                ScreenChip(draft: d)
                if let r = d.screenReason {
                    Text(r).font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(2)
                }
                if d.screenState == "clear-keyword-only" || d.screenState == "unscreened" {
                    Button("run the full screen") {
                        Task { await run {
                            _ = try await API.shared.post("/research/drafts/\(d.id)/screen", json: [:])
                        } }
                    }
                    .buttonStyle(.plain)
                    .font(Term.mono(9)).foregroundStyle(Term.amber)
                    .disabled(busy)
                }
                Spacer()
            }

            // What the screen actually found — a verdict nobody can act
            // on gets clicked past.
            let hits = d.screenFindings?.hits ?? []
            let concerns = d.screenFindings?.concerns ?? []
            if !hits.isEmpty || !concerns.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(hits.enumerated()), id: \.offset) { _, h in
                        Text("· \(h.why ?? "")\(h.excerpt.map { " — “\(String($0.prefix(90)))”" } ?? "")")
                            .font(Term.mono(9)).foregroundStyle(Term.fgDim)
                    }
                    ForEach(Array(concerns.enumerated()), id: \.offset) { _, c in
                        Text("· \(c)").font(Term.mono(9)).foregroundStyle(Term.fgDim)
                    }
                }
            }

            if editing {
                TextField("Subject", text: $subject)
                    .textFieldStyle(.plain)
                    .font(Term.mono(11)).foregroundStyle(Term.white)
                    .padding(6).background(Term.bg).termBorder()
                TextEditor(text: $bodyText)
                    .font(Term.mono(11)).foregroundStyle(Term.white)
                    .lineSpacing(3)
                    .scrollContentBackground(.hidden)
                    .autocorrectionDisabled()
                    .frame(minHeight: 180)
                    .padding(4).background(Term.bg).termBorder()
                // Said before they commit: fixing a typo on a
                // fully-approved draft costs both sign-offs.
                if (d.approvalCount ?? 0) > 0 {
                    Text("Saving a change clears \((d.approvalCount ?? 0) == 1 ? "the approval" : "both approvals") — the draft goes back for review.")
                        .font(Term.mono(9)).foregroundStyle(Term.negative)
                }
                HStack(spacing: 6) {
                    Button("Save") {
                        let s = subject, b = bodyText
                        Task { await run {
                            try await ResearchHTTP.patch("/research/drafts/\(d.id)", json: ["subject": s, "body": b])
                            editing = false
                        } }
                    }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
                    Button("Cancel") { editing = false }.buttonStyle(TermButtonStyle())
                }
            } else {
                Text(d.subject).font(Term.mono(11, weight: .medium)).foregroundStyle(Term.white)
                    .textSelection(.enabled)
                ScrollView {
                    Text(d.body)
                        .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 260)
            }

            if !editing && d.sentAt == nil {
                HStack(spacing: 6) {
                    if d.canIApprove == true {
                        Button("Approve") {
                            Task { await run {
                                _ = try await API.shared.post("/research/drafts/\(d.id)/approve", json: [:])
                            } }
                        }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                    }
                    if d.iApproved == true {
                        Text("you approved this").font(Term.mono(9)).foregroundStyle(Term.positive)
                        // Withdrawing is a first-class action: someone
                        // who thinks better of a sign-off must be able
                        // to say so without editing the text out from
                        // under the other approver.
                        Button("Withdraw") {
                            Task { await run {
                                try await ResearchHTTP.delete("/research/drafts/\(d.id)/approve")
                            } }
                        }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                    }
                    if d.canIApprove == true {
                        Button("Reject") { rejecting.toggle() }
                            .buttonStyle(TermButtonStyle()).disabled(busy)
                    }
                    Button("Edit") {
                        subject = d.subject; bodyText = d.body; editing = true
                    }
                    .buttonStyle(TermButtonStyle()).disabled(busy)

                    // Copy is the send button, so it stays shut until
                    // the server says both signatures are in. A greyed
                    // control with a reason teaches the rule; a hidden
                    // one just looks broken.
                    Button(copied ? "Copied" : "Copy to send") {
                        let text = "Subject: \(d.subject)\n\n\(d.body)"
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                        copied = true
                        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
                    }
                    .buttonStyle(TermButtonStyle())
                    .disabled(d.fullyApproved != true)
                    .help(d.fullyApproved == true
                          ? "Copy, then send from your school address to \(target.email ?? "them")"
                          : "Needs two approvals first")

                    if d.fullyApproved == true {
                        Button("Mark sent") {
                            Task { await run {
                                _ = try await API.shared.post("/research/drafts/\(d.id)/sent", json: [:])
                            } }
                        }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                    }
                    Spacer()
                }
            }

            if d.sentAt != nil { replyLog(d) }

            if rejecting {
                HStack(spacing: 6) {
                    TextField("What is wrong with it?", text: $rejectNote)
                        .textFieldStyle(.plain)
                        .font(Term.mono(11)).foregroundStyle(Term.white)
                        .padding(6).background(Term.bg).termBorder()
                    Button("Confirm reject") {
                        let note = rejectNote
                        Task { await run {
                            _ = try await API.shared.post("/research/drafts/\(d.id)/reject", json: ["note": note])
                            rejecting = false
                            rejectNote = ""
                        } }
                    }
                    .buttonStyle(TermButtonStyle())
                    .disabled(busy || rejectNote.isEmpty)
                }
            }
        }
        .padding(8)
        .background(Term.bg)
        .termBorder()
    }

    /// What came back, sitting under the email it answers.
    ///
    /// Three states that must never look alike: nothing back at all, an
    /// automatic reply that means nobody has read it yet, and a real
    /// answer. A card that showed none of them made a sent email and a
    /// silent one identical, which is how a batch of thirteen reads as
    /// progress on a week when every address bounced.
    @ViewBuilder
    private func replyLog(_ d: Draft) -> some View {
        let heard = messages.filter { !$0.outbound && $0.kind != "AutoReply" }
        let last = messages.last
        VStack(alignment: .leading, spacing: 6) {
            Divider().overlay(Term.border)
            HStack(spacing: 8) {
                Text("CORRESPONDENCE")
                    .font(Term.mono(9, weight: .bold)).tracking(0.6)
                    .foregroundStyle(Term.white)
                Button("Log a reply") { beginLog(out: false) }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
                Button("Log what we sent") { beginLog(out: true) }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
                Spacer()
            }

            // Whose turn it is, in one line. Sent-and-silent is not
            // sent-and-answered, an out-of-office is neither, and a reply
            // we have not answered is the opposite failure to silence.
            if messages.isEmpty {
                Text("No reply yet. Sent \(Fmt.date(d.sentAt ?? "")), waiting on them.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            } else if let last, !last.outbound, last.kind != "AutoReply" {
                Text("Their move was last. We owe them a reply.")
                    .font(Term.mono(10)).foregroundStyle(Term.positive)
            } else if heard.isEmpty {
                Text("Only an automatic reply so far. Nobody has read this yet, so it is still waiting.")
                    .font(Term.mono(10)).foregroundStyle(Term.amber)
            } else {
                Text("We wrote last. Waiting on them.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }

            // The first email is part of the thread and belongs at the
            // top of it, or the log opens mid-conversation.
            HStack(spacing: 8) {
                Text("WE SENT THE FIRST EMAIL")
                    .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.blue)
                Text(Fmt.date(d.sentAt ?? ""))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                Spacer()
            }

            ForEach(messages) { r in
                let (label, tone, help) = r.display
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(label).font(Term.mono(9, weight: .bold)).tracking(0.5)
                            .foregroundStyle(tone).help(help)
                        Text(Fmt.date(r.occurredAt) + (r.recordedBy?.name.map { " · logged by \($0)" } ?? ""))
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        Spacer()
                        Button("remove") {
                            Task { await run { try await ResearchHTTP.delete("/research/messages/\(r.id)") } }
                        }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                    }
                    if let b = r.body, !b.isEmpty {
                        Text(b).font(Term.mono(10)).foregroundStyle(Term.fgDim)
                            .lineSpacing(3).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let a = r.action, !a.isEmpty {
                        Text("→ \(a)").font(Term.mono(10)).foregroundStyle(Term.white)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(6).background(Term.bg).termBorder()
                // Ours sit left, theirs indent. The shape of the thread
                // should answer "who said this" before the label is read.
                .padding(.leading, r.outbound ? 0 : 18)
            }

            if logging {
                HStack(spacing: 6) {
                    Picker("", selection: $replyKind) {
                        ForEach(replyOut ? Self.sentKinds : Self.replyKinds, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .labelsHidden().frame(width: 170)
                    // When the message happened, not when it is being
                    // typed in. Logging a day late is normal and a
                    // defaulted stamp would put a false number under
                    // every interval measured off it.
                    TextField("YYYY-MM-DD HH:MM", text: $replyWhen)
                        .textFieldStyle(.plain)
                        .font(Term.mono(10)).foregroundStyle(Term.white)
                        .padding(5).background(Term.bg).termBorder()
                        .frame(width: 170)
                        .help("When the message happened, not when you are logging it")
                    Spacer()
                }
                Text(kindConsequence)
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                TextEditor(text: $replyBody)
                    .font(Term.mono(10)).foregroundStyle(Term.white)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 60)
                    .padding(4).background(Term.bg).termBorder()
                TextField(replyOut ? "Why we sent it (optional)" : "What we do about it (optional)", text: $replyAction)
                    .textFieldStyle(.plain)
                    .font(Term.mono(10)).foregroundStyle(Term.white)
                    .padding(5).background(Term.bg).termBorder()
                HStack(spacing: 6) {
                    Button("Save") {
                        let kind = replyKind
                        let dir = replyOut ? "out" : "in"
                        let when = Self.iso(from: replyWhen) ?? replyWhen
                        let bodyIn = replyBody, actionIn = replyAction, draftID = d.id
                        Task { await run {
                            _ = try await API.shared.post(
                                "/research/targets/\(target.id)/messages",
                                json: ["kind": kind, "direction": dir, "occurredAt": when,
                                       "draftId": draftID, "body": bodyIn, "action": actionIn])
                            logging = false
                        } }
                    }
                    .buttonStyle(TermButtonStyle()).disabled(busy || replyWhen.isEmpty)
                    Button("Cancel") { logging = false }.buttonStyle(TermButtonStyle())
                    Spacer()
                }
            }
        }
    }

    /// Said where the choice is made: three of the received kinds move
    /// the target the moment they are saved, and nothing we send does.
    ///
    /// Built as a plain string rather than inline in the view because the
    /// chained conditionals defeated the SwiftUI type-checker outright.
    private var kindConsequence: String {
        let set = replyOut ? Self.sentKinds : Self.replyKinds
        var out = set.first { $0.0 == replyKind }?.2 ?? ""
        if replyOut {
            out += " — nothing we send changes the target status."
            return out
        }
        switch replyKind {
        case "Bounce":     out += " — saving this marks the target Unreachable."
        case "Declined":   out += " — saving this marks the target Declined."
        case "Interested": out += " — saving this marks the target Scheduled."
        default: break
        }
        return out
    }

    private func beginLog(out: Bool) {
        replyOut = out
        replyKind = out ? "Scheduling" : "AutoReply"
        replyWhen = Self.nowLocal()
        replyBody = ""
        replyAction = ""
        logging = true
    }

    private static let sentKinds: [(String, String, String)] = [
        ("Scheduling", "WE SENT DATES", "Times offered, waiting on them to pick"),
        ("Reply", "WE REPLIED", "We answered something they asked"),
        ("FollowUp", "WE FOLLOWED UP", "A chase on an email with no answer"),
        ("Other", "WE SENT", "Anything else we sent"),
    ]

    private static let replyKinds: [(String, String, String)] = [
        ("Interested", "INTERESTED", "They are willing to talk"),
        ("Declined", "DECLINED", "They said no. The target closes"),
        ("Bounce", "BOUNCED", "Dead address. The target becomes unreachable"),
        ("AutoReply", "AUTO-REPLY", "Out of office. Nobody has read it yet, so this is still waiting"),
        ("Other", "OTHER", "Anything that does not clearly fit"),
    ]

    /// Local wall-clock, which is what someone reading their inbox is
    /// looking at. Converted to an instant on the way out.
    private static func nowLocal() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.string(from: Date())
    }

    private static func iso(from local: String) -> String? {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        guard let d = f.date(from: local.trimmingCharacters(in: .whitespaces)) else { return nil }
        let out = ISO8601DateFormatter()
        out.formatOptions = [.withInternetDateTime]
        return out.string(from: d)
    }

    @ViewBuilder
    private func stateLine(_ d: Draft) -> some View {
        if let sent = d.sentAt {
            Text("SENT \(Fmt.date(sent))\(d.sentBy?.name.map { " by \($0)" } ?? "")")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.fgMuted)
        } else if d.rejectedAt != nil {
            Text("REJECTED by \(d.rejectedBy?.name ?? "someone") — \(d.reviewNote ?? "no reason given")")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.negative)
        } else if d.screenBlocked == true {
            Text("BLOCKED by the compliance screen — cannot be approved or sent as written")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.negative)
        } else if d.fullyApproved == true {
            Text("APPROVED by \((d.approvedByNames ?? []).joined(separator: " and ")) — ready to send")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.positive)
        } else {
            let names = d.approvedByNames ?? []
            Text("\(d.approvalCount ?? 0) of \(d.approvalsNeeded ?? 2) approvals\(names.isEmpty ? "" : " — \(names.joined(separator: ", "))")")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.fgDim)
        }
    }
}

// MARK: Interviews

private struct InterviewsTab: View {
    let p: ProjectFull
    let onOpenTranscript: (Int) -> Void

    var body: some View {
        let list = p.interviews ?? []
        VStack(alignment: .leading, spacing: 8) {
            if list.isEmpty {
                PanelMessage(text: "No interviews on this project yet.")
            } else {
                // What the list owes you, before scrolling it.
                let noTranscript = list.filter { !($0.quarantined ?? false) && ($0.transcript?.isEmpty ?? true) }.count
                let notExtracted = list.filter {
                    !($0.quarantined ?? false) && ($0.transcript?.isEmpty == false) && ($0.counts?.claims ?? 0) == 0
                }.count
                if noTranscript > 0 || notExtracted > 0 {
                    Text([
                        noTranscript > 0 ? "\(noTranscript) awaiting a transcript" : nil,
                        notExtracted > 0 ? "\(notExtracted) transcribed but never extracted" : nil,
                    ].compactMap { $0 }.joined(separator: " · "))
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                }

                ForEach(list) { iv in
                    interviewRow(iv)
                }
            }
            Text("Recording upload, transcript import and claim extraction run on the web terminal.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
    }

    private func interviewRow(_ iv: ProjectFull.Interview) -> some View {
        // The state of an interview is the thing you scan this list for
        // — which ones still owe you work.
        let claims = iv.counts?.claims ?? 0
        let edge: Color = (iv.quarantined ?? false) || !(iv.consentObtained ?? false)
            ? Term.negative
            : (iv.transcript?.isEmpty ?? true) || claims == 0 ? Term.amber : Term.positive

        return EdgeRow(tone: edge) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(iv.title).font(Term.mono(11)).foregroundStyle(Term.white)
                    // The next action, not a status noun. Quarantined
                    // renders flagged, never hidden.
                    if iv.quarantined ?? false {
                        Text("QUARANTINED").font(Term.mono(9, weight: .bold)).foregroundStyle(Term.negative)
                    } else if !(iv.consentObtained ?? false) {
                        Text("NO CONSENT").font(Term.mono(9, weight: .bold)).foregroundStyle(Term.negative)
                    } else if iv.transcript?.isEmpty ?? true {
                        Text("needs a transcript").font(Term.mono(9)).foregroundStyle(Term.amber)
                    } else if claims == 0 {
                        Text("not extracted yet").font(Term.mono(9)).foregroundStyle(Term.amber)
                    }
                    Spacer()
                    complianceChips(iv)
                    if iv.transcript?.isEmpty == false {
                        Button("Transcript") { onOpenTranscript(iv.id) }
                            .buttonStyle(TermButtonStyle())
                    }
                }
                HStack(spacing: 6) {
                    Text([
                        iv.source?.alias,
                        iv.source?.employer,
                        Fmt.date(iv.conductedAt),
                        fmtDuration(iv.durationMs),
                    ].compactMap { $0 }.joined(separator: " · "))
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    Text("\(claims) claims")
                        .font(Term.mono(9))
                        .foregroundStyle(claims > 0 ? Term.white : Term.fgMuted)
                }
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
    }

    // The compliance chips: risk, screen coverage, consent. A keyword-
    // only screen is named as such — it is never presented as a pass.
    @ViewBuilder
    private func complianceChips(_ iv: ProjectFull.Interview) -> some View {
        HStack(spacing: 6) {
            if let risk = iv.mnpiRisk, risk != "low" {
                Text("MNPI \(risk.uppercased())")
                    .font(Term.mono(8, weight: .bold))
                    .foregroundStyle(risk == "prohibited" ? Term.negative : Term.orange)
            }
            if iv.screenedAt == nil {
                Text("unscreened").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                    .help("No MNPI screen has run on this transcript yet.")
            } else if iv.screenResult?.modelAvailable == false {
                Text("keyword-only").font(Term.mono(8)).foregroundStyle(Term.orange)
                    .help("Only the keyword pass ran — the model was unavailable, so this is not a full clearance.")
            }
            if !(iv.consentObtained ?? false) {
                Text("no consent").font(Term.mono(8)).foregroundStyle(Term.negative)
            }
        }
    }
}

// The transcript, readable in place. Quarantined interviews stay
// readable — the quarantine is about citation, not about hiding the
// record from the people responsible for reviewing it — but the banner
// says exactly what state the reader is in.
private struct TranscriptReader: View {
    let interview: ProjectFull.Interview
    let onBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button("← Interviews", action: onBack).buttonStyle(TermButtonStyle())
                Text(interview.title).font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white).lineLimit(1)
                Text([
                    interview.source?.alias,
                    Fmt.date(interview.conductedAt),
                    interview.transcriptModel,
                ].compactMap { $0 }.joined(separator: " · "))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Divider().overlay(Term.border)

            if interview.quarantined ?? false {
                Text("QUARANTINED — \(interview.quarantineNote ?? "claims from this interview cannot be cited until a person releases it.")")
                    .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.negative)
                    .padding(.horizontal, 10).padding(.vertical, 4)
            }

            ScrollView {
                Text(interview.transcript ?? "No transcript.")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: Visits
//
// Going and looking rather than asking. Observations are counted toward
// question coverage but never merged with transcript claims: what
// someone saw has no tape to walk back to.

private struct VisitsTab: View {
    let p: ProjectFull

    var body: some View {
        let visits = p.visits ?? []
        VStack(alignment: .leading, spacing: 8) {
            if visits.isEmpty {
                PanelMessage(text: "No visits logged. For a retail name this is most of the work — and three different stores beat three trips to one.")
            } else {
                ForEach(visits) { v in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(v.location).font(Term.mono(11)).foregroundStyle(Term.white)
                            if let b = v.banner {
                                Text("· \(b)").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                            }
                            Spacer()
                        }
                        Text([
                            Fmt.date(v.visitedAt),
                            v.dayPart,
                            v.visitor?.name,
                            "\(v.siteObservations?.count ?? 0) observation\((v.siteObservations?.count ?? 0) == 1 ? "" : "s")",
                        ].compactMap { $0 }.joined(separator: " · "))
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        if let n = v.notes, !n.isEmpty {
                            Text(n).font(Term.mono(10)).foregroundStyle(Term.fgDim)
                                .textSelection(.enabled)
                        }
                        ForEach(v.siteObservations ?? []) { o in
                            HStack(alignment: .top, spacing: 4) {
                                Text("·").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                                Text(o.text).font(Term.mono(10)).foregroundStyle(Term.fgDim)
                                    .textSelection(.enabled)
                                if o.questionId != nil {
                                    Text("[linked]").font(Term.mono(9)).foregroundStyle(Term.positive)
                                }
                            }
                            .padding(.leading, 8)
                        }
                    }
                    .padding(.vertical, 4)
                    .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
                }
            }
            Text("Logging visits and observations happens on the web terminal.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
    }
}

// MARK: Valuation
//
// What the work concluded a share is worth, and what it assumed. Three
// cases rather than one number, with the assumptions underneath where
// they can be read — an assumption that cites a claim came off a
// recording at a timestamp; one that cites nothing is a figure somebody
// chose, and the two must not look alike.

private struct ValuationTab: View {
    let p: ProjectFull

    @State private var quote: Loadable<LiveQuote?> = .loading
    @State private var openAssumptions: Set<Int> = []

    var body: some View {
        let list = p.valuations ?? []
        VStack(alignment: .leading, spacing: 10) {
            quoteLine

            if list.isEmpty {
                PanelMessage(text: "No valuation yet. The spreadsheet can go in Files — this is the part someone can argue with without opening it.")
            } else {
                ForEach(list) { v in
                    valuationRow(v)
                }
            }
            Text("Creating and editing valuations happens on the web terminal.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
        .task(id: p.ticker) { await loadQuote() }
    }

    private var live: Double? {
        if case .loaded(let q) = quote { return q?.last }
        return nil
    }

    @ViewBuilder
    private var quoteLine: some View {
        switch quote {
        case .loading:
            Text("Fetching live quote…").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        case .failed(let msg):
            // Upside falls back to the at-write reference below, and
            // the fallback is named rather than silent.
            Text("Live quote unavailable — \(msg). Upside shown against the price at write.")
                .font(Term.mono(9)).foregroundStyle(Term.orange)
        case .loaded(let q):
            if let last = q?.last {
                HStack(spacing: 6) {
                    Text("LIVE \(p.ticker ?? "")").font(Term.mono(9, weight: .bold)).tracking(0.5)
                        .foregroundStyle(Term.fgMuted)
                    Text("$\(Fmt.money(last))").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white)
                    if let pct = q?.changePct {
                        Text(Fmt.pct(pct)).font(Term.mono(10)).foregroundStyle(Term.delta(pct))
                    }
                }
            } else if p.ticker != nil {
                Text("No live quote for \(p.ticker ?? "") right now — upside shown against the price at write.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
        }
    }

    private func valuationRow(_ v: ProjectFull.Valuation) -> some View {
        let kindLabel: String = {
            switch v.kind {
            case "dcf":    return "DCF"
            case "merger": return "MERGER / M&A"
            case "comps":  return "COMPS"
            default:       return (v.kind ?? "OTHER").uppercased()
            }
        }()
        // Live wins as the reference when we have it — but only for a
        // USD-denominated model. The quote endpoint prices in USD, and
        // a CHF target over a USD reference is a wrong percentage
        // printed with confidence. Non-USD models keep their at-write
        // reference, named as such.
        let liveUsable = live != nil && (v.currency ?? "USD").uppercased() == "USD"
        let ref = liveUsable ? live : v.priceAtWrite
        let refIsLive = liveUsable
        let stale = isPastISO(v.reviewBy)

        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(kindLabel).font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.fgMuted)
                Text(v.name).font(Term.mono(11)).foregroundStyle(Term.white)
                Spacer()
                Text([Fmt.date(v.asOf), v.createdBy?.name].compactMap { $0 }.joined(separator: " · "))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }

            HStack(alignment: .top, spacing: 18) {
                // Three dashes said "we have no numbers" when the record
                // actually said "this one states a multiple, not a
                // price". Those are different claims about our own work
                // and must not render alike.
                if v.bear == nil && v.base == nil && v.bull == nil {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("NO PRICE CASES, BY CHOICE")
                            .font(Term.mono(9, weight: .bold)).tracking(0.5)
                            .foregroundStyle(Term.amber)
                        Text("Stated as a multiple. See the note below.")
                            .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                    }
                    .frame(minWidth: 240, alignment: .leading)
                } else {
                    caseCell("BEAR", v.bear, ref: ref, ccy: v.currency)
                    caseCell("BASE", v.base, ref: ref, ccy: v.currency)
                    caseCell("BULL", v.bull, ref: ref, ccy: v.currency)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(ref == nil ? "NO REF PRICE" : (refIsLive ? "VS LIVE" : "VS AT WRITE"))
                        .font(Term.mono(9)).tracking(0.5).foregroundStyle(Term.fgMuted)
                    Text(ref.map { moneyCcy($0, refIsLive ? "USD" : v.currency) } ?? "—")
                        .font(Term.mono(12)).foregroundStyle(Term.fgDim)
                    Text(ref == nil
                         ? "upside not shown"
                         : refIsLive
                         ? "quote now"
                         : (v.currency ?? "USD").uppercased() != "USD"
                         ? "live quote is USD — not comparable"
                         : "live unavailable")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
            }

            // The watch. A valuation saying a name is cheap does
            // nothing on its own — somebody has to be looking on the
            // day it gets there.
            if let below = v.buyBelow {
                HStack(spacing: 6) {
                    Text("watching for").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    Text(moneyCcy(below, v.currency)).font(Term.mono(10, weight: .bold)).foregroundStyle(Term.white)
                    if let hit = v.alertedAt {
                        Text("· reached \(Fmt.date(hit))").font(Term.mono(10)).foregroundStyle(Term.positive)
                    } else {
                        Text("· not there yet").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    }
                    if (v.watchers ?? []).isEmpty {
                        // A watch with nobody on it fires into a log
                        // file. Worth saying on the row.
                        Text("· NOBODY IS EMAILED").font(Term.mono(10)).foregroundStyle(Term.amber)
                    } else {
                        Text("· emails \(v.watchers?.count ?? 0)").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    }
                }
            }

            // A model written before the last earnings report is a
            // claim about facts that have since been restated.
            if stale {
                Text("PAST REVIEW (\(Fmt.date(v.reviewBy))) — re-run before acting")
                    .font(Term.mono(10, weight: .bold)).foregroundStyle(Term.negative)
            } else if let rb = v.reviewBy {
                Text("review by \(Fmt.date(rb))").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }

            let assumptions = v.assumptions ?? []
            Button {
                if openAssumptions.contains(v.id) { openAssumptions.remove(v.id) }
                else { openAssumptions.insert(v.id) }
            } label: {
                Text(openAssumptions.contains(v.id)
                     ? "hide assumptions"
                     : "\(assumptions.count) assumption\(assumptions.count == 1 ? "" : "s")")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .underline(true, pattern: .dot)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if openAssumptions.contains(v.id) {
                if assumptions.isEmpty {
                    Text("None recorded — the cases above cannot be restated without the file.")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                        .padding(.leading, 8)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(assumptions.enumerated()), id: \.offset) { _, a in
                            assumptionLine(a)
                        }
                    }
                    .padding(.leading, 8)
                }
            }

            if let note = v.note, !note.isEmpty {
                Text(note).font(Term.mono(10)).foregroundStyle(Term.fgDim)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 5)
        .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
    }

    private func caseCell(_ label: String, _ val: Double?, ref: Double?, ccy: String?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(Term.mono(9)).tracking(0.5).foregroundStyle(Term.fgMuted)
            Text(moneyCcy(val, ccy)).font(Term.mono(12)).foregroundStyle(Term.white)
            if let val, let ref, ref != 0 {
                let up = (val - ref) / ref * 100
                Text(Fmt.pct(up, decimals: 0))
                    .font(Term.mono(9))
                    .foregroundStyle(up >= 0 ? Term.positive : Term.negative)
            }
        }
        .frame(minWidth: 78, alignment: .leading)
    }

    // The claim pin: an assumption that cites a claim shows the words
    // it rests on and the timestamp; one with a note shows provenance
    // in place of the word "assumed"; the rest say "assumed" plainly.
    private func assumptionLine(_ a: ProjectFull.Valuation.Assumption) -> some View {
        let claim = a.claimId.flatMap { id in (p.claims ?? []).first { $0.id == id } }
        return HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(a.label ?? "").font(Term.mono(10)).foregroundStyle(Term.fgDim)
            Text("\(a.value?.value ?? "")\(a.unit.map { " \($0)" } ?? "")")
                .font(Term.mono(10, weight: .bold)).foregroundStyle(Term.white)
            if let c = claim {
                Text("· from the tape: “\(String((c.quote ?? c.text).prefix(70)))” \(c.stamp ?? "")")
                    .font(Term.mono(9)).foregroundStyle(Term.positive)
                    .lineLimit(1)
                    .help(c.citation ?? "")
            } else if let note = a.note {
                Text("· \(note)").font(Term.mono(9)).foregroundStyle(Term.fgDim)
            } else {
                Text("· assumed").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            Spacer(minLength: 0)
        }
    }

    private func loadQuote() async {
        guard let t = p.ticker, !t.isEmpty else {
            quote = .loaded(nil)
            return
        }
        quote = .loading
        do {
            let data = try await API.shared.get("/terminal/quotes", query: ["tickers": t])
            let dict = try await API.shared.decode([String: LiveQuote?].self, from: data)
            quote = .loaded(dict[t.uppercased()] ?? nil)
        } catch {
            quote = .failed(error.localizedDescription)
        }
    }
}

// MARK: Ledger
//
// The claim ledger: what people actually said, grouped by topic with
// triangulation. The alias is the only identity that ever renders —
// the server sends nothing else.

private struct LedgerTab: View {
    let p: ProjectFull
    @Binding var busy: Bool
    let run: RunAction

    private enum LFilter: CaseIterable { case all, unlinked, unverified, scan }
    @State private var only: LFilter = .all

    var body: some View {
        let claims = p.claims ?? []
        let unlinked = claims.filter { $0.questionId == nil }.count
        let unverified = claims.filter { $0.verifiedById == nil }.count

        VStack(alignment: .leading, spacing: 12) {
            if claims.isEmpty {
                PanelMessage(text: "No claims yet. Add an interview on the web, upload the recording, then extract.")
            } else {
                HStack(spacing: 12) {
                    Chip(label: "ALL \(claims.count)", active: only == .all) { only = .all }
                    // The claims answering nothing asked are the actual
                    // work queue.
                    Chip(label: "ANSWERS NOTHING ASKED \(unlinked)", active: only == .unlinked) { only = .unlinked }
                    Chip(label: "NOT LISTENED BACK \(unverified)", active: only == .unverified) { only = .unverified }
                    Chip(label: "FOUND BY SCAN", active: only == .scan) { only = .scan }
                    if only != .all && claims.filter(matches).isEmpty {
                        Text("— none, nothing to do here").font(Term.mono(10)).foregroundStyle(Term.positive)
                    }
                }

                let shown = claims.filter(matches)
                let topics = p.topics ?? []
                ForEach(topics) { t in
                    let group = shown.filter { $0.topic == t.topic }
                    if !group.isEmpty {
                        topicGroup(t, group, totalInTopic: t.claimCount ?? 0)
                    }
                }

                // Claims the triangulator cannot group (no topic) would
                // silently vanish if we only walked the topic list.
                // They still exist; say so.
                let orphans = shown.filter { c in c.topic == nil || !topics.contains { $0.topic == c.topic } }
                if !orphans.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("(no topic)").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.fgMuted)
                        ForEach(orphans) { c in claimRow(c) }
                    }
                }
            }
        }
    }

    private func matches(_ c: ProjectFull.Claim) -> Bool {
        switch only {
        case .all:        return true
        case .unlinked:   return c.questionId == nil
        case .unverified: return c.verifiedById == nil
        case .scan:       return c.origin == "answer-scan"
        }
    }

    private func topicGroup(_ t: ProjectFull.Topic, _ group: [ProjectFull.Claim], totalInTopic: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(t.topic).font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white)
                Text(SupportStyle.label(t.support))
                    .font(Term.mono(9)).tracking(0.5)
                    .foregroundStyle(SupportStyle.tone(t.support))
                // Triangulation is computed across the whole topic;
                // with a filter on, say what is shown instead of
                // implying the corroboration applies to the subset.
                if only == .all {
                    Text("\(t.distinctSources ?? 0) src · \(t.independentLines ?? 0) independent\((t.opinionCount ?? 0) > 0 ? " · \(t.opinionCount ?? 0) opinion" : "")\((t.forecastCount ?? 0) > 0 ? " · \(t.forecastCount ?? 0) forecast" : "")")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                } else {
                    Text("\(group.count) of \(totalInTopic) shown · support is for the whole topic")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                Spacer()
            }
            ForEach(group) { c in claimRow(c) }
        }
    }

    private func claimRow(_ c: ProjectFull.Claim) -> some View {
        EdgeRow(tone: Term.border) {
            VStack(alignment: .leading, spacing: 1) {
                Text(c.text).font(Term.mono(11)).foregroundStyle(Term.white)
                    .textSelection(.enabled)
                if let quote = c.quote {
                    // The source's own words sit next to the tidy
                    // summary. The summary is the model's; the quote is
                    // the evidence.
                    Text("“\(quote)”")
                        .font(Term.mono(10)).italic().foregroundStyle(Term.fgDim)
                        .textSelection(.enabled)
                }
                HStack(spacing: 6) {
                    Text("\(c.citation ?? "") · \(c.kind ?? "")\(c.verifiedById != nil ? " · verified" : "")")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    // Which question this bears on. The extractor knows
                    // what was said; only a person knows what we set
                    // out to learn, so the join stays a human call.
                    linkMenu(c)
                    Spacer()
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func linkMenu(_ c: ProjectFull.Claim) -> some View {
        let questions = p.questions ?? []
        let current = c.questionId.flatMap { qid in questions.first { $0.id == qid } }
        return Menu {
            Button("— answers no question yet —") {
                Task { await run {
                    _ = try await API.shared.post("/research/claims/\(c.id)/link", json: ["questionId": NSNull()])
                } }
            }
            ForEach(questions) { q in
                Button(String(q.text.prefix(44))) {
                    Task { await run {
                        _ = try await API.shared.post("/research/claims/\(c.id)/link", json: ["questionId": q.id])
                    } }
                }
            }
        } label: {
            Text(current.map { "→ \(String($0.text.prefix(40)))" } ?? "→ answers no question yet")
                .font(Term.mono(9))
                .foregroundStyle(current == nil ? Term.fgMuted : Term.cyan)
                .lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(busy)
        .help("Link this claim to the question it bears on")
    }
}

// MARK: Files
//
// Where the dossiers and memos live, and where members mostly READ —
// the reader is the point of this tab, so it gets real typographic care
// rather than a table cell.

private struct FilesTab: View {
    let p: ProjectFull
    @Binding var busy: Bool
    let run: RunAction
    let onOpenArtifact: (Int) -> Void
    let onOpenFile: (String, String) -> Void

    private static let kinds: [(String, String)] = [
        ("guide", "Interview guide"), ("script", "Script"), ("model", "Valuation model / DCF"),
        ("filing", "Filing or earnings call"), ("document", "Document"), ("data", "Data"),
        ("photo", "Photo"), ("memo", "Memo"), ("other", "Other"),
    ]

    @State private var composing = false
    @State private var kind = "memo"
    @State private var title = ""
    @State private var bodyText = ""
    @State private var uploading: String?
    @State private var uploadError: String?

    var body: some View {
        let artifacts = p.artifacts ?? []
        VStack(alignment: .leading, spacing: 10) {
            // A guide typed straight in and a PDF dragged over land in
            // the same list, which is the whole point: forcing the file
            // shape on a script somebody wrote in the app just means
            // they keep it somewhere else.
            if composing {
                composer
            } else {
                HStack(spacing: 8) {
                    Button("+ Upload files") { pickAndUpload() }
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy || uploading != nil)
                    Button("+ Write one here") { composing = true }
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy || uploading != nil)
                    if let u = uploading {
                        // Named, because uploading eleven annual reports
                        // over a home connection is a minute of nothing
                        // happening and a silent spinner reads as a hang.
                        Text("Uploading \(u)…")
                            .font(Term.mono(9)).foregroundStyle(Term.amber)
                    } else if let e = uploadError {
                        Text(e).font(Term.mono(9)).foregroundStyle(Term.negative)
                    }
                    Spacer()
                }
            }

            if artifacts.isEmpty {
                PanelMessage(text: "Nothing attached yet.")
            } else {
                // The server already sorts key documents first. They are
                // separated under a heading as well, because a colour
                // alone stops being a signal the moment a project has
                // twenty files and you are scrolling past it.
                let key = artifacts.filter { $0.keyDoc == true }
                let rest = artifacts.filter { $0.keyDoc != true }
                if !key.isEmpty {
                    Text("KEY DOCUMENTS")
                        .font(Term.mono(9, weight: .bold)).tracking(0.6)
                        .foregroundStyle(Term.amber)
                        .padding(.top, 2)
                    ForEach(key) { a in artifactRow(a) }
                    if !rest.isEmpty {
                        Text("EVERYTHING ELSE")
                            .font(Term.mono(9, weight: .bold)).tracking(0.6)
                            .foregroundStyle(Term.fgMuted)
                            .padding(.top, 8)
                    }
                }
                ForEach(rest) { a in artifactRow(a) }
            }
        }
    }

    /// Anything the project needs: a PDF, a Word report, a spreadsheet
    /// model, a CSV of prices. No type filter, deliberately — the server
    /// stores whatever it is handed, and a picker that refused a .csv
    /// because this panel had not thought of it would be a worse bug
    /// than an odd file in the list.
    ///
    /// Uploads run one at a time rather than concurrently. Each one
    /// forwards through our API to Graph, and firing eleven at once is
    /// how a home connection turns a slow upload into a failed one.
    private func pickAndUpload() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.message = "Attach files to this project"
        panel.prompt = "Upload"
        guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
        let urls = panel.urls
        let k = kind

        Task {
            uploadError = nil
            var failed: [String] = []
            for url in urls {
                uploading = url.lastPathComponent
                do {
                    // Security-scoped access is what makes a file picked
                    // from outside the sandbox actually readable.
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    _ = try await API.shared.upload(
                        "/research/projects/\(p.id)/artifacts",
                        fileURL: url,
                        fields: ["kind": k, "title": url.lastPathComponent])
                } catch {
                    // One bad file must not abandon the other ten, and
                    // the ones that failed have to be named or a partial
                    // upload looks exactly like a complete one.
                    failed.append(url.lastPathComponent)
                }
            }
            uploading = nil
            if !failed.isEmpty {
                uploadError = failed.count == urls.count
                    ? "Upload failed: \(failed.joined(separator: ", "))"
                    : "\(urls.count - failed.count) uploaded, failed: \(failed.joined(separator: ", "))"
            }
            await run { }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Menu {
                    ForEach(Self.kinds, id: \.0) { k in
                        Button(k.1) { kind = k.0 }
                    }
                } label: {
                    Text(Self.kinds.first { $0.0 == kind }?.1 ?? kind)
                        .font(Term.mono(10)).foregroundStyle(Term.white)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                TextField("Title", text: $title)
                    .textFieldStyle(.plain)
                    .font(Term.mono(11)).foregroundStyle(Term.white)
                    .padding(6).background(Term.bg).termBorder()
            }
            TextEditor(text: $bodyText)
                .font(Term.mono(11)).foregroundStyle(Term.white)
                .lineSpacing(3)
                .scrollContentBackground(.hidden)
                .autocorrectionDisabled()
                .frame(minHeight: 120)
                .padding(4).background(Term.bg).termBorder()
            HStack(spacing: 6) {
                Button("Save text") {
                    let k = kind, t = title, b = bodyText
                    Task { await run {
                        _ = try await API.shared.post("/research/projects/\(p.id)/artifacts",
                                                      json: ["kind": k, "title": t, "body": b])
                        composing = false
                        title = ""; bodyText = ""
                    } }
                }
                .buttonStyle(TermButtonStyle())
                .disabled(busy || title.isEmpty || bodyText.isEmpty)
                Button("Cancel") { composing = false }.buttonStyle(TermButtonStyle())
            }
        }
        .padding(8).termBorder()
    }

    private func artifactRow(_ a: ProjectFull.Artifact) -> some View {
        let isKey = a.keyDoc == true
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            // The marker carries the meaning; the colour only makes it
            // findable. Colour alone would say nothing to a reader who
            // cannot tell amber from white on a projector.
            Text(isKey ? "★" : " ")
                .font(Term.mono(10)).foregroundStyle(Term.amber)
                .frame(width: 10, alignment: .leading)
            Text((a.kind ?? "document").uppercased())
                .font(Term.mono(9)).tracking(0.5)
                .foregroundStyle(isKey ? Term.amber : Term.fgMuted)
                .frame(width: 70, alignment: .leading)
            if a.body?.isEmpty == false {
                Button { onOpenArtifact(a.id) } label: {
                    Text(a.title)
                        .font(Term.mono(11)).foregroundStyle(Term.amber)
                        .lineLimit(1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                .help("Read in place")
            } else if let item = DocumentViewer.itemId(from: a.fileRef) {
                Button { onOpenFile(item, a.title) } label: {
                    Text(a.title)
                        .font(Term.mono(11, weight: isKey ? .bold : .regular))
                        .foregroundStyle(isKey ? Term.amber : Term.white)
                        .lineLimit(1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                .help("Read it here, or open the original")
            } else {
                Text(a.title)
                    .font(Term.mono(11, weight: isKey ? .bold : .regular))
                    .foregroundStyle(isKey ? Term.amber : Term.white).lineLimit(1)
                // Neither inline text nor a stored file. Nothing to open,
                // and saying so beats a link that does nothing.
                Text("(no file attached)")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            Spacer(minLength: 6)
            Button(isKey ? "unkey" : "key") {
                let want = !isKey, aid = a.id
                Task { await run {
                    try await ResearchHTTP.patch("/research/artifacts/\(aid)", json: ["keyDoc": want])
                } }
            }
            .buttonStyle(TermButtonStyle()).disabled(busy)
            .help(isKey ? "Stop pinning this to the top" : "Pin to the top as a key document")
            Text(a.uploadedBy?.name ?? "")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            Text(Fmt.date(a.createdAt))
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                .frame(width: 62, alignment: .trailing)
        }
        .padding(.vertical, 4)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
    }
}

// The reading surface. Mono 11 with real line spacing, a measure capped
// at ~72 characters, generous padding, full height, selectable — a memo
// should read like a document, not like a log line.
private struct ArtifactReader: View {
    let artifact: ProjectFull.Artifact
    let onBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button("← Files", action: onBack).buttonStyle(TermButtonStyle())
                Text((artifact.kind ?? "document").uppercased())
                    .font(Term.mono(9)).tracking(0.5).foregroundStyle(Term.fgMuted)
                Text(artifact.title)
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white).lineLimit(1)
                Spacer()
                Text([artifact.uploadedBy?.name, Fmt.date(artifact.createdAt)].compactMap { $0 }.joined(separator: " · "))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Divider().overlay(Term.border)

            if let note = artifact.note, !note.isEmpty {
                // The provenance line — for a synthesized memo this
                // carries the citation count and whether any invented
                // citations were removed, which is exactly what a
                // reader should know before trusting a word.
                Text(note)
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .padding(.horizontal, 14).padding(.top, 6)
            }

            ScrollView {
                Text(artifact.body ?? "")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: 680, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: Compliance
//
// What the screen caught, and nothing else — grouped so a count is
// never a dead end. Silence is the normal state and reads as
// reassurance: the all-clear is stated in a full sentence, because
// "nothing here" and "nothing was checked" must never look alike.

private struct ComplianceTab: View {
    let p: ProjectFull

    var body: some View {
        let list = p.interviews ?? []
        let flagged = list.filter {
            $0.reviewedAt == nil &&
            (($0.quarantined ?? false) || ($0.mnpiRisk ?? "low") != "low"
             || !($0.consentObtained ?? false) || $0.screenedAt == nil)
        }
        let noAttestation = list.filter { $0.attestedAt == nil }.count

        VStack(alignment: .leading, spacing: 12) {
            if list.isEmpty {
                PanelMessage(text: "No interviews yet, so nothing to screen.")
            } else if flagged.isEmpty {
                Text("Screened \(list.count) interview\(list.count == 1 ? "" : "s"). Nothing flagged — no material non-public information found, consent recorded throughout.")
                    .font(Term.mono(11)).foregroundStyle(Term.positive)
            } else {
                Text("The screen flagged \(flagged.count) of \(list.count) interview\(list.count == 1 ? "" : "s"). Everything else came back clean.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)

                group("QUARANTINED", Term.negative,
                      "Screened as containing material non-public information. Claims excluded from the ledger and from any memo.",
                      flagged.filter { $0.quarantined ?? false })
                group("ELEVATED", Term.amber,
                      "Brushes something sensitive, or the source is a current employee. Read before citing.",
                      flagged.filter { !($0.quarantined ?? false) && $0.mnpiRisk == "elevated" })
                group("UNSCREENED", Term.amber,
                      "No MNPI screen has run on this transcript yet.",
                      flagged.filter { !($0.quarantined ?? false) && $0.screenedAt == nil })
                group("NO CONSENT", Term.negative,
                      "Consent to record was never recorded for this interview.",
                      flagged.filter { !($0.consentObtained ?? false) })

                Text("Review decisions — clear, release, quarantine, re-screen — are made on the web terminal.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }

            if noAttestation > 0 {
                Text("\(noAttestation) interview\(noAttestation == 1 ? "" : "s") carry no pre-call attestation. These were imported, so there was no call to attest to — new interviews opened on the web record one.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .padding(.top, 4)
                    .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
            }
        }
    }

    @ViewBuilder
    private func group(_ label: String, _ tone: Color, _ meaning: String,
                       _ interviews: [ProjectFull.Interview]) -> some View {
        if !interviews.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("\(label): \(interviews.count)")
                        .font(Term.mono(10, weight: .bold)).tracking(0.5).foregroundStyle(tone)
                    Text(meaning).font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(2)
                }
                ForEach(interviews) { iv in
                    EdgeRow(tone: tone) {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                Text(iv.title).font(Term.mono(11)).foregroundStyle(Term.white)
                                Text([
                                    iv.source?.alias,
                                    iv.source?.relationship == "CurrentEmployee" ? "current employee" : nil,
                                ].compactMap { $0 }.joined(separator: " · "))
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                Spacer()
                            }
                            // Lead with what the model found, in its
                            // words — and where no reason was ever
                            // stored, say that plainly rather than
                            // leaving a coloured word unexplained.
                            Text(finding(iv))
                                .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                            ForEach(Array((iv.screenResult?.hits ?? []).prefix(3).enumerated()), id: \.offset) { _, h in
                                Text("· \(h.why ?? ""): “\(String((h.excerpt ?? "").prefix(110)))”")
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                    .padding(.leading, 8)
                            }
                            if iv.screenResult?.modelAvailable == false {
                                Text("· keyword pass only — the model was unavailable, so this is not a full clearance")
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                    .padding(.leading, 8)
                            }
                        }
                    }
                }
            }
        }
    }

    private func finding(_ iv: ProjectFull.Interview) -> String {
        if let r = iv.screenResult?.reason, !r.isEmpty { return r }
        if let q = iv.quarantineNote, !q.isEmpty { return q }
        if !(iv.consentObtained ?? false) { return "No consent to record was captured for this interview." }
        if iv.screenedAt == nil { return "This transcript has not been screened yet." }
        return "Risk is \((iv.mnpiRisk ?? "unknown").uppercased()) but no reason was recorded — this interview was screened before findings were stored. Re-screen it on the web before deciding."
    }
}

// MARK: - Project search

// One index over the whole project.
//
// A research project is eight tabs deep by the time it is any good, and
// the thing you want is almost never on the tab you are looking at: a
// name you half remember, a phrase from a transcript, which question a
// claim was pinned to. Without this you open tabs until you find it,
// which is how people stop using the evidence they gathered.
//
// Every row carries the tab it came from, so a hit is a door rather
// than a readout.
private struct SearchRow: Identifiable {
    let id = UUID()
    let tab: RTab
    let kind: String
    let title: String
    let body: String
    let meta: String
    /// What the hit opens. Without it a result reaches the tab and then
    /// abandons the reader in the list they searched to avoid.
    let recordID: Int?

    var tone: Color {
        switch kind {
        case "question":   return Term.amber
        case "contact":    return Term.white
        case "draft":      return Term.orange
        case "interview", "visit", "observation": return Term.cyan
        case "valuation":  return Term.positive
        case "claim":      return Term.blue
        default:            return Term.magenta
        }
    }
}

private func buildSearchIndex(_ p: ProjectFull) -> [SearchRow] {
    var rows: [SearchRow] = []
    func add(_ tab: RTab, _ kind: String, _ title: String?, _ body: String?,
             _ meta: String?, _ id: Int? = nil) {
        rows.append(SearchRow(tab: tab, kind: kind, title: title ?? "",
                              body: body ?? "", meta: meta ?? "", recordID: id))
    }

    for q in p.questions ?? [] { add(.questions, "question", q.text, q.rationale, q.status, q.id) }
    for t in p.targets ?? [] {
        add(.outreach, "contact", t.name,
            [t.employer, t.email, t.notes].compactMap { $0 }.joined(separator: " · "), t.status, t.id)
        for d in t.drafts ?? [] {
            // A draft opens its CONTACT, which is where it is read.
            add(.outreach, "draft", "\(t.name): \(d.subject)", d.body, d.stage, t.id)
        }
    }
    for i in p.interviews ?? [] { add(.interviews, "interview", i.title, i.transcript, i.source?.alias, i.id) }
    for v in p.visits ?? [] {
        add(.visits, "visit", v.location, v.notes, v.banner, v.id)
        for o in v.siteObservations ?? [] { add(.visits, "observation", v.location, o.text, nil, v.id) }
    }
    for v in p.valuations ?? [] { add(.valuation, "valuation", v.name, v.note, v.kind, v.id) }
    for c in p.claims ?? [] {
        add(.ledger, "claim", c.text, c.quote,
            [c.topic, c.stamp].compactMap { $0 }.joined(separator: " · "), c.questionId)
    }
    for a in p.artifacts ?? [] {
        add(.files, "file", a.title, a.body,
            [a.kind, a.note].compactMap { $0 }.joined(separator: " · "), a.id)
    }
    return rows
}

private struct SearchResultsView: View {
    let project: ProjectFull
    let query: String
    let onGo: (RTab, Int?) -> Void

    /// Every term must appear. Multi-word search that ORs is search that
    /// always matches, which is the same as no search at all.
    private var terms: [String] {
        query.lowercased().split(separator: " ").map(String.init).filter { !$0.isEmpty }
    }

    private var hits: [SearchRow] {
        let t = terms
        guard !t.isEmpty else { return [] }
        return buildSearchIndex(project).filter { row in
            let hay = "\(row.title) \(row.body) \(row.meta)".lowercased()
            return t.allSatisfy { hay.contains($0) }
        }
    }

    /// The line around the first hit, so a result explains itself rather
    /// than making you open it to learn why it matched.
    private func snippet(_ row: SearchRow) -> String {
        let body = row.body
        guard !body.isEmpty else { return "" }
        let low = body.lowercased()
        var at: String.Index?
        for t in terms {
            if let r = low.range(of: t), at == nil || r.lowerBound < at! { at = r.lowerBound }
        }
        guard let hit = at else { return String(body.prefix(140)) }
        let start = body.index(hit, offsetBy: -40, limitedBy: body.startIndex) ?? body.startIndex
        let end = body.index(hit, offsetBy: 120, limitedBy: body.endIndex) ?? body.endIndex
        return (start > body.startIndex ? "…" : "") + body[start..<end].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        let rows = hits
        if rows.isEmpty {
            PanelMessage(text: "Nothing in this project matches \u{201C}\(query)\u{201D}. Searches every question, contact, draft, transcript, visit, valuation, claim and file.")
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(rows.count) match\(rows.count == 1 ? "" : "es") for \u{201C}\(query)\u{201D} · Escape to clear")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)

                // Grouped by tab rather than ranked: "three hits in
                // Interviews, one in the Ledger" tells you something a
                // flat list does not, and it matches the shape the
                // reader already has in their head.
                ForEach(RTab.allCases, id: \.self) { t in
                    let group = rows.filter { $0.tab == t }
                    if !group.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                SectionLabel(text: "\(t.rawValue) (\(group.count))")
                                Button("open tab") { onGo(t, nil) }
                                    .buttonStyle(.plain)
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            }
                            ForEach(group.prefix(8)) { r in
                                Button { onGo(t, r.recordID) } label: {
                                    EdgeRow(tone: r.tone) {
                                        VStack(alignment: .leading, spacing: 1) {
                                            HStack(spacing: 8) {
                                                Text(r.kind.uppercased())
                                                    .font(Term.mono(9)).foregroundStyle(r.tone)
                                                Text(r.title).font(Term.mono(11))
                                                    .foregroundStyle(Term.white).lineLimit(1)
                                                if !r.meta.isEmpty {
                                                    Text(r.meta).font(Term.mono(9))
                                                        .foregroundStyle(Term.fgMuted).lineLimit(1)
                                                }
                                                Spacer()
                                            }
                                            if !r.body.isEmpty {
                                                Text(snippet(r)).font(Term.mono(10))
                                                    .foregroundStyle(Term.fgDim).lineLimit(2)
                                            }
                                        }
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                            if group.count > 8 {
                                // Never a silent cap: a truncated list
                                // that does not say so reads as the
                                // whole answer.
                                Text("and \(group.count - 8) more in \(t.rawValue) — open the tab for all of them")
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            }
                        }
                    }
                }
            }
        }
    }
}
