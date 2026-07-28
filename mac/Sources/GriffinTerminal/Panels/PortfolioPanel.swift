import SwiftUI

// PM — the whole book.
//
// Shape from getSheetPortfolio. Cash rows come back with isCash set and
// no ticker worth showing, so they are separated rather than sorted in
// among the positions: cash at a 100% "weight of itself" in a column of
// equity weights is noise.
struct PortfolioPanel: View {
    struct Holding: Decodable, Identifiable {
        let ticker: String?
        let name: String?
        let shares: Double?
        let costBasis: Double?
        let price: Double?
        let marketValue: Double?
        let dayChange: Double?
        let isCash: Bool?
        var id: String { (ticker ?? name ?? UUID().uuidString) }
    }

    struct Payload: Decodable {
        let holdings: [Holding]?
        let totalValue: Double?
        let fetchedAt: String?
        let source: String?
    }

    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { ($0.holdings ?? []).isEmpty },
                   emptyText: "The positions sheet came back empty.",
                   retry: { Task { await load() } }) { p in
            let all = p.holdings ?? []
            let positions = all.filter { !($0.isCash ?? false) }
            let cash = all.filter { $0.isCash ?? false }
            let total = p.totalValue ?? all.compactMap(\.marketValue).reduce(0, +)

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
        .task { await load() }
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
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    private var columnHeads: some View {
        HStack(spacing: 8) {
            Text("TICKER").frame(width: 62, alignment: .leading)
            Text("NAME").frame(maxWidth: .infinity, alignment: .leading)
            Text("SHARES").frame(width: 70, alignment: .trailing)
            Text("LAST").frame(width: 72, alignment: .trailing)
            Text("VALUE").frame(width: 92, alignment: .trailing)
            Text("WT").frame(width: 54, alignment: .trailing)
            Text("DAY").frame(width: 78, alignment: .trailing)
        }
        .font(Term.mono(9, weight: .bold))
        .foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func row(_ h: Holding, total: Double) -> some View {
        let weight = (total > 0 && h.marketValue != nil) ? h.marketValue! / total * 100 : nil
        return HStack(spacing: 8) {
            Text(h.ticker ?? "—")
                .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
                .frame(width: 62, alignment: .leading)
            Text(h.name ?? "")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text(h.shares.map { Fmt.money($0, decimals: 0) } ?? "—")
                .frame(width: 70, alignment: .trailing)
            Text(Fmt.money(h.price)).frame(width: 72, alignment: .trailing)
            Text(Fmt.money(h.marketValue, decimals: 0)).frame(width: 92, alignment: .trailing)
            Text(weight.map { Fmt.pct($0, decimals: 1, signed: false) } ?? "—")
                .frame(width: 54, alignment: .trailing)
            Text(h.dayChange.map { Fmt.money($0, decimals: 0) } ?? "—")
                .foregroundStyle(Term.delta(h.dayChange))
                .frame(width: 78, alignment: .trailing)
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
                .frame(width: 62, alignment: .leading)
            Text(c.name ?? "").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(Fmt.money(c.marketValue, decimals: 0))
                .font(Term.mono(11)).foregroundStyle(Term.white)
                .frame(width: 92, alignment: .trailing)
            Text(weight.map { Fmt.pct($0, decimals: 1, signed: false) } ?? "—")
                .font(Term.mono(11)).foregroundStyle(Term.fgDim)
                .frame(width: 54, alignment: .trailing)
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
