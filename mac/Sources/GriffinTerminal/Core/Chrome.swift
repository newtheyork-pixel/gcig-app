import SwiftUI

// The Bloomberg chrome: the red function bar that tops every screen
// and the two-line security banner that sits under it. Neither is a
// panel. Chrome frames data, it never IS the data, which sets the one
// rule both views live by: they may go quiet, they may never fail.
// There is no PanelState here on purpose — a banner that throws up
// COULD NOT LOAD blocks the panel it exists to introduce, so every
// missing number is an em dash and every failed poll keeps whatever
// was last known good.

// MARK: - Function bar

/// The red one-liner. Bloomberg puts the mnemonic on the LEFT and the
/// long title RIGHT-ALIGNED — the code is what you typed and what you
/// will type again, so it lives where the eye starts; the title is
/// confirmation, so it can sit at the far edge. Deep red because the
/// bar is furniture: it must hold white text all day without shouting
/// over the numbers below it.
struct FunctionBar: View {
    let code: String
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            Text(code.uppercased())
                .font(Term.mono(10, weight: .bold))
                .foregroundStyle(Term.white)
            Spacer(minLength: 8)
            Text(label.uppercased())
                .font(Term.mono(9))
                .tracking(0.8)
                .foregroundStyle(Term.white)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity)
        .frame(height: 18)
        .background(Term.redBar)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Term.border).frame(height: 1)
        }
    }
}

// MARK: - Quote banner

/// The persistent two-line security header: ticker, live last with
/// the tick flash, day change, session chip; then the session line —
/// as-of, volume, O/H/L, prior close.
///
/// Two feeds, deliberately unequal. /terminal/quotes owns line 1: its
/// `last` carries the server's extended-hours merge, so it wins the
/// price no matter what intraday says. /terminal/intraday owns line 2:
/// volume and the as-of stamp come straight off it, and O/H/L are
/// derived here from its points (first / max / min) because the quote
/// feed simply does not carry them. Each feed failing degrades ONLY
/// its own line to dashes; the other keeps printing.
struct QuoteBanner: View {
    let ticker: String

    /// One /terminal/quotes value. `changePct` and `extendedPct` are
    /// ALREADY percents (1.23 == +1.23%) — unlike the sheet-derived
    /// fractions elsewhere in the app, so no ×100 anywhere below.
    /// A ticker the vendor missed arrives as JSON null and never
    /// lands in state, so a miss keeps the previous print.
    struct Quote: Decodable {
        let last: Double?
        let changePct: Double?
        let prevClose: Double?
        let session: String?      // "pre" / "post" when off-hours
        let extendedPct: Double?
        let close: Double?        // regular-session close, off-hours
    }

    /// The slice of /terminal/intraday this banner reads. `asOf` is
    /// free text ("Jul 28, 2026 5:03 PM ET") — rendered raw, never
    /// through Fmt.date, which would mangle it into a dash. `points`
    /// may be empty pre-open; that is a fact about the clock and it
    /// renders as dashes, not as an error.
    struct Intraday: Decodable {
        struct Point: Decodable {
            let t: Double?
            let price: Double?
        }
        let last: Double?
        let prevClose: Double?
        let volume: Double?
        let asOf: String?
        let points: [Point]?
    }

    @State private var quote: Quote?
    @State private var intraday: Intraday?
    /// When either poll last succeeded — the clock the as-of slot
    /// falls back to before intraday has spoken.
    @State private var polledAt: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            priceLine
            sessionLine
        }
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Term.bgHeader)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Term.border).frame(height: 1)
        }
        // Two loops, two cadences: 20s matches the server's per-ticker
        // quote TTL so most polls can carry a new print; 45s matches
        // the intraday cache. Both key on the ticker, and each clears
        // ONLY its own feed on a security change — the old name's
        // numbers under the new name's code is the one lie this
        // banner could tell.
        .task(id: ticker) {
            quote = nil
            while !Task.isCancelled {
                await pollQuote()
                try? await Task.sleep(for: .seconds(20))
            }
        }
        .task(id: ticker) {
            intraday = nil
            while !Task.isCancelled {
                await pollIntraday()
                try? await Task.sleep(for: .seconds(45))
            }
        }
    }

    // MARK: Line 1 — the price

    private var priceLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(ticker.uppercased())
                .font(Term.mono(13, weight: .bold))
                .foregroundStyle(Term.white)
            Text("US")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
            Text("$")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            Text(Fmt.money(quote?.last))
                .font(Term.mono(15, weight: .bold))
                .foregroundStyle(Term.white)
                .tickFlash(quote?.last)
            // Net and % share one color, keyed to the percent: derive
            // each independently and a rounding hair puts a green
            // +0.00 beside a red -0.01 on a flat day.
            Text(signedAbs(dayNet))
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.delta(quote?.changePct))
            Text(Fmt.pct(quote?.changePct))
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.delta(quote?.changePct))
            if let s = extendedSession {
                // The off-hours chip. Orange, not the delta colors —
                // WHICH session you are looking at is a different
                // fact from which way it is going.
                Text(s)
                    .font(Term.mono(9, weight: .bold))
                    .foregroundStyle(Term.orange)
                if let e = quote?.extendedPct {
                    Text(Fmt.pct(e))
                        .font(Term.mono(9, weight: .medium))
                        .foregroundStyle(Term.delta(e))
                }
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .padding(.horizontal, 10)
        .frame(height: 22)
    }

    // MARK: Line 2 — the session

    private var sessionLine: some View {
        HStack(spacing: 12) {
            Text("At \(asOfText)")
                .foregroundStyle(Term.fgMuted)
            stat("Vol", Fmt.money(intraday?.volume, decimals: 0))
            HStack(spacing: 8) {
                stat("O", Fmt.money(open))
                stat("H", Fmt.money(high))
                stat("L", Fmt.money(low))
            }
            stat("Prev", Fmt.money(intraday?.prevClose ?? quote?.prevClose))
            Spacer(minLength: 0)
        }
        .font(Term.mono(9))
        .lineLimit(1)
        .padding(.horizontal, 10)
        .frame(height: 16)
    }

    private func stat(_ label: String, _ value: String) -> some View {
        HStack(spacing: 3) {
            Text(label).foregroundStyle(Term.fgMuted)
            Text(value).foregroundStyle(Term.white)
        }
    }

    // MARK: Derivations

    private var extendedSession: String? {
        switch quote?.session?.lowercased() {
        case "pre":  return "PRE"
        case "post": return "POST"
        default:     return nil
        }
    }

    /// The DAY's net change. The subtlety is off-hours: `last` is then
    /// the extended print, but the day's move ended at the regular
    /// close — which the server sends as `close` for exactly this.
    /// In-session, `close` is absent or stale, so `last` rules.
    private var dayNet: Double? {
        guard let q = quote, let pc = q.prevClose else { return nil }
        let dayLast = extendedSession != nil ? (q.close ?? q.last)
                                             : (q.last ?? q.close)
        return dayLast.map { $0 - pc }
    }

    /// O/H/L off the intraday tape: the open is the first print, the
    /// extremes are the tape's extremes. Missing prices are dropped
    /// rather than zeroed — a 0 low on a real chart is a flash crash
    /// that never happened.
    private var prices: [Double] {
        (intraday?.points ?? []).compactMap(\.price)
    }
    private var open: Double?  { prices.first }
    private var high: Double?  { prices.max() }
    private var low: Double?   { prices.min() }

    /// The as-of slot: the server's own free-text stamp when it sent
    /// one, else the wall clock of our last good poll — pinned to ET
    /// like everything else on this tape — and a dash only before
    /// anything has ever answered.
    private var asOfText: String {
        if let a = intraday?.asOf, !a.isEmpty { return a }
        guard let d = polledAt else { return "—" }
        return "\(d.formatted(etClock)) ET"
    }

    private var etClock: Date.FormatStyle {
        Date.FormatStyle(locale: Locale(identifier: "en_US"),
                         timeZone: TimeZone(identifier: "America/New_York")
                             ?? .current)
            .hour(.defaultDigits(amPM: .abbreviated))
            .minute(.twoDigits)
    }

    /// "+1.23" / "-0.45" — Fmt has no signed money form and the sign
    /// is the whole message here.
    private func signedAbs(_ v: Double?) -> String {
        guard let v else { return "—" }
        return v >= 0 ? "+\(Fmt.money(v))" : Fmt.money(v)
    }

    // MARK: Polls
    //
    // Both polls swallow failure the same way the web's useLiveRefresh
    // does: a bad round trip returns without touching state, so the
    // last good numbers stand and the banner never blinks. The guard
    // chain means a transport error, a 500, and a decode surprise all
    // land identically — for chrome, they are the same non-event.

    private func pollQuote() async {
        let t = ticker.uppercased()
        guard !t.isEmpty,
              let data = try? await API.shared.get("/terminal/quotes",
                                                   query: ["tickers": t]),
              let map = try? await API.shared.decode([String: Quote?].self,
                                                     from: data),
              let q = map[t] ?? nil else { return }
        quote = q
        polledAt = Date()
    }

    private func pollIntraday() async {
        let t = ticker.uppercased()
        guard !t.isEmpty,
              let data = try? await API.shared.get("/terminal/intraday/\(t)"),
              let p = try? await API.shared.decode(Intraday.self,
                                                   from: data) else { return }
        intraday = p
        polledAt = Date()
    }
}
