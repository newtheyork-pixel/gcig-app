import SwiftUI

// The book. The compulsive check, and the screen that sells the app to the
// club, so it is the one that most has to look like it belongs to the
// terminal rather than to a generic list app.

@MainActor
final class BookStore: ObservableObject {
    @Published private(set) var state: Loadable<Book> = .loading

    private var lastLoad: Date?

    func load() async {
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
            let book = try await API.shared.get("/holdings/quotes", as: Book.self)
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

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "BOOK", title: "Positions")
            ScreenState(state: store.state,
                        emptyWhen: { ($0.holdings ?? []).isEmpty },
                        emptyText: "The positions sheet came back empty.",
                        retry: { Task { await store.load() } }) { book in
                content(book)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: TickerScreen.self) { $0 }
        .task { if store.state.value == nil { await store.load() } }
        .task { await store.refreshIfStale() }
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
                    ForEach(Array(book.equities.enumerated()), id: \.offset) { _, h in
                        NavigationLink(value: TickerScreen(symbol: h.ticker ?? "",
                                                          holding: h)) {
                            holdingRow(h)
                        }
                            .buttonStyle(.plain)
                    }
                } header: {
                    SectionHeader(text: "Positions", trailing: "\(book.equities.count)")
                }

                if !book.cash.isEmpty {
                    Section {
                        ForEach(Array(book.cash.enumerated()), id: \.offset) { _, h in
                            cashRow(h)
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
