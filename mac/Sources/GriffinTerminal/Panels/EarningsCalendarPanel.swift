import SwiftUI

// EVTS — when the companies we own report.
//
// The one date on which a thesis is either confirmed or contradicted in
// public, and until now it lived in nobody's calendar. A member who
// reads the book on Sunday had no way to know that two of the twelve
// positions report on Tuesday.
//
// Scoped to HOLDINGS rather than the 162-name watchlist, and that is a
// rate limit rather than a design view: Finnhub's free tier allows about
// sixty calls a minute and the batch fetch fires one per ticker with no
// concurrency cap, so a watchlist sweep would spend the whole budget and
// return half a calendar. Widening it needs chunking first.
struct EarningsCalendarPanel: View {
    struct Row: Decodable, Identifiable {
        let ticker: String?
        let name: String?
        let sector: String?
        let date: String?
        /// bmo | amc | dmh — before open, after close, during market
        /// hours. It decides whether a report lands while the market can
        /// react or overnight, which is the difference between watching
        /// it and reading about it.
        let hour: String?
        let epsEstimate: Double?
        let revenueEstimate: Double?
        let quarter: Int?
        let year: Int?
        var id: String { "\(ticker ?? "")-\(date ?? "")" }
    }

    struct Payload: Decodable { let upcoming: [Row]? }

    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        PanelState(state: state, retry: { Task { await load() } }) { p in
            let rows = p.upcoming ?? []
            VStack(alignment: .leading, spacing: 0) {
                header(rows)
                Divider().overlay(Term.border)
                columnHeads
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if rows.isEmpty {
                            // Distinguishable from a failure: the fetch
                            // worked and the next sixty days are simply
                            // quiet, which in a twelve-name book is
                            // normal for weeks at a stretch.
                            Text("No reports scheduled in the next 60 days for anything we hold.")
                                .font(Term.mono(10)).foregroundStyle(Term.fgMuted).padding(10)
                        }
                        ForEach(grouped(rows), id: \.0) { week, items in
                            weekHeader(week)
                            ForEach(items) { r in
                                row(r)
                                Divider().overlay(Term.border.opacity(0.3))
                            }
                        }
                    }
                }
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func header(_ rows: [Row]) -> some View {
        let soon = rows.filter { daysAway($0.date) ?? 999 <= 7 }
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 12) {
                SectionLabel(text: "Earnings calendar")
                Text("the book, next 60 days")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                Spacer()
                Text("\(rows.count) scheduled")
                    .font(Term.mono(9)).foregroundStyle(Term.fgDim)
            }
            if !soon.isEmpty {
                // The line somebody actually opens this for.
                Text("THIS WEEK: " + soon.compactMap { $0.ticker }.joined(separator: ", "))
                    .font(Term.mono(10, weight: .bold)).foregroundStyle(Term.amber)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
    }

    private enum Field: CaseIterable {
        case date, when, ticker, name, eps, rev, away
        var title: String {
            switch self {
            case .date: return "DATE"
            case .when: return "WHEN"
            case .ticker: return "TICKER"
            case .name: return "COMPANY"
            case .eps: return "EPS EST"
            case .rev: return "REV EST"
            case .away: return "IN"
            }
        }
        var width: CGFloat? {
            switch self {
            case .date: return 86
            case .when: return 58
            case .ticker: return 62
            case .name: return nil
            case .eps: return 72
            case .rev: return 88
            case .away: return 56
            }
        }
        var align: Alignment {
            switch self {
            case .date, .when, .ticker, .name: return .leading
            default: return .trailing
            }
        }
    }

    private func sized<V: View>(_ f: Field, @ViewBuilder _ c: () -> V) -> some View {
        Group {
            if let w = f.width { c().frame(width: w, alignment: f.align) }
            else { c().frame(minWidth: 100, maxWidth: .infinity, alignment: f.align) }
        }
    }

    private var columnHeads: some View {
        HStack(spacing: 8) {
            ForEach(Field.allCases, id: \.self) { f in sized(f) { Text(f.title) } }
        }
        .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func weekHeader(_ label: String) -> some View {
        Text(label)
            .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.cyan)
            .padding(.horizontal, 10).padding(.top, 7).padding(.bottom, 2)
    }

    private func row(_ r: Row) -> some View {
        let days = daysAway(r.date)
        return HStack(spacing: 8) {
            ForEach(Field.allCases, id: \.self) { f in
                sized(f) { cell(f, r, days) }
            }
        }
        .font(Term.mono(11)).foregroundStyle(Term.white)
        .padding(.horizontal, 10).padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture {
            if let t = r.ticker {
                NotificationCenter.default.post(name: .runCommand, object: "\(t) EARN")
            }
        }
        .help("Open EARN for \(r.ticker ?? "")")
    }

    @ViewBuilder
    private func cell(_ f: Field, _ r: Row, _ days: Int?) -> some View {
        switch f {
        case .date:
            Text(r.date.map { Fmt.date($0) } ?? "—")
        case .when:
            // Spelled out. "bmo" is jargon for the three people who
            // already know it and noise for everyone else.
            Text(whenLabel(r.hour))
                .font(Term.mono(9)).foregroundStyle(Term.fgDim)
        case .ticker:
            Text(r.ticker ?? "—").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
        case .name:
            Text(r.name ?? "—").foregroundStyle(Term.fgDim).lineLimit(1)
        case .eps:
            Text(r.epsEstimate.map { Fmt.money($0) } ?? "—")
                .foregroundStyle(r.epsEstimate == nil ? Term.fgMuted : Term.white)
        case .rev:
            Text(r.revenueEstimate.map { bigMoney($0) } ?? "—")
                .foregroundStyle(r.revenueEstimate == nil ? Term.fgMuted : Term.white)
        case .away:
            if let d = days {
                Text(d == 0 ? "TODAY" : "\(d)d")
                    .font(Term.mono(10, weight: d <= 7 ? .bold : .regular))
                    .foregroundStyle(d <= 7 ? Term.amber : Term.fgDim)
            } else {
                Text("—").foregroundStyle(Term.fgMuted)
            }
        }
    }

    /// Revenue estimates arrive in dollars and run to eleven digits.
    /// Rendered raw they push every other column off the pane.
    private func bigMoney(_ v: Double) -> String {
        let a = abs(v)
        if a >= 1e9 { return String(format: "$%.2fb", v / 1e9) }
        if a >= 1e6 { return String(format: "$%.1fm", v / 1e6) }
        return Fmt.money(v, decimals: 0)
    }

    private func whenLabel(_ h: String?) -> String {
        switch h?.lowercased() {
        case "bmo": return "pre-open"
        case "amc": return "post-close"
        case "dmh": return "intraday"
        default: return "—"
        }
    }

    private func daysAway(_ iso: String?) -> Int? {
        guard let iso, iso.count >= 10 else { return nil }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "America/New_York")
        guard let d = f.date(from: String(iso.prefix(10))) else { return nil }
        let cal = Calendar.current
        return cal.dateComponents([.day], from: cal.startOfDay(for: Date()),
                                  to: cal.startOfDay(for: d)).day
    }

    /// Grouped by week so a run of four reports in three days reads as
    /// the busy stretch it is rather than four separate rows.
    private func grouped(_ rows: [Row]) -> [(String, [Row])] {
        var out: [(String, [Row])] = []
        for r in rows {
            let key = weekLabel(daysAway(r.date))
            if let i = out.firstIndex(where: { $0.0 == key }) {
                out[i].1.append(r)
            } else {
                out.append((key, [r]))
            }
        }
        return out
    }

    private func weekLabel(_ days: Int?) -> String {
        guard let d = days else { return "UNDATED" }
        if d <= 7 { return "THIS WEEK" }
        if d <= 14 { return "NEXT WEEK" }
        if d <= 30 { return "THIS MONTH" }
        return "LATER"
    }

    private func load() async {
        state = .loading
        do {
            let d = try await API.shared.get("/holdings/earnings")
            state = .loaded(try await API.shared.decode(Payload.self, from: d))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
