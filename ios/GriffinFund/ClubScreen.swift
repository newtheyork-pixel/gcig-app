import SwiftUI

// The club. Every obligation a member carries that is not outreach.
//
// This is the screen for the newest person in the room, and it is the only
// one built entirely out of routes gated on nothing but `verifyJwt`. Wire
// and Watch sit behind `requireTerminalAccess`, which is Analyst and above,
// so a JuniorAnalyst — the default role for every Google self-signup —
// installs this app and finds most of it is a role gate. Everything here
// answers to them: whether they are presenting, where their pitch request
// got to, when the next meeting is, what their attendance says, and whether
// they still owe the president a review.
//
// Six calls, fired together, each failing on its own. A president-review
// endpoint that 500s must never be the reason somebody does not learn they
// are presenting on Thursday, and that is not a hypothetical: the six live
// in four different route files with four different failure modes. The
// screen fails only when every one of them failed.
//
// Nothing here writes outward. The one write on the screen is
// `POST /pitches/mine/seen/:id`, which is a member dismissing their own
// reminder inside the club's own database.

// MARK: Decodables
//
// Read off the handlers, not guessed, and every field optional — a renamed
// key then decodes to nil and renders an em dash rather than a fabricated
// figure. Nothing conforms to Identifiable: several of these rows carry an
// optional server id, and `Identifiable` on an `Int?` collapses every nil
// row onto one identity in a ForEach. Each has a `key` instead, built so it
// stays unique even when the id is missing.

/// `GET /api/dashboard` — server/src/routes/dashboard.js:148-155.
///
/// Only `upcomingEvents` is read here. It is already the useful shape: the
/// handler merges real events with upcoming pitches, applies
/// `eventAudienceWhere` so advisory-only meetings never reach a member who
/// may not see them, sorts by date and slices to five (dashboard.js:93-113).
private struct ClubDashboard: Decodable {
    let upcomingEvents: [ClubAgendaItem]?
}

/// One row of that merged feed — dashboard.js:94-110.
///
/// `id` is a STRING here and not the database id: the handler namespaces it
/// as "event-12" or "pitch-3" because the two tables share row numbers. That
/// is also what makes it safe to deduplicate against `GET /api/events`
/// below, whose ids are bare integers.
private struct ClubAgendaItem: Decodable {
    let id: String?
    /// "event" or "pitch".
    let kind: String?
    let title: String?
    let date: String?
    let location: String?
}

/// `GET /api/events` — server/src/routes/events.js:34-40.
///
/// The whole Event row, and the one trap on this screen: the handler applies
/// the audience filter but NO date filter, and orders by date DESCENDING.
/// Rendering it as it arrives would put last spring's meetings at the top of
/// a section called Next meeting. Future rows are selected here, in
/// `ClubMeeting.init(event:now:)`.
private struct ClubEventRow: Decodable {
    let id: Int?
    let title: String?
    let date: String?
    let location: String?
}

/// `GET /api/pitches/mine/upcoming` — server/src/routes/pitches.js:482-511.
///
/// The handler returns `{ pitchId, assignedAt, pitch }` where `pitch` is the
/// Pitch row with its presenters flattened to `{ id, name }` user objects.
/// Note what it selects on: `seenAt: null` AND a future date. This list is
/// undismissed assignments, not all of them — which is why the dismiss
/// button below has to be honest about what it does.
private struct ClubAssignment: Decodable {
    let pitchId: Int?
    let assignedAt: String?
    let pitch: ClubPitch?

    var key: String { pitchId.map { "p\($0)" } ?? "a:\(assignedAt ?? "?")" }
}

/// The Pitch row — prisma/schema.prisma:264-279, plus the `presenters` array
/// the handler grafts on at pitches.js:507.
private struct ClubPitch: Decodable {
    let id: Int?
    let ticker: String?
    let pitcherName: String?
    let date: String?
    let location: String?
    let presenters: [ClubPerson]?
}

private struct ClubPerson: Decodable {
    let id: Int?
    let name: String?
}

/// `GET /api/pitch-requests/mine` — server/src/routes/pitchRequests.js:273-280,
/// with the relations named in `pitchRequestInclude()` at :37-44. Columns are
/// prisma/schema.prisma:199-242.
private struct ClubPitchRequest: Decodable {
    let id: Int?
    let ticker: String?
    let companyName: String?
    /// "Pending" | "Approved" | "Declined" — the PitchRequestStatus enum,
    /// schema.prisma:45-49. Compared as strings, never re-ranked here.
    let status: String?
    let proposedDate: String?
    /// Already an "HH:MM" 24h string, validated server-side against the
    /// lunch-block schedule. Rendered as the server wrote it.
    let proposedStartTime: String?
    /// LIBRARY | LOWER_COMMONS | ATHLETIC_COMMONS, an allowlist rather than
    /// an enum so a new room is a code change and not a migration.
    let room: String?
    let presidentDecidedAt: String?
    let presidentDeclineReason: String?
    let pmDecidedAt: String?
    let pmApproved: Bool?
    let pmDeclineReason: String?
    /// Null until the requester dismisses the decision on the website. Nil
    /// on a decided request is what makes the NEW chip below true.
    let requesterSeenAt: String?
    let createdAt: String?
    let president: ClubPerson?
    let pm: ClubPerson?
    let industry: ClubIndustry?

    var key: String { id.map { "r\($0)" } ?? "r:\(ticker ?? "?")\(createdAt ?? "")" }
    var isPending: Bool { status == "Pending" }
    var isDeclined: Bool { status == "Declined" }
    var isApproved: Bool { status == "Approved" }
    /// Decided, and the member has not acknowledged it anywhere yet.
    var isUnseenDecision: Bool { !isPending && requesterSeenAt == nil }
}

private struct ClubIndustry: Decodable {
    let id: Int?
    let name: String?
}

/// `GET /api/pitch-requests/pending-count` — pitchRequests.js:510-529.
///
/// Two different numbers and they must not be added together. `count` is the
/// queue waiting on THIS member's decision, and is zero for anyone below
/// PortfolioManager. `mineUnseen` is their own decided requests they have
/// not dismissed — already visible as rows, so only `count` is rendered.
private struct ClubRequestCounts: Decodable {
    let count: Int?
    let mineUnseen: Int?
}

/// `GET /api/attendance/mine` — server/src/routes/attendance.js:194-217.
///
/// `exempt: true` is its own payload, returned early at :197-206 for advisory
/// roles and Chief of Communication, with `percentage: null`. It exists
/// precisely so those members do not get a 0% card, and honouring that is
/// the whole reason this decodable carries the flag.
private struct ClubAttendance: Decodable {
    let exempt: Bool?
    let records: [ClubAttendanceRecord]?
    let total: Int?
    let present: Int?
    let excused: Int?
    /// 0-100, rounded server-side. Read carefully: attendance.js:215 returns
    /// 0 when `total` is 0, so a member with no meetings marked yet and a
    /// member who missed everything are the same number. `hasRecord` below
    /// is what keeps the screen from printing the first as the second.
    let percentage: Double?

    var isExempt: Bool { exempt == true }
    var hasRecord: Bool { (total ?? 0) > 0 }
}

/// One marked meeting. `event` is the trimmed `{ id, title, date }` select at
/// attendance.js:209.
private struct ClubAttendanceRecord: Decodable {
    /// "Present" | "Absent" | "Excused" — schema.prisma:33-37.
    let status: String?
    let event: ClubAttendanceEvent?

    /// Unique without the row id: the table has a unique key on
    /// (userId, eventId), so one member has at most one row per event.
    var key: String { "e\(event?.id ?? -1)" }
}

private struct ClubAttendanceEvent: Decodable {
    let id: Int?
    let title: String?
    let date: String?
}

/// `GET /api/president-review/status` — server/src/routes/presidentReview.js:79-109.
///
/// `pending` is the roster of presidents this member has not reviewed this
/// cycle, with themselves already removed server-side (:83) because there is
/// no self-review. `cycle` is the academic year, "2025-2026".
private struct ClubReviewStatus: Decodable {
    let cycle: String?
    let totalPresidents: Int?
    let completedCount: Int?
    let pending: [ClubPerson]?
}

/// Every write on this screen answers `{ ok: true }` — pitches.js:520.
private struct ClubAck: Decodable {
    let ok: Bool?
}

// MARK: The desk

/// One meeting, from either source, normalised.
///
/// A row whose date will not parse is dropped rather than kept with a nil
/// date: an unsortable row floats to whichever end of the list the comparator
/// happens to put it, and under a header reading "Next meeting" that is a
/// claim about when the club is meeting. Prisma always writes an ISO
/// timestamp, so this drops nothing in practice and lies in none.
private struct ClubMeeting {
    let key: String
    let title: String
    let location: String?
    /// Parsed, for sorting and for the countdown.
    let at: Date
    /// The server's own string, kept alongside the Date so rendering goes
    /// through `Fmt.shortDateTime` like every other timestamp in the app.
    /// Re-serialising `at` to feed it back to Fmt would work and would also
    /// be a second date format living in a view file.
    let iso: String?
    let isPitch: Bool

    init?(agenda a: ClubAgendaItem) {
        guard let at = Fmt.parseISO(a.date) else { return nil }
        // The handler's namespaced id ("event-12" / "pitch-3") is the
        // deduplication key against the plain-integer ids from /events.
        self.key = a.id ?? "agenda:\(a.title ?? "?")\(a.date ?? "")"
        self.title = a.title ?? "Untitled"
        self.location = a.location
        self.at = at
        self.iso = a.date
        self.isPitch = a.kind == "pitch"
    }

    init?(event e: ClubEventRow, now: Date) {
        guard let at = Fmt.parseISO(e.date), at >= now else { return nil }
        self.key = e.id.map { "event-\($0)" } ?? "event:\(e.title ?? "?")\(e.date ?? "")"
        self.title = e.title ?? "Untitled"
        self.location = e.location
        self.at = at
        self.iso = e.date
        self.isPitch = false
    }
}

/// What one of the six calls came back with.
///
/// A section that is empty and a section whose call failed look identical on
/// screen unless something remembers the difference, and "you have no pitch
/// requests" is a sentence this app must not print about a request it could
/// not read.
private enum ClubFetch<T> {
    case ok(T)
    /// A 403. Rendered as one quiet sentence, never as COULD NOT LOAD over a
    /// RETRY that cannot succeed.
    case denied(String)
    case failed(String)
    /// The member left the screen. Not a failure, and never shown as one.
    case cancelled

    var value: T? {
        if case .ok(let v) = self { return v }
        return nil
    }
    var arrived: Bool {
        if case .ok = self { return true }
        return false
    }
    var isCancelled: Bool {
        if case .cancelled = self { return true }
        return false
    }
    /// The one line to print in place of the section, or nil if there is
    /// nothing to apologise for.
    var problem: String? {
        switch self {
        case .ok, .cancelled:                     return nil
        case .denied(let m), .failed(let m):      return m
        }
    }
}

/// Everything the screen renders, with each part carrying its own verdict.
private struct ClubDesk {
    var presenting: ClubFetch<[ClubAssignment]>
    var requests: ClubFetch<[ClubPitchRequest]>
    var counts: ClubFetch<ClubRequestCounts>
    var meetings: ClubFetch<[ClubMeeting]>
    var attendance: ClubFetch<ClubAttendance>
    var review: ClubFetch<ClubReviewStatus>

    var anyArrived: Bool {
        presenting.arrived || requests.arrived || counts.arrived
            || meetings.arrived || attendance.arrived || review.arrived
    }
    var anyCancelled: Bool {
        presenting.isCancelled || requests.isCancelled || counts.isCancelled
            || meetings.isCancelled || attendance.isCancelled || review.isCancelled
    }
    var firstProblem: String? {
        [presenting.problem, requests.problem, counts.problem,
         meetings.problem, attendance.problem, review.problem]
            .compactMap { $0 }.first
    }

    /// Nothing owed and nothing hidden behind a failure. This is the good
    /// news case, and it has to be sure of itself: a screen that says "you
    /// are all clear" while one of its six calls quietly 500'd is worse than
    /// one that says nothing at all.
    var isQuiet: Bool {
        guard firstProblem == nil else { return false }
        return (presenting.value ?? []).isEmpty
            && (requests.value ?? []).isEmpty
            && (counts.value?.count ?? 0) == 0
            && (meetings.value ?? []).isEmpty
            && !(attendance.value?.hasRecord ?? false)
            && !(attendance.value?.isExempt ?? false)
            && (review.value?.pending ?? []).isEmpty
    }
}

/// How far off something is, in the reader's own calendar.
///
/// Not a Fmt entry because it formats no figure: it turns two dates into an
/// English phrase, and putting it in Fmt would invite the next screen to
/// invent a second one. Day boundaries come from `Calendar.current`, so a
/// meeting at 8pm tonight reads "Today" and one at 8am tomorrow reads
/// "Tomorrow" — subtracting timestamps would call both "in 12 hours".
private enum ClubWhen {
    static func days(until date: Date, now: Date = Date()) -> Int? {
        let cal = Calendar.current
        return cal.dateComponents([.day],
                                  from: cal.startOfDay(for: now),
                                  to: cal.startOfDay(for: date)).day
    }

    static func phrase(until date: Date, now: Date = Date()) -> String {
        guard let d = days(until: date, now: now) else { return "Scheduled" }
        switch d {
        case ..<0: return "Passed"
        case 0:    return "Today"
        case 1:    return "Tomorrow"
        default:   return "In \(d) days"
        }
    }

    /// Two days out is when a pitch stops being a plan and starts being a
    /// deadline. Only that turns the row red.
    static func isImminent(_ date: Date, now: Date = Date()) -> Bool {
        guard let d = days(until: date, now: now) else { return false }
        return d <= 2
    }
}

/// The room allowlist, server/src/lib/lunchSlots.js:27-31.
///
/// The server's own labels carry a parenthetical ("Library (near smart board
/// / printers)") written for a desktop form. The short form is used here
/// because the phone renders it inside a row subtitle, and an unrecognised
/// code is returned unchanged rather than dashed — same rule as `Fmt.day`.
private func clubRoomLabel(_ raw: String?) -> String? {
    guard let raw, !raw.isEmpty else { return nil }
    switch raw {
    case "LIBRARY":          return "Library"
    case "LOWER_COMMONS":    return "Lower Commons"
    case "ATHLETIC_COMMONS": return "Athletic Commons"
    default:                 return raw
    }
}

// MARK: Store

@MainActor
private final class ClubStore: ObservableObject {
    @Published private(set) var state: Loadable<ClubDesk> = .loading
    /// Pitch ids with a dismiss in flight, so the button can go quiet
    /// without the whole screen reloading.
    @Published private(set) var dismissing: Set<Int> = []
    /// A failed dismiss says so next to the row it failed on. It is a write,
    /// so it is never retried automatically — the member decides.
    @Published private(set) var dismissProblem: String?

    private var lastLoad: Date?

    func load() async {
        state = .loading
        await fetch(keepingOldOnFailure: false)
    }

    /// Pull-to-refresh, the stale strip's retry, and foregrounding. Keeps the
    /// old desk on failure: somebody who pulled to refresh still wants to see
    /// that they are presenting on Thursday.
    func refresh() async {
        await fetch(keepingOldOnFailure: true)
    }

    func refreshIfStale(after seconds: TimeInterval = 300) async {
        if case .loading = state { return }
        guard let last = lastLoad, Date().timeIntervalSince(last) > seconds else { return }
        await refresh()
    }

    private func fetch(keepingOldOnFailure keepOld: Bool) async {
        let previous = state.value

        // Six requests in flight together. Serially this is six round trips
        // to a free-tier dyno that may be waking up, which on a cold morning
        // is the difference between a screen and a spinner.
        async let presenting = loadPresenting()
        async let requests = loadRequests()
        async let counts = loadCounts()
        async let meetings = loadMeetings()
        async let attendance = loadAttendance()
        async let review = loadReview()

        let desk = ClubDesk(presenting: await presenting,
                            requests: await requests,
                            counts: await counts,
                            meetings: await meetings,
                            attendance: await attendance,
                            review: await review)

        // Nothing arrived and something was cancelled: the member walked off
        // the screen mid-load. Say nothing, change nothing.
        if !desk.anyArrived && desk.anyCancelled { return }

        if desk.anyArrived {
            lastLoad = Date()
            state = .loaded(desk, at: Date())
            return
        }

        // Every one of the six failed. Only now is this a broken screen
        // rather than a thin one.
        let msg = desk.firstProblem ?? "The club data did not load."
        if keepOld, let previous {
            state = .stale(previous, msg)
        } else {
            state = .failed(msg)
        }
    }

    /// One request, with the three outcomes that are not failures kept
    /// separate from the one that is. Cancellation is caught first and on its
    /// own, before anything can dress it up as an error.
    private func attempt<T: Decodable>(_ path: String,
                                       as type: T.Type,
                                       denied: String) async -> ClubFetch<T> {
        do {
            return .ok(try await API.shared.get(path, as: type))
        } catch APIError.cancelled {
            return .cancelled
        } catch APIError.forbidden {
            // Our own gate, described as our own gate. Never "you have no
            // pitch requests" for a list we were refused.
            return .denied(denied)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func loadPresenting() async -> ClubFetch<[ClubAssignment]> {
        let r = await attempt("/pitches/mine/upcoming", as: [ClubAssignment].self,
                              denied: "Pitch assignments need a club role.")
        guard case .ok(let rows) = r else { return r }
        // The server orders these by `assignedAt desc` — by when you were
        // told. A screen about what is owed soonest orders by when it is due.
        let sorted = rows.sorted {
            let a = Fmt.parseISO($0.pitch?.date) ?? .distantFuture
            let b = Fmt.parseISO($1.pitch?.date) ?? .distantFuture
            return a < b
        }
        return .ok(sorted)
    }

    private func loadRequests() async -> ClubFetch<[ClubPitchRequest]> {
        let r = await attempt("/pitch-requests/mine", as: [ClubPitchRequest].self,
                              denied: "Pitch requests need a club role.")
        guard case .ok(let rows) = r else { return r }
        // Server order is newest first, which is right within a group. What
        // it cannot know is that a request still waiting on the President is
        // an open obligation and a decided one is a record, so pending rises.
        let sorted = rows.enumerated().sorted { a, b in
            if a.element.isPending != b.element.isPending { return a.element.isPending }
            return a.offset < b.offset
        }.map(\.element)
        return .ok(sorted)
    }

    private func loadCounts() async -> ClubFetch<ClubRequestCounts> {
        await attempt("/pitch-requests/pending-count", as: ClubRequestCounts.self,
                      denied: "The decision queue is not open to this role.")
    }

    private func loadAttendance() async -> ClubFetch<ClubAttendance> {
        await attempt("/attendance/mine", as: ClubAttendance.self,
                      denied: "Your attendance record is not readable here.")
    }

    private func loadReview() async -> ClubFetch<ClubReviewStatus> {
        await attempt("/president-review/status", as: ClubReviewStatus.self,
                      denied: "The president review is not open to this role.")
    }

    /// The meeting list is two sources on purpose.
    ///
    /// `/dashboard` gives the merged, audience-filtered, thirty-day feed with
    /// pitches folded in, which is the better answer. `/events` gives every
    /// scheduled event with no lookahead cap. Either alone is a usable Next
    /// meeting section, so the two are raced and merged: the dashboard's
    /// namespaced ids ("event-12") make deduplication exact, and the section
    /// survives whichever of the two is having a bad minute.
    private func loadMeetings() async -> ClubFetch<[ClubMeeting]> {
        async let dashCall = attempt("/dashboard", as: ClubDashboard.self,
                                     denied: "The dashboard is not open to this role.")
        async let eventsCall = attempt("/events", as: [ClubEventRow].self,
                                       denied: "The calendar is not open to this role.")
        let dash = await dashCall
        let events = await eventsCall

        if !dash.arrived && !events.arrived {
            if dash.isCancelled || events.isCancelled { return .cancelled }
            return .failed(dash.problem ?? events.problem ?? "The calendar did not load.")
        }

        let now = Date()
        var out: [ClubMeeting] = []
        var seen = Set<String>()
        for item in dash.value?.upcomingEvents ?? [] {
            guard let m = ClubMeeting(agenda: item) else { continue }
            if seen.insert(m.key).inserted { out.append(m) }
        }
        for row in events.value ?? [] {
            guard let m = ClubMeeting(event: row, now: now) else { continue }
            if seen.insert(m.key).inserted { out.append(m) }
        }
        out.sort { $0.at < $1.at }
        return .ok(out)
    }

    // MARK: the one write

    /// Dismiss a presenting reminder.
    ///
    /// This is destructive in a way the button has to admit: the handler
    /// stamps `seenAt` (pitches.js:514-521) and `/mine/upcoming` selects on
    /// `seenAt: null`, so the row does not come back. The pitch still stands;
    /// only the reminder goes. Never retried — writes are not idempotent to a
    /// member watching a row vanish twice.
    func markSeen(pitchId: Int) async {
        dismissProblem = nil
        dismissing.insert(pitchId)
        defer { dismissing.remove(pitchId) }
        do {
            _ = try await API.shared.post("/pitches/mine/seen/\(pitchId)",
                                          body: [:], as: ClubAck.self)
            drop(pitchId: pitchId)
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden {
            dismissProblem = "This reminder is not yours to dismiss."
        } catch {
            dismissProblem = "The reminder is still there. \(error.localizedDescription)"
        }
    }

    /// Remove the row locally rather than refetching the whole desk for one
    /// dismissed reminder. The timestamp on `.loaded` is preserved: this
    /// changed one row, it did not make the other five sections newer.
    private func drop(pitchId: Int) {
        guard var desk = state.value, case .ok(let rows) = desk.presenting else { return }
        desk.presenting = .ok(rows.filter { $0.pitchId != pitchId })
        switch state {
        case .loaded(_, let at): state = .loaded(desk, at: at)
        case .stale(_, let msg): state = .stale(desk, msg)
        case .loading, .failed:  break
        }
    }
}

// MARK: Screen

/// What the club is owed from you, soonest first.
///
/// The order is the argument: presenting, then your own requests, then the
/// next meeting, then your attendance, then the review. It runs from what
/// you must do this week down to what you should know about yourself, and
/// nothing on it is a market fact.
///
/// Deliberately absent, because they are desk work and belong on the Mac:
/// the roster, marking anybody else's attendance, and creating events.
struct ClubScreen: View {
    @StateObject private var store = ClubStore()
    /// Drives the clock-based stale strip; see StaleClock.
    @ObservedObject private var clock = StaleClock.shared

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "CLUB", title: "What you owe")
            // Thirty minutes rather than the book's ten. These are calendar
            // facts, not prices: a meeting time does not move minute to
            // minute, and crying stale over a schedule teaches people to
            // ignore the strip on the screen where it means money.
            ScreenState(state: store.state.aged(after: 1800, now: clock.tick),
                        emptyWhen: { $0.isQuiet },
                        emptyText: "Nothing owed. No pitch to present, no request waiting on a decision, no review outstanding.",
                        emptyIsGood: true,
                        retry: { Task { await store.load() } },
                        staleRetry: { Task { await store.refresh() } }) { desk in
                content(desk)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .task { if store.state.value == nil { await store.load() } }
        .task { await store.refreshIfStale() }
        .refreshOnForeground(after: 120) { await store.refreshIfStale(after: 120) }
    }

    private func content(_ desk: ClubDesk) -> some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                presentingSection(desk)
                requestsSection(desk)
                meetingSection(desk)
                attendanceSection(desk)
                reviewSection(desk)
                Spacer().frame(height: Space.xl)
            }
        }
        .refreshable { await store.refresh() }
    }

    // MARK: You are presenting

    /// A section renders when it has something to say OR when its call
    /// failed. The second half matters as much as the first: a header that
    /// silently disappears because the request 500'd tells the member they
    /// have no pitch, which is the one thing this screen exists to tell them
    /// correctly.
    @ViewBuilder private func presentingSection(_ desk: ClubDesk) -> some View {
        let rows = desk.presenting.value ?? []
        if !rows.isEmpty || desk.presenting.problem != nil {
            Section {
                if let problem = desk.presenting.problem {
                    note(problem)
                } else {
                    ForEach(rows, id: \.key) { row in
                        presentingRow(row)
                    }
                    if let msg = store.dismissProblem {
                        note(msg)
                    }
                }
            } header: {
                SectionHeader(text: "You are presenting",
                              trailing: rows.isEmpty ? nil : "\(rows.count)")
            }
        }
    }

    @ViewBuilder private func presentingRow(_ row: ClubAssignment) -> some View {
        let at = Fmt.parseISO(row.pitch?.date)
        let imminent = at.map { ClubWhen.isImminent($0, now: clock.tick) } ?? false
        let others = (row.pitch?.presenters ?? [])
            .compactMap(\.name)
            .filter { !$0.isEmpty }

        VStack(spacing: 0) {
            Row(title: "\(row.pitch?.ticker ?? "—") pitch",
                subtitle: presentingSubtitle(row, others: others),
                meta: row.pitch?.location.map { "Room \($0)" },
                strip: imminent ? T.negative : T.amber) {
                VStack(alignment: .trailing, spacing: Space.xs) {
                    Text(Fmt.shortDateTime(row.pitch?.date))
                        .font(Type.value)
                        .foregroundStyle(T.white)
                    if let at {
                        Chip(text: ClubWhen.phrase(until: at, now: clock.tick),
                             tone: imminent ? T.negative : T.amber,
                             style: .solid)
                    }
                }
            }
            // The dismiss sits OUTSIDE the Row rather than in its trailing
            // slot, and not for layout. Row combines its children into one
            // accessibility element, which is right for a row of data and
            // would swallow a button whole — VoiceOver would read the pitch
            // and offer no way to act on it.
            if let id = row.pitchId {
                dismissBar(pitchId: id)
            }
        }
    }

    private func presentingSubtitle(_ row: ClubAssignment, others: [String]) -> String? {
        if others.count > 1 {
            return "With \(others.joined(separator: ", "))."
        }
        if let named = row.pitch?.pitcherName, !named.isEmpty, others.isEmpty {
            return "Listed as \(named)."
        }
        return nil
    }

    /// Named for what it does to the server rather than for how it feels.
    /// "Got it" would be a lie: the handler stamps seenAt and the row is
    /// gone from this list for good.
    @ViewBuilder private func dismissBar(pitchId: Int) -> some View {
        HStack(spacing: Space.s) {
            Text("Stops the reminder. The pitch still stands.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
            Spacer(minLength: Space.s)
            if store.dismissing.contains(pitchId) {
                ProgressView().tint(T.amber).frame(minWidth: 44, minHeight: 44)
            } else {
                Button("DISMISS") { Task { await store.markSeen(pitchId: pitchId) } }
                    .buttonStyle(GriffinButtonStyle())
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.bg)
        .hairline()
    }

    // MARK: Your pitch requests

    @ViewBuilder private func requestsSection(_ desk: ClubDesk) -> some View {
        let rows = desk.requests.value ?? []
        let queue = desk.counts.value?.count ?? 0
        if !rows.isEmpty || queue > 0 || desk.requests.problem != nil {
            Section {
                if let problem = desk.requests.problem {
                    note(problem)
                } else {
                    ForEach(rows, id: \.key) { row in
                        requestRow(row)
                    }
                }
                // Only PMs and the President ever see a non-zero queue
                // (pitchRequests.js:511-519), so this line simply does not
                // exist for most members. Deciding is desk work; the phone
                // says the queue is there and stops.
                if queue > 0 {
                    Row(title: "\(queue) request\(queue == 1 ? "" : "s") waiting on you",
                        subtitle: "Approve or decline on the terminal.",
                        strip: T.amber)
                }
            } header: {
                SectionHeader(text: "Your pitch requests",
                              trailing: rows.isEmpty ? nil : "\(rows.count)")
            }
        }
    }

    @ViewBuilder private func requestRow(_ r: ClubPitchRequest) -> some View {
        Row(title: [r.ticker, r.companyName].compactMap { $0 }.first ?? "—",
            subtitle: requestSubtitle(r),
            meta: requestMeta(r),
            strip: r.isPending ? T.amber : nil) {
            VStack(alignment: .trailing, spacing: Space.xs) {
                Chip(text: r.status ?? "—", tone: statusTone(r), style: .quiet)
                if r.isUnseenDecision {
                    Chip(text: "New", tone: T.cyan, style: .solid)
                }
            }
        }
    }

    private func statusTone(_ r: ClubPitchRequest) -> Color {
        if r.isApproved { return T.positive }
        if r.isDeclined { return T.negative }
        return T.amber
    }

    /// What actually happened to the request, in the order a person asks it:
    /// a decline is a reason, an approval is a time and a place, and pending
    /// is who is sitting on it.
    private func requestSubtitle(_ r: ClubPitchRequest) -> String? {
        if r.isDeclined {
            let reason = [r.presidentDeclineReason, r.pmDeclineReason]
                .compactMap { $0 }
                .first { !$0.isEmpty }
            return reason ?? "No reason was recorded."
        }
        if r.isApproved {
            let when = [r.proposedDate.map { Fmt.day($0) }, r.proposedStartTime]
                .compactMap { $0 }
                .joined(separator: " at ")
            let place = clubRoomLabel(r.room)
            let parts = [when.isEmpty ? nil : when, place].compactMap { $0 }
            return parts.isEmpty ? "Approved. No time set yet." : parts.joined(separator: " · ")
        }
        if let president = r.president?.name, !president.isEmpty {
            return "With \(president)."
        }
        return "Waiting on the President."
    }

    /// The PM's read is informational — pitchRequests.js:297-299 is explicit
    /// that the President is the gating role — so it belongs on the meta line
    /// under the decision, never beside it where it could read as the answer.
    private func requestMeta(_ r: ClubPitchRequest) -> String? {
        var bits: [String] = []
        // Once it is decided, the date that matters is the decision's, not
        // the submission's — a request sent in March and answered last week
        // reads as three weeks of silence if only the first is shown.
        if let decided = r.presidentDecidedAt, !r.isPending {
            bits.append("Decided \(Fmt.day(decided))")
        } else if let sent = r.createdAt {
            bits.append("Sent \(Fmt.day(sent))")
        }
        if let pod = r.industry?.name, !pod.isEmpty { bits.append(pod) }
        if r.pmDecidedAt != nil, let approved = r.pmApproved {
            let who = r.pm?.name ?? "PM"
            bits.append(approved ? "\(who) backed it" : "\(who) did not")
        }
        return bits.isEmpty ? nil : bits.joined(separator: " · ")
    }

    // MARK: Next meeting

    @ViewBuilder private func meetingSection(_ desk: ClubDesk) -> some View {
        let all = desk.meetings.value ?? []
        if !all.isEmpty || desk.meetings.problem != nil {
            Section {
                if let problem = desk.meetings.problem {
                    note(problem)
                } else if let next = all.first {
                    meetingRow(next)
                    if all.count > 1 {
                        note("\(all.count - 1) more on the calendar.")
                    }
                }
            } header: {
                SectionHeader(text: "Next meeting")
            }
        }
    }

    @ViewBuilder private func meetingRow(_ m: ClubMeeting) -> some View {
        Row(title: m.title,
            subtitle: m.location,
            meta: nil,
            strip: ClubWhen.isImminent(m.at, now: clock.tick) ? T.amber : nil) {
            VStack(alignment: .trailing, spacing: Space.xs) {
                Text(Fmt.shortDateTime(m.iso))
                    .font(Type.value)
                    .foregroundStyle(T.white)
                Chip(text: m.isPitch ? "Pitch" : ClubWhen.phrase(until: m.at, now: clock.tick),
                     tone: m.isPitch ? T.amber : T.muted,
                     style: .quiet)
            }
        }
    }

    // MARK: Attendance

    @ViewBuilder private func attendanceSection(_ desk: ClubDesk) -> some View {
        if let problem = desk.attendance.problem {
            Section {
                note(problem)
            } header: {
                SectionHeader(text: "Attendance")
            }
        } else if let a = desk.attendance.value, a.isExempt {
            // The server returns this shape specifically so an exempt member
            // does not get a 0% card (attendance.js:195-206). Honour it, or
            // the phone reinvents the bug the API already fixed.
            Section {
                note("Your role is not counted in attendance.")
            } header: {
                SectionHeader(text: "Attendance")
            }
        } else if let a = desk.attendance.value, a.hasRecord {
            Section {
                VStack(spacing: 0) {
                    // Present and excused both count toward the percentage
                    // server-side (attendance.js:215), so they are shown
                    // together rather than left for the member to add up and
                    // disagree with us.
                    StatLine(label: "COUNTED",
                             value: Fmt.pct(a.percentage, decimals: 0, signed: false),
                             tone: attendanceTone(a.percentage))
                    StatLine(label: "PRESENT", value: "\(a.present ?? 0) of \(a.total ?? 0)")
                    StatLine(label: "EXCUSED", value: "\(a.excused ?? 0)")
                }
                .padding(.horizontal, Space.l)
                .padding(.vertical, Space.s)
                .background(T.card)
                .hairline()

                ForEach(missedRecords(a), id: \.key) { r in
                    Row(title: r.event?.title ?? "Meeting",
                        subtitle: nil,
                        meta: Fmt.day(r.event?.date),
                        strip: T.negative) {
                        Chip(text: r.status ?? "—", tone: T.negative, style: .quiet)
                    }
                }
            } header: {
                SectionHeader(text: "Attendance", trailing: "\(a.total ?? 0) marked")
            }
        }
        // No record and not exempt: nothing has been marked yet, which is not
        // a 0% attendance record and must never be drawn as one. The section
        // simply does not exist.
    }

    /// The meetings actually missed, newest first — the server already orders
    /// records by event date descending (attendance.js:210), so this preserves
    /// its order rather than imposing another. Capped at four: this is a
    /// nudge, not a disciplinary file.
    private func missedRecords(_ a: ClubAttendance) -> [ClubAttendanceRecord] {
        Array((a.records ?? []).filter { $0.status == "Absent" }.prefix(4))
    }

    /// Green only where it is earned. Anything below three quarters is a fact
    /// the member should act on, and colouring it neutral would hide it.
    private func attendanceTone(_ pct: Double?) -> Color {
        guard let pct else { return T.white }
        if pct >= 90 { return T.positive }
        if pct < 75 { return T.negative }
        return T.white
    }

    // MARK: Review owed

    @ViewBuilder private func reviewSection(_ desk: ClubDesk) -> some View {
        let pending = desk.review.value?.pending ?? []
        if !pending.isEmpty || desk.review.problem != nil {
            Section {
                if let problem = desk.review.problem {
                    note(problem)
                } else {
                    ForEach(Array(pending.enumerated()), id: \.offset) { _, p in
                        Row(title: "Review \(p.name ?? "the President")",
                            subtitle: "Four statements and an optional comment.",
                            meta: desk.review.value?.cycle,
                            strip: T.amber)
                    }
                    // The form itself stays on the website. Rating a person
                    // is a considered thing and the ballot is a real write;
                    // the phone's job here is to make sure nobody forgets it
                    // exists, not to collect it in a queue at a bus stop.
                    note("The form is on the website, under President Review.")
                }
            } header: {
                SectionHeader(text: "Review owed", trailing: reviewProgress(desk))
            }
        }
    }

    /// "1 of 2" rather than a bare count of what is left, because the
    /// denominator is the reassuring half: a member part-way through a
    /// four-president year should see that they are part-way through.
    private func reviewProgress(_ desk: ClubDesk) -> String? {
        guard let s = desk.review.value,
              let total = s.totalPresidents, total > 0,
              let done = s.completedCount else { return nil }
        return "\(done) of \(total)"
    }

    // MARK: pieces

    /// One quiet sentence where a section's content would have been. Not
    /// ErrorState: that is a full-screen failure with a RETRY, and a screen
    /// with five other working sections has not failed.
    private func note(_ text: String) -> some View {
        Text(text)
            .font(Type.footnote)
            .foregroundStyle(T.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .hairline()
    }
}
