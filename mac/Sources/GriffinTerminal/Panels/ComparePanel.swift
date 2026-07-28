import SwiftUI

// CMP — 2–4 tickers side by side, ported from Compare.jsx.
//
// The panel owns its own ticker set: chips with a remove button, an
// input capped at four, deduped and upper-cased by the same rule the
// command parser uses. `initial` seeds the set once from the command
// line ("CMP AIT JNJ V") and never reaches in again — later changes
// are the user's.
//
// Two data flows, deliberately separate, same as the web. Fundamentals
// come from GET /terminal/compare?tickers=A,B — one getPeerSnapshot
// per name, the ~15m bundle PEER shows, one row per REQUESTED ticker
// (a miss is a column of dashes, never a dropped name). Price and
// Day % come only from GET /terminal/quotes on a ~20s loop while the
// pane is open; /compare carries no price at all, so those two cells
// show an em dash until the first live tick, and a failed poll keeps
// the last good quote rather than blanking a cell.
//
// Unit trap, the reverse of PeersPanel: /quotes' changePct is
// Finnhub's `dp`, ALREADY a percent (1.23 == +1.23%) — no ×100.
// dividendYield from the snapshot is a fraction and does get ×100.
//
// The AI brief mirrors the web's confab guard: it fires once per set,
// off the loaded snapshot (never the 20s tick), and only when at
// least two columns actually resolved — the model is never asked to
// compare a single name or thin air.
struct ComparePanel: View {
    let initial: String?

    struct Row: Decodable {
        let ticker: String
        let name: String?
        let marketCap: Double?
        let peRatio: Double?
        let forwardPE: Double?
        let dividendYield: Double?
        let beta: Double?
    }

    struct Payload: Decodable {
        let tickers: [String]?
        let rows: [Row]
    }

    struct Quote: Decodable {
        let last: Double?
        let changePct: Double?
    }

    private struct Brief: Decodable {
        let brief: String?
    }

    static let maxTickers = 4

    @State private var tickers: [String]
    @State private var input = ""

    // The fetch state answers "what happened to the LAST request";
    // lastGood keeps every row a previous load resolved, keyed by
    // ticker, so the table stays painted through a re-fetch and a
    // failed refresh degrades under an error line instead of wiping
    // the grid — the web's sticky-data behavior exactly.
    @State private var state: Loadable<Payload> = .loading
    @State private var lastGood: [String: Row] = [:]
    @State private var quotes: [String: Quote] = [:]

    @State private var brief: String? = nil
    @State private var briefLoading = false
    @State private var briefRanFor = ""

    init(initial: String? = nil) {
        self.initial = initial
        _tickers = State(initialValue: Self.seed(initial))
    }

    /// Stable comma key: the exact ?tickers= value for both endpoints
    /// and the identity both .task loops restart on.
    private var setKey: String { tickers.joined(separator: ",") }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Term.border)
            chipRow
            Divider().overlay(Term.border)
            Group {
                if tickers.isEmpty {
                    PanelMessage(text: "Add 2–4 tickers to compare them side by side.")
                } else {
                    middle
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            Divider().overlay(Term.border)
            footer
        }
        .task(id: setKey) { await loadSnapshot() }
        .task(id: setKey) { await pollQuotes() }
    }

    // MARK: Sections

    private var header: some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Compare")
            if !tickers.isEmpty {
                Text("\(tickers.count) of \(Self.maxTickers)")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // The set editor stays visible in every state — a failed set still
    // needs its chips editable to fix it, which is why the panel does
    // not wrap everything in PanelState's full-pane switch.
    private var chipRow: some View {
        HStack(spacing: 8) {
            ForEach(tickers, id: \.self) { t in chip(t) }
            if tickers.count < Self.maxTickers {
                TextField("", text: $input,
                          prompt: Text("Add ticker").foregroundStyle(Term.fgMuted))
                    .textFieldStyle(.plain)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .frame(width: 84)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Term.bg)
                    .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
                    .onSubmit { addTicker() }
                Button("Add") { addTicker() }
                    .buttonStyle(TermButtonStyle())
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func chip(_ t: String) -> some View {
        HStack(spacing: 6) {
            Text(t)
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.white)
            Button {
                removeTicker(t)
            } label: {
                Text("×").font(Term.mono(11)).foregroundStyle(Term.fgMuted)
            }
            .buttonStyle(.plain)
            .help("Remove \(t)")
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    // The web's render order: loading line only while there is nothing
    // to show, error above a still-rendered grid, AI block whenever
    // the set is non-empty. Failure keeps the last good columns under
    // a named error — degraded, never dressed as empty.
    @ViewBuilder private var middle: some View {
        switch state {
        case .loading:
            if lastGood.isEmpty {
                loadingLine
            } else {
                briefBlock
                Divider().overlay(Term.border)
                table
            }
        case .failed(let msg):
            errorBlock(msg)
            Divider().overlay(Term.border)
            briefBlock
            Divider().overlay(Term.border)
            table
        case .loaded:
            briefBlock
            Divider().overlay(Term.border)
            table
        }
    }

    private var loadingLine: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small).tint(Term.amber)
            Text("Loading fundamentals for \(tickers.joined(separator: ", "))…")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorBlock(_ msg: String) -> some View {
        HStack(spacing: 10) {
            Text("COULD NOT LOAD")
                .font(Term.mono(10, weight: .bold))
                .foregroundStyle(Term.negative)
            Text(msg)
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .lineLimit(2)
            Spacer()
            Button("Retry") { Task { await loadSnapshot() } }
                .buttonStyle(TermButtonStyle())
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
            Text(briefText)
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var briefText: String {
        if briefLoading { return "Generating…" }
        if resolvableCount >= 2 {
            return (brief?.isEmpty == false) ? (brief ?? "") : "No brief available."
        }
        // The web's under-two sentence, distinct from the empty-set
        // message on purpose — this one shows above a partial grid.
        return "Add 2–4 tickers to compare."
    }

    private var footer: some View {
        Text("Up to 4 tickers · Price & Day % refresh live (~20s) while this panel is open; Mkt Cap / P/E / Div / Beta are a ~15m fundamentals snapshot. Click any ticker header to open its DES.")
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
    }

    // MARK: Table

    /// One requested ticker, whatever we know about it. The snapshot
    /// row and the live quote are looked up independently so a miss on
    /// one never hides the other.
    private struct Column: Identifiable {
        let ticker: String
        let row: Row?
        let quote: Quote?
        var id: String { ticker }

        /// The server resolved this name at all — the web's guard for
        /// counting a column toward the AI brief.
        var resolvable: Bool {
            guard let row else { return false }
            return row.name != nil || row.marketCap != nil
                || row.peRatio != nil || row.forwardPE != nil
                || row.dividendYield != nil || row.beta != nil
        }
    }

    private var cols: [Column] {
        tickers.map { Column(ticker: $0, row: lastGood[$0], quote: quotes[$0]) }
    }

    private var resolvableCount: Int { cols.filter(\.resolvable).count }

    private enum ColW {
        static let metric: CGFloat = 64
    }

    private var table: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("METRIC")
                    .font(Term.mono(9, weight: .bold))
                    .foregroundStyle(Term.fgMuted)
                    .frame(width: ColW.metric, alignment: .leading)
                ForEach(cols) { c in
                    Button {
                        open(c.ticker)
                    } label: {
                        Text(c.ticker)
                            .font(Term.mono(10, weight: .bold))
                            .foregroundStyle(Term.amber)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Open \(c.ticker) DES")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            Divider().overlay(Term.border)
            // Live pair first, then the snapshot rows — the web's ROWS
            // order. changePct is already a percent; dividendYield is
            // a fraction. Missing is an em dash via Fmt, never 0.
            metricRow("Price") { c in
                (Fmt.money(c.quote?.last), Term.white)
            }
            metricRow("Day %") { c in
                (Fmt.pct(c.quote?.changePct), Term.delta(c.quote?.changePct))
            }
            metricRow("Mkt Cap") { c in
                (Fmt.compact(c.row?.marketCap), Term.white)
            }
            metricRow("P/E") { c in
                (Fmt.money(c.row?.peRatio, decimals: 1), Term.white)
            }
            metricRow("Fwd P/E") { c in
                (Fmt.money(c.row?.forwardPE, decimals: 1), Term.white)
            }
            metricRow("Div") { c in
                (Fmt.pct((c.row?.dividendYield).map { $0 * 100 }, signed: false),
                 Term.white)
            }
            metricRow("Beta") { c in
                (Fmt.money(c.row?.beta, decimals: 1), Term.white)
            }
        }
    }

    private func metricRow(_ label: String,
                           _ value: @escaping (Column) -> (String, Color)) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
                .frame(width: ColW.metric, alignment: .leading)
            ForEach(cols) { c in
                let (text, tone) = value(c)
                Text(text)
                    .font(Term.mono(11))
                    .foregroundStyle(tone)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
    }

    // MARK: Set editing

    /// Same normalization as the web seed: split, upper-case, keep
    /// only real ticker shapes, dedupe, cap at four. Junk tokens are
    /// dropped silently — the user typed a command, not a form.
    private static func seed(_ initial: String?) -> [String] {
        var out: [String] = []
        let toks = (initial ?? "")
            .uppercased()
            .split(whereSeparator: { $0 == " " || $0 == "," })
            .map(String.init)
        for t in toks where Parser.looksLikeTicker(t) && !out.contains(t) {
            out.append(t)
            if out.count == maxTickers { break }
        }
        return out
    }

    private func addTicker() {
        let t = input.trimmingCharacters(in: .whitespaces).uppercased()
        input = ""
        guard Parser.looksLikeTicker(t),
              !tickers.contains(t),
              tickers.count < Self.maxTickers else { return }
        tickers.append(t)
    }

    private func removeTicker(_ t: String) {
        tickers.removeAll { $0 == t }
    }

    private func open(_ t: String) {
        NotificationCenter.default.post(name: .runCommand, object: "\(t) DES")
    }

    // MARK: Loading

    private func loadSnapshot() async {
        guard !tickers.isEmpty else {
            // The web's empty-set reset: drop data and brief so a
            // rebuilt set starts clean.
            state = .loading
            lastGood = [:]
            brief = nil
            briefLoading = false
            return
        }
        let key = setKey
        state = .loading
        if briefRanFor != key { brief = nil }
        do {
            let data = try await API.shared.get("/terminal/compare",
                                                query: ["tickers": key])
            let p = try await API.shared.decode(Payload.self, from: data)
            // Merge, don't replace: a re-added ticker keeps its last
            // known fundamentals through the re-fetch, and lookups
            // are by current set so stale extras never render.
            for r in p.rows { lastGood[r.ticker.uppercased()] = r }
            state = .loaded(p)
            await loadBrief(key: key)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// ~20s live tap for Price and Day %, alive only while the pane
    /// is; .task(id:) cancels the loop when the set changes or the
    /// pane closes, and a fresh loop starts on the new key.
    private func pollQuotes() async {
        guard !tickers.isEmpty else { return }
        while !Task.isCancelled {
            await fetchQuotes()
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { break }
        }
    }

    private func fetchQuotes() async {
        let key = setKey
        guard !key.isEmpty else { return }
        do {
            let data = try await API.shared.get("/terminal/quotes",
                                                query: ["tickers": key])
            let q = try await API.shared.decode([String: Quote?].self, from: data)
            // A null per-ticker value is a Finnhub miss; keeping the
            // previous quote beats blanking a cell that was showing
            // something real a moment ago.
            for (t, v) in q { if let v { quotes[t] = v } }
        } catch {
            // A failed poll keeps the last good quotes on screen —
            // the web swallows it the same way.
        }
    }

    // Confab-safe brief, once per set: keyed off the loaded snapshot
    // rather than the 20s tick, and never fired with fewer than two
    // resolved columns. The context lines mirror the web's so both
    // clients feed the CMP prompt the same evidence.
    private func loadBrief(key: String) async {
        let set = cols.filter(\.resolvable)
        guard set.count >= 2 else {
            brief = nil
            return
        }
        guard briefRanFor != key else { return }
        briefRanFor = key
        briefLoading = true
        var lines = ["Head-to-head comparison of \(set.count) tickers:"]
        for c in set {
            guard let r = c.row else { continue }
            let nm = r.name.map { " (\($0))" } ?? ""
            lines.append(
                "\(c.ticker)\(nm): mktcap \(Fmt.compact(r.marketCap)), "
                + "P/E \(Fmt.money(r.peRatio, decimals: 1)), "
                + "fwd P/E \(Fmt.money(r.forwardPE, decimals: 1)), "
                + "div \(Fmt.pct((r.dividendYield).map { $0 * 100 }, signed: false)), "
                + "beta \(Fmt.money(r.beta, decimals: 1))")
        }
        do {
            let data = try await API.shared.post("/terminal/annotate", json: [
                "function": "CMP",
                "context": lines.joined(separator: "\n"),
            ])
            brief = (try await API.shared.decode(Brief.self, from: data)).brief ?? ""
        } catch {
            // A failed brief is a missing garnish, not a failed panel.
            brief = ""
        }
        briefLoading = false
    }
}
