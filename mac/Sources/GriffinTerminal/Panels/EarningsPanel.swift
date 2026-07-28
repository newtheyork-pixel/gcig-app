import SwiftUI

// EARN — next scheduled report and the trailing EPS beat/miss record.
//
// Shape comes from getEarnings in marketData.js via /terminal/earnings.
// Two things about that feed worth knowing before touching this file.
//
// The endpoint never 5xxes: a coverage gap (ETFs, funds, thin names)
// is an honest 200 with upcoming:null / history:[], so "empty" here is
// a real answer and gets its own sentence, not a spinner or an error.
//
// When Finnhub's free tier carries no reported actuals the server
// falls back to SEC XBRL, and those rows have NO estimate, date, or
// surprise — deliberately, because pairing SEC fiscal periods with
// Finnhub calendar dates risks a confidently wrong beat/miss. The web
// panel collapses to a two-column table for that mode and explains
// itself; the same degradation is ported here. The service marks the
// mode with `actualsSource`, though the route currently drops the
// field (it forwards only ticker/upcoming/history), so today we can
// only ever see the five-column shape with dashes. The check is kept
// anyway so the panel starts doing the right thing the moment the
// server forwards it.
//
// The web panel also fetches an AI brief from /terminal/annotate; the
// native ports skip that on purpose (DES does the same).
struct EarningsPanel: View {
    let ticker: String

    struct Upcoming: Decodable {
        let date: String?
        let epsEstimate: Double?
    }

    struct Row: Decodable {
        let period: String?
        let date: String?
        let epsEstimate: Double?
        let epsActual: Double?
        let surprisePct: Double?
    }

    struct Payload: Decodable {
        let ticker: String?
        let upcoming: Upcoming?
        let history: [Row]?
        let actualsSource: String?
    }

    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.upcoming == nil && ($0.history ?? []).isEmpty },
                   emptyText: "No earnings data for \(ticker.uppercased()) — common for ETFs, funds, and thinly-covered names.",
                   retry: { Task { await load() } }) { p in
            let history = p.history ?? []
            // Reported EPS from SEC filings carries no estimate to beat
            // or miss, so three columns of dashes would read as broken
            // rather than unavailable. Same collapse the web does.
            let fromSec = p.actualsSource == "sec"
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        nextReport(p.upcoming)
                        if history.isEmpty {
                            Text("No reported quarters on file yet.")
                                .font(Term.mono(11))
                                .foregroundStyle(Term.fgMuted)
                        } else {
                            table(history, fromSec: fromSec)
                        }
                        if fromSec {
                            Text("Reported EPS from SEC filings (diluted, as filed). The news wire carries analyst estimates for upcoming quarters but not for ones already reported, so there is no beat/miss to show against these — the trend is real, the surprise column is simply not available.")
                                .font(Term.mono(10))
                                .foregroundStyle(Term.fgMuted)
                                .lineSpacing(2)
                        }
                        Text("Finnhub earnings calendar · estimates vs. actuals, newest first · 12h cache. A green surprise is a beat, red a miss.")
                            .font(Term.mono(10))
                            .foregroundStyle(Term.fgMuted)
                            .lineSpacing(2)
                    }
                    .padding(12)
                }
            }
        }
        .task(id: ticker) { await load() }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            Text((p.ticker ?? ticker).uppercased())
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            SectionLabel(text: "Earnings")
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func nextReport(_ up: Upcoming?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("NEXT REPORT")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(Term.fgDim)
            if let up {
                Text(EarnDay.long(up.date))
                    .font(Term.mono(15))
                    .foregroundStyle(Term.white)
                if let d = EarnDay.daysUntil(up.date), d >= 0 {
                    Text("in \(d) day\(d == 1 ? "" : "s")")
                        .font(Term.mono(11))
                        .foregroundStyle(Term.fgDim)
                }
                Spacer(minLength: 6)
                Text("EPS est")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                Text(eps(up.epsEstimate))
                    .font(Term.mono(11, weight: .medium))
                    .foregroundStyle(Term.white)
            } else {
                Text("Not yet scheduled.")
                    .font(Term.mono(12))
                    .foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    private func table(_ rows: [Row], fromSec: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Period")
                    .frame(minWidth: 64, alignment: .leading)
                if !fromSec {
                    Text("Reported").frame(width: 64, alignment: .leading)
                    Text("EPS Est").frame(width: 62, alignment: .trailing)
                }
                Spacer(minLength: 6)
                Text("EPS Act").frame(width: 62, alignment: .trailing)
                if !fromSec {
                    Text("Surprise").frame(width: 66, alignment: .trailing)
                }
            }
            .font(Term.mono(9, weight: .bold))
            .foregroundStyle(Term.fgMuted)
            .padding(.vertical, 4)
            Divider().overlay(Term.border)
            // Keyed by position: SEC-mode rows share date:null, so no
            // field combination is guaranteed unique. The web keys on
            // period-plus-index for the same reason.
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                row(r, fromSec: fromSec)
            }
        }
    }

    private func row(_ r: Row, fromSec: Bool) -> some View {
        HStack(spacing: 8) {
            Text(r.period ?? "—")
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.amber)
                .frame(minWidth: 64, alignment: .leading)
            if !fromSec {
                Text(EarnDay.short(r.date))
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .frame(width: 64, alignment: .leading)
                Text(eps(r.epsEstimate))
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .frame(width: 62, alignment: .trailing)
            }
            Spacer(minLength: 6)
            Text(eps(r.epsActual))
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .frame(width: 62, alignment: .trailing)
            if !fromSec {
                // Zero is a beat on the web (>= 0 is green), so this
                // is not Term.delta, which mutes exact zero.
                Text(Fmt.pct(r.surprisePct, decimals: 1))
                    .font(Term.mono(11, weight: .medium))
                    .foregroundStyle(surpriseTone(r.surprisePct))
                    .frame(width: 66, alignment: .trailing)
            }
        }
        .padding(.vertical, 3)
    }

    private func surpriseTone(_ v: Double?) -> Color {
        guard let v else { return Term.white }
        return v >= 0 ? Term.positive : Term.negative
    }

    // EPS as the web renders it: -$0.42, $2.15, em dash when absent.
    // Fmt.money handles the digits; only the dollar sign and its
    // placement relative to the minus are ours.
    private func eps(_ v: Double?) -> String {
        guard let v else { return "—" }
        return v < 0 ? "-$\(Fmt.money(abs(v)))" : "$\(Fmt.money(v))"
    }

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("EARN needs a ticker.")
            return
        }
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/earnings/\(ticker)")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

// Earnings dates arrive as bare ISO days (YYYY-MM-DD), which Fmt.date
// cannot parse — its ISO8601 paths want a time component and its
// fallback echoes the raw string. Parsing a bare day as UTC slips the
// shown date a day back in any timezone west of UTC, so this pins the
// day to local midnight, the same guard the web's parseISODay and the
// server's earningsPeriod use.
private enum EarnDay {
    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: s)
    }

    /// "Jul 28, 2026" — the next-report headline.
    static func long(_ s: String?) -> String {
        guard let d = parse(s) else { return "—" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d, yyyy"
        return f.string(from: d)
    }

    /// "07/28/26" — the table's Reported column.
    static func short(_ s: String?) -> String {
        guard let d = parse(s) else { return "—" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MM/dd/yy"
        return f.string(from: d)
    }

    /// Whole calendar days from today, both ends pinned to midnight so
    /// a partial day never reads as one off.
    static func daysUntil(_ s: String?) -> Int? {
        guard let d = parse(s) else { return nil }
        let cal = Calendar.current
        return cal.dateComponents([.day],
                                  from: cal.startOfDay(for: Date()),
                                  to: cal.startOfDay(for: d)).day
    }
}
