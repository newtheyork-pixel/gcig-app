import SwiftUI

// DES — the company snapshot, laid out the way Bloomberg's is.
//
// The old panel was a price, six valuation rows and a wall of prose. The
// prose was the worse half: it came straight off the top of the 10-K's
// Item 1, so Mesa's description opened "In this annual report, Mesa
// Laboratories, Inc., a Colorado corporation, together with its
// subsidiaries is collectively referred to as 'we,' 'us,' 'our'…" —
// drafting conventions, not a description. The server now opens on the
// sentence that says what the company does.
//
// What Bloomberg puts on this screen and we did not: where the company
// is actually run from, when it was founded, how many people work there,
// when its year ends, and a chart. Those are the fields being added, and
// three of them come from the submissions feed rather than being read
// out of prose — a head office extracted from a sentence put General
// Dynamics in St. Louis, because the sentence was about a customer's
// building.
//
// Every one of these is nullable and renders as a dash. A dash here is a
// fact about the filing, not a hole in the panel.
struct DescriptionPanel: View {
    let ticker: String

    struct Info: Decodable {
        let name: String?
        let legalName: String?
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
        let beta: Double?
        let volume: Double?
        let avgVolume: Double?
        let summary: String?
        let exchange: String?
        let website: String?
        let country: String?

        // The corporate block.
        let employees: Double?
        let founded: Int?
        let headquarters: String?
        let street: String?
        let phone: String?
        let sicDescription: String?
        let fiscalYearEnd: String?
        let stateOfIncorporation: String?
        let formerNames: [String]?
        let summarySource: SummarySource?

        struct SummarySource: Decodable {
            let form: String?
            let filedAt: String?
            let url: String?
        }
    }

    struct Chart: Decodable {
        let points: [Point]?
        let range: String?
        struct Point: Decodable { let t: Double?; let close: Double? }
    }

    @State private var state: Loadable<Info> = .loading
    /// The chart is a second request and must never gate the panel: a
    /// missing sparkline is a missing sparkline, not a failed DES.
    @State private var chart: [Double] = []
    @State private var chartRange: String?

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
                    sparkline(i)
                    Divider().overlay(Term.border)
                    // Two columns, because Bloomberg's DES is two
                    // columns and the reason is sound: the numbers and
                    // the particulars are read separately, and stacking
                    // them means scrolling past one to reach the other.
                    HStack(alignment: .top, spacing: 18) {
                        VStack(alignment: .leading, spacing: 10) { stats(i) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .leading, spacing: 10) { corporate(i) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Divider().overlay(Term.border)
                    business(i)
                }
                .padding(12)
            }
        }
        .task(id: ticker) { await load() }
    }

    // MARK: Header

    private func quote(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ticker)
                    .font(Term.mono(18, weight: .bold))
                    .foregroundStyle(Term.amber)
                if let ex = i.exchange {
                    Text(ex).font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(1)
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
                // SIC is the registrant's own classification and is
                // usually more specific than the vendor's, which for
                // Applied printed "Trading Companies & Distributors"
                // as both sector and industry — one fact, twice.
                let vendor = [s, i.industry].compactMap { $0 }
                let parts = Array(NSOrderedSet(array: vendor + [i.sicDescription].compactMap { $0 })) as? [String] ?? vendor
                Text(parts.joined(separator: " · "))
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted).lineLimit(2)
            }
        }
    }

    // MARK: The chart Bloomberg has and we did not

    @ViewBuilder
    private func sparkline(_ i: Info) -> some View {
        if chart.count > 1 {
            let lo = chart.min() ?? 0
            let hi = chart.max() ?? 1
            let span = max(hi - lo, 0.0001)
            let rising = (chart.last ?? 0) >= (chart.first ?? 0)
            let tint = rising ? Term.positive : Term.negative
            VStack(alignment: .leading, spacing: 3) {
                GeometryReader { geo in
                    let w = geo.size.width
                    let h = geo.size.height
                    let step = w / CGFloat(max(chart.count - 1, 1))
                    let pt: (Int) -> CGPoint = { idx in
                        CGPoint(x: CGFloat(idx) * step,
                                y: h - CGFloat((chart[idx] - lo) / span) * h)
                    }
                    ZStack {
                        // Filled under the line, the way a terminal
                        // draws it — the shape reads at a glance and
                        // the axis labels are the range beneath.
                        Path { p in
                            p.move(to: CGPoint(x: 0, y: h))
                            for idx in chart.indices { p.addLine(to: pt(idx)) }
                            p.addLine(to: CGPoint(x: w, y: h))
                            p.closeSubpath()
                        }
                        .fill(LinearGradient(colors: [tint.opacity(0.22), tint.opacity(0.01)],
                                             startPoint: .top, endPoint: .bottom))
                        Path { p in
                            for idx in chart.indices {
                                idx == 0 ? p.move(to: pt(idx)) : p.addLine(to: pt(idx))
                            }
                        }
                        .stroke(tint, style: StrokeStyle(lineWidth: 1.2, lineJoin: .round))
                    }
                }
                .frame(height: 54)
                HStack {
                    Text(chartRange.map { $0.uppercased() } ?? "")
                        .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                    Spacer()
                    Text("\(Fmt.money(lo)) – \(Fmt.money(hi))")
                        .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                }
            }
        }
    }

    // MARK: Columns

    private func stats(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Valuation")
            StatRow(label: "Market cap", value: Fmt.compact(i.marketCap))
            StatRow(label: "Trailing P/E", value: i.trailingPE.map { Fmt.money($0) } ?? "—")
            StatRow(label: "Forward P/E", value: i.forwardPE.map { Fmt.money($0) } ?? "—")
            StatRow(label: "Dividend yield",
                    value: i.dividendYield.map { Fmt.pct($0 * 100, signed: false) } ?? "—")
            StatRow(label: "Beta", value: i.beta.map { String(format: "%.2f", $0) } ?? "—")
            StatRow(label: "Previous close", value: Fmt.money(i.previousClose))
            StatRow(label: "Avg volume", value: Fmt.compact(i.avgVolume))
            StatRow(label: "52w range",
                    value: (i.fiftyTwoWeekLow != nil && i.fiftyTwoWeekHigh != nil)
                        ? "\(Fmt.money(i.fiftyTwoWeekLow))  –  \(Fmt.money(i.fiftyTwoWeekHigh))"
                        : "—")
            rangeBar(i)
        }
    }

    /// Where today sits in the year's range. The two numbers alone do
    /// not answer "is this near its high", which is the question anybody
    /// reading them is asking.
    @ViewBuilder
    private func rangeBar(_ i: Info) -> some View {
        if let lo = i.fiftyTwoWeekLow, let hi = i.fiftyTwoWeekHigh,
           let p = i.price, hi > lo {
            let frac = min(max((p - lo) / (hi - lo), 0), 1)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Term.border).frame(height: 3)
                    Circle().fill(Term.amber)
                        .frame(width: 7, height: 7)
                        .offset(x: geo.size.width * CGFloat(frac) - 3.5)
                }
                .frame(height: 8)
            }
            .frame(height: 8)
            .padding(.top, 2)
            .help("\(Int(frac * 100))% of the way up the 52-week range")
        }
    }

    private func corporate(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Corporate")
            StatRow(label: "Head office", value: i.headquarters ?? "—")
            StatRow(label: "Founded", value: i.founded.map(String.init) ?? "—")
            StatRow(label: "Employees",
                    value: i.employees.map { Fmt.compact($0) } ?? "—")
            StatRow(label: "Fiscal year end", value: i.fiscalYearEnd ?? "—")
            StatRow(label: "Incorporated", value: i.stateOfIncorporation ?? "—")
            StatRow(label: "Phone", value: i.phone ?? "—")
            if let w = i.website, !w.isEmpty {
                Button {
                    if let u = URL(string: w) { NSWorkspace.shared.open(u) }
                } label: {
                    HStack(spacing: 0) {
                        Text("Website").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                        Spacer()
                        Text(w.replacingOccurrences(of: "https://", with: ""))
                            .font(Term.mono(10)).foregroundStyle(Term.blue).lineLimit(1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            // A company that changed its name is worth knowing about:
            // Applied Industrial filed as Bearings Inc, and a search of
            // old coverage under the current name finds nothing.
            if let f = i.formerNames, !f.isEmpty {
                Text("Formerly \(f.joined(separator: ", "))")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .padding(.top, 2)
            }
        }
    }

    // MARK: Description

    @ViewBuilder
    private func business(_ i: Info) -> some View {
        if let s = i.summary, !s.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    SectionLabel(text: "Business")
                    if let src = i.summarySource, let filed = src.filedAt {
                        // The company's own words, and which filing they
                        // are from — a description with no date is an
                        // assertion.
                        Button {
                            if let u = src.url, let url = URL(string: u) { NSWorkspace.shared.open(url) }
                        } label: {
                            Text("\(src.form ?? "10-K") filed \(filed)")
                                .font(Term.mono(9)).foregroundStyle(Term.blue)
                        }
                        .buttonStyle(.plain)
                        .help("Open the filing on EDGAR")
                    }
                    Spacer()
                }
                Text(s)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .lineSpacing(2)
                    .textSelection(.enabled)
            }
        } else {
            // Absence of a summary is a fact about the source, not a
            // rendering gap. EDGAR has no Item 1 for foreign issuers or
            // ETFs.
            Text("No business summary. Foreign issuers and ETFs often have no US 10-K to draw one from.")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
        }
    }

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("DES needs a ticker.")
            return
        }
        state = .loading
        chart = []
        chartRange = nil
        do {
            let data = try await API.shared.get("/holdings/info/\(ticker)")
            state = .loaded(try await API.shared.decode(Info.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
            return
        }
        // Separate and deliberately after: the snapshot is the panel and
        // the chart is decoration on it.
        if let d = try? await API.shared.get("/terminal/chart/\(ticker)"),
           let c = try? await API.shared.decode(Chart.self, from: d) {
            chart = (c.points ?? []).compactMap { $0.close }
            chartRange = c.range
        }
    }
}
