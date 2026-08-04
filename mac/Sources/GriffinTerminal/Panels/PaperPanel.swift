import SwiftUI

// PAPER — trades nobody places.
//
// The execution study said stay out of the first thirty minutes and rest
// at the bid rather than crossing. Both were measured on history, which
// is where a rule always looks its best. This is the forward test.
//
// Everything on this screen is simulated and says so in three places,
// which is two more than feels necessary and exactly as many as it takes
// for nobody to ever mistake this blotter for the book. The club manages
// real endowment money; a member who confuses the two costs more than
// this panel could ever save.
struct PaperPanel: View {
    struct Order: Decodable, Identifiable {
        let id: Int
        let ticker: String?
        let side: String?
        let shares: Double?
        let arrivalPrice: Double?
        let limitPrice: Double?
        let status: String?
        let placedAt: String?
        let filledAt: String?
        let fillPrice: Double?
        let polls: Int?
        let bestSeen: Double?
        let note: String?
        let rationale: String?

        /// Signed so NEGATIVE IS GOOD on both sides: a buy filled below
        /// arrival and a sell filled above it are both wins. The raw
        /// percentage would file every good sell as a loss.
        var shortfall: Double? {
            guard let a = arrivalPrice, let f = fillPrice, a > 0 else { return nil }
            let raw = (f / a - 1) * 100
            return side == "sell" ? -raw : raw
        }
    }

    struct Score: Decodable {
        let n: Int?; let filled: Int?
        let fillRate: Double?; let avgShortfall: Double?; let vsCrossing: Double?
    }

    struct Payload: Decodable {
        let orders: [Order]?
        let score: Score?
        let restMinutes: Int?
        let caveat: String?
    }

    struct Session: Decodable {
        let ok: Bool?; let phase: String?; let reason: String?; let restMinutes: Int?
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var session: Session?
    @State private var ticker = ""
    @State private var shares = "10"
    @State private var side = "buy"
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        PanelState(state: state, retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ticketRow
                Divider().overlay(Term.border)
                columnHeads
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if (p.orders ?? []).isEmpty {
                            Text("No paper orders yet. Place one above.")
                                .font(Term.mono(10)).foregroundStyle(Term.fgMuted).padding(10)
                        }
                        ForEach(p.orders ?? []) { o in
                            row(o)
                            Divider().overlay(Term.border.opacity(0.35))
                        }
                    }
                }
                if let c = p.caveat {
                    Divider().overlay(Term.border)
                    Text(c)
                        .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func header(_ p: Payload) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // What this panel is, in one sentence. The pane titlebar
            // already says PAPER twice; repeating it a third time told
            // nobody anything, and the question a reader actually
            // arrives with is "what am I looking at".
            Text("Testing one idea: does resting a limit at the bid beat "
                 + "crossing the spread? Simulated — never touches the book.")
                .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                .fixedSize(horizontal: false, vertical: true)

            verdict(p)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    /// The answer, in English, or an honest statement that there is not
    /// one yet.
    ///
    /// The first version showed SETTLED / FILL RATE / AVG COST /
    /// CROSSING and left the reader to work out which way was good. Four
    /// numbers and a formula is the measurement apparatus; a member wants
    /// the result and whether to believe it.
    @ViewBuilder
    private func verdict(_ p: Payload) -> some View {
        let s = p.score
        let n = s?.n ?? 0
        let cost = s?.avgShortfall
        let cross = s?.vsCrossing ?? 0.0097
        let saved = cost.map { cross - $0 }

        VStack(alignment: .leading, spacing: 3) {
            if n == 0 {
                Text("Nothing settled yet.")
                    .font(Term.mono(12, weight: .bold)).foregroundStyle(Term.fgDim)
                Text("Place an order below. It rests for ten minutes, then fills "
                     + "or crosses, and the result appears here.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            } else if let saved, let cost {
                HStack(spacing: 6) {
                    Text(saved > 0 ? "Resting is winning" : "Resting is losing")
                        .font(Term.mono(13, weight: .bold))
                        .foregroundStyle(saved > 0 ? Term.positive : Term.negative)
                    Text("by \(String(format: "%.3f", abs(saved)))% per order")
                        .font(Term.mono(11)).foregroundStyle(Term.fgDim)
                }
                Text("Paid \(String(format: "%+.4f", cost))% against the price at the "
                     + "moment you decided. Crossing would have cost "
                     + "\(String(format: "%.4f", cross))%. "
                     + "\(s?.filled ?? 0) of \(n) filled without crossing.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)

                // The sample-size caveat, sized to the sample. It is the
                // difference between a result and a rumour, and at n=1
                // it is the only honest thing on the screen.
                if n < 30 {
                    Text("\(n) order\(n == 1 ? "" : "s") is too few to conclude anything. "
                         + "Around 30 before this means much.")
                        .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.amber)
                }
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Term.bgHeader)
        .overlay(alignment: .leading) { Rectangle().fill(Term.amber).frame(width: 2) }
    }

    private var ticketRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("PLACE A TEST ORDER")
                .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.blue)
            HStack(spacing: 10) {
                Picker("", selection: $side) {
                    Text("BUY").tag("buy")
                    Text("SELL").tag("sell")
                }
                .pickerStyle(.segmented).frame(width: 120).labelsHidden()

                field("ticker", $ticker, width: 90, placeholder: "AAPL")
                field("shares", $shares, width: 70, placeholder: "10")

                Button(busy ? "PLACING…" : "PLACE") { Task { await place() } }
                    .disabled(busy || ticker.trimmingCharacters(in: .whitespaces).isEmpty)
                    .font(Term.mono(10, weight: .bold))

                // Why the button will not do what you expect, beside the
                // button. It used to live in the far top-right corner,
                // which is nowhere near where anybody looks after
                // pressing something and having nothing happen.
                if let s = session, !(s.ok ?? true) {
                    Text(s.reason ?? "")
                        .font(Term.mono(9)).foregroundStyle(Term.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let e = error {
                    Text(e).font(Term.mono(9)).foregroundStyle(Term.negative).lineLimit(2)
                }
                Spacer()
                Button("CHECK NOW") { Task { await tick() } }
                    .font(Term.mono(9))
                    .help("Advance resting orders now instead of waiting for the next minute")
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
    }

    /// A labelled input. The first version showed a bare field whose
    /// placeholder read TICKER, which looks exactly like a column
    /// heading and not at all like somewhere to type.
    private func field(_ label: String, _ text: Binding<String>,
                       width: CGFloat, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased())
                .font(Term.mono(7, weight: .bold)).foregroundStyle(Term.fgMuted)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(Term.mono(11))
                .frame(width: width)
                .onSubmit { Task { await place() } }
        }
    }

    // Five columns, not nine.
    //
    // The first version showed PLACED / SIDE / TICKER / QTY / ARRIVAL /
    // LIMIT / FILL / COST / STATUS, which is every field the row has and
    // no help at all: a reader had to hold four prices in their head to
    // work out whether the thing worked. RESULT states it.
    private enum Field: CaseIterable {
        case when, order, rested, got, result
        var title: String {
            switch self {
            case .when: return "TIME"
            case .order: return "ORDER"
            case .rested: return "RESTED AT"
            case .got: return "GOT"
            case .result: return "RESULT"
            }
        }
        var width: CGFloat? {
            switch self {
            case .when: return 76
            case .order: return 150
            case .rested: return 88
            case .got: return 88
            case .result: return nil
            }
        }
        var align: Alignment {
            switch self {
            case .when, .order, .result: return .leading
            default: return .trailing
            }
        }
    }

    private func sized<V: View>(_ f: Field, @ViewBuilder _ c: () -> V) -> some View {
        Group {
            if let w = f.width { c().frame(width: w, alignment: f.align) }
            else { c().frame(minWidth: 200, maxWidth: .infinity, alignment: f.align) }
        }
    }

    private var columnHeads: some View {
        HStack(spacing: 8) {
            ForEach(Field.allCases, id: \.self) { f in sized(f) { Text(f.title) } }
        }
        .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func row(_ o: Order) -> some View {
        HStack(spacing: 8) {
            ForEach(Field.allCases, id: \.self) { f in sized(f) { cell(f, o) } }
        }
        .font(Term.mono(11)).foregroundStyle(Term.white)
        .padding(.horizontal, 10).padding(.vertical, 3)
        .help(o.rationale ?? "")
    }

    @ViewBuilder
    private func cell(_ f: Field, _ o: Order) -> some View {
        switch f {
        case .when:
            Text(o.placedAt.map { Fmt.shortDateTime($0) } ?? "—").foregroundStyle(Term.fgDim)
        case .order:
            HStack(spacing: 5) {
                Text((o.side ?? "").uppercased())
                    .font(Term.mono(10, weight: .bold))
                    .foregroundStyle(o.side == "sell" ? Term.negative : Term.positive)
                Text(Fmt.compact(o.shares))
                Text(o.ticker ?? "—")
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
            }
        case .rested:
            Text(Fmt.money(o.limitPrice))
        case .got:
            Text(o.fillPrice.map { Fmt.money($0) } ?? "—")
                .foregroundStyle(o.fillPrice == nil ? Term.fgMuted : Term.white)
        case .result:
            // One sentence per row. Whether the thing worked is the only
            // question the table is asked, and it used to be spread
            // across four numeric columns.
            Text(resultText(o))
                .font(Term.mono(10))
                .foregroundStyle(resultTone(o))
                .lineLimit(1)
        }
    }

    private func resultText(_ o: Order) -> String {
        guard let s = o.status else { return "—" }
        switch s {
        case "open":
            let n = o.polls ?? 0
            return "resting… checked \(n) time\(n == 1 ? "" : "s")"
                + (o.bestSeen.map { ", closest \(Fmt.money($0))" } ?? "")
        case "filled":
            guard let sf = o.shortfall, let a = o.arrivalPrice, let sh = o.shares else {
                return "filled"
            }
            let dollars = abs(sf / 100 * a * sh)
            return sf <= 0
                ? String(format: "filled — beat the mid, saved $%.2f", dollars)
                : String(format: "filled — worse than the mid by $%.2f", dollars)
        case "crossed":
            return "never came to us — crossed and paid up"
        case "abandoned":
            return "abandoned, no price seen"
        default:
            return s
        }
    }

    private func resultTone(_ o: Order) -> Color {
        switch o.status {
        case "filled": return (o.shortfall ?? 0) <= 0 ? Term.positive : Term.negative
        case "crossed": return Term.amber
        case "abandoned": return Term.negative
        default: return Term.cyan
        }
    }

    private func tone(_ s: String?) -> Color {
        switch s {
        case "filled": return Term.positive
        case "crossed": return Term.amber
        case "abandoned": return Term.negative
        default: return Term.cyan
        }
    }

    // MARK: Data

    private func place() async {
        error = nil
        let t = ticker.trimmingCharacters(in: .whitespaces).uppercased()
        guard !t.isEmpty, let q = Double(shares), q > 0 else {
            error = "ticker and share count"
            return
        }
        busy = true
        defer { busy = false }
        do {
            _ = try await API.shared.post("/paper/orders",
                                          json: ["ticker": t, "side": side, "shares": q])
            ticker = ""
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func tick() async {
        _ = try? await API.shared.post("/paper/tick", json: [:])
        await load()
    }

    private func load() async {
        if let d = try? await API.shared.get("/paper/session") {
            session = try? await API.shared.decode(Session.self, from: d)
        }
        do {
            let d = try await API.shared.get("/paper/orders")
            state = .loaded(try await API.shared.decode(Payload.self, from: d))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
