import SwiftUI

struct RootView: View {
    @EnvironmentObject var s: Session
    var body: some View {
        Group {
            if s.token == nil { LoginView() } else { MainTabs() }
        }
        .preferredColorScheme(.dark)
        .onOpenURL { url in
            // griffin-terminal://auth?code=… coming back from Safari.
            guard url.scheme == "griffin-terminal",
                  let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                      .queryItems?.first(where: { $0.name == "code" })?.value
            else { return }
            Task { await s.exchange(code: code) }
        }
    }
}

struct LoginView: View {
    @EnvironmentObject var s: Session
    @State private var email = ""
    @State private var password = ""
    var body: some View {
        ZStack {
            T.bg.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                Spacer()
                Text("THE GRIFFIN FUND").font(T.mono(17, .bold)).foregroundStyle(T.amber)
                    .tracking(1.5)
                Text("Grace Church School").font(T.mono(11)).foregroundStyle(T.dim)
                    .tracking(0.5)
                Spacer().frame(height: 18)

                // The browser route is first because it is the one that
                // works for everybody: Google, two-factor and password all
                // happen on a page that already handles them.
                Link(destination: Session.handoffURL) {
                    Text("SIGN IN WITH BROWSER")
                        .font(T.mono(12, .bold)).tracking(0.8)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(T.amber).foregroundStyle(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                Text("Opens the website. Works with Google and two-factor.")
                    .font(T.mono(9)).foregroundStyle(T.muted)

                HStack(spacing: 8) {
                    Rectangle().fill(T.border).frame(height: 1)
                    Text("OR").font(T.mono(9)).foregroundStyle(T.muted)
                    Rectangle().fill(T.border).frame(height: 1)
                }.padding(.vertical, 6)

                TextField("school email", text: $email)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.emailAddress).textContentType(.username)
                    .padding(11).background(T.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                SecureField("password", text: $password)
                    .textContentType(.password)
                    .padding(11).background(T.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                if let e = s.error {
                    Text(e).font(T.mono(11)).foregroundStyle(T.negative)
                }
                Button {
                    Task { await s.logIn(email: email, password: password) }
                } label: {
                    Text(s.busy ? "SIGNING IN…" : "SIGN IN WITH PASSWORD")
                        .font(T.mono(11, .bold)).tracking(0.5)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(T.panel).foregroundStyle(T.white)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(T.border, lineWidth: 1))
                }
                .disabled(s.busy || email.isEmpty || password.isEmpty)
                Spacer()
            }
            .textFieldStyle(.plain)
            .font(T.mono(13)).foregroundStyle(T.white)
            .padding(18)
        }
    }
}

struct MainTabs: View {
    var body: some View {
        TabView {
            TodayView().tabItem { Label("Today", systemImage: "checklist") }
            BookView().tabItem { Label("Book", systemImage: "chart.pie") }
        }
        .tint(T.amber)
    }
}

/// What needs you, today. Bloomberg's mobile alerts are market events;
/// ours are obligations, which is the more phone-shaped thing and the one
/// nobody can hold in their head across a hundred and ten contacts.
struct TodayView: View {
    @EnvironmentObject var s: Session
    @State private var tasks: [WorkItem] = []
    @State private var loading = true
    @State private var failed: String?

    var body: some View {
        NavigationStack {
            ZStack {
                T.bg.ignoresSafeArea()
                Group {
                    if loading { ProgressView().tint(T.amber) }
                    else if let failed {
                        VStack(spacing: 8) {
                            Text("COULD NOT LOAD").font(T.mono(12, .bold)).foregroundStyle(T.negative)
                            Text(failed).font(T.mono(11)).foregroundStyle(T.dim)
                                .multilineTextAlignment(.center)
                            Button("Retry") { Task { await load() } }
                                .font(T.mono(12)).foregroundStyle(T.amber)
                        }.padding()
                    } else if tasks.isEmpty {
                        // An empty list here is good news and should read
                        // as good news, not as a failure to load.
                        Text("Nothing owed today.")
                            .font(T.mono(12)).foregroundStyle(T.positive)
                    } else {
                        List(tasks) { t in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(t.title).font(T.mono(13, .medium)).foregroundStyle(T.white)
                                    Spacer()
                                    Text(t.due.map(Fmt.day) ?? "")
                                        .font(T.mono(10))
                                        .foregroundStyle(t.urgent ? T.negative : T.dim)
                                }
                                Text(t.detail).font(T.mono(11)).foregroundStyle(T.dim)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(t.source).font(T.mono(9)).foregroundStyle(T.muted)
                            }
                            .listRowBackground(T.panel)
                            .padding(.vertical, 3)
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            .navigationTitle("Today")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .refreshable { await load() }
        }
        .task { await load() }
    }

    /// Walks the open research projects and collects everything the chase
    /// clock says is actionable. The server already sorts and explains
    /// each one, so the phone renders the sentence rather than inventing
    /// its own rule and disagreeing with the Mac.
    private func load() async {
        loading = tasks.isEmpty; failed = nil
        do {
            let projects = try await s.get("/research/projects", as: [ProjectStub].self)
            let open = projects.filter { ($0.status ?? "") != "Closed" }
            var out: [WorkItem] = []
            var skipped: [String] = []
            for p in open {
                // A project that fails to load is NAMED, never silently
                // dropped. Swallowing it left the green "Nothing owed
                // today" standing while an overdue chase sat in the one
                // that 429'd.
                guard let full = try? await s.get("/research/projects/\(p.id)", as: ProjectFull.self),
                      let rows = full.followUps?.rows else {
                    skipped.append(p.ticker ?? "#\(p.id)"); continue
                }
                for r in rows where r.urgent || r.due {
                    out.append(WorkItem(
                        id: "\(p.id)-\(r.id)",
                        title: r.name ?? "someone",
                        detail: r.recommendation ?? "",
                        due: r.dueAt,
                        urgent: r.urgent,
                        source: "\(p.ticker ?? "—") outreach"))
                }
            }
            // assessOutreach already ranks these overdue, due, owed and
            // then by date. Re-sorting on the raw string put every owed row
            // at the top under the empty string by accident, and let a
            // merely-due chase outrank an overdue one. The server's order
            // is the order.
            tasks = out
            if !skipped.isEmpty {
                failed = "Could not read \(skipped.joined(separator: ", ")). This list is incomplete."
            }
        } catch let e as APIError {
            failed = e.errorDescription
        } catch {
            failed = error.localizedDescription
        }
        loading = false
    }
}

struct BookView: View {
    @EnvironmentObject var s: Session
    @State private var book: Book?
    @State private var loading = true
    @State private var failed: String?

    var body: some View {
        NavigationStack {
            ZStack {
                T.bg.ignoresSafeArea()
                if loading && book == nil { ProgressView().tint(T.amber) }
                else if let failed, book == nil {
                    VStack(spacing: 8) {
                        Text("COULD NOT LOAD").font(T.mono(12, .bold)).foregroundStyle(T.negative)
                        Text(failed).font(T.mono(11)).foregroundStyle(T.dim)
                            .multilineTextAlignment(.center)
                        Button("Retry") { Task { await load() } }
                            .font(T.mono(12)).foregroundStyle(T.amber)
                    }.padding()
                } else if let b = book {
                    List {
                        // A refresh that failed over an already-loaded book
                        // used to show nothing, leaving yesterday's marks on
                        // screen as if current. A price screen must never do
                        // that silently.
                        if let failed {
                            Section {
                                Text("Stale. \(failed)")
                                    .font(T.mono(10)).foregroundStyle(T.negative)
                                    .listRowBackground(T.panel)
                            }
                        }
                        Section {
                            HStack {
                                Text("TOTAL").font(T.mono(10, .bold)).foregroundStyle(T.dim)
                                Spacer()
                                Text(Fmt.money(b.totals?.totalValue))
                                    .font(T.mono(17, .bold)).foregroundStyle(T.amber)
                            }.listRowBackground(T.panel)
                        }
                        Section("HOLDINGS") {
                            ForEach((b.holdings ?? []).filter { $0.isCash != true }) { h in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(h.ticker ?? "—")
                                            .font(T.mono(13, .bold)).foregroundStyle(T.amber)
                                        Text(h.name ?? "").font(T.mono(10)).foregroundStyle(T.muted)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 2) {
                                        Text(Fmt.money(h.marketValue))
                                            .font(T.mono(12)).foregroundStyle(T.white)
                                        if let d = h.dayChangePct {
                                            Text(Fmt.pct(d)).font(T.mono(10))
                                                .foregroundStyle(d >= 0 ? T.positive : T.negative)
                                        }
                                    }
                                }.listRowBackground(T.panel)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .scrollContentBackground(.hidden)
                }
            }
            .navigationTitle("Book")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { s.signOut() }
                        .font(T.mono(11)).foregroundStyle(T.dim)
                }
            }
            .refreshable { await load() }
        }
        .task { await load() }
    }

    private func load() async {
        failed = nil
        do { book = try await s.get("/holdings/quotes", as: Book.self) }
        catch let e as APIError { failed = e.errorDescription }
        catch { failed = error.localizedDescription }
        loading = false
    }
}
