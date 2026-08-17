import SwiftUI

// NOTE — a private, per-member research note on the focused ticker,
// one note per (user, ticker), saved to the member's profile and
// visible only to its owner. The personal counterpart to the club's
// HoldingThesis: a place to jot a thesis, open questions, reminders.
//
// Unlike the read-only panels, this one writes, and the web panel's
// contract carries over whole. Saving is explicit — there is no
// autosave, because an autosave that fails silently eats research —
// so the footer label always states the truth: Saving… / Unsaved
// changes / Saved ✓ with a timestamp / the server's own error
// sentence. A failed save keeps the draft on screen exactly as
// typed; savedBody is untouched so the buffer still reads as dirty
// and Save stays live for a retry. Clear empties the editor and
// persists the emptiness — the server turns an empty body into a
// row delete, so the note is genuinely gone, durably.
struct NotesPanel: View {
    let ticker: String

    // What both GET and PUT /notes/:ticker return. `updatedAt` stays
    // a String: Prisma serializes dates with fractional seconds and
    // the house decoder's .iso8601 strategy rejects those as Date.
    struct Note: Decodable {
        let ticker: String?
        let body: String?
        let updatedAt: String?
    }

    // The web keeps a fourth state, 'saved', but never renders it
    // differently from idle-with-a-clean-buffer — the status line is
    // derived from saving/error/dirty/savedBody alone — so the port
    // collapses it rather than carrying an unobservable state.
    private enum SaveState { case idle, saving, error(String) }

    private static let maxBody = 10_000

    @State private var state: Loadable<Note> = .loading

    // The persisted text (last known server state) vs. the working
    // copy in the editor. "Unsaved changes" is simply the two
    // diverging.
    @State private var savedBody = ""
    @State private var draft = ""
    @State private var updatedAt: String? = nil
    @State private var saveState: SaveState = .idle

    // Guards a late save response — from an older save, or from a
    // previous ticker after a reload — landing in this editor. The
    // same hazard the web panel's reqSeq covers.
    @State private var saveSeq = 0

    private var dirty: Bool { draft != savedBody }
    private var saving: Bool {
        if case .saving = saveState { return true }
        return false
    }

    var body: some View {
        if ticker.isEmpty {
            PanelMessage(text: "Enter a ticker to open your research notes.")
        } else {
            PanelState(state: state, retry: { Task { await load() } }) { _ in
                VStack(alignment: .leading, spacing: 0) {
                    header
                    Divider().overlay(Term.border)
                    editor
                        .padding(10)
                    controls
                        .padding(.horizontal, 10)
                    Text("Private to you and saved to your profile — not shared with the club. One note per ticker; Clear removes it.")
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgMuted)
                        .padding(.horizontal, 10)
                        .padding(.top, 6)
                        .padding(.bottom, 8)
                }
            }
            .task(id: ticker) { await load() }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(ticker.uppercased())
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.amber)
            SectionLabel(text: "Notes")
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $draft)
                .font(Term.mono(12))
                .foregroundStyle(Term.white)
                .lineSpacing(4)
                .scrollContentBackground(.hidden)
                .autocorrectionDisabled()
                .padding(6)
            if draft.isEmpty {
                Text("Your private research notes for \(ticker.uppercased()) — thesis, open questions, reminders. Saved to your profile.")
                    .font(Term.mono(12))
                    .foregroundStyle(Term.fgMuted)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 14)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .frame(minHeight: 180)
        .background(Term.bg)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
        .onChange(of: draft) { _, next in
            // The web textarea enforces maxLength natively; TextEditor
            // does not, so the cap lands here. Truncation re-fires
            // onChange with a length that passes, so this terminates.
            if next.count > Self.maxBody {
                draft = String(next.prefix(Self.maxBody))
                return
            }
            // Typing again leaves a stale save error behind — the
            // status should track the live edit, not the last failure.
            if case .error = saveState { saveState = .idle }
        }
    }

    private var controls: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button(saving ? "Saving…" : "Save") { persist(draft) }
                .buttonStyle(TermButtonStyle())
                .disabled(saving || !dirty)
            Button("Clear") {
                draft = ""
                persist("")
            }
            .buttonStyle(TermButtonStyle())
            .disabled(saving || (draft.isEmpty && savedBody.isEmpty))

            Text(status.text)
                .font(Term.mono(11))
                .foregroundStyle(status.tone)
                .lineLimit(2)

            Spacer(minLength: 8)

            Text("\(Fmt.money(Double(draft.count), decimals: 0)) / 10,000")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .monospacedDigit()
        }
    }

    // The corner label that makes explicit save survivable: whatever
    // the truth is right now — in flight, failed with the server's
    // sentence, diverged from disk, clean, or never written — it says
    // so. Priority order is the web panel's, verbatim.
    private var status: (text: String, tone: Color) {
        if saving { return ("Saving…", Term.fgMuted) }
        if case .error(let msg) = saveState { return (msg, Term.negative) }
        if dirty { return ("Unsaved changes", Term.amber) }
        if !savedBody.isEmpty {
            let at = savedAtLabel(updatedAt).map { " · \($0)" } ?? ""
            return ("Saved ✓\(at)", Term.fgMuted)
        }
        return ("No note yet — start typing.", Term.fgMuted)
    }

    // "Jul 28, 3:45 PM" — the web's fmtSavedAt. Not Fmt.date, which
    // drops the time; for a note the time is the informative part.
    private func savedAtLabel(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        else { return nil }
        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US_POSIX")
        out.dateFormat = "MMM d, h:mm a"
        return out.string(from: d)
    }

    private var encodedTicker: String {
        ticker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ticker
    }

    private func load() async {
        // A ticker change orphans any in-flight save; bumping the
        // sequence keeps its late response out of the new editor.
        saveSeq += 1
        saveState = .idle
        savedBody = ""
        draft = ""
        updatedAt = nil
        state = .loading
        do {
            let data = try await API.shared.get("/notes/\(encodedTicker)")
            let note = try await API.shared.decode(Note.self, from: data)
            guard !Task.isCancelled else { return }
            savedBody = note.body ?? ""
            draft = note.body ?? ""
            updatedAt = note.updatedAt
            state = .loaded(note)
        } catch is CancellationError {
            return
        } catch API.Failure.unauthorized {
            guard !Task.isCancelled else { return }
            // Terminal users are authed; if the session lapsed
            // mid-session, degrade with the web's sentence rather
            // than a raw 401.
            state = .failed("Sign in to keep notes.")
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(error.localizedDescription)
        }
    }

    // Save the given text. Empty is the deliberate "clear" — the
    // server deletes the row and returns the empty shape. On failure
    // the draft is left exactly as the user typed it and only the
    // status flips; on success we settle on the server's canonical
    // body (it trims), same as the web panel does on resolve.
    private func persist(_ text: String) {
        guard !ticker.isEmpty else { return }
        saveSeq += 1
        let seq = saveSeq
        saveState = .saving
        Task {
            do {
                let data = try await API.shared.put("/notes/\(encodedTicker)",
                                                    json: ["body": text])
                guard seq == saveSeq else { return } // superseded
                let note = try await API.shared.decode(Note.self, from: data)
                savedBody = note.body ?? ""
                draft = note.body ?? ""
                updatedAt = note.updatedAt
                saveState = .idle
            } catch API.Failure.unauthorized {
                guard seq == saveSeq else { return }
                saveState = .idle
                state = .failed("Sign in to keep notes.")
            } catch {
                guard seq == saveSeq else { return }
                // The server's own sentence when it sent one ("Could
                // not save note. Try again.") — never wipe the text.
                saveState = .error(error.localizedDescription)
            }
        }
    }
}

// API.swift predates any panel that writes, so the actor speaks GET
// and POST but not PUT. This mirrors `send` there — same base, same
// X-New-Token rotation, same 401 mapping, same { error } surfacing —
// and lives here only because this port ships as one file. Fold it
// into API.swift the next time that file is open, and delete this.
extension API {
    func put(_ path: String, json: [String: Any]) async throws -> Data {
        let base = ProcessInfo.processInfo.environment["GRIFFIN_API"]
            ?? "https://gcig-api.onrender.com/api"
        guard let url = URL(string: base + path) else {
            throw Failure.transport("Bad URL for \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.timeoutInterval = 30
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = TokenStore.read() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data, response: URLResponse
        do {
            (data, response) = try await Net.session.data(for: req)
        } catch {
            throw Failure.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw Failure.transport("No HTTP response.")
        }

        // Silent rotation. A panel that writes must honor it too, or
        // a long note-taking session dies at the 24h mark.
        // Through adopt, never a raw write. A panel that rotates on its
        // own is a second door onto the token store, and the whole bug
        // was a stale rotation getting through one.
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token") {
            TokenStore.adopt(fresh)
        }

        if http.statusCode == 401 || http.statusCode == 403 {
            throw Failure.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { $0?["error"] as? String } ?? ""
            throw Failure.http(http.statusCode, msg)
        }
        return data
    }
}
