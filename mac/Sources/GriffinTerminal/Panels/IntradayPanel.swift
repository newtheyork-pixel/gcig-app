import SwiftUI
import Charts

// GIP — today's intraday session against the prior close, the way
// Bloomberg's GIP reads: the whole line colored by the day's direction,
// a dashed baseline at previous close, pre- and post-market included.
//
// Shape comes from getIntraday in priceHistory.js, which parses NASDAQ's
// chart endpoint. Two fields bite if misread: pctChange is a FRACTION
// (0.0123 means +1.23%), and point timestamps are epoch MILLISECONDS.
// Every quote-header number passes through parseMoney/parseInt0 on the
// server, which return null for "N/A", so all of them are optional here.
struct IntradayPanel: View {
    let ticker: String

    struct Point: Decodable {
        let t: Double?      // epoch ms
        let price: Double?
    }

    struct Payload: Decodable {
        let ticker: String?
        let company: String?    // present upstream; the web GIP never renders it
        let exchange: String?
        let asOf: String?       // free-text like "Jul 28, 2026 10:03 AM ET", not ISO
        let last: Double?
        let prevClose: Double?
        let netChange: Double?
        let pctChange: Double?  // fraction, not percent
        let volume: Double?
        let points: [Point]?
    }

    /// A point both of whose coordinates actually arrived. The server
    /// filters non-finite values already, but the decode keeps them
    /// optional on principle and we drop the stragglers here.
    private struct Print: Identifiable {
        let id: Double          // the epoch-ms timestamp; unique per session
        let date: Date
        let price: Double
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var hover: Print? = nil

    var body: some View {
        PanelState(state: state, retry: { Task { await load(initial: true) } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                let prints = prints(p)
                if prints.isEmpty {
                    // Empty is a fact about the clock, not a failure: the
                    // header still shows the quote, exactly as on the web.
                    PanelMessage(text: "No intraday prints yet — the session may not have opened.")
                } else {
                    chart(p, prints)
                }
                Divider().overlay(Term.border)
                Text("Intraday line vs prior close · NASDAQ ~1-min prints, pre/post-market included · refreshes ~30s while open.")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
            }
        }
        .task(id: ticker) {
            await load(initial: true)
            // The web refreshes on a 30s cadence while the panel is
            // visible; the server caches for 45s, so this is polite.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { break }
                await load(initial: false)
            }
        }
    }

    // Direction of the day decides the line's color. Unknown counts as
    // up — same call the web makes — because a flat open with no quote
    // yet should not paint the session red.
    private func up(_ p: Payload) -> Bool {
        guard let pct = p.pctChange else { return true }
        return pct >= 0
    }

    private func prints(_ p: Payload) -> [Print] {
        (p.points ?? []).compactMap { pt in
            guard let t = pt.t, let price = pt.price else { return nil }
            return Print(id: t, date: Date(timeIntervalSince1970: t / 1000), price: price)
        }
    }

    // The session trades on New York's clock no matter where the viewer
    // sits, and the web pins the axis to ET for the same reason.
    private var etTime: Date.FormatStyle {
        Date.FormatStyle(locale: Locale(identifier: "en_US"),
                         timeZone: TimeZone(identifier: "America/New_York") ?? .current)
            .hour(.defaultDigits(amPM: .abbreviated))
            .minute(.twoDigits)
    }

    /// "+1.23" / "-0.45" — signed absolute change. Fmt has no signed
    /// money form and the sign is the whole message here.
    private func signedAbs(_ v: Double?) -> String {
        guard let v else { return "—" }
        return v >= 0 ? "+\(Fmt.money(v))" : Fmt.money(v)
    }

    // MARK: Header

    private func header(_ p: Payload) -> some View {
        let tone = up(p) ? Term.positive : Term.negative
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ticker.uppercased())
                    .font(Term.mono(14, weight: .bold))
                    .foregroundStyle(Term.amber)
                Text(p.exchange ?? "Intraday")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                Text("\(up(p) ? "▲" : "▼") \(Fmt.money(p.last))")
                    .font(Term.mono(14, weight: .bold))
                    .foregroundStyle(tone)
                Text(signedAbs(p.netChange))
                    .font(Term.mono(11, weight: .medium))
                    .foregroundStyle(tone)
                Text(Fmt.pct(p.pctChange.map { $0 * 100 }))
                    .font(Term.mono(11, weight: .medium))
                    .foregroundStyle(tone)
                Spacer()
            }
            HStack(spacing: 12) {
                Text("Prev Close \(Fmt.money(p.prevClose))")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgDim)
                if let v = p.volume {
                    Text("Vol \(Fmt.money(v, decimals: 0))")
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgDim)
                }
                Spacer()
                if let a = p.asOf {
                    Text(a).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Chart

    // The web pads the y-domain 8% past the extremes (prior close
    // included) so neither the line nor the baseline rides the frame.
    // The odd-looking fallback chain mirrors the JS `||`: a flat line
    // still gets headroom, a zero-price freak still gets a unit.
    private func yDomain(_ p: Payload, _ prints: [Print]) -> ClosedRange<Double> {
        var lo = prints.map(\.price).min() ?? 0
        var hi = prints.map(\.price).max() ?? 1
        if let pc = p.prevClose {
            lo = min(lo, pc)
            hi = max(hi, pc)
        }
        var pad = (hi - lo) * 0.08
        if pad == 0 { pad = hi * 0.01 }
        if pad == 0 { pad = 1 }
        return (lo - pad)...(hi + pad)
    }

    private func chart(_ p: Payload, _ prints: [Print]) -> some View {
        let tone = up(p) ? Term.positive : Term.negative
        let domain = yDomain(p, prints)
        return Chart {
            ForEach(prints) { pt in
                AreaMark(x: .value("Time", pt.date),
                         yStart: .value("Base", domain.lowerBound),
                         yEnd: .value("Price", pt.price))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(
                        LinearGradient(colors: [tone.opacity(0.28), tone.opacity(0.02)],
                                       startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Time", pt.date),
                         y: .value("Price", pt.price))
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 1.4))
                    .foregroundStyle(tone)
            }
            if let pc = p.prevClose {
                // The reference everything above is measured against.
                RuleMark(y: .value("Prev close", pc))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .foregroundStyle(Term.fgMuted.opacity(0.8))
            }
            if let h = hover {
                RuleMark(x: .value("Time", h.date))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Term.fgMuted.opacity(0.5))
                PointMark(x: .value("Time", h.date),
                          y: .value("Price", h.price))
                    .symbolSize(20)
                    .foregroundStyle(tone)
            }
        }
        .chartYScale(domain: domain)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { value in
                AxisTick(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Term.border)
                AxisValueLabel {
                    if let d = value.as(Date.self) {
                        Text(d.formatted(etTime))
                            .font(Term.mono(9))
                            .foregroundStyle(Term.fgDim)
                    }
                }
            }
        }
        .chartYAxis {
            // Horizontal grid only, like the web's CartesianGrid.
            AxisMarks(position: .trailing) { value in
                AxisGridLine().foregroundStyle(Term.border.opacity(0.5))
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text(Fmt.money(v))
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
                        case .active(let loc):
                            guard let anchor = proxy.plotFrame else { return }
                            let x = loc.x - geo[anchor].origin.x
                            if let d: Date = proxy.value(atX: x) {
                                hover = prints.min(by: {
                                    abs($0.date.timeIntervalSince(d)) <
                                    abs($1.date.timeIntervalSince(d))
                                })
                            }
                        case .ended:
                            hover = nil
                        }
                    }
            }
        }
        .overlay(alignment: .topLeading) {
            if let h = hover { tip(h, prevClose: p.prevClose) }
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // The hover readout: time, price, and the move vs prior close. The
    // tooltip's change is colored by ITS OWN sign, not the day's — a
    // green session can still be below the close at 9:40am.
    private func tip(_ h: Print, prevClose: Double?) -> some View {
        let chg = prevClose.map { h.price - $0 }
        let pct: Double? = {
            guard let chg, let pc = prevClose, pc != 0 else { return nil }
            return chg / pc * 100
        }()
        return VStack(alignment: .leading, spacing: 2) {
            Text(h.date.formatted(etTime))
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
            HStack(spacing: 6) {
                Text(Fmt.money(h.price))
                    .font(Term.mono(11, weight: .medium))
                    .foregroundStyle(Term.white)
                if let chg {
                    Text("\(signedAbs(chg)) (\(Fmt.pct(pct)))")
                        .font(Term.mono(10))
                        .foregroundStyle(chg >= 0 ? Term.positive : Term.negative)
                }
            }
        }
        .padding(6)
        .background(Term.bgHeader)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
        .padding(10)
        .allowsHitTesting(false)
    }

    // MARK: Load

    // `initial` is the difference between opening the panel and a 30s
    // tick. On a tick we keep whatever is on screen: the web only shows
    // an error when it has nothing to show instead, and a chart that
    // blanks every time a poll hiccups is worse than a stale one.
    private func load(initial: Bool) async {
        guard !ticker.isEmpty else {
            state = .failed("GIP needs a ticker.")
            return
        }
        if initial { state = .loading }
        do {
            let path = "/terminal/intraday/\(ticker.uppercased())"
            let data = try await API.shared.get(path)
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            if initial { state = .failed(error.localizedDescription) }
        }
    }
}
