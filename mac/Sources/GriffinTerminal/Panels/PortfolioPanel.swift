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
                columnHeads
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(positions) { h in row(h, total: total) }
                        if !cash.isEmpty {
                            Divider().overlay(Term.border).padding(.vertical, 4)
                            ForEach(cash) { c in cashRow(c, total: total) }
                        }
                    }
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
            Text(Fmt.money(total))
                .font(Term.mono(13, weight: .bold))
                .foregroundStyle(Term.white)
                .tickFlash(total)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    private var columnHeads: some View {
        HStack(spacing: 8) {
            Text("TICKER").frame(width: 58, alignment: .leading)
            Text("SHARES").frame(width: 60, alignment: .trailing)
            Text("AVG COST").frame(width: 72, alignment: .trailing)
            Text("LAST").frame(width: 72, alignment: .trailing)
            Text("COST").frame(width: 82, alignment: .trailing)
            Text("VALUE").frame(width: 88, alignment: .trailing)
            Text("WT").frame(width: 50, alignment: .trailing)
            Text("DAY").frame(width: 70, alignment: .trailing)
            Text("SINCE BUY").frame(width: 88, alignment: .trailing)
            Text("%").frame(width: 62, alignment: .trailing)
            Text("YTD").frame(width: 62, alignment: .trailing)
        }
        .font(Term.mono(9, weight: .bold))
        .foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func row(_ h: Holding, total: Double) -> some View {
        // Prefer the server's own weight; fall back to deriving it so a
        // sheet that stops sending the column does not blank a row.
        let weight = h.portfolioPct ?? ((total > 0 && h.marketValue != nil) ? h.marketValue! / total * 100 : nil)
        return HStack(spacing: 8) {
            // Drill-down: the ticker is a door, same as the web.
            Button {
                if let t = h.ticker {
                    NotificationCenter.default.post(name: .runCommand, object: "\(t) DES")
                }
            } label: {
                Text(h.ticker ?? "—")
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
                    .frame(width: 58, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
            Text(h.name ?? "")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text(h.shares.map { Fmt.money($0, decimals: 0) } ?? "—")
                .frame(width: 70, alignment: .trailing)
            Text(Fmt.money(h.price)).frame(width: 72, alignment: .trailing)
                .tickFlash(h.price)
            Text(Fmt.money(h.marketValue, decimals: 0)).frame(width: 92, alignment: .trailing)
                .tickFlash(h.marketValue)
            Text(weight.map { Fmt.pct($0, decimals: 1, signed: false) } ?? "—")
                .frame(width: 54, alignment: .trailing)
            Text(h.dayChange.map { Fmt.money($0, decimals: 0) } ?? "—")
                .foregroundStyle(Term.delta(h.dayChange))
                .frame(width: 78, alignment: .trailing)
                .tickFlash(h.dayChange)
        }
        .font(Term.mono(11))
        .foregroundStyle(Term.white)
        .padding(.horizontal, 10).padding(.vertical, 3)
    }

    private func cashRow(_ c: Holding, total: Double) -> some View {
        let weight = (total > 0 && c.marketValue != nil) ? c.marketValue! / total * 100 : nil
        return HStack(spacing: 8) {
            Text("CASH")
                .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.cyan)
                .frame(width: 58, alignment: .leading)
            Spacer().frame(width: 60 + 72 + 72 + 82 + 8 * 4)
            Text(Fmt.money(c.marketValue, decimals: 0))
                .font(Term.mono(11)).foregroundStyle(Term.white)
                .frame(width: 88, alignment: .trailing)
            Text(weight.map { Fmt.pct($0, decimals: 1, signed: false) } ?? "—")
                .font(Term.mono(11)).foregroundStyle(Term.fgDim)
                .frame(width: 50, alignment: .trailing)
        }
        .padding(.horizontal, 10).padding(.vertical, 3)
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/portfolio")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
