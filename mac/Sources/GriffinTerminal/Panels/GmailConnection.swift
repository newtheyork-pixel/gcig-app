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
