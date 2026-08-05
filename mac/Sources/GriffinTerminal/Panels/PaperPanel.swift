import SwiftUI

// EXEC — what doing a trade properly is worth, in dollars.
//
// This started life as a paper blotter that simulated resting orders and
// scored them, and it answered a question nobody had. The question the
// club actually has is the one Thomas asked: we are buying $100,000 of
// something on Thursday, how much do we save by doing it properly?
//
// So it is a calculator with a ledger behind it, not a simulator. Type
// the size, get the number, and the record of what following the rules
// has been worth over the trades actually taken.
//
// The two rules and their evidence live in services/executionSaving.js.
// The short version: do not trade in the first thirty minutes, and post
// at the bid rather than crossing it. Both were measured across 17 names
// and 60 days rather than assumed, and both survive because they are
// structural. The open is violent because the overnight order book
// clears into it, every day, whatever anybody believes.
//
// THE NUMBERS ARE SMALL AND THE PANEL SAYS SO. About $5.40 on $10,000
// and $54 on $100,000. Everything larger that was tested lost money:
// multi-day limit ladders, eight chart entry signals, trend following.
// A panel that dressed 0.05% up as an edge would be teaching the wrong
// lesson to the people it is built for.
struct PaperPanel: View {
    struct Estimate: Decodable {
        let notional: Double?
        let total: Double?
        let timing: Double?
        let posting: Double?
        let timingVsRandom: Double?
        let pct: Double?
        let basis: String?
        let session: Session?

        struct Session: Decodable {
            let open: Bool?; let weekend: Bool?
            let minutes: Int?; let spreadMultiple: Double?
            let inCalm: Bool?; let phase: String?; let minutesUntilCalm: Int?
        }
    }

    struct Ledger: Decodable {
        let trades: Int?; let notional: Double?; let saved: Double?; let pending: Int?
    }

    struct Order: Decodable, Identifiable {
        let id: Int
        let ticker: String?; let side: String?; let shares: Double?
        let arrivalPrice: Double?; let fillPrice: Double?; let status: String?
        let placedAt: String?; let notional: Double?; let estimatedSaving: Double?
    }

    struct Payload: Decodable { let orders: [Order]?; let ledger: Ledger? }

    @State private var amount = "100000"
    @State private var est: Estimate?
    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        PanelState(state: state, retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                calculator
                Divider().overlay(Term.border)
                record(p)
            }
        }
        .task { await load(); await recompute() }
    }

    // MARK: The calculator

    private var calculator: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What does doing this trade properly save us?")
                .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)

            HStack(spacing: 8) {
                Text("ORDER SIZE  $").font(Term.mono(10)).foregroundStyle(Term.fgDim)
                TextField("100000", text: $amount)
                    .textFieldStyle(.roundedBorder).font(Term.mono(12))
                    .frame(width: 120)
                    .onSubmit { Task { await recompute() } }
                Button("CALCULATE") { Task { await recompute() } }
                    .font(Term.mono(10, weight: .bold))
                Spacer()
            }

            if let e = est, let total = e.total {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Fmt.money(total))
                            .font(Term.mono(26, weight: .bold)).foregroundStyle(Term.positive)
                        Text("saved on this trade")
                            .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                        Text(String(format: "%.3f%% of the order", e.pct ?? 0))
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    }

                    line("Not trading in the first 30 minutes", e.timing)
                    line("Posting at the bid instead of crossing", e.posting)

                    // The honest comparison, always beside the headline.
                    // The timing rule only beats a market order at the
                    // bell; against trading at a sensible hour anyway it
                    // is worth almost nothing, and quoting the big number
                    // alone would be a lie of omission.
                    if let vr = e.timingVsRandom {
                        Text("The timing half assumes the alternative was a market order at the "
                             + "opening bell. Against trading at some sensible hour anyway it is "
                             + "worth \(Fmt.money(vr)), not \(Fmt.money(e.timing ?? 0)). "
                             + "Posting is the durable half.")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Term.bgHeader)
                .overlay(alignment: .leading) { Rectangle().fill(Term.positive).frame(width: 2) }

                rightNow(e.session)

                if let b = e.basis {
                    Text("Estimate. \(b).")
                        .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    private func line(_ label: String, _ v: Double?) -> some View {
        HStack(spacing: 6) {
            Text("+" + Fmt.money(v ?? 0))
                .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.positive)
                .frame(width: 78, alignment: .trailing)
            Text(label).font(Term.mono(10)).foregroundStyle(Term.fgDim)
            Spacer()
        }
    }

    /// What to do about it in the next few minutes, which is the only
    /// part that is actionable today.
    @ViewBuilder
    private func rightNow(_ s: Estimate.Session?) -> some View {
        if let s {
            HStack(spacing: 7) {
                Text("RIGHT NOW").font(Term.mono(8, weight: .bold)).foregroundStyle(Term.blue)
                switch s.phase {
                case "opening":
                    Text("The expensive half hour. Spread is about \(String(format: "%.1fx", s.spreadMultiple ?? 0)) "
                         + "midday. Wait \(s.minutesUntilCalm ?? 0) minutes.")
                        .foregroundStyle(Term.negative)
                case "calm":
                    Text("Good window. Post at the bid and give it ten minutes.")
                        .foregroundStyle(Term.positive)
                case "closing":
                    Text("Closing imbalance. Either go now with a tight limit or wait for tomorrow.")
                        .foregroundStyle(Term.amber)
                case "weekend", "closed":
                    Text("Market shut. Best window is 11:30 to 15:00 ET.")
                        .foregroundStyle(Term.fgDim)
                case "premarket":
                    Text("Not open yet. Do not queue a market order for the bell.")
                        .foregroundStyle(Term.amber)
                default:
                    Text("Acceptable. The calm window is 11:30 to 15:00 ET.")
                        .foregroundStyle(Term.fgDim)
                }
                Spacer()
            }
            .font(Term.mono(10))
        }
    }

    // MARK: The record

    @ViewBuilder
    private func record(_ p: Payload) -> some View {
        let l = p.ledger
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 14) {
                Text("THE RECORD").font(Term.mono(9, weight: .bold)).foregroundStyle(Term.blue)
                Text("what this has actually saved, on trades taken")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                Spacer()
            }
            if (l?.trades ?? 0) == 0 {
                // Never a zero. Nothing logged is not the same as a rule
                // that has saved nothing, and the two must not render
                // alike on a screen whose whole job is a running total.
                Text("No trades logged yet. The total appears here once orders are recorded.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            } else {
                HStack(spacing: 20) {
                    stat("TRADES", "\(l?.trades ?? 0)")
                    stat("TRADED", Fmt.money(l?.notional ?? 0, decimals: 0))
                    stat("SAVED", Fmt.money(l?.saved ?? 0), tone: Term.positive)
                    Spacer()
                }
            }
            ForEach((p.orders ?? []).prefix(8)) { o in
                HStack(spacing: 8) {
                    Text(o.placedAt.map { Fmt.shortDateTime($0) } ?? "—")
                        .foregroundStyle(Term.fgDim).frame(width: 76, alignment: .leading)
                    Text((o.side ?? "").uppercased())
                        .foregroundStyle(o.side == "sell" ? Term.negative : Term.positive)
                        .frame(width: 36, alignment: .leading)
                    Text(o.ticker ?? "—")
                        .font(Term.mono(10, weight: .bold)).foregroundStyle(Term.amber)
                        .frame(width: 56, alignment: .leading)
                    Text(Fmt.money(o.notional ?? 0, decimals: 0))
                        .frame(width: 84, alignment: .trailing)
                    Text("+" + Fmt.money(o.estimatedSaving ?? 0))
                        .foregroundStyle(Term.positive).frame(width: 66, alignment: .trailing)
                    Text(o.status ?? "").foregroundStyle(Term.fgMuted)
                    Spacer()
                }
                .font(Term.mono(10))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    private func stat(_ l: String, _ v: String, tone: Color = Term.white) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(l).font(Term.mono(8, weight: .bold)).foregroundStyle(Term.blue)
            Text(v).font(Term.mono(14, weight: .bold)).foregroundStyle(tone)
        }
    }

    // MARK: Data

    private func recompute() async {
        let n = Double(amount.replacingOccurrences(of: ",", with: "")
                        .replacingOccurrences(of: "$", with: "")) ?? 0
        guard n > 0 else { est = nil; return }
        if let d = try? await API.shared.get("/paper/estimate", query: ["notional": String(n)]) {
            est = try? await API.shared.decode(Estimate.self, from: d)
        }
    }

    private func load() async {
        state = .loading
        do {
            let d = try await API.shared.get("/paper/orders")
            state = .loaded(try await API.shared.decode(Payload.self, from: d))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
