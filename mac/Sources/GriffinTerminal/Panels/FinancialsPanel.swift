import SwiftUI

// FA — the three financial statements line by line, fiscal periods as
// columns, the way Bloomberg's FA lays them out.
//
// Shape comes from getStatements in secFundamentals.js. One payload
// carries all three statements on a shared period axis, so the
// statement toggle is a client-side flip; only the annual/quarterly
// switch (and a ticker change) re-fetches. Values arrive raw — USD,
// USD/shares, or a share count — and null-holed. A hole means the
// filer never tagged that concept for that period, which is routine,
// so it renders as an em dash: a zero here would read as "they
// reported zero", and nobody reported anything.
struct FinancialsPanel: View {
    let ticker: String

    // MARK: Wire shapes

    struct Period: Decodable {
        let period: String
        let fy: Int?
        let fp: String?
        let label: String?
    }

    struct Line: Decodable, Identifiable {
        let key: String
        let label: String?
        let unit: String?     // "USD", "USD/shares", or "shares"
        let values: [Double?] // aligned to periods; null = never tagged
        var id: String { key }
    }

    struct Payload: Decodable {
        let ticker: String?
        let name: String?
        let freq: String?
        let periods: [Period]
        let income: [Line]
        let balance: [Line]
        let cashflow: [Line]
    }

    // Declaration order is the web's button order (balance first),
    // while income stays the default the panel opens on.
    private enum Statement: String, CaseIterable {
        case balance, income, cashflow

        var button: String {
            switch self {
            case .balance:  return "Balance Sheet"
            case .income:   return "Income"
            case .cashflow: return "Cash Flow"
            }
        }

        var heading: String {
            switch self {
            case .balance:  return "Balance Sheet"
            case .income:   return "Income Statement"
            case .cashflow: return "Cash Flow"
            }
        }
    }

    private enum Freq: String, CaseIterable {
        case quarterly, annual
        var button: String { self == .quarterly ? "Quarterly" : "Yearly" }
    }

    @State private var statement: Statement = .income
    @State private var freq: Freq = .annual
    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header and toggles live outside PanelState so a freq flip
            // does not vanish the very controls that caused the reload.
            header
            controls
            Divider().overlay(Term.border)
            PanelState(state: state,
                       emptyWhen: { $0.periods.isEmpty },
                       emptyText: "SEC tags no \(freq.rawValue) statement data for \(ticker.uppercased()) — common for foreign filers (20-F), funds, and ADRs that don't report in us-gaap XBRL.",
                       retry: { Task { await load() } }) { p in
                table(p)
            }
            Divider().overlay(Term.border)
            source
        }
        .task(id: "\(ticker)|\(freq.rawValue)") { await load() }
    }

    // MARK: Header + controls

    private var companyLine: String {
        if case .loaded(let p) = state, let n = p.name, !n.isEmpty {
            return "Financial Statements · \(n)"
        }
        return "Financial Statements"
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(ticker.uppercased())
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            Text("US Equity")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
            Text(companyLine)
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var controls: some View {
        HStack(spacing: 4) {
            ForEach(Statement.allCases, id: \.self) { s in
                toggle(s.button, active: statement == s) { statement = s }
            }
            Color.clear.frame(width: 8, height: 1)
            ForEach(Freq.allCases, id: \.self) { f in
                toggle(f.button, active: freq == f) { freq = f }
            }
            Spacer()
            // The web says "In Millions"; we render Fmt.compact
            // (K/M/B), so the caption states that instead of lying.
            Text("Compact USD · except per-share")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    // TermButtonStyle has no notion of "selected", so the active tab
    // re-strokes the style's border in amber rather than inventing a
    // second button style for one panel.
    private func toggle(_ label: String, active: Bool,
                        action: @escaping () -> Void) -> some View {
        Button(label, action: action)
            .buttonStyle(TermButtonStyle())
            .overlay(Rectangle().strokeBorder(active ? Term.amber : .clear,
                                              lineWidth: 1))
    }

    // MARK: Table

    private let stubWidth: CGFloat = 168
    private let cellWidth: CGFloat = 78

    private var activeLines: (Payload) -> [Line] {
        switch statement {
        case .balance:  return { $0.balance }
        case .income:   return { $0.income }
        case .cashflow: return { $0.cashflow }
        }
    }

    private func table(_ p: Payload) -> some View {
        // Both axes in one ScrollView so the period header and its
        // columns can never scroll apart. Old filers carry a lot of
        // periods; like the web, all of them are kept and the panel
        // scrolls rather than silently truncating history.
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 0) {
                headerRow(p)
                ForEach(activeLines(p)) { line in lineRow(line) }
                Color.clear.frame(height: 10)
                ForEach(ratioRows(p)) { r in ratioRow(r) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    private func headerRow(_ p: Payload) -> some View {
        HStack(spacing: 0) {
            Text(statement.heading.uppercased())
                .font(Term.mono(9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(Term.blue)
                .frame(width: stubWidth, alignment: .leading)
            ForEach(p.periods, id: \.period) { per in
                Text(per.label ?? per.period)
                    .font(Term.mono(10, weight: .bold))
                    .foregroundStyle(Term.fgMuted)
                    .frame(width: cellWidth, alignment: .trailing)
            }
        }
        .padding(.vertical, 4)
    }

    private func lineRow(_ line: Line) -> some View {
        HStack(spacing: 0) {
            Text(line.label ?? line.key)
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
                .lineLimit(1)
                .frame(width: stubWidth, alignment: .leading)
            ForEach(Array(line.values.enumerated()), id: \.offset) { _, v in
                Text(cellText(unit: line.unit, v))
                    .font(Term.mono(10))
                    .foregroundStyle(Term.white)
                    .frame(width: cellWidth, alignment: .trailing)
            }
        }
        .padding(.vertical, 2)
    }

    private func ratioRow(_ r: RatioRow) -> some View {
        HStack(spacing: 0) {
            Text(r.label)
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .lineLimit(1)
                .frame(width: stubWidth, alignment: .leading)
            ForEach(Array(r.values.enumerated()), id: \.offset) { _, v in
                Text(ratioText(r.kind, v))
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgDim)
                    .frame(width: cellWidth, alignment: .trailing)
            }
        }
        .padding(.vertical, 2)
    }

    // Per-share stays in dollars; dollar lines and share counts both
    // go through compact — same split as the web's cell().
    private func cellText(unit: String?, _ v: Double?) -> String {
        unit == "USD/shares" ? Fmt.money(v) : Fmt.compact(v)
    }

    // MARK: Derived ratios
    //
    // The web derives these client-side beneath each statement rather
    // than asking the server, and the mac panel does the same math so
    // the two clients can never disagree about a margin. Revenue always
    // comes from the income statement, whichever statement is showing.

    private struct RatioRow: Identifiable {
        enum Kind { case pct, growth, x, compact }
        let label: String
        let kind: Kind
        let values: [Double?]
        var id: String { label }
    }

    private func ratioRows(_ p: Payload) -> [RatioRow] {
        let n = p.periods.count
        let rev = series(p.income, "revenue", n)

        func ratio(_ a: Double?, _ b: Double?) -> Double? {
            guard let a, let b, b != 0 else { return nil }
            return a / b
        }
        func over(_ num: [Double?], _ den: [Double?]) -> [Double?] {
            (0..<n).map { ratio(num[$0], den[$0]) }
        }

        switch statement {
        case .income:
            let g = series(p.income, "grossProfit", n)
            let op = series(p.income, "operatingIncome", n)
            let ni = series(p.income, "netIncome", n)
            let rnd = series(p.income, "rnd", n)
            let sga = series(p.income, "sga", n)
            let growth: [Double?] = (0..<n).map { i in
                guard i > 0, let prev = rev[i - 1], prev != 0,
                      let cur = rev[i] else { return nil }
                return (cur - prev) / abs(prev)
            }
            return [
                RatioRow(label: "Gross Profit Margin", kind: .pct, values: over(g, rev)),
                RatioRow(label: "Operating Profit Margin", kind: .pct, values: over(op, rev)),
                RatioRow(label: "Net Profit Margin", kind: .pct, values: over(ni, rev)),
                RatioRow(label: "R&D as % of Revenue", kind: .pct, values: over(rnd, rev)),
                RatioRow(label: "SG&A as % of Revenue", kind: .pct, values: over(sga, rev)),
                RatioRow(label: freq == .quarterly ? "Revenue QoQ Growth" : "Revenue YoY Growth",
                         kind: .growth, values: growth),
            ]

        case .cashflow:
            let cfo = series(p.cashflow, "cfo", n)
            let capex = series(p.cashflow, "capex", n)
            let fcf: [Double?] = (0..<n).map { i in
                guard let c = cfo[i], let x = capex[i] else { return nil }
                return c - x
            }
            return [
                RatioRow(label: "Free Cash Flow", kind: .compact, values: fcf),
                RatioRow(label: "FCF Margin", kind: .pct, values: over(fcf, rev)),
                RatioRow(label: "CapEx as % of Revenue", kind: .pct, values: over(capex, rev)),
            ]

        case .balance:
            let ca = series(p.balance, "currentAssets", n)
            let cl = series(p.balance, "currentLiabilities", n)
            let debt = series(p.balance, "longTermDebt", n)
            let eq = series(p.balance, "equity", n)
            let cash = series(p.balance, "cash", n)
            let ta = series(p.balance, "totalAssets", n)
            return [
                RatioRow(label: "Current Ratio", kind: .x, values: over(ca, cl)),
                RatioRow(label: "Debt / Equity", kind: .x, values: over(debt, eq)),
                RatioRow(label: "Cash as % of Assets", kind: .pct, values: over(cash, ta)),
            ]
        }
    }

    // The server aligns every values array to the period axis, but the
    // ratio math indexes freely, so pad rather than trust — an index
    // crash over one short array would take the whole panel with it.
    private func series(_ rows: [Line], _ key: String, _ n: Int) -> [Double?] {
        let vals = rows.first(where: { $0.key == key })?.values ?? []
        return (0..<n).map { $0 < vals.count ? vals[$0] : nil }
    }

    // Signed throughout: the web leaves margins unsigned, but a
    // negative net margin printed without its minus is a wrong number,
    // not a style choice.
    private func ratioText(_ kind: RatioRow.Kind, _ v: Double?) -> String {
        switch kind {
        case .pct, .growth: return Fmt.pct(v.map { $0 * 100 }, decimals: 1)
        case .x:            return v.map { Fmt.money($0) + "x" } ?? "—"
        case .compact:      return Fmt.compact(v)
        }
    }

    // MARK: Footer

    private var source: some View {
        Text("SEC XBRL companyfacts · fiscal periods, latest filing per period (restatements win). Quarterly Q4 is derived as FY minus Q1–Q3 for flow lines.")
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
    }

    // MARK: Load

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("FA needs a ticker.")
            return
        }
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/statements/\(ticker)",
                                                query: ["freq": freq.rawValue])
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
