import Foundation

// Is this door open right now, where it is?
//
// The sample runs across three time zones, and the decision the queue has
// to support is not "what are their hours" but "can I ring this one in
// the next two minutes". Those are different questions and only the
// second one is useful at four in the afternoon.
//
// Two moments are worth naming rather than merely reporting. The last
// half hour before close is when a salesperson is cashing up and counting
// stock, and the refusal that earns looks identical in the log to a
// refusal about the questions — which quietly poisons the only rate this
// whole exercise measures. The first half hour after opening is the same
// trap with a different cause.
enum StoreClock {

    struct Hours: Decodable, Hashable {
        let day: String
        let opens: String
        let closes: String
    }

    enum Status: Equatable {
        /// Open, with minutes left before it shuts.
        case open(minutesToClose: Int)
        /// Open but inside the window where asking is a waste of a door.
        case closingSoon(minutesToClose: Int)
        case justOpened(minutesSinceOpen: Int)
        /// Shut, with minutes until it opens, when that is known today.
        case closed(minutesToOpen: Int?)
        /// No hours on file. Never guessed at.
        case unknown

        var isCallable: Bool {
            switch self {
            case .open, .justOpened: return true
            case .closingSoon, .closed, .unknown: return false
            }
        }
    }

    /// Minutes before close at which ringing stops being worth it.
    static let closingWindow = 30
    /// Minutes after opening that carry the same problem.
    static let openingWindow = 20

    /// @param now Injectable so this can be tested without waiting for
    ///   half past six on a Tuesday.
    static func status(hours: [Hours]?, timezone: String?, now: Date = Date()) -> Status {
        guard let hours, !hours.isEmpty, let zone = timezone.flatMap(TimeZone.init(identifier:))
        else { return .unknown }

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let parts = cal.dateComponents([.weekday, .hour, .minute], from: now)
        guard let weekday = parts.weekday, let hour = parts.hour, let minute = parts.minute
        else { return .unknown }
        let nowMinutes = hour * 60 + minute

        // Core Data counts weekdays from Sunday = 1; the locator names
        // them. Matching on the name rather than an index, because an
        // off-by-one here is a queue that reports Monday's hours on a
        // Sunday and nobody notices until somebody rings a closed shop.
        let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        let today = dayNames[(weekday - 1) % 7]
        let tomorrow = dayNames[weekday % 7]

        guard let spec = hours.first(where: { $0.day.caseInsensitiveCompare(today) == .orderedSame }),
              let opens = minutes(spec.opens), let closes = minutes(spec.closes)
        else {
            // Closed today. If tomorrow is on file, say when.
            if let next = hours.first(where: { $0.day.caseInsensitiveCompare(tomorrow) == .orderedSame }),
               let o = minutes(next.opens) {
                return .closed(minutesToOpen: (24 * 60 - nowMinutes) + o)
            }
            return .closed(minutesToOpen: nil)
        }

        if nowMinutes < opens {
            return .closed(minutesToOpen: opens - nowMinutes)
        }
        if nowMinutes >= closes {
            if let next = hours.first(where: { $0.day.caseInsensitiveCompare(tomorrow) == .orderedSame }),
               let o = minutes(next.opens) {
                return .closed(minutesToOpen: (24 * 60 - nowMinutes) + o)
            }
            return .closed(minutesToOpen: nil)
        }

        let toClose = closes - nowMinutes
        if toClose <= closingWindow { return .closingSoon(minutesToClose: toClose) }
        let sinceOpen = nowMinutes - opens
        if sinceOpen < openingWindow { return .justOpened(minutesSinceOpen: sinceOpen) }
        return .open(minutesToClose: toClose)
    }

    /// "11:00" to 660. Nil rather than zero on anything unexpected, so a
    /// malformed row reads as unknown hours instead of a shop that opens
    /// at midnight.
    static func minutes(_ hhmm: String) -> Int? {
        let bits = hhmm.split(separator: ":")
        guard bits.count >= 2, let h = Int(bits[0]), let m = Int(bits[1]),
              (0...24).contains(h), (0..<60).contains(m) else { return nil }
        return h * 60 + m
    }

    /// The store's own wall clock, for the console. Somebody about to ring
    /// Denver from New York should see both.
    static func localTime(timezone: String?, now: Date = Date()) -> String? {
        guard let zone = timezone.flatMap(TimeZone.init(identifier:)) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = "h:mm a"
        return f.string(from: now)
    }

    /// "1h 20m", "40m". Short because it sits on a queue row.
    static func brief(_ minutes: Int) -> String {
        if minutes < 60 { return "\(minutes)m" }
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }

    /// The IANA zone for a state.
    ///
    /// Exact for every state in the current sample and deliberately nil
    /// for the ones that straddle a boundary rather than guessing: El
    /// Paso is Mountain while the rest of Texas is Central, and a wrong
    /// zone is worse than no zone because it produces a confident answer.
    static func zoneForState(_ state: String?) -> String? {
        guard let s = state?.trimmingCharacters(in: .whitespaces).uppercased() else { return nil }
        switch s {
        case "CT", "DE", "DC", "GA", "ME", "MD", "MA", "NH", "NJ", "NY",
             "NC", "OH", "PA", "RI", "SC", "VT", "VA", "WV", "MI":
            return "America/New_York"
        case "AL", "AR", "IL", "IA", "LA", "MN", "MS", "MO", "OK", "WI":
            return "America/Chicago"
        case "AZ":   return "America/Phoenix"
        case "CO", "MT", "NM", "UT", "WY":
            return "America/Denver"
        case "CA", "WA":
            return "America/Los_Angeles"
        case "TX":   return "America/Chicago"   // wrong only for El Paso
        case "FL":   return "America/New_York"  // wrong only for the panhandle
        case "IN":   return "America/Indiana/Indianapolis"
        case "TN", "KY", "KS", "NE", "ND", "SD", "ID", "OR", "AK", "HI", "NV":
            return nil                          // genuinely split, or its own case
        default:     return nil
        }
    }
}
