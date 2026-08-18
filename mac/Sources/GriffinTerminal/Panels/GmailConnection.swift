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
        /// When this person was last written to, or nil for a first
        /// contact. A chase is a legitimate second letter; twelve
        /// duplicates were not, and nothing in this list could tell them
        /// apart until the server started saying.
        let priorContactAt: String?
        var id: Int { draftId ?? 0 }
        var isSecondLetter: Bool { (priorContactAt ?? "").isEmpty == false }
    }
    struct Skip: Decodable, Identifiable {
        let draftId: Int?; let name: String?; let why: String?
        var id: Int { draftId ?? 0 }
    }
}

struct ScheduledQueue: Decodable {
    let queued: Int?
    let failed: Int?
    let rows: [Row]?
    struct Row: Decodable, Identifiable {
        let id: Int
        let subject: String?
        let scheduledFor: String?
        /// Set when the scheduler gave up. The time is cleared with it, so a
        /// row with a reason and no time is one that will never send unless
        /// somebody does something.
        let scheduleError: String?
        let target: T?
        struct T: Decodable { let name: String?; let email: String? }
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
    @State private var queue: ScheduledQueue?
    @State private var picked: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The queue is shown whether or not the send panel is open. A
            // schedule you cannot see is a schedule you cannot trust, and
            // the only other way to learn what was promised is to wait and
            // read the sent folder on Monday.
            if let q = queue, (q.queued ?? 0) > 0 || (q.failed ?? 0) > 0 {
                HStack(spacing: 8) {
                    SectionLabel(text: "Queued")
                    // QUEUED, never "scheduled". A target's Scheduled status
                    // means somebody agreed to talk to us; a letter waiting
                    // to leave is the opposite kind of fact and borrowing the
                    // word would merge the two on every counter that reads it.
                    Text("\(q.queued ?? 0) queued")
                        .font(Term.mono(10)).foregroundStyle(Term.amber)
                    if (q.failed ?? 0) > 0 {
                        Text("\(q.failed ?? 0) gave up")
                            .font(Term.mono(10)).foregroundStyle(Term.negative)
                    }
                    Button("UNSCHEDULE ALL") { Task { await unschedule(nil) } }
                        .buttonStyle(TermButtonStyle()).disabled(busy)
                    Spacer()
                }
                if (q.rows ?? []).count > 10 {
                    Text("showing 10 of \((q.rows ?? []).count)")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                ForEach((q.rows ?? []).prefix(10)) { r in
                    HStack(spacing: 6) {
                        Text(r.target?.name ?? "?").font(Term.mono(10)).foregroundStyle(Term.fg)
                        if let e = r.scheduleError {
                            Text(e).font(Term.mono(10)).foregroundStyle(Term.negative).lineLimit(1)
                        } else {
                            Text(Fmt.shortDateTime(r.scheduledFor))
                                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                            Button("CANCEL") { Task { await unschedule([r.id]) } }
                                .buttonStyle(TermButtonStyle()).disabled(busy)
                        }
                        Spacer()
                    }
                }
            }

            HStack(spacing: 8) {
                SectionLabel(text: "Outreach")
                Button(open ? "CLOSE" : "SEND") {
                    open.toggle()
                    // EVERY open re-reads. The old guard only loaded when
                    // preview was nil, so a list read once survived every
                    // send, schedule, rejection and refresh for as long as
                    // the tab stayed on screen, and the number beside the
                    // button was whatever had been true when it was first
                    // opened. Everything else on this tab reloads; this was
                    // the one stale thing, and it looked live.
                    if open { Task { await load() } }
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
        .task { await loadQueue() }
    }

    private func loadQueue() async {
        queue = try? await API.shared.decode(
            ScheduledQueue.self,
            from: try await API.shared.get("/research/projects/\(projectID)/scheduled"))
        // "13 scheduled for Mon 08:00" outlived the queue it described:
        // unscheduling emptied the list and left the sentence standing,
        // and nothing on screen retracted it. An outcome is only true
        // while the server still agrees.
        if let n = result?.scheduled, n > 0, (queue?.queued ?? 0) == 0 { result = nil }
    }

    private func unschedule(_ ids: [Int]?) async {
        busy = true; note = nil; result = nil
        defer { busy = false }
        do {
            _ = try await API.shared.post("/research/projects/\(projectID)/unschedule",
                                          json: ids == nil ? [:] : ["draftIds": ids!])
            await loadQueue()
            // The send list changes the moment something leaves the queue,
            // so it is re-read rather than left showing a stale count.
            if open { await load() }
        } catch { note = error.localizedDescription }
    }

    @ViewBuilder private var panel: some View {
        if busy {
            Text("reading the queue").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
        } else if let p = preview, (p.recipients ?? []).isEmpty {
            // Nothing to send is a RESULT, and a good one. The panel used
            // to open on blank space here, which reads as a failure of the
            // app rather than an empty queue, and sent somebody looking for
            // a bug that was not there.
            VStack(alignment: .leading, spacing: 3) {
                Text("Nothing is waiting to send.")
                    .font(Term.mono(11)).foregroundStyle(Term.fg)
                Text("Letters already sent, pulled, scheduled, or parked in a mailbox do not appear here.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                ForEach((p.skipped ?? []).prefix(6)) { sk in
                    Text("held back \(sk.name ?? "?"): \(sk.why ?? "")")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                if (p.skipped ?? []).count > 6 {
                    Text("and \((p.skipped ?? []).count - 6) more held back")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
            }
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
                                if r.isSecondLetter {
                                    Text("2ND LETTER").font(Term.mono(9)).foregroundStyle(Term.orange)
                                        .help("Already written to on \(Fmt.date(r.priorContactAt)). Tick it only if this is a deliberate follow-up.")
                                }
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
                    Text("held back \(sk.name ?? "?"): \(sk.why ?? "")")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                }
                if (p.skipped ?? []).count > 5 {
                    Text("and \((p.skipped ?? []).count - 5) more held back")
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
            // First contacts start ticked. A second letter to somebody
            // already written to has to be chosen on purpose.
            chosen = Set((p.recipients ?? []).filter { !$0.isSecondLetter }.map(\.id))
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
            await loadQueue()
        } catch { note = error.localizedDescription }
    }
}

// MARK: The connect panel

/// What INBX shows when there is no mailbox behind it.
///
/// This started as a one-line strip at the top of another function, which
/// was wrong twice over. It sat in a panel a person had no reason to open
/// to read their mail, and it was sized like a status note when it is the
/// only thing standing between somebody and a working inbox. An empty
/// inbox with a quiet grey row above it reads as "no mail yet", and the
/// person waits for mail that can never arrive.
///
/// So it takes the whole panel and says the one thing to do.
struct GmailConnectPanel: View {
    let status: GmailStatus?
    let busy: Bool
    let note: String?
    let onConnect: () -> Void
    let onRecheck: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)

            Text(headline)
                .font(Term.mono(17, weight: .bold))
                .foregroundStyle(Term.fg)

            Text(explain)
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
                .fixedSize(horizontal: false, vertical: true)

            if canConnect {
                Button(action: onConnect) {
                    Text(busy ? "OPENING BROWSER" : "CONNECT MAILBOX")
                        .font(Term.mono(14, weight: .bold))
                        .tracking(1.2)
                        .foregroundStyle(Term.bg)
                        .padding(.horizontal, 30)
                        .padding(.vertical, 12)
                        .background(busy ? Term.fgMuted : Term.amber)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)

                // Only after the browser has been opened, because until
                // then there is nothing to recheck and a second button
                // just splits the one instruction in two.
                if note != nil {
                    Button("I APPROVED IT, RECHECK") { onRecheck() }
                        .buttonStyle(TermButtonStyle())
                }
            }

            if let note {
                Text(note)
                    .font(Term.mono(11))
                    .foregroundStyle(noteIsError ? Term.negative : Term.orange)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 460)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    private var canConnect: Bool {
        status?.configured == true && status?.allowed == true
    }

    private var noteIsError: Bool {
        guard let note else { return false }
        return !note.lowercased().contains("approve it in the browser")
    }

    private var headline: String {
        guard let s = status else { return "Checking your mailbox" }
        if s.configured != true { return "Mail is not set up on the server" }
        if s.allowed != true { return "You are not a named sender" }
        if s.revokedAt != nil { return "Google refused the connection" }
        return "Connect your mailbox"
    }

    private var explain: String {
        guard let s = status else { return "One moment." }
        if s.configured != true {
            return "The server has no Google credentials, so no mailbox can be connected from here. An exec needs to configure it."
        }
        if s.allowed != true {
            return "Sending and reading mail is limited to a named list, and your account is not on it. Ask an exec to add your address."
        }
        if s.revokedAt != nil {
            return "The permission was withdrawn or expired, so replies have stopped arriving. Connecting again restores it."
        }
        return "Your replies live in your Griffin Fund mailbox. Connect it once and everything people send back shows up here, and you can answer from the terminal."
    }
}
