import SwiftUI

// MOVR — the day's moves across the book.
//
// Shape comes from getPortfolioMovers in sheetPortfolio.js. The field
// worth carrying over most carefully is `unpriced`: the server counts
// positions it could not price and hands the number back precisely so a
// panel showing 3 of 13 holdings does not read as a 3-holding book. That
// bug already happened once on the web (MOVR ranked 1 of 12), so the
// count is rendered, not dropped.
struct MoversPanel: View {
    struct Row: Decodable, Identifiable {
        let ticker: String
        let name: String?
        let last: Double?
        let dayUsd: Double?
        let changePct: Double?
        let source: String?
        var id: String { ticker }
    }

    struct Payload: Decodable {
        let asOf: String?
        let count: Int?
        let positions: Int?
        let unpriced: Int?
        let rows: [Row]
    }

    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.rows.isEmpty },
                   emptyText: "No priced positions in the book today.",
                   retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(p.rows) { r in row(r) }
                    }
                }
            }
        }
        .task { await load() }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Movers")
            Text("\(p.rows.count) of \(p.positions ?? p.rows.count) priced")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            // The whole point: an unpriced position is stated, never
            // silently omitted from a ranking that looks complete.
            if let u = p.unpriced, u > 0 {
                Text("\(u) unpriced")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.negative)
            }
            Spacer()
            if let d = p.asOf {
                Text(d).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func row(_ r: Row) -> some View {
        HStack(spacing: 8) {
            Text(r.ticker)
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.amber)
                .frame(width: 62, alignment: .leading)
            Text(r.name ?? "")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(Fmt.money(r.last))
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .frame(width: 74, alignment: .trailing)
            Text(Fmt.pct(r.changePct.map { $0 * 100 }))
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.delta(r.changePct))
                .frame(width: 68, alignment: .trailing)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/movers")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
