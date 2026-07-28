import SwiftUI

// MACRO — portfolio sensitivity to the five macro factors (10Y yield,
// WTI oil, USD index, VIX, SPY) over a 252-trading-day OLS.
//
// Shape comes from getMacroSensitivity in factorSensitivity.js. The
// endpoint is contractually never-5xx: any upstream failure (missing
// FRED_API_KEY, a sheet outage) degrades to an honest-empty 200 with
// factors:[], so the failed branch here only ever means transport or
// auth. That makes the empty render load-bearing — it is the panel's
// most common degraded state in the wild, and it must say why the
// matrix is empty rather than paint a blank frame.
//
// Two caveats from the web panel survive the port on purpose. The
// n≥60 filter is stated per factor (survivors + excluded counts) so a
// portfolio β over three names never reads as a thirteen-name book.
// And the methodology footer — kind distinction, unadjusted standard
// errors, "past sensitivity, not forecast" — is mandatory per the
// design doc, not decoration.
struct MacroPanel: View {
    struct Contributor: Decodable, Identifiable {
        let ticker: String
        let beta: Double?
        let weight: Double?
        let contribution: Double?
        var id: String { ticker }
    }

    struct TickerRow: Decodable {
        let ticker: String
        let beta: Double?
        let alpha: Double?
        let rSquared: Double?
        let n: Int?
        let stdErr: Double?
        let tStat: Double?
    }

    struct Scenario: Decodable {
        let shock: Double?
        let expectedMove: Double?
    }

    struct Factor: Decodable, Identifiable {
        let id: String
        let label: String?
        let unit: String?
        let defaultShock: Double?
        let portfolioBeta: Double?
        let scenario: Scenario?
        let perTicker: [TickerRow]?
        let surviving: [String]?
        let topContributors: [Contributor]?
    }

    struct Payload: Decodable {
        let asOf: String?
        let lookbackDays: Int?
        let factors: [Factor]?
        let holdings: [String]?
    }

    private struct Annotation: Decodable {
        let brief: String?
    }

    @State private var state: Loadable<Payload> = .loading

    // The brief is one-shot per panel life, same as WEI: the matrix is
    // a 6h-cached snapshot server-side, so re-briefing on a reload
    // would just re-summarize identical numbers through the LLM.
    @State private var brief: String? = nil
    @State private var briefLoading = false
    @State private var briefRequested = false

    var body: some View {
        // No emptyWhen here: the web keeps the full frame (header,
        // brief, footer) when factors is empty and puts the honest
        // empty line where the cards would go, so the reader still
        // sees the methodology and the "FRED unavailable" diagnosis
        // side by side. Collapsing to a bare message would lose both.
        PanelState(state: state,
                   retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                briefBlock
                Divider().overlay(Term.border)
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if (p.factors ?? []).isEmpty {
                            Text("No factor data — FRED may be unconfigured, or the portfolio could not be read.")
                                .font(Term.mono(11))
                                .foregroundStyle(Term.fgMuted)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.vertical, 20)
                        } else {
                            ForEach(p.factors ?? []) { f in
                                card(f, holdingsCount: (p.holdings ?? []).count)
                            }
                        }
                        footer
                    }
                    .padding(10)
                }
            }
        }
        .task { await load() }
    }

    // MARK: Sections

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Macro Sensitivity")
            Text("portfolio factor sensitivity · \(p.lookbackDays ?? 252)-day OLS · \((p.holdings ?? []).count) non-cash holdings")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .lineLimit(1)
            Spacer()
            if let d = p.asOf {
                Text(Fmt.date(d)).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var briefBlock: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("◢ AI BRIEF")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(Term.amber)
            Text(briefLoading
                 ? "Generating…"
                 : (brief?.isEmpty == false ? brief ?? "" : "No brief available."))
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // One factor card: label + colored scenario cue, the β/survivor
    // stats line, the top-3 contributor chips, and the excluded count
    // when the n≥60 filter dropped anyone. Same top-to-bottom order
    // as the web card.
    private func card(_ f: Factor, holdingsCount: Int) -> some View {
        let survCount = (f.surviving ?? []).count
        let excluded = holdingsCount - survCount
        let move = f.scenario?.expectedMove
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(f.label ?? f.id)
                    .font(Term.mono(12, weight: .medium))
                    .foregroundStyle(Term.fg)
                Spacer(minLength: 6)
                (Text("\(shockText(f)) → ").foregroundStyle(Term.fgDim)
                 + Text("book \(fmtPct(move))").foregroundStyle(moveColor(move)))
                    .font(Term.mono(10))
            }
            Text("portfolio β = \(fmtBeta(f.portfolioBeta)) · n survivors = \(survCount) · shock = \(shockText(f))")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
            if (f.topContributors ?? []).isEmpty {
                Text("No surviving contributors (every holding under n≥60).")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
                    .padding(.top, 2)
            } else {
                // At most three chips by server contract (slice(0,3)),
                // so a plain HStack stands in for the web's flex-wrap.
                HStack(spacing: 8) {
                    ForEach(f.topContributors ?? []) { c in
                        chip(c, factor: f)
                    }
                }
                .padding(.top, 2)
            }
            if excluded > 0 {
                Text("\(excluded) \(excluded == 1 ? "holding" : "holdings") excluded (insufficient overlap with factor data).")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .termPanelBackground()
        .termBorder()
    }

    // Contributor chip: ticker on the face, β / R² / n underneath in
    // muted text. R² and n live in perTicker, not the contributor
    // record — same join the web does. Click opens the ticker's DES.
    private func chip(_ c: Contributor, factor f: Factor) -> some View {
        let row = (f.perTicker ?? []).first { $0.ticker == c.ticker }
        return Button {
            NotificationCenter.default.post(name: .runCommand, object: "\(c.ticker) DES")
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.ticker)
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(Term.amber)
                Text("β \(fmtBeta(c.beta)) · R² \(fmtR2(row?.rSquared)) · n=\(fmtN(row?.n))")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(minWidth: 80, alignment: .leading)
            .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open \(c.ticker) DES")
    }

    // The methodology footer, verbatim from the web. The yield-vs-
    // price kind distinction is the most-confused choice in the spec
    // and the "past sensitivity, not forecast" line is mandatory.
    private var footer: some View {
        Text("Lookback: 252 trading days. Factors: 10Y / WTI / USD index / VIX (FRED) + S&P 500 (price-bar cache). Returns: daily Δ in pp for yields & VIX (levels, not prices); daily relative for oil / USD / SPY. Regression: simple OLS; standard errors unadjusted (no HAC/Newey-West). Portfolio β = Σ weight × β over tickers with n ≥ 60. Past sensitivity, not forecast. Rolling betas drift across regimes — refresh and re-read after major regime shifts.")
            .font(Term.mono(10))
            .foregroundStyle(Term.fgMuted)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Formatting

    // β with an explicit '+' on positive values; negative carries its
    // own sign. Matches the web's fmtBeta so the two clients never
    // disagree about what +0.42 looks like.
    private func fmtBeta(_ b: Double?) -> String {
        guard let b, b.isFinite else { return "—" }
        return "\(b > 0 ? "+" : "")\(String(format: "%.2f", b))"
    }

    // Fractional move → signed percent ("+1.23%").
    private func fmtPct(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "—" }
        return Fmt.pct(v * 100)
    }

    private func fmtR2(_ r: Double?) -> String {
        guard let r, r.isFinite else { return "—" }
        return String(format: "%.2f", r)
    }

    private func fmtN(_ n: Int?) -> String {
        guard let n else { return "—" }
        return String(n)
    }

    // The default-shock cue in the factor's native unit: yields move
    // in bps (Δ in pp × 100), VIX in points, prices in percent. The
    // expected book move is always a relative %.
    private func shockText(_ f: Factor) -> String {
        guard let s = f.defaultShock, s.isFinite else { return "—" }
        switch f.unit {
        case "bps": return "+\(Int((s * 100).rounded()))bps"
        case "pts": return "+\(String(format: "%.0f", s))pts"
        default:    return "+\(String(format: "%.0f", s * 100))%"
        }
    }

    // Flat is deliberately dim, not green — a book with no measured
    // sensitivity should not read as a favorable scenario.
    private func moveColor(_ v: Double?) -> Color {
        guard let v, v != 0 else { return Term.fgDim }
        return v > 0 ? Term.positive : Term.negative
    }

    // MARK: Data

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/macro-sensitivity")
            let p = try await API.shared.decode(Payload.self, from: data)
            state = .loaded(p)
            // Kick the brief in its own task so a slow LLM call never
            // holds up the matrix paint.
            if !briefRequested {
                briefRequested = true
                Task { await requestBrief(p) }
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    // The confab-safe gate carried over from the web: if no factor has
    // a non-empty surviving set (typically the FRED_API_KEY-unset case
    // where every factor returns n=0) there is nothing for the model
    // to ground on, so the annotate call is skipped entirely and the
    // honest empty-state line takes the brief's slot instead.
    private func requestBrief(_ p: Payload) async {
        let factors = p.factors ?? []
        let anyData = factors.contains { !($0.surviving ?? []).isEmpty }
        guard anyData else {
            brief = "FRED data unavailable (no FRED_API_KEY?) or no holding has 60 aligned observations — re-check after configuring or backfilling price bars."
            return
        }
        briefLoading = true
        defer { briefLoading = false }

        // Compact, factual context, mirroring the web build line for
        // line: portfolio β + signed scenario per factor, top 1–3
        // contributors, and the average R² across survivors as the
        // single "how predictive has this been" number.
        var lines = [
            "Portfolio macro sensitivity (252-day OLS, \((p.holdings ?? []).count) non-cash holdings).",
        ]
        for f in factors {
            let label = f.label ?? f.id
            guard let surv = f.surviving, !surv.isEmpty else {
                lines.append("\(label): insufficient overlap (no holding cleared n≥60).")
                continue
            }
            let contrib = (f.topContributors ?? []).prefix(3)
                .map { "\($0.ticker) β=\(fmtBeta($0.beta))" }
                .joined(separator: ", ")
            let survRows = (f.perTicker ?? []).filter { ($0.n ?? 0) >= 60 }
            let avgR2: Double? = survRows.isEmpty ? nil
                : survRows.reduce(0.0) { $0 + ($1.rSquared ?? 0) } / Double(survRows.count)
            lines.append(
                "\(label): portfolio β = \(fmtBeta(f.portfolioBeta)) · scenario "
                + "\(shockText(f)) → book \(fmtPct(f.scenario?.expectedMove)) · "
                + "top contributors \(contrib.isEmpty ? "—" : contrib) · "
                + "avg R² \(fmtR2(avgR2)) · n=\(survRows.count) survivors")
        }
        do {
            let data = try await API.shared.post("/terminal/annotate", json: [
                "function": "MACRO",
                "context": lines.joined(separator: "\n"),
            ])
            let a = try await API.shared.decode(Annotation.self, from: data)
            if !Task.isCancelled { brief = a.brief ?? "" }
        } catch {
            // The brief is garnish; the matrix is the payload. The web
            // swallows this error the same way.
            if !Task.isCancelled { brief = "" }
        }
    }
}
