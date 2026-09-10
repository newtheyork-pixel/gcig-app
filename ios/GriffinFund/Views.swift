import SwiftUI

// The phone is not the terminal and must not pretend to be.
//
// Bloomberg's own mobile app does not ship Launchpad; it ships news,
// messages, market data and alerts, and lets the dense multi-panel grid
// stay on the desk. The same logic applies here: a six-inch screen holds a
// reader and an alerter. Anything with columns belongs on the Mac.

struct RootView: View {
    @EnvironmentObject var s: Session
    var body: some View {
        Group {
            if s.token == nil { LoginView() } else { MainTabs() }
        }
        .preferredColorScheme(.dark)
        .onOpenURL { url in
            // griffin-terminal://auth?code=… coming back from Safari.
            //
            // The host is checked as well as the scheme. A custom scheme is
            // not exclusive on iOS, so this path deserves tightening to
            // ASWebAuthenticationSession over a Universal Link; until then
            // the least this can do is refuse links it does not recognise.
            guard url.scheme == "griffin-terminal", url.host == "auth",
                  let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                      .queryItems?.first(where: { $0.name == "code" })?.value,
                  !code.isEmpty
            else { return }
            Task { await s.exchange(code: code) }
        }
        // Who is holding the phone, asked at launch and again whenever the
        // app comes back. A role can change between sessions, and a stale
        // answer is how somebody keeps looking at a surface that was taken
        // away from them.
        .task { await s.refreshIdentity() }
        .refreshOnForeground(after: 300) { await s.refreshIdentity() }
    }
}

struct LoginView: View {
    @EnvironmentObject var s: Session
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    var body: some View {
        ZStack {
            T.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Space.m) {
                    Spacer().frame(height: 40)
                    Text("THE GRIFFIN FUND")
                        .font(Font.data(18, .bold)).tracking(1.5).foregroundStyle(T.amber)
                    Text("Grace Church School")
                        .font(Type.footnote).foregroundStyle(T.dim)
                    Spacer().frame(height: Space.m)

                    // The browser route is first because it is the one that
                    // works for everybody: Google, two-factor and password
                    // all happen on a page that already handles them.
                    Link(destination: Session.handoffURL) {
                        Text("SIGN IN WITH BROWSER")
                            .font(Type.chip).tracking(0.8)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(T.amber).foregroundStyle(T.bg)
                    }
                    Text("Opens the website. Works with Google and two-factor.")
                        .font(Type.meta).foregroundStyle(T.muted)

                    HStack(spacing: Space.s) {
                        Rectangle().fill(T.border).frame(height: 1)
                        Text("OR").font(Type.chip).foregroundStyle(T.muted)
                        Rectangle().fill(T.border).frame(height: 1)
                    }
                    .padding(.vertical, Space.s)

                    TextField("school email", text: $email)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.emailAddress).textContentType(.username)
                        .focused($focus, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                        .padding(Space.m).background(T.card)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                    SecureField("password", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { signIn() }
                        .padding(Space.m).background(T.card)
                        .clipShape(RoundedRectangle(cornerRadius: 4))

                    if let e = s.error {
                        Text(e).font(Type.footnote).foregroundStyle(T.negative)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button(action: signIn) {
                        Text(s.busy ? "SIGNING IN…" : "SIGN IN WITH PASSWORD")
                            .font(Type.chip).tracking(0.5)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(T.card).foregroundStyle(T.white)
                            .overlay(Rectangle().strokeBorder(T.border, lineWidth: 1))
                    }
                    .disabled(s.busy || email.isEmpty || password.isEmpty)
                    Spacer()
                }
                .textFieldStyle(.plain)
                .font(Type.body).foregroundStyle(T.white)
                .padding(Space.l)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func signIn() {
        guard !email.isEmpty, !password.isEmpty else { return }
        focus = nil
        Task { await s.logIn(email: email, password: password) }
    }
}

/// Where the phone can go that is not a tab.
///
/// Five surfaces is the tab bar's honest limit — iOS folds a sixth into a
/// "More" list, which is where features go to be forgotten. So the screens
/// that are answered rather than browsed reach the member through Today,
/// which is the screen they open first and the only one that knows what is
/// owed.
enum Route: Hashable {
    case ballots, alerts, club, performance, search
}

@MainActor
@ViewBuilder func routeView(_ r: Route) -> some View {
    switch r {
    case .ballots:     VoteScreen()
    case .alerts:      AlertsScreen()
    case .club:        ClubScreen()
    case .performance: PerformanceScreen()
    case .search:      SearchScreen()
    }
}

struct MainTabs: View {
    @EnvironmentObject var s: Session

    /// Wire and Watch both sit behind `requireTerminalAccess`, which is
    /// Analyst and above. JuniorAnalyst is one rank below it and is the
    /// DEFAULT role for every self-signup, so the newest members of the club
    /// installed this app and found two of five tabs were full-screen red
    /// errors with a RETRY that could never succeed. The server gate is
    /// right and deliberate; what was missing was the client half of it —
    /// CLAUDE.md says in as many words that the two must move together.
    ///
    /// Nil means "we have not asked yet", and the tabs stay up through it:
    /// a slow identity call must not read as a demotion.
    private var showsTerminal: Bool { s.terminalAccess != false }

    var body: some View {
        // Today first because the phone is the interrupt device and this
        // is the only screen that knows who you are. Club last: lowest
        // frequency, but without it sign-out squats in another screen's
        // toolbar and cannot be reached from most of the app.
        TabView {
            NavigationStack { TodayScreen() }
                .tabItem { Label("Today", systemImage: "checklist") }
            if showsTerminal {
                NavigationStack { NewsScreen() }
                    .tabItem { Label("Wire", systemImage: "newspaper") }
                NavigationStack { WatchScreen() }
                    .tabItem { Label("Watch", systemImage: "eye") }
            }
            NavigationStack { BookScreen() }
                .tabItem { Label("Book", systemImage: "chart.pie") }
            NavigationStack { AccountScreen() }
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .tint(T.amber)
        .toolbarBackground(T.bg, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }
}

// MARK: Today

@MainActor
final class TodayStore: ObservableObject {
    @Published private(set) var state: Loadable<FollowUps> = .loading
    /// The three below are context, not the subject, so each fails
    /// silently. A summary the model could not write must never be the
    /// reason the chase list does not appear.
    @Published private(set) var review: DayInReview?
    @Published private(set) var movers: Movers?
    /// The market half of this screen. Each is context rather than the
    /// subject, so each fails silently and independently: a FRED outage
    /// must never be why the book's own number is missing.
    ///
    /// `book` is read from the same cache BookStore writes, so opening the
    /// app puts a real number on screen before a request is made. Indices
    /// sit behind requireTerminalAccess, so for a JuniorAnalyst that block
    /// is simply absent rather than an error.
    @Published private(set) var book: Book?
    @Published private(set) var indices: PerfIndices?
    @Published private(set) var macro: PerfMacro?
    /// The book's own earnings calendar. Cached, because a sixty-day
    /// calendar barely moves between opens and a member should see the
    /// next print before the network answers.
    @Published private(set) var earnings: BookEarnings?
    /// When the book and the calendar were actually true. The headline is
    /// printed in 28pt and had no as-of stamp at all, while `Cache.read`
    /// was already handing back the timestamp and it was being discarded.
    @Published private(set) var bookAt: Date?
    @Published private(set) var earningsAt: Date?
    /// Set by the screen from Session so the two Analyst-gated reads can be
    /// skipped rather than fired to be refused.
    var terminalAccess: Bool?

    func load() async {
        if let (f, at) = Cache.read("/research/follow-ups", as: FollowUps.self) {
            // Same reasoning as the Book: what you owe today is the thing
            // worth showing in the first quarter-second, and it is rarely
            // wrong by much. See Cache.swift.
            state = .loaded(f, at: at)
            async let a: Void = fetch(keepOld: true)
            async let b: Void = loadExtras()
            _ = await (a, b)
            return
        }
        state = .loading
        async let a: Void = fetch(keepOld: false)
        async let b: Void = loadExtras()
        _ = await (a, b)
    }

    func refresh() async {
        async let a: Void = fetch(keepOld: true)
        async let b: Void = loadExtras()
        _ = await (a, b)
    }

    private func loadExtras() async {
        // Each read lands on its OWN published property the moment it
        // arrives, and this is the difference between a screen that paints
        // in a second and one that sits empty for half a minute.
        //
        // These six were fired concurrently with `async let` and then
        // collected into one tuple, and a tuple await is a BARRIER: nothing
        // was assigned until the slowest finished. The slowest is
        // /dashboard/day-in-review, which is a lazy LLM generation that
        // takes ten to thirty seconds on a cache miss. So the book, the
        // movers, the indices, the macro and the earnings — five reads that
        // answer in well under a second — all waited behind an essay, and
        // pull-to-refresh spun for the whole of it.
        //
        // A task group with per-child assignment has no barrier: the market
        // is on screen immediately and the summary arrives whenever it is
        // written.
        if let (b, at) = Cache.read("/holdings/quotes", as: Book.self) {
            book = b; bookAt = at
        }
        if let (e, at) = Cache.read("/holdings/earnings", as: BookEarnings.self) {
            earnings = e; earningsAt = at
        }

        // Two of these are Analyst-gated, and JuniorAnalyst is the default
        // role, so for half the club they are a guaranteed 403 — two of six
        // launch requests spent to be refused. Nil means we have not asked
        // /auth/me yet and we still try, which is the same rule MainTabs
        // uses for the tabs themselves.
        let mayTerminal = terminalAccess != false

        await withTaskGroup(of: Void.self) { group in
            group.addTask { [weak self] in
                let v = try? await API.shared.get("/holdings/quotes", as: Book.self, cache: true)
                await MainActor.run { if let v { self?.book = v; self?.bookAt = Date() } }
            }
            group.addTask { [weak self] in
                let v = try? await API.shared.get("/holdings/earnings", as: BookEarnings.self, cache: true)
                await MainActor.run { if let v { self?.earnings = v; self?.earningsAt = Date() } }
            }
            group.addTask { [weak self] in
                let v = try? await API.shared.get("/dashboard/macro", as: PerfMacro.self)
                await MainActor.run { if let v { self?.macro = v } }
            }
            group.addTask { [weak self] in
                let v = try? await API.shared.get("/dashboard/day-in-review", as: DayInReview.self)
                await MainActor.run { if let v { self?.review = v } }
            }
            if mayTerminal {
                group.addTask { [weak self] in
                    let v = try? await API.shared.get("/terminal/movers", as: Movers.self)
                    await MainActor.run { if let v { self?.movers = v } }
                }
                group.addTask { [weak self] in
                    let v = try? await API.shared.get("/terminal/indices", as: PerfIndices.self)
                    await MainActor.run { if let v { self?.indices = v } }
                }
            }
        }
    }

    private func fetch(keepOld: Bool) async {
        let previous = state.value
        do {
            let f = try await API.shared.get("/research/follow-ups", as: FollowUps.self, cache: true)
            state = .loaded(f, at: Date())
        } catch APIError.cancelled {
            // Leaving the tab mid-load is not a failure. The old build used
            // `try?` here, which turned every tab switch into "Could not
            // read AIT, GD, MLAB. This list is incomplete."
            return
        } catch {
            let msg = error.localizedDescription
            state = keepOld && previous != nil ? .stale(previous!, msg) : .failed(msg)
        }
    }
}

/// What needs you, today.
///
/// Bloomberg's mobile alerts are market events; ours are obligations, which
/// is the more phone-shaped thing and the one nobody can hold in their head
/// across a hundred and ten contacts.
///
/// Earnings dates USED to be excluded here on the grounds that they are a
/// market event with no action attached. That held while this was an
/// obligations list and stopped holding when it became a terminal: for a
/// club deciding whether to hold a name through its print, the date IS the
/// action. They now sit under the movers.
///
/// One thing is still deliberately absent: chases that are merely coming
/// up. The five
/// working-day rule exists so nobody is the person who emailed twice in
/// three days, and putting tomorrow's chase on today's screen as a tappable
/// row invites sending it today.
struct TodayScreen: View {
    @StateObject private var store = TodayStore()
    @EnvironmentObject var s: Session
    /// Every other screen using aged() observes this; Today did not, so its
    /// stale strip was unreachable by the clock no matter how old the chase
    /// list got. aged() is a pure function of now, and nothing was making
    /// the body re-run.
    @ObservedObject private var clock = StaleClock.shared
    @State private var showAllOutreach = false

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "TODAY", title: "What needs you")
            // The three blocks are siblings, and that is the fix.
            //
            // They used to live inside one ScreenState keyed on the chase
            // list, so a 500 on /research/follow-ups blanked the movers and
            // the day-in-review as well — two sections that had loaded
            // perfectly. One failed request must cost exactly one section.
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    // The market first, and the book's own number above all
                    // of it. This screen opened on a list of overdue emails,
                    // which is one member's job rather than the fund's
                    // position, and it read as a chore rather than a
                    // terminal. Outreach is still here and still ranked by
                    // the server; it is just no longer the headline.
                    bookHeadline
                    moversSection
                    earningsSection
                    indicesSection
                    macroSection
                    outreachSection
                    reviewSection
                    Spacer().frame(height: Space.xl)
                }
            }
            .refreshable { await store.refresh() }
        }
        // Bottom, not top, and big enough to hit.
        //
        // These five were a row of 16-point chips under the function bar:
        // at the far end of a six-inch screen from where a thumb rests, and
        // below Apple's 44-point floor in both directions. They are half
        // this app's navigation and they were the least usable thing on it.
        //
        // safeAreaInset rather than an overlay so the scroll view knows the
        // bar is there and the last row of content can still be reached.
        .safeAreaInset(edge: .bottom, spacing: 0) { accessBar }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: PersonScreen.self) { $0 }
        .navigationDestination(for: TickerScreen.self) { $0 }
        .navigationDestination(for: Route.self) { routeView($0) }
        .navigationDestination(for: VoteDetailScreen.self) { $0 }
        .task {
            store.terminalAccess = s.terminalAccess
            if store.state.value == nil { await store.load() }
        }
        .onChange(of: s.terminalAccess) { _, new in store.terminalAccess = new }
        .refreshOnForeground { await store.refresh() }
    }

    /// The way to everything that is not a tab.
    ///
    /// Ballots first and always: it is the only obligation here with a
    /// deadline the server enforces, and closeExpiredSessions() gives no
    /// grace. Alerts and Search are Analyst-gated, so they are absent rather
    /// than present-and-refusing for the members who cannot open them —
    /// the same rule the Wire and Watch tabs follow.
    @ViewBuilder private var accessBar: some View {
        // Icons as well as words. At this size a label alone is a wall of
        // small caps, and the glyph is what the eye actually lands on.
        let items: [(Route, String, String, Color)] = {
            var v: [(Route, String, String, Color)] = [
                (.ballots, "BALLOTS", "checkmark.square", T.amber),
                (.club, "CLUB", "person.2", T.blue),
                (.performance, "PERF", "chart.line.uptrend.xyaxis", T.blue),
            ]
            if s.terminalAccess != false {
                v.append((.alerts, "ALERTS", "bell", T.orange))
                v.append((.search, "SEARCH", "magnifyingglass", T.blue))
            }
            return v
        }()

        VStack(spacing: 0) {
            Rectangle().fill(T.border).frame(height: 1)
            HStack(spacing: 0) {
                ForEach(items, id: \.0) { route, label, icon, tone in
                    NavigationLink(value: route) {
                        VStack(spacing: Space.xs) {
                            Image(systemName: icon)
                                .font(.system(size: 17, weight: .semibold))
                            Text(label)
                                .font(Type.chip)
                                .tracking(0.6)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                        .foregroundStyle(tone)
                        // 52pt tall and an equal share of the width, so
                        // every one of these clears the 44-point floor in
                        // both directions with room to spare. contentShape
                        // makes the whole cell tappable rather than just
                        // the glyph and the glyph's baseline.
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, Space.xs)
        }
        .background(T.header)
    }

    /// The fund's own number, at the top, because this is a terminal and
    /// that is what a terminal opens with.
    ///
    /// Painted from the cache BookStore already writes, so it is on screen
    /// before a request is made rather than after a dyno wakes up. The day
    /// move is summed from the positions: `totals` carries value, cost and
    /// lifetime gain but no day figure, and inventing one server-side would
    /// be a second rule that could disagree with the Book tab.
    @ViewBuilder private var bookHeadline: some View {
        if let t = store.book?.totals, let value = t.totalValue {
            let day = store.book?.equities.compactMap(\.dayChangeValue).reduce(0, +)
            Section {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(Fmt.money(value))
                        .font(Type.valueBig)
                        .foregroundStyle(T.white)
                    HStack(spacing: Space.m) {
                        if let day, day != 0 {
                            Text("\(Fmt.moneyDelta(day)) today")
                                .font(Type.delta)
                                .foregroundStyle(T.delta(day))
                        }
                        if let gl = t.totalGainLoss {
                            Text("\(Fmt.moneyDelta(gl)) \(Fmt.pct(t.totalGainLossPct))")
                                .font(Type.delta)
                                .foregroundStyle(T.delta(gl))
                        }
                        Spacer(minLength: 0)
                    }
                    // The same warning the Book carries. A total that is
                    // silently missing positions is a wrong number, and it
                    // is more wrong here, where it is the headline.
                    if let n = t.unpricedCount, n > 0 {
                        Text("\(n) position\(n == 1 ? "" : "s") unpriced, so this total is short.")
                            .font(Type.meta).foregroundStyle(T.orange)
                    }
                    // The biggest number in the app had nothing saying when
                    // it was true, and the loader was already holding the
                    // answer. A 28pt figure with no stamp is the exact lie
                    // the "Live" chip on the ticker screen used to tell.
                    Text("AS OF \(Fmt.since(store.bookAt))")
                        .font(Type.meta).foregroundStyle(T.muted)
                }
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "The book")
            }
        }
    }

    /// What reports next, out of our own book.
    ///
    /// This screen's own comment used to say earnings dates were
    /// DELIBERATELY absent, "because they are a market event with no action
    /// attached, which is exactly the category this screen exists not to
    /// be". That was a fair rule when Today was an obligations list. It
    /// stopped being true the moment Today led with the book, and the
    /// owner's judgement is that the print date is the most useful thing on
    /// here: an earnings date IS the action for a club that has to decide
    /// whether to hold something through it.
    ///
    /// `/holdings/earnings` is verifyJwt only, so this is one of the few
    /// genuinely useful blocks a JuniorAnalyst can see.
    @ViewBuilder private var earningsSection: some View {
        // Filtered, not trusted. See EarningsDate.whenLine: the server only
        // ever sends future dates, but this list can come off disk and a
        // cached calendar ages into the past.
        let rows = (store.earnings?.upcoming ?? []).filter(\.isUpcoming)
        if !rows.isEmpty {
            Section {
                VStack(spacing: 0) {
                    ForEach(rows.prefix(5)) { e in
                        NavigationLink(value: TickerScreen(symbol: e.ticker ?? "")) {
                            TickerRow(ticker: e.ticker ?? "—",
                                      name: e.name,
                                      meta: e.whenLine,
                                      strip: e.isImminent ? T.amber : nil) {
                                // The estimate is the only number worth the
                                // width here. A revenue estimate beside it
                                // would need a second column, and columns
                                // are the Mac's.
                                if let eps = e.epsEstimate {
                                    VStack(alignment: .trailing, spacing: Space.xs) {
                                        Text(String(format: "%.2f", eps))
                                            .font(Type.value).foregroundStyle(T.white)
                                        Text("EST EPS")
                                            .font(Type.meta).foregroundStyle(T.muted)
                                    }
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            } header: {
                SectionHeader(text: "Reporting next",
                              trailing: rows.count > 5 ? "5 of \(rows.count)" : "\(rows.count)")
            }
        }
    }

    /// Where the market went, as context for where we went. Only the move
    /// is shown: worldIndices falls back to a tracking ETF when its sources
    /// miss and flags `approx`, which makes the LEVEL wrong under the
    /// index's own name while the percentage stays faithful.
    @ViewBuilder private var indicesSection: some View {
        let rows = store.indices?.rows ?? []
        if !rows.isEmpty {
            Section {
                VStack(spacing: 0) {
                    ForEach(rows.prefix(6)) { r in
                        StatLine(label: (r.name ?? r.symbol ?? "—").uppercased(),
                                 value: Fmt.pct(r.changePercent),
                                 tone: T.delta(r.changePercent))
                    }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "Markets")
            }
        }
    }

    /// The five FRED series. `value` arrives already formatted by the
    /// service, so it is printed as sent rather than parsed and reformatted
    /// here, which is the one way this could disagree with the dashboard
    /// about a number they both read from FRED.
    @ViewBuilder private var macroSection: some View {
        let rows = store.macro?.indicators ?? []
        if !rows.isEmpty {
            Section {
                VStack(spacing: 0) {
                    ForEach(rows) { r in
                        StatLine(label: (r.label ?? r.id ?? "—").uppercased(),
                                 value: [r.value, r.unit].compactMap { $0 }.joined())
                    }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "Macro")
            }
        }
    }

    @ViewBuilder private var outreachSection: some View {
        let rows = store.state.value?.rows ?? []
        Section {
            switch store.state.aged(after: 600, now: clock.tick) {
            case .loading:
                LoadingState().frame(height: 120)
            case .failed(let msg):
                ErrorState(message: msg, retry: { Task { await store.load() } })
                    .frame(height: 180)
            case .stale(let f, let msg):
                VStack(spacing: 0) {
                    StaleStrip(message: msg, retry: { Task { await store.refresh() } })
                    chaseList(f)
                }
            case .loaded(let f, _):
                chaseList(f)
            }
        } header: {
            SectionHeader(text: "Outreach",
                          trailing: store.state.value?.summary
                              ?? (rows.isEmpty ? nil : "\(rows.count)"))
        }
    }

    /// Three rows, then a count.
    ///
    /// This list used to be the whole screen, and with a hundred and ten
    /// contacts on a chase clock it ran for pages — so Today read as one
    /// member's inbox rather than as the fund's position, and the market
    /// blocks below were never scrolled to. The work has not gone anywhere:
    /// the server still ranks it, the three most urgent still show, and the
    /// summary line says exactly how much is behind them.
    ///
    /// The cap is on what is DRAWN, never on what is counted. A screen that
    /// quietly shows the first three of forty is worse than the long list
    /// it replaced.
    private static let outreachPreview = 3

    @ViewBuilder private func chaseList(_ f: FollowUps) -> some View {
        let rows = f.rows ?? []
        if rows.isEmpty {
            EmptyState(text: emptyText, good: true).frame(height: 90)
        } else {
            // The rows arrive ranked by the server and are rendered in that
            // order. The client used to sort them itself and disagreed with
            // the desk about which chase mattered most.
            let shown = showAllOutreach ? rows : Array(rows.prefix(Self.outreachPreview))
            ForEach(shown) { row in
                NavigationLink(value: PersonScreen(targetId: row.targetId ?? -1,
                                                   knownName: row.name)) {
                    chaseRow(row)
                }
                .buttonStyle(.plain)
                // A row with no target id has nothing to open, and a link
                // that goes nowhere is worse than no link.
                .disabled(row.targetId == nil)
            }
            if rows.count > Self.outreachPreview {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { showAllOutreach.toggle() }
                } label: {
                    HStack(spacing: Space.s) {
                        Text(showAllOutreach
                             ? "SHOW LESS"
                             : "SHOW ALL \(rows.count)")
                            .font(Type.chip).tracking(0.8).foregroundStyle(T.cyan)
                        if let sum = f.summary, !showAllOutreach {
                            Text(sum).font(Type.meta).foregroundStyle(T.muted)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Space.l)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .background(T.card)
                    .hairline()
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// The server ships nextDueAt precisely so a screen with nothing to do
    /// can say when that changes. The first build decoded it and threw it
    /// away, leaving a bare sentence with no scroll view, so pull-to-refresh
    /// could not physically fire.
    private var emptyText: String {
        let next = store.state.value?.nextDueAt
        guard let next, let d = Fmt.parseISO(next) else {
            return "Nothing owed today."
        }
        return "Nothing owed today.\nNext chase comes due \(Fmt.day(ISO8601DateFormatter().string(from: d)))."
    }

    /// What moved in our own book today. Not a market screen: these are
    /// the club's positions, ranked, and every row opens the name.
    @ViewBuilder private var moversSection: some View {
        let all = store.movers?.rows ?? []
        // Already sorted best-first by the server, so the two ends of the
        // one array are the gainers and the losers.
        let shown = all.count <= 6 ? all : Array(all.prefix(3)) + Array(all.suffix(3))
        if !shown.isEmpty {
            Section {
                ForEach(shown) { m in
                    NavigationLink(value: TickerScreen(symbol: m.ticker ?? "")) {
                        TickerRow(ticker: m.ticker ?? "—", name: m.name) {
                            Text(Fmt.pct(m.changePercent))
                                .font(Type.value)
                                .foregroundStyle(T.delta(m.changePercent))
                        }
                    }
                    .buttonStyle(.plain)
                }
                // Saying which of the book this is, rather than letting six
                // rows read as the whole thing.
                if let n = store.movers?.unpriced, n > 0 {
                    Text("\(n) position\(n == 1 ? "" : "s") could not be priced.")
                        .font(Type.meta).foregroundStyle(T.muted)
                        .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } header: {
                SectionHeader(text: "Our movers",
                              trailing: shown.count < all.count
                                  ? "\(shown.count) of \(all.count)" : "\(all.count)")
            }
        }
    }

    /// The post-close summary, written once a day after the close. It is
    /// the last thing on the screen on purpose: it is the thing you read,
    /// not the thing you do.
    @ViewBuilder private var reviewSection: some View {
        if let text = store.review?.dayInReview, !text.isEmpty {
            Section {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(text).font(Type.body).foregroundStyle(T.dim)
                        .fixedSize(horizontal: false, vertical: true)
                    if let g = store.review?.dayInReviewAt {
                        Text("Written \(Fmt.shortDateTime(g))")
                            .font(Type.meta).foregroundStyle(T.muted)
                    }
                }
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "Day in review")
            }
        }
    }

    private func chaseRow(_ r: ChaseRow) -> some View {
        Row(title: r.name ?? "Unnamed contact",
            subtitle: r.recommendation,
            meta: metaLine(r),
            strip: strip(r)) {
            Chip(text: label(r), tone: strip(r) ?? T.muted, style: .solid)
        }
    }

    /// `owed` carries no dueAt at all, so a due-date line is not merely
    /// empty for it, it is the wrong question: nobody is waiting on a clock,
    /// they are waiting on us.
    private func metaLine(_ r: ChaseRow) -> String? {
        if r.isOwed { return "They wrote back" }
        if let d = r.dueDay { return "Due \(d)" }
        if let d = r.dueAt { return "Due \(Fmt.day(d))" }
        return nil
    }

    private func label(_ r: ChaseRow) -> String {
        if r.isOwed { return "Owed" }
        if r.isOverdue { return "Overdue" }
        return "Due"
    }

    /// The most urgent state had no visible marker at all: urgency was
    /// expressed only as red on the due-date text, and `owed` rows have no
    /// due date, so the red was applied to an empty string.
    private func strip(_ r: ChaseRow) -> Color? {
        if r.isOwed || r.isOverdue { return T.negative }
        if r.isDue { return T.amber }
        return nil
    }
}

// MARK: Club

/// Who is signed in, and how to stop being signed in. Deliberately just
/// that: the club's own administration — votes, attendance, the roster,
/// events — is not in this app at all, so this is an account screen and
/// not a members' area.
///
/// It still earns a tab. Without one, signing out squats in the Book's
/// toolbar, which is where it was, and from any other screen you could
/// not sign out at all.
struct AccountScreen: View {
    @EnvironmentObject var s: Session
    @State private var confirmingSignOut = false

    /// The wire carries CamelCase role names. "SeniorPortfolioManager" is a
    /// database value, not a sentence to show somebody about themselves.
    static func readable(_ role: String) -> String {
        role.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2",
                                  options: .regularExpression)
    }

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "ACCT", title: "Signed in")
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        // The name is remembered across launches now. It
                        // was only ever set by the sign-in call, so every
                        // cold launch showed the placeholder to a member
                        // whose name we had known since the day they
                        // installed the app.
                        Row(title: s.name ?? "Signed in",
                            subtitle: s.role.map { Self.readable($0) } ?? "The Griffin Fund")
                        if s.terminalAccess == false {
                            Row(title: "Wire and Watch are not on this account",
                                subtitle: "Market data needs the Analyst role. The book and your obligations do not.",
                                strip: T.muted)
                        }
                        if let w = s.keychainWarning {
                            Row(title: "This phone could not save your sign-in",
                                subtitle: w,
                                strip: T.negative)
                        }
                    } header: {
                        SectionHeader(text: "You")
                    }

                    Section {
                        Button { confirmingSignOut = true } label: {
                            Row(title: "Sign out", subtitle: "Removes the token from this phone.")
                        }
                        .buttonStyle(.plain)
                    } header: {
                        SectionHeader(text: "Session")
                    }
                }
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .confirmationDialog("Sign out?",
                            isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { s.signOut() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("You will need the website to sign in again.")
        }
    }
}
