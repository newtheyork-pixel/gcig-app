import SwiftUI

// A private note on a name.
//
// This is the one write that genuinely belongs on the phone. A thought
// about a company does not arrive at a desk — it arrives on a train, in a
// store, halfway through somebody else's sentence — and by the time the
// laptop is open it has been rounded down to "I liked the store". The
// terminal is where research is written up; this is where it is caught.
//
// It is also the one write that cannot lose anything, because what it is
// holding is not recoverable from anywhere else. A price we fail to fetch
// is on the server; a paragraph we drop is gone. Every decision below
// falls out of that: the draft lives in view state and NOTHING clears it
// except a save the server confirmed, the PUT is never retried behind the
// member's back, and a failure says so in a sentence with the text still
// sitting under it.
//
// The route (server/src/routes/notes.js) is mounted behind verifyJwt and
// nothing else, so every member has this — no rank gate, no Analyst
// ladder. That is deliberate on the server's side and worth not
// second-guessing here.

// MARK: The record

/// Read from the handler, not guessed. All four exits in
/// `server/src/routes/notes.js` return this same three-key object and
/// nothing else:
///
///   :41-43   `emptyNote()`   — { ticker, body: '', updatedAt: null }
///   :62-66   GET, note found
///   :108-112 PUT, after the upsert
///   :138     DELETE
///
/// There is no envelope and no `id`. `updatedAt` is a Prisma DateTime, so
/// it arrives as an ISO string with fractional seconds — `Fmt.parseISO`
/// and `Fmt.shortDateTime` already cope with both spellings.
///
/// Every field optional, per the house rule: a renamed key must decode to
/// nil, not to a plausible-looking wrong value. Here the cost of getting
/// that wrong is unusually direct — a `body` that silently decodes to nil
/// is an empty editor over a note the member actually wrote.
struct TickerNote: Decodable {
    let ticker: String?
    let body: String?
    let updatedAt: String?

    /// The handler sends `''` for "never written" and never null, but a
    /// missing key must land in the same place rather than crash into an
    /// optional two views down.
    var text: String { body ?? "" }
}

// MARK: The store

/// BookStore's shape, with one addition: a write is a separate concern
/// from a read, so `writing` and `writeError` sit beside `state` rather
/// than inside it. Collapsing them would mean a failed save either blanks
/// the note (`.failed`) or hides behind a stale strip that talks about
/// refreshing — neither of which is "your save did not land, your words
/// are still here".
@MainActor
final class TickerNotesStore: ObservableObject {
    @Published private(set) var state: Loadable<TickerNote> = .loading
    /// A PUT or DELETE is in flight. The button is the only thing that
    /// reads it, and it must be impossible to press twice.
    @Published private(set) var writing = false
    /// The last write failure, in the server's own words. Cleared when the
    /// next write starts, never by a read.
    @Published private(set) var writeError: String?
    /// A 403, held apart from every other failure. It is an answer, not an
    /// outage, so it renders as one quiet sentence with no RETRY — a
    /// button that can never succeed is worse than no button.
    @Published private(set) var gate: String?

    private let ticker: String

    init(ticker: String) {
        self.ticker = ticker.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    /// The handler upper-cases and trims the path param itself, so this is
    /// only about not handing `URL(string:)` something it will refuse —
    /// which surfaces as `noResponse`, an error about the network for a
    /// fault that is ours.
    private var path: String {
        let safe = ticker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ticker
        return "/notes/\(safe)"
    }

    func load() async {
        state = .loading
        await fetch(keepingOldOnFailure: false)
    }

    /// Keeps what is on screen when it fails. Note that on this screen the
    /// thing being kept may be a note the member is halfway through
    /// editing, which makes blanking it that much less forgivable.
    func refresh() async {
        await fetch(keepingOldOnFailure: true)
    }

    private func fetch(keepingOldOnFailure keepOld: Bool) async {
        let previous = state.value
        do {
            let note = try await API.shared.get(path, as: TickerNote.self)
            gate = nil
            state = .loaded(note, at: Date())
        } catch APIError.cancelled {
            // Scrolling this section off a LazyVStack cancels its task.
            // That is not a failure and must never be drawn as one.
            return
        } catch APIError.forbidden(let msg) {
            gate = msg
        } catch {
            let msg = error.localizedDescription
            if keepOld, let previous {
                state = .stale(previous, msg)
            } else {
                state = .failed(msg)
            }
        }
    }

    /// PUT /api/notes/:ticker { body }.
    ///
    /// Returns whether the server confirmed it, and the caller uses that
    /// to decide whether it may touch the member's text. False means the
    /// draft is untouched — that is the whole contract of this method.
    ///
    /// The server trims and slices to 10,000 (:88-90) and hands back what
    /// it stored, so the response is the authority on what the note now
    /// says, not the string we sent.
    func save(_ text: String) async -> Bool {
        await write { try await API.shared.put(self.path, body: ["body": text], as: TickerNote.self) }
    }

    /// DELETE /api/notes/:ticker.
    ///
    /// `deleteMany` scoped to the caller (:135-137), so removing a note
    /// that is not there is a clean success and not a 404 — which means
    /// the confirm-then-delete path never has to special-case an empty
    /// note.
    func clear() async -> Bool {
        await write { try await API.shared.delete(self.path, as: TickerNote.self) }
    }

    private func write(_ op: () async throws -> TickerNote) async -> Bool {
        writing = true
        writeError = nil
        defer { writing = false }
        do {
            let note = try await op()
            gate = nil
            state = .loaded(note, at: Date())
            return true
        } catch APIError.cancelled {
            // A cancelled write is the one case where we genuinely do not
            // know: the PUT may have landed before the socket went. We
            // report nothing, keep the text, and leave the note marked
            // unsaved — saving again is harmless because the handler
            // upserts on (userId, ticker), so a duplicate save is the same
            // save. Claiming success here would be a guess about the
            // member's own words.
            return false
        } catch APIError.forbidden(let msg) {
            gate = msg
            return false
        } catch {
            // Writes are never retried — `API.post`/`put` deliberately
            // skip the read ladder — so this is final until a person
            // presses the button again. The handler promises a 4xx and
            // never a 5xx here (:113-121), and its 400 carries a sentence
            // meant to be shown: "Could not save note. Try again."
            writeError = error.localizedDescription
            return false
        }
    }
}

// MARK: The section

/// Drops into a ticker screen's `LazyVStack` beside the other sections.
/// It owns its own store because a note has nothing to do with the quote,
/// loads later than the quote does, and must not be able to take a price
/// panel down with it.
struct TickerNotesSection: View {
    let ticker: String

    @StateObject private var store: TickerNotesStore

    /// The member's text, and the reason this file exists. It is view
    /// state, not store state, so no fetch, refresh, failure or scene
    /// change can reach it. The only writes to it are: seeding it once
    /// from the first successful load, and replacing it with what the
    /// server confirmed it stored.
    @State private var draft = ""
    @State private var seeded = false
    @State private var confirmingDelete = false
    /// True when the server stored fewer characters than we sent, which
    /// happens at the 10,000 cap. Silence there would mean a member's last
    /// paragraph quietly not existing.
    @State private var wasTruncated = false
    @FocusState private var editing: Bool

    /// The cap the handler enforces at :32. Mirrored only to warn before
    /// the cut, never to block typing — the server's rule is that a long
    /// paste keeps its first 10,000 rather than losing the whole save, and
    /// a client that refuses the keystroke is stricter than the system it
    /// is a window onto.
    private let maxBody = 10_000

    init(ticker: String) {
        self.ticker = ticker.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        _store = StateObject(wrappedValue: TickerNotesStore(ticker: ticker))
    }

    var body: some View {
        Section {
            content
        } header: {
            SectionHeader(text: "My note", trailing: savedStamp)
        }
        .task {
            // Only ever the first load. Every other path through this
            // screen goes through refresh(), which cannot blank anything.
            guard !ticker.isEmpty, store.state.value == nil, store.gate == nil else { return }
            await store.load()
            seedIfUntouched()
        }
        // Deliberately no `aged(after:)` and no pull-to-refresh of our
        // own. A note is not a price: it does not decay, and the only
        // person who can change it is the one holding the phone. A stale
        // strip over somebody's own paragraph would be the app inventing
        // doubt about a fact it is not entitled to doubt.
        //
        // The one refresh worth having is coming back after a long absence
        // — the member may have written on the Mac in between — and it is
        // taken ONLY when there is nothing unsaved to lose.
        .refreshOnForeground(after: 300) {
            guard !dirty else { return }
            await store.refresh()
            reseed()
        }
        .confirmationDialog("Delete this note?",
                            isPresented: $confirmingDelete,
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteNote() } }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("The note on \(ticker) is removed from the server. Nothing else in the club sees this either way.")
        }
    }

    @ViewBuilder private var content: some View {
        if ticker.isEmpty {
            // BookScreen builds its navigation value as
            // `TickerScreen(symbol: h.ticker ?? "")`, so a sheet row with
            // no symbol reaches us as an empty string. Firing the request
            // anyway means a 400 "Invalid ticker" presented as a failure,
            // which reads as our fault rather than as a gap in the sheet.
            quiet("This position has no ticker on the sheet, so there is nowhere to file a note against it.")
        } else if let gate = store.gate {
            // One sentence, no RETRY. See TickerNotesStore.gate.
            quiet(gate)
        } else {
            ScreenState(state: store.state,
                        retry: { Task { await store.load(); seedIfUntouched() } },
                        staleRetry: { Task { await store.refresh() } }) { _ in
                editor
            }
        }
    }

    // MARK: the editor

    /// Note there is no `emptyWhen` on the ScreenState above, and that is
    /// the point: an empty note is not an empty result. The editor has to
    /// be present exactly when there is nothing there, because that is the
    /// moment somebody wants to write.
    private var editor: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            privacyLine

            if savedText.isEmpty && !dirty {
                // Neither an error nor good news, so `good:` stays false:
                // green here would congratulate a member for not having
                // done the work. Worth knowing that the handler degrades a
                // failed read to the same empty shape (:67-70), so in rare
                // cases this sentence is our database having a bad moment
                // wearing an honest face. It stays a claim about our own
                // record and never about the company, which is the only
                // reason that is tolerable.
                EmptyState(text: "Nothing filed on \(ticker) yet.")
            }

            textBox

            if draft.count > maxBody - 1_000 {
                quiet("\(draft.count) characters. The server keeps the first \(maxBody).")
            }
            if wasTruncated {
                warn("That was longer than \(maxBody) characters. What you see now is what was stored — the rest was cut.")
            }
            if let msg = store.writeError {
                warn("\(msg) Nothing was discarded: the text above is exactly what you typed.")
            }

            controls
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }

    /// Said plainly because the handler is unambiguous about it: every
    /// query is bound to the composite (userId, ticker) key against
    /// `req.user.id` (:57-58, :96-98, :103-104, :135-136), and there is no
    /// route in that file that reads anybody else's row. The club-wide
    /// counterpart is HoldingThesis, which lives somewhere else entirely.
    /// A member deciding whether to write down a doubt needs to know which
    /// of the two this is before they type, not after.
    private var privacyLine: some View {
        HStack(alignment: .top, spacing: Space.s) {
            Chip(text: "Private", tone: T.cyan, style: .solid)
            Text("Only you can read this. It is filed under your account, not the club's, and nothing here reaches a pitch, a vote or the terminal.")
                .font(Type.footnote)
                .foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var textBox: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $draft)
                .font(Type.body)
                .foregroundStyle(T.white)
                .tint(T.amber)
                .scrollContentBackground(.hidden)
                .focused($editing)
                .textInputAutocapitalization(.sentences)
                // A fixed height rather than one that grows: a TextEditor
                // that sizes to its content inside a ScrollView fights the
                // outer scroll and jumps the whole screen on every return
                // key. Tall enough for a real thought, short enough that
                // the sections below it stay reachable.
                .frame(minHeight: 180)
                .padding(Space.s)

            if draft.isEmpty {
                Text("What you noticed, and when.")
                    .font(Type.body)
                    .foregroundStyle(T.muted)
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, Space.m)
                    .allowsHitTesting(false)
            }
        }
        .background(T.card)
        // The one rounded thing in the app, at the radius Components.swift
        // names: square corners clip the iOS selection loupe.
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(T.border, lineWidth: 1))
        // A TextEditor is the only surface in this app that takes a
        // keyboard, and there is no other way to put it away.
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("DONE") { editing = false }
                    .font(Type.chip)
                    .foregroundStyle(T.amber)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: Space.m) {
            Button(store.writing ? "SAVING" : "SAVE") {
                editing = false
                if saveWouldDelete {
                    // Saving an emptied box is a DELETE on the server
                    // (:93-100) — the same destruction as the button
                    // below, arrived at by a word that promises the
                    // opposite. It gets the same confirmation.
                    confirmingDelete = true
                } else {
                    Task { await saveNote() }
                }
            }
            .buttonStyle(GriffinButtonStyle())
            .disabled(!dirty || store.writing)

            if store.writing {
                ProgressView().tint(T.amber)
            }

            Spacer(minLength: Space.s)

            if !savedText.isEmpty {
                Button("DELETE") {
                    editing = false
                    confirmingDelete = true
                }
                .buttonStyle(GriffinButtonStyle(tone: T.negative))
                .disabled(store.writing)
            }
        }
        .overlay(alignment: .topLeading) {
            if dirty && !store.writing {
                Chip(text: "Unsaved", tone: T.amber, style: .solid)
                    .offset(y: -Space.m)
            }
        }
    }

    // MARK: actions

    private func saveNote() async {
        let outgoing = trimmedDraft
        wasTruncated = false
        guard await store.save(outgoing) else { return }

        // Only now, with the server's own answer in hand, is the draft
        // allowed to move — and it moves to what was STORED, not to what
        // was sent. The handler trims and caps, so the two can differ, and
        // showing the sent version would leave the box disagreeing with
        // the database while claiming to be saved.
        let stored = savedText
        wasTruncated = stored.count < outgoing.count
        draft = stored
    }

    private func deleteNote() async {
        guard await store.clear() else { return }
        wasTruncated = false
        draft = ""
        seeded = true
    }

    /// Seed once, from the first load that actually returned something.
    /// After that the member owns the box: a later refresh must never
    /// overwrite what somebody has typed, which is the failure this flag
    /// exists to prevent.
    private func seedIfUntouched() {
        guard !seeded, let note = store.state.value else { return }
        draft = note.text
        seeded = true
    }

    /// The deliberate exception, taken only when `dirty` is false — see
    /// the refreshOnForeground call above.
    private func reseed() {
        guard let note = store.state.value else { return }
        draft = note.text
        seeded = true
    }

    // MARK: derived

    private var savedText: String { store.state.value?.text ?? "" }

    /// Compared TRIMMED, because the server trims before it stores
    /// (:89-90). Comparing raw would leave a box whose only difference
    /// from the database is a trailing newline permanently marked unsaved,
    /// with a live SAVE button that changes nothing.
    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var dirty: Bool { trimmedDraft != savedText }

    /// An emptied box over an existing note. Pressing SAVE here destroys
    /// the note rather than saving it, so the word has to be checked
    /// before it is believed.
    private var saveWouldDelete: Bool { trimmedDraft.isEmpty && !savedText.isEmpty }

    private var savedStamp: String? {
        guard let iso = store.state.value?.updatedAt, !savedText.isEmpty else { return nil }
        return "SAVED \(Fmt.shortDateTime(iso))"
    }

    // MARK: small pieces

    private func quiet(_ text: String) -> some View {
        Text(text)
            .font(Type.footnote)
            .foregroundStyle(T.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .hairline()
    }

    /// A write that did not land, said in the negative colour and with the
    /// reassurance attached. The chip is a system label and stays mono;
    /// the sentence beside it is prose, per the type rule.
    private func warn(_ text: String) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            Chip(text: "Not saved", tone: T.negative, style: .solid)
            Text(text)
                .font(Type.footnote)
                .foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.negative.opacity(0.12))
    }
}
