import SwiftUI

// CON — a ticker's analyst recommendation breakdown.
//
// Shape comes from getConsensus in marketData.js: the newest period's
// strong-buy → strong-sell distribution plus up to six recent periods,
// newest first, off Finnhub's /stock/recommendation feed. The server
// coerces every count to a number and degrades to an honest-empty 200
// ({ latest:null, trend:[] }) on any miss, so a coverage gap here is a
// fact about the name — ETFs and thin names — not a failure to load.
//
// The web panel hands the loaded distribution to /terminal/annotate
// for an AI brief, but only when there is coverage to read: with no
// latest row and no trend the model has nothing to ground on, and an
// honest "no coverage" line beats an invented read. That guard is the
// part of the port most worth keeping.
struct ConsensusPanel: View {
    let ticker: String

    // Counts are declared optional because the API owes us nothing,
    // but they render zero-filled, not em-dashed: the server forces
    // every bucket to a number and the web does `|| 0` on top, and
    // the proportion math needs zeros anyway. A missing bucket IS
    // zero analysts here, unlike a missing price.
    struct Row: Decodable {
        let period: String?
        let strongBuy: Int?
        let buy: Int?
        let hold: Int?
        let sell: Int?
        let strongSell: Int?

        var nStrongBuy: Int { strongBuy ?? 0 }
        var nBuy: Int { buy ?? 0 }
        var nHold: Int { hold ?? 0 }
        var nSell: Int { sell ?? 0 }
        var nStrongSell: Int { strongSell ?? 0 }
        var total: Int { nStrongBuy + nBuy + nHold + nSell + nStrongSell }
    }

    struct Payload: Decodable {
        let ticker: String?
        let latest: Row?
        let trend: [Row]?
    }

    private struct Brief: Decodable {
        let brief: String?
    }

    // One bucket of the distribution, in display order. The buy side
    // is green, the sell side red, holds the dim neutral — the same
    // positive/negative vocabulary every other panel uses. Hold is
    // deliberately fgDim, not full amber: the web paints it with the
    // dim foreground at half opacity so the middle of the bar reads
    // as ballast, not as a third signal.
    private struct Part {
        let label: String
        let short: String
        let n: Int
        let color: Color
        let mid: Bool
    }

    private static func parts(_ r: Row) -> [Part] {
        [
            Part(label: "Strong Buy", short: "STRONG BUY", n: r.nStrongBuy,
                 color: Term.positive, mid: false),
            Part(label: "Buy", short: "BUY", n: r.nBuy,
                 color: Term.positive, mid: false),
            Part(label: "Hold", short: "HOLD", n: r.nHold,
                 color: Term.fgDim, mid: true),
            Part(label: "Sell", short: "SELL", n: r.nSell,
                 color: Term.negative, mid: false),
            Part(label: "Strong Sell", short: "STRONG SELL", n: r.nStrongSell,
                 color: Term.negative, mid: false),
        ]
    }

    // Periods arrive as bare ISO days (YYYY-MM-DD) that Finnhub means
    // as monthly snapshots, so a "Jun 26" label is the honest
    // precision. Parsed in local time on purpose: reading a bare day
    // as UTC midnight slips it back a day anywhere west of UTC, which
    // shifts the month the panel shows. Same guard the web keeps.
    private static func fmtPeriod(_ s: String?) -> String {
        guard let s, !s.isEmpty else { return "—" }
        let inFmt = DateFormatter()
        inFmt.locale = Locale(identifier: "en_US_POSIX")
        inFmt.timeZone = .current
        inFmt.dateFormat = "yyyy-MM-dd"
        guard let d = inFmt.date(from: s) else { return "—" }
        let outFmt = DateFormatter()
        outFmt.locale = Locale(identifier: "en_US_POSIX")
        outFmt.dateFormat = "MMM yy"
        return outFmt.string(from: d)
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var brief = ""
    @State private var briefLoading = false

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.latest == nil && ($0.trend ?? []).isEmpty },
                   emptyText: "No analyst coverage for \(ticker.uppercased()) — common for ETFs, funds, and thinly-covered names.",
                   retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let l = p.latest {
                            latestBlock(l)
                        } else {
                            // The trend can exist without a latest
                            // row only in a degraded payload; the web
                            // names it rather than leaving a hole.
                            Text("No latest-period breakdown on file.")
                                .font(Term.mono(11))
                                .foregroundStyle(Term.fgMuted)
                        }
                        briefBlock
                        trendBlock(p.trend ?? [])
                        Text("Finnhub analyst recommendation trend · newest first · 24h cache. Greens are the buy side, reds the sell side.")
                            .font(Term.mono(10))
                            .foregroundStyle(Term.fgMuted)
                    }
                    .padding(12)
                }
            }
        }
        .task(id: ticker) { await load() }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            Text((p.ticker ?? ticker).uppercased())
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            SectionLabel(text: "Analyst Consensus")
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Latest breakdown

    private func latestBlock(_ l: Row) -> some View {
        let parts = Self.parts(l)
        let total = l.total
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                SectionLabel(text: "Latest Breakdown")
                Text(Self.fmtPeriod(l.period))
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgMuted)
                Spacer()
                Text("\(total)")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                + Text(" analyst\(total == 1 ? "" : "s")")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgMuted)
            }

            // Proportion bar — each bucket's share of the analyst
            // count. A zero bucket simply contributes no width, and
            // an all-zero row leaves the empty frame rather than
            // faking a distribution.
            GeometryReader { geo in
                HStack(spacing: 0) {
                    if total > 0 {
                        ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                            if p.n > 0 {
                                Rectangle()
                                    .fill(p.color)
                                    .opacity(p.mid ? 0.5 : 0.85)
                                    .frame(width: geo.size.width * CGFloat(p.n) / CGFloat(total))
                            }
                        }
                    }
                }
            }
            .frame(height: 8)
            .frame(maxWidth: .infinity)
            .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))

            // Legend: label, count in the bucket's colour, share of
            // total. Adaptive grid stands in for the web's flex-wrap.
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 14, alignment: .leading)],
                      alignment: .leading, spacing: 6) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(p.label)
                            .font(Term.mono(11))
                            .foregroundStyle(Term.fgDim)
                        Text("\(p.n)")
                            .font(Term.mono(11, weight: .medium))
                            .foregroundStyle(p.color)
                        Text("(\(total > 0 ? Int((Double(p.n) / Double(total) * 100).rounded()) : 0)%)")
                            .font(Term.mono(10))
                            .foregroundStyle(Term.fgMuted)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    // MARK: AI brief

    private var briefBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("◢ AI BRIEF")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(Term.amber)
            Text(briefLoading ? "Generating…" : (brief.isEmpty ? "No brief available." : brief))
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .lineSpacing(2)
                .textSelection(.enabled)
        }
    }

    // MARK: Trend table

    private let periodW: CGFloat = 56
    private let numW: CGFloat = 66

    @ViewBuilder
    private func trendBlock(_ trend: [Row]) -> some View {
        if trend.isEmpty {
            Text("No recommendation history on file.")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("PERIOD")
                        .frame(width: periodW, alignment: .leading)
                    ForEach(Array(["STRONG BUY", "BUY", "HOLD", "SELL", "STRONG SELL"].enumerated()),
                            id: \.offset) { _, h in
                        Text(h).frame(width: numW, alignment: .trailing)
                    }
                }
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.fgMuted)
                .padding(.vertical, 4)
                Divider().overlay(Term.border)
                // Period alone is not a safe id — a degraded row can
                // arrive with an empty one — so rows key on position,
                // the same move the web makes with its index key.
                ForEach(Array(trend.enumerated()), id: \.offset) { _, r in
                    trendRow(r)
                }
            }
        }
    }

    private func trendRow(_ r: Row) -> some View {
        HStack(spacing: 8) {
            Text(Self.fmtPeriod(r.period))
                .foregroundStyle(Term.amber)
                .frame(width: periodW, alignment: .leading)
            Text("\(r.nStrongBuy)")
                .foregroundStyle(Term.positive)
                .frame(width: numW, alignment: .trailing)
            Text("\(r.nBuy)")
                .foregroundStyle(Term.positive)
                .frame(width: numW, alignment: .trailing)
            Text("\(r.nHold)")
                .foregroundStyle(Term.white)
                .frame(width: numW, alignment: .trailing)
            Text("\(r.nSell)")
                .foregroundStyle(Term.negative)
                .frame(width: numW, alignment: .trailing)
            Text("\(r.nStrongSell)")
                .foregroundStyle(Term.negative)
                .frame(width: numW, alignment: .trailing)
        }
        .font(Term.mono(11))
        .padding(.vertical, 3)
    }

    // MARK: Loading

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("CON needs a ticker.")
            return
        }
        state = .loading
        brief = ""
        briefLoading = false
        do {
            let data = try await API.shared.get("/terminal/consensus/\(ticker)")
            let p = try await API.shared.decode(Payload.self, from: data)
            state = .loaded(p)
            await loadBrief(p)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    // Confab-safe: with neither a latest breakdown nor any trend rows
    // there is nothing for the model to ground on, so /annotate is
    // never called — the coverage message stands instead of an
    // invented read. The context lines are the web's, verbatim, so
    // both clients feed the CON prompt the same evidence.
    private func loadBrief(_ p: Payload) async {
        let trend = p.trend ?? []
        guard p.latest != nil || !trend.isEmpty else { return }
        briefLoading = true
        var lines: [String] = []
        if let l = p.latest {
            let t = l.total
            lines.append(
                "Latest period \(Self.fmtPeriod(l.period)) (\(t) analyst\(t == 1 ? "" : "s")): "
                + "Strong Buy \(l.nStrongBuy), Buy \(l.nBuy), Hold \(l.nHold), "
                + "Sell \(l.nSell), Strong Sell \(l.nStrongSell)")
        }
        if !trend.isEmpty {
            lines.append("Recent trend (newest first):")
            for r in trend {
                lines.append(
                    "\(Self.fmtPeriod(r.period)): SB \(r.nStrongBuy) / B \(r.nBuy) / "
                    + "H \(r.nHold) / S \(r.nSell) / SS \(r.nStrongSell)")
            }
        }
        do {
            let data = try await API.shared.post("/terminal/annotate", json: [
                "ticker": ticker,
                "function": "CON",
                "context": lines.joined(separator: "\n"),
            ])
            brief = (try await API.shared.decode(Brief.self, from: data)).brief ?? ""
        } catch {
            // A failed brief is a missing garnish, not a failed
            // panel; the web swallows it the same way.
            brief = ""
        }
        briefLoading = false
    }
}
