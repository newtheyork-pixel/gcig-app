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
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Text("PAPER").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
                Text("SIMULATED — NOT THE BOOK")
                    .font(Term.mono(8, weight: .bold))
                    .foregroundStyle(Term.bg)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Term.amber)
                Spacer()
                if let s = session {
                    Text(s.reason ?? "")
                        .font(Term.mono(9))
                        .foregroundStyle((s.ok ?? false) ? Term.positive : Term.amber)
                }
            }
            if let sc = p.score, (sc.n ?? 0) > 0 {
                HStack(spacing: 16) {
                    stat("SETTLED", "\(sc.n ?? 0)")
                    stat("FILL RATE", sc.fillRate.map { Fmt.pct($0, decimals: 0, signed: false) } ?? "—",
                         tone: (sc.fillRate ?? 0) >= 69 ? Term.positive : Term.negative)
                    stat("AVG COST", sc.avgShortfall.map { Fmt.pct($0, decimals: 4) } ?? "—",
                         tone: (sc.avgShortfall ?? 0) <= 0 ? Term.positive : Term.negative)
                    stat("CROSSING", sc.vsCrossing.map { Fmt.pct($0, decimals: 4, signed: false) } ?? "—")
                    Spacer()
                }
                // The two numbers that decide whether the rule survives,
                // stated rather than left for a reader to infer.
                Text("Beats crossing if AVG COST is below CROSSING. The study's "
                     + "break-even fill rate was 69%.")
                    .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
            } else {
                Text("Nothing has settled yet. Numbers appear once an order fills or expires.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
    }

    private func stat(_ l: String, _ v: String, tone: Color = Term.white) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(l).font(Term.mono(8, weight: .bold)).foregroundStyle(Term.blue)
            Text(v).font(Term.mono(12, weight: .bold)).foregroundStyle(tone)
        }
    }

    private var ticketRow: some View {
        HStack(spacing: 8) {
            Picker("", selection: $side) {
                Text("BUY").tag("buy")
                Text("SELL").tag("sell")
            }
            .pickerStyle(.segmented).frame(width: 110).labelsHidden()

            TextField("TICKER", text: $ticker)
                .textFieldStyle(.plain).font(Term.mono(11))
                .frame(width: 80)
                .onSubmit { Task { await place() } }
            TextField("SHARES", text: $shares)
                .textFieldStyle(.plain).font(Term.mono(11))
                .frame(width: 70)
                .onSubmit { Task { await place() } }

            Button(busy ? "..." : "PLACE") { Task { await place() } }
                .disabled(busy || ticker.trimmingCharacters(in: .whitespaces).isEmpty)
                .font(Term.mono(10, weight: .bold))

            if let e = error {
                Text(e).font(Term.mono(9)).foregroundStyle(Term.negative).lineLimit(1)
            }
            Spacer()
            Button("CHECK NOW") { Task { await tick() } }
                .font(Term.mono(9))
                .help("Advance open orders immediately instead of waiting for the minute")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    private enum Field: CaseIterable {
        case placed, side, ticker, qty, arrival, limit, fill, cost, status
        var title: String {
            switch self {
            case .placed: return "PLACED"
            case .side: return "SIDE"
            case .ticker: return "TICKER"
            case .qty: return "QTY"
            case .arrival: return "ARRIVAL"
            case .limit: return "LIMIT"
            case .fill: return "FILL"
            case .cost: return "COST"
            case .status: return "STATUS"
            }
        }
        var width: CGFloat? {
            switch self {
            case .placed: return 92
            case .side: return 44
            case .ticker: return 62
            case .qty: return 50
            case .arrival: return 78
            case .limit: return 78
            case .fill: return 78
            case .cost: return 80
            case .status: return nil
            }
        }
        var align: Alignment {
            switch self {
            case .placed, .side, .ticker, .status: return .leading
            default: return .trailing
            }
        }
    }

    private func sized<V: View>(_ f: Field, @ViewBuilder _ c: () -> V) -> some View {
        Group {
            if let w = f.width { c().frame(width: w, alignment: f.align) }
            else { c().frame(minWidth: 80, maxWidth: .infinity, alignment: f.align) }
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
        .opacity(o.status == "open" ? 1 : 0.85)
        .help(o.rationale ?? "")
    }

    @ViewBuilder
    private func cell(_ f: Field, _ o: Order) -> some View {
        switch f {
        case .placed:
            Text(o.placedAt.map { Fmt.shortDateTime($0) } ?? "—").foregroundStyle(Term.fgDim)
        case .side:
            Text((o.side ?? "").uppercased())
                .font(Term.mono(10, weight: .bold))
                .foregroundStyle(o.side == "sell" ? Term.negative : Term.positive)
        case .ticker:
            Text(o.ticker ?? "—").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
        case .qty:
            Text(Fmt.compact(o.shares))
        case .arrival:
            Text(Fmt.money(o.arrivalPrice)).foregroundStyle(Term.fgDim)
        case .limit:
            Text(Fmt.money(o.limitPrice))
        case .fill:
            // A dash while it is still resting. An unfilled order has no
            // price, and printing the arrival there would read as a fill.
            Text(o.fillPrice.map { Fmt.money($0) } ?? "—")
                .foregroundStyle(o.fillPrice == nil ? Term.fgMuted : Term.white)
        case .cost:
            if let s = o.shortfall {
                Text(Fmt.pct(s, decimals: 4))
                    .foregroundStyle(s <= 0 ? Term.positive : Term.negative)
            } else {
                Text("—").foregroundStyle(Term.fgMuted)
            }
        case .status:
            HStack(spacing: 5) {
                Text((o.status ?? "").uppercased())
                    .font(Term.mono(9, weight: .bold))
                    .foregroundStyle(tone(o.status))
                if o.status == "open", let n = o.polls {
                    Text("\(n) checks").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                }
                if let b = o.bestSeen, o.status != "filled" {
                    Text("best \(Fmt.money(b))").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                }
                if let n = o.note {
                    Text(n).font(Term.mono(8)).foregroundStyle(Term.amber).lineLimit(1)
                }
            }
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
