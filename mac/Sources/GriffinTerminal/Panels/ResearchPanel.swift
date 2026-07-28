import SwiftUI

// RSCH / FLD — the research workspace.
//
// The web version is 2,400 lines across seven tabs. This carries the
// parts that are worked daily rather than read occasionally: the project
// list, the question spine with its coverage, and the outreach funnel
// with the two-signature approval gate.
//
// The gate is re-implemented honestly rather than reproduced visually.
// Every rule that matters is enforced on the server, so this panel does
// not decide whether you may approve or send; it asks, shows what came
// back, and never renders a state as safer than the server called it.
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
                                        Text(p.status)
                                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
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

struct Project: Decodable, Identifiable {
    let id: Int
    let name: String
    let ticker: String?
    let status: String
    let brief: String?
}

struct ProjectFull: Decodable {
    let id: Int
    let name: String
    let ticker: String?
    let brief: String?
    let targets: [Target]?
    let outreachQueue: Queue?
    let coverage: Coverage?

    struct Coverage: Decodable {
        struct Summary: Decodable {
            let supported: Int?
            let thin: Int?
            let unaddressed: Int?
        }
        let summary: Summary?
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
    let email: String?
    let tier: String?
    let relationship: String
    let status: String
    let priority: Int?
    let drafts: [Draft]?
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
    let screenState: String?
    let screenReason: String?
    let sentAt: String?
}

// MARK: Detail

private struct ProjectDetail: View {
    let projectId: Int
    let onBack: () -> Void

    @State private var state: Loadable<ProjectFull> = .loading
    @State private var busy = false
    @State private var err: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button("← Projects", action: onBack).buttonStyle(TermButtonStyle())
                if case .loaded(let p) = state {
                    Text(p.ticker ?? "").font(Term.mono(12, weight: .bold)).foregroundStyle(Term.amber)
                    Text(p.name).font(Term.mono(11)).foregroundStyle(Term.fgDim).lineLimit(1)
                }
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Divider().overlay(Term.border)

            if let err {
                Text(err).font(Term.mono(10)).foregroundStyle(Term.negative)
                    .padding(.horizontal, 10).padding(.top, 4)
            }

            PanelState(state: state, retry: { Task { await load() } }) { p in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if let q = p.outreachQueue { queueLine(q) }
                        Divider().overlay(Term.border)
                        SectionLabel(text: "Outreach")
                            .padding(.horizontal, 10)
                        ForEach((p.targets ?? []).sorted { ($0.priority ?? 99) < ($1.priority ?? 99) }) { t in
                            TargetRow(target: t, busy: $busy) { act in
                                await run(act)
                            }
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
        .task { await load() }
    }

    private func queueLine(_ q: ProjectFull.Queue) -> some View {
        HStack(spacing: 12) {
            if let n = q.awaitingMe, n > 0 {
                Text("\(n) waiting on you").foregroundStyle(Term.white)
            }
            if let n = q.awaitingReview, n > 0 {
                Text("\(n) awaiting sign-off").foregroundStyle(Term.fgDim)
            }
            if let n = q.readyToSend, n > 0 {
                Text("\(n) ready to send").foregroundStyle(Term.positive)
            }
            if let n = q.screenBlocked, n > 0 {
                Text("\(n) blocked").foregroundStyle(Term.negative)
            }
            // Not-fully-screened is its own state and never folded into
            // "clear" — the whole point of the screen chips on the web.
            let notScreened = (q.unscreened ?? 0) + (q.keywordOnly ?? 0)
            if notScreened > 0 {
                Text("\(notScreened) not fully screened").foregroundStyle(Term.orange)
            }
            Spacer()
        }
        .font(Term.mono(10))
        .padding(.horizontal, 10)
    }

    private func run(_ action: @escaping @MainActor @Sendable () async throws -> Void) async {
        busy = true; err = nil
        do { try await action(); await load() }
        catch { err = error.localizedDescription }
        busy = false
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/research/projects/\(projectId)")
            state = .loaded(try await API.shared.decode(ProjectFull.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

private struct TargetRow: View {
    let target: Target
    @Binding var busy: Bool
    let run: (@escaping @MainActor @Sendable () async throws -> Void) async -> Void

    @State private var expanded = false

    var body: some View {
        let draft = target.drafts?.first
        VStack(alignment: .leading, spacing: 4) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    Text("\(target.priority.map(String.init) ?? "—")")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                        .frame(width: 18, alignment: .trailing)
                    Text(target.name)
                        .font(Term.mono(11, weight: .medium)).foregroundStyle(Term.amber)
                        .frame(width: 140, alignment: .leading)
                    TierChip(tier: target.tier)
                    Text(target.employer ?? "")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted).lineLimit(1)
                    Spacer(minLength: 6)
                    StageChip(draft: draft)
                }
                .padding(.horizontal, 10).padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded, let d = draft {
                DraftCard(draft: d, busy: $busy, run: run)
                    .padding(.horizontal, 10)
            } else if expanded {
                Text("No draft written for \(target.name).")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    .padding(.horizontal, 30)
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }
}

private struct TierChip: View {
    let tier: String?
    var body: some View {
        if let t = tier, !t.isEmpty {
            let tone: Color = {
                switch t.lowercased() {
                case "witness":    return Term.white
                case "baseline":   return Term.cyan
                case "competitor": return Term.orange
                case "buyer":      return Term.orange
                default:           return Term.fgDim
                }
            }()
            Text(t.uppercased())
                .font(Term.mono(9)).foregroundStyle(tone)
                .padding(.horizontal, 4).padding(.vertical, 1)
                .overlay(Rectangle().strokeBorder(tone, lineWidth: 1))
        }
    }
}

private struct StageChip: View {
    let draft: Draft?

    var body: some View {
        if let d = draft {
            HStack(spacing: 6) {
                Text(label(d)).font(Term.mono(9, weight: .bold)).foregroundStyle(tone(d))
                if let s = d.screenState {
                    Text(screenLabel(s)).font(Term.mono(9)).foregroundStyle(screenTone(s))
                }
            }
        } else {
            Text("no draft").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
    }

    private func label(_ d: Draft) -> String {
        switch d.stage {
        case "sent":         return "SENT"
        case "rejected":     return "REJECTED"
        case "blocked":      return "BLOCKED"
        case "ready":        return "READY"
        default:             return "\(d.approvalCount ?? 0) of \(d.approvalsNeeded ?? 2)"
        }
    }

    private func tone(_ d: Draft) -> Color {
        switch d.stage {
        case "ready":                 return Term.positive
        case "rejected", "blocked":   return Term.negative
        case "sent":                  return Term.fgMuted
        case "one-approval":          return Term.amber
        default:                      return Term.fgDim
        }
    }

    // Never collapse "unscreened" or "keyword only" into a pass.
    private func screenLabel(_ s: String) -> String {
        switch s {
        case "prohibited":          return "BLOCKED"
        case "elevated":            return "FLAGGED"
        case "clear":               return "screened"
        case "clear-keyword-only":  return "part-screened"
        default:                    return "unscreened"
        }
    }

    private func screenTone(_ s: String) -> Color {
        switch s {
        case "prohibited":          return Term.negative
        case "elevated":            return Term.orange
        case "clear":               return Term.positive
        case "clear-keyword-only":  return Term.orange
        default:                    return Term.fgMuted
        }
    }
}

private struct DraftCard: View {
    let draft: Draft
    @Binding var busy: Bool
    let run: (@escaping @MainActor @Sendable () async throws -> Void) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let r = draft.screenReason,
               let s = draft.screenState, s != "clear" {
                Text(r).font(Term.mono(9)).foregroundStyle(Term.orange)
            }
            Text(draft.subject).font(Term.mono(11, weight: .medium)).foregroundStyle(Term.white)
            ScrollView {
                Text(draft.body)
                    .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 240)

            HStack(spacing: 6) {
                if draft.canIApprove == true {
                    Button("Approve") {
                        Task { await run { _ = try await API.shared.post("/research/drafts/\(draft.id)/approve", json: [:]) } }
                    }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
                }
                if draft.iApproved == true, draft.sentAt == nil {
                    Text("you approved this").font(Term.mono(9)).foregroundStyle(Term.positive)
                }
                Button("Copy") {
                    let t = "Subject: \(draft.subject)\n\n\(draft.body)"
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(t, forType: .string)
                }
                .buttonStyle(TermButtonStyle())
                // Copy is the send button, so it stays shut until the
                // server says both signatures are in.
                .disabled(draft.fullyApproved != true)
                Spacer()
            }
        }
        .padding(8)
        .background(Term.bg)
        .termBorder()
        .padding(.bottom, 6)
    }
}
