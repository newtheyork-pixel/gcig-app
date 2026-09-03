import SwiftUI

// A price line, drawn by hand rather than with Swift Charts.
//
// Charts would give axes, gridlines and rounded everything for free, and
// every one of those is a thing to then talk back out of it. What this
// needs is small: a line, a soft fill under it, an emphasised endpoint,
// and a dashed rule at our average cost when we own the name. Drawing it
// directly is fewer lines than configuring it away.
//
// The range buttons are the whole interaction. A phone chart nobody can
// scrub is fine; a phone chart stuck on one window is not, because the
// question is almost always "against what period".

struct ChartPoint {
    let t: Double
    let close: Double
}

struct PriceChart: View {
    let points: [ChartPoint]
    /// Drawn as a dashed rule when we hold the name, so the line is read
    /// against what we paid rather than against zero.
    var averageCost: Double? = nil
    var height: CGFloat = 160

    private var closes: [Double] { points.map(\.close) }

    /// The band the line is drawn in. Average cost is folded in when it is
    /// close enough to be worth seeing: a cost far outside the window
    /// would flatten the price line into a straight edge to make room for
    /// a rule, which loses the thing the chart is for.
    /// A perfectly flat series is real data, not missing data.
    ///
    /// The guard here was `hi > lo`, so a name that closed at the same price
    /// every day in the window — a halted stock, a cash-like holding, a
    /// short window on a quiet name — returned nil and the screen said "Not
    /// enough history", which is a claim about our records rather than about
    /// the price. When every close is equal the band is invented around the
    /// level and the line is drawn flat, which is the truth.
    private var bounds: (lo: Double, hi: Double)? {
        guard let lo = closes.min(), let hi = closes.max() else { return nil }
        guard hi > lo else {
            let pad = max(abs(hi) * 0.01, 0.01)
            var low = lo - pad, high = hi + pad
            if let c = averageCost { low = min(low, c); high = max(high, c) }
            return (low, high)
        }
        let pad = (hi - lo) * 0.08
        var low = lo - pad, high = hi + pad
        if let c = averageCost, c > lo - (hi - lo), c < hi + (hi - lo) {
            low = min(low, c); high = max(high, c)
        }
        return (low, high)
    }

    /// Up or down over the window, which is what colours the line. The
    /// day's move is a different question and belongs to the quote above.
    private var rising: Bool {
        guard let f = closes.first, let l = closes.last else { return true }
        return l >= f
    }

    var body: some View {
        GeometryReader { geo in
            if let b = bounds, points.count > 1 {
                let w = geo.size.width, h = geo.size.height
                let tone = rising ? T.positive : T.negative
                let x = { (i: Int) in w * CGFloat(i) / CGFloat(points.count - 1) }
                let y = { (v: Double) in
                    h - CGFloat((v - b.lo) / (b.hi - b.lo)) * h
                }

                ZStack {
                    // The fill first, so the line sits on top of its own
                    // shadow rather than under it.
                    Path { p in
                        p.move(to: CGPoint(x: 0, y: h))
                        for (i, pt) in points.enumerated() {
                            p.addLine(to: CGPoint(x: x(i), y: y(pt.close)))
                        }
                        p.addLine(to: CGPoint(x: w, y: h))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [tone.opacity(0.22), tone.opacity(0)],
                                         startPoint: .top, endPoint: .bottom))

                    Path { p in
                        for (i, pt) in points.enumerated() {
                            let point = CGPoint(x: x(i), y: y(pt.close))
                            if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
                        }
                    }
                    .stroke(tone, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))

                    if let c = averageCost, c >= b.lo, c <= b.hi {
                        Path { p in
                            p.move(to: CGPoint(x: 0, y: y(c)))
                            p.addLine(to: CGPoint(x: w, y: y(c)))
                        }
                        .stroke(T.amber.opacity(0.7),
                                style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }

                    // The endpoint, because the last print is the one the
                    // reader came for.
                    if let last = closes.last {
                        Rectangle()
                            .fill(tone)
                            .frame(width: 4, height: 4)
                            .position(x: w, y: y(last))
                    }
                }
            } else {
                // Not an error: a name with one bar has nothing to draw.
                Text("Not enough history to chart.")
                    .font(Type.meta).foregroundStyle(T.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: height)
    }
}

/// The ranges the server actually accepts. Anything else is a 400, so the
/// list lives next to the chart rather than being typed at a call site.
enum ChartRange: String, CaseIterable, Identifiable {
    case m1 = "1mo", m3 = "3mo", m6 = "6mo", y1 = "1y", y5 = "5y", max = "max"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .m1: return "1M"
        case .m3: return "3M"
        case .m6: return "6M"
        case .y1: return "1Y"
        case .y5: return "5Y"
        case .max: return "MAX"
        }
    }
}

struct RangePicker: View {
    @Binding var range: ChartRange
    var body: some View {
        HStack(spacing: 0) {
            ForEach(ChartRange.allCases) { r in
                Button { range = r } label: {
                    Text(r.label)
                        .font(Type.chip)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.s)
                        .background(range == r ? T.amber : Color.clear)
                        .foregroundStyle(range == r ? T.bg : T.dim)
                }
                .buttonStyle(.plain)
            }
        }
        .overlay(Rectangle().strokeBorder(T.border, lineWidth: 1))
    }
}
