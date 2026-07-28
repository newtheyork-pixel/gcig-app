import SwiftUI

// ICLUSTER — multi-insider open-market buy clusters across the book.
//
// Shape comes from insiderClustersHandler in terminal.js: the server
// builds the universe (holdings + a watchlist once that route ships)
// and scanUniverse ranks the qualifying clusters — ≥3 distinct
// insiders, 60d window, Form 4 code P only, role-weighted score, an
// into-weakness flag against the 90d high. The route contractually
// never 5xxes; any degradation comes back as an honest-empty 200
// ({ universe:[], results:[] }), so a failed render here means the
// request itself died, not the scan.
//
// The framing is the part that must survive the port: this is a
// screen, not a backtested signal, and the methodology footer says so
// under every state that has data behind it. `intoWeakness` is
// tri-state on purpose — null is "no price history to judge against",
// which is not the same fact as "no", and collapsing them would let a
// missing chart read as reassurance.
struct InsiderClustersPanel: View {
    struct Row: Decodable, Identifiable {
        let ticker: String
        let insiderCount: Int?
        let totalDollars: Double?
        let score: Double?
        let intoWeakness: Bool?
        let periodDays: Int?
        let latestBuyAt: String?
        let topInsider: String?
        var id: String { ticker }
    }

    struct Payload: Decodable {
        let asOf: String?
        let universe: [String]?
        let results: [Row]?
    }

    private struct Brief: Decodable {
        let brief: String?
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var brief = ""
    @State private var briefLoading = false

    var body: some View {
        // No emptyWhen here: the web's empty state keeps the header
        // (with the universe count) and the methodology footer around
        // the message, so "we scanned n names and none qualified" stays
        // a scan result rather than a blank pane. That needs the
        // payload in hand, so the branch lives in content.
        PanelState(state: state,
                   retry: { Task { await load() } }) { p in
            let results = p.results ?? []
            let universe = p.universe ?? []
            VStack(alignment: .leading, spacing: 0) {
                header(universe: universe, results: results)
                Divider().overlay(Term.border)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if results.isEmpty {
                            emptyBlock(n: universe.count)
                        } else {
                            briefBlock
                            table(results)
                        }
                        footer(n: universe.count)
                    }
                    .padding(12)
                }
            }
        }
        .task { await load() }
    }

    // MARK: Header

    private func header(universe: [String], results: [Row]) -> some View {
        HStack(spacing: 10) {
            Text("ICLUSTER")
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            SectionLabel(text: "Insider Clusters")
            Text("n=\(universe.count)"
                 + (results.isEmpty ? "" : " · \(results.count) hit\(results.count == 1 ? "" : "s")"))
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Empty

    // The web's empty sentence, verbatim: it names the threshold so a
    // quiet screen teaches the methodology instead of just shrugging.
    private func emptyBlock(n: Int) -> some View {
        Text("No qualifying clusters in the current universe (n=\(n) holdings, last 60d). Threshold is ≥3 distinct insider open-market purchases per name; single-insider accumulation and option exercises don't count.")
            .font(Term.mono(11))
            .foregroundStyle(Term.fgMuted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
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
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Table

    private let tickerW: CGFloat = 62
    private let countW: CGFloat = 66
    private let dollarW: CGFloat = 78
    private let scoreW: CGFloat = 64
    private let dateW: CGFloat = 66

    private func table(_ results: [Row]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("TICKER").frame(width: tickerW, alignment: .leading)
                Text("#INSIDERS").frame(width: countW, alignment: .trailing)
                Text("TOTAL $").frame(width: dollarW, alignment: .trailing)
                Text("SCORE").frame(width: scoreW, alignment: .trailing)
                Text("LATEST BUY").frame(width: dateW, alignment: .leading)
                Text("INTO WEAKNESS?")
                Spacer(minLength: 0)
            }
            .font(Term.mono(9, weight: .bold))
            .foregroundStyle(Term.fgMuted)
            .padding(.vertical, 4)
            Divider().overlay(Term.border)
            ForEach(results) { r in row(r) }
        }
    }

    private func row(_ r: Row) -> some View {
        Button {
            // Drill-down: the row hands the ticker to the shell as if
            // typed, opening its insider tape. (The web routes this
            // click to DES; the native spec pins INSDR — the Form 4
            // detail is the natural next question from a cluster row.)
            NotificationCenter.default.post(name: .runCommand,
                                            object: "\(r.ticker) INSDR")
        } label: {
            HStack(spacing: 8) {
                Text(r.ticker)
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(Term.amber)
                    .frame(width: tickerW, alignment: .leading)
                    .help(r.topInsider ?? "")
                Text(r.insiderCount.map(String.init) ?? "—")
                    .foregroundStyle(Term.white)
                    .frame(width: countW, alignment: .trailing)
                Text(Self.dollars(r.totalDollars))
                    .foregroundStyle(Term.white)
                    .frame(width: dollarW, alignment: .trailing)
                Text(Self.scoreText(r.score))
                    .foregroundStyle(Term.white)
                    .frame(width: scoreW, alignment: .trailing)
                Text(Self.shortDate(r.latestBuyAt))
                    .foregroundStyle(Term.fgDim)
                    .frame(width: dateW, alignment: .leading)
                // Tri-state, kept tri-state: yes is the signal and
                // paints positive, no is a plain fact, null is an
                // unknown (no price history) and must not read as no.
                Text(r.intoWeakness == true ? "yes" : r.intoWeakness == false ? "no" : "—")
                    .foregroundStyle(r.intoWeakness == true ? Term.positive
                                     : r.intoWeakness == false ? Term.white : Term.fgMuted)
                Spacer(minLength: 0)
            }
            .font(Term.mono(11))
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
        .help("Open \(r.ticker) INSDR")
    }

    // MARK: Footer

    // The methodology line, with the spec's honesty sentence kept
    // bold: the one part of this panel that must never soften.
    private func footer(n: Int) -> some View {
        (Text("Universe: your holdings (n=\(n)). Window: 60d. Threshold: ≥3 distinct insider open-market purchases (Form 4 code P; exercises excluded). Weights: Officer 1.0 · Director 0.6 · 10%-Owner 0.3. Source: SEC Form 4 via the existing Finnhub-primary / SEC-fallback fetcher. ")
         + Text("Screen, not a backtested signal — use as evidence within a fundamentals thesis, not a standalone trade trigger.")
            .bold())
            .font(Term.mono(10))
            .foregroundStyle(Term.fgMuted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Formatting

    // The web's fmt.dollars, mirrored digit for digit: 2dp on the B/M
    // buckets, none below — K-bucket decimals just clutter the column.
    // Fmt.compact is close but carries no $ and different precision,
    // and the two clients must render the same leg the same way.
    private static func dollars(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "—" }
        let sign = v < 0 ? "-" : ""
        let a = abs(v)
        if a >= 1e9 { return "\(sign)$\(String(format: "%.2f", a / 1e9))B" }
        if a >= 1e6 { return "\(sign)$\(String(format: "%.2f", a / 1e6))M" }
        if a >= 1e3 { return "\(sign)$\(String(format: "%.0f", a / 1e3))K" }
        return "\(sign)$\(String(format: "%.0f", a))"
    }

    // Score is dollar-scaled but not dollars (Σ role-weight × $), so
    // it takes the compact bucket without the currency mark — same
    // distinction the web draws.
    private static func scoreText(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "—" }
        if v >= 1e6 { return "\(String(format: "%.2f", v / 1e6))M" }
        if v >= 1e3 { return "\(String(format: "%.1f", v / 1e3))K" }
        return String(format: "%.0f", v)
    }

    // latestBuyAt is a bare "YYYY-MM-DD". Pure string slicing into
    // MM/DD/YY, no Date round trip — parsing a bare day lands on UTC
    // midnight and renders a day early anywhere west of Greenwich,
    // the same trap the web's fmt.date pins shut.
    private static func shortDate(_ s: String?) -> String {
        guard let s else { return "—" }
        let parts = s.prefix(10).split(separator: "-")
        guard parts.count == 3, parts[0].count == 4 else { return "—" }
        return "\(parts[1])/\(parts[2])/\(parts[0].suffix(2))"
    }

    // MARK: Loading

    private func load() async {
        state = .loading
        brief = ""
        briefLoading = false
        do {
            let data = try await API.shared.get("/terminal/insider-clusters")
            let p = try await API.shared.decode(Payload.self, from: data)
            state = .loaded(p)
            await loadBrief(p)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    // Confab-safe, same guard as the web: with zero qualifying
    // clusters there is nothing for the model to ground on, so
    // /annotate is never called — the empty-state sentence stands
    // alone. The context lines are the web's, verbatim, so both
    // clients feed the ICLUSTER prompt the same evidence.
    private func loadBrief(_ p: Payload) async {
        let results = p.results ?? []
        guard !results.isEmpty else { return }
        briefLoading = true
        defer { briefLoading = false }
        var lines: [String] = [
            "Universe: \(p.universe?.count ?? 0) tickers · window: 60d",
            "Ranked clusters (score = Σ role-weight × $; descending):",
        ]
        for r in results.prefix(20) {
            let weakness = r.intoWeakness == true ? "yes"
                : r.intoWeakness == false ? "no" : "unknown"
            lines.append(
                "\(r.ticker) — \(r.insiderCount.map(String.init) ?? "—") insiders, "
                + "\(Self.dollars(r.totalDollars)) total (score \(Self.scoreText(r.score))), "
                + "top: \(r.topInsider ?? "n/a"), latest \(Self.shortDate(r.latestBuyAt)), "
                + "into-weakness: \(weakness)")
        }
        do {
            let data = try await API.shared.post("/terminal/annotate", json: [
                "function": "ICLUSTER",
                "context": lines.joined(separator: "\n"),
            ])
            brief = (try await API.shared.decode(Brief.self, from: data)).brief ?? ""
        } catch {
            // A failed brief is a missing garnish, not a failed panel;
            // the web swallows it the same way.
            brief = ""
        }
    }
}
