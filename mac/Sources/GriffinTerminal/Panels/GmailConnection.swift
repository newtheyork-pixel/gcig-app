import SwiftUI
import AppKit

// The Gmail connection, and the one button that establishes it.
//
// This row exists because the alternative is a curl. It shows three states
// and they are deliberately different sentences rather than one sentence
// with a colour: not configured on the server, configured but not for you,
// and connected as a named address. A member who is not a permitted sender
// is told so plainly instead of being shown a button that will 403, which
// is a permission you can see and cannot use and reads as a bug.
//
// Connecting OPENS A BROWSER and cannot do otherwise. The server hands back
// a link to its own /api/gmail/start, which sets the nonce cookie
// first-party to the API before redirecting to Google. Fetching that URL in
// process would leave the cookie nowhere and the callback would fail the
// binding every time, which is exactly the bug this flow was rebuilt to
// avoid.

struct GmailStatus: Decodable {
    let configured: Bool?
    /// Whether THIS member may send at all. Distinct from `connected`: the
    /// server answers false here for everyone outside GMAIL_SENDERS.
    let allowed: Bool?
    let connected: Bool?
    let address: String?
    let lastSyncAt: String?
    let revokedAt: String?
}

struct GmailConnectionRow: View {
    @State private var status: Loadable<GmailStatus> = .loading
    @State private var busy = false
    @State private var note: String?
    /// Last sweep result, kept so the row can say what happened rather than
    /// flashing a spinner and going quiet.
    @State private var swept: String?

    var body: some View {
        HStack(spacing: 8) {
            SectionLabel(text: "Gmail")

            switch status {
            case .loading:
                Text("checking").font(Term.mono(10)).foregroundStyle(Term.fgMuted)

            case .failed(let msg):
                Text(msg).font(Term.mono(10)).foregroundStyle(Term.negative).lineLimit(1)
                Button("RETRY") { Task { await load() } }.buttonStyle(TermButtonStyle())

            case .loaded(let s):
                if s.configured != true {
                    Text("not configured on the server")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                } else if s.allowed != true {
                    // Named, not hidden. Somebody wondering why they cannot
                    // send should find the answer here rather than in a 403.
                    Text("sending is limited to named senders")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                } else if s.connected == true, let addr = s.address {
                    Text(addr).font(Term.mono(10)).foregroundStyle(Term.positive)
                    if let last = s.lastSyncAt {
                        Text("swept \(Fmt.shortDateTime(last))")
                            .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    }
                    Button(busy ? "SWEEPING" : "SWEEP REPLIES") { Task { await sync() } }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                    Button("DISCONNECT") { Task { await disconnect() } }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                } else {
                    // revokedAt is its own sentence. A connection that has
                    // gone bad and still reads as absent sends somebody
                    // looking for a setup step they already did.
                    Text(s.revokedAt != nil ? "connection refused by Google, reconnect" : "not connected")
                        .font(Term.mono(10))
                        .foregroundStyle(s.revokedAt != nil ? Term.negative : Term.fgMuted)
                    Button(busy ? "OPENING" : "CONNECT") { Task { await connect() } }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                }
            }

            if let swept { Text(swept).font(Term.mono(10)).foregroundStyle(Term.fgDim).lineLimit(1) }
            if let note { Text(note).font(Term.mono(10)).foregroundStyle(Term.negative).lineLimit(1) }
            Spacer()
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let d = try await API.shared.get("/gmail/status")
            status = .loaded(try await API.shared.decode(GmailStatus.self, from: d))
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    /// Opens the browser. The URL is the API's own /start, never Google's
    /// directly: the cookie that binds this consent to this browser is set
    /// on that hop, and a request made in process would strand it.
    private func connect() async {
        busy = true; note = nil
        defer { busy = false }
        do {
            let d = try await API.shared.get("/gmail/connect")
            struct Link: Decodable { let url: String }
            let link = try await API.shared.decode(Link.self, from: d)
            guard let u = URL(string: link.url) else { note = "bad link from the server"; return }
            NSWorkspace.shared.open(u)
            note = "finish in the browser, then RETRY here"
        } catch {
            note = error.localizedDescription
        }
    }

    private func sync() async {
        busy = true; note = nil; swept = nil
        defer { busy = false }
        do {
            let d = try await API.shared.post("/gmail/sync", json: [:])
            struct R: Decodable { let threads: Int?; let added: Int?; let errorCount: Int? }
            let r = try await API.shared.decode(R.self, from: d)
            // The error count is shown rather than swallowed. A sweep that
            // skipped half the threads and reported "0 new" is
            // indistinguishable from a quiet week, and a quiet week is what
            // ends a contact.
            let errs = (r.errorCount ?? 0) > 0 ? ", \(r.errorCount!) failed" : ""
            swept = "\(r.added ?? 0) new from \(r.threads ?? 0) threads\(errs)"
            await load()
        } catch {
            note = error.localizedDescription
        }
    }

    private func disconnect() async {
        busy = true; note = nil
        defer { busy = false }
        do {
            _ = try await API.shared.delete("/gmail/connection")
            await load()
        } catch {
            note = error.localizedDescription
        }
    }
}

// MARK: Send All

// The batch, with its preview in front of it.
//
// The server refuses to send unless it is told to twice, and this mirrors
// that rather than hiding it: the first press asks what WOULD go and shows
// the list, the second sends exactly that list. A single button that fires
// fifty irreversible emails is not a button, it is an accident waiting for
// somebody in a hurry.

struct SendAllPreview: Decodable {
    let wouldSend: Int?
    let recipients: [Row]?
    let skipped: [Skip]?
    struct Row: Decodable, Identifiable {
        let draftId: Int?; let name: String?; let email: String?
        let subject: String?; let screenRisk: String?
        var id: Int { draftId ?? 0 }
    }
    struct Skip: Decodable, Identifiable {
        let draftId: Int?; let name: String?; let why: String?
        var id: Int { draftId ?? 0 }
    }
}

struct SendAllResult: Decodable {
    let sent: Int?
    let failedCount: Int?
    let failed: [Fail]?
    struct Fail: Decodable, Identifiable {
        let draftId: Int?; let name: String?; let error: String?
        var id: Int { draftId ?? 0 }
    }
}

struct SendAllControl: View {
    let projectID: Int

    @State private var preview: SendAllPreview?
    @State private var result: SendAllResult?
    @State private var busy = false
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                SectionLabel(text: "Send all")
                Button(busy ? "WORKING" : "WHAT WOULD SEND") { Task { await dryRun() } }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
                if let p = preview, (p.wouldSend ?? 0) > 0 {
                    // The count is on the button itself. "Send" and "send
                    // forty-three emails" are different decisions and the
                    // control should say which one is being made.
                    Button(busy ? "SENDING" : "SEND \(p.wouldSend ?? 0) NOW") { Task { await send() } }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                }
                if let note { Text(note).font(Term.mono(10)).foregroundStyle(Term.negative).lineLimit(1) }
                Spacer()
            }

            if let p = preview, result == nil {
                Text("\(p.wouldSend ?? 0) would go, \((p.skipped ?? []).count) skipped. Nothing has been sent.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                ForEach((p.recipients ?? []).prefix(12)) { r in
                    HStack(spacing: 6) {
                        Text(r.name ?? "?").font(Term.mono(10)).foregroundStyle(Term.fg)
                        Text(r.email ?? "").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                        if r.screenRisk == "elevated" {
                            Text("ELEVATED").font(Term.mono(9)).foregroundStyle(Term.orange)
                        }
                        Spacer()
                    }
                }
                if (p.recipients ?? []).count > 12 {
                    Text("and \((p.recipients ?? []).count - 12) more")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                }
                // Skips are shown, not counted. A draft quietly missing from
                // a batch is how somebody concludes a contact was written to
                // when they were not.
                ForEach((p.skipped ?? []).prefix(6)) { s in
                    Text("skipped \(s.name ?? "?"): \(s.why ?? "")")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                }
            }

            if let r = result {
                Text("\(r.sent ?? 0) sent, \(r.failedCount ?? 0) failed")
                    .font(Term.mono(10))
                    .foregroundStyle((r.failedCount ?? 0) > 0 ? Term.orange : Term.positive)
                ForEach(r.failed ?? []) { f in
                    Text("\(f.name ?? "?"): \(f.error ?? "")")
                        .font(Term.mono(10)).foregroundStyle(Term.negative)
                }
            }
        }
    }

    private func dryRun() async {
        busy = true; note = nil; result = nil
        defer { busy = false }
        do {
            let d = try await API.shared.post("/research/projects/\(projectID)/send-all", json: [:])
            preview = try await API.shared.decode(SendAllPreview.self, from: d)
        } catch { note = error.localizedDescription }
    }

    private func send() async {
        busy = true; note = nil
        defer { busy = false }
        do {
            let d = try await API.shared.post("/research/projects/\(projectID)/send-all",
                                              json: ["confirm": true])
            result = try await API.shared.decode(SendAllResult.self, from: d)
            preview = nil
        } catch { note = error.localizedDescription }
    }
}

// MARK: Inbox

// What came in, across every project, newest first.
//
// The per-target thread answers what we said to one person. This answers
// the question somebody opens the app with, which is what arrived. Until
// this existed a reply was reachable only by opening the target it belonged
// to, so you had to know who had written in order to find out who had.

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
            let id: Int?; let name: String?; let employer: String?
            let project: P?
            struct P: Decodable { let ticker: String?; let name: String? }
        }
        struct F: Decodable { let state: String?; let recommendation: String? }
    }
}

struct InboxSection: View {
    @State private var state: Loadable<InboxPayload> = .loading

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                SectionLabel(text: "Inbox")
                if case .loaded(let p) = state {
                    Text("\(p.counts?.total ?? 0) in, \(p.counts?.owed ?? 0) owed a reply")
                        .font(Term.mono(10))
                        .foregroundStyle((p.counts?.owed ?? 0) > 0 ? Term.orange : Term.fgMuted)
                }
                Button("REFRESH") { Task { await load() } }.buttonStyle(TermButtonStyle())
                Spacer()
            }

            PanelState(state: state,
                       emptyWhen: { ($0.messages ?? []).isEmpty },
                       emptyText: "Nothing has come in yet.",
                       retry: { Task { await load() } }) { p in
                VStack(alignment: .leading, spacing: 4) {
                    ForEach((p.messages ?? []).prefix(30)) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(m.target?.name ?? "Unknown")
                                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.fg)
                                if let t = m.target?.project?.ticker {
                                    Text(t).font(Term.mono(9)).foregroundStyle(Term.blue)
                                }
                                // The kind matters more than it looks: an
                                // auto-reply is not being heard from, and a
                                // bounce needs a new address rather than
                                // another send.
                                if let k = m.kind, k != "Reply" {
                                    Text(k.uppercased()).font(Term.mono(9))
                                        .foregroundStyle(k == "Bounce" ? Term.negative : Term.orange)
                                }
                                if m.followUp?.state == "owed" {
                                    Text("OWED").font(Term.mono(9)).foregroundStyle(Term.negative)
                                }
                                Spacer()
                                Text(Fmt.shortDateTime(m.occurredAt))
                                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                            }
                            if let b = m.body, !b.isEmpty {
                                Text(b).font(Term.mono(10)).foregroundStyle(Term.fgDim)
                                    .lineLimit(3).textSelection(.enabled)
                            }
                        }
                        .padding(.vertical, 3)
                    }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let d = try await API.shared.get("/research/inbox")
            state = .loaded(try await API.shared.decode(InboxPayload.self, from: d))
        } catch { state = .failed(error.localizedDescription) }
    }
}
