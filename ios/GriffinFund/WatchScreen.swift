import SwiftUI

// The watchlist.
//
// Provenance is the design, and the server's own comment says why: a ticker
// we own, a ticker a manager we respect disclosed, and a ticker somebody
// typed in are three different claims about how much attention a name
// deserves, and a list that flattens them into one column cannot be
// weighed. So the phone groups by source rather than sorting everything
// into one alphabet.
//
// The most interesting row is the one on a filing AND in the book, which
// the server flags as `alsoHeld`. That gets said out loud.

@MainActor
final class WatchStore: ObservableObject {
    @Published private(set) var state: Loadable<Watchlist> = .loading

    func load() async {
        state = .loading
        await fetch(keepOld: false)
    }

    func refresh() async { await fetch(keepOld: true) }

    /// Named for what it is, not for the sheet: the screen has its own
    /// `adding` meaning "the sheet is open", and two different booleans
    /// with one name is how a disabled button ends up wired to the wrong
    /// one.
    @Published private(set) var submitting = false
    /// Any failed write on this screen, add or remove. One field rather
    /// than two because there is one place to show it, and a remove
    /// failure written into a variable only the add sheet renders is a
    /// message nobody ever sees.
    @Published var actionError: String?

    /// Adding is the watchlist's real value on a phone: somebody names a
    /// company at dinner and it takes four seconds. Reading the list is
    /// the secondary use.
    ///
    /// `scope` is passed explicitly rather than left to the server's
    /// default, which is the SHARED club list. That default is right for
    /// the web client and wrong to inherit silently here: a member tapping
    /// + on a phone should know whether they just added a name for
    /// everybody, so the screen asks.
    func add(_ ticker: String, shared: Bool) async -> Bool {
        submitting = true
        actionError = nil
        defer { submitting = false }
        do {
            _ = try await API.shared.post("/watchlist",
                                          body: ["ticker": ticker.uppercased(),
                                                 "scope": shared ? "club" : "mine"],
                                          as: AddReceipt.self)
            await refresh()
            return true
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    /// The list could be added to and never removed from, which turns a
    /// watchlist into a ratchet: the only way to take a name off was to open
    /// the website.
    ///
    /// Only rows with a numeric id can go. That is not a client rule invented
    /// here — the server refuses a non-numeric id because holdings are
    /// derived from the sheet, and "removing" one would be pretending we can
    /// sell from a watchlist. The row hides its own remove action when the
    /// id says it is not ours to delete, so nobody is offered a button that
    /// answers 400.
    func remove(_ item: WatchItem) async {
        guard let id = item.id, Int(id) != nil else { return }
        do {
            _ = try await API.shared.delete("/watchlist/\(id)", as: AddReceipt.self)
            await refresh()
        } catch {
            // Surfaced in the same place an add failure is. A permission
            // refusal here is a real sentence from the server about whose
            // row this is ("Only an executive can remove a name from the
            // club list"), and it is worth reading.
            actionError = error.localizedDescription
        }
    }

    private func fetch(keepOld: Bool) async {
        let previous = state.value
        do {
            state = .loaded(try await API.shared.get("/watchlist", as: Watchlist.self), at: Date())
        } catch APIError.cancelled {
            return
        } catch {
            let msg = error.localizedDescription
            state = keepOld && previous != nil ? .stale(previous!, msg) : .failed(msg)
        }
    }
}

struct WatchScreen: View {
    @StateObject private var store = WatchStore()
    @ObservedObject private var clock = StaleClock.shared
    @State private var adding = false
    @State private var newTicker = ""
    @State private var shared = true
    @State private var removing: WatchItem?
    @FocusState private var tickerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "WATCH", title: "Names we follow")
            ScreenState(state: store.state.aged(after: 600, now: clock.tick),
                        emptyWhen: { ($0.items ?? []).isEmpty },
                        emptyText: "Nothing on the watchlist yet.",
                        retry: { Task { await store.load() } },
                        staleRetry: { Task { await store.refresh() } }) { list in
                content(list)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: TickerScreen.self) { $0 }
        .task { if store.state.value == nil { await store.load() } }
        .refreshOnForeground { await store.refresh() }
        .overlay(alignment: .bottomTrailing) { addButton }
        // Reset on dismiss, not only on a successful add. Cancelling used to
        // leave the typed ticker and any error behind, so reopening the
        // sheet showed a stranger's half-finished attempt.
        .sheet(isPresented: $adding, onDismiss: resetAddSheet) { addSheet }
        .confirmationDialog("Remove \(removing?.ticker ?? "this name")?",
                            isPresented: Binding(get: { removing != nil },
                                                 set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let item = removing { Task { await store.remove(item) } }
                removing = nil
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text(removing?.source == "manual"
                 ? "Takes it off the list for everyone who can see it."
                 : "Takes it off the watchlist. The filing it came from is unaffected.")
        }
    }

    private func resetAddSheet() {
        newTicker = ""
        store.actionError = nil
    }

    private var addButton: some View {
        Button {
            // Cleared on the way IN as well as out: an error left from a
            // failed remove has nothing to do with the sheet about to open.
            store.actionError = nil
            adding = true
        } label: {
            Text("+ ADD")
                .font(Type.chip).tracking(0.8)
                .padding(.horizontal, Space.m).padding(.vertical, Space.m)
                .background(T.amber).foregroundStyle(T.bg)
        }
        .buttonStyle(.plain)
        .padding(Space.l)
    }

    private var addSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Space.m) {
                Text("TICKER").font(Type.label).tracking(0.8).foregroundStyle(T.muted)
                TextField("e.g. LISN", text: $newTicker)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(Font.data(20, .bold)).foregroundStyle(T.amber)
                    .padding(Space.m).background(T.card)
                    .overlay(Rectangle().strokeBorder(T.border, lineWidth: 1))
                    .focused($tickerFocused)

                // Said as a sentence rather than a toggle labelled "scope",
                // because the consequence is the part that matters.
                Toggle(isOn: $shared) {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(shared ? "Adding for the whole club" : "Adding just for you")
                            .font(Type.body).foregroundStyle(T.white)
                        Text(shared ? "Everyone will see this name on the list."
                                    : "Nobody else will see it.")
                            .font(Type.meta).foregroundStyle(T.muted)
                    }
                }
                .tint(T.amber)

                if let e = store.actionError {
                    Text(e).font(Type.footnote).foregroundStyle(T.negative)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    Task {
                        if await store.add(newTicker, shared: shared) {
                            newTicker = ""
                            adding = false
                        }
                    }
                } label: {
                    Text(store.submitting ? "ADDING…" : "ADD TO WATCHLIST")
                        .font(Type.chip).tracking(0.8)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(newTicker.isEmpty ? T.card : T.amber)
                        .foregroundStyle(newTicker.isEmpty ? T.muted : T.bg)
                }
                .disabled(newTicker.isEmpty || store.submitting)

                Spacer()
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.bg)
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("ADD A NAME").font(Type.screenCode).foregroundStyle(T.white)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { adding = false }.foregroundStyle(T.dim)
                }
            }
            .toolbarBackground(T.redBar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .presentationDetents([.height(340)])
        .task { tickerFocused = true }
    }

    private func content(_ list: Watchlist) -> some View {
        let items = list.items ?? []
        let groups: [(String, String, [WatchItem])] = [
            ("The book", "holding", items.filter { $0.source == "holding" }),
            ("On a 13F", "seg13f", items.filter { $0.source == "seg13f" }),
            ("Added by hand", "manual", items.filter { $0.source == "manual" }),
        ]

        return ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                // A remove is attempted from the list, not from the sheet,
                // so its failure has to be legible from the list.
                if let e = store.actionError, !adding {
                    HStack(spacing: Space.s) {
                        Chip(text: "Not done", tone: T.negative, style: .solid)
                        Text(e).font(Type.meta).foregroundStyle(T.dim)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button("DISMISS") { store.actionError = nil }
                            .font(Type.chip).foregroundStyle(T.cyan)
                            .buttonStyle(.plain)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T.negative.opacity(0.12))
                }

                // Said once, at the top, rather than as a dash on every
                // row: if quotes are down, that is one fact about the
                // screen, not forty facts about forty companies.
                if list.quotesAvailable == false {
                    HStack(spacing: Space.s) {
                        Chip(text: "No quotes", tone: T.orange, style: .solid)
                        Text("Prices are unavailable right now. The names and our own figures are still current.")
                            .font(Type.meta).foregroundStyle(T.dim)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T.orange.opacity(0.12))
                }

                ForEach(groups, id: \.1) { title, key, rows in
                    if !rows.isEmpty {
                        Section {
                            ForEach(rows) { item in
                                NavigationLink(value: TickerScreen(symbol: item.ticker ?? "")) {
                                    row(item)
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    if removable(item) {
                                        Button("Remove from watchlist",
                                               systemImage: "minus.circle",
                                               role: .destructive) { removing = item }
                                    }
                                }
                            }
                        } header: {
                            SectionHeader(text: title, trailing: "\(rows.count)")
                        }
                    }
                }
                // The + ADD button floats over the bottom-trailing corner,
                // so without this the last row's price sits underneath it.
                Spacer().frame(height: 72)
            }
        }
        .refreshable { await store.refresh() }
    }

    /// Derived rows carry non-numeric ids and the server refuses to delete
    /// them. Asking first means nobody is offered an action that 400s.
    private func removable(_ i: WatchItem) -> Bool {
        guard let id = i.id else { return false }
        return Int(id) != nil
    }

    private func row(_ i: WatchItem) -> some View {
        TickerRow(ticker: i.ticker ?? "—",
                  name: i.name,
                  meta: metaLine(i)) {
            ValueStack(
                value: Fmt.money(i.quote?.last, decimals: 2),
                delta: i.quote?.changePct,
                deltaText: i.quote?.changePct == nil ? "—" : Fmt.pct(i.quote?.changePct),
                flash: i.quote?.last
            )
        }
        .contentShape(Rectangle())
    }

    /// A name on a filing that we also own is the most interesting row on
    /// the list, so it says so before it says anything else.
    private func metaLine(_ i: WatchItem) -> String? {
        var parts: [String] = []
        if i.alsoHeld == true && i.source != "holding" { parts.append("We own it") }
        if let w = i.weight { parts.append("\(Fmt.pct(w, signed: false)) of book") }
        if let s = i.stats?.ytd { parts.append("YTD \(Fmt.pct(s))") }
        if i.quote?.stale == true { parts.append("stale price") }
        if let n = i.note, !n.isEmpty, parts.isEmpty { parts.append(n) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
