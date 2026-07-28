import SwiftUI

// DES — the company snapshot.
//
// Uses /holdings/info/:ticker, the same endpoint the web DES panel does,
// which is Finnhub-shaped with the business summary backfilled from
// EDGAR's 10-K Item 1 when Finnhub's free tier has none.
struct DescriptionPanel: View {
    let ticker: String

    struct Info: Decodable {
        let name: String?
        let sector: String?
        let industry: String?
        let price: Double?
        let previousClose: Double?
        let marketCap: Double?
        let trailingPE: Double?
        let forwardPE: Double?
        let dividendYield: Double?
        let fiftyTwoWeekLow: Double?
        let fiftyTwoWeekHigh: Double?
        let summary: String?
        let exchange: String?
    }

    @State private var state: Loadable<Info> = .loading

    private var changePct: Double? {
        guard case .loaded(let i) = state,
              let p = i.price, let pc = i.previousClose, pc > 0 else { return nil }
        return (p - pc) / pc * 100
    }

    var body: some View {
        PanelState(state: state, retry: { Task { await load() } }) { i in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    quote(i)
                    Divider().overlay(Term.border)
                    stats(i)
                    if let s = i.summary, !s.isEmpty {
                        Divider().overlay(Term.border)
                        VStack(alignment: .leading, spacing: 6) {
                            SectionLabel(text: "Business")
                            Text(s)
                                .font(Term.mono(11))
                                .foregroundStyle(Term.fgDim)
                                .lineSpacing(2)
                                .textSelection(.enabled)
                        }
                    } else {
                        // Absence of a summary is a fact about the
                        // source, not a rendering gap. EDGAR has no
                        // Item 1 for foreign issuers or ETFs.
                        Text("No business summary. Foreign issuers and ETFs often have no US 10-K to draw one from.")
                            .font(Term.mono(10))
                            .foregroundStyle(Term.fgMuted)
                    }
                }
                .padding(12)
            }
        }
        .task(id: ticker) { await load() }
    }

    private func quote(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ticker)
                    .font(Term.mono(18, weight: .bold))
                    .foregroundStyle(Term.amber)
                if let ex = i.exchange {
                    Text(ex).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                Spacer()
                Text(Fmt.money(i.price))
                    .font(Term.mono(20, weight: .bold))
                    .foregroundStyle(Term.white)
            }
            HStack {
                Text(i.name ?? "")
                    .font(Term.mono(11)).foregroundStyle(Term.fgDim).lineLimit(1)
                Spacer()
                if let c = changePct {
                    Text(Fmt.pct(c)).font(Term.mono(12, weight: .medium))
                        .foregroundStyle(Term.delta(c))
                }
            }
            if let s = i.sector {
                Text([s, i.industry].compactMap { $0 }.joined(separator: " · "))
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
        }
    }

    private func stats(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Valuation")
            StatRow(label: "Market cap", value: Fmt.compact(i.marketCap))
            StatRow(label: "Trailing P/E", value: i.trailingPE.map { Fmt.money($0) } ?? "—")
            StatRow(label: "Forward P/E", value: i.forwardPE.map { Fmt.money($0) } ?? "—")
            StatRow(label: "Dividend yield",
                    value: i.dividendYield.map { Fmt.pct($0 * 100, signed: false) } ?? "—")
            StatRow(label: "Previous close", value: Fmt.money(i.previousClose))
            StatRow(label: "52w range",
                    value: (i.fiftyTwoWeekLow != nil && i.fiftyTwoWeekHigh != nil)
                        ? "\(Fmt.money(i.fiftyTwoWeekLow))  –  \(Fmt.money(i.fiftyTwoWeekHigh))"
                        : "—")
        }
    }

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("DES needs a ticker.")
            return
        }
        state = .loading
        do {
            let data = try await API.shared.get("/holdings/info/\(ticker)")
            state = .loaded(try await API.shared.decode(Info.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
