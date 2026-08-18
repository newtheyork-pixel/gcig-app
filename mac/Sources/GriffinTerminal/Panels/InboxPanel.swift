import SwiftUI

// INBX. Everything that has come back, across every project, newest first.
//
// It used to live inside the Research panel, under whichever ticker the
// person was first written about. That is the wrong home and the reason
// nobody found Kanter's reply for days: an answer is not about a project,
// it is about the person who sent it, and a reader looking for "what came
// in" should not have to guess which name it came in under.
//
// Read-only on purpose. Answering happens where there is a keyboard and a
// thread to answer inside, and a reply typed from a list is a reply
// written without the correspondence in front of it.

struct InboxPayload: Decodable {
    let messages: [Msg]?
    let counts: Counts?
    struct Counts: Decodable { let total: Int?; let owed: Int? }
    struct Msg: Decodable, Identifiable {
        let id: Int
        let direction: String?
        let kind: String?
        let occurredAt: String?
        let body: String?
        let target: T?
        let followUp: F?
        struct T: Decodable {
            let id: Int?; let name: String?; let employer: String?; let role: String?
            let project: P?
            struct P: Decodable { let id: Int?; let ticker: String?; let name: String? }
        }
        struct F: Decodable { let state: String?; let recommendation: String? }
    }
}

struct InboxPanel: View {
    @State private var state: Loadable<InboxPayload> = .loading
    /// Owed-only is the working view: the whole point of an inbox here is
    /// who is still waiting on us, not a chronology of everything ever said.
    @State private var owedOnly = false
    @State private var expanded: Set<Int> = []
    /// The mailbox behind the inbox. Nil while we are still asking; a
    /// failed status is deliberately NOT treated as disconnected, because
    /// telling somebody to connect a mailbox they already connected is a
    /// worse error than showing them a stale list.
    @State private var gmail: GmailStatus?
    @State private var gmailAsked = false
    @State private var connecting = false
    @State private var connectNote: String?

    /// Connected AND healthy. Anything else means mail cannot arrive, and
    /// the panel should say so instead of rendering an honest-looking
    /// empty list that will never fill.
    private var mailboxWorking: Bool {
        guard let g = gmail else { return true }   // unknown: do not nag
        return g.configured == true && g.allowed == true
            && g.connected == true && g.revokedAt == nil
    }

    var body: some View {
        Group {
            if gmailAsked && !mailboxWorking {
                GmailConnectPanel(
                    status: gmail,
                    busy: connecting,
                    note: connectNote,
                    onConnect: { Task { await connect() } },
                    onRecheck: { Task { await loadGmail(); await load() } }
                )
            } else {
                inbox
            }
        }
        .task { await loadGmail() }
    }

    private var inbox: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if case .loaded(let p) = state {
                    Text("\(p.counts?.total ?? 0) in")
                        .font(Term.mono(11)).foregroundStyle(Term.fgMuted)
                    Text("\(p.counts?.owed ?? 0) owed a reply")
                        .font(Term.mono(11))
                        .foregroundStyle((p.counts?.owed ?? 0) > 0 ? Term.orange : Term.fgMuted)
                }
                Button(owedOnly ? "SHOWING OWED" : "SHOW ALL") { owedOnly.toggle() }
                    .buttonStyle(TermButtonStyle())
                Button("REFRESH") { Task { await load() } }.buttonStyle(TermButtonStyle())
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 6)

            PanelState(state: state,
                       emptyWhen: { ($0.messages ?? []).isEmpty },
                       emptyText: "Nothing has come in yet.",
                       retry: { Task { await load() } }) { p in
                let rows = (p.messages ?? []).filter { !owedOnly || $0.followUp?.state == "owed" }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { m in row(m) }
                    }
                }
            }
        }
        .task { await load() }
    }

    private func loadGmail() async {
        defer { gmailAsked = true }
        do {
            let d = try await API.shared.get("/gmail/status")
            gmail = try await API.shared.decode(GmailStatus.self, from: d)
        } catch {
            // Leave it nil. An unreachable status endpoint is our outage,
            // not evidence that the member never connected anything.
            gmail = nil
        }
    }

    private func connect() async {
        connecting = true; connectNote = nil
        defer { connecting = false }
        do {
            let d = try await API.shared.get("/gmail/connect")
            struct Link: Decodable { let url: String }
            let link = try await API.shared.decode(Link.self, from: d)
            guard let u = URL(string: link.url) else {
                connectNote = "The server sent a link we could not open."
                return
            }
            NSWorkspace.shared.open(u)
            connectNote = "Approve it in the browser, then come back and press recheck. The link expires in ninety seconds."
        } catch {
            connectNote = error.localizedDescription
        }
    }

    private func row(_ m: InboxPayload.Msg) -> some View {
        let owed = m.followUp?.state == "owed"
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(m.target?.name ?? "Unknown")
                    .font(Term.mono(12, weight: .bold)).foregroundStyle(Term.fg)
                if let e = m.target?.employer {
                    Text(e).font(Term.mono(10)).foregroundStyle(Term.fgDim).lineLimit(1)
                }
                if let t = m.target?.project?.ticker {
                    Text(t).font(Term.mono(9)).foregroundStyle(Term.blue)
                }
                // The kind matters more than it looks. An auto-reply is not
                // being heard from and must not stop a chase clock; a bounce
                // needs a new address rather than another send.
                if let k = m.kind, k != "Reply" {
                    Text(k.uppercased()).font(Term.mono(9))
                        .foregroundStyle(k == "Bounce" ? Term.negative : Term.orange)
                }
                if owed {
                    Text("OWED").font(Term.mono(9, weight: .bold)).foregroundStyle(Term.negative)
                }
                Spacer()
                Text(Fmt.shortDateTime(m.occurredAt))
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
            if let b = m.body, !b.isEmpty {
                Text(b)
                    .font(Term.mono(11)).foregroundStyle(Term.fgDim)
                    .lineLimit(expanded.contains(m.id) ? nil : 2)
                    .textSelection(.enabled)
                    .onTapGesture {
                        if expanded.contains(m.id) { expanded.remove(m.id) } else { expanded.insert(m.id) }
                    }
            }
            if owed, let r = m.followUp?.recommendation {
                Text(r).font(Term.mono(10)).foregroundStyle(Term.orange)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            if owed { Rectangle().fill(Term.negative).frame(width: 2) }
        }
        .background(Term.bgPanel)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private func load() async {
        do {
            let d = try await API.shared.get("/research/inbox")
            state = .loaded(try await API.shared.decode(InboxPayload.self, from: d))
        } catch { state = .failed(error.localizedDescription) }
    }
}
