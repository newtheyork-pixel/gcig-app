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

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "WATCH", title: "Names we follow")
            ScreenState(state: store.state,
                        emptyWhen: { ($0.items ?? []).isEmpty },
                        emptyText: "Nothing on the watchlist yet.",
                        retry: { Task { await store.load() } }) { list in
                content(list)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: TickerScreen.self) { $0 }
        .task { if store.state.value == nil { await store.load() } }
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
                            }
                        } header: {
                            SectionHeader(text: title, trailing: "\(rows.count)")
                        }
                    }
                }
            }
        }
        .refreshable { await store.refresh() }
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
