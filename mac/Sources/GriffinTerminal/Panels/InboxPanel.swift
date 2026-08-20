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
        let subject: String?
        let body: String?
        let target: T?
        let followUp: F?
        struct T: Decodable {
            let id: Int?; let name: String?; let employer: String?; let role: String?
            /// Where the bounce came from, so a dead address is nameable
            /// on the row rather than one more click away.
            let email: String?
            let project: P?
            struct P: Decodable { let id: Int?; let ticker: String?; let name: String? }
        }
        struct F: Decodable {
            let state: String?
            let recommendation: String?
            let resumeAfter: String?
        }
    }
}

struct InboxPanel: View {
    @State private var state: Loadable<InboxPayload> = .loading
    /// Owed-only is the working view: the whole point of an inbox here is
    /// who is still waiting on us, not a chronology of everything ever said.
    @State private var filter: Filter = .all
    @State private var expanded: Set<Int> = []
    /// Last successful read, so the header can say how fresh this is
    /// rather than leaving a reader to guess whether it is live.
    @State private var lastLoad: Date?
    @State private var syncing = false
    @State private var syncNote: String?
    /// Which message has a reply box open, and what is in it. One at a
    /// time on purpose: two half-written answers in a list is how the
    /// wrong one gets sent.
    @State private var replyingTo: Int?
    @State private var replyText = ""
    @State private var sending = false
    @State private var rowNote: [Int: String] = [:]
    @State private var sentJustNow: Set<Int> = []
    // Compose. A new letter, to somebody already in the book.
    @State private var composing = false
    @State private var pick = ""
    @State private var contacts: [Contact] = []
    @State private var toTarget: Contact?
    @State private var newSubject = ""
    @State private var newBody = ""
    @State private var composeNote: String?

    struct Contact: Decodable, Identifiable, Equatable {
        let id: Int
        let name: String?
        let email: String?
        let employer: String?
        let status: String?
    }

    enum Filter: String, CaseIterable {
        case all = "ALL", owed = "OWED", bounced = "BOUNCED", replies = "REPLIES"
        var label: String { rawValue }
    }

    /// Sixty seconds.
    ///
    /// This endpoint is a database read, not a Gmail call, and the
    /// terminal's data routes share 900 requests per ten minutes per
    /// caller, so one a minute spends 6.7% of the allowance and leaves
    /// the rest for every other panel. Pulling from GMAIL is a different
    /// matter and deliberately NOT on this timer: the server sweeps every
    /// ten minutes on its own, which is the cadence Google's quota is
    /// sized for, and REFRESH forces one by hand when somebody is waiting
    /// on a specific reply.
    private static let pollSeconds: UInt64 = 60
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
        .task {
            // Re-read on a clock. A desk where somebody is waiting on an
            // answer should not need to be told to press anything, and a
            // stale inbox is worse than a slow one: it reports silence
            // that is not there.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.pollSeconds * 1_000_000_000)
                if Task.isCancelled { break }
                await load()
            }
        }
    }

    private var inbox: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if case .loaded(let p) = state {
                    let msgs = p.messages ?? []
                    let owed = msgs.filter { $0.followUp?.state == "owed" }.count
                    let bounced = msgs.filter { ($0.kind ?? "") == "Bounce" }.count
                    Text("\(msgs.count)").font(Term.mono(11)).foregroundStyle(Term.fg)
                    ForEach(Filter.allCases, id: \.self) { f in
                        let n = count(for: f, in: msgs)
                        Button(action: { filter = f }) {
                            HStack(spacing: 3) {
                                Text(f.label).font(Term.mono(9, weight: filter == f ? .bold : .regular))
                                Text("\(n)").font(Term.mono(9))
                            }
                            .foregroundStyle(filter == f ? Term.amber
                                : (f == .owed && owed > 0) ? Term.orange
                                : (f == .bounced && bounced > 0) ? Term.negative : Term.fgMuted)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(filter == f ? Term.bgPanelHover : Color.clear)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                Spacer()
                if let d = lastLoad {
                    Text(ago(d)).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        .help("The list re-reads itself every minute. REFRESH also pulls from Gmail.")
                }
                Button(composing ? "CLOSE" : "NEW") {
                    composing.toggle()
                    if composing { Task { await findContacts() } }
                }
                .buttonStyle(TermButtonStyle())
                .help("Write a new letter to somebody in the book")
                Button(syncing ? "PULLING" : "REFRESH") { Task { await syncThenLoad() } }
                    .buttonStyle(TermButtonStyle()).disabled(syncing)
                if let n = syncNote {
                    Text(n).font(Term.mono(9)).foregroundStyle(Term.negative).lineLimit(1)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)

            if composing { composer }

            PanelState(state: state,
                       emptyWhen: { ($0.messages ?? []).isEmpty },
                       emptyText: "Nothing has come in yet.",
                       retry: { Task { await load() } }) { p in
                let rows = (p.messages ?? []).filter { matches(filter, $0) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { m in row(m) }
                    }
                }
            }
        }
        .task { await load() }
    }

    /// The compose box.
    ///
    /// The recipient is CHOSEN, never typed. An address typed into a
    /// compose box is exactly the guessed address the whole desk exists to
    /// prevent, and a wrong one sends our research to a stranger. Somebody
    /// not in the book has to be added as a contact first, with a
    /// verification recorded against them, which is the step that matters.
    @ViewBuilder private var composer: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text("TO").font(Term.mono(9, weight: .bold)).foregroundStyle(Term.fgMuted)
                    .frame(width: 40, alignment: .leading)
                if let t = toTarget {
                    Text(t.name ?? "?").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.fg)
                    Text(t.email ?? "").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    Button("CHANGE") { toTarget = nil; pick = "" }.buttonStyle(TermButtonStyle())
                } else {
                    TextField("search a contact by name, employer or address", text: $pick)
                        .textFieldStyle(.plain).font(Term.mono(11)).foregroundStyle(Term.white)
                        .onChange(of: pick) { _, _ in Task { await findContacts() } }
                }
                Spacer()
            }
            if toTarget == nil && !contacts.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(contacts) { c in
                            HStack(spacing: 6) {
                                Text(c.name ?? "?").font(Term.mono(10)).foregroundStyle(Term.fg)
                                Text(c.employer ?? "").font(Term.mono(9)).foregroundStyle(Term.fgDim).lineLimit(1)
                                Spacer()
                                Text(c.email ?? "").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                                if let st = c.status {
                                    Text(st.uppercased()).font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                                }
                            }
                            .padding(.vertical, 2)
                            .contentShape(Rectangle())
                            .onTapGesture { toTarget = c; contacts = [] }
                        }
                    }
                }
                .frame(maxHeight: 120)
            }
            if toTarget != nil {
                HStack(spacing: 6) {
                    Text("SUBJ").font(Term.mono(9, weight: .bold)).foregroundStyle(Term.fgMuted)
                        .frame(width: 40, alignment: .leading)
                    TextField("subject", text: $newSubject)
                        .textFieldStyle(.plain).font(Term.mono(11)).foregroundStyle(Term.white)
                }
                TextEditor(text: $newBody)
                    .font(Term.mono(11)).foregroundStyle(Term.fg)
                    .scrollContentBackground(.hidden).background(Term.bg)
                    .frame(minHeight: 110)
                    .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
                HStack(spacing: 8) {
                    Button(sending ? "SENDING" : "SEND") { Task { await sendNew() } }
                        .buttonStyle(TermButtonStyle())
                        .disabled(sending || newSubject.trimmingCharacters(in: .whitespaces).isEmpty
                                  || newBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("Screened before it goes. From your mailbox, and there is no undo.")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    Spacer()
                }
            }
            if let n = composeNote {
                Text(n).font(Term.mono(10)).foregroundStyle(Term.negative)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Term.bgPanel)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private func findContacts() async {
        let q = pick.trimmingCharacters(in: .whitespaces)
        do {
            let d = try await API.shared.get("/research/contacts?q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")")
            struct Wrap: Decodable { let contacts: [Contact] }
            contacts = try await API.shared.decode(Wrap.self, from: d).contacts
        } catch { contacts = [] }
    }

    private func sendNew() async {
        guard let t = toTarget else { return }
        sending = true; composeNote = nil
        defer { sending = false }
        do {
            _ = try await API.shared.post("/research/compose", json: [
                "targetId": t.id, "subject": newSubject, "body": newBody,
            ])
            composing = false; toTarget = nil; pick = ""
            newSubject = ""; newBody = ""
            await load()
        } catch {
            composeNote = error.localizedDescription
        }
    }

    private func matches(_ f: Filter, _ m: InboxPayload.Msg) -> Bool {
        switch f {
        case .all:     return true
        case .owed:    return m.followUp?.state == "owed"
        case .bounced: return (m.kind ?? "") == "Bounce"
        // A human answer. An out of office is NOT being heard from, which
        // is the whole reason kind exists, so it does not belong here.
        case .replies: return (m.direction ?? "in") == "in"
            && !["Bounce", "AutoReply"].contains(m.kind ?? "")
        }
    }

    private func count(for f: Filter, in msgs: [InboxPayload.Msg]) -> Int {
        msgs.filter { matches(f, $0) }.count
    }

    /// How long ago, in the shortest form that is still true.
    private func ago(_ d: Date) -> String {
        let s = Int(Date().timeIntervalSince(d))
        if s < 90 { return "just now" }
        if s < 3600 { return "\(s / 60)m ago" }
        return "\(s / 3600)h ago"
    }

    /// REFRESH means two different things and does both, in order.
    ///
    /// The cheap one is re-reading our own database, which is what the
    /// minute timer does. The expensive one is asking GMAIL for new mail
    /// on every thread we started, which is what somebody actually wants
    /// when they press a button because they are waiting on a reply. The
    /// server already sweeps every ten minutes; this is the impatient path.
    private func syncThenLoad() async {
        syncing = true; syncNote = nil
        defer { syncing = false }
        do {
            let d = try await API.shared.post("/gmail/sync", json: [:])
            struct Sync: Decodable { let added: Int?; let errorCount: Int?; let errors: [String]? }
            let r = try await API.shared.decode(Sync.self, from: d)
            if (r.errorCount ?? 0) > 0 { syncNote = r.errors?.first ?? "\(r.errorCount ?? 0) threads failed" }
        } catch {
            // A failed pull must not look like an empty mailbox. The list
            // below is still whatever we last read, and it is still true.
            syncNote = error.localizedDescription
        }
        await load()
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
        let bounced = (m.kind ?? "") == "Bounce"
        let open = expanded.contains(m.id)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(open ? "v" : ">")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted).frame(width: 8)
                Text(m.target?.name ?? "Unknown")
                    .font(Term.mono(12, weight: .bold))
                    .foregroundStyle(bounced ? Term.negative : Term.fg)
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
                        .foregroundStyle(bounced ? Term.negative : Term.orange)
                }
                if owed {
                    Text("OWED").font(Term.mono(9, weight: .bold)).foregroundStyle(Term.negative)
                }
                Spacer()
                Text(Fmt.shortDateTime(m.occurredAt))
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }

            // The subject, which an inbox without one is not. Two replies
            // from the same person on the same day were previously
            // distinguishable only by opening them.
            if let sub = m.subject, !sub.isEmpty {
                Text(sub)
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(Term.fgDim)
                    .lineLimit(1)
                    .padding(.leading, 14)
            }

            if let b = m.body, !b.isEmpty {
                Text(b)
                    .font(Term.mono(11)).foregroundStyle(Term.fgMuted)
                    .lineLimit(open ? nil : 2)
                    .textSelection(.enabled)
                    .padding(.leading, 14)
            }

            // Everything below this point is OURS, not theirs.
            //
            // The recommendation used to render as plain text directly
            // under the body in a similar colour, so "They wrote back and
            // we have not answered" read as a sentence the source had
            // written. A line about what WE owe cannot look like a line
            // they sent.
            // A closed loop is worth saying once, quietly. It is the
            // difference between "we have dropped this" and "they told us
            // when to come back", and only one of those needs anybody.
            if !owed && !bounced, let st = m.followUp?.state,
               st == "closed-loop" || st == "drafted" {
                Text(m.followUp?.recommendation ?? "")
                    .font(Term.mono(9))
                    .foregroundStyle(st == "drafted" ? Term.cyan : Term.fgMuted)
                    .lineLimit(1)
                    .padding(.leading, 14)
            }

            if owed || bounced {
                HStack(spacing: 6) {
                    Text(bounced ? "FIX" : "TODO")
                        .font(Term.mono(8, weight: .bold)).tracking(0.5)
                        .foregroundStyle(Term.bg)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(bounced ? Term.negative : Term.orange)
                    Text(bounced
                         ? "\(m.target?.email ?? "that address") does not exist. Find another route before sending again."
                         : (m.followUp?.recommendation ?? "They wrote back and we have not answered."))
                        .font(Term.mono(10))
                        .foregroundStyle(bounced ? Term.negative : Term.orange)
                        .lineLimit(open ? nil : 1)
                    Spacer()
                }
                .padding(.leading, 14).padding(.top, 2)
            }

            if open, let addr = m.target?.email {
                Text(addr).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .textSelection(.enabled).padding(.leading, 14)
            }

            // Answer it here. A bounce is the one thing that cannot be
            // answered: the address is dead and a reply is another bounce.
            if open && !bounced && (m.direction ?? "in") == "in" {
                if replyingTo == m.id {
                    VStack(alignment: .leading, spacing: 4) {
                        TextEditor(text: $replyText)
                            .font(Term.mono(11))
                            .foregroundStyle(Term.fg)
                            .scrollContentBackground(.hidden)
                            .background(Term.bg)
                            .frame(minHeight: 90)
                            .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
                        HStack(spacing: 8) {
                            Button(sending ? "SENDING" : "SEND REPLY") { Task { await sendReply(m) } }
                                .buttonStyle(TermButtonStyle())
                                .disabled(sending || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Button("CANCEL") { replyingTo = nil; replyText = "" }
                                .buttonStyle(TermButtonStyle()).disabled(sending)
                            Text("Goes from your mailbox, inside this thread. It is screened first, and there is no undo.")
                                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            Spacer()
                        }
                    }
                    .padding(.leading, 14).padding(.top, 4)
                } else if sentJustNow.contains(m.id) {
                    Text("Replied.").font(Term.mono(10)).foregroundStyle(Term.positive)
                        .padding(.leading, 14)
                } else {
                    Button("REPLY") { replyingTo = m.id; replyText = "" }
                        .buttonStyle(TermButtonStyle())
                        .padding(.leading, 14).padding(.top, 2)
                }
                if let n = rowNote[m.id] {
                    Text(n).font(Term.mono(10)).foregroundStyle(Term.negative)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 14)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture {
            if open { expanded.remove(m.id) } else { expanded.insert(m.id) }
        }
        .overlay(alignment: .leading) {
            if bounced { Rectangle().fill(Term.negative).frame(width: 2) }
            else if owed { Rectangle().fill(Term.orange).frame(width: 2) }
        }
        .background(Term.bgPanel)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private func sendReply(_ m: InboxPayload.Msg) async {
        sending = true; rowNote[m.id] = nil
        defer { sending = false }
        do {
            _ = try await API.shared.post("/research/messages/\(m.id)/reply",
                                          json: ["body": replyText])
            replyingTo = nil; replyText = ""
            sentJustNow.insert(m.id)
            // Re-read rather than patch the row by hand: the answer
            // changes who is owed a reply, and that is the server's
            // arithmetic, not ours.
            await load()
        } catch {
            // The screen refusing it, or Gmail refusing it, are both
            // things the writer has to see in full. This is the one
            // place in the panel where a truncated error would cost
            // somebody a rewrite they did not need.
            rowNote[m.id] = error.localizedDescription
        }
    }

    private func load() async {
        do {
            let d = try await API.shared.get("/research/inbox")
            state = .loaded(try await API.shared.decode(InboxPayload.self, from: d))
            lastLoad = Date()
        } catch {
            // A poll that fails must not wipe a list we already have.
            // The timer runs every minute; one refused request, or a
            // dyno waking up, is not news and is certainly not an empty
            // mailbox. Only the first load can fail into an error state.
            if case .loaded = state { return }
            state = .failed(error.localizedDescription)
        }
    }
}
