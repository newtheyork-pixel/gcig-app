import Charts
import SwiftUI

// GF — graph fundamentals.
//
// SEC XBRL income-statement / cash-flow figures over time, from
// /terminal/fundamentals (services/secFundamentals.js): dollar metrics
// as grouped bars on the left axis, a margin or EPS line on the right,
// annual or quarterly. The data is whatever the filer actually tagged,
// so a metric a company never reported drops out rather than drawing a
// zero — a nil is skipped, never plotted.
//
// Swift Charts has no second y-axis, so the overlay line is mapped
// into the dollar domain and the trailing axis labels are recovered by
// the inverse map. The line keeps its true shape; only the ruler on
// the right is synthetic.
struct FundamentalsPanel: View {
    let ticker: String

    // One fiscal period as the server normalizes it: "FY2023" annual,
    // "2023 Q1" quarterly. Every number is nullable — XBRL only has
    // what the filer tagged, and margins exist only where revenue does.
    struct Row: Decodable, Identifiable {
        let period: String
        let revenue: Double?
        let grossProfit: Double?
        let operatingIncome: Double?
        let netIncome: Double?
        let cfo: Double?
        let epsDiluted: Double?
        let grossMargin: Double?
        let operatingMargin: Double?
        let netMargin: Double?
        var id: String { period }
    }

    struct Payload: Decodable {
        let ticker: String?
        let name: String?
        let freq: String?
        let rows: [Row]
    }

    // The web's BAR_METRICS, colors carried over token for token.
    // Revenue wears --term-fg, which is the amber.
    enum BarMetric: String, CaseIterable, Identifiable {
        case revenue, grossProfit, operatingIncome, netIncome, cfo
        var id: String { rawValue }

        var label: String {
            switch self {
            case .revenue:         return "Revenue"
            case .grossProfit:     return "Gross Profit"
            case .operatingIncome: return "Op Income"
            case .netIncome:       return "Net Income"
            case .cfo:             return "Op Cash Flow"
            }
        }

        var color: Color {
            switch self {
            case .revenue:         return Term.fg
            case .grossProfit:     return Term.blue
            case .operatingIncome: return Term.magenta
            case .netIncome:       return Term.cyan
            case .cfo:             return Term.positive
            }
        }

        func value(_ r: Row) -> Double? {
            switch self {
            case .revenue:         return r.revenue
            case .grossProfit:     return r.grossProfit
            case .operatingIncome: return r.operatingIncome
            case .netIncome:       return r.netIncome
            case .cfo:             return r.cfo
            }
        }
    }

    // The web's LINE_METRICS: one overlay at a time, or none. Margins
    // arrive as fractions of revenue; EPS is dollars per share.
    enum LineMetric: String, CaseIterable, Identifiable {
        case none, grossMargin, operatingMargin, netMargin, epsDiluted
        var id: String { rawValue }

        var label: String {
            switch self {
            case .none:            return "None"
            case .grossMargin:     return "Gross Margin"
            case .operatingMargin: return "Op Margin"
            case .netMargin:       return "Net Margin"
            case .epsDiluted:      return "Diluted EPS"
            }
        }

        var isPct: Bool { self != .none && self != .epsDiluted }

        func value(_ r: Row) -> Double? {
            switch self {
            case .none:            return nil
            case .grossMargin:     return r.grossMargin
            case .operatingMargin: return r.operatingMargin
            case .netMargin:       return r.netMargin
            case .epsDiluted:      return r.epsDiluted
            }
        }

        /// Readout precision, matching the web tooltip.
        func format(_ v: Double?) -> String {
            isPct ? Fmt.pct(v.map { $0 * 100 }, decimals: 1, signed: false)
                  : Fmt.money(v)
        }

        /// Axis precision, matching the web's coarser right-axis ticks.
        func axisFormat(_ v: Double?) -> String {
            isPct ? Fmt.pct(v.map { $0 * 100 }, decimals: 0, signed: false)
                  : Fmt.money(v, decimals: 0)
        }
    }

    enum Freq: String, CaseIterable {
        case annual, quarterly
        var label: String { self == .annual ? "Annual" : "Quarterly" }
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var freq: Freq = .annual
    @State private var bars: Set<BarMetric> = [.revenue, .netIncome]
    @State private var line: LineMetric = .netMargin
    @State private var hovered: String? = nil
    @State private var brief = ""
    @State private var briefLoading = false

    private var sym: String {
        ticker.trimmingCharacters(in: .whitespaces).uppercased()
    }

    private var activeBars: [BarMetric] {
        BarMetric.allCases.filter { bars.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header and pickers live outside PanelState on purpose:
            // the web keeps them up through loading, error, and empty,
            // so an empty annual series still offers the quarterly
            // button rather than a dead end.
            header
            controls
            Divider().overlay(Term.border)
            PanelState(state: state,
                       emptyWhen: { $0.rows.isEmpty },
                       emptyText: "No tagged fundamentals for \(sym). SEC XBRL covers US filers — ADRs and funds often tag none.",
                       retry: { Task { await load() } }) { p in
                VStack(alignment: .leading, spacing: 8) {
                    if p.rows.count >= 2 { briefBlock }
                    readout(p.rows)
                    chart(p.rows)
                }
                .padding(10)
            }
        }
        // Ticker and frequency both name the dataset; a change to
        // either cancels the in-flight fetch and starts a fresh one,
        // the same shape DescriptionPanel uses per ticker.
        .task(id: "\(sym)|\(freq.rawValue)") { await load() }
    }

    // MARK: Chrome

    private var loadedName: String? {
        if case .loaded(let p) = state { return p.name }
        return nil
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(sym)
                .font(Term.mono(13, weight: .bold))
                .foregroundStyle(Term.amber)
            Text([loadedName, "Graph Fundamentals"]
                    .compactMap { $0 }.joined(separator: " · "))
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .lineLimit(1)
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                ForEach(Freq.allCases, id: \.self) { f in freqButton(f) }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func freqButton(_ f: Freq) -> some View {
        Button(f.label) { freq = f }
            .buttonStyle(.plain)
            .font(Term.mono(10, weight: f == freq ? .bold : .regular))
            .foregroundStyle(f == freq ? Term.amber : Term.fgMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .overlay(Rectangle().strokeBorder(
                f == freq ? Term.borderFocus : Term.border, lineWidth: 1))
            .contentShape(Rectangle())
    }

    // The metric pickers: the bar toggles double as the legend, which
    // is why the chart itself draws none.
    private var controls: some View {
        HStack(spacing: 6) {
            ForEach(BarMetric.allCases) { m in barToggle(m) }
            Spacer(minLength: 8)
            Text("overlay")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
            Picker("", selection: $line) {
                ForEach(LineMetric.allCases) { l in
                    Text(l.label).tag(l)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .controlSize(.small)
            .frame(width: 120)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private func barToggle(_ m: BarMetric) -> some View {
        let on = bars.contains(m)
        return Button {
            if on { bars.remove(m) } else { bars.insert(m) }
        } label: {
            HStack(spacing: 4) {
                Rectangle()
                    .fill(m.color)
                    .opacity(on ? 1 : 0.3)
                    .frame(width: 7, height: 7)
                Text(m.label)
                    .font(Term.mono(9))
                    .foregroundStyle(on ? Term.fg : Term.fgMuted)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .overlay(Rectangle().strokeBorder(
                on ? m.color : Term.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var briefBlock: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("◢ AI BRIEF")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(Term.amber)
            Text(briefLoading ? "Generating…"
                 : (brief.isEmpty ? "No brief available." : brief))
                .font(Term.mono(10))
                .foregroundStyle(briefLoading || brief.isEmpty
                                 ? Term.fgMuted : Term.fgDim)
                .lineSpacing(2)
                .textSelection(.enabled)
        }
    }

    // The web answers hover with a floating tooltip. The native port
    // is a fixed readout strip: hovered period when the pointer is on
    // the plot, latest period otherwise, same fields either way.
    private func readout(_ rows: [Row]) -> some View {
        let r = rows.first { $0.period == hovered } ?? rows[rows.count - 1]
        return HStack(spacing: 10) {
            Text(r.period)
                .font(Term.mono(10, weight: .bold))
                .foregroundStyle(Term.white)
            ForEach(activeBars) { m in
                Text("\(m.label) \(Fmt.compact(m.value(r)))")
                    .font(Term.mono(10))
                    .foregroundStyle(m.color)
            }
            if line != .none {
                Text("\(line.label) \(line.format(line.value(r)))")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.white)
            }
            Spacer()
        }
        .lineLimit(1)
    }

    // MARK: Chart

    private struct Span { let lo: Double; let hi: Double }

    private func usdSpan(_ rows: [Row]) -> Span {
        let vals = rows.flatMap { r in activeBars.compactMap { $0.value(r) } }
        guard let lo = vals.min(), let hi = vals.max(), !(lo == 0 && hi == 0)
        else { return Span(lo: 0, hi: 1) }
        // Bars grow from zero, so the domain must hold it; a little
        // headroom keeps the tallest bar off the frame.
        return Span(lo: lo < 0 ? lo * 1.05 : 0,
                    hi: hi > 0 ? hi * 1.05 : 0)
    }

    private func lineSpan(_ rows: [Row]) -> Span? {
        guard line != .none else { return nil }
        let vals = rows.compactMap { line.value($0) }
        guard var lo = vals.min(), var hi = vals.max() else { return nil }
        if lo == hi {
            // A flat series still needs a nonzero span to map through.
            let pad = max(abs(lo) * 0.1, 0.01)
            lo -= pad
            hi += pad
        }
        return Span(lo: lo, hi: hi)
    }

    private func toUSD(_ v: Double, _ from: Span, _ to: Span) -> Double {
        to.lo + (v - from.lo) / (from.hi - from.lo) * (to.hi - to.lo)
    }

    private func fromUSD(_ y: Double, _ from: Span, _ to: Span) -> Double {
        from.lo + (y - to.lo) / (to.hi - to.lo) * (from.hi - from.lo)
    }

    // Category axis shows every label by default; thin them once a
    // quarterly series gets long so the axis doesn't turn to mush.
    private func xTicks(_ rows: [Row]) -> [String] {
        guard rows.count > 14 else { return rows.map(\.period) }
        let step = Int((Double(rows.count) / 10).rounded(.up))
        return rows.enumerated().compactMap {
            $0.offset % step == 0 ? $0.element.period : nil
        }
    }

    private func chart(_ rows: [Row]) -> some View {
        let usd = usdSpan(rows)
        let overlay = lineSpan(rows)
        // Four evenly spaced ticks in the overlay's own units, parked
        // at their mapped positions; the labels invert the map back.
        let trailingTicks: [Double] = overlay.map { d in
            (0...3).map { toUSD(d.lo + Double($0) / 3 * (d.hi - d.lo), d, usd) }
        } ?? []

        return Chart {
            ForEach(rows) { r in
                ForEach(activeBars) { m in
                    if let v = m.value(r) {
                        BarMark(x: .value("Period", r.period),
                                y: .value("USD", v))
                            .position(by: .value("Metric", m.label))
                            .foregroundStyle(m.color)
                    }
                }
            }
            if line != .none, let d = overlay {
                // Nil periods are skipped, so consecutive real points
                // connect across the gap — the web's connectNulls.
                ForEach(rows) { r in
                    if let v = line.value(r) {
                        LineMark(x: .value("Period", r.period),
                                 y: .value("Overlay", toUSD(v, d, usd)))
                            .foregroundStyle(Term.white)
                            .lineStyle(StrokeStyle(lineWidth: 1.4))
                            .interpolationMethod(.monotone)
                        PointMark(x: .value("Period", r.period),
                                  y: .value("Overlay", toUSD(v, d, usd)))
                            .foregroundStyle(Term.white)
                            .symbolSize(12)
                    }
                }
            }
        }
        .chartYScale(domain: usd.lo...usd.hi)
        .chartXAxis {
            AxisMarks(values: xTicks(rows)) { value in
                AxisTick().foregroundStyle(Term.border)
                AxisValueLabel {
                    if let s = value.as(String.self) {
                        Text(s).font(Term.mono(9)).foregroundStyle(Term.fgDim)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine().foregroundStyle(Term.border.opacity(0.5))
                AxisTick().foregroundStyle(Term.border)
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text(Fmt.compact(v))
                            .font(Term.mono(9))
                            .foregroundStyle(Term.fgDim)
                    }
                }
            }
            AxisMarks(position: .trailing, values: trailingTicks) { value in
                AxisTick().foregroundStyle(Term.border)
                AxisValueLabel {
                    if let d = overlay, let y = value.as(Double.self) {
                        Text(line.axisFormat(fromUSD(y, d, usd)))
                            .font(Term.mono(9))
                            .foregroundStyle(Term.fgDim)
                    }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle().fill(Color.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let pt):
                            guard let anchor = proxy.plotFrame else {
                                hovered = nil
                                return
                            }
                            let frame = geo[anchor]
                            guard frame.width > 0, frame.contains(pt) else {
                                hovered = nil
                                return
                            }
                            // Index math instead of proxy.value(atX:):
                            // deterministic over a band scale, and the
                            // bands are equal-width by construction.
                            let rel = (pt.x - frame.minX) / frame.width
                            let idx = Int(rel * CGFloat(rows.count))
                            hovered = rows[max(0, min(rows.count - 1, idx))].period
                        case .ended:
                            hovered = nil
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Data

    private func load() async {
        guard !sym.isEmpty else {
            state = .failed("Enter a ticker to load GF.")
            return
        }
        state = .loading
        brief = ""
        do {
            let data = try await API.shared.get(
                "/terminal/fundamentals/\(sym)",
                query: ["freq": freq.rawValue])
            let p = try await API.shared.decode(Payload.self, from: data)
            state = .loaded(p)
            await loadBrief(p)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    // AI brief once the series resolves (≥2 periods), same context the
    // web sends so the model reads the same panel. Best-effort: a dead
    // annotate endpoint degrades to "No brief available.", never to a
    // failed panel — the chart is the product, the brief is garnish.
    private func loadBrief(_ p: Payload) async {
        guard p.rows.count >= 2,
              let first = p.rows.first, let last = p.rows.last else { return }
        briefLoading = true
        defer { briefLoading = false }

        var lines = [
            "\(p.name ?? sym) — \(freq.rawValue) fundamentals, \(p.rows.count) periods (\(first.period) → \(last.period)).",
            "Latest: revenue \(Fmt.compact(last.revenue)), net income \(Fmt.compact(last.netIncome)), net margin \(LineMetric.netMargin.format(last.netMargin)), diluted EPS \(Fmt.money(last.epsDiluted)).",
        ]
        if let a = first.revenue, let b = last.revenue, a != 0 {
            let g = b / a - 1
            lines.append("Revenue \(g >= 0 ? "up" : "down") \(Fmt.pct(abs(g) * 100, decimals: 1, signed: false)) across the window.")
        }

        struct Annotation: Decodable { let brief: String? }
        do {
            let data = try await API.shared.post("/terminal/annotate", json: [
                "ticker": sym,
                "function": "GF",
                "context": lines.joined(separator: "\n"),
            ])
            let a = try await API.shared.decode(Annotation.self, from: data)
            // A cancelled task (ticker or freq changed mid-flight) must
            // not stamp the old dataset's brief onto the new one.
            if !Task.isCancelled { brief = a.brief ?? "" }
        } catch {
            if !Task.isCancelled { brief = "" }
        }
    }
}
