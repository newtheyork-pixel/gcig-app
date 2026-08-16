import SwiftUI

// Tapping a position had nowhere to go, which was most of "you can't click
// on a stock and see anything about it".
//
// The screen paints instantly from what the row already knew, then fills in
// the market data and the club's own record behind it. Two separate loads,
// deliberately: the position is ours and always available, the quote comes
// from Finnhub or Yahoo and may not arrive at all. A failed quote must never
// be the reason a member cannot see what we own.

@MainActor
final class HoldingStore: ObservableObject {
    @Published private(set) var info: Loadable<TickerInfo> = .loading
    /// Silent on failure. The club record is context, not the subject, and a
    /// coverage query that fails should leave no wreckage on the screen.
    @Published private(set) var coverage: Coverage?

    func load(_ ticker: String) async {
        async let a: Void = loadInfo(ticker)
        async let b: Void = loadCoverage(ticker)
        _ = await (a, b)
    }

    private func loadInfo(_ ticker: String) async {
        do {
            info = .loaded(try await API.shared.get("/holdings/info/\(ticker)", as: TickerInfo.self),
                           at: Date())
        } catch APIError.cancelled {
            return
        } catch {
            info = .failed(error.localizedDescription)
        }
    }

    private func loadCoverage(_ ticker: String) async {
        coverage = try? await API.shared.get("/holdings/coverage/\(ticker)", as: Coverage.self)
    }
}

/// A single name. Reachable from the book, the wire and the watchlist, so
/// it cannot require a position: `holding` is nil for a ticker we do not
/// own, and the "our position" section simply does not exist for it. That
/// absence is the honest rendering — a zero-filled position block would
/// claim we hold something we do not.
struct TickerScreen: View, Hashable {
    let symbol: String
    var holding: Holding? = nil

    @StateObject private var store = HoldingStore()

    private var ticker: String { symbol.uppercased() }

    static func == (a: TickerScreen, b: TickerScreen) -> Bool { a.symbol == b.symbol }
    func hash(into h: inout Hasher) { h.combine(symbol) }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                quoteBlock
                positionSection
                marketSection
                clubSection
                aboutSection
            }
        }
        .background(T.bg)
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: Space.s) {
                    Text(ticker).font(Type.screenCode).foregroundStyle(T.white)
                    Text("DES").font(Type.screenTitle).tracking(0.8).foregroundStyle(T.white)
                }
            }
        }
        .toolbarBackground(T.redBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task { await store.load(ticker) }
    }

    // MARK: the number

    /// Prefers the live quote and falls back to the sheet's mark, saying
    /// which it used. A price with no provenance on a screen that also shows
    /// a sheet mark is a number nobody can check.
    private var quoteBlock: some View {
        let live = store.info.value
        let price = live?.price ?? holding?.price
        let chg = live?.dayChange ?? holding?.dayChange
        let pct = live?.dayChangePct ?? holding?.dayChangePct
        let fromLive = live?.price != nil

        return VStack(alignment: .leading, spacing: Space.s) {
            Text(holding?.name ?? live?.name ?? ticker)
                .font(Type.headline)
                .foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                Text(Fmt.money(price, decimals: 2))
                    .font(Type.valueBig)
                    .foregroundStyle(T.white)
                    .tickFlash(price)
                if chg != nil {
                    Text("\(Fmt.moneyDelta(chg, decimals: 2))  \(Fmt.pct(pct))")
                        .font(Type.delta)
                        .foregroundStyle(T.delta(chg))
                }
            }

            HStack(spacing: Space.s) {
                Chip(text: fromLive ? (live?.exchange ?? "Live") : "Sheet mark",
                     tone: fromLive ? T.orange : T.muted)
                if let s = live?.sector { Chip(text: s, tone: T.muted) }
            }

            if let pos = live?.rangePosition,
               let lo = live?.fiftyTwoWeekLow, let hi = live?.fiftyTwoWeekHigh {
                rangeBar(pos: pos, lo: lo, hi: hi)
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }

    /// The 52-week band. A price on its own says nothing; where it sits in
    /// its own year is the cheapest context there is.
    private func rangeBar(pos: Double, lo: Double, hi: Double) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(T.border).frame(height: 3)
                    Rectangle()
                        .fill(T.amber)
                        .frame(width: 2, height: 11)
                        .offset(x: max(0, min(geo.size.width - 2, geo.size.width * pos)))
                }
                .frame(height: 11, alignment: .center)
            }
            .frame(height: 11)
            HStack {
                Text(Fmt.money(lo, decimals: 2)).font(Type.meta).foregroundStyle(T.muted)
                Spacer()
                Text("52 WEEK").font(Type.meta).foregroundStyle(T.muted)
                Spacer()
                Text(Fmt.money(hi, decimals: 2)).font(Type.meta).foregroundStyle(T.muted)
            }
        }
        .padding(.top, Space.xs)
    }

    // MARK: sections

    @ViewBuilder private var positionSection: some View {
        if let h = holding {
        Section {
            VStack(spacing: 0) {
                StatLine(label: "SHARES", value: Fmt.shares(h.shares))
                StatLine(label: "MARKET VALUE", value: Fmt.money(h.marketValue, decimals: 2))
                StatLine(label: "AVERAGE COST", value: Fmt.money(h.costBasis, decimals: 2))
                StatLine(label: "UNREALISED",
                         value: h.gainLoss == nil ? "—"
                            : "\(Fmt.moneyDelta(h.gainLoss, decimals: 2))  \(Fmt.pct(h.gainLossPct))",
                         tone: T.delta(h.gainLoss))
                StatLine(label: "TODAY",
                         value: h.dayChangeValue == nil ? "—"
                            : Fmt.moneyDelta(h.dayChangeValue, decimals: 2),
                         tone: T.delta(h.dayChange))
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.s)
            .background(T.card)
            .hairline()
        } header: {
            SectionHeader(text: "Our position")
        }
        }
    }

    private var marketSection: some View {
        Section {
            Group {
                switch store.info {
                case .loading:
                    HStack(spacing: Space.s) {
                        ProgressView().tint(T.amber)
                        Text("Loading quote").font(Type.meta).foregroundStyle(T.muted)
                    }
                    .padding(Space.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
                case .failed(let msg):
                    // Named, and scoped to this section. The position above
                    // is ours and stays on screen regardless.
                    Text("Quote unavailable. \(msg)")
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                        .padding(Space.l)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .loaded(let i, _), .stale(let i, _):
                    VStack(spacing: 0) {
                        StatLine(label: "PREV CLOSE", value: Fmt.money(i.previousClose, decimals: 2))
                        StatLine(label: "MARKET CAP", value: Fmt.compact(i.marketCap))
                        StatLine(label: "P/E TRAILING", value: Fmt.multiple(i.trailingPE))
                        StatLine(label: "P/E FORWARD", value: Fmt.multiple(i.forwardPE))
                        StatLine(label: "BETA", value: i.beta == nil ? "—" : String(format: "%.2f", i.beta!))
                        StatLine(label: "DIV YIELD", value: Fmt.pct(i.dividendYield, signed: false))
                        StatLine(label: "INDUSTRY", value: i.industry ?? "—")
                    }
                    .padding(.horizontal, Space.l)
                    .padding(.vertical, Space.s)
                    .background(T.card)
                    .hairline()
                }
            }
        } header: {
            SectionHeader(text: "Market")
        }
    }

    /// The club's own record. This is the part no market-data app can show,
    /// and the reason to open ours instead of Yahoo.
    @ViewBuilder private var clubSection: some View {
        if let c = store.coverage, !c.isEmpty {
            Section {
                VStack(spacing: 0) {
                    ForEach(Array((c.pitches ?? []).prefix(4).enumerated()), id: \.offset) { _, p in
                        Row(title: p.title ?? "Pitch",
                            subtitle: p.recommendation,
                            meta: Fmt.day(p.date))
                    }
                    ForEach(Array((c.reports ?? []).prefix(4).enumerated()), id: \.offset) { _, r in
                        Row(title: r.title ?? "Report",
                            subtitle: r.author,
                            meta: Fmt.day(r.date))
                    }
                    ForEach(Array((c.research ?? []).prefix(3).enumerated()), id: \.offset) { _, r in
                        Row(title: r.name ?? "Research",
                            subtitle: [r.status, r.analyst].compactMap { $0 }.joined(separator: " · "),
                            meta: r.buyBelow.map { "Buy below \(Fmt.money($0, decimals: 2))" })
                    }
                }
            } header: {
                SectionHeader(text: "Club record")
            }
        }
    }

    @ViewBuilder private var aboutSection: some View {
        if let prose = store.info.value?.prose {
            Section {
                Text(prose)
                    .font(Type.body)
                    .foregroundStyle(T.dim)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(Space.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T.card)
                    .hairline()
            } header: {
                SectionHeader(text: "About")
            }
        }
    }
}
