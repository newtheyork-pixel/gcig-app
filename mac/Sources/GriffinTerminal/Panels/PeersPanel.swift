import SwiftUI

// PEER — sector peer comparison for the focused ticker.
//
// Shape comes from /terminal/peers/:ticker: Finnhub's peer set plus a
// compact fundamentals snapshot per name, focus row first (the server
// orders it that way) and flagged with `isFocus`. Two unit traps carry
// over from getPeerSnapshot: `changePct` and `dividendYield` arrive as
// FRACTIONS (0.0123 == +1.23%), so both are ×100 before Fmt.pct, and
// `marketCap` is already in dollars — the server did the ×1e6 on
// Finnhub's millions.
//
// The web panel layers an AI brief and a ~20s live-quote overlay on
// top of this snapshot; neither exists natively yet, so the footer
// describes what the reader is actually looking at — a ~15m snapshot —
// rather than repeating the web's live-refresh promise.
struct PeersPanel: View {
    let ticker: String

    struct Row: Decodable, Identifiable {
        let ticker: String
        let isFocus: Bool?
        /// Where this name came from: "filing", "peer", or "sector".
        /// The panel used to show a vendor's sub-industry cohort with
        /// no provenance at all, so Dillard's turned up against Amazon
        /// looking like a data error when it was in fact GICS answering
        /// a question nobody had asked.
        let source: String?
        let name: String?
        let price: Double?
        let changePct: Double?
        let marketCap: Double?
        let trailingPE: Double?
        let forwardPE: Double?
        let dividendYield: Double?
        let beta: Double?
        var id: String { ticker }
    }

    struct Payload: Decodable {
        let ticker: String?
        let count: Int?
        let rows: [Row]
        let caveat: String?
    }

    /// The one-word badge each row carries, and what it means in full.
    private static func sourceBadge(_ s: String?) -> (String, Color, String)? {
        switch s {
        case "filing":
            return ("10-K", Term.positive,
                    "Named as a competitor in this company's own annual report. The strongest evidence available: the filer saying so under signature.")
        case "peer":
            return ("READ", Term.cyan,
                    "Our own read of who this company competes with, which is a judgement rather than a vendor classification. The ticker is verified to exist in EDGAR; its relevance is our call.")
        case "sector":
            return ("GICS", Term.fgMuted,
                    "Same GICS sub-industry. A classification, not a competitive view — since the 2023 revision this bucket puts department stores beside Amazon and puts Walmart in another sector entirely.")
        default:
            return nil
        }
    }

    @State private var state: Loadable<Payload> = .loading

    // One set of column widths shared by the header row and every data
    // row. A table that drifts a point between the two stops being a
    // table.
    private enum Col {
        static let ticker: CGFloat = 56
        static let last: CGFloat = 70
        static let chg: CGFloat = 66
        static let cap: CGFloat = 62
        static let pe: CGFloat = 48
        static let fwd: CGFloat = 48
        static let div: CGFloat = 56
        static let beta: CGFloat = 42
    }

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.rows.isEmpty },
                   emptyText: "No peer rows for \(ticker.uppercased()).",
                   retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                // An empty peer set is a fact about Finnhub's coverage,
                // not a failure — the focus row still renders below.
                // Same sentence the web shows.
                if (p.count ?? 0) == 0 {
                    Text("No comparables found for \(p.ticker ?? ticker.uppercased()) — common for ETFs, funds, and thinly-covered names. Showing \(p.ticker ?? ticker.uppercased()) alone.")
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgMuted)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                }
                columnHeader
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(p.rows) { r in row(r) }
                    }
                }
                Divider().overlay(Term.border)
                VStack(alignment: .leading, spacing: 2) {
                    // The key to the badges, always visible. Hovering a
                    // badge gives the long version; nobody should have
                    // to hover to learn that the badges exist.
                    HStack(spacing: 8) {
                        Text("10-K named").foregroundStyle(Term.positive)
                        Text("READ our judgement").foregroundStyle(Term.cyan)
                        Text("GICS classification only").foregroundStyle(Term.fgMuted)
                        Text("· fundamentals are a ~15m snapshot").foregroundStyle(Term.fgMuted)
                    }
                    if let c = p.caveat {
                        Text(c).foregroundStyle(Term.fgMuted)
                    }
                }
                .font(Term.mono(9))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
            }
        }
        .task(id: ticker) { await load() }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Peers")
            Text(p.ticker ?? ticker.uppercased())
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.amber)
            if let c = p.count, c > 0 {
                Text("\(c) comparables")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var columnHeader: some View {
        HStack(spacing: 8) {
            Text("TICKER").frame(width: Col.ticker, alignment: .leading)
            Spacer(minLength: 6)
            Text("LAST").frame(width: Col.last, alignment: .trailing)
            Text("CHG %").frame(width: Col.chg, alignment: .trailing)
            Text("MKT CAP").frame(width: Col.cap, alignment: .trailing)
            Text("P/E").frame(width: Col.pe, alignment: .trailing)
            Text("FWD P/E").frame(width: Col.fwd, alignment: .trailing)
            Text("DIV").frame(width: Col.div, alignment: .trailing)
            Text("BETA").frame(width: Col.beta, alignment: .trailing)
        }
        .font(Term.mono(9, weight: .bold))
        .foregroundStyle(Term.fgMuted)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }

    private func row(_ r: Row) -> some View {
        let focus = r.isFocus ?? false
        return HStack(spacing: 8) {
            // The focus row reads white-on-raised so the comparison has
            // an anchor; every peer keeps the amber symbol.
            Text(r.ticker)
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(focus ? Term.white : Term.amber)
                .frame(width: Col.ticker, alignment: .leading)
            Text(r.name ?? "")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .lineLimit(1)
            if let (label, tone, help) = Self.sourceBadge(r.source) {
                Text(label)
                    .font(Term.mono(8, weight: .bold))
                    .foregroundStyle(tone)
                    .padding(.horizontal, 3).padding(.vertical, 1)
                    .overlay(RoundedRectangle(cornerRadius: 2).stroke(tone.opacity(0.5), lineWidth: 0.5))
                    .help(help)
            }
            Spacer(minLength: 6)
            cell(Fmt.money(r.price), width: Col.last)
            cell(Fmt.pct(r.changePct.map { $0 * 100 }),
                 width: Col.chg, tone: Term.delta(r.changePct))
            cell(Fmt.compact(r.marketCap), width: Col.cap)
            cell(Fmt.money(r.trailingPE, decimals: 1), width: Col.pe)
            cell(Fmt.money(r.forwardPE, decimals: 1), width: Col.fwd)
            cell(Fmt.pct(r.dividendYield.map { $0 * 100 }, signed: false),
                 width: Col.div)
            cell(Fmt.money(r.beta, decimals: 1), width: Col.beta)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(focus ? Term.bgPanelHover : Term.bgPanel)
    }

    private func cell(_ text: String, width: CGFloat,
                      tone: Color = Term.white) -> some View {
        Text(text)
            .font(Term.mono(11))
            .foregroundStyle(tone)
            .frame(width: width, alignment: .trailing)
    }

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("PEER needs a ticker.")
            return
        }
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/peers/\(ticker)")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
