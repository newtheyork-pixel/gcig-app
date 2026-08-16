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

struct MainTabs: View {
    var body: some View {
        // Today first because the phone is the interrupt device and this
        // is the only screen that knows who you are. Club last: lowest
        // frequency, but without it sign-out squats in another screen's
        // toolbar and cannot be reached from most of the app.
        TabView {
            NavigationStack { TodayScreen() }
                .tabItem { Label("Today", systemImage: "checklist") }
            NavigationStack { NewsScreen() }
                .tabItem { Label("Wire", systemImage: "newspaper") }
            NavigationStack { WatchScreen() }
                .tabItem { Label("Watch", systemImage: "eye") }
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

    func load() async {
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
        review = try? await API.shared.get("/dashboard/day-in-review", as: DayInReview.self)
        movers = try? await API.shared.get("/terminal/movers", as: Movers.self)
    }

    private func fetch(keepOld: Bool) async {
        let previous = state.value
        do {
            let f = try await API.shared.get("/research/follow-ups", as: FollowUps.self)
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
/// Two things are deliberately absent. Earnings dates, because they are a
/// market event with no action attached, which is exactly the category this
/// screen exists not to be. And chases that are merely coming up: the five
/// working-day rule exists so nobody is the person who emailed twice in
/// three days, and putting tomorrow's chase on today's screen as a tappable
/// row invites sending it today.
struct TodayScreen: View {
    @StateObject private var store = TodayStore()

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "TODAY", title: "What needs you")
            ScreenState(state: store.state,
                        retry: { Task { await store.load() } }) { f in
                list(f)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: PersonScreen.self) { $0 }
        .navigationDestination(for: TickerScreen.self) { $0 }
        .task { if store.state.value == nil { await store.load() } }
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

    private func list(_ f: FollowUps) -> some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                // The rows arrive ranked by the server and are rendered in
                // that order. The client used to sort them itself and
                // disagreed with the desk about which chase mattered most.
                let rows = f.rows ?? []
                Section {
                    if rows.isEmpty {
                        EmptyState(text: emptyText, good: true).frame(height: 90)
                    } else {
                        ForEach(rows) { row in
                            NavigationLink(value: PersonScreen(targetId: row.targetId ?? -1,
                                                               knownName: row.name)) {
                                chaseRow(row)
                            }
                            .buttonStyle(.plain)
                            // A row with no target id has nothing to open,
                            // and a link that goes nowhere is worse than
                            // no link.
                            .disabled(row.targetId == nil)
                        }
                    }
                } header: {
                    SectionHeader(text: "Outreach", trailing: rows.isEmpty ? nil : "\(rows.count)")
                }

                moversSection
                reviewSection
                Spacer().frame(height: Space.xl)
            }
        }
        .refreshable { await store.refresh() }
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
        .accessibilityElement(children: .combine)
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

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "ACCT", title: "Signed in")
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        Row(title: s.name ?? "Signed in",
                            subtitle: "The Griffin Fund")
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
