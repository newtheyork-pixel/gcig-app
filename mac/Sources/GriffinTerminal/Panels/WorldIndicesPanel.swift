import SwiftUI

// WEI — world equity indices. No ticker; the basket is fixed
// server-side and grouped by region.
//
// Shape comes from getWorldIndices in worldIndices.js: Stooq first,
// then a Finnhub ETF stand-in for the indices Stooq keeps behind the
// paywall. Two contracts from that service matter here. `approx`
// means the row is an ETF proxy — its %-move tracks the index but
// its level is a different number entirely, so the web prefixes the
// symbol with ≈ and explains on hover; both carried over. And a
// total feed miss is not an error: the server stubs the row with
// nulls, so a bad source degrades to "—", never to a missing index.
//
// Unlike MOVR the fetch is not one-shot. The web rides a shared
// ~20s while-visible poller and the footer promises as much, so the
// native panel polls on the same cadence — .task dies with the
// view, which is the whole pause/resume story. A dropped refresh
// keeps the last good tape; only a true first-paint failure renders
// as one.
struct WorldIndicesPanel: View {
    struct Row: Decodable, Identifiable {
        let name: String?
        let region: String?
        let symbol: String?
        let last: Double?
        let change: Double?
        let changePercent: Double?
        let source: String?
        let approx: Bool?
        // The web keys rows by name; the fixed basket keeps it unique.
        var id: String { name ?? symbol ?? "" }
    }

    struct Payload: Decodable {
        let asOf: String?
        let regions: [String]?
        let rows: [Row]
    }

    private struct Brief: Decodable {
        let brief: String?
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var lastUpdated: Date? = nil

    // The AI brief is a one-shot read of the tape, not per-tick
    // commentary — same reasoning as the web: keying it off every
    // poll would hit the LLM endpoint each ~20s for the life of the
    // pane. Requested once, on the first non-empty tape.
    @State private var brief: String? = nil
    @State private var briefLoading = false
    @State private var briefRequested = false

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.rows.isEmpty },
                   emptyText: "No index data returned.",
                   retry: { Task { await load(first: true) } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                briefBlock
                Divider().overlay(Term.border)
                columnHead
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(presentRegions(p), id: \.self) { region in
                            regionLabel(region)
                            ForEach(p.rows.filter { $0.region == region }) { r in
                                row(r)
                            }
                        }
                    }
                }
                Divider().overlay(Term.border)
                footer
            }
        }
        .task {
            await load(first: true)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled else { break }
                await load(first: false)
            }
        }
    }

    // MARK: Sections

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "World Equity Indices")
            Spacer()
            if let t = timeString(iso: p.asOf) {
                Text(t).font(Term.mono(10)).foregroundStyle(Term.fgDim)
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

    private var columnHead: some View {
        HStack(spacing: 8) {
            Text("Index").frame(maxWidth: .infinity, alignment: .leading)
            Text("Last").frame(width: 84, alignment: .trailing)
            Text("Chg").frame(width: 64, alignment: .trailing)
            Text("Chg %").frame(width: 64, alignment: .trailing)
        }
        .font(Term.mono(9, weight: .bold))
        .foregroundStyle(Term.fgMuted)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }

    // A region header only appears when at least one row belongs to
    // it, in the server's REGION_ORDER — same filter as the web.
    private func presentRegions(_ p: Payload) -> [String] {
        (p.regions ?? []).filter { reg in p.rows.contains { $0.region == reg } }
    }

    private func regionLabel(_ region: String) -> some View {
        SectionLabel(text: region)
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 3)
    }

    private func row(_ r: Row) -> some View {
        HStack(spacing: 8) {
            HStack(spacing: 5) {
                Text(r.name ?? "—")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .lineLimit(1)
                Text((r.approx == true ? "≈ " : "") + (r.symbol ?? ""))
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                    .lineLimit(1)
                    .help(r.approx == true
                          ? "ETF proxy (\(r.symbol ?? "")) — %-move tracks the index, level differs"
                          : (r.symbol ?? ""))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // A proxy's LEVEL is not the index's level — SPY trades near
            // 747 while the S&P is near 7,500 — so the number itself has
            // to look different, not just the symbol beside it. Marking
            // only the symbol is what let "S&P 500  747.03" sit on
            // screen looking like a quote.
            Text((r.approx == true ? "≈" : "") + Fmt.money(r.last))
                .font(Term.mono(11))
                .foregroundStyle(r.approx == true ? Term.fgMuted : Term.white)
                .frame(width: 84, alignment: .trailing)
                .help(r.approx == true
                      ? "This is the ETF's price, not the index level. The percentage tracks; the number does not."
                      : "")
            // Both delta cells color off the sign of `change`, as the
            // web does — one row, one verdict, not two shades when
            // rounding disagrees. changePercent arrives already in
            // percentage points (the server does the ×100); scaling
            // it again like MOVR's fraction would be a 100x lie.
            Text(signedChange(r.change))
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.delta(r.change))
                .frame(width: 64, alignment: .trailing)
            Text(Fmt.pct(r.changePercent))
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.delta(r.change))
                .frame(width: 64, alignment: .trailing)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
    }

    // The web states the freshness contract in words because the
    // source is free and delayed — "refreshes while open" is not
    // "LIVE", and pretending otherwise is how a stale level gets
    // believed. The sentence ships verbatim.
    private var footer: some View {
        var s = "Indices refresh while this panel is open (~20s); "
              + "data is delayed by the free source (Yahoo index level; "
              + "an ETF proxy marked ≈ where the index itself is unreadable), "
              + "not true real-time."
        if let d = lastUpdated {
            s += " Updated \(clock(d))."
        }
        return Text(s)
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
    }

    // MARK: Formatting helpers

    // The web's fmt.chg: signed, two decimals. Fmt.pct is signed but
    // appends %, Fmt.money drops the + — compose the two rather than
    // grow a third number path in PanelKit.
    private func signedChange(_ v: Double?) -> String {
        guard let v else { return "—" }
        return (v >= 0 ? "+" : "") + Fmt.money(v)
    }

    // Wall-clock stamps. Fmt.date renders a date; the tape needs a
    // time — an index level goes stale in minutes, not days. Built
    // per call like Fmt's own formatters (DateFormatter is not
    // Sendable, so a static would trip strict concurrency).
    private func clock(_ d: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        return f.string(from: d)
    }

    private func timeString(iso: String?) -> String? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        else { return nil }
        return clock(d)
    }

    // MARK: Loading

    private func load(first: Bool) async {
        if first { state = .loading }
        do {
            let data = try await API.shared.get("/terminal/indices")
            let p = try await API.shared.decode(Payload.self, from: data)
            state = .loaded(p)
            lastUpdated = Date()
            // First non-empty tape kicks the one-shot brief, in its
            // own task so a slow LLM call never stalls the poll.
            if !briefRequested && !p.rows.isEmpty {
                briefRequested = true
                Task { await requestBrief(p) }
            }
        } catch {
            // A dropped refresh keeps the last good tape on screen —
            // the terminal's best-effort contract. Only a first-paint
            // failure, with nothing good ever loaded, is shown as one.
            if case .loaded = state { return }
            state = .failed(error.localizedDescription)
        }
    }

    private func requestBrief(_ p: Payload) async {
        briefLoading = true
        defer { briefLoading = false }
        let context = p.rows.map { r in
            "\(r.name ?? "") (\(r.symbol ?? "")): \(Fmt.money(r.last)) "
            + "\(signedChange(r.change)) \(Fmt.pct(r.changePercent))"
        }.joined(separator: "\n")
        do {
            let data = try await API.shared.post(
                "/terminal/annotate",
                json: ["function": "WEI", "context": context])
            brief = (try await API.shared.decode(Brief.self, from: data)).brief ?? ""
        } catch {
            // The brief is garnish; the tape is the payload. The web
            // swallows this error the same way.
            brief = ""
        }
    }
}
