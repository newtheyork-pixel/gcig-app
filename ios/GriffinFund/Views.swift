import SwiftUI

struct RootView: View {
    @EnvironmentObject var s: Session
    var body: some View {
        Group {
            if s.token == nil { LoginView() } else { MainTabs() }
        }
        .preferredColorScheme(.dark)
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
                Text("THE GRIFFIN FUND").font(T.mono(15, .bold)).foregroundStyle(T.amber)
                Text("Grace Church School").font(T.mono(11)).foregroundStyle(T.dim)
                    .padding(.bottom, 10)
                TextField("school email", text: $email)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                SecureField("password", text: $password)
                if let e = s.error {
                    Text(e).font(T.mono(11)).foregroundStyle(T.negative)
                }
                Button {
                    Task { await s.logIn(email: email, password: password) }
                } label: {
                    Text(s.busy ? "SIGNING IN…" : "SIGN IN")
                        .font(T.mono(12, .bold)).frame(maxWidth: .infinity)
                }
                .disabled(s.busy || email.isEmpty || password.isEmpty)
                .padding(.top, 6)
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
            let open = projects.filter { ($0.status ?? "") != "Closed" }.prefix(6)
            var out: [WorkItem] = []
            for p in open {
                guard let full = try? await s.get("/research/projects/\(p.id)", as: ProjectFull.self),
                      let rows = full.followUps?.rows else { continue }
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
            tasks = out.sorted { ($0.due ?? "") < ($1.due ?? "") }
        } catch URLError.userAuthenticationRequired {
            failed = "Signed out. Sign in again."
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
                    Text(failed).font(T.mono(11)).foregroundStyle(T.negative).padding()
                } else if let b = book {
                    List {
                        Section {
                            HStack {
                                Text("TOTAL").font(T.mono(10, .bold)).foregroundStyle(T.dim)
                                Spacer()
                                Text(Fmt.money(b.totals?.totalValue ?? 0))
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
                                        Text(Fmt.money(h.marketValue ?? 0))
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
        catch { failed = error.localizedDescription }
        loading = false
    }
}
