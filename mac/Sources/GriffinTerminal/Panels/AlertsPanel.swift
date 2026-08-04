import SwiftUI

// ALRT — what the club's own charter says somebody should be told.
//
// Not price alerts. The IPS has hard numbers in it and nothing checked
// them: a 10% cap on any single security, a 5% cash floor, and the rule
// that names an action rather than a limit — "if a position ever
// declines beyond 15%, the voting members must meet to review".
//
// The design decision worth stating: an alert here shows the number and
// the threshold and then quotes the charter. A member who has never read
// the IPS should learn what it says from the alert, and an exec who
// thinks it is wrong should end up arguing with the document rather than
// with the software.
struct AlertsPanel: View {
    struct Alert: Decodable, Identifiable {
        let id: String
        /// breach | action | watch | unchecked
        let kind: String?
        let ticker: String?
        let title: String?
        let detail: String?
        let value: Double?
        let threshold: Double?
        let source: String?
    }

    struct Summary: Decodable {
        let total: Int?; let breach: Int?; let action: Int?
        let watch: Int?; let unchecked: Int?; let clear: Bool?
    }

    struct Payload: Decodable { let alerts: [Alert]?; let summary: Summary? }

    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        PanelState(state: state, retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        let rows = p.alerts ?? []
                        if rows.isEmpty {
                            Text("Nothing to raise. Every rule ran and every one passed.")
                                .font(Term.mono(10)).foregroundStyle(Term.positive).padding(12)
                        }
                        ForEach(rows) { a in
                            row(a)
                            Divider().overlay(Term.border.opacity(0.3))
                        }
                    }
                }
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func header(_ p: Payload) -> some View {
        let s = p.summary
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                SectionLabel(text: "Policy alerts")
                Text("against the club's own IPS")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                Spacer()
                Button("RECHECK") { Task { await load() } }.font(Term.mono(9))
            }
            HStack(spacing: 14) {
                count("BREACH", s?.breach, Term.negative)
                count("ACTION", s?.action, Term.amber)
                count("WATCH", s?.watch, Term.cyan)
                // Shown only when it is non-zero, and in the colour of a
                // problem, because a rule that could not run is the one
                // thing on this screen that must never read as a pass.
                if (s?.unchecked ?? 0) > 0 {
                    count("NOT CHECKED", s?.unchecked, Term.negative)
                }
                Spacer()
            }
            if (s?.unchecked ?? 0) > 0 {
                Text("Some rules could not run. Silence below is not compliance.")
                    .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.negative)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
    }

    private func count(_ label: String, _ n: Int?, _ tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(Term.mono(8, weight: .bold)).foregroundStyle(Term.blue)
            Text("\(n ?? 0)")
                .font(Term.mono(14, weight: .bold))
                .foregroundStyle((n ?? 0) > 0 ? tone : Term.fgMuted)
        }
    }

    private func row(_ a: Alert) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 7) {
                Text(badge(a.kind))
                    .font(Term.mono(8, weight: .bold))
                    .foregroundStyle(Term.bg)
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(tone(a.kind))
                Text(a.title ?? "—")
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white)
                Spacer()
                if let t = a.ticker {
                    Button(t) {
                        NotificationCenter.default.post(name: .runCommand, object: "\(t) DES")
                    }
                    .buttonStyle(.plain)
                    .font(Term.mono(10, weight: .bold)).foregroundStyle(Term.amber)
                    .help("Open \(t)")
                }
            }
            if let d = a.detail {
                Text(d)
                    .font(Term.mono(9)).foregroundStyle(Term.fgDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let src = a.source {
                // Where the rule comes from, so nobody has to take the
                // alert on trust.
                Text(src).font(Term.mono(8)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            Rectangle().fill(tone(a.kind)).frame(width: 2)
        }
    }

    private func badge(_ k: String?) -> String {
        switch k {
        case "breach": return "BREACH"
        case "action": return "ACTION"
        case "watch": return "WATCH"
        default: return "NOT CHECKED"
        }
    }

    private func tone(_ k: String?) -> Color {
        switch k {
        case "breach": return Term.negative
        case "action": return Term.amber
        case "watch": return Term.cyan
        default: return Term.negative
        }
    }

    private func load() async {
        state = .loading
        do {
            let d = try await API.shared.get("/alerts")
            state = .loaded(try await API.shared.decode(Payload.self, from: d))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
