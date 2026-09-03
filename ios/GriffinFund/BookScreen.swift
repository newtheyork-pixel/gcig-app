import SwiftUI

// The book. The compulsive check, and the screen that sells the app to the
// club, so it is the one that most has to look like it belongs to the
// terminal rather than to a generic list app.

@MainActor
final class BookStore: ObservableObject {
    @Published private(set) var state: Loadable<Book> = .loading

    private var lastLoad: Date?

    /// Paints from the last visit before the network is asked.
    ///
    /// A cold launch used to be a spinner over an empty screen for as long as
    /// Render took to wake a sleeping dyno, which is often thirty seconds. A
    /// phone is opened for four. The cached book renders instantly with its
    /// real age attached, `aged(after:)` puts the stale strip up if it is old
    /// enough to matter, and the refresh corrects it underneath.
    func load() async {
        if let (book, at) = Cache.read("/holdings/quotes", as: Book.self) {
            state = .loaded(book, at: at)
            lastLoad = at
            await fetch(keepingOldOnFailure: true)
            return
        }
        state = .loading
        await fetch(keepingOldOnFailure: false)
    }

    /// Pull-to-refresh and tab re-entry. Never blanks the screen: a failure
    /// here leaves the numbers up under a stale strip, because a member who
    /// pulled to refresh still wants to see the book.
    func refresh() async {
        await fetch(keepingOldOnFailure: true)
    }

    /// Tab re-entry. Silent, and only if the data has had time to go stale,
    /// so switching tabs twice does not hammer the sheet.
    func refreshIfStale(after seconds: TimeInterval = 120) async {
        if case .loading = state { return }
        guard let last = lastLoad, Date().timeIntervalSince(last) > seconds else { return }
        await refresh()
    }

    private func fetch(keepingOldOnFailure keepOld: Bool) async {
        let previous = state.value
        do {
            let book = try await API.shared.get("/holdings/quotes", as: Book.self, cache: true)
            lastLoad = Date()
            state = .loaded(book, at: Date())
        } catch APIError.cancelled {
            // Leaving the tab is not a failure. Say nothing, change nothing.
            return
        } catch {
            let msg = error.localizedDescription
            if keepOld, let previous {
                state = .stale(previous, msg)
            } else {
                state = .failed(msg)
            }
        }
    }
}

struct BookScreen: View {
    @StateObject private var store = BookStore()
    /// Drives the clock-based stale strip; see StaleClock.
    @ObservedObject private var clock = StaleClock.shared

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "BOOK", title: "Positions")
            // aged(): staleness by the CLOCK, not only by a failed
            // refresh. A book nobody refetched looked exactly like one
            // fetched a second ago, which on a money screen is the one
            // lie this app must not tell.
            ScreenState(state: store.state.aged(after: 600, now: clock.tick),
                        emptyWhen: { ($0.holdings ?? []).isEmpty },
                        emptyText: "The positions sheet came back empty.",
                        retry: { Task { await store.load() } },
                        staleRetry: { Task { await store.refresh() } }) { book in
                content(book)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: TickerScreen.self) { $0 }
        .task { if store.state.value == nil { await store.load() } }
        .task { await store.refreshIfStale() }
        // refreshIfStale on .task fires on view construction, which is tab
        // re-entry and nothing else. It does not fire on lock/unlock or on
        // an app switch, which is how the book stays on morning prices all
        // afternoon. The Mac syncs on didBecomeActive for the same reason.
        .refreshOnForeground(after: 60) { await store.refreshIfStale(after: 60) }
    }

    private func content(_ book: Book) -> some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                summary(book)

                if let n = book.totals?.unpricedCount, n > 0 {
                    // The server refuses to write a snapshot on a read like
                    // this, and the reason applies just as much to the
                    // screen: the total below is missing those positions.
                    unpricedWarning(n)
                }

                Section {
                    ForEach(book.equities.keyed, id: \.key) { entry in
                        NavigationLink(value: TickerScreen(symbol: entry.holding.ticker ?? "",
                                                          holding: entry.holding)) {
                            holdingRow(entry.holding)
                        }
                            .buttonStyle(.plain)
                    }
                } header: {
                    SectionHeader(text: "Positions", trailing: "\(book.equities.count)")
                }

                if !book.cash.isEmpty {
                    Section {
                        ForEach(book.cash.keyed, id: \.key) { entry in
                            cashRow(entry.holding)
                        }
                    } header: {
                        SectionHeader(text: "Cash")
                    }
                }

                footer(book)
            }
        }
        .refreshable { await store.refresh() }
    }

    // MARK: pieces

    private func summary(_ book: Book) -> some View {
        let t = book.totals
        return VStack(spacing: 0) {
            StatBlock(
                label: "Total value",
                value: Fmt.money(t?.totalValue),
                delta: t?.totalGainLoss,
                deltaText: t?.totalGainLoss == nil ? nil
                    : "\(Fmt.moneyDelta(t?.totalGainLoss)) (\(Fmt.pct(t?.totalGainLossPct)))",
                caption: "Since cost. Equities \(Fmt.money(t?.equityValue)) · cash \(Fmt.money(t?.cashValue))"
            )
        }
    }

    private func unpricedWarning(_ n: Int) -> some View {
        HStack(spacing: Space.s) {
            Chip(text: "Short", tone: T.negative, style: .solid)
            Text("\(n) position\(n == 1 ? "" : "s") could not be priced, so the total above is missing \(n == 1 ? "it" : "them").")
                .font(Type.meta)
                .foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.negative.opacity(0.12))
    }

    private func holdingRow(_ h: Holding) -> some View {
        TickerRow(
            ticker: h.ticker ?? "—",
            name: h.name,
            meta: "\(Fmt.shares(h.shares)) sh · \(Fmt.money(h.price, decimals: 2))",
            strip: nil
        ) {
            ValueStack(
                value: Fmt.money(h.marketValue, decimals: 2),
                delta: h.dayChange,
                deltaText: h.dayChange == nil ? "—"
                    : "\(Fmt.moneyDelta(h.dayChangeValue, decimals: 2))  \(Fmt.pct(h.dayChangePct))",
                flash: h.price
            )
        }
        .contentShape(Rectangle())
    }

    private func cashRow(_ h: Holding) -> some View {
        TickerRow(ticker: h.ticker ?? "CASH", name: h.name) {
            Text(Fmt.money(h.marketValue, decimals: 2))
                .font(Type.value)
                .foregroundStyle(T.cyan)
        }
    }

    /// The reconciliation the club already knows about, said out loud rather
    /// than left for someone to rediscover: the website's headline number
    /// includes estimated cash interest and the sheet's does not, so the two
    /// legitimately differ.
    private func footer(_ book: Book) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            AsOfStamp(date: Fmt.parseISO(book.fetchedAt))
            Text("Marked from the sheet. The website's total adds estimated cash interest, so it reads slightly higher.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// Holding must be Hashable to be a navigation value. Identity is the
// ticker, not the whole struct: a price tick must not push a new screen.
extension Holding: Hashable {
    static func == (a: Holding, b: Holding) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}
