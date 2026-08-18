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
// The send gate is re-implemented honestly rather than reproduced
// visually. Every rule that matters is enforced on the server, so this
// panel does not decide whether you may send; it asks, shows what came
// back, and never renders a state as safer than the server called it.
// Two rules carried from the web that must never regress:
// `unscreened` and `clear-keyword-only` are never shown as a pass, and
// Copy — the de-facto send button — stays shut when the server says the
// draft cannot go out (a prohibited screen, or a rejection).
//
// Sources are aliases everywhere. The server never sends a real name in
// a citation and this panel renders exactly what it sends.
struct ResearchPanel: View {
    let ticker: String?
    /// Nil in a popped-out window, which owns no workspace pane and so
    /// must not publish numbers that Number <GO> would fire at nothing.
    var paneID: UUID? = nil

    @State private var projects: Loadable<[Project]> = .loading
    @State private var openID: Int?
    @State private var query = ""

    var body: some View {
        Group {
            if let id = openID {
                ProjectDetail(projectId: id, paneID: paneID, onBack: { openID = nil })
            } else {
                list
            }
        }
        .task(id: ticker) { await loadProjects() }
    }

    /// A pile heading. Shown only when there are two piles to tell
    /// apart — one heading above one list is furniture.
    private func pileHeader(_ text: String, _ n: Int) -> some View {
        HStack(spacing: 6) {
            Text(text).font(Term.mono(9, weight: .bold)).tracking(0.6)
                .foregroundStyle(Term.fgDim)
            Text("\(n)").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            Spacer()
        }
        .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 3)
    }

    private func projectRow(_ p: Project) -> some View {
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
                // WHO owns the work, where the count string used to
                // sit. Forty rows of "Q0 F1 T0 C0" told a reader
                // nothing; a name answers the question people actually
                // bring to this list. The counts survive in the hover.
                Text(p.createdBy?.name ?? p.countsLine)
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .lineLimit(1)
                    .help(p.countsHelp)
                Text(p.status)
                    .font(Term.mono(9)).foregroundStyle(Term.fgDim)
                    .frame(width: 62, alignment: .trailing)
                // When the research was INITIATED. The updated stamp
                // moves whenever anyone relabels a row — one bulk pass
                // made thirty-nine projects read "Aug 6" — and the date
                // a reader wants is the one the work began.
                Text(Fmt.date(p.createdAt ?? p.updatedAt))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .frame(width: 66, alignment: .trailing)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private var list: some View {
        PanelState(state: projects,
                   emptyWhen: { $0.isEmpty },
                   emptyText: "No research projects yet.",
                   retry: { Task { await loadProjects() } }) { ps in
            let scoped = ticker.map { t in
                ps.filter { $0.ticker?.uppercased() == t.uppercased() }
            } ?? ps
            // The search reads ticker and name, case-blind. With
            // forty-plus projects the scroll stopped being a way to
            // find anything.
            let q = query.trimmingCharacters(in: .whitespaces).uppercased()
            let shown = q.isEmpty ? scoped : scoped.filter {
                ($0.ticker?.uppercased().contains(q) ?? false)
                    || $0.name.uppercased().contains(q)
            }
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

                TextField("Search ticker or name", text: $query)
                    .textFieldStyle(.plain)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Term.bgPanel)
                Divider().overlay(Term.border)

                if shown.isEmpty {
                    PanelMessage(text: q.isEmpty
                        ? "No project for \(ticker ?? "that ticker"). Type RSCH for all of them."
                        : "Nothing matches \"\(query)\".")
                } else {
                    // Two piles, split by STATUS: live work above,
                    // everything Closed below as the historic record.
                    // The old split keyed on emptiness, which filed the
                    // finished Lindt project with the live work and the
                    // imports under a heading of their own.
                    let worked = shown.filter { $0.status != "Closed" }
                    let historic = shown.filter { $0.status == "Closed" }
                    // Live work groups by campaign. Five separate rows
                    // named ABB, Munters, Sika, Cognite and Vertiv are one
                    // piece of work on data centres, and a flat list is
                    // the only reason that is not obvious at a glance.
                    //
                    // Ungrouped rows come FIRST and keep no heading. The
                    // active name usually stands alone and putting a
                    // header above one row, or filing it under a folder of
                    // one, would bury the thing most likely to be wanted.
                    let loose = worked.filter { ($0.folder ?? "").isEmpty }
                    let shelved = Dictionary(
                        grouping: worked.filter { !($0.folder ?? "").isEmpty },
                        by: { $0.folder ?? "" }
                    )
                    let shelfNames = shelved.keys.sorted()
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            if !loose.isEmpty && (!shelved.isEmpty || !historic.isEmpty) {
                                pileHeader("BEING RESEARCHED", loose.count)
                            }
                            ForEach(loose) { p in projectRow(p) }
                            ForEach(shelfNames, id: \.self) { name in
                                let rows = shelved[name] ?? []
                                pileHeader(name.uppercased(), rows.count)
                                ForEach(rows) { p in projectRow(p) }
                            }
                            if !historic.isEmpty {
                                if !worked.isEmpty {
                                    pileHeader("HISTORIC WORK · CLOSED", historic.count)
                                }
                                ForEach(historic) { p in projectRow(p) }
                            }
                        }
                    }
                    Text("Q questions · F files · T contacts · C calls. Historic work is closed research kept for the record.")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        .padding(.horizontal, 10).padding(.vertical, 2)
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
    /// The campaign this belongs to, or nil. Optional in the decodable as
    /// well as the column: a build talking to a server that predates the
    /// field must render an ungrouped list, not fail to decode one.
    let folder: String?
    let brief: String?
    let updatedAt: String?
    let createdAt: String?
    let createdBy: Author?
    let counts: Counts?

    struct Author: Decodable { let name: String? }

    struct Counts: Decodable {
        let interviews: Int?
        let artifacts: Int?
        // The four that turn "how many calls" into "what is in here".
        // Optional and read as UNKNOWN rather than zero: a client
        // pointed at a server that predates them must not announce that
        // a project has no questions on the strength of a field nobody
        // sent.
        let questions: Int?
        let targets: Int?
        let visits: Int?
        let valuations: Int?
    }

    /// A project imported from OneDrive rather than worked in the app.
    ///
    /// Thirty-nine of forty-one are exactly that: a ticker, one or two
    /// PDFs, no brief of our own, nothing asked and nobody contacted.
    /// They are worth keeping and worth not scrolling through, and the
    /// distinction is structural rather than a judgement — an import has
    /// no questions and no outreach because nobody has done any yet.
    /// What is in the project, in the width a list row has.
    ///
    /// A dash rather than a zero where the server sent no count at all:
    /// "this server does not report questions" and "this project has no
    /// questions" are different statements, and an old build talking to
    /// a new one must not make the first sound like the second.
    var countsLine: String {
        func n(_ v: Int?) -> String { v.map(String.init) ?? "–" }
        return "Q\(n(counts?.questions)) F\(n(counts?.artifacts)) T\(n(counts?.targets)) C\(n(counts?.interviews))"
    }

    var countsHelp: String {
        func n(_ v: Int?) -> String { v.map(String.init) ?? "not reported" }
        return "\(n(counts?.questions)) questions · \(n(counts?.artifacts)) files · "
            + "\(n(counts?.targets)) outreach contacts · \(n(counts?.interviews)) interviews · "
            + "\(n(counts?.visits)) site visits · \(n(counts?.valuations)) valuations"
    }

    var isArchive: Bool {
        (counts?.questions ?? 0) == 0
            && (counts?.targets ?? 0) == 0
            && (counts?.interviews ?? 0) == 0
    }

    // Explicit, because `counts` is `_count` on the wire. Which also
    // means every new property has to be named here: leaving one out does
    // not decode it as nil, it stops the type conforming at all.
    enum CodingKeys: String, CodingKey {
        case id, name, ticker, status, folder, brief, updatedAt, createdAt, createdBy
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
        // The server has always computed these and the client never
        // decoded them, so the one number the campaign exists to produce
        // reached the wire and stopped there. Two replies out of
        // fifty-seven sends was findable only by memory or by opening a
        // hundred and ten contacts one at a time.
        let queued: Int?
        /// Letters on the server's own clock. Distinct from `queued`,
        /// which means parked in somebody's mail client by hand.
        let scheduled: Int?
        let replied: Int?
        let autoRepliedOnly: Int?
        let bounced: Int?
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
    let followUp: FollowUp?
    /// The draft this row should speak for.
    ///
    /// The server hands drafts back newest first, and the row used to
    /// take `.first`, which is only the right answer when a contact has
    /// exactly one. On 14 August a rewrite left a duplicate first contact
    /// on twelve people whose letters had already gone out that morning,
    /// and every one of those rows then read READY while the letter that
    /// actually went was invisible underneath it. The row was telling the
    /// truth about a draft and lying about the contact.
    ///
    /// Order of interest, which is not order of creation: something with
    /// a send time on it, then something still to act on, then the record
    /// of what went, and only then whatever is left.
    var primaryDraft: Draft? {
        let ds = drafts ?? []
        if let scheduled = ds.first(where: { $0.queuedFor != nil || $0.queueError != nil }) { return scheduled }
        if let live = ds.first(where: { $0.sentAt == nil && $0.rejectedAt == nil }) { return live }
        if let sent = ds.first(where: { $0.sentAt != nil }) { return sent }
        return ds.first
    }

    /// Unsent, unpulled drafts this row is NOT showing.
    var otherLiveDrafts: Int {
        let live = (drafts ?? []).filter { $0.sentAt == nil && $0.rejectedAt == nil }
        guard let shown = primaryDraft else { return max(0, live.count) }
        return max(0, live.filter { $0.id != shown.id }.count)
    }

}

/// Whether this person is owed a chase, and when.
///
/// Thirteen CHRW emails went out and one came back. The other twelve are
/// not refusals, they are silence, and nobody can hold twelve dates in
/// their head. The server counts in WORKING days, so an email sent on
/// Friday afternoon is one day old on Monday rather than three, and a
/// recommendation can never come due at the weekend.
struct FollowUp: Decodable {
    /// answered · owed · bounced · closed · waiting · due · overdue ·
    /// exhausted · none
    let state: String
    let recommendation: String?
    let dueAt: String?
    let dueDay: String?
    let workingDaysWaited: Int?
    let waitTarget: Int?
    let attempts: Int?
    let autoReplyReset: Bool?

    var isActionable: Bool { state == "due" || state == "overdue" || state == "owed" }

    var label: String? {
        switch state {
        case "overdue": return "CHASE — \(workingDaysWaited ?? 0)d"
        case "due": return "CHASE NOW"
        case "owed": return "REPLY OWED"
        // Deliberately silent. The chase date on every waiting row was a
        // date per row that nobody reads, and the FOLLOW UP line above
        // already names who is actually due. Urgency belongs in one place.
        case "waiting": return nil
        case "exhausted": return "GIVE UP"
        case "bounced": return "BAD ADDRESS"
        default: return nil
        }
    }

    var tint: Color {
        switch state {
        case "overdue", "owed": return Term.negative
        case "due": return Term.amber
        case "exhausted", "bounced": return Term.fgMuted
        default: return Term.fgDim
        }
    }
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
            case "Outreach":   return ("WE WROTE FIRST", Term.blue, "The opening email, when it was not sent from a draft here")
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
        case "Reply":      return ("REPLIED", Term.positive, "A real answer. Our move")
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
    /// When this draft goes out on its own, if it has been queued.
    let queuedFor: String?
    /// Who gets copied when this sends, from the server, so the card
    /// cannot promise a copy the header will not carry.
    let cc: String?
    let queueError: String?
    let screenBlocked: Bool?
    let screenState: String?
    let screenReason: String?
    let screenFindings: Findings?
    let sentAt: String?
    // Written into a mail client and scheduled, not yet gone.
    let queuedAt: String?
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
/// Builds the JSON body OFF the main actor and posts it.
///
/// The add-forms assemble their payload from a handful of optional text
/// fields, which means a `[String: Any]` built inside a `@MainActor`
/// view. Handing that to the API actor is a Swift 6 sending violation,
/// so the dictionary is assembled here instead: the inputs crossing the
/// boundary are Sendable strings and ints, and the untyped dictionary
/// never exists on the main actor at all. Empty strings are dropped
/// rather than sent, because the server stores "" as a value and a blank
/// employer field would otherwise overwrite nothing with nothing.
private enum ResearchWrite {
    static func create(
        _ path: String,
        text: [String: String],
        numbers: [String: Int] = [:]
    ) async throws {
        var json: [String: Any] = [:]
        for (k, v) in text where !v.isEmpty { json[k] = v }
        for (k, v) in numbers { json[k] = v }
        _ = try await API.shared.post(path, json: json)
    }
}

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
            (data, response) = try await Net.session.data(for: req)
        } catch {
            throw WriteError(message: "Could not reach the server. \(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse else {
            throw WriteError(message: "No HTTP response.")
        }
        // Through adopt, never a raw write. A panel that rotates on its
        // own is a second door onto the token store, and the whole bug
        // was a stale rotation getting through one.
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token") {
            TokenStore.adopt(fresh)
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
typealias RunAction = (@escaping @MainActor @Sendable () async throws -> Void) async -> Void

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
        // A draft with a send time beats every other label. Somebody
        // reading a row while a letter for that person sits waiting for
        // Monday morning needs to see THAT, not the stage it was in before
        // it was queued, and not the target's status, which still says
        // Identified because nobody has actually written to them yet.
        if let at = d.queuedFor { return "QUEUED \(Fmt.shortDateTime(at))" }
        if d.queueError != nil { return "QUEUE FAILED" }
        switch d.stage {
        case "sent":         return "SENT"
        // Not "REJECTED": that reads as though the CONTACT turned us
        // down, which is the one thing it never means. It means a
        // president pulled our own letter before it went, and the row
        // has to say which of those happened without being opened.
        case "rejected":     return "PULLED"
        case "blocked":      return "BLOCKED"
        case "ready":        return "READY"
        // Queued is further along than ready and short of sent. Without
        // this it fell through to the approval arithmetic below and the
        // draft nearest to going out printed a dim grey "0 of 0".
        case "queued":       return "QUEUED"
        case "one-approval": return "1 of \(d.approvalsNeeded ?? 2)"
        default:             return "\(d.approvalCount ?? 0) of \(d.approvalsNeeded ?? 2)"
        }
    }
    static func tone(_ d: Draft) -> Color {
        if d.queuedFor != nil { return Term.amber }
        if d.queueError != nil { return Term.negative }
        switch d.stage {
        case "ready":               return Term.positive
        // Cyan, not green: it is sitting in a mailbox waiting on a clock,
        // which is neither "do something" nor "gone".
        case "queued":              return Term.cyan
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
    /// How many OTHER unsent, unpulled drafts this row is not showing.
    /// A row that silently speaks for one of three is how twelve
    /// duplicate letters hid behind twelve rows that all read SENT.
    var alsoHolding: Int = 0

    var body: some View {
        if let d = draft {
            VStack(alignment: .trailing, spacing: 1) {
                HStack(spacing: 6) {
                    if alsoHolding > 0 {
                        Text("+\(alsoHolding)")
                            .font(Term.mono(9, weight: .bold))
                            .foregroundStyle(Term.orange)
                            .help("\(alsoHolding) more unsent draft\(alsoHolding == 1 ? "" : "s") on this contact")
                    }
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
/// The one-line input look shared by every write form in this panel.
/// Defined once because there are now four of them and a form that does
/// not look like the others reads as a different app.
private extension View {
    func termInput(width: CGFloat? = nil) -> some View {
        font(Term.mono(11))
            .foregroundStyle(Term.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .frame(width: width)
            .background(Term.bg)
            .termBorder()
    }
}

/// A labelled Menu that writes a single string, matching statusMenu's
/// look so the pickers in the add-forms are not a new visual language.
private struct TermPicker: View {
    let options: [String]
    @Binding var value: String
    let placeholder: String
    var width: CGFloat = 118

    var body: some View {
        Menu {
            ForEach(options, id: \.self) { o in
                Button(o) { value = o }
            }
        } label: {
            Text(value.isEmpty ? placeholder : value)
                .font(Term.mono(10))
                .foregroundStyle(value.isEmpty ? Term.fgMuted : Term.fgDim)
        }
        .menuStyle(.borderlessButton)
        .frame(width: width, alignment: .leading)
    }
}

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

// The panel is a research workspace, not a fieldwork tool.
//
// Eight top-level tabs were the fieldwork spine — questions, outreach,
// interviews, visits, ledger, compliance — with files and valuation
// wedged in beside them. That reads as "this is for going out and
// interviewing people", which is one kind of research and not the one
// most projects here do: the forty imported from OneDrive have files and
// a model and nothing else.
//
// So the top level is what any project has, and the fieldwork tabs move
// under FIELD where they belong together.
/// The research tabs, flat.
///
/// Fieldwork used to be one tab with four of its own inside it, so
/// reaching an interview meant clicking FIELD and then INTERVIEWS, and a
/// search that found three interviews and a claim reported all four as
/// "FIELD". The nesting was hiding the part of the panel people actually
/// came for.
///
/// Flattening also repairs the numbering. Bloomberg's grammar is that a
/// printed number is a typeable address, and the sub-tabs printed 6 to 9
/// while publishTabs only ever registered 1 to 5 — so those four digits
/// were promises the terminal did not keep. Every tab here is numbered
/// and every number is registered.
private enum RTab: String, CaseIterable {
    case files, valuation, questions, outreach, interviews, visits, ledger, compliance

    func title(_ p: ProjectFull) -> String {
        switch self {
        case .files:      return "FILES (\(p.artifacts?.count ?? 0))"
        case .valuation:  return "VALUATION (\(p.valuations?.count ?? 0))"
        case .questions:  return "QUESTIONS (\(p.questions?.count ?? 0))"
        case .outreach:   return "OUTREACH (\(p.funnel?.total ?? p.targets?.count ?? 0))"
        case .interviews: return "INTERVIEWS (\(p.interviews?.count ?? 0))"
        case .visits:     return "VISITS (\(p.visits?.count ?? 0))"
        case .ledger:     return "LEDGER (\(p.claims?.count ?? 0))"
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
            // How many drafts are ready to send but still sitting.
            return p.outreachQueue?.readyToSend ?? 0
        case .interviews:
            // An interview nobody has reviewed that carries a flag. This
            // used to sit on FIELD, where it could equally have meant a
            // visit or a claim needed attention.
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
    /// Passed down so the tab bar can register itself with Number <GO>,
    /// the oldest navigation idiom the terminal has. The digits were
    /// already printed beside each tab; without this they were decoration.
    var paneID: UUID?
    let onBack: () -> Void
    @EnvironmentObject private var ws: Workspace

    @State private var state: Loadable<ProjectFull> = .loading
    @State private var tab: RTab = .files
    @State private var briefOpen = false
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
                                        // Only an interview row carries an
                                        // interview id. This branch used to
                                        // fire for visits and claims too and
                                        // fed their ids to the transcript
                                        // reader, which opened the wrong
                                        // record or none at all.
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
        .safeAreaInset(edge: .bottom, spacing: 0) { statusLine }
        .task { await load(initial: true) }
        .onAppear { publishTabs() }
        // Re-published when the pane takes focus, because the map is
        // global and the last panel to publish owns the digits. Without
        // this, opening a second RSCH pane leaves 5 <GO> firing at the
        // one you are no longer looking at.
        .onChange(of: ws.focusedID) { _, _ in publishTabs() }
        .onDisappear {
            if let id = paneID, ws.numbersOwner == id { ws.clearNumbers(for: id) }
        }
    }

    /// Bloomberg's bottom line: the grammar of the panel you are looking
    /// at, stated rather than discovered. A terminal that hides its own
    /// shortcuts is a terminal people drive with the mouse.
    private var statusLine: some View {
        HStack(spacing: 14) {
            Text("\(RTab.allCases.firstIndex(of: tab).map { $0 + 1 } ?? 1)) \(tab.rawValue.uppercased())")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.amber)
            // Derived, not typed. Eight tabs today; the hint and the
            // registered numbers must never be able to disagree.
            Text("1-\(RTab.allCases.count) <GO> TAB")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            Text("/ SEARCH")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            Text("ESC BACK")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            Spacer()
            if paneID == nil {
                // A popped-out window owns no pane, so the digits cannot
                // be wired to it. Saying so beats printing a shortcut
                // that does nothing out here.
                Text("POPPED OUT · NUMBER GO UNAVAILABLE")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(Term.bgHeader)
        .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    /// The tab bar, registered with Number <GO>. Bloomberg's grammar is
    /// that a printed number is a typeable address, so printing them
    /// without registering them would be a promise the terminal breaks.
    private func publishTabs() {
        guard let id = paneID, ws.focusedID == id else { return }
        var map: [Int: () -> Void] = [:]
        for (i, t) in RTab.allCases.enumerated() {
            map[i + 1] = { tab = t }
        }
        ws.publishNumbers(for: id, map)
    }

    // Brief, standing, and the compliance strip — what the project IS,
    // above the tabs that hold what it contains.
    @ViewBuilder
    private func headerBlock(_ p: ProjectFull) -> some View {
        // The header used to open with two lines of brief, a coverage bar
        // and a compliance strip, above eight tabs — for a project that
        // is often just a folder of PDFs, all of it noise before anything
        // useful. The brief collapses to one line you can open, and the
        // coverage bar only appears where there are questions to cover.
        VStack(alignment: .leading, spacing: 6) {
            if let brief = p.brief, !brief.isEmpty {
                Button { briefOpen.toggle() } label: {
                    HStack(alignment: .top, spacing: 5) {
                        Text(briefOpen ? "▾" : "▸")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        Text(brief)
                            .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                            .lineLimit(briefOpen ? nil : 1)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if (p.questions?.count ?? 0) > 0 { ProjectStatusBar(p: p) }
            ComplianceStripView(interviews: p.interviews ?? [],
                                onOpen: { tab = .compliance })
            if p.transcriptionReady == false {
                // Say it here rather than letting someone find out at
                // the end of a long upload on the web.
                Text("Transcription is not configured on the API — recordings can still be attached as files.")
                    .font(Term.mono(9)).foregroundStyle(Term.negative)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    /// Eight tabs do not always fit.
    ///
    /// The bar scrolls, but it scrolls with no indicator, and the pane it
    /// lives in opens at 900pt and can be dragged down to 320 — so at
    /// full width COMPLIANCE sits near the right edge and at any narrower
    /// width most of the bar is simply off screen with nothing to say so.
    /// Trimming the labels does not fix that; it only moves the width at
    /// which it starts. Keeping the SELECTED tab in view does fix it, at
    /// every width, including the one somebody drags to.
    private func tabBar(_ p: ProjectFull) -> some View {
        ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(RTab.allCases.enumerated()), id: \.element) { i, t in
                    let badge = t.badge(p)
                    let on = tab == t
                    Button { tab = t } label: {
                        HStack(spacing: 4) {
                            // Bloomberg numbers everything you can jump
                            // to, and the number IS the shortcut: type it
                            // on the command line and press GO. Published
                            // below so the digits mean something.
                            Text("\(i + 1))")
                                .font(Term.mono(10))
                                .foregroundStyle(on ? Term.bg : Term.fgMuted)
                            Text(t.title(p))
                                .font(Term.mono(10, weight: on ? .bold : .regular))
                                .tracking(0.5)
                                .foregroundStyle(on ? Term.bg : Term.fgDim)
                            if badge > 0 {
                                Text("\(badge)")
                                    .font(Term.mono(9, weight: .bold))
                                    .foregroundStyle(on ? Term.bg : Term.orange)
                                    .help("\(badge) outstanding")
                            }
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        // Reverse video for the selected tab. A slightly
                        // lighter panel colour is how a web app shows a
                        // selected tab; amber ground with dark text is how
                        // a terminal does, and it is legible across a room.
                        .background(on ? Term.amber : Color.clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Type \(i + 1) and press GO")
                    .id(t)
                }
            }
        }
        // Jumping by number is the whole point of numbering them, and a
        // jump that lands off screen is not a jump.
        .onChange(of: tab) { _, t in
            withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(t, anchor: .center) }
        }
        .onAppear { proxy.scrollTo(tab, anchor: .center) }
        }
    }

    @ViewBuilder
    private func tabContent(_ p: ProjectFull) -> some View {
        switch tab {
        case .files:
            FilesTab(p: p, busy: $busy, run: run,
                     onOpenArtifact: { readerArtifactID = $0 },
                     onOpenFile: { id, title in openFile = OpenFile(itemId: id, title: title) })
        case .valuation:
            ValuationTab(p: p)
        case .questions:
            CoverageTab(p: p, busy: $busy, run: run)
        case .outreach:
            OutreachTab(p: p, busy: $busy, run: run, onOpenTarget: { openTargetID = $0 },
                        reload: { Task { await load(initial: false) } })
        case .interviews:
            InterviewsTab(p: p, busy: $busy, run: run, onOpenTranscript: { readerInterviewID = $0 })
        case .visits:
            VisitsTab(p: p, busy: $busy, run: run)
        case .ledger:
            LedgerTab(p: p, busy: $busy, run: run)
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
    /// Re-read the whole project. The send control changes counts that
    /// live in THIS payload rather than in its own, so without a way to
    /// ask for a reload the funnel line goes stale the moment anything
    /// is scheduled.
    let reload: () -> Void

    private enum TFilter: Equatable { case all, status(String), dead }
    @State private var only: TFilter = .all

    private static let statuses = [
        "Identified", "Queued", "Contacted", "Scheduled", "Completed", "Declined", "Unreachable",
    ]

    // The house vocabulary, same set the /sources route validates
    // against. The targets route stores relationship as free text, but
    // typing a fresh spelling here would silently fork the funnel's
    // grouping, so the picker is the only way in.
    private static let relationships = [
        "FormerEmployee", "CurrentEmployee", "Customer", "Distributor",
        "Supplier", "Competitor", "IndustryExpert", "Other",
    ]

    @State private var adding = false
    @State private var nName = ""
    @State private var nRelationship = ""
    @State private var nEmployer = ""
    @State private var nRole = ""
    @State private var nEmail = ""
    @State private var nNotes = ""

    var body: some View {
        let targets = p.targets ?? []
        let fn = p.funnel
        let q = p.outreachQueue
        let queuedCount = (p.targets ?? []).reduce(0) { n, t in
            n + (t.drafts ?? []).filter { $0.queuedFor != nil && $0.sentAt == nil }.count
        }

        VStack(alignment: .leading, spacing: 10) {
            // The funnel: "who haven't we tried yet" is the number that
            // actually paces a project.
            // "scheduled" here counts people who agreed to a CALL. Letters
            // waiting to go out are a different fact entirely and used to
            // be invisible on this line, which read as though fifty queued
            // emails had not registered anywhere. Both are shown, named
            // differently, because merging them would destroy the only
            // number that says how many conversations we actually have.
            Text("\(fn?.identified ?? 0) not yet written to · \(fn?.contacted ?? 0) written to · \(queuedCount) queued to send · \(fn?.scheduled ?? 0) calls booked · \(fn?.completed ?? 0) done · \((fn?.declined ?? 0) + (fn?.unreachable ?? 0)) dead")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)

            // Whether the terminal can actually put any of this in
            // somebody's inbox, above the queue counts. A ready-to-send
            // number is a promise, and a promise the app cannot keep
            // because no mailbox is connected should say so here rather
            // than at the moment somebody presses send.

            // The outreach workbench. What has come BACK lives in INBX now:
            // a reply is not about one project, it is about the person who
            // wrote it, and burying it under whichever ticker they were
            // first written about is why nobody found Kanter's.
            // Scheduling changes the funnel line, the rows and the
            // badge, none of which live in this control. Without the
            // callback the line above kept saying "5 queued to send"
            // while the block below it listed thirteen, because the two
            // are different payloads and nothing refreshed them together.
            SendAllControl(projectID: p.id, onChanged: reload)

            // Approval and compliance state on one line, because
            // "approved" and "screened" are different claims and a
            // reader who sees only the first will assume the second.
            queueLine(q)

            chaseLine(targets)

            addTargetForm

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
                PanelMessage(text: "No targets yet. Map the value chain, add the names above, then work the list.")
            } else if shown.isEmpty {
                // An empty bucket is good news here, and a blank table
                // does not say so.
                Text("None in this bucket.").font(Term.mono(11)).foregroundStyle(Term.positive)
            } else {
                ForEach(shown) { t in
                    targetRow(t)
                }
            }

            Text("The whole funnel runs here: add a name, draft, screen, approve, send, log the reply, move the status.")
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
            + (q.screenBlocked ?? 0) + (q.screenElevated ?? 0) + notScreened
            + (q.replied ?? 0) + (q.queued ?? 0) + (q.scheduled ?? 0) + (q.bounced ?? 0)
            + (q.autoRepliedOnly ?? 0) > 0 {
            HStack(spacing: 12) {
                // Answers first. A strip that only ever reports problems
                // makes a campaign look like a list of failures.
                if let n = q.replied, n > 0 {
                    Text("\(n) replied").foregroundStyle(Term.positive).bold()
                }
                if let n = q.readyToSend, n > 0 {
                    Text("\(n) ready").foregroundStyle(Term.positive)
                }
                if let n = q.scheduled, n > 0 {
                    Text("\(n) queued to send").foregroundStyle(Term.cyan)
                }
                // Named differently on purpose. This one is not on our
                // clock at all: somebody has it open in a mail client.
                if let n = q.queued, n > 0 {
                    Text("\(n) in a mailbox").foregroundStyle(Term.cyan)
                }
                if let n = q.bounced, n > 0 {
                    Text("\(n) bounced").foregroundStyle(Term.negative)
                }
                if let n = q.autoRepliedOnly, n > 0 {
                    Text("\(n) out of office").foregroundStyle(Term.amber)
                }
                if let n = q.rejected, n > 0 {
                    Text("\(n) pulled").foregroundStyle(Term.negative)
                        .help("Letters a president stopped before they went out. Not people who turned us down.")
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

    /// What to send today, and when the next one comes up.
    ///
    /// The point is that a quiet day still says something. "Nothing due"
    /// with the next date attached is an answer; a blank strip is not,
    /// and would be indistinguishable from the feature not working.
    @ViewBuilder
    private func chaseLine(_ targets: [Target]) -> some View {
        let rows = targets.compactMap { t in t.followUp.map { (t, $0) } }
        let now = rows.filter { $0.1.isActionable }
        if !rows.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                if now.isEmpty {
                    let next = rows.compactMap { $0.1.state == "waiting" ? $0.1.dueAt : nil }.sorted().first
                    Text(next.map { "Nothing to chase today. Next follow-up due \($0)." }
                         ?? "Nothing to chase.")
                        .font(Term.mono(10)).foregroundStyle(Term.positive)
                } else {
                    Text("FOLLOW UP TODAY")
                        .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.amber)
                    Text(now.map { $0.0.name }.joined(separator: ", "))
                        .font(Term.mono(10)).foregroundStyle(Term.white)
                        .lineLimit(2)
                }
                Spacer()
            }
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
            StageChip(draft: t.primaryDraft, alsoHolding: t.otherLiveDrafts)
                .frame(width: 160, alignment: .trailing)
            // The status writes straight through — moving a name off
            // "Identified" also stamps lastContactAt on the server.
            statusMenu(t)
                .frame(width: 92, alignment: .trailing)
            VStack(alignment: .trailing, spacing: 1) {
                Text(t.lastContactAt.map { Fmt.date($0) } ?? "—")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                if let f = t.followUp, let label = f.label {
                    Text(label)
                        .font(Term.mono(8, weight: f.isActionable ? .bold : .regular))
                        .foregroundStyle(f.tint)
                        .lineLimit(1)
                        .help(f.recommendation ?? "")
                }
            }
            .frame(width: 84, alignment: .trailing)
        }
        .padding(.vertical, 4)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
    }

    /// Adding a name is the other edit the funnel needs weekly, and it
    /// used to mean opening a browser. Collapsed by default so the tab
    /// still opens on the list rather than on a form.
    @ViewBuilder private var addTargetForm: some View {
        if adding {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    TextField("Name", text: $nName)
                        .textFieldStyle(.plain).termInput(width: 150)
                    TermPicker(options: Self.relationships, value: $nRelationship,
                               placeholder: "Relationship")
                    TextField("Employer", text: $nEmployer)
                        .textFieldStyle(.plain).termInput(width: 140)
                    TextField("Role", text: $nRole)
                        .textFieldStyle(.plain).termInput(width: 140)
                }
                HStack(spacing: 6) {
                    TextField("Email (optional)", text: $nEmail)
                        .textFieldStyle(.plain).termInput(width: 190)
                    TextField("Why this person", text: $nNotes)
                        .textFieldStyle(.plain).termInput(width: 250)
                        .onSubmit { addTarget() }
                    Button("Add") { addTarget() }
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy || nName.isEmpty || nRelationship.isEmpty)
                    Button("Cancel") { adding = false; clearTarget() }
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy)
                }
                Text("Name and relationship required. A malformed address is rejected rather than stored, because a bad one looks like a working address until the bounce comes back.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            .padding(.vertical, 4)
        } else {
            Button("+ ADD NAME") { adding = true }
                .buttonStyle(TermButtonStyle())
                .disabled(busy)
        }
    }

    private func addTarget() {
        guard !nName.isEmpty, !nRelationship.isEmpty else { return }
        let fields = [
            "name": nName, "relationship": nRelationship, "employer": nEmployer,
            "role": nRole, "email": nEmail, "notes": nNotes,
        ]
        let path = "/research/projects/\(p.id)/targets"
        Task { await run {
            try await ResearchWrite.create(path, text: fields)
            clearTarget()
            adding = false
        } }
    }

    private func clearTarget() {
        nName = ""; nRelationship = ""; nEmployer = ""
        nRole = ""; nEmail = ""; nNotes = ""
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

                // The one sentence somebody opening this record wants:
                // is it my move, and if not, when does it become my move.
                if let f = t.followUp, let rec = f.recommendation {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(rec)
                            .font(Term.mono(11, weight: f.isActionable ? .bold : .regular))
                            .foregroundStyle(f.isActionable ? Term.amber : Term.fgDim)
                        if f.autoReplyReset == true {
                            Text("Clock restarted at their out-of-office — no point chasing somebody on holiday.")
                                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Term.bgHeader)
                }

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

// The outreach email panel. The app does not send the mail — it goes
// from a real person's school address — so what this panel owes the
// user is the text, verbatim and copyable, plus the compliance read.
private struct DraftsSection: View {
    let target: Target
    @Binding var busy: Bool
    let run: RunAction

    @State private var composing = false
    @State private var subject = ""
    @State private var bodyText = ""

    var body: some View {
        // Oldest first. A contact is a conversation and it reads forwards:
        // the email we sent, the reply that came back underneath it, then
        // whatever we sent next. Newest-first put our answer above the
        // question it answered.
        let drafts = (target.drafts ?? []).sorted { $0.id < $1.id }
        // Correspondence that never came from a draft in this app: a
        // thread run out of Outlook before the log existed, or one
        // started by a colleague. Without this it is stored and
        // invisible, because the thread view lives inside a draft card
        // and there is no card to hang it on.
        let unlinked = (target.messages ?? []).filter { $0.draftId == nil }
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

            if !unlinked.isEmpty {
                UnlinkedThread(target: target, messages: unlinked, busy: $busy, run: run)
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
                        Text("Anything written here is screened by compliance before it goes out.")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    }
                }
            } else if drafts.isEmpty {
                Text("Nothing drafted. Anything written here is screened by compliance before it goes out.")
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

/// A thread with no draft behind it, rendered on the target itself.
///
/// The in-card log answers "what happened to this email". This answers
/// "what has passed between us and this person", which is the same
/// question one level up and the only place a conversation started
/// outside the app can live.
private struct UnlinkedThread: View {
    let target: Target
    let messages: [Message]
    @Binding var busy: Bool
    let run: RunAction

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("CORRESPONDENCE")
                    .font(Term.mono(9, weight: .bold)).tracking(0.6).foregroundStyle(Term.white)
                Text("not sent from a draft here")
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
                .padding(.leading, r.outbound ? 0 : 18)
            }
        }
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

    /// A sent email is history. It collapses to one line so the draft you
    /// can still act on is not buried under four hundred words already
    /// gone. nil means "use the default for this draft"; a tap pins it.
    @State private var expandedOverride: Bool? = nil
    private var isExpanded: Bool { expandedOverride ?? (draft.sentAt == nil) }

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
    @State private var sending = false
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
                if let r = d.screenReason, isExpanded {
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
                // Editing re-runs the compliance screen on the new words.
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
                Button { expandedOverride = !isExpanded } label: {
                    HStack(spacing: 6) {
                        Text(isExpanded ? "v" : ">")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        Text(d.subject).font(Term.mono(11, weight: .medium))
                            .foregroundStyle(Term.white).lineLimit(1)
                        Spacer(minLength: 4)
                        // What a closed row has to answer: when did it go,
                        // and did anything come back.
                        if !isExpanded {
                            if let sent = d.sentAt {
                                Text("sent \(Fmt.date(sent))")
                                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            }
                            if !messages.isEmpty {
                                Text("\(messages.count) reply\(messages.count == 1 ? "" : "s")")
                                    .font(Term.mono(9)).foregroundStyle(Term.positive)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)

                // WHO IT IS GOING TO, above the words themselves.
                //
                // The card used to lead with a Copy button and never once
                // said the address. Somebody about to send is checking two
                // things, who receives it and who else sees it, and
                // neither was on screen.
                HStack(spacing: 6) {
                    Text("to").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    Text(target.email ?? "no address")
                        .font(Term.mono(10)).foregroundStyle(target.email == nil ? Term.negative : Term.fg)
                    if let cc = d.cc, !cc.isEmpty {
                        Text("cc").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        Text(cc).font(Term.mono(10)).foregroundStyle(Term.blue)
                    }
                    Spacer()
                }

                if isExpanded {
                    ScrollView {
                        Text(d.body)
                            .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 260)
                }
            }

            if !editing && d.sentAt == nil {
                HStack(spacing: 6) {
                    // An exec can still veto a draft outright; it just is
                    // not required for one to go out.
                    if d.canIApprove == true {
                        Button("Reject") { rejecting.toggle() }
                            .buttonStyle(TermButtonStyle()).disabled(busy)
                    }
                    Button("Edit") {
                        subject = d.subject; bodyText = d.body; editing = true
                    }
                    .buttonStyle(TermButtonStyle()).disabled(busy)

                    if d.fullyApproved == true {
                        // Copy is back, and it earned its way back.
                        //
                        // It was removed when the app became the sender,
                        // on the reasoning that pasting into Gmail
                        // described a world that had ended. That was half
                        // right. Threads that BEGAN somewhere else still
                        // have to be answered from there: a reply to a
                        // source first written to from the school address
                        // must go out from that address, or it reaches
                        // them as a stranger breaking into a conversation.
                        // Two of the three real correspondences on Signet
                        // are in exactly that position.
                        //
                        // Same gate as Send. A veto you can copy past
                        // reads as oversight that is not happening.
                        Button(copied ? "Copied" : "Copy") { copyBlock(d) }
                            .buttonStyle(TermButtonStyle()).disabled(busy)
                            .help("To send by hand, from a mailbox the terminal is not connected to.")

                        Button(sending ? "Sending" : "Send now") {
                            Task {
                                sending = true
                                defer { sending = false }
                                await run {
                                    _ = try await API.shared.post("/research/drafts/\(d.id)/deliver", json: [:])
                                }
                            }
                        }
                        .buttonStyle(TermButtonStyle()).disabled(busy || sending)
                        .help("Sends it from your own mailbox, now. There is no undo.")
                    }
                    Spacer()
                }
            }

            if d.sentAt != nil && isExpanded { replyLog(d) }

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
    /// Address, subject and body in one block, in the order the compose
    /// window asks for them. Shared by the open card and the closed row,
    /// because copying is the whole point of this screen and should never
    /// be more than one click away.
    private func copyBlock(_ d: Draft) {
        let who = [target.role, target.employer]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
        let to: String
        if let addr = target.email, !addr.isEmpty {
            // Bare address, nothing after it. The name and role used to
            // ride along in brackets as a last check before sending, and
            // Gmail's address parser chokes on them, so every one of 57
            // pastes needed the annotation deleted by hand. The identity
            // belongs on screen beside the button, not in the clipboard.
            _ = who
            to = "To: \(addr)"
        } else {
            to = "To: NO ADDRESS ON FILE for \(target.name), do not send"
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("\(to)\nSubject: \(d.subject)\n\n\(d.body)", forType: .string)
        copied = true
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
    }

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
                // Only inbound gets logged by hand. "Log what we sent" was
                // a second way to record an outbound email alongside Mark as
                // sent, and two doors onto one fact is how the funnel and
                // the thread end up disagreeing about whether we wrote.
                // Marking the draft sent is the record of what we sent.
                Button("Log a reply") { beginLog(out: false) }
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
                    TextField(Fmt.localStampHint, text: $replyWhen)
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
        replyKind = out ? "Scheduling" : "Reply"
        replyWhen = Self.nowLocal()
        replyBody = ""
        replyAction = ""
        logging = true
    }

    private static let sentKinds: [(String, String, String)] = [
        ("Outreach", "WE WROTE FIRST", "The opening email, when it was not sent from a draft here"),
        ("Scheduling", "WE SENT DATES", "Times offered, waiting on them to pick"),
        ("Reply", "WE REPLIED", "We answered something they asked"),
        ("FollowUp", "WE FOLLOWED UP", "A chase on an email with no answer"),
        ("Other", "WE SENT", "Anything else we sent"),
    ]

    private static let replyKinds: [(String, String, String)] = [
        // Reply leads because the picker defaults to whatever comes first
        // and this is the commonest real event. AutoReply used to lead, so
        // anyone who did not touch the control filed a human answer as a
        // robot and the chase clock went on hunting somebody who had
        // already written back.
        ("Reply", "REPLIED", "A real answer. Neither a yes nor a no"),
        ("Interested", "INTERESTED", "They are willing to talk"),
        ("Declined", "DECLINED", "They said no. The target closes"),
        ("Bounce", "BOUNCED", "Dead address. The target becomes unreachable"),
        ("AutoReply", "AUTO-REPLY", "Out of office. Nobody has read it yet, so this is still waiting"),
        ("Other", "OTHER", "Anything that does not clearly fit"),
    ]

    /// Local wall-clock, which is what someone reading their inbox is
    /// looking at. Converted to an instant on the way out.
    ///
    /// Both defer to Fmt rather than keeping a second copy of the format:
    /// this panel and the interview form ask the same question of the same
    /// person, and two copies is how one of them ends up in another clock.
    private static func nowLocal() -> String { Fmt.localStamp() }

    private static func iso(from local: String) -> String? { Fmt.isoFromLocal(local) }

    @ViewBuilder
    private func stateLine(_ d: Draft) -> some View {
        if let sent = d.sentAt {
            Text("SENT \(Fmt.date(sent))\(d.sentBy?.name.map { " by \($0)" } ?? "")")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.fgMuted)
        } else if d.rejectedAt != nil {
            Text("PULLED by \(d.rejectedBy?.name ?? "someone"), will not be sent: \(d.reviewNote ?? "no reason given")")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.negative)
        } else if d.screenBlocked == true {
            Text("BLOCKED by the compliance screen — cannot be approved or sent as written")
                .font(Term.mono(9, weight: .bold)).tracking(0.5).foregroundStyle(Term.negative)
        } else if d.fullyApproved == true {
            // Never claim a person signed this off when nobody did.
            // REQUIRED_APPROVALS is 0 by decision, so fullyApproved is true
            // the moment a draft exists, and printing "APPROVED by" with an
            // empty name list made an unread email look reviewed, directly
            // above an orange compliance flag.
            let names = d.approvedByNames ?? []
            Text(names.isEmpty
                 ? ""
                 : "APPROVED by \(names.joined(separator: " and ")), ready to send")
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
    @Binding var busy: Bool
    let run: RunAction
    let onOpenTranscript: (Int) -> Void

    @State private var opening = false
    @State private var importingFor: Int?
    @State private var working: String?

    var body: some View {
        let list = p.interviews ?? []
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button(opening ? "Cancel" : "+ New interview") { opening.toggle() }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
                if let w = working {
                    Text(w).font(Term.mono(9)).foregroundStyle(Term.amber)
                }
                Spacer()
            }
            if opening {
                NewInterviewForm(projectId: p.id, ticker: p.ticker, busy: $busy, run: run,
                                 onDone: { opening = false })
                    .padding(8).background(Term.bg).termBorder()
            }
            if let id = importingFor {
                TranscriptImportForm(interviewId: id, busy: $busy, run: run,
                                     onDone: { importingFor = nil })
                    .padding(8).background(Term.bg).termBorder()
            }
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
        }
    }

    /// What this interview still owes, as buttons rather than a sentence
    /// pointing at another application. Each one is hidden when the
    /// server would refuse it: no audio without consent, no extraction
    /// without a transcript. A control that always 409s teaches nothing.
    @ViewBuilder
    private func interviewActions(_ iv: ProjectFull.Interview) -> some View {
        let hasTranscript = !(iv.transcript?.isEmpty ?? true)
        let claims = iv.counts?.claims ?? 0
        HStack(spacing: 6) {
            if !hasTranscript {
                if iv.consentObtained == true {
                    Button("Upload recording") { pickRecording(for: iv.id) }
                        .buttonStyle(TermButtonStyle()).disabled(busy || working != nil)
                } else {
                    Text("no consent on file — audio cannot be stored")
                        .font(Term.mono(9)).foregroundStyle(Term.amber)
                }
                Button("Import transcript") { importingFor = iv.id }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
            }
            if hasTranscript && claims == 0 && !(iv.quarantined ?? false) {
                Button("Extract claims") {
                    let id = iv.id
                    Task {
                        working = "Extracting claims…"
                        await run { _ = try await API.shared.post("/research/interviews/\(id)/extract", json: [:]) }
                        working = nil
                    }
                }
                .buttonStyle(TermButtonStyle()).disabled(busy || working != nil)
            }
            if hasTranscript {
                Button("Re-screen") {
                    let id = iv.id
                    Task {
                        working = "Screening…"
                        await run { _ = try await API.shared.post("/research/interviews/\(id)/screen", json: [:]) }
                        working = nil
                    }
                }
                .buttonStyle(TermButtonStyle()).disabled(busy || working != nil)
            }
            Spacer()
        }
    }

    /// Audio only. The server takes what it is given, but a video file is
    /// a hundred megabytes of pixels nobody transcribes, so the picker
    /// says what it wants.
    private func pickRecording(for id: Int) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Pick the recording"
        panel.prompt = "Upload"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            working = "Uploading and transcribing \(url.lastPathComponent)…"
            await run {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                _ = try await API.shared.upload("/research/interviews/\(id)/recording",
                                               fileURL: url, fields: [:])
            }
            working = nil
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
                interviewActions(iv)
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
    @Binding var busy: Bool
    let run: RunAction

    // Day-part is free text on the server but a fixed list here: the
    // whole value of the field is comparing like with like, and one
    // analyst writing "morning" while another writes "Weekday AM"
    // destroys that silently.
    private static let dayParts = [
        "Weekday AM", "Weekday midday", "Weekday PM",
        "Weekday evening", "Saturday", "Sunday",
    ]
    private static let obsKinds = [
        "condition", "measurement", "pricing", "traffic", "assortment", "other",
    ]

    @State private var logging = false
    @State private var vLocation = ""
    @State private var vBanner = ""
    @State private var vDayPart = ""
    @State private var vWeather = ""
    @State private var vNotes = ""

    @State private var obsFor: Int?
    @State private var oText = ""
    @State private var oKind = "condition"
    @State private var oQuestionID: Int?

    var body: some View {
        let visits = p.visits ?? []
        VStack(alignment: .leading, spacing: 8) {
            logVisitForm

            if visits.isEmpty {
                PanelMessage(text: "No visits logged. For a retail name this is most of the work, and three different stores beat three trips to one.")
            } else {
                ForEach(visits) { v in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(v.location).font(Term.mono(11)).foregroundStyle(Term.white)
                            if let b = v.banner {
                                Text("· \(b)").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                            }
                            Spacer()
                            Button(obsFor == v.id ? "CLOSE" : "+ OBSERVATION") {
                                obsFor = (obsFor == v.id) ? nil : v.id
                                oText = ""; oKind = "condition"; oQuestionID = nil
                            }
                            .buttonStyle(TermButtonStyle())
                            .disabled(busy)
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

                        if obsFor == v.id {
                            observationForm(visitID: v.id)
                        }
                    }
                    .padding(.vertical, 4)
                    .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
                }
            }
            Text("Observations count toward question coverage by distinct location, so link one to the question it answers. Eight trips to one store is still one data point.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
    }

    @ViewBuilder private var logVisitForm: some View {
        if logging {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    TextField("Location", text: $vLocation)
                        .textFieldStyle(.plain).termInput(width: 190)
                    TextField("Banner / fascia", text: $vBanner)
                        .textFieldStyle(.plain).termInput(width: 140)
                    TermPicker(options: Self.dayParts, value: $vDayPart,
                               placeholder: "Day part", width: 128)
                    TextField("Weather", text: $vWeather)
                        .textFieldStyle(.plain).termInput(width: 110)
                }
                HStack(spacing: 6) {
                    TextField("What the trip was for, and what you saw overall", text: $vNotes)
                        .textFieldStyle(.plain).termInput(width: 420)
                        .onSubmit { logVisit() }
                    Button("Log") { logVisit() }
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy || vLocation.isEmpty)
                    Button("Cancel") { logging = false; clearVisit() }
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy)
                }
                Text("Location is required. The visit is stamped now unless you are backfilling, and it inherits the project ticker.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            .padding(.vertical, 4)
        } else {
            Button("+ LOG VISIT") { logging = true }
                .buttonStyle(TermButtonStyle())
                .disabled(busy)
        }
    }

    private func observationForm(visitID: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                TextField("What you observed", text: $oText)
                    .textFieldStyle(.plain).termInput(width: 300)
                    .onSubmit { addObservation(visitID: visitID) }
                TermPicker(options: Self.obsKinds, value: $oKind,
                           placeholder: "kind", width: 108)
                questionLink
                Button("Add") { addObservation(visitID: visitID) }
                    .buttonStyle(TermButtonStyle())
                    .disabled(busy || oText.isEmpty)
            }
        }
        .padding(.leading, 8)
        .padding(.vertical, 2)
    }

    /// Linking an observation to a question is what turns a store trip
    /// into coverage rather than an anecdote, so the picker is inline
    /// rather than a second step somebody skips.
    @ViewBuilder private var questionLink: some View {
        let qs = p.questions ?? []
        if qs.isEmpty {
            Text("no questions to link")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        } else {
            Menu {
                Button("Not linked") { oQuestionID = nil }
                ForEach(qs) { q in
                    Button(String(q.text.prefix(70))) { oQuestionID = q.id }
                }
            } label: {
                Text(oQuestionID == nil
                     ? "link to question"
                     : "Q\(qs.firstIndex(where: { $0.id == oQuestionID }).map { $0 + 1 } ?? 0)")
                    .font(Term.mono(10))
                    .foregroundStyle(oQuestionID == nil ? Term.fgMuted : Term.positive)
            }
            .menuStyle(.borderlessButton)
            .frame(width: 116, alignment: .leading)
        }
    }

    private func logVisit() {
        guard !vLocation.isEmpty else { return }
        let fields = [
            "location": vLocation, "banner": vBanner,
            "dayPart": vDayPart, "weather": vWeather, "notes": vNotes,
        ]
        let path = "/research/projects/\(p.id)/visits"
        Task { await run {
            try await ResearchWrite.create(path, text: fields)
            clearVisit()
            logging = false
        } }
    }

    private func addObservation(visitID: Int) {
        guard !oText.isEmpty else { return }
        let fields = ["text": oText, "kind": oKind]
        let nums = oQuestionID.map { ["questionId": $0] } ?? [:]
        let path = "/research/visits/\(visitID)/observations"
        Task { await run {
            try await ResearchWrite.create(path, text: fields, numbers: nums)
            oText = ""; oQuestionID = nil
        } }
    }

    private func clearVisit() {
        vLocation = ""; vBanner = ""; vDayPart = ""; vWeather = ""; vNotes = ""
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
    @State private var openFolders: Set<String> = []
    @State private var syncing: String?
    @ObservedObject private var drive = GriffinDrive.shared

    /// What the drive is doing, in one line. Pushing, pulling and idle
    /// are three different states and an idle sync that never says so
    /// looks identical to a broken one.
    private var driveStatusLine: String {
        let s = drive.status
        if s.pending > 0 { return "uploading \(s.pending)…" }
        if let e = s.error { return "last error: \(e)" }
        let bits = [s.lastPush.map { "pushed \($0)" }, s.lastPull.map { "pulled \($0)" }]
            .compactMap { $0 }
        return bits.isEmpty ? "watching, nothing changed yet" : bits.joined(separator: " · ")
    }

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
                    // No switch. The drive runs for every project from
                    // launch; this line only says what it is doing.
                    Text(driveStatusLine)
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
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
                    // Full path here on purpose: a key document is being
                    // pulled out of its folder, so it has to say where it
                    // actually lives.
                    ForEach(key) { a in artifactRow(a, label: a.title) }
                }

                // Two hundred files in one flat list is a list nobody
                // reads. The paths were already in the titles — model/,
                // research/annual-reports/, report/ — so the folders
                // existed and were simply not being rendered as folders.
                let groups = Self.grouped(rest)
                if !groups.isEmpty {
                    Text("FOLDERS (\(groups.count))")
                        .font(Term.mono(9, weight: .bold)).tracking(0.6)
                        .foregroundStyle(Term.fgMuted)
                        .padding(.top, key.isEmpty ? 2 : 8)
                }
                ForEach(groups, id: \.0) { name, items in
                    // Collapsed by default once a project is big enough
                    // for that to be a mercy; small ones open flat so a
                    // five-file project is not two clicks deep.
                    let open = openFolders.contains(name) || rest.count <= 24
                    Button {
                        if openFolders.contains(name) { openFolders.remove(name) }
                        else { openFolders.insert(name) }
                    } label: {
                        HStack(spacing: 6) {
                            Text(open ? "▾" : "▸")
                                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                .frame(width: 10, alignment: .leading)
                            Text(name)
                                .font(Term.mono(10, weight: .bold)).tracking(0.4)
                                .foregroundStyle(Term.blue)
                            Text("\(items.count)")
                                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            Spacer()
                        }
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                    if open {
                        // Basename only inside a folder. The header
                        // carries the path, so repeating it on every row
                        // just pushes the filename off the right edge.
                        ForEach(items) { a in
                            artifactRow(a, label: Self.basename(a.title))
                                .padding(.leading, 14)
                        }
                    }
                }
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

    /// Folder name and basename, split on the last slash. No slash means
    /// the file is loose at the root.
    static func split(_ title: String) -> (String?, String) {
        guard let i = title.lastIndex(of: "/") else { return (nil, title) }
        return (String(title[title.startIndex..<i]), String(title[title.index(after: i)...]))
    }

    static func basename(_ title: String) -> String {
        let n = split(title).1
        return n.isEmpty ? title : n
    }

    /// Grouped by path prefix, folders alphabetical, loose files last
    /// under a heading that says they are loose rather than pretending
    /// the root is a folder like any other.
    static func grouped(_ items: [ProjectFull.Artifact]) -> [(String, [ProjectFull.Artifact])] {
        var byFolder: [String: [ProjectFull.Artifact]] = [:]
        var loose: [ProjectFull.Artifact] = []
        for a in items {
            if let f = split(a.title).0, !f.isEmpty { byFolder[f, default: []].append(a) }
            else { loose.append(a) }
        }
        var out = byFolder.keys.sorted().map { ($0, byFolder[$0]!) }
        if !loose.isEmpty { out.append(("NOT IN A FOLDER", loose)) }
        return out
    }

    private func artifactRow(_ a: ProjectFull.Artifact, label: String? = nil) -> some View {
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
                    Text(label ?? a.title)
                        .font(Term.mono(11)).foregroundStyle(Term.amber)
                        .lineLimit(1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                .help("Read in place")
            } else if let item = DocumentViewer.itemId(from: a.fileRef) {
                Button { onOpenFile(item, a.title) } label: {
                    Text(label ?? a.title)
                        .font(Term.mono(11, weight: isKey ? .bold : .regular))
                        .foregroundStyle(isKey ? Term.amber : Term.white)
                        .lineLimit(1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                .help("Read it here, or open the original")
            } else {
                Text(label ?? a.title)
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
    // Each fieldwork row points at the tab it actually lives on. They
    // all pointed at FIELD before, so a search reported "FIELD (4)" for
    // three interviews and a claim and dropped the reader on whichever
    // sub-tab happened to be selected.
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
        // Search the ORIGINAL string case-insensitively. A String.Index
        // taken from body.lowercased() is not valid in body — lowercasing
        // can change length (Turkish İ becomes two scalars, ß, ligatures),
        // and offsetting that foreign index into body can slice mid-
        // grapheme or trap outright on non-ASCII notes.
        var at: String.Index?
        for t in terms {
            if let r = body.range(of: t, options: .caseInsensitive),
               at == nil || r.lowerBound < at! { at = r.lowerBound }
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
