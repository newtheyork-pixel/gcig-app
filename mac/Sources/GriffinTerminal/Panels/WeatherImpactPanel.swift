import SwiftUI

// WX — named-storm impact on two curated baskets (Gulf O&G, P&C
// insurers), plus the best-effort NHC active-storm feed.
//
// Shape comes from getWeatherImpact in weatherSignals.js via
// /terminal/weather-impact. The output is a historical playbook, not
// a forecast — HURDAT2 US-landfall named storms 2020-present, forward
// returns SPY-relative — and the footer says so in the web's words.
//
// Two server facts drive the states here. The route contractually
// never 5xxes: an unexpected rejection degrades to a 200 with
// activeStorms:[] and exposures:[]. Empty storms is the normal state
// outside hurricane season and gets the web's own quiet sentence;
// empty EXPOSURES can only be that degraded catch, because the
// baskets are in-repo config that a healthy server always returns.
// So exposures.isEmpty is treated as the failure it is, never as a
// calm day.
//
// The web panel also fetches an AI brief from /terminal/annotate; the
// native ports skip that on purpose (DES and EARN do the same).
struct WeatherImpactPanel: View {
    struct Storm: Decodable {
        let name: String?
        let classification: String?
        let intensity: Double?
        let lastUpdate: String?
        /// Where it is, in words. A latitude is not a place.
        let place: Place?
        struct Place: Decodable {
            let der: String?
            let miles: Double?
            let nearest: String?
            let threatening: Bool?
            enum CodingKeys: String, CodingKey { case der = "where", miles, nearest, threatening }
        }
    }

    struct Win: Decodable {
        let mean: Double?
        let median: Double?
        let std: Double?
        let n: Int?
        let tStat: Double?
    }

    struct Study: Decodable {
        // Keyed "1d" / "5d" / "20d". perEvent exists server-side but
        // the web never renders it, so it is not decoded.
        let perWindow: [String: Win]?
    }

    struct ExposureDef: Decodable {
        let id: String
        let label: String?
        let tickers: [String]?
        let rationale: String?
    }

    struct ExposureRow: Decodable, Identifiable {
        let exposure: ExposureDef
        let holdingsOverlap: [String]?
        let study: Study?
        var id: String { exposure.id }
    }

    struct Payload: Decodable {
        let asOf: String?
        let activeStorms: [Storm]?
        let exposures: [ExposureRow]?
    }

    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { ($0.exposures ?? []).isEmpty },
                   emptyText: "The server sent its degraded envelope — no exposure baskets came back, which is an upstream failure, not a quiet day. Reopen WX to retry.",
                   retry: { Task { await load() } }) { p in
            let storms = p.activeStorms ?? []
            let exposures = p.exposures ?? []
            // The fixture is identical across baskets in v1 (one event
            // type), so any basket's 5d n is the archive count after
            // price-cache coverage — the web takes the max and so do we.
            let archiveN = exposures
                .map { $0.study?.perWindow?["5d"]?.n ?? 0 }
                .max() ?? 0
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        verdict(storms, exposures)
                        stormsCard(storms)
                        ForEach(exposures) { e in exposureCard(e) }
                        footer(archiveN)
                    }
                    .padding(12)
                }
            }
        }
        .task { await load() }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Weather Impact")
            Text("historical playbook")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            Spacer()
            if let d = p.asOf {
                Text(Fmt.date(d)).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Active storms

    private func stormsCard(_ storms: [Storm]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ACTIVE STORMS · NHC FEED")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(Term.fgDim)
            if storms.isEmpty {
                // The common state eight months of the year, and a real
                // answer — the web's sentence, not a blank.
                Text("No active US-affecting tropical activity in the NHC feed right now.")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgMuted)
            } else {
                // Keyed by position: nothing NHC sends is guaranteed
                // unique, and two depressions can share a nil name.
                ForEach(Array(storms.enumerated()), id: \.offset) { _, s in
                    stormRow(s)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    /// The answer first: does any of this touch what we own.
    ///
    /// The panel led with a storm list and a table of historical returns,
    /// which is a lot of screen for a question nobody had asked. What a
    /// reader wants to know on opening it is whether to care, and most
    /// days the honest answer is no — which is worth saying plainly
    /// rather than leaving them to work out from coordinates.
    @ViewBuilder
    private func verdict(_ storms: [Storm], _ exposures: [ExposureRow]) -> some View {
        let near = storms.filter { $0.place?.threatening == true }
        let held = exposures.flatMap { $0.holdingsOverlap ?? [] }
        VStack(alignment: .leading, spacing: 3) {
            if storms.isEmpty {
                Text("No active storms.")
                    .font(Term.mono(12)).foregroundStyle(Term.fgDim)
            } else if near.isEmpty {
                Text("\(storms.count) active storm\(storms.count == 1 ? "" : "s"), none near a coast.")
                    .font(Term.mono(12)).foregroundStyle(Term.fgDim)
                Text("Nothing to act on. The study below is history, not a forecast.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            } else if held.isEmpty {
                Text("\(near.count) storm\(near.count == 1 ? "" : "s") near a coast, nothing we hold is in an exposed basket.")
                    .font(Term.mono(12)).foregroundStyle(Term.amber)
            } else {
                Text("\(near.count) storm\(near.count == 1 ? "" : "s") near a coast, and we hold \(held.joined(separator: ", ")).")
                    .font(Term.mono(12, weight: .bold)).foregroundStyle(Term.amber)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Term.bgHeader)
    }

    private func stormRow(_ s: Storm) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(s.name ?? "—")
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.white)
            Text(s.classification ?? "—")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
            Text(knots(s.intensity))
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
            // The part that makes this a fact rather than a headline.
            // Amber when it is near a coast, dim when it is a thousand
            // miles out and concerns nobody.
            if let place = s.place?.der {
                Text(place)
                    .font(Term.mono(11))
                    .foregroundStyle(s.place?.threatening == true ? Term.amber : Term.fgMuted)
            }
            Spacer(minLength: 6)
            Text("updated \(updated(s.lastUpdate))")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
        }
    }

    // MARK: Exposure cards

    private func exposureCard(_ e: ExposureRow) -> some View {
        let w1 = e.study?.perWindow?["1d"]
        let w5 = e.study?.perWindow?["5d"]
        let w20 = e.study?.perWindow?["20d"]
        let overlap = e.holdingsOverlap ?? []
        let tickers = e.exposure.tickers ?? []
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(e.exposure.label ?? e.exposure.id)
                    .font(Term.mono(13))
                    .foregroundStyle(Term.white)
                Spacer(minLength: 6)
                Text("n=\(w5?.n ?? 0) events")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
            }

            statsRow(w1: w1, w5: w5, w20: w20)

            if let r = e.exposure.rationale {
                Text(r)
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Wrap(hSpacing: 8, vSpacing: 6) {
                Text("Basket (\(tickers.count)):")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                ForEach(tickers, id: \.self) { t in
                    chip(t, held: overlap.contains(t.uppercased()))
                }
            }

            holdingsLine(overlap)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    // 1d / 5d / 20d means, with the 5d dispersion detail in the muted
    // parenthetical. mean/median run in tens of bps, so two decimals on
    // the percent is the readable resolution — same as the web.
    private func statsRow(w1: Win?, w5: Win?, w20: Win?) -> some View {
        Wrap(hSpacing: 18, vSpacing: 6) {
            (Text("1d ").foregroundStyle(Term.fgDim)
                + Text(pct(w1?.mean)).foregroundStyle(meanTone(w1?.mean)))
                .font(Term.mono(11))
            (Text("5d ").foregroundStyle(Term.fgDim)
                + Text(pct(w5?.mean)).foregroundStyle(meanTone(w5?.mean))
                + Text(" (med \(pct(w5?.median)), std \(pct(w5?.std)), t=\(tstat(w5?.tStat)))")
                    .foregroundStyle(Term.fgMuted))
                .font(Term.mono(11))
            (Text("20d ").foregroundStyle(Term.fgDim)
                + Text(pct(w20?.mean)).foregroundStyle(meanTone(w20?.mean)))
                .font(Term.mono(11))
        }
    }

    // A basket ticker, outlined in green when the fund holds it. Click
    // opens that name's DES, the same drill-down the web chip runs.
    private func chip(_ t: String, held: Bool) -> some View {
        Button {
            NotificationCenter.default.post(name: .runCommand, object: "\(t) DES")
        } label: {
            Text(t)
                .font(Term.mono(10))
                .tracking(0.5)
                .foregroundStyle(held ? Term.positive : Term.fgDim)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .overlay(Rectangle().strokeBorder(held ? Term.positive : Term.border,
                                                  lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open \(t) DES")
    }

    private func holdingsLine(_ overlap: [String]) -> some View {
        (Text("Your holdings in this basket: ").foregroundStyle(Term.fgDim)
            + (overlap.isEmpty
                ? Text("(none of your current holdings)").foregroundStyle(Term.fgMuted)
                : Text(overlap.joined(separator: ", ")).foregroundStyle(Term.positive)))
            .font(Term.mono(10))
    }

    // The methodology paragraph, verbatim from the web. The rationale
    // for showing it at all: the baskets are editorial, and the reader
    // should see what we are betting on and be free to disagree.
    private func footer(_ archiveN: Int) -> some View {
        Text("Archive: NHC HURDAT2 US-landfall named storms (2020-present, n=\(archiveN)). Baskets curated in-repo (Gulf O&G: XOM/OXY/MRO/ET/EPD/KMI/CTRA; P&C: HIG/TRV/ALL/PGR/CB) with rationale. Forward returns are SPY-relative (sector-neutral). Window bounded by 5y price-bar cache. Historical playbook, not a forecast. Use as evidence within a thesis, not a standalone trade trigger.")
            .font(Term.mono(10))
            .foregroundStyle(Term.fgMuted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Formatting

    // Fractions to signed percents, missing to an em dash. The web
    // paints v >= 0 green (a zero-mean study should not read as red),
    // so this is deliberately not Term.delta, which mutes exact zero.
    private func pct(_ v: Double?) -> String {
        Fmt.pct(v.map { $0 * 100 })
    }

    private func meanTone(_ v: Double?) -> Color {
        guard let v else { return Term.fgMuted }
        return v >= 0 ? Term.positive : Term.negative
    }

    private func tstat(_ v: Double?) -> String {
        guard let v else { return "—" }
        return String(format: "%.2f", v)
    }

    private func knots(_ v: Double?) -> String {
        guard let v else { return "—" }
        return "\(String(format: "%.0f", v)) kt"
    }

    // NHC's lastUpdate is a full ISO timestamp; a compact MM/DD HH:mm
    // in local time reads well in a tight row — the web's fmtUpdated.
    private func updated(_ iso: String?) -> String {
        guard let iso else { return "—" }
        let p = ISO8601DateFormatter()
        p.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = p.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
            return "—"
        }
        let f = DateFormatter()
        f.dateFormat = "MM/dd HH:mm"
        return f.string(from: d)
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/weather-impact")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

// The web lays the chip and stat rows out with flex-wrap; HStack would
// clip the Gulf basket the moment the pane narrows. Minimal top-left
// flow: measure each child at its ideal size, break the line when the
// next one will not fit.
private struct Wrap: Layout {
    var hSpacing: CGFloat = 8
    var vSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews,
                      cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > maxW {
                x = 0
                y += rowH + vSpacing
                rowH = 0
            }
            x += s.width + hSpacing
            rowH = max(rowH, s.height)
            widest = max(widest, x - hSpacing)
        }
        return CGSize(width: maxW.isFinite ? maxW : widest, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize,
                       subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX {
                x = bounds.minX
                y += rowH + vSpacing
                rowH = 0
            }
            v.place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                    proposal: .unspecified)
            x += s.width + hSpacing
            rowH = max(rowH, s.height)
        }
    }
}
