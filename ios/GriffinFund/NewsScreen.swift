import SwiftUI

// The wire.
//
// Bloomberg's mobile app ships news and alerts and leaves the grid on the
// desk, and this is the news half. Almost all the hard work is already
// server-side: /terminal/top-news merges Finnhub with six public wires,
// age-gates the merge so a dead feed cannot serve eighteen-month-old
// headlines, scores each item for how genuinely breaking it is, and badges
// any headline that mentions a name we own.
//
// The one thing the phone must not do is flatten those distinctions. Three
// states look alike if you let them: a quiet wire, a wire nobody scored,
// and a wire that failed. They are not the same, and only the last is bad.

@MainActor
final class NewsStore: ObservableObject {
    @Published private(set) var state: Loadable<Wire> = .loading

    func load() async {
        state = .loading
        await fetch(keepOld: false)
    }

    func refresh() async { await fetch(keepOld: true) }

    private func fetch(keepOld: Bool) async {
        let previous = state.value
        do {
            state = .loaded(try await API.shared.get("/terminal/top-news", as: Wire.self), at: Date())
        } catch APIError.cancelled {
            return
        } catch {
            let msg = error.localizedDescription
            state = keepOld && previous != nil ? .stale(previous!, msg) : .failed(msg)
        }
    }
}

struct NewsScreen: View {
    @StateObject private var store = NewsStore()
    @ObservedObject private var clock = StaleClock.shared

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "WIRE", title: "Top news")
            ScreenState(state: store.state.aged(after: 900, now: clock.tick),
                        emptyWhen: { ($0.articles ?? []).isEmpty },
                        emptyText: "The wire is quiet. Nothing published recently.",
                        retry: { Task { await store.load() } },
                        staleRetry: { Task { await store.refresh() } }) { wire in
                list(wire)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: TickerScreen.self) { $0 }
        .task { if store.state.value == nil { await store.load() } }
        .refreshOnForeground { await store.refresh() }
    }

    private func list(_ wire: Wire) -> some View {
        let all = wire.articles ?? []
        let breaking = all.filter { $0.isBreaking }
        let rest = all.filter { !$0.isBreaking }

        return ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                if !breaking.isEmpty {
                    Section {
                        ForEach(breaking) { row($0) }
                    } header: {
                        SectionHeader(text: "Breaking", trailing: "\(breaking.count)")
                    }
                }

                Section {
                    ForEach(rest) { row($0) }
                } header: {
                    // "Nothing is breaking" and "nobody scored this" are
                    // different facts, and the server ships `classified` so
                    // the difference can be told. Silently showing an
                    // unfiltered wire under a BREAKING header would be the
                    // confession dressed as the quiet day.
                    SectionHeader(text: "The wire",
                                  trailing: wire.classified == false ? "unscored" : nil)
                }

                feedRollCall(wire)
            }
        }
        .refreshable { await store.refresh() }
    }

    private func row(_ a: Article) -> some View {
        // The held badge is what makes this our wire rather than a news
        // app, so it is the solid chip: our colour, filled.
        Link(destination: URL(string: a.url ?? "") ?? URL(string: "https://thegriffinfund.org")!) {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(a.title ?? "Untitled")
                    .font(Type.headline)
                    .foregroundStyle(T.white)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: Space.s) {
                    if let t = a.heldTicker {
                        // Tapping the badge opens the name rather than the
                        // article: the reason a held-name headline is worth
                        // a badge at all is that you want the position.
                        NavigationLink(value: TickerScreen(symbol: t)) {
                            Chip(text: t, tone: T.amber, style: .solid)
                        }
                        .buttonStyle(.plain)
                    }
                    if let s = a.source { Chip(text: s, tone: T.orange) }
                    Spacer(minLength: 0)
                    Text(Fmt.shortDateTime(a.publishedAt))
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                }
            }
            .padding(.vertical, Space.m)
            .padding(.horizontal, Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .edgeStrip(a.isBreaking ? T.negative : nil)
            .hairline()
        }
        .buttonStyle(.plain)
    }

    /// Which wires actually returned anything. A feed that quietly died
    /// once served the same fifteen headlines for eighteen months and
    /// counted as healthy the whole time, because only errors skipped it.
    @ViewBuilder private func feedRollCall(_ wire: Wire) -> some View {
        if let feeds = wire.sources?.feeds, !feeds.isEmpty {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("SOURCES").font(Type.label).tracking(0.8).foregroundStyle(T.muted)
                ForEach(feeds.sorted(by: { ($0.source ?? "") < ($1.source ?? "") })) { f in
                    HStack {
                        Text(f.source ?? "?").font(Type.meta).foregroundStyle(T.dim)
                        Spacer()
                        Text(f.items == 0 ? "silent" : "\(f.items ?? 0)")
                            .font(Type.meta)
                            .foregroundStyle(f.items == 0 ? T.negative : T.muted)
                    }
                }
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
