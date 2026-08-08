import SwiftUI
import Charts

// GP — the price graph, off /terminal/chart/:ticker (PriceBar cache,
// daily bars, lazy 5y backfill). The one panel that steps off amber:
// a white close line over a navy wash, because a price line in the
// text color disappears into every other number on screen.
//
// The web panel overlays a live last/change from /terminal/quotes on
// a ~20s shared poll. There is no shared poller in this app yet, so
// the headline here is the cache's latest close against the prior
// bar — end-of-day honest, and labelled "daily" so nobody reads it
// as a live tape.
//
// 1D and 3D exist as buttons but stay disabled, same as the web: the
// PriceBar cache is end-of-day only, and a disabled button that says
// why beats a missing one that makes GP look thinner than Bloomberg's.
struct ChartPanel: View {
    let ticker: String

    // The route forwards whole OHLCV bars, not just closes — the
    // session header reads open/high/low/volume. `t` is epoch millis.
    // Every field optional: the cache only stores rows with a close,
    // but that is an ingest detail, not a contract.
    struct Point: Decodable, Identifiable {
        let t: Double?
        let open: Double?
        let high: Double?
        let low: Double?
        let close: Double?
        let volume: Double?
        var id: Double { t ?? 0 }
        var date: Date { Date(timeIntervalSince1970: (t ?? 0) / 1000) }
    }

    struct Payload: Decodable {
        let ticker: String?
        let range: String?
        let interval: String?
        let points: [Point]
    }

    // The web's RANGES, verbatim: label the user sees, query param the
    // server takes. nil param = intraday, no source, button disabled.
    private struct RangeOpt { let id: String; let param: String? }
    private static let ranges: [RangeOpt] = [
        .init(id: "1D", param: nil),
        .init(id: "3D", param: nil),
        .init(id: "1M", param: "1mo"),
        .init(id: "6M", param: "6mo"),
        .init(id: "YTD", param: "ytd"),
        .init(id: "1Y", param: "1y"),
        .init(id: "5Y", param: "5y"),
        .init(id: "Max", param: "max"),
    ]

    // Overlay studies (GP's "Mov Avgs", generalized to SMA/EMA).
    // Colors handed out in order, deliberately off the white line and
    // the navy fill so each study reads as its own series.
    private struct Study: Identifiable {
        let id: String
        let type: String
        let period: Int
        let color: Color
    }
    private static let studyColors: [Color] = [
        Term.fg, Term.cyan, Term.magenta, Term.blue, Term.positive,
    ]
    private static let maxStudies = 5

    @State private var state: Loadable<Payload> = .loading
    @State private var rangeId = "1Y"
    @State private var studies: [Study] = []
    @State private var adding = false
    @State private var draftType = "SMA"
    @State private var draftPeriod = "50"
    @State private var hoverIdx: Int? = nil

    private var sym: String { ticker.uppercased() }

    var body: some View {
        if sym.isEmpty {
            PanelMessage(text: "Enter a ticker to load GP.")
        } else {
            let s = loadedStats
            VStack(alignment: .leading, spacing: 0) {
                header(s)
                toolbar
                studiesRail
                Divider().overlay(Term.border)
                // Chrome stays put across all three states so a failed
                // range is never a dead end — the buttons that escape
                // it are right there above the error.
                PanelState(state: state,
                           emptyWhen: { $0.points.isEmpty },
                           emptyText: "No history.",
                           retry: { Task { await load() } }) { p in
                    loadedContent(p, s)
                }
            }
            // One key covers both reload triggers: new ticker from the
            // pane, new range from the buttons.
            .task(id: "\(sym)|\(rangeId)") { await load() }
        }
    }

    // MARK: Header — GP's quote block

    private func header(_ s: Stats?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(sym)
                    .font(Term.mono(14, weight: .bold))
                    .foregroundStyle(Term.amber)
                Text("Equity · GP")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                if let s {
                    let tone = Term.delta(s.changeAbs)
                    Text(s.up ? "▲" : "▼")
                        .font(Term.mono(11))
                        .foregroundStyle(tone)
                    Text(Fmt.money(s.last))
                        .font(Term.mono(14, weight: .bold))
                        .foregroundStyle(tone)
                    Text(signed(s.changeAbs))
                        .font(Term.mono(11))
                        .foregroundStyle(tone)
                    Text(Fmt.pct(s.changePct.map { $0 * 100 }))
                        .font(Term.mono(11))
                        .foregroundStyle(tone)
                }
                Spacer()
            }
            if let s { sessionRow(s) }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private func sessionRow(_ s: Stats) -> some View {
        HStack(spacing: 10) {
            pair("O", Fmt.money(s.bar.open))
            pair("H", Fmt.money(s.bar.high))
            pair("L", Fmt.money(s.bar.low))
            pair("Vol", Fmt.compact(s.bar.volume))
            pair("Val", Fmt.compact(s.val))
            Text("Latest session · daily")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
            Spacer()
        }
    }

    private func pair(_ k: String, _ v: String) -> some View {
        HStack(spacing: 3) {
            Text(k).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            Text(v).font(Term.mono(9, weight: .medium)).foregroundStyle(Term.white)
        }
    }

    // MARK: Toolbar — range row + interval + loaded span

    private var toolbar: some View {
        HStack(spacing: 4) {
            ForEach(Self.ranges, id: \.id) { r in
                rangeButton(r)
            }
            Text("Daily ▾")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
                .padding(.leading, 4)
            Spacer()
            if let span = dateSpan {
                Text(span).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }

    private func rangeButton(_ r: RangeOpt) -> some View {
        let active = r.id == rangeId
        let enabled = r.param != nil
        return Button {
            if enabled { rangeId = r.id }
        } label: {
            Text(r.id)
                .font(Term.mono(10, weight: active ? .bold : .regular))
                .foregroundStyle(active ? Term.bg : (enabled ? Term.amber : Term.fgMuted))
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(active ? Term.amber : Color.clear)
                .overlay(Rectangle().strokeBorder(active ? Term.amber : Term.border,
                                                  lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .help(enabled ? "" : "Intraday not available — daily history only")
    }

    // MARK: Studies rail

    private var studiesRail: some View {
        HStack(spacing: 6) {
            SectionLabel(text: "Studies")
            ForEach(studies) { s in chip(s) }
            if adding {
                addControls
            } else if studies.count < Self.maxStudies {
                Button {
                    adding = true
                } label: {
                    Text("+ indicator")
                        .font(Term.mono(9))
                        .foregroundStyle(Term.fgDim)
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 5)
    }

    private func chip(_ s: Study) -> some View {
        HStack(spacing: 4) {
            Rectangle().fill(s.color).frame(width: 7, height: 7)
            Text("\(s.type) \(s.period)")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgDim)
            Button {
                studies.removeAll { $0.id == s.id }
            } label: {
                Text("×").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            .buttonStyle(.plain)
            .help("Remove")
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .overlay(Rectangle().strokeBorder(s.color.opacity(0.6), lineWidth: 1))
    }

    private var addControls: some View {
        HStack(spacing: 4) {
            Picker("", selection: $draftType) {
                Text("SMA").tag("SMA")
                Text("EMA").tag("EMA")
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .controlSize(.small)
            .frame(width: 64)
            TextField("50", text: $draftPeriod)
                .textFieldStyle(.plain)
                .font(Term.mono(10))
                .foregroundStyle(Term.white)
                .frame(width: 34)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(Term.bg)
                .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
                .onSubmit { addStudy() }
            Button {
                addStudy()
            } label: {
                Text("Add").font(Term.mono(9)).foregroundStyle(Term.amber)
            }
            .buttonStyle(.plain)
            Button {
                adding = false
            } label: {
                Text("×").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
            .buttonStyle(.plain)
        }
    }

    private func addStudy() {
        // Same clamp as the web: garbage input becomes period 1, which
        // draws as a copy of the price line — visible, therefore fixable.
        let period = min(400, max(1, Int(draftPeriod) ?? 1))
        guard studies.count < Self.maxStudies else { adding = false; return }
        let color = Self.studyColors[studies.count % Self.studyColors.count]
        studies.append(Study(id: "\(draftType)\(period)-\(UUID().uuidString.prefix(6))",
                             type: draftType, period: period, color: color))
        adding = false
    }

    // MARK: Chart

    @ViewBuilder
    private func loadedContent(_ p: Payload, _ s: Stats?) -> some View {
        // Bars without a close cannot be plotted or averaged; drop them
        // once here so every downstream index lines up.
        let pts = p.points.filter { $0.t != nil && $0.close != nil }
        if pts.isEmpty {
            PanelMessage(text: "No history.")
        } else {
            chartArea(pts, s, computeStudySeries(pts))
        }
    }

    private func chartArea(_ pts: [Point], _ s: Stats?,
                           _ series: [StudySeries]) -> some View {
        // Measured, not guessed. A fixed headroom fraction cleared the
        // legend in a tall pane and lost to it in a short one — the
        // legend is ~80pt regardless of pane size, so the fraction it
        // needs GROWS as the pane shrinks. GeometryReader gives the real
        // height and the domain gets exactly the padding that puts the
        // series below the legend block, plus a margin, at every size.
        GeometryReader { geo in
            let legendClear = min(0.5, (Self.legendHeightEstimate + 14) / max(geo.size.height, 120))
            let dom = yDomain(pts, topFraction: max(0.06, legendClear))
            chartBody(pts, s, series, dom: dom)
        }
    }

    /// Four mono lines plus padding — stable enough to size against.
    private static let legendHeightEstimate: CGFloat = 84

    private func chartBody(_ pts: [Point], _ s: Stats?,
                           _ series: [StudySeries], dom: ClosedRange<Double>) -> some View {
        return Chart {
            priceMarks(pts, base: dom.lowerBound)
            studyMarks(series)
            lastPriceRule(s?.last)
        }
        .chartYScale(domain: dom)
        .chartXScale(domain: xDomain(pts))
        // Gridlines are omitted, not styled to invisible — the marks
        // simply aren't declared. Labels only, in the muted ink.
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 6)) { value in
                AxisValueLabel {
                    if let d = value.as(Date.self) {
                        Text(tickLabel(d))
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
        .overlay(alignment: .topLeading) {
            if let s { legend(s).padding(.leading, 8).padding(.top, 6) }
        }
        .overlay(alignment: .topTrailing) {
            if let i = hoverIdx, pts.indices.contains(i) {
                hoverBox(pts[i], series)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }

    @ChartContentBuilder
    private func priceMarks(_ pts: [Point], base: Double) -> some ChartContent {
        ForEach(pts) { p in
            if let c = p.close {
                // yStart pinned to the domain floor: the default area
                // baseline is zero, which on an auto-scaled stock chart
                // would drag the whole plot down to make room for it.
                AreaMark(x: .value("Date", p.date),
                         yStart: .value("Base", base),
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
    }

    @ChartContentBuilder
    private func studyMarks(_ series: [StudySeries]) -> some ChartContent {
        ForEach(series) { st in
            ForEach(st.points) { sp in
                LineMark(x: .value("Date", sp.date),
                         y: .value("Value", sp.value),
                         series: .value("Series", st.id))
                    .foregroundStyle(st.color)
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .interpolationMethod(.monotone)
            }
        }
    }

    @ChartContentBuilder
    private func lastPriceRule(_ last: Double?) -> some ChartContent {
        if let last {
            RuleMark(y: .value("Last", last))
                .foregroundStyle(Term.gpLine.opacity(0.6))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                .annotation(position: .top, alignment: .trailing, spacing: 2) {
                    Text(Fmt.money(last))
                        .font(Term.mono(9, weight: .bold))
                        .foregroundStyle(Term.bg)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Term.gpLine)
                }
        }
    }

    private var areaFill: LinearGradient {
        LinearGradient(colors: [Term.gpArea.opacity(0.45),
                                Term.gpArea.opacity(0.02)],
                       startPoint: .top, endPoint: .bottom)
    }

    // MARK: Legend + hover readout

    private func legend(_ s: Stats) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            legendRow("Last Price", Fmt.money(s.last))
            legendRow("High on \(mdy(s.highDate))", Fmt.money(s.high))
            legendRow("Average", Fmt.money(s.avg))
            legendRow("Low on \(mdy(s.lowDate))", Fmt.money(s.low))
        }
        .padding(6)
        .background(Term.bgPanel.opacity(0.85))
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    private func legendRow(_ k: String, _ v: String) -> some View {
        HStack(spacing: 6) {
            Text(k).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            Spacer(minLength: 4)
            Text(v).font(Term.mono(9, weight: .medium)).foregroundStyle(Term.white)
        }
    }

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

    private func hoverBox(_ p: Point, _ series: [StudySeries]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(mdy(p.date))
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.white)
            HStack(spacing: 6) {
                pair("O", Fmt.money(p.open))
                pair("H", Fmt.money(p.high))
                pair("L", Fmt.money(p.low))
                pair("C", Fmt.money(p.close))
            }
            if p.volume != nil {
                pair("Vol", Fmt.compact(p.volume))
            }
            ForEach(series) { st in
                if let t = p.t, let v = st.byT[t] {
                    Text("\(st.label): \(Fmt.money(v))")
                        .font(Term.mono(9))
                        .foregroundStyle(st.color)
                }
            }
        }
        .padding(6)
        .background(Term.bgPanel.opacity(0.92))
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
        .padding(.trailing, 8)
        .padding(.top, 6)
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

    // MARK: Derived numbers

    // The web's stats memo: headline last/change (prior bar → latest,
    // so the change reads yesterday→now), window high/low/average for
    // the floating legend, latest bar + traded value for the header.
    private struct Stats {
        let bar: Point
        let last: Double?
        let changeAbs: Double?
        let changePct: Double?
        let high: Double?
        let highDate: Date?
        let low: Double?
        let lowDate: Date?
        let avg: Double?
        let val: Double?
        var up: Bool { (changeAbs ?? 0) >= 0 }

        init?(_ points: [Point]) {
            guard let lastBar = points.last else { return nil }
            bar = lastBar
            last = lastBar.close
            let prevClose = points.count > 1 ? points[points.count - 2].close : nil
            if let l = last, let pc = prevClose {
                changeAbs = l - pc
                changePct = pc != 0 ? (l - pc) / pc : nil
            } else {
                changeAbs = nil
                changePct = nil
            }
            var hi = -Double.infinity, lo = Double.infinity
            var hiD: Date? = nil, loD: Date? = nil
            var sum = 0.0, n = 0
            for p in points {
                guard let c = p.close else { continue }
                if c > hi { hi = c; hiD = p.date }
                if c < lo { lo = c; loD = p.date }
                sum += c
                n += 1
            }
            high = n > 0 ? hi : nil
            highDate = hiD
            low = n > 0 ? lo : nil
            lowDate = loD
            avg = n > 0 ? sum / Double(n) : nil
            val = (lastBar.close != nil && lastBar.volume != nil)
                ? lastBar.close! * lastBar.volume! : nil
        }
    }

    private var loadedStats: Stats? {
        guard case .loaded(let p) = state else { return nil }
        return Stats(p.points.filter { $0.t != nil && $0.close != nil })
    }

    private var dateSpan: String? {
        guard case .loaded(let p) = state else { return nil }
        let pts = p.points.filter { $0.t != nil }
        guard let f = pts.first, let l = pts.last else { return nil }
        return "\(mdy(f.date)) – \(mdy(l.date))"
    }

    private func yDomain(_ pts: [Point], topFraction: CGFloat) -> ClosedRange<Double> {
        let closes = pts.compactMap(\.close)
        guard let lo = closes.min(), let hi = closes.max(), hi > lo else {
            let v = closes.first ?? 0
            return (v - 1)...(v + 1)
        }
        // Asymmetric, the way Bloomberg ranges GP: real headroom above
        // the series so the floating legend only covers empty sky. The
        // top fraction arrives MEASURED from the pane's actual height —
        // a fixed percentage cleared tall panes and collided in short
        // ones. topFraction is the share of the final plot height the
        // legend needs, so the data occupies (1 - f) and the padding in
        // price units is range * f / (1 - f).
        let range = hi - lo
        let f = Double(min(topFraction, 0.6))
        let topPad = range * f / max(1 - f, 0.4)
        return (lo - range * 0.04)...(hi + topPad)
    }

    private func xDomain(_ pts: [Point]) -> ClosedRange<Date> {
        let first = pts.first?.date ?? Date()
        let last = pts.last?.date ?? Date()
        return first <= last ? first...last : last...first
    }

    // MARK: Studies math

    private struct StudySeries: Identifiable {
        struct Pt: Identifiable {
            let id: Double
            let date: Date
            let value: Double
        }
        let id: String
        let color: Color
        let label: String
        let points: [Pt]
        let byT: [Double: Double]
    }

    private func computeStudySeries(_ pts: [Point]) -> [StudySeries] {
        guard !studies.isEmpty, !pts.isEmpty else { return [] }
        let closes = pts.map { $0.close ?? 0 } // pre-filtered, never 0
        return studies.map { st in
            let vals = st.type == "EMA" ? ema(closes, st.period)
                                        : sma(closes, st.period)
            var out: [StudySeries.Pt] = []
            var byT: [Double: Double] = [:]
            for (i, v) in vals.enumerated() {
                guard let v else { continue }
                let p = pts[i]
                out.append(.init(id: p.t ?? Double(i), date: p.date, value: v))
                if let t = p.t { byT[t] = v }
            }
            return StudySeries(id: st.id, color: st.color,
                               label: "\(st.type) \(st.period)",
                               points: out, byT: byT)
        }
    }

    // Both return arrays aligned to the input, nil until enough
    // lookback has accumulated, so an overlay never draws a
    // misleading early stub. Straight ports of the web's math.
    private func sma(_ closes: [Double], _ period: Int) -> [Double?] {
        var out = [Double?](repeating: nil, count: closes.count)
        guard period >= 1 else { return out }
        var sum = 0.0
        for i in closes.indices {
            sum += closes[i]
            if i >= period { sum -= closes[i - period] }
            if i >= period - 1 { out[i] = sum / Double(period) }
        }
        return out
    }

    private func ema(_ closes: [Double], _ period: Int) -> [Double?] {
        var out = [Double?](repeating: nil, count: closes.count)
        guard period >= 1, !closes.isEmpty else { return out }
        let k = 2.0 / Double(period + 1)
        // Seed on the first full window's SMA so the curve starts on a
        // real average rather than the opening print.
        var prev = 0.0
        var seed = 0.0
        for i in closes.indices {
            if i < period {
                seed += closes[i]
                if i == period - 1 {
                    prev = seed / Double(period)
                    out[i] = prev
                }
                continue
            }
            prev = closes[i] * k + prev * (1 - k)
            out[i] = prev
        }
        return out
    }

    // MARK: Formatting helpers

    // Composes Fmt rather than replacing it: the header change needs
    // an explicit plus, which Fmt.money by design does not add.
    private func signed(_ v: Double?) -> String {
        guard let v else { return "—" }
        return (v >= 0 ? "+" : "") + Fmt.money(v)
    }

    // Fmt.date takes ISO strings; these bars carry epoch millis, and
    // the web renders MM/DD/YYYY here, so this stays local to GP.
    private func mdy(_ d: Date?) -> String {
        guard let d else { return "—" }
        return d.formatted(.dateTime.month(.twoDigits).day(.twoDigits).year())
    }

    private func tickLabel(_ d: Date) -> String {
        switch rangeId {
        case "1M":        return d.formatted(.dateTime.month(.defaultDigits).day())
        case "5Y", "Max": return d.formatted(.dateTime.year())
        default:          return d.formatted(.dateTime.month(.abbreviated))
        }
    }

    // MARK: Load

    private func load() async {
        hoverIdx = nil
        // Disabled ranges can't be selected, but a guard beats trusting
        // that forever — the web bails the same way.
        guard let param = Self.ranges.first(where: { $0.id == rangeId })?.param
        else { return }
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/chart/\(sym)",
                                                query: ["range": param])
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
