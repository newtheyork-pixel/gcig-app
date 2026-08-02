import SwiftUI

// TRK — the club's own report card.
//
// Every screen before this one showed the club what the market did.
// This one shows the club what the CLUB did: each closed vote, the
// decision the room reached, and what the price has done since, scored
// against SPY because the honest alternative to owning a name was owning
// the index.
//
// It is meant to be uncomfortable. A report card that could only flatter
// would not be worth opening, and the first thing it says on the real
// book is that the worst decision on file is the one position nobody
// pitched.
struct DecisionRecordPanel: View {
    struct Row: Decodable, Identifiable {
        let id: Int?
        let ticker: String?
        let kind: String?
        let decision: String?
        let closedAt: String?
        let ballots: Int?
        let proposed: Double?

        let scored: Bool?
        let reason: String?
        /// "vote" when ballots back it, "pitch" for the five names the
        /// club turned down before the app recorded ballots.
        let source: String?
        let ret: Double?
        let bench: Double?
        let excess: Double?
        let days: Int?
        let mature: Bool?
        /// "reversed" when the club undid this decision and the window
        /// closed there; "open" when it still runs to the last print.
        let closedBy: String?
        let exitDate: String?
        let entryPrice: Double?
        let lastPrice: Double?

        var key: String { "\(id ?? 0)-\(ticker ?? "")" }
    }

    struct Summary: Decodable {
        let decisions: Int?; let scored: Int?; let mature: Int?
        let tooEarly: Int?; let unscored: Int?
        let wins: Int?; let losses: Int?
        let avgExcess: Double?; let hitRate: Double?
    }

    struct Payload: Decodable {
        let rows: [Row]?
        let summary: Summary?
        let benchmark: String?
        let benchError: String?
        let basis: String?
        let maturityDays: Int?
    }

    @State private var state: Loadable<Payload> = .loading
    /// On by default, which is the opposite of what the maturity rule
    /// suggests and is right anyway: exactly one of the club's eleven
    /// closed votes has cleared ninety days, so hiding the rest would
    /// open the panel on a single row. They are shown dimmed and sorted
    /// below the settled ones instead, and the header says in words
    /// that none of them is a verdict yet.
    @State private var showEarly = true

    var body: some View {
        PanelState(state: state, retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                columnHeads
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        let rows = visible(p)
                        if rows.isEmpty {
                            Text("No closed votes to score yet.")
                                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                                .padding(10)
                        }
                        ForEach(rows, id: \.key) { r in
                            row(r)
                            Divider().overlay(Term.border.opacity(0.35))
                        }
                    }
                }
            }
        }
        .task { await load() }
    }

    // MARK: The verdict line

    @ViewBuilder
    private func header(_ p: Payload) -> some View {
        let s = p.summary
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 14) {
                Text("DECISION RECORD")
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
                Text("vs \(p.benchmark ?? "SPY")")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                // Said on the screen, not just in the source. Our price
                // history carries no dividend-adjusted series, so these
                // are price returns — and the gap runs against the club,
                // since SPY yields less than SCHD, JNJ or GD.
                if (p.basis ?? "price") == "price" {
                    Text("PRICE ONLY")
                        .font(Term.mono(8, weight: .bold))
                        .foregroundStyle(Term.fgMuted)
                        .help("Returns exclude dividends on both sides. Dividend payers are understated against SPY.")
                }
                Spacer()
                Toggle(isOn: $showEarly) {
                    Text("include recent").font(Term.mono(9))
                }
                .toggleStyle(.checkbox)
                .foregroundStyle(Term.fgDim)
            }

            // The denominator travels with the number, always. A hit
            // rate quoted over one decision is not a hit rate, and on
            // the real record exactly one vote has cleared ninety days.
            if let s, (s.mature ?? 0) > 0 {
                HStack(spacing: 16) {
                    stat("HIT RATE", s.hitRate.map { Fmt.pct($0, decimals: 0, signed: false) } ?? "—",
                         tone: (s.hitRate ?? 0) >= 50 ? Term.positive : Term.negative)
                    stat("AVG EXCESS", s.avgExcess.map { Fmt.pct($0, decimals: 1) } ?? "—",
                         tone: (s.avgExcess ?? 0) >= 0 ? Term.positive : Term.negative)
                    stat("SETTLED", "\(s.wins ?? 0)W / \(s.losses ?? 0)L")
                    Spacer()
                }
                if (s.mature ?? 0) < 10 {
                    // Say it in words rather than trusting a reader to
                    // notice the denominator. One win out of one is not
                    // a hundred per cent, it is one win.
                    Text("Over \(s.mature ?? 0) decision\((s.mature ?? 0) == 1 ? "" : "s") past \(p.maturityDays ?? 90) days. Too few to be a record.")
                        .font(Term.mono(9)).foregroundStyle(Term.amber)
                }
            } else {
                Text("No decision has cleared \(p.maturityDays ?? 90) days yet. Numbers below are real; none of them is a verdict.")
                    .font(Term.mono(9)).foregroundStyle(Term.amber)
            }

            if let s {
                Text("\(s.decisions ?? 0) closed votes · \(s.tooEarly ?? 0) still recent"
                     + ((s.unscored ?? 0) > 0 ? " · \(s.unscored!) unscorable" : ""))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            if let e = p.benchError {
                Text("Benchmark unavailable — nothing can be scored: \(e)")
                    .font(Term.mono(9)).foregroundStyle(Term.negative)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
    }

    private func stat(_ label: String, _ value: String, tone: Color = Term.white) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(Term.mono(8, weight: .bold)).foregroundStyle(Term.blue)
            Text(value).font(Term.mono(13, weight: .bold)).foregroundStyle(tone)
        }
    }

    // MARK: The table

    private enum Field: CaseIterable {
        case ticker, decision, when, ballots, ret, bench, excess, age

        var title: String {
            switch self {
            case .ticker:   return "TICKER"
            case .decision: return "DECIDED"
            case .when:     return "DATE"
            case .ballots:  return "VOTES"
            case .ret:      return "SINCE"
            case .bench:    return "SPY"
            case .excess:   return "EXCESS"
            case .age:      return "AGE"
            }
        }
        var width: CGFloat? {
            switch self {
            case .ticker:   return 62
            case .decision: return 74
            case .when:     return 88
            case .ballots:  return 52
            case .ret:      return 74
            case .bench:    return 68
            case .excess:   return nil
            case .age:      return 62
            }
        }
        var align: Alignment {
            switch self {
            case .ticker, .decision: return .leading
            default: return .trailing
            }
        }
    }

    private static let gap: CGFloat = 8

    private func sized<V: View>(_ f: Field, @ViewBuilder _ c: () -> V) -> some View {
        Group {
            if let w = f.width { c().frame(width: w, alignment: f.align) }
            else { c().frame(minWidth: 90, maxWidth: .infinity, alignment: f.align) }
        }
    }

    private var columnHeads: some View {
        HStack(spacing: Self.gap) {
            ForEach(Field.allCases, id: \.self) { f in sized(f) { Text(f.title) } }
        }
        .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func row(_ r: Row) -> some View {
        HStack(spacing: Self.gap) {
            ForEach(Field.allCases, id: \.self) { f in sized(f) { cell(f, r) } }
        }
        .font(Term.mono(11)).foregroundStyle(Term.white)
        .padding(.horizontal, 10).padding(.vertical, 3)
        // A recent decision is dimmed rather than hidden or footnoted.
        // The number is real and the verdict is not, and opacity says
        // that faster than a column of asterisks.
        .opacity((r.mature ?? false) ? 1 : 0.55)
        .contentShape(Rectangle())
        .help(tooltip(r))
    }

    @ViewBuilder
    private func cell(_ f: Field, _ r: Row) -> some View {
        switch f {
        case .ticker:
            Text(r.ticker ?? "—").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
        case .decision:
            Text(r.decision?.uppercased() ?? "—")
                .font(Term.mono(10, weight: .bold))
                .foregroundStyle(tone(r.decision))
        case .when:
            Text(r.closedAt.map { Fmt.date($0) } ?? "—").foregroundStyle(Term.fgDim)
        case .ballots:
            // A dash, never a zero. Nobody cast zero ballots on these —
            // they were decided before the app recorded them.
            Text(r.ballots.map(String.init) ?? "—")
                .foregroundStyle(r.ballots == nil ? Term.fgMuted : Term.fgDim)
                .help(r.source == "pitch" ? "Decided before the app recorded ballots" : "")
        case .ret:
            signed(r.ret)
        case .bench:
            Text(r.bench.map { Fmt.pct($0, decimals: 1) } ?? "—").foregroundStyle(Term.fgDim)
        case .excess:
            if r.scored == true {
                Text(Fmt.pct(r.excess ?? 0, decimals: 1))
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle((r.excess ?? 0) >= 0 ? Term.positive : Term.negative)
            } else {
                // A reason, not a dash. "No price history" and "the vote
                // predates our archive" send somebody to look for
                // different things.
                Text(r.reason ?? "not scored")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(1)
            }
        case .age:
            HStack(spacing: 3) {
                Text(r.days.map { "\($0)d" } ?? "—")
                    .foregroundStyle((r.mature ?? false) ? Term.fgDim : Term.amber.opacity(0.8))
                // A closed window is short by fact, not by accident, and
                // a reader comparing a 30-day row against a 260-day one
                // has to be able to tell which.
                if r.closedBy == "reversed" {
                    Text("◼")
                        .font(Term.mono(7)).foregroundStyle(Term.cyan)
                        .help("Window closed: the club reversed this decision"
                              + (r.exitDate.map { " on \(Fmt.date($0))" } ?? ""))
                }
            }
        }
    }

    private func signed(_ v: Double?) -> some View {
        Text(v.map { Fmt.pct($0, decimals: 1) } ?? "—")
            .foregroundStyle(v == nil ? Term.fgMuted : ((v ?? 0) >= 0 ? Term.positive : Term.negative))
    }

    private func tone(_ d: String?) -> Color {
        switch d {
        case "Buy": return Term.positive
        case "Sell": return Term.negative
        case "NoBuy": return Term.fgDim
        default: return Term.fgMuted
        }
    }

    /// The row's own story, for the reader who stops on it.
    private func tooltip(_ r: Row) -> String {
        var bits: [String] = []
        if let d = r.decision, let n = r.ballots { bits.append("\(d) on \(n) ballots") }
        if let p = r.proposed, p > 0 { bits.append("proposed \(Fmt.money(p)) average") }
        if let e = r.entryPrice, let l = r.lastPrice {
            bits.append("\(Fmt.money(e)) at the vote, \(Fmt.money(l)) now")
        }
        if r.closedBy == "reversed" {
            bits.append("measured only while the club held it"
                        + (r.exitDate.map { ", to \(Fmt.date($0))" } ?? ""))
        }
        if r.mature == false, let d = r.days {
            bits.append("\(d) days old — the number is real, the verdict is not")
        }
        if let reason = r.reason { bits.append(reason) }
        return bits.joined(separator: " · ")
    }

    // MARK: Data

    /// Sorted worst-first among settled decisions.
    ///
    /// A report card opened at its best row is a trophy cabinet. The
    /// thing a club needs from its own record is the decision that went
    /// wrong and why, so that is what the panel opens on.
    private func visible(_ p: Payload) -> [Row] {
        (p.rows ?? [])
            .filter { showEarly || ($0.mature ?? false) }
            .sorted { a, b in
                let am = a.mature ?? false, bm = b.mature ?? false
                if am != bm { return am }          // settled first
                return (a.excess ?? 0) < (b.excess ?? 0)
            }
    }

    private func load() async {
        state = .loading
        do {
            let d = try await API.shared.get("/holdings/decisions/record")
            state = .loaded(try await API.shared.decode(Payload.self, from: d))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
