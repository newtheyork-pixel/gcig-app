import SwiftUI

// PM — the whole book.
//
// Shape from getSheetPortfolio. Cash rows come back with isCash set and
// no ticker worth showing, so they are separated rather than sorted in
// among the positions: cash at a 100% "weight of itself" in a column of
// equity weights is noise.
//
// Two feeds, the web Portfolio.jsx split. The SHEET is the system of
// record for the book itself — which names, shares, cost — and is
// fetched once, plus manual Retry. Re-polling it was this panel's dead
// end: the sheet read is server-cached far longer than any sane poll,
// so a 45s re-fetch returned identical numbers and the tick flash had
// nothing to fire on. Price marks instead go live off
// GET /terminal/quotes on a 20s loop while the panel is open — 20s is
// also the server's per-ticker quote TTL (liveQuotes.QUOTE_TTL_MS), so
// most polls can actually carry a new print — and every number that
// moves with price re-marks off it: last, market value, weight, day
// P&L, and the header total.
struct PortfolioPanel: View {
    struct Holding: Decodable, Identifiable {
        let ticker: String?
        let name: String?
        let sector: String?
        let shares: Double?
        /// Average price paid per share, not the position's total cost.
        let costBasis: Double?
        let price: Double?
        let marketValue: Double?
        let dayChange: Double?
        let portfolioPct: Double?
        /// Unrealized, since purchase. The server computes both so the
        /// panel does not have to guess at partial fills.
        let dollarReturn: Double?
        let percentReturn: Double?
        /// Year to date, PRICE only. Dividends are not in the bar cache,
        /// so a payer is understated and the header says so.
        let ytdReturn: Double?
        let isCash: Bool?
        var id: String { (ticker ?? name ?? UUID().uuidString) }

        /// What the position cost in total, which is what a reader means
        /// by "cost basis" even though the sheet stores the per-share.
        var totalCost: Double? {
            guard let s = shares, let c = costBasis else { return nil }
            return s * c
        }
    }

    /// What the club itself has on a name: a pitch, a closed vote, a
    /// written report. Counts rather than contents — this paints a
    /// column, and the panel that wants the ballots is DES.
    struct Cov: Decodable {
        let pitches: Int?; let reports: Int?; let votes: Int?
        let deck: Bool?; let lastPitch: String?
        let lastDecision: Decision?
        struct Decision: Decodable {
            let decision: String?; let kind: String?
            let closedAt: String?; let ballots: Int?
        }
        var isEmpty: Bool { (pitches ?? 0) == 0 && (votes ?? 0) == 0 && (reports ?? 0) == 0 }
    }

    struct CovPayload: Decodable { let coverage: [String: Cov]? }

    struct Totals: Decodable {
        let totalValue: Double?
        let totalCost: Double?
        let totalGainLoss: Double?
        let totalGainLossPct: Double?
        let cashValue: Double?
    }

    struct Payload: Decodable {
        let holdings: [Holding]?
        let totals: Totals?
        let fetchedAt: String?
        let source: String?
    }

    /// One /terminal/quotes value. changePct (Finnhub `dp`, ALREADY a
    /// percent) is deliberately not decoded: every number PM shows is
    /// dollars, and last − prevClose covers the day move without ever
    /// touching the percent-vs-fraction trap MOVR converts across. A
    /// ticker Finnhub missed comes back as JSON null and never lands
    /// in `quotes`, so a miss keeps what the cell was already showing.
    struct Quote: Decodable {
        let last: Double?
        let prevClose: Double?
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var quotes: [String: Quote] = [:]
    @State private var coverage: [String: Cov] = [:]

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { ($0.holdings ?? []).isEmpty },
                   emptyText: "The positions sheet came back empty.",
                   retry: { Task { await load() } }) { p in
            let all = (p.holdings ?? []).map(merged)
            let positions = all.filter { !($0.isCash ?? false) }
            let cash = all.filter { $0.isCash ?? false }
            // The web's NAV: re-summed from the marked rows so the
            // header total moves with the live prices. Until the first
            // quote lands the marks are the sheet's own, and the
            // sheet's stated total wins when it carries one.
            let total = quotes.isEmpty
                ? (p.totals?.totalValue ?? all.compactMap(\.marketValue).reduce(0, +))
                : all.compactMap(\.marketValue).reduce(0, +)

            VStack(alignment: .leading, spacing: 0) {
                header(p, total: total, n: positions.count)
                Divider().overlay(Term.border)
                // Twelve columns do not fit a narrow pane and do not
                // compress, so the table scrolls in both directions
                // rather than being truncated at the pane wall. The
                // column heads and the totals are pinned: they are the
                // two lines you need on screen no matter how far down or
                // across the book you have scrolled.
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0,
                               pinnedViews: [.sectionHeaders, .sectionFooters]) {
                        Section {
                            ForEach(positions) { h in row(h, total: total) }
                            if !cash.isEmpty {
                                Divider().overlay(Term.border).padding(.vertical, 4)
                                ForEach(cash) { c in cashRow(c, total: total) }
                            }
                        } header: {
                            VStack(alignment: .leading, spacing: 0) {
                                columnHeads
                                Divider().overlay(Term.border)
                            }
                            .background(Term.bgPanel)
                        } footer: {
                            VStack(alignment: .leading, spacing: 0) {
                                Divider().overlay(Term.border)
                                totalsRow(positions, cash: cash, total: total)
                            }
                        }
                    }
                    .frame(minWidth: Self.tableMinWidth, alignment: .leading)
                }
            }
        }
        .task {
            await load()
            // Only the quote overlay loops. The sheet is never
            // re-fetched here, so loading / failed / empty stay owned
            // by load() and the Retry button alone — the loop just
            // reads whatever the loaded book says to poll.
            while !Task.isCancelled {
                await pollQuotes()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    /// Overlay a live quote onto a sheet holding — the web's buildRow,
    /// kept in dollars end to end. Price is the live last when we have
    /// one; market value re-marks as shares × last when shares are
    /// known; day P&L is shares × (last − prevClose) when both prints
    /// are known. Fallbacks are the sheet's own numbers, so a Finnhub
    /// miss never blanks a cell.
    ///
    /// One unit note on the day fallback: the sheet's dayChange column
    /// is PER-SHARE dollars (see sheetPortfolio.js and the web's
    /// buildRow), so it is multiplied by shares to land in the same
    /// position-level dollars as the live math. Rendering it raw — as
    /// this panel once did — understated every day move by a factor of
    /// the share count.
    private func merged(_ h: Holding) -> Holding {
        if h.isCash ?? false { return h }
        let q = h.ticker.flatMap { quotes[$0.uppercased()] }
        let last = q?.last ?? h.price
        let mv: Double?
        if let s = h.shares, let l = last {
            mv = s * l
        } else {
            mv = h.marketValue
        }
        let day: Double?
        if let s = h.shares, let l = q?.last, let pc = q?.prevClose {
            day = s * (l - pc)
        } else if let s = h.shares, let d = h.dayChange {
            day = s * d
        } else if let mv, let p = h.price, let d = h.dayChange, p - d > 0 {
            // Sharesless fallback, the web's: recover the day fraction
            // from the per-share pair and apply it to position value.
            day = mv - mv / (1 + d / (p - d))
        } else {
            day = nil
        }
        // Unrealized recomputes off the LIVE price, which is the whole
        // point of the overlay: a P&L that stops at the sheet's mark is
        // yesterday's P&L wearing today's price beside it. YTD stays as
        // the server sent it, since its base year-open is not something
        // a quote can supply. Weight is dropped so the row derives it
        // from the live total rather than the sheet's stale one.
        var upl: Double? = nil
        var uplPct: Double? = nil
        if let c = h.costBasis, let sh = h.shares, let l = last {
            upl = (l - c) * sh
            if c > 0 { uplPct = ((l - c) / c) * 100 }
        } else {
            upl = h.dollarReturn
            uplPct = h.percentReturn
        }
        return Holding(ticker: h.ticker, name: h.name, sector: h.sector, shares: h.shares,
                       costBasis: h.costBasis, price: last,
                       marketValue: mv, dayChange: day, portfolioPct: nil,
                       dollarReturn: upl, percentReturn: uplPct,
                       ytdReturn: h.ytdReturn, isCash: h.isCash)
    }

    // The live tap. A failed poll returns silently and the last good
    // overlay stands — same swallow as the web's useLiveRefresh — and
    // per-ticker nulls are skipped, so a value is never wiped to nil.
    private func pollQuotes() async {
        guard case .loaded(let p) = state else { return }
        let tickers = Set((p.holdings ?? [])
            .filter { !($0.isCash ?? false) }
            .compactMap { $0.ticker?.uppercased() })
        guard !tickers.isEmpty else { return }
        let key = tickers.sorted().joined(separator: ",")
        guard let data = try? await API.shared.get("/terminal/quotes",
                                                   query: ["tickers": key]),
              let q = try? await API.shared.decode([String: Quote?].self,
                                                   from: data) else { return }
        for (t, v) in q { if let v { quotes[t] = v } }
    }

    private func header(_ p: Payload, total: Double, n: Int) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Portfolio")
            Text("\(n) positions")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            Spacer()
            // Said once, here, rather than in the YTD cells: the bar
            // cache carries no distributions, so a dividend payer's YTD
            // is its price return and is understated. Better a caveat a
            // reader can see than a column that quietly means something
            // narrower than its heading.
            Text("YTD IS PRICE ONLY")
                .font(Term.mono(9)).foregroundStyle(Term.fgDim)
            Text(Fmt.money(total))
                .font(Term.mono(13, weight: .bold))
                .foregroundStyle(Term.white)
                .tickFlash(total)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    // The table is ONE list of fields and every line renders by walking
    // it. This began as two hand-typed lists, a header and a row, and
    // they drifted: the header grew to eleven columns while the row
    // still drew six, so every number sat under the wrong heading and
    // AVG COST, COST, SINCE BUY, % and YTD were advertised and never
    // rendered. Titles, widths and cells now come from the same enum,
    // and because each cell builder is an exhaustive switch, a column
    // added here will not compile until the position row, the cash line
    // and the totals have all said what they put in it.
    private enum Field: CaseIterable {
        case ticker, name, club, shares, avgCost, last, cost, value, wt, day, sinceBuy, pct, ytd

        var title: String {
            switch self {
            case .ticker:   return "TICKER"
            case .name:     return "NAME"
            case .club:     return "CLUB"
            case .shares:   return "SHARES"
            case .avgCost:  return "AVG COST"
            case .last:     return "LAST"
            case .cost:     return "COST"
            case .value:    return "VALUE"
            case .wt:       return "WT"
            case .day:      return "DAY"
            case .sinceBuy: return "SINCE BUY"
            case .pct:      return "%"
            case .ytd:      return "YTD"
            }
        }

        /// nil takes the slack, and exactly one column does.
        var width: CGFloat? {
            switch self {
            case .ticker:   return 58
            case .name:     return nil
            case .club:     return 54
            case .shares:   return 60
            case .avgCost:  return 72
            case .last:     return 72
            case .cost:     return 82
            case .value:    return 88
            case .wt:       return 50
            case .day:      return 70
            case .sinceBuy: return 88
            case .pct:      return 62
            case .ytd:      return 62
            }
        }

        var align: Alignment {
            switch self {
            case .ticker, .name: return .leading
            case .club: return .leading
            default: return .trailing   // every other column is a number
            }
        }
    }

    private static let gap: CGFloat = 8

    /// Every fixed column, a floor for the flexible one, the gaps and
    /// the row padding. Below this the table scrolls sideways instead of
    /// overflowing, and above it the NAME column takes the slack.
    private static var tableMinWidth: CGFloat {
        let fixed = Field.allCases.reduce(CGFloat.zero) { $0 + ($1.width ?? 140) }
        return fixed + CGFloat(Field.allCases.count - 1) * gap + 20
    }

    private func sized<V: View>(_ f: Field, @ViewBuilder _ content: () -> V) -> some View {
        Group {
            if let w = f.width {
                content().frame(width: w, alignment: f.align)
            } else {
                content().frame(minWidth: 0, maxWidth: .infinity, alignment: f.align)
            }
        }
    }

    private var columnHeads: some View {
        HStack(spacing: Self.gap) {
            ForEach(Field.allCases, id: \.self) { f in
                sized(f) { Text(f.title) }
            }
        }
        .font(Term.mono(9, weight: .bold))
        .foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func row(_ h: Holding, total: Double) -> some View {
        // Prefer the server's own weight; fall back to deriving it so a
        // sheet that stops sending the column does not blank a row.
        let weight = h.portfolioPct ?? ((total > 0 && h.marketValue != nil) ? h.marketValue! / total * 100 : nil)
        return HStack(spacing: Self.gap) {
            ForEach(Field.allCases, id: \.self) { f in
                sized(f) { cell(f, h, weight: weight) }
            }
        }
        .font(Term.mono(11))
        .foregroundStyle(Term.white)
        .padding(.horizontal, 10).padding(.vertical, 3)
    }


    // MARK: The club column

    /// Three lit letters: pitched, voted, written up.
    ///
    /// The alternative was a single word — FULL, PART, NONE — and it
    /// hides the distinction that matters. A name we voted on but never
    /// pitched (Applied Digital, 183 shares, six ballots, no deck) fails
    /// differently from one somebody pitched and the club never put to a
    /// vote, and a reader scanning twenty-five rows should be able to
    /// see which is which without opening anything.
    @ViewBuilder
    private func clubCell(_ h: Holding) -> some View {
        let c = coverage[Self.key(h.ticker)]
        HStack(spacing: 3) {
            mark("P", on: (c?.pitches ?? 0) > 0, help: pitchHelp(c))
            mark("V", on: (c?.votes ?? 0) > 0, help: voteHelp(c))
            mark("R", on: (c?.reports ?? 0) > 0,
                 help: (c?.reports ?? 0) > 0 ? "\(c!.reports!) report(s) in the archive" : "No written report")
        }
    }

    private func mark(_ letter: String, on: Bool, help: String) -> some View {
        Text(letter)
            .font(Term.mono(10, weight: on ? .bold : .regular))
            // Off is drawn, not omitted. A blank cell reads as "not
            // loaded"; a dim letter reads as "we checked, and no".
            .foregroundStyle(on ? Term.amber : Term.fgMuted.opacity(0.45))
            .help(help)
    }

    private func pitchHelp(_ c: Cov?) -> String {
        guard let c, (c.pitches ?? 0) > 0 else { return "Never pitched to the club" }
        let deck = (c.deck ?? false) ? "" : ", no deck attached"
        return "\(c.pitches!) pitch(es)" + (c.lastPitch.map { ", last \(Fmt.date($0))" } ?? "") + deck
    }

    private func voteHelp(_ c: Cov?) -> String {
        guard let c, let d = c.lastDecision else { return "No closed vote on file" }
        return [d.decision, d.closedAt.map { Fmt.date($0) }, d.ballots.map { "\($0) ballots" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// The server keys this map through its own ticker resolver, which
    /// folds case and the dot/dash share-class convention. Matching it
    /// here is four characters; getting it wrong would silently blank
    /// the column for exactly the names most likely to be misfiled.
    static func key(_ raw: String?) -> String {
        (raw ?? "").trimmingCharacters(in: .whitespaces).uppercased()
            .replacingOccurrences(of: ".", with: "-")
    }

    /// What those positions are, and what fraction of the book they
    /// are, because two names is a footnote and 44% of equity is not.
    private var uncoveredHelp: String {
        guard case .loaded(let p) = state, !coverage.isEmpty else {
            return "Our own record has not loaded"
        }
        let eq = (p.holdings ?? []).filter { !($0.isCash ?? false) }
        let bare = eq.filter { (coverage[Self.key($0.ticker)]?.isEmpty ?? true) }
        let total = eq.reduce(0.0) { $0 + ($1.marketValue ?? 0) }
        let share = bare.reduce(0.0) { $0 + ($1.marketValue ?? 0) }
        let names = bare.compactMap { $0.ticker }.joined(separator: ", ")
        let pct = total > 0 ? Fmt.pct(share / total * 100, decimals: 0, signed: false) : "—"
        return "No pitch, no closed vote, no report on file: \(names) — \(pct) of equity"
    }

    /// Positions we own with nothing on file. Cash excluded — nobody
    /// pitches cash.
    private var uncoveredCount: Int {
        guard case .loaded(let p) = state else { return 0 }
        guard !coverage.isEmpty else { return 0 }   // not loaded is not zero
        return (p.holdings ?? []).filter { !($0.isCash ?? false) }
            .filter { (coverage[Self.key($0.ticker)]?.isEmpty ?? true) }.count
    }

    @ViewBuilder
    private func cell(_ f: Field, _ h: Holding, weight: Double?) -> some View {
        switch f {
        case .ticker:
            // Drill-down: the ticker is a door, same as the web.
            Button {
                if let t = h.ticker {
                    NotificationCenter.default.post(name: .runCommand, object: "\(t) DES")
                }
            } label: {
                Text(h.ticker ?? "—")
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
        case .name:
            Text(h.name ?? "")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                .lineLimit(1).truncationMode(.tail)
        case .club:
            clubCell(h)
        case .shares:
            Text(h.shares.map { Fmt.money($0, decimals: 0) } ?? "—")
        case .avgCost:
            // Per-share paid, sitting beside the per-share mark, because
            // those are the two numbers a reader compares.
            Text(Fmt.money(h.costBasis)).foregroundStyle(Term.fgDim)
        case .last:
            Text(Fmt.money(h.price)).tickFlash(h.price)
        case .cost:
            Text(Fmt.money(h.totalCost, decimals: 0)).foregroundStyle(Term.fgDim)
        case .value:
            Text(Fmt.money(h.marketValue, decimals: 0)).tickFlash(h.marketValue)
        case .wt:
            Text(weight.map { Fmt.pct($0, decimals: 1, signed: false) } ?? "—")
        case .day:
            Text(h.dayChange.map { Fmt.money($0, decimals: 0) } ?? "—")
                .foregroundStyle(Term.delta(h.dayChange)).tickFlash(h.dayChange)
        case .sinceBuy:
            Text(h.dollarReturn.map { Fmt.money($0, decimals: 0) } ?? "—")
                .foregroundStyle(Term.delta(h.dollarReturn))
        case .pct:
            Text(h.percentReturn.map { Fmt.pct($0, decimals: 1) } ?? "—")
                .foregroundStyle(Term.delta(h.percentReturn))
        case .ytd:
            Text(h.ytdReturn.map { Fmt.pct($0, decimals: 1) } ?? "—")
                .foregroundStyle(Term.delta(h.ytdReturn))
        }
    }

    private func cashRow(_ c: Holding, total: Double) -> some View {
        let weight = (total > 0 && c.marketValue != nil) ? c.marketValue! / total * 100 : nil
        return HStack(spacing: Self.gap) {
            ForEach(Field.allCases, id: \.self) { f in
                sized(f) { cashCell(f, c, weight: weight) }
            }
        }
        .font(Term.mono(11))
        .padding(.horizontal, 10).padding(.vertical, 3)
    }

    @ViewBuilder
    private func cashCell(_ f: Field, _ c: Holding, weight: Double?) -> some View {
        switch f {
        case .ticker:
            Text("CASH").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.cyan)
        case .value:
            Text(Fmt.money(c.marketValue, decimals: 0)).foregroundStyle(Term.white)
        case .wt:
            Text(weight.map { Fmt.pct($0, decimals: 1, signed: false) } ?? "—")
                .foregroundStyle(Term.fgDim)
        case .name, .club, .shares, .avgCost, .last, .cost, .day, .sinceBuy, .pct, .ytd:
            // Cash has no basis, no mark and no share count. These stay
            // empty rather than zero: a zero reads as a measured value.
            // Nobody pitches cash either.
            Text("")
        }
    }

    /// The book's own line, summed from the MARKED rows rather than read
    /// off the payload, so it agrees with the header total and with
    /// every row above it the moment a live print lands.
    private struct BookTotals {
        let positions: Int
        let hasCash: Bool
        /// nil when no position carries a basis, which is not the same
        /// as a book that cost nothing.
        let cost: Double?
        let value: Double
        let wt: Double?
        let day: Double
        let upl: Double?
        let uplPct: Double?
    }

    private func totalsRow(_ positions: [Holding], cash: [Holding], total: Double) -> some View {
        let costs = positions.compactMap(\.totalCost)
        let cost = costs.isEmpty ? nil : costs.reduce(0, +)
        let invested = positions.compactMap(\.marketValue).reduce(0, +)
        // Cost excludes cash, which has no basis, so the percentage is
        // return on invested money and not on the account.
        let t = BookTotals(
            positions: positions.count,
            hasCash: !cash.isEmpty,
            cost: cost,
            value: total,
            wt: total > 0 ? invested / total * 100 : nil,
            day: positions.compactMap(\.dayChange).reduce(0, +),
            upl: cost.map { invested - $0 },
            uplPct: (cost.map { $0 > 0 } ?? false) ? (invested - cost!) / cost! * 100 : nil)
        return HStack(spacing: Self.gap) {
            ForEach(Field.allCases, id: \.self) { f in
                sized(f) { totalCell(f, t) }
            }
        }
        .font(Term.mono(11, weight: .bold))
        .foregroundStyle(Term.white)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Term.bgHeader)
    }

    @ViewBuilder
    private func totalCell(_ f: Field, _ t: BookTotals) -> some View {
        switch f {
        case .ticker:
            Text("TOTAL").font(Term.mono(10, weight: .bold)).foregroundStyle(Term.blue)
        case .name:
            Text("\(t.positions) positions" + (t.hasCash ? " plus cash" : ""))
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
        case .club:
            // The audit, in one cell. Stated, not judged: on the real
            // book the two names with no record are VOO and QQQ, which
            // is 44% of equity and is probably a deliberate decision to
            // park in the index rather than an oversight. Amber, not
            // red — the screen's job is to make sure nobody has to
            // remember this, not to call it a failure. The club does
            // pitch ETFs, so these two do stand apart, and the members
            // can decide what that is worth.
            Text(uncoveredCount > 0 ? "\(uncoveredCount) UNPITCHED" : "")
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(uncoveredCount > 0 ? Term.amber : Term.fgMuted)
                .help(uncoveredHelp)
        case .cost:
            Text(Fmt.money(t.cost, decimals: 0))
        case .value:
            Text(Fmt.money(t.value, decimals: 0)).tickFlash(t.value)
        case .wt:
            Text(t.wt.map { Fmt.pct($0, decimals: 1, signed: false) } ?? "—")
                .foregroundStyle(Term.fgDim)
        case .day:
            Text(Fmt.money(t.day, decimals: 0)).foregroundStyle(Term.delta(t.day))
        case .sinceBuy:
            Text(t.upl.map { Fmt.money($0, decimals: 0) } ?? "—")
                .foregroundStyle(Term.delta(t.upl))
        case .pct:
            Text(t.uplPct.map { Fmt.pct($0, decimals: 1) } ?? "—")
                .foregroundStyle(Term.delta(t.uplPct))
        case .shares, .avgCost, .last, .ytd:
            // No book-level YTD: the positions were bought at different
            // points in the year, so a single number would need a base
            // none of them share. Blank beats a figure nobody can defend.
            Text("")
        }
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/portfolio")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
        // Separately, and deliberately not fatal. The book is the point
        // of this panel; if our own record fails to load the column goes
        // dim rather than the screen going red.
        if let d = try? await API.shared.get("/holdings/coverage"),
           let p = try? await API.shared.decode(CovPayload.self, from: d) {
            coverage = p.coverage ?? [:]
        }
    }
}
