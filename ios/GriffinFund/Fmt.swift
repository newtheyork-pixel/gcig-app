import Foundation

// The only formatters. A screen that formats a number itself is a screen
// that will disagree with the one next to it.
//
// Every entry point takes an optional and returns an em dash for nil.
// A missing figure rendered as "$0" is a fabricated number in 28pt bold,
// and all-optional decodables mean one renamed server key produces exactly
// that. Optional in, dash out, with no exceptions: `pct` used to take a
// non-optional Double, which forced callers to invent a zero to call it.
enum Fmt {

    /// Money, always in US dollars with US grouping.
    ///
    /// The locale is pinned to en_US, and the distinction matters: this was
    /// briefly pinned to en_US_POSIX, copied from the date parsers below
    /// where it is correct. POSIX is a locale with no grouping separator,
    /// so $137,070 rendered as $137070 and the book looked broken. POSIX
    /// exists to make a fixed format string parse the same on every handset;
    /// it is not a formatting locale.
    ///
    /// en_US rather than Locale.current because the fund's book is in
    /// dollars for a US school no matter which handset is reading it, and a
    /// phone set to French would otherwise print 137 070,00 $.
    static func money(_ v: Double?, decimals: Int = 0) -> String {
        guard let v else { return "—" }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = Locale(identifier: "en_US")
        f.currencyCode = "USD"
        f.minimumFractionDigits = decimals
        f.maximumFractionDigits = decimals
        return f.string(from: NSNumber(value: v)) ?? "—"
    }

    /// A signed money delta: +$1,204 / -$318. The sign is explicit on the
    /// positive side because a gain with no sign reads as a level.
    static func moneyDelta(_ v: Double?, decimals: Int = 0) -> String {
        guard let v else { return "—" }
        let body = money(abs(v), decimals: decimals)
        if body == "—" { return "—" }
        return (v > 0 ? "+" : v < 0 ? "-" : "") + body
    }

    static func pct(_ v: Double?, decimals: Int = 2, signed: Bool = true) -> String {
        guard let v else { return "—" }
        let s = String(format: "%.\(decimals)f", abs(v))
        let sign = !signed ? "" : (v > 0 ? "+" : (v < 0 ? "-" : ""))
        return "\(sign)\(s)%"
    }

    /// A valuation multiple: 18.4x. Its own formatter rather than percent
    /// with the sign suppressed and the symbol swapped, which is what this
    /// was doing and what would have printed a negative P/E as a positive.
    static func multiple(_ v: Double?) -> String {
        guard let v else { return "—" }
        return String(format: "%.1fx", v)
    }

    /// 1.2B / 340.5M / 12.3K. Big numbers in a narrow column.
    static func compact(_ v: Double?) -> String {
        guard let v else { return "—" }
        let a = abs(v)
        let sign = v < 0 ? "-" : ""
        switch a {
        case 1_000_000_000_000...: return "\(sign)\(String(format: "%.2f", a / 1_000_000_000_000))T"
        case 1_000_000_000...:     return "\(sign)\(String(format: "%.2f", a / 1_000_000_000))B"
        case 1_000_000...:         return "\(sign)\(String(format: "%.1f", a / 1_000_000))M"
        case 1_000...:             return "\(sign)\(String(format: "%.1f", a / 1_000))K"
        default:                   return "\(sign)\(String(format: "%.2f", a))"
        }
    }

    static func shares(_ v: Double?) -> String {
        guard let v else { return "—" }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        f.maximumFractionDigits = v == v.rounded() ? 0 : 3
        return f.string(from: NSNumber(value: v)) ?? "—"
    }

    /// "2026-08-19" to "19 Aug", the house short form. Returns the input
    /// untouched rather than a wrong date when it will not parse.
    ///
    /// Here the POSIX locale IS correct, and for the reason it is always
    /// correct: a fixed format string is parsed against the reader's own
    /// calendar unless told otherwise, so a Thai Buddhist or Japanese
    /// Imperial phone reads yyyy in that era and lands centuries off.
    static func day(_ iso: String?) -> String {
        guard let iso, iso.count >= 10 else { return "—" }
        let inF = DateFormatter()
        inF.dateFormat = "yyyy-MM-dd"
        inF.locale = Locale(identifier: "en_US_POSIX")
        inF.timeZone = TimeZone(identifier: "UTC")
        guard let d = inF.date(from: String(iso.prefix(10))) else { return iso }
        let out = DateFormatter()
        out.dateFormat = "d MMM"
        out.locale = Locale(identifier: "en_US_POSIX")
        out.timeZone = TimeZone(identifier: "UTC")
        return out.string(from: d)
    }

    /// Date and clock, for anything whose lifetime is measured in minutes.
    static func shortDateTime(_ iso: String?) -> String {
        guard let iso, let d = parseISO(iso) else { return iso.map { String($0.prefix(16)) } ?? "—" }
        let out = DateFormatter()
        out.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "d MMM HH:mm"
        out.locale = Locale(identifier: "en_US_POSIX")
        return out.string(from: d)
    }

    /// "14:32", the reader's own clock, for the as-of stamp.
    static func clock(_ d: Date?) -> String {
        guard let d else { return "—" }
        return d.formatted(date: .omitted, time: .shortened)
    }

    /// The server sends fractional seconds on some rows and not others, and
    /// ISO8601DateFormatter refuses whichever it was not configured for.
    /// Both are tried in one place so no caller has to remember.
    static func parseISO(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
