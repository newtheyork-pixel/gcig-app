import SwiftUI
import Charts

// INSDR — Form 4 insider activity overlaid on the 1y price line.
//
// Two legs, fetched together like the web's allSettled pair: the price
// line reuses /terminal/chart (PriceBar cache) and the trades come from
// /terminal/insiders (Finnhub primary, SEC EDGAR fallback, 20-min
// server cache). The legs degrade independently — a dead chart leaves
// the table standing ("table only"), a dead insider feed with a chart
// up is stated as a failure over the table, never dressed as a quiet
// tape. The web collapses that second case into an empty table; the
// house rule against failure-as-empty wins here.
//
// Only open-market P (buy) / S (sell) are plotted; the toggle below the
// chart shows every code in the table, same as the web.
struct InsiderPanel: View {
    let ticker: String

    // INSDR draws only the close line — GP owns the full OHLCV bar.
    // `t` is epoch millis of the bar's UTC-midnight date.
    struct Point: Decodable, Identifiable {
        let t: Double?
        let close: Double?
        var id: Double { t ?? 0 }
        var date: Date { Date(timeIntervalSince1970: (t ?? 0) / 1000) }
    }

    // Shape from services/insiderTx.js. isBuy/isSell are the server's
    // own P/S classification — recomputing from `code` here would just
    // be a second chance to disagree with the table the web shows.
    struct Tx: Decodable {
        let date: String?
        let name: String?
        let role: String?
        let code: String?
        let isBuy: Bool?
        let isSell: Bool?
        let shares: Double?
        let price: Double?
        let value: Double?

        var isOpenMarket: Bool { (isBuy ?? false) || (isSell ?? false) }
    }

    struct ChartPayload: Decodable {
        let points: [Point]?
    }

    struct InsiderPayload: Decodable {
        let transactions: [Tx]?
        let source: String?
        enum CodingKeys: String, CodingKey {
            case transactions
            case source = "_source"
        }
    }

    private struct Brief: Decodable {
        let brief: String?
    }

    // The merged result of both legs. `chartNote` carries the failure
    // sentence when the chart leg died (nil when it merely came back
    // empty); `txError` is the insider leg's failure with a chart still
    // worth showing — the no-chart case fails the whole panel instead,
    // exactly the web's `err && !points.length` gate.
    struct Payload {
        let points: [Point]
        let chartNote: String?
        let tx: [Tx]
        let txError: String?
        let source: String?
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var openOnly = true
    @State private var brief = ""
    @State private var briefLoading = false
    @State private var hoverIdx: Int? = nil

    private var sym: String { ticker.uppercased() }

    var body: some View {
        if sym.isEmpty {
            PanelMessage(text: "Enter a ticker to load insider activity.")
        } else {
            PanelState(state: state,
                       retry: { Task { await load(); await generateBrief() } }) { p in
                content(p)
            }
            .task(id: ticker) {
                await load()
                await generateBrief()
            }
        }
    }

    // MARK: Layout

    private func content(_ p: Payload) -> some View {
        let plot = buildPlot(p.points, p.tx)
        return VStack(alignment: .leading, spacing: 0) {
            header(p)
            briefBlock
            Divider().overlay(Term.border)
            if p.points.isEmpty {
                chartUnavailable(p.chartNote)
            } else {
                chartArea(p.points, plot)
                    .frame(height: 230)
            }
            legendRow
            Divider().overlay(Term.border)
            tableSection(p)
            footnote
        }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 8) {
            Text(sym)
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.amber)
            Text("Insider Activity · Form 4")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
            if let s = p.source {
                Text(s == "sec" ? "SEC EDGAR" : "Finnhub")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: AI brief

    private var briefBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("◢ AI BRIEF")
                .font(Term.mono(9, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(Term.amber)
            if briefLoading {
                Text("Generating…")
                    .font(Term.mono(11))
                    .italic()
                    .foregroundStyle(Term.fgDim)
            } else {
                // The web's degraded line when annotate fails or there
                // was nothing to annotate — stated, not blanked.
                Text(brief.isEmpty ? "No brief available." : brief)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Term.amber.opacity(0.06))
        .overlay(Rectangle().strokeBorder(Term.fgMuted, lineWidth: 1))
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    // MARK: Chart

    // One marker per trading day per side, hung on that day's close —
    // the web learned the hard way that markers must live on the price
    // series' own x positions (a Scatter with its own data scrambled
    // the shared axes), and the same discipline keeps a transaction
    // dated outside the price window off the chart entirely. It still
    // shows in the table below.
    private struct Plot {
        struct Marker: Identifiable {
            let id: String
            let date: Date
            let close: Double
            let isBuy: Bool
        }
        let markers: [Marker]
        let txByIdx: [Int: [Tx]]
    }

    private func buildPlot(_ pts: [Point], _ tx: [Tx]) -> Plot {
        guard let firstT = pts.first?.t, let lastT = pts.last?.t else {
            return Plot(markers: [], txByIdx: [:])
        }
        var buyIdx: Set<Int> = []
        var sellIdx: Set<Int> = []
        var byIdx: [Int: [Tx]] = [:]
        for t in tx {
            guard t.isOpenMarket, let ts = Self.dayMillis(t.date),
                  ts >= firstT, ts <= lastT else { continue }
            // Nearest prior trading day: the last bar dated <= the tx,
            // so a weekend filing lands on Friday, not a phantom day.
            var idx = 0
            for (i, p) in pts.enumerated() {
                if (p.t ?? 0) <= ts { idx = i } else { break }
            }
            if t.isBuy ?? false { buyIdx.insert(idx) } else { sellIdx.insert(idx) }
            byIdx[idx, default: []].append(t)
        }
        var markers: [Plot.Marker] = []
        for i in buyIdx.sorted() {
            guard let c = pts[i].close else { continue }
            markers.append(.init(id: "b\(i)", date: pts[i].date, close: c, isBuy: true))
        }
        for i in sellIdx.sorted() {
            guard let c = pts[i].close else { continue }
            markers.append(.init(id: "s\(i)", date: pts[i].date, close: c, isBuy: false))
        }
        return Plot(markers: markers, txByIdx: byIdx)
    }

    private func chartArea(_ pts: [Point], _ plot: Plot) -> some View {
        let dom = yDomain(pts)
        return Chart {
            ForEach(pts) { p in
                if let c = p.close {
                    // Baseline pinned to the domain floor — the default
                    // zero baseline would drag an auto-scaled stock
                    // chart down to make room for it.
                    AreaMark(x: .value("Date", p.date),
                             yStart: .value("Base", dom.lowerBound),
                             yEnd: .value("Price", c))
                        .foregroundStyle(areaFill)
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Date", p.date),
                             y: .value("Price", c),
                             series: .value("Series", "price"))
                        .foregroundStyle(Term.gpLine)
                        .lineStyle(StrokeStyle(lineWidth: 1.4))
                        .interpolationMethod(.monotone)
                }
            }
            ForEach(plot.markers) { m in
                PointMark(x: .value("Date", m.date),
                          y: .value("Price", m.close))
                    .foregroundStyle(m.isBuy ? Term.positive : Term.negative)
                    .symbol {
                        TriangleMark(up: m.isBuy)
                            .fill(m.isBuy ? Term.positive : Term.negative)
                            .overlay(TriangleMark(up: m.isBuy)
                                .stroke(Term.bg, lineWidth: 0.5))
                            .frame(width: 10, height: 10)
                    }
            }
        }
        .chartYScale(domain: dom)
        .chartXScale(domain: xDomain(pts))
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 6)) { value in
                AxisValueLabel {
                    if let d = value.as(Date.self) {
                        Text(d.formatted(.dateTime.month(.abbreviated)))
                            .font(Term.mono(9))
                            .foregroundStyle(Term.fgMuted)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing) { value in
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text(String(format: "%.0f", v))
                            .font(Term.mono(9))
                            .foregroundStyle(Term.fgMuted)
                    }
                }
            }
        }
        .chartOverlay { proxy in hoverCatcher(proxy, pts) }
        .overlay(alignment: .topTrailing) {
            if let i = hoverIdx, pts.indices.contains(i) {
                hoverBox(pts, plot, i)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }

    // The web shows one sentence whether the chart leg failed or came
    // back bare; when it failed we also carry the server's sentence, so
    // a 502 is not indistinguishable from a ticker with no bars.
    private func chartUnavailable(_ note: String?) -> some View {
        Text(note.map { "Price history unavailable (\($0)) — table only." }
            ?? "Price history unavailable — table only.")
            .font(Term.mono(11))
            .foregroundStyle(Term.fgMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .padding(.horizontal, 12)
    }

    private var areaFill: LinearGradient {
        LinearGradient(colors: [Term.gpArea.opacity(0.45),
                                Term.gpArea.opacity(0.02)],
                       startPoint: .top, endPoint: .bottom)
    }

    // MARK: Hover readout

    private func hoverCatcher(_ proxy: ChartProxy, _ pts: [Point]) -> some View {
        GeometryReader { geo in
            Rectangle()
                .fill(Color.clear)
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let loc):
                        let plot = geo[proxy.plotAreaFrame]
                        guard plot.width > 0 else { return }
                        if let d = proxy.value(atX: loc.x - plot.origin.x,
                                               as: Date.self) {
                            hoverIdx = nearestIndex(in: pts, to: d)
                        }
                    case .ended:
                        hoverIdx = nil
                    }
                }
        }
    }

    private func hoverBox(_ pts: [Point], _ plot: Plot, _ i: Int) -> some View {
        let p = pts[i]
        let list = plot.txByIdx[i] ?? []
        // Buys before sells, the web tooltip's order.
        let ordered = list.filter { $0.isBuy ?? false }
            + list.filter { $0.isSell ?? false }
        return VStack(alignment: .leading, spacing: 2) {
            Text("\(Self.mdy(p.date)) · \(Fmt.money(p.close)) close")
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.white)
            ForEach(Array(ordered.enumerated()), id: \.offset) { _, t in
                Text(hoverLine(t))
                    .font(Term.mono(9))
                    .foregroundStyle((t.isBuy ?? false) ? Term.positive : Term.negative)
            }
        }
        .padding(6)
        .background(Term.bgPanel.opacity(0.92))
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
        .padding(.trailing, 8)
        .padding(.top, 6)
    }

    private func hoverLine(_ t: Tx) -> String {
        let side = (t.isBuy ?? false) ? "BUY" : "SELL"
        let role = t.role.map { " · \($0)" } ?? ""
        return "\(side) \(t.name ?? "—")\(role) — "
            + "\(Fmt.money(t.shares, decimals: 0)) @ "
            + "\(Fmt.money(t.price)) = \(Self.dollars(t.value))"
    }

    private func nearestIndex(in pts: [Point], to d: Date) -> Int? {
        guard !pts.isEmpty else { return nil }
        let target = d.timeIntervalSince1970 * 1000
        var best = 0
        var bestDist = Double.greatestFiniteMagnitude
        for (i, p) in pts.enumerated() {
            guard let t = p.t else { continue }
            let dist = abs(t - target)
            if dist < bestDist { bestDist = dist; best = i }
        }
        return best
    }

    // MARK: Legend + toggle

    private var legendRow: some View {
        HStack(spacing: 10) {
            Text("▲ buy").font(Term.mono(10)).foregroundStyle(Term.positive)
            Text("▼ sell").font(Term.mono(10)).foregroundStyle(Term.negative)
            Spacer()
            Button(openOnly ? "Open-market only" : "All codes") {
                openOnly.toggle()
            }
            .buttonStyle(TermButtonStyle())
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    // MARK: Table

    @ViewBuilder
    private func tableSection(_ p: Payload) -> some View {
        if let e = p.txError {
            // The web quietly rendered this as an empty table. A dead
            // feed is a failure, and it says so in the failure dress.
            VStack(spacing: 8) {
                Text("INSIDER FEED FAILED")
                    .font(Term.mono(10, weight: .bold))
                    .foregroundStyle(Term.negative)
                Text(e)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .multilineTextAlignment(.center)
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let rows = openOnly ? p.tx.filter(\.isOpenMarket) : p.tx
            if rows.isEmpty {
                // Two different empties: a genuinely quiet tape, and a
                // tape whose every trade is behind the code toggle.
                PanelMessage(text: p.tx.isEmpty
                    ? "No Form 4 activity in the last 24 months."
                    : "No open-market P/S trades — \(p.tx.count) other-code filings behind All codes.")
            } else {
                VStack(spacing: 0) {
                    tableHeader
                    Divider().overlay(Term.border)
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { _, t in
                                row(t)
                            }
                        }
                    }
                }
                .frame(maxHeight: .infinity)
            }
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 8) {
            cap("DATE").frame(width: 58, alignment: .leading)
            cap("INSIDER").frame(maxWidth: .infinity, alignment: .leading)
            cap("ROLE").frame(width: 110, alignment: .leading)
            cap("TX").frame(width: 26, alignment: .trailing)
            cap("SHARES").frame(width: 76, alignment: .trailing)
            cap("PRICE").frame(width: 62, alignment: .trailing)
            cap("VALUE").frame(width: 76, alignment: .trailing)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }

    private func cap(_ s: String) -> some View {
        Text(s).font(Term.mono(9, weight: .bold)).foregroundStyle(Term.fgMuted)
    }

    private func row(_ t: Tx) -> some View {
        let codeTone: Color = (t.isBuy ?? false) ? Term.positive
            : (t.isSell ?? false) ? Term.negative : Term.fgDim
        return HStack(spacing: 8) {
            Text(Self.mdy(t.date))
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .frame(width: 58, alignment: .leading)
            Text(t.name ?? "—")
                .font(Term.mono(10, weight: .medium))
                .foregroundStyle(Term.amber)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(t.role ?? "—")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .lineLimit(1)
                .frame(width: 110, alignment: .leading)
            Text(t.code ?? "—")
                .font(Term.mono(10, weight: .medium))
                .foregroundStyle(codeTone)
                .frame(width: 26, alignment: .trailing)
            Text(Fmt.money(t.shares, decimals: 0))
                .font(Term.mono(10))
                .foregroundStyle(Term.white)
                .frame(width: 76, alignment: .trailing)
            Text(Fmt.money(t.price))
                .font(Term.mono(10))
                .foregroundStyle(Term.white)
                .frame(width: 62, alignment: .trailing)
            Text(Self.dollars(t.value))
                .font(Term.mono(10))
                .foregroundStyle(Term.white)
                .frame(width: 76, alignment: .trailing)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private var footnote: some View {
        Text("Open-market P/S plotted; M/A/F/G shown in the table only. 20-min cache.")
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
    }

    // MARK: Domains

    private func yDomain(_ pts: [Point]) -> ClosedRange<Double> {
        let closes = pts.compactMap(\.close)
        guard let lo = closes.min(), let hi = closes.max(), hi > lo else {
            let v = closes.first ?? 0
            return (v - 1)...(v + 1)
        }
        let pad = (hi - lo) * 0.04
        return (lo - pad)...(hi + pad)
    }

    private func xDomain(_ pts: [Point]) -> ClosedRange<Date> {
        let first = pts.first?.date ?? Date()
        let last = pts.last?.date ?? Date()
        return first <= last ? first...last : last...first
    }

    // MARK: Load

    private func load() async {
        state = .loading
        brief = ""
        hoverIdx = nil
        async let chartLeg = fetchChart()
        async let insLeg = fetchInsiders()
        let (chart, ins) = await (chartLeg, insLeg)

        let points: [Point]
        let chartNote: String?
        switch chart {
        case .success(let p):
            // Bars without a timestamp or close cannot be plotted or
            // marker-mapped; drop them once so every index lines up.
            points = (p.points ?? []).filter { $0.t != nil && $0.close != nil }
            chartNote = nil
        case .failure(let e):
            points = []
            chartNote = e.localizedDescription
        }

        switch ins {
        case .success(let p):
            state = .loaded(Payload(points: points,
                                    chartNote: chartNote,
                                    tx: p.transactions ?? [],
                                    txError: nil,
                                    source: p.source))
        case .failure(let e):
            // The web fails the whole panel only when there is also no
            // chart to show; with a chart up, the dead feed is stated
            // inline where the table would be.
            if points.isEmpty {
                state = .failed(e.localizedDescription)
            } else {
                state = .loaded(Payload(points: points,
                                        chartNote: chartNote,
                                        tx: [],
                                        txError: e.localizedDescription,
                                        source: nil))
            }
        }
    }

    private func fetchChart() async -> Result<ChartPayload, Error> {
        do {
            let data = try await API.shared.get("/terminal/chart/\(sym)",
                                                query: ["range": "1y",
                                                        "interval": "1d"])
            return .success(try await API.shared.decode(ChartPayload.self, from: data))
        } catch {
            return .failure(error)
        }
    }

    private func fetchInsiders() async -> Result<InsiderPayload, Error> {
        do {
            let data = try await API.shared.get("/terminal/insiders/\(sym)")
            return .success(try await API.shared.decode(InsiderPayload.self, from: data))
        } catch {
            return .failure(error)
        }
    }

    // MARK: AI brief load

    // The same call the web makes: the fifteen newest transactions,
    // formatted, through POST /terminal/annotate. A failure collapses
    // into "No brief available." rather than the panel's error state —
    // the ledger is the product, the brief is garnish.
    private func generateBrief() async {
        guard case .loaded(let p) = state, !p.tx.isEmpty else { return }
        briefLoading = true
        defer { briefLoading = false }
        let context = p.tx.prefix(15).map { t in
            "\(Self.mdy(t.date)) \(t.name ?? "—") (\(t.role ?? "—")) \(t.code ?? "") "
                + "\(Fmt.money(t.shares, decimals: 0)) @ \(Fmt.money(t.price)) "
                + "= \(Self.dollars(t.value))"
        }.joined(separator: "\n")
        do {
            let data = try await API.shared.post("/terminal/annotate",
                                                 json: ["ticker": sym,
                                                        "function": "INSDR",
                                                        "context": context])
            let b = try await API.shared.decode(Brief.self, from: data)
            brief = b.brief ?? ""
        } catch {
            brief = ""
        }
    }

    // MARK: Formatting

    // The web's fmtMoney: dollar sign plus a compact magnitude. Fmt's
    // decimal counts differ from the JS by a hair, and the house
    // formatter wins over replicating a rounding quirk.
    private static func dollars(_ v: Double?) -> String {
        guard let v else { return "—" }
        return "$" + Fmt.compact(v)
    }

    // Tx dates arrive as bare yyyy-mm-dd, which Fmt.date (built for
    // full ISO timestamps) would pass through raw. Parsed at UTC
    // midnight — the same instant JS's `new Date("yyyy-mm-dd")` picks —
    // so the chart-window comparison agrees with the web's.
    private static func parseDay(_ raw: String?) -> Date? {
        guard let raw, raw.count >= 10 else { return nil }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f.date(from: String(raw.prefix(10)))
    }

    private static func dayMillis(_ raw: String?) -> Double? {
        parseDay(raw).map { $0.timeIntervalSince1970 * 1000 }
    }

    // MM/dd/yy, the web's fmtDate.
    private static func mdy(_ raw: String?) -> String {
        guard let d = parseDay(raw) else { return "—" }
        return mdy(d)
    }

    private static func mdy(_ d: Date) -> String {
        let out = DateFormatter()
        out.dateFormat = "MM/dd/yy"
        out.timeZone = TimeZone(identifier: "UTC")
        return out.string(from: d)
    }
}

// The web's Triangle scatter shape: up for a buy, down for a sell.
// Swift Charts has no pointing-down builtin, so both directions are
// drawn by hand and handed to PointMark as a custom symbol.
private struct TriangleMark: Shape {
    let up: Bool

    func path(in rect: CGRect) -> Path {
        var p = Path()
        if up {
            p.move(to: CGPoint(x: rect.midX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        } else {
            p.move(to: CGPoint(x: rect.midX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        }
        p.closeSubpath()
        return p
    }
}
