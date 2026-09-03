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
    /// The chart is a second request and must never gate the screen: a
    /// missing line is a missing line, not a failed name.
    @Published private(set) var chart: [ChartPoint] = []
    /// Nil when the chart is fine. A sentence rather than a bool, because
    /// the three ways this fails are three different facts and only one of
    /// them is about the company.
    @Published private(set) var chartError: String?
    /// Three more best-effort reads, each silent on failure for the same
    /// reason the coverage query is: they are context around the name, and
    /// a missing analyst count must never be why the company does not
    /// appear.
    @Published private(set) var filings: [Filing] = []
    @Published private(set) var estimates: Estimates?
    @Published private(set) var consensus: Consensus.Row?

    func load(_ ticker: String) async {
        // Concurrent rather than sequential: five independent reads, and
        // the slowest of them should be the wait, not the sum.
        async let a: Void = loadInfo(ticker)
        async let b: Void = loadCoverage(ticker)
        async let c: Void = loadFilings(ticker)
        async let d: Void = loadEstimates(ticker)
        async let e: Void = loadConsensus(ticker)
        _ = await (a, b, c, d, e)
    }

    private func loadFilings(_ ticker: String) async {
        let p = try? await API.shared.get("/holdings/\(ticker)/filings", as: FilingsPayload.self)
        filings = p?.filings ?? []
    }

    private func loadEstimates(_ ticker: String) async {
        estimates = try? await API.shared.get("/terminal/earnings/\(ticker)", as: Estimates.self)
    }

    private func loadConsensus(_ ticker: String) async {
        consensus = (try? await API.shared.get("/terminal/consensus/\(ticker)", as: Consensus.self))?.latest
    }

    /// Same keep-the-numbers rule as every other store: this screen now has
    /// a pull-to-refresh, and a refresh that fails must not replace a quote
    /// the member is reading with "Quote unavailable".
    private func loadInfo(_ ticker: String) async {
        let previous = info.value
        do {
            info = .loaded(try await API.shared.get("/holdings/info/\(ticker)", as: TickerInfo.self),
                           at: Date())
        } catch APIError.cancelled {
            return
        } catch {
            let msg = error.localizedDescription
            info = previous != nil ? .stale(previous!, msg) : .failed(msg)
        }
    }

    private func loadCoverage(_ ticker: String) async {
        coverage = try? await API.shared.get("/holdings/coverage/\(ticker)", as: Coverage.self)
    }

    /// The range picker is the whole interaction on this screen, so tapping
    /// 1M then 3M before the first finishes is ordinary use, not a contrived
    /// race. `.task(id: range)` cancels the superseded request; a bare `try?`
    /// then flattened that cancellation into the same nil as a real failure
    /// and the cancelled task went on to write `chartFailed = true` over a
    /// perfectly good chart. Every other loader in this file already catches
    /// `.cancelled` explicitly; this one now does too.
    ///
    /// The 403 case matters just as much. `/terminal/*` requires Analyst,
    /// and the default role for a new member is below it — so for them this
    /// swallowed a permission denial and printed "No price history available
    /// for this name", which is our own gate reported as a fact about the
    /// company. The repo's own rule forbids exactly that.
    func loadChart(_ ticker: String, range: ChartRange) async {
        do {
            let payload = try await API.shared.get("/terminal/chart/\(ticker)?range=\(range.rawValue)",
                                                   as: ChartPayload.self)
            chart = (payload.points ?? []).compactMap { p -> ChartPoint? in
                guard let t = p.t, let c = p.close else { return nil }
                return ChartPoint(t: t, close: c)
            }
            chartError = chart.isEmpty ? "No price history available for this name." : nil
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden {
            chart = []
            chartError = "Price history needs Analyst access."
        } catch {
            chart = []
            chartError = "The price history did not load. \(error.localizedDescription)"
        }
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
    @State private var range: ChartRange = .m6

    private var ticker: String { symbol.uppercased() }

    static func == (a: TickerScreen, b: TickerScreen) -> Bool { a.symbol == b.symbol }
    func hash(into h: inout Hasher) { h.combine(symbol) }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                quoteBlock
                chartSection
                positionSection
                marketSection
                // Why it moved, before what it is. A member opening a name
                // that gapped down wants the reason above the fundamentals.
                TickerNewsSection(ticker: ticker)
                earningsSection
                consensusSection
                // Fundamentals, statements, insiders, peers, dividends and
                // short interest. Each loads and fails on its own; none of
                // them is allowed to be why the quote above is missing.
                NameDetailSections(ticker: ticker)
                filingsSection
                clubSection
                // Last, because it is the one thing here you write rather
                // than read, and it should sit under everything it is about.
                TickerNotesSection(ticker: ticker)
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
        // The quote block calls itself "Live". It was not: there was no
        // refresh path of any kind after the first load, so a member could
        // sit on a twenty-minute-old number that the screen labelled live.
        // Pull to refresh, and the as-of stamp in the quote block says when
        // the number is actually from.
        .refreshable {
            await store.load(ticker)
            await store.loadChart(ticker, range: range)
        }
        .task { await store.load(ticker) }
        .task(id: range) { await store.loadChart(ticker, range: range) }
    }

    /// Priced against what we paid, when we own it. A line with no cost
    /// rule answers "what did the market do"; with one it answers "how are
    /// we doing", which is the question somebody opening our app has.
    @ViewBuilder private var chartSection: some View {
        VStack(spacing: Space.s) {
            if let msg = store.chartError, store.chart.isEmpty {
                Text(msg)
                    .font(Type.meta).foregroundStyle(T.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, Space.l)
            } else {
                PriceChart(points: store.chart, averageCost: position?.costBasis)
                if position?.costBasis != nil && !store.chart.isEmpty {
                    HStack(spacing: Space.xs) {
                        Rectangle().fill(T.amber.opacity(0.7)).frame(width: 10, height: 1)
                        Text("Our average cost").font(Type.meta).foregroundStyle(T.muted)
                        Spacer()
                    }
                }
            }
            RangePicker(range: $range)
        }
        .padding(Space.l)
        .background(T.card)
        .hairline()
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

    /// The position the coverage payload reports, used when this screen was
    /// not opened from the Book.
    ///
    /// `holding` arrives only through the navigation link off BookScreen, so
    /// the SAME held name opened from the wire, the watchlist or Today's
    /// movers claimed we owned nothing — no position block, and no cost rule
    /// on the chart. The server has been sending `coverage.holding` all
    /// along. Market value is derived from the live quote rather than read,
    /// because the coverage row carries shares and cost and no mark.
    private var position: Holding? {
        if let h = holding { return h }
        guard let c = store.coverage?.holding, let shares = c.shares else { return nil }
        let price = store.info.value?.price
        return Holding(ticker: ticker,
                       name: c.name,
                       shares: shares,
                       price: price,
                       marketValue: price.map { $0 * shares },
                       costBasis: c.costBasis,
                       dayChange: store.info.value?.dayChange,
                       isCash: false)
    }

    @ViewBuilder private var positionSection: some View {
        if let h = position {
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
                    //
                    // With a retry, because the screen had none: a quote
                    // that failed once could only be reloaded by leaving
                    // the screen and coming back, which is not a thing
                    // anybody works out on their own.
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text("Quote unavailable. \(msg)")
                            .font(Type.meta)
                            .foregroundStyle(T.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: Space.s)
                        Button("RETRY") { Task { await store.load(ticker) } }
                            .font(Type.chip)
                            .foregroundStyle(T.cyan)
                            .buttonStyle(.plain)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                        .padding(.horizontal, Space.l)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .loaded(let i, _), .stale(let i, _):
                    VStack(spacing: 0) {
                        StatLine(label: "PREV CLOSE", value: Fmt.money(i.previousClose, decimals: 2))
                        StatLine(label: "MARKET CAP", value: Fmt.compact(i.marketCap))
                        StatLine(label: "P/E TRAILING", value: Fmt.multiple(i.trailingPE))
                        StatLine(label: "P/E FORWARD", value: Fmt.multiple(i.forwardPE))
                        StatLine(label: "BETA", value: i.beta == nil ? "—" : String(format: "%.2f", i.beta!))
                        StatLine(label: "DIV YIELD", value: Fmt.pct(i.dividendYieldPct, signed: false))
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

    /// Next report, then how the last four went. The beat/miss column is
    /// derived from the two EPS figures rather than read from surprisePct,
    /// which older rows do not carry.
    @ViewBuilder private var earningsSection: some View {
        if let e = store.estimates, e.upcoming != nil || !(e.history ?? []).isEmpty {
            Section {
                VStack(spacing: 0) {
                    if let u = e.upcoming, u.date != nil {
                        StatLine(label: "NEXT REPORT", value: Fmt.day(u.date))
                        if let est = u.epsEstimate {
                            StatLine(label: "EPS ESTIMATE", value: String(format: "%.2f", est))
                        }
                    }
                    ForEach((e.history ?? []).prefix(4)) { h in
                        StatLine(
                            label: h.period.map { Fmt.day($0) } ?? "—",
                            value: h.epsActual == nil ? "—"
                                : "\(String(format: "%.2f", h.epsActual!)) vs \(h.epsEstimate.map { String(format: "%.2f", $0) } ?? "—")",
                            tone: h.beat == nil ? T.white : (h.beat! ? T.positive : T.negative))
                    }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "Earnings")
            }
        }
    }

    /// A bar rather than five numbers. The only question a reader has here
    /// is which way the street leans and how many of them there are.
    @ViewBuilder private var consensusSection: some View {
        if let c = store.consensus, c.total > 0 {
            Section {
                VStack(alignment: .leading, spacing: Space.s) {
                    GeometryReader { geo in
                        HStack(spacing: 1) {
                            block(c.bullish, c.total, geo.size.width, T.positive)
                            block(c.hold ?? 0, c.total, geo.size.width, T.muted)
                            block(c.bearish, c.total, geo.size.width, T.negative)
                        }
                    }
                    .frame(height: 10)
                    HStack {
                        Text("\(c.bullish) buy").font(Type.meta).foregroundStyle(T.positive)
                        Text("\(c.hold ?? 0) hold").font(Type.meta).foregroundStyle(T.muted)
                        Text("\(c.bearish) sell").font(Type.meta).foregroundStyle(T.negative)
                        Spacer()
                        Text("\(c.total) analysts").font(Type.meta).foregroundStyle(T.muted)
                    }
                }
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "The street")
            }
        }
    }

    private func block(_ n: Int, _ total: Int, _ width: CGFloat, _ tone: Color) -> some View {
        Rectangle().fill(tone)
            .frame(width: total > 0 ? width * CGFloat(n) / CGFloat(total) : 0)
    }

    /// What the company has actually told the SEC, newest first. An 8-K is
    /// marked because it is the one form that behaves like news: something
    /// happened and they had four days to say so.
    @ViewBuilder private var filingsSection: some View {
        if !store.filings.isEmpty {
            Section {
                ForEach(store.filings.prefix(8)) { f in
                    Link(destination: URL(string: f.url ?? "") ?? URL(string: "https://www.sec.gov")!) {
                        Row(title: f.form ?? "Filing",
                            subtitle: f.description,
                            meta: Fmt.day(f.filingDate),
                            strip: f.isEvent ? T.orange : nil) {
                            if f.isAnnual { Chip(text: "Annual", tone: T.blue) }
                            else if f.isEvent { Chip(text: "Event", tone: T.orange) }
                        }
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                SectionHeader(text: "Filings", trailing: "\(store.filings.count)")
            }
        }
    }

    /// The club's own record. This is the part no market-data app can show,
    /// and the reason to open ours instead of Yahoo.
    @ViewBuilder private var clubSection: some View {
        if let c = store.coverage, !c.isEmpty {
            Section {
                VStack(spacing: 0) {
                    // What the club DECIDED, which is the whole point of the
                    // section and was the one part never drawn. The rows
                    // were decoded into a shape the server does not send and
                    // then dropped on the floor.
                    ForEach((c.decisions ?? []).prefix(4), id: \.stableId) { d in
                        Row(title: decisionTitle(d),
                            subtitle: d.synthesis,
                            meta: Fmt.day(d.closedAt),
                            strip: decisionTone(d)) {
                            if let n = d.ballots, n > 0 {
                                Chip(text: "\(n) ballot\(n == 1 ? "" : "s")", tone: T.muted)
                            }
                        }
                    }
                    ForEach((c.pitches ?? []).prefix(4), id: \.stableId) { p in
                        Row(title: p.who.map { "Pitched by \($0)" } ?? "Pitch",
                            subtitle: p.where_,
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

    /// "Voted Buy · $4,200 average" reads as a decision. "Buy" alone reads
    /// as a recommendation somebody is making now, which is a different
    /// claim about a closed vote.
    private func decisionTitle(_ d: Coverage.Decision) -> String {
        let verdict = d.decision ?? "Closed"
        guard let p = d.proposed, let avg = p.avg else {
            return "\(d.question): \(verdict)"
        }
        let sized = p.fixed == true ? "\(Fmt.money(avg)) fixed"
                                    : "\(Fmt.money(avg)) average"
        return "\(d.question): \(verdict) · \(sized)"
    }

    private func decisionTone(_ d: Coverage.Decision) -> Color? {
        switch d.decision {
        case "Buy":  return T.positive
        case "Sell": return T.negative
        default:     return nil
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
