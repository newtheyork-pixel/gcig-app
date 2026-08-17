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

// MARK: Send

// One door onto sending, with everything it can do behind it.
//
// The old shape was a bare button that fired a batch. This asks three
// questions in the order somebody actually has them: WHO is going, WHEN,
// and only then does it commit. Nothing here sends without the list having
// been on screen first.
//
// SCHEDULING RUNS ON THE SERVER, not on this Mac and not inside Gmail.
// Gmail's API has no scheduled send at all: "Schedule send" is a feature of
// the Gmail web interface and users.messages.send accepts no send-at time.
// So the queue lives on Render and fires whether or not this machine is
// awake, which is the property that was actually wanted.

struct SendPreview: Decodable {
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

struct SendResult: Decodable {
    let sent: Int?
    let failedCount: Int?
    let scheduled: Int?
    let at: String?
    let failed: [Fail]?
    struct Fail: Decodable, Identifiable {
        let draftId: Int?; let name: String?; let error: String?
        var id: Int { draftId ?? 0 }
    }
}

struct SendAllControl: View {
    let projectID: Int

    @State private var open = false
    @State private var preview: SendPreview?
    @State private var result: SendResult?
    @State private var busy = false
    @State private var note: String?
    /// Which drafts are actually going. Everything starts selected, because
    /// the preview already refused anything unsendable, and a member who
    /// opened this meant to send.
    @State private var chosen: Set<Int> = []
    @State private var when = Date().addingTimeInterval(12 * 3600)
    @State private var scheduling = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                SectionLabel(text: "Outreach")
                Button(open ? "CLOSE" : "SEND") {
                    open.toggle()
                    if open && preview == nil { Task { await load() } }
                }
                .buttonStyle(TermButtonStyle())
                if let r = result {
                    if let n = r.scheduled, n > 0 {
                        Text("\(n) scheduled for \(Fmt.shortDateTime(r.at))")
                            .font(Term.mono(10)).foregroundStyle(Term.positive)
                    } else {
                        Text("\(r.sent ?? 0) sent, \(r.failedCount ?? 0) failed")
                            .font(Term.mono(10))
                            .foregroundStyle((r.failedCount ?? 0) > 0 ? Term.orange : Term.positive)
                    }
                }
                if let note { Text(note).font(Term.mono(10)).foregroundStyle(Term.negative).lineLimit(1) }
                Spacer()
            }

            if open { panel }
        }
    }

    @ViewBuilder private var panel: some View {
        if busy && preview == nil {
            Text("reading the queue").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
        } else if let p = preview {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text("\(chosen.count) of \(p.recipients?.count ?? 0) selected")
                        .font(Term.mono(10)).foregroundStyle(Term.fg)
                    Button("ALL") { chosen = Set((p.recipients ?? []).map(\.id)) }
                        .buttonStyle(TermButtonStyle())
                    Button("NONE") { chosen = [] }.buttonStyle(TermButtonStyle())
                    // The screen flags a draft without blocking it, and
                    // elevated is the set worth a second look before a batch.
                    Button("ONLY CLEAN") {
                        chosen = Set((p.recipients ?? []).filter { $0.screenRisk == "low" }.map(\.id))
                    }.buttonStyle(TermButtonStyle())
                    Spacer()
                }

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(p.recipients ?? []) { r in
                            HStack(spacing: 6) {
                                Text(chosen.contains(r.id) ? "[x]" : "[ ]")
                                    .font(Term.mono(10))
                                    .foregroundStyle(chosen.contains(r.id) ? Term.amber : Term.fgMuted)
                                Text(r.name ?? "?").font(Term.mono(10)).foregroundStyle(Term.fg)
                                Text(r.email ?? "").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                                if r.screenRisk == "elevated" {
                                    Text("ELEVATED").font(Term.mono(9)).foregroundStyle(Term.orange)
                                }
                                Spacer()
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if chosen.contains(r.id) { chosen.remove(r.id) } else { chosen.insert(r.id) }
                            }
                            .padding(.vertical, 1)
                        }
                    }
                }
                .frame(maxHeight: 180)

                // Skips are shown, never counted. A draft quietly missing
                // from a batch is how somebody concludes a contact was
                // written to when they were not.
                ForEach((p.skipped ?? []).prefix(5)) { sk in
                    Text("skipped \(sk.name ?? "?"): \(sk.why ?? "")")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                }

                HStack(spacing: 8) {
                    Button(busy ? "SENDING" : "SEND NOW (\(chosen.count))") { Task { await send() } }
                        .buttonStyle(TermButtonStyle()).disabled(busy || chosen.isEmpty)
                    Button(scheduling ? "PICK A TIME" : "SCHEDULE") { scheduling.toggle() }
                        .buttonStyle(TermButtonStyle()).disabled(busy || chosen.isEmpty)
                    Spacer()
                }

                if scheduling {
                    HStack(spacing: 8) {
                        DatePicker("", selection: $when, in: Date()...,
                                   displayedComponents: [.date, .hourAndMinute])
                            .labelsHidden().font(Term.mono(10))
                        Button(busy ? "QUEUEING" : "QUEUE \(chosen.count)") { Task { await schedule() } }
                            .buttonStyle(TermButtonStyle()).disabled(busy || chosen.isEmpty)
                        Spacer()
                    }
                    // Said out loud, because the obvious assumption is wrong
                    // and would be discovered at 8am on a Monday.
                    Text("Queued on the server, not in Gmail and not on this Mac. It sends whether or not this computer is awake.")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                ForEach(result?.failed ?? []) { f in
                    Text("\(f.name ?? "?"): \(f.error ?? "")")
                        .font(Term.mono(10)).foregroundStyle(Term.negative)
                }
            }
        }
    }

    private func load() async {
        busy = true; note = nil; result = nil
        defer { busy = false }
        do {
            let d = try await API.shared.post("/research/projects/\(projectID)/send-all", json: [:])
            let p = try await API.shared.decode(SendPreview.self, from: d)
            preview = p
            chosen = Set((p.recipients ?? []).map(\.id))
        } catch { note = error.localizedDescription }
    }

    private func send() async {
        busy = true; note = nil
        defer { busy = false }
        do {
            let d = try await API.shared.post("/research/projects/\(projectID)/send-all",
                                              json: ["confirm": true, "draftIds": Array(chosen)])
            result = try await API.shared.decode(SendResult.self, from: d)
            preview = nil; open = false
        } catch { note = error.localizedDescription }
    }

    private func schedule() async {
        busy = true; note = nil
        defer { busy = false }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        do {
            let d = try await API.shared.post("/research/projects/\(projectID)/schedule",
                                              json: ["confirm": true, "at": iso.string(from: when),
                                                     "draftIds": Array(chosen)])
            result = try await API.shared.decode(SendResult.self, from: d)
            preview = nil; open = false; scheduling = false
        } catch { note = error.localizedDescription }
    }
}
