import SwiftUI

// Ballots.
//
// Of everything the club does, a vote is the one obligation with a hard
// clock and a two-tap answer, which is the definition of phone-shaped: the
// deadline arrives while you are on a bus and the whole interaction is
// "which way, and confirm". Everything else this screen shows — the case,
// the running tally, who has said what — is context for those two taps and
// is deliberately subordinate to them.
//
// Every route behind this screen is `verifyJwt` only (votes.js:7), with no
// role gate anywhere in the file, so this is the one substantial surface a
// JuniorAnalyst gets in full. It must NOT be hidden behind
// `terminalAccess`; that flag gates /terminal/* and /watchlist and has
// nothing to say about club governance.
//
// The one rule this screen exists to honour: a deadline that has passed
// reads as CLOSED, never as a button that does not work. The server closes
// expired sessions lazily on read (votes.js:123-128), so a row can be
// stamped "open" in the database right up until somebody looks at it — the
// client therefore treats "past its deadline" as closed on its own
// authority rather than trusting `status` alone.

// MARK: - What the server sends
//
// Written from server/src/routes/votes.js with the file open, not from the
// web client's JSX. Every field optional, because a key that was renamed
// decodes to nil in silence and a screen that guessed would print a dash as
// though it were a fact about the vote.

/// One voting session, as both list routes serve it.
///
/// votes.js:133-144 (`GET /api/votes`) and votes.js:147-161
/// (`GET /api/votes/pending`) both return raw `VotingSession` rows with
/// `creator` and `pitch` selected in. The column names are Prisma's, from
/// `model VotingSession` in schema.prisma, and Prisma serialises them
/// verbatim. Only the list route asks for `_count`, so `counts` is absent
/// on a pending row rather than zero — which is why it is optional and why
/// nothing on screen renders "0 ballots" from its absence.
struct VoteSession: Decodable {
    let id: Int?
    let ticker: String?
    let title: String?
    let status: String?
    /// "buy" or "sell". votes.js:262-265 resolves it and lowercases it, so
    /// anything else means the payload changed under us.
    let kind: String?
    /// "average" or "fixed", and meaningless on a sell session.
    let amountMode: String?
    let fixedAmount: Double?
    let deadline: String?
    let createdAt: String?
    let closedAt: String?
    let synthesis: String?
    let creator: VoteMemberRef?
    let pitch: VotePitchRef?
    let counts: VoteCounts?

    enum CodingKeys: String, CodingKey {
        case id, ticker, title, status, kind, amountMode, fixedAmount
        case deadline, createdAt, closedAt, synthesis, creator, pitch
        case counts = "_count"
    }

    /// A stable identity for ForEach that does not pretend a row without an
    /// id is the same row as another one without an id.
    var rowKey: String { "\(id.map { String($0) } ?? "?")-\(ticker ?? "")" }
}

/// votes.js:138, :170 — `select: { id, name, role }` on the creator, and
/// the same shape on each ballot's user.
struct VoteMemberRef: Decodable {
    let id: Int?
    let name: String?
    let role: String?
}

/// votes.js:139, :171. The detail route also selects `date`; the list and
/// pending routes do not, so it is absent there rather than null.
struct VotePitchRef: Decodable {
    let id: Int?
    let ticker: String?
    let pitcherName: String?
    let slideshowUrl: String?
    let date: String?
}

/// votes.js:140 — `_count: { select: { ballots: true } }`.
struct VoteCounts: Decodable {
    let ballots: Int?
}

/// `GET /api/votes/pending` answers with a session OR with the JSON literal
/// `null` (votes.js:160, `res.json(session || null)`), which no plain
/// decodable can absorb. Wrapping it means "nobody is waiting on you" and
/// "we could not tell" stay different answers, and the screen only says the
/// good-news one when the server actually said it.
struct VotePendingSlot: Decodable {
    let session: VoteSession?

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        session = c.decodeNil() ? nil : try VoteSession(from: decoder)
    }
}

/// The detail payload. votes.js:203 spreads the session row and adds three
/// computed things: `...session, tally, myBallot, synthesis`.
///
/// The session half is decoded through `VoteSession` from the same keyed
/// container rather than copied out field by field, so the list and the
/// detail can never drift into disagreeing about what a session is.
struct VoteDetail: Decodable {
    let session: VoteSession
    /// votes.js:172-175 — every ballot, with its voter. Votes in this club
    /// are not secret and the server has always served them to any member.
    let ballots: [VoteBallot]?
    let tally: VoteTally?
    /// votes.js:185 — my own row, or null if I have not voted.
    let myBallot: VoteBallot?

    private enum K: String, CodingKey { case ballots, tally, myBallot }

    init(from decoder: Decoder) throws {
        session = try VoteSession(from: decoder)
        let c = try decoder.container(keyedBy: K.self)
        ballots = (try? c.decodeIfPresent([VoteBallot].self, forKey: .ballots)) ?? nil
        tally = (try? c.decodeIfPresent(VoteTally.self, forKey: .tally)) ?? nil
        myBallot = (try? c.decodeIfPresent(VoteBallot.self, forKey: .myBallot)) ?? nil
    }
}

/// A cast ballot. The shape is `model Ballot` plus the included user, and
/// it is also exactly what the POST returns (votes.js:329-346).
///
/// `action` is the wire value and is one of Buy / Hold / Sell — the
/// `VoteAction` enum in schema.prisma. It is NOT always what the member was
/// shown: on a fixed-amount session the button says No and the server
/// stores Hold (votes.js:289-293). Anything rendering this string must go
/// through `VoteRules.label` or it will tell a member they voted Hold when
/// they pressed No.
struct VoteBallot: Decodable {
    let id: Int?
    let sessionId: Int?
    let userId: Int?
    let action: String?
    let investmentAmount: Double?
    let note: String?
    let castAt: String?
    let user: VoteMemberRef?
}

/// The weighted tally, votes.js:95-118.
///
/// Worth stating plainly because the screen has to render it honestly: the
/// general body votes as ONE BLOC worth 3 (votes.js:16), each sitting
/// President or CIO carries 1, a tied bloc contributes nothing at all, and
/// a tied final result defaults to Hold (votes.js:56). A bar chart of raw
/// headcount would be a lie about how this club decides.
struct VoteTally: Decodable {
    /// Raw general-body headcount, before the bloc is applied.
    let memberCounts: VoteActionCounts?
    let memberTotal: Int?
    /// Which way the bloc went, or null when the general body tied.
    let generalBodyDecision: String?
    let generalBodyWeight: Int?
    let generalBodyBlocWeight: Int?
    let leadershipVotes: [VoteLeadershipBallot]?
    let buyAmountStats: VoteAmountStats?
    let leadershipCount: Int?
    let leadershipEligible: Int?
    let maxWeightedVotes: Int?
    /// The weighted totals the decision is actually read off.
    let weights: VoteActionCounts?
    let totalWeightedVotes: Int?
    /// Computed on every read, open or closed. On an OPEN session this is
    /// where the vote stands if it ended now, and must never be labelled
    /// final.
    let finalDecision: String?
    let isTied: Bool?
}

/// The Buy / Hold / Sell counters. The JSON keys are capitalised because
/// they are the `VoteAction` enum's own spelling.
struct VoteActionCounts: Decodable {
    let buy: Int?
    let hold: Int?
    let sell: Int?

    enum CodingKeys: String, CodingKey {
        case buy = "Buy", hold = "Hold", sell = "Sell"
    }

    func count(forWire wire: String) -> Int? {
        switch wire {
        case "Buy":  return buy
        case "Hold": return hold
        case "Sell": return sell
        default:     return nil
        }
    }
}

/// votes.js:101-108.
struct VoteLeadershipBallot: Decodable {
    let userId: Int?
    let name: String?
    let role: String?
    let action: String?
    let note: String?
    let investmentAmount: Double?
}

/// votes.js:64-93. `fixed: true` is the flag that says avg / min / max are
/// all the same pinned number rather than an average of anything, and the
/// UI must relabel rather than print "average $5,000 across 6 ballots" for
/// a figure nobody averaged.
struct VoteAmountStats: Decodable {
    let count: Int?
    let avg: Double?
    let min: Double?
    let max: Double?
    let fixed: Bool?
}

// MARK: - The choice rules
//
// A DIRECT mirror of prepareBallot (votes.js:276-310). There is one rule
// and it lives on the server; this is a translation of it, not a second
// opinion. If the two ever disagree the member finds out by having a ballot
// rejected, which is the worst possible way to learn about a UI bug, so the
// line numbers are here to be checked against.

/// One button on the ballot.
struct VoteChoice: Identifiable {
    /// The wire value doubles as identity: no ballot offers the same
    /// server-side action twice.
    var id: String { wire }
    /// What the member is told they are doing.
    let label: String
    /// The server's own gloss on it, from the CLAUDE.md description of the
    /// two session kinds.
    let detail: String
    /// What we POST as `action`.
    let wire: String
    let tone: Color
    /// Only a Buy on an average-mode session carries a dollar figure.
    let carriesAmount: Bool
}

enum VoteRules {
    /// votes.js:257-258. Mirrored, and clamped locally before the POST, so
    /// the member cannot be handed a 400 for a number our own control
    /// offered them.
    static let buyMin: Double = 1500
    static let buyMax: Double = 10000
    static let buyStep: Double = 250

    static func isSell(_ session: VoteSession) -> Bool {
        (session.kind ?? "buy").lowercased() == "sell"
    }

    /// Fixed mode is a BUY-session concept. votes.js:223-234 forces a sell
    /// session to average with a null amount, so asking about a sell
    /// session's amountMode is asking a question with no meaning.
    static func isFixed(_ session: VoteSession) -> Bool {
        !isSell(session) && (session.amountMode ?? "average").lowercased() == "fixed"
    }

    /// The three ballots this app can present, and no fourth.
    static func choices(for session: VoteSession) -> [VoteChoice] {
        if isSell(session) {
            // votes.js:280-285.
            return [
                VoteChoice(label: "Sell", detail: "Exit the position.",
                           wire: "Sell", tone: T.negative, carriesAmount: false),
                VoteChoice(label: "Hold", detail: "Maintain.",
                           wire: "Hold", tone: T.dim, carriesAmount: false)
            ]
        }
        if isFixed(session) {
            // votes.js:289-293. The creator pinned the figure; members only
            // ratify it. "No" is persisted as Hold so the shared weighting
            // machinery is untouched, and the screen says so out loud
            // rather than letting somebody discover it in the tally.
            let pinned = Fmt.money(session.fixedAmount)
            return [
                VoteChoice(label: "Buy",
                           detail: "Support committing \(pinned).",
                           wire: "Buy", tone: T.positive, carriesAmount: false),
                VoteChoice(label: "No",
                           detail: "Do not support the amount. Recorded as Hold.",
                           wire: "Hold", tone: T.dim, carriesAmount: false)
            ]
        }
        // votes.js:296-309: the original pitch ballot.
        return [
            VoteChoice(label: "Buy", detail: "Commit the amount you propose below.",
                       wire: "Buy", tone: T.positive, carriesAmount: true),
            VoteChoice(label: "Hold", detail: "Not now.",
                       wire: "Hold", tone: T.dim, carriesAmount: false),
            VoteChoice(label: "Sell", detail: "Against the position.",
                       wire: "Sell", tone: T.negative, carriesAmount: false)
        ]
    }

    /// What a stored action should be CALLED on this session.
    ///
    /// The one case that matters: a Hold on a fixed-amount session was a
    /// press of the No button. Printing "Hold" there tells a member they
    /// abstained when they refused.
    static func label(forWire wire: String?, in session: VoteSession) -> String {
        guard let wire, !wire.isEmpty else { return "—" }
        if isFixed(session), wire == "Hold" { return "No" }
        return wire
    }

    static func tone(forWire wire: String?) -> Color {
        switch wire {
        case "Buy":  return T.positive
        case "Sell": return T.negative
        case "Hold": return T.dim
        default:     return T.muted
        }
    }

    /// Closed on our own authority, not only on the server's flag.
    ///
    /// `closeExpiredSessions` runs at the top of every read (votes.js:133,
    /// :148, :165), so a stale payload can carry status "open" past its own
    /// deadline — and the POST would answer 400 (votes.js:317-319). The
    /// deadline is the truth; the flag is a cache of it.
    static func isClosed(_ session: VoteSession, now: Date) -> Bool {
        if let status = session.status, status.lowercased() != "open" { return true }
        if let deadline = Fmt.parseISO(session.deadline), deadline <= now { return true }
        return false
    }

    static func kindLabel(_ session: VoteSession) -> String {
        if isSell(session) { return "Sell vote" }
        return isFixed(session) ? "Buy vote, fixed amount" : "Buy vote"
    }
}

// MARK: - The clock
//
// Fmt owns money, percentages and dates, and a countdown is none of those.
// It lives here rather than being added to Fmt because exactly one screen
// in this app has a deadline, and a formatter with one caller belongs next
// to that caller until a second one turns up.

enum VoteClock {
    /// "2d 4h left". Nil once the deadline has passed, which is what makes
    /// the caller say CLOSED instead of printing a negative countdown.
    static func remaining(until deadline: Date?, now: Date) -> String? {
        guard let deadline else { return nil }
        let secs = deadline.timeIntervalSince(now)
        guard secs > 0 else { return nil }
        let mins = Int(secs / 60)
        if mins < 1 { return "under a minute left" }
        if mins < 60 { return "\(mins) minute\(mins == 1 ? "" : "s") left" }
        let hours = mins / 60
        if hours < 24 {
            let m = mins % 60
            return m == 0 ? "\(hours)h left" : "\(hours)h \(m)m left"
        }
        let days = hours / 24
        let h = hours % 24
        return h == 0 ? "\(days)d left" : "\(days)d \(h)h left"
    }

    /// Urgency as colour, and only where there is genuine urgency: an
    /// amber strip on a vote that closes next month is noise, and noise is
    /// how a member learns to stop reading the strip that matters.
    static func tone(until deadline: Date?, now: Date) -> Color? {
        guard let deadline else { return nil }
        let secs = deadline.timeIntervalSince(now)
        guard secs > 0 else { return nil }
        if secs < 3600 * 2 { return T.negative }
        if secs < 3600 * 24 { return T.amber }
        return nil
    }
}

// MARK: - What this phone knows about its own ballots
//
// Neither list route says whether I voted. `GET /votes` carries no ballot
// of mine and `GET /votes/pending` is defined as the newest open session I
// have NOT voted in (votes.js:151-153), which answers the question for
// exactly one row and for no other.
//
// So the list claims only what it has actually seen: a ballot this app
// loaded on the detail screen, or one it cast itself. A session nobody has
// opened says nothing about my ballot rather than guessing, because "you
// have not voted" is the sentence that makes somebody vote twice or not at
// all. In memory only, and deliberately not in Cache: it is a convenience,
// and the detail screen is the authority.
@MainActor
final class VoteBallotMemory: ObservableObject {
    static let shared = VoteBallotMemory()
    @Published private(set) var mine: [Int: String] = [:]

    func remember(sessionId: Int?, action: String?) {
        guard let sessionId, let action, !action.isEmpty else { return }
        mine[sessionId] = action
    }

    func action(for sessionId: Int?) -> String? {
        guard let sessionId else { return nil }
        return mine[sessionId]
    }
}

// MARK: - The board

/// What the list screen renders: every session, plus the one the server
/// says is waiting on this member.
struct VoteBoard {
    var sessions: [VoteSession]
    var pending: VoteSession?
    /// False when the pending check itself failed. The distinction is the
    /// whole point of the flag: an empty result is good news and reads as
    /// good news, but our own failed request must never be dressed up as
    /// "nothing is waiting on you".
    var pendingKnown: Bool
}

@MainActor
final class VoteStore: ObservableObject {
    @Published private(set) var state: Loadable<VoteBoard> = .loading
    /// A 403 is an answer, not a failure. Rendered as one quiet sentence,
    /// never as COULD NOT LOAD over a RETRY that can never succeed. Nothing
    /// in votes.js gates on role today, so this is insurance against a gate
    /// being added on the server without the client hearing about it.
    @Published private(set) var forbidden: String?

    private var lastLoad: Date?

    func load() async {
        state = .loading
        await fetch(keepOld: false)
    }

    /// Pull-to-refresh and the stale strip's retry. Never blanks the
    /// screen: a member who pulled still wants to see the deadlines.
    func refresh() async {
        await fetch(keepOld: true)
    }

    func refreshIfStale(after seconds: TimeInterval = 120) async {
        if case .loading = state { return }
        guard let last = lastLoad, Date().timeIntervalSince(last) > seconds else { return }
        await refresh()
    }

    private func fetch(keepOld: Bool) async {
        let previous = state.value
        do {
            let sessions = try await API.shared.get("/votes", as: [VoteSession].self)
            var board = VoteBoard(sessions: sessions, pending: nil, pendingKnown: false)
            // The pending check is a second request and gets its own
            // failure. It is the smaller half of the screen, and losing it
            // must not take the list of deadlines down with it.
            do {
                let slot = try await API.shared.get("/votes/pending", as: VotePendingSlot.self)
                board.pending = slot.session
                board.pendingKnown = true
            } catch APIError.cancelled {
                return
            } catch {
                board.pendingKnown = false
            }
            forbidden = nil
            lastLoad = Date()
            state = .loaded(board, at: Date())
        } catch APIError.cancelled {
            // Leaving the tab mid-load is not a failure. Say nothing.
            return
        } catch APIError.forbidden(let msg) {
            forbidden = msg
            state = .failed(msg)
        } catch {
            let msg = error.localizedDescription
            forbidden = nil
            if keepOld, let previous {
                state = .stale(previous, msg)
            } else {
                state = .failed(msg)
            }
        }
    }
}

@MainActor
final class VoteDetailStore: ObservableObject {
    @Published private(set) var state: Loadable<VoteDetail> = .loading
    @Published private(set) var forbidden: String?

    /// The write's own state, kept separate from the read's. A failed cast
    /// must leave the case, the tally and the deadline exactly where they
    /// were: the member needs all three to decide whether to try again.
    @Published private(set) var casting = false
    @Published var castError: String?
    @Published private(set) var castConfirmation: String?

    func load(_ id: Int) async {
        state = .loading
        await fetch(id, keepOld: false)
    }

    func refresh(_ id: Int) async {
        await fetch(id, keepOld: true)
    }

    private func fetch(_ id: Int, keepOld: Bool) async {
        let previous = state.value
        do {
            let detail = try await API.shared.get("/votes/\(id)", as: VoteDetail.self)
            VoteBallotMemory.shared.remember(sessionId: id, action: detail.myBallot?.action)
            forbidden = nil
            state = .loaded(detail, at: Date())
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden(let msg) {
            forbidden = msg
            state = .failed(msg)
        } catch {
            let msg = error.localizedDescription
            forbidden = nil
            if keepOld, let previous {
                state = .stale(previous, msg)
            } else {
                state = .failed(msg)
            }
        }
    }

    /// Cast, or recast. votes.js:329 upserts on (sessionId, userId), so
    /// voting again replaces the ballot on file rather than adding one, and
    /// the screen tells the member that before they press anything.
    ///
    /// Not retried, and that is deliberate rather than an omission: the
    /// cold-start ladder in API.get is safe because a GET can be repeated,
    /// and a ballot cannot. A write that fails is reported plainly and the
    /// member decides.
    func cast(sessionId: Int, choice: VoteChoice, amount: Double?, note: String) async {
        guard !casting else { return }
        casting = true
        castError = nil
        castConfirmation = nil
        defer { casting = false }

        var body: [String: Any] = ["action": choice.wire]
        if choice.carriesAmount, let amount {
            // Clamped to the band the server enforces at votes.js:304, so
            // a slider that drifted a dollar out cannot cost somebody
            // their vote with a 400.
            let clamped = Swift.min(Swift.max(amount, VoteRules.buyMin), VoteRules.buyMax)
            body["investmentAmount"] = Int(clamped.rounded())
        }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["note"] = trimmed }

        do {
            let ballot = try await API.shared.post("/votes/\(sessionId)/ballot",
                                                   body: body, as: VoteBallot.self)
            VoteBallotMemory.shared.remember(sessionId: sessionId,
                                             action: ballot.action ?? choice.wire)
            castConfirmation = "Recorded as \(choice.label). You can change it until the deadline."
            // The tally the member is about to look at must include the
            // ballot they just cast.
            await refresh(sessionId)
        } catch APIError.cancelled {
            // The one place in this app where cancellation is not silence.
            // A cancelled READ means nobody is looking any more; a
            // cancelled WRITE means we do not know whether the ballot
            // arrived, and telling somebody nothing happened would be a
            // claim we cannot support.
            castError = "The request stopped before the server answered. Reopen this vote to see whether your ballot was recorded."
        } catch {
            castError = error.localizedDescription
        }
    }
}

// MARK: - The list

struct VoteScreen: View {
    @StateObject private var store = VoteStore()
    @ObservedObject private var memory = VoteBallotMemory.shared
    /// Drives the countdowns. Without it a member watching this screen
    /// sees "12 minutes left" until they touch something.
    @ObservedObject private var clock = StaleClock.shared

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "VOTE", title: "Ballots")
            if let msg = store.forbidden {
                // One sentence. Not a failure, and not a retry.
                EmptyState(text: msg)
            } else {
                ScreenState(state: store.state.aged(after: 600, now: clock.tick),
                            emptyWhen: { $0.sessions.isEmpty && $0.pending == nil },
                            emptyText: "No vote has been opened yet.",
                            retry: { Task { await store.load() } },
                            staleRetry: { Task { await store.refresh() } }) { board in
                    content(board)
                }
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: VoteDetailScreen.self) { $0 }
        .task { if store.state.value == nil { await store.load() } }
        .task { await store.refreshIfStale() }
        .refreshOnForeground(after: 60) { await store.refreshIfStale(after: 60) }
    }

    // The three groups, in the order a member cares about them: what is
    // waiting on me, what is still open, what has been decided.

    private var now: Date { clock.tick }

    /// Waiting only while we have not seen a ballot of our own on it. The
    /// server's pending row is defined as one I have not voted in, so the
    /// instant I cast, that row is answered — and it moves down to Open
    /// without a refetch rather than sitting under a header that is now
    /// wrong.
    private func waiting(_ board: VoteBoard) -> VoteSession? {
        guard let p = board.pending else { return nil }
        return memory.action(for: p.id) == nil ? p : nil
    }

    private func openRows(_ board: VoteBoard) -> [VoteSession] {
        let waitingId = waiting(board)?.id
        return board.sessions
            .filter { !VoteRules.isClosed($0, now: now) }
            .filter { $0.id == nil || $0.id != waitingId }
            .sorted { (Fmt.parseISO($0.deadline) ?? .distantFuture)
                    < (Fmt.parseISO($1.deadline) ?? .distantFuture) }
    }

    private func closedRows(_ board: VoteBoard) -> [VoteSession] {
        board.sessions
            .filter { VoteRules.isClosed($0, now: now) }
            .sorted { (Fmt.parseISO($0.closedAt ?? $0.deadline) ?? .distantPast)
                    > (Fmt.parseISO($1.closedAt ?? $1.deadline) ?? .distantPast) }
    }

    /// The archive is unbounded and the phone is not the place to read all
    /// of it. The header says how many of how many, so the cap is a stated
    /// fact rather than a list that silently ends.
    private static let closedShown = 12

    private func content(_ board: VoteBoard) -> some View {
        let open = openRows(board)
        let closed = closedRows(board)
        return ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    if let p = waiting(board) {
                        link(p)
                    } else if board.pendingKnown {
                        // An empty obligation list is good news and must
                        // read as good news.
                        EmptyState(text: "Nothing is waiting on your ballot.", good: true)
                    } else {
                        EmptyState(text: "We could not check whether a vote is waiting on you. The list below is still current.")
                    }
                } header: {
                    SectionHeader(text: "Waiting on you")
                }

                if !open.isEmpty {
                    Section {
                        ForEach(open, id: \.rowKey) { link($0) }
                    } header: {
                        SectionHeader(text: "Open", trailing: "\(open.count)")
                    }
                }

                if !closed.isEmpty {
                    Section {
                        ForEach(closed.prefix(Self.closedShown), id: \.rowKey) { link($0) }
                    } header: {
                        SectionHeader(
                            text: "Closed",
                            trailing: closed.count > Self.closedShown
                                ? "\(Self.closedShown) of \(closed.count)" : "\(closed.count)")
                    }
                }

                footer
            }
        }
        .refreshable { await store.refresh() }
    }

    @ViewBuilder private func link(_ session: VoteSession) -> some View {
        if let id = session.id {
            NavigationLink(value: VoteDetailScreen(sessionId: id, preview: session)) {
                row(session)
            }
            .buttonStyle(.plain)
        } else {
            // No id means no detail route to open. A row that pushes an
            // empty screen is worse than a row that does not move.
            row(session)
        }
    }

    private func row(_ session: VoteSession) -> some View {
        let deadline = Fmt.parseISO(session.deadline)
        let closed = VoteRules.isClosed(session, now: now)
        let left = VoteClock.remaining(until: deadline, now: now)
        let mine = memory.action(for: session.id)

        return TickerRow(
            ticker: session.ticker ?? "—",
            name: rowSubtitle(session),
            meta: metaLine(session, closed: closed),
            strip: closed ? nil : VoteClock.tone(until: deadline, now: now)
        ) {
            VStack(alignment: .trailing, spacing: Space.xs) {
                if closed {
                    Chip(text: "Closed", tone: T.muted)
                } else {
                    Text(left ?? "closing")
                        .font(Type.value)
                        .foregroundStyle(VoteClock.tone(until: deadline, now: now) ?? T.white)
                }
                if let mine {
                    Chip(text: "You: \(VoteRules.label(forWire: mine, in: session))",
                         tone: VoteRules.tone(forWire: mine))
                }
            }
        }
        .contentShape(Rectangle())
    }

    /// The title the creator gave the vote, or failing that the person
    /// whose pitch it is. Written out rather than chained inline: optional
    /// chaining through `pitch` and then mapping over `pitcherName` builds a
    /// doubly-optional string, which is the shape that silently renders
    /// nothing.
    private func rowSubtitle(_ session: VoteSession) -> String? {
        if let t = session.title, !t.isEmpty { return t }
        if let p = session.pitch?.pitcherName, !p.isEmpty { return "Pitched by \(p)" }
        return nil
    }

    private func metaLine(_ session: VoteSession, closed: Bool) -> String {
        var parts = [VoteRules.kindLabel(session)]
        if closed {
            parts.append("closed \(Fmt.day(session.closedAt ?? session.deadline))")
        } else {
            parts.append("closes \(Fmt.shortDateTime(session.deadline))")
        }
        if let n = session.counts?.ballots {
            parts.append("\(n) ballot\(n == 1 ? "" : "s")")
        }
        return parts.joined(separator: " · ")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            AsOfStamp(date: store.state.loadedAt)
            Text("Every member votes, whatever their rank. A ballot can be changed until the deadline.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - The ballot

struct VoteDetailScreen: View, Hashable {
    let sessionId: Int
    /// The row that was tapped, so the ticker and the deadline paint before
    /// the network answers. Never used once the real payload lands.
    var preview: VoteSession? = nil

    @StateObject private var store = VoteDetailStore()
    @ObservedObject private var clock = StaleClock.shared

    @State private var chosen: String?
    @State private var amount: Double = 5000
    @State private var note: String = ""

    static func == (a: VoteDetailScreen, b: VoteDetailScreen) -> Bool {
        a.sessionId == b.sessionId
    }
    func hash(into h: inout Hasher) { h.combine(sessionId) }

    private var now: Date { clock.tick }

    var body: some View {
        Group {
            if let msg = store.forbidden {
                EmptyState(text: msg)
            } else {
                ScreenState(state: store.state,
                            retry: { Task { await store.load(sessionId) } },
                            staleRetry: { Task { await store.refresh(sessionId) } }) { detail in
                    content(detail)
                }
            }
        }
        .background(T.bg)
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: Space.s) {
                    Text(store.state.value?.session.ticker ?? preview?.ticker ?? "VOTE")
                        .font(Type.screenCode)
                        .foregroundStyle(T.white)
                    Text("BALLOT")
                        .font(Type.screenTitle).tracking(0.8)
                        .foregroundStyle(T.white)
                }
            }
        }
        .toolbarBackground(T.redBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task { await store.load(sessionId) }
        .refreshable { await store.refresh(sessionId) }
        // Seeded from the ballot on file so recasting starts where the
        // member left off rather than at an arbitrary midpoint.
        .onChange(of: store.state.value?.myBallot?.investmentAmount, initial: true) { _, new in
            if let new { amount = new }
        }
        .onChange(of: store.state.value?.myBallot?.note, initial: true) { _, new in
            if note.isEmpty, let new { note = new }
        }
    }

    private func content(_ detail: VoteDetail) -> some View {
        let session = detail.session
        let closed = VoteRules.isClosed(session, now: now)
        return ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                deadlineBlock(session, closed: closed)
                caseSection(session)
                if let mine = detail.myBallot { myBallotSection(mine, session: session) }
                ballotSection(detail, closed: closed)
                tallySection(detail, closed: closed)
                notesSection(detail)
                synthesisSection(session)
            }
        }
    }

    // MARK: the clock, said once and prominently

    private func deadlineBlock(_ session: VoteSession, closed: Bool) -> some View {
        let deadline = Fmt.parseISO(session.deadline)
        let left = VoteClock.remaining(until: deadline, now: now)
        return StatBlock(
            label: closed ? "Voting closed" : "Time remaining",
            value: closed ? "Closed" : (left ?? "Closing"),
            caption: closed
                ? "Closed \(Fmt.shortDateTime(session.closedAt ?? session.deadline)). \(VoteRules.kindLabel(session))."
                : "Closes \(Fmt.shortDateTime(session.deadline)). \(VoteRules.kindLabel(session))."
        )
    }

    // MARK: the case

    @ViewBuilder private func caseSection(_ session: VoteSession) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Space.s) {
                if let title = session.title, !title.isEmpty {
                    Text(title)
                        .font(Type.headline)
                        .foregroundStyle(T.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let pitch = session.pitch {
                    Text(pitchLine(pitch))
                        .font(Type.footnote)
                        .foregroundStyle(T.dim)
                        .fixedSize(horizontal: false, vertical: true)
                    if let deck = pitch.slideshowUrl, !deck.isEmpty {
                        // Selectable text rather than a tap target, the
                        // same call this app makes on a contact's email
                        // address: the phone reads, and anything that
                        // leaves the app is a decision the member makes.
                        Text(deck)
                            .font(Type.meta)
                            .foregroundStyle(T.cyan)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if VoteRules.isFixed(session) {
                    Text("The amount is pinned at \(Fmt.money(session.fixedAmount)). Members ratify the figure rather than proposing one.")
                        .font(Type.footnote)
                        .foregroundStyle(T.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(openedLine(session))
                    .font(Type.meta)
                    .foregroundStyle(T.muted)
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .hairline()
        } header: {
            SectionHeader(text: "The case")
        }
    }

    private func pitchLine(_ pitch: VotePitchRef) -> String {
        var s = "Pitched by \(pitch.pitcherName ?? "a member")"
        if let d = pitch.date { s += " on \(Fmt.day(d))" }
        return s + "."
    }

    private func openedLine(_ session: VoteSession) -> String {
        var s = "Opened"
        if let who = session.creator?.name { s += " by \(who)" }
        if let role = session.creator?.role { s += " (\(role))" }
        if let when = session.createdAt { s += " on \(Fmt.day(when))" }
        return s
    }

    // MARK: my ballot

    private func myBallotSection(_ mine: VoteBallot, session: VoteSession) -> some View {
        Section {
            Row(title: VoteRules.label(forWire: mine.action, in: session),
                subtitle: mine.note,
                meta: metaForMine(mine),
                strip: VoteRules.tone(forWire: mine.action)) {
                if let amt = mine.investmentAmount {
                    Text(Fmt.money(amt))
                        .font(Type.value)
                        .foregroundStyle(T.amber)
                }
            }
        } header: {
            SectionHeader(text: "Your ballot")
        }
    }

    private func metaForMine(_ mine: VoteBallot) -> String {
        "Cast \(Fmt.shortDateTime(mine.castAt))"
    }

    // MARK: the two taps

    @ViewBuilder private func ballotSection(_ detail: VoteDetail, closed: Bool) -> some View {
        let session = detail.session
        let choices = VoteRules.choices(for: session)
        Section {
            if closed {
                // Not a disabled button and not an error: a closed vote is
                // a finished thing, and the screen should read that way.
                Text(detail.myBallot == nil
                     ? "This vote is closed. No ballot of yours is on file."
                     : "This vote is closed. Your ballot stands as cast.")
                    .font(Type.footnote)
                    .foregroundStyle(T.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(Space.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: Space.s) {
                    ForEach(choices) { choice in
                        choiceButton(choice)
                    }

                    if let selected = choices.first(where: { $0.id == chosen }),
                       selected.carriesAmount {
                        amountPicker
                    }

                    noteField
                    castButton(detail, choices: choices)

                    if let err = store.castError {
                        // Plain, and it stays until the member acts. The
                        // POST is not retried behind their back.
                        Text(err)
                            .font(Type.footnote)
                            .foregroundStyle(T.negative)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let ok = store.castConfirmation {
                        Text(ok)
                            .font(Type.footnote)
                            .foregroundStyle(T.positive)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Text(detail.myBallot == nil
                         ? "You can change your ballot until the deadline."
                         : "Casting again replaces the ballot on file.")
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(Space.l)
            }
        } header: {
            SectionHeader(text: closed ? "Voting" : "Your vote")
        }
    }

    private func choiceButton(_ choice: VoteChoice) -> some View {
        let selected = chosen == choice.id
        return Button {
            chosen = choice.id
            // A new selection makes the previous refusal or confirmation
            // stale; leaving either up beside a different choice invites
            // reading it as being about this one.
            store.castError = nil
        } label: {
            HStack(spacing: Space.s) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(choice.label.uppercased())
                        .font(Type.chip).tracking(0.8)
                        .foregroundStyle(selected ? choice.tone : T.white)
                    Text(choice.detail)
                        .font(Type.footnote)
                        .foregroundStyle(T.dim)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Space.s)
                if selected { Chip(text: "Chosen", tone: choice.tone, style: .solid) }
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(selected ? T.cardPress : T.card)
            .overlay(Rectangle().strokeBorder(selected ? choice.tone : T.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }

    /// Only ever shown for an average-mode Buy. The presets are the whole
    /// interaction on a phone; the stepper is there for the member who
    /// wants $3,250 and should not have to type into a number field with
    /// one thumb on a bus.
    private var amountPicker: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: 0) {
                ForEach([1500.0, 2500.0, 5000.0, 7500.0, 10000.0], id: \.self) { preset in
                    Button { amount = preset } label: {
                        Text(Fmt.money(preset))
                            .font(Type.chip)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, Space.s)
                            .background(amount == preset ? T.amber : Color.clear)
                            .foregroundStyle(amount == preset ? T.bg : T.dim)
                    }
                    .buttonStyle(.plain)
                }
            }
            .overlay(Rectangle().strokeBorder(T.border, lineWidth: 1))

            Stepper(value: $amount, in: VoteRules.buyMin...VoteRules.buyMax,
                    step: VoteRules.buyStep) {
                HStack {
                    Text("PROPOSED")
                        .font(Type.label).tracking(0.8)
                        .foregroundStyle(T.muted)
                    Spacer(minLength: Space.s)
                    Text(Fmt.money(amount))
                        .font(Type.value)
                        .foregroundStyle(T.amber)
                }
            }
            .tint(T.amber)

            Text("The club's band is \(Fmt.money(VoteRules.buyMin)) to \(Fmt.money(VoteRules.buyMax)). A Buy is a proposal, not the trade: the club commits the average of the Buy ballots.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var noteField: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("NOTE, OPTIONAL")
                .font(Type.label).tracking(0.8)
                .foregroundStyle(T.muted)
            TextField("why", text: $note, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...4)
                .font(Type.body)
                .foregroundStyle(T.white)
                .padding(Space.m)
                .background(T.card)
                // Radius 4 on a text field only, so the selection loupe
                // does not clip. Everything else in this app is square.
                .clipShape(RoundedRectangle(cornerRadius: 4))
            Text("Notes are read by the club and feed the recap written when the vote closes.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func castButton(_ detail: VoteDetail, choices: [VoteChoice]) -> some View {
        let selected = choices.first { $0.id == chosen }
        let ready = selected != nil && !store.casting
        return Button {
            guard let selected else { return }
            Task {
                await store.cast(sessionId: sessionId, choice: selected,
                                 amount: selected.carriesAmount ? amount : nil,
                                 note: note)
            }
        } label: {
            Text(castLabel(detail, selected: selected))
                .font(Type.chip).tracking(0.8)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.m)
                .background(ready ? T.amber : T.card)
                .foregroundStyle(ready ? T.bg : T.muted)
                .overlay(Rectangle().strokeBorder(T.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!ready)
    }

    private func castLabel(_ detail: VoteDetail, selected: VoteChoice?) -> String {
        if store.casting { return "CASTING…" }
        guard let selected else { return "CHOOSE ONE" }
        let verb = detail.myBallot == nil ? "CAST" : "CHANGE TO"
        return "\(verb) \(selected.label.uppercased())"
    }

    // MARK: the tally, weighted honestly

    @ViewBuilder private func tallySection(_ detail: VoteDetail, closed: Bool) -> some View {
        if let tally = detail.tally {
            let session = detail.session
            Section {
                StatBlock(
                    label: closed ? "Final decision" : "If it closed now",
                    // The server computes finalDecision on every read, open
                    // or closed (votes.js:56). Printing it as final on a
                    // live vote would be a claim about a decision the club
                    // has not made.
                    value: VoteRules.label(forWire: tally.finalDecision, in: session),
                    caption: decisionCaption(tally, closed: closed)
                )

                VStack(alignment: .leading, spacing: Space.s) {
                    VStack(spacing: 0) {
                        ForEach(VoteRules.choices(for: session)) { choice in
                            StatLine(
                                label: choice.label,
                                value: weightLine(tally, wire: choice.wire),
                                tone: choice.tone)
                        }
                    }

                    Text(weightingExplainer(tally))
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    if let stats = tally.buyAmountStats {
                        Text(amountLine(stats))
                            .font(Type.footnote)
                            .foregroundStyle(T.dim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T.card)
                .hairline()

                if let leadership = tally.leadershipVotes, !leadership.isEmpty {
                    ForEach(Array(leadership.enumerated()), id: \.offset) { entry in
                        let v = entry.element
                        Row(title: v.name ?? "Unknown",
                            subtitle: v.role,
                            meta: v.investmentAmount.map { "Proposed \(Fmt.money($0))" },
                            strip: VoteRules.tone(forWire: v.action)) {
                            Text(VoteRules.label(forWire: v.action, in: session))
                                .font(Type.value)
                                .foregroundStyle(VoteRules.tone(forWire: v.action))
                        }
                    }
                }
            } header: {
                SectionHeader(
                    text: closed ? "Result" : "Where it stands",
                    trailing: tallyHeaderTrailing(tally))
            }
        }
    }

    private func tallyHeaderTrailing(_ tally: VoteTally) -> String? {
        guard let total = tally.totalWeightedVotes, let max = tally.maxWeightedVotes else {
            return nil
        }
        return "\(total) of \(max) weighted"
    }

    /// The weighted figure and, beside it, the raw headcount it came from.
    /// One without the other is unreadable: 3 weighted votes can be five
    /// members or it can be three officers.
    private func weightLine(_ tally: VoteTally, wire: String) -> String {
        let weight = (tally.weights?.count(forWire: wire)) ?? nil
        let members = (tally.memberCounts?.count(forWire: wire)) ?? nil
        let w = weight.map { String($0) } ?? "—"
        guard let members else { return "\(w) weighted" }
        return "\(w) weighted · \(members) general body"
    }

    private func decisionCaption(_ tally: VoteTally, closed: Bool) -> String {
        var parts: [String] = []
        if tally.isTied == true {
            parts.append("Tied on weight, so it falls to Hold.")
        }
        if tally.generalBodyDecision == nil, (tally.memberTotal ?? 0) > 0 {
            parts.append("The general body is tied, so its bloc contributes nothing and leadership decides alone.")
        }
        parts.append(closed
            ? "This is the decision on file."
            : "Members are still voting, so this can change.")
        return parts.joined(separator: " ")
    }

    private func weightingExplainer(_ tally: VoteTally) -> String {
        let bloc = tally.generalBodyBlocWeight ?? 3
        let eligible = tally.leadershipEligible
        let seats = eligible.map { "\($0) seat\($0 == 1 ? "" : "s")" } ?? "each seat"
        let cast = tally.memberTotal ?? 0
        return "The general body votes as one bloc worth \(bloc), carried by its own majority, from \(cast) ballot\(cast == 1 ? "" : "s"). Each President or CIO carries 1, across \(seats)."
    }

    /// The fixed case is not an average of anything and must not be called
    /// one. votes.js:81-93 synthesises the same struct from the pinned
    /// figure precisely so downstream code does not special-case it; the
    /// `fixed` flag is how the label stays true anyway.
    private func amountLine(_ stats: VoteAmountStats) -> String {
        let n = stats.count ?? 0
        if stats.fixed == true {
            return "Amount pinned at \(Fmt.money(stats.avg)), with \(n) member\(n == 1 ? "" : "s") in support."
        }
        let avg = Fmt.money(stats.avg)
        let lo = Fmt.money(stats.min)
        let hi = Fmt.money(stats.max)
        if lo == hi {
            return "Proposed allocation \(avg), from \(n) Buy ballot\(n == 1 ? "" : "s")."
        }
        return "Proposed allocation averages \(avg) across \(n) Buy ballot\(n == 1 ? "" : "s"), ranging \(lo) to \(hi)."
    }

    // MARK: what people said

    @ViewBuilder private func notesSection(_ detail: VoteDetail) -> some View {
        let session = detail.session
        let withNotes = (detail.ballots ?? []).filter {
            !($0.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if !withNotes.isEmpty {
            Section {
                ForEach(Array(withNotes.enumerated()), id: \.offset) { entry in
                    let b = entry.element
                    Row(title: b.user?.name ?? "A member",
                        subtitle: b.note,
                        meta: "\(VoteRules.label(forWire: b.action, in: session)) · \(Fmt.shortDateTime(b.castAt))",
                        strip: VoteRules.tone(forWire: b.action))
                }
            } header: {
                SectionHeader(text: "Notes", trailing: "\(withNotes.count)")
            }
        }
    }

    @ViewBuilder private func synthesisSection(_ session: VoteSession) -> some View {
        if let text = session.synthesis, !text.isEmpty {
            Section {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(text)
                        .font(Type.body)
                        .foregroundStyle(T.white)
                        .fixedSize(horizontal: false, vertical: true)
                    // Provenance, because this paragraph reads like a
                    // person wrote it and nobody did. The ballots above it
                    // are the record; this is a summary of them.
                    Text("Written by the model from the ballots and their notes when the vote closed.")
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "Recap")
            }
        }
    }
}
