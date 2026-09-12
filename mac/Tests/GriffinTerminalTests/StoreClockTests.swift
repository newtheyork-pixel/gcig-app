import XCTest
@testable import GriffinTerminal

/// The queue has to answer "can I ring this one now", across three time
/// zones, and two of the answers are traps rather than facts: the last
/// half hour before close and the first twenty minutes after opening are
/// both times when a salesperson says no for reasons that have nothing
/// to do with the questions. A refusal earned that way is indistinguish-
/// able in the log from a real one, which poisons the only rate this
/// exercise measures.
final class StoreClockTests: XCTestCase {

    let mallHours = [
        StoreClock.Hours(day: "Monday", opens: "11:00", closes: "19:00"),
        StoreClock.Hours(day: "Tuesday", opens: "11:00", closes: "19:00"),
        StoreClock.Hours(day: "Wednesday", opens: "11:00", closes: "19:00"),
        StoreClock.Hours(day: "Thursday", opens: "11:00", closes: "19:00"),
        StoreClock.Hours(day: "Friday", opens: "11:00", closes: "19:00"),
        StoreClock.Hours(day: "Saturday", opens: "11:00", closes: "19:00"),
        StoreClock.Hours(day: "Sunday", opens: "12:00", closes: "18:00"),
    ]

    /// A moment, given as wall-clock time in a named zone.
    private func at(_ iso: String, _ zone: String) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: zone)
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.date(from: iso)!
    }

    func testOpenInTheMiddleOfTheAfternoon() {
        // Thursday, 2pm in San Antonio.
        let s = StoreClock.status(hours: mallHours, timezone: "America/Chicago",
                                  now: at("2026-09-10 14:00", "America/Chicago"))
        XCTAssertEqual(s, .open(minutesToClose: 300))
        XCTAssertTrue(s.isCallable)
    }

    func testTheLastHalfHourIsNotCallable() {
        let s = StoreClock.status(hours: mallHours, timezone: "America/Chicago",
                                  now: at("2026-09-10 18:45", "America/Chicago"))
        XCTAssertEqual(s, .closingSoon(minutesToClose: 15))
        XCTAssertFalse(s.isCallable, "cashing up is not a moment to ask for two minutes")
    }

    func testTheOpeningRushIsFlaggedButStillCallable() {
        let s = StoreClock.status(hours: mallHours, timezone: "America/Chicago",
                                  now: at("2026-09-10 11:05", "America/Chicago"))
        XCTAssertEqual(s, .justOpened(minutesSinceOpen: 5))
        XCTAssertTrue(s.isCallable)
    }

    /// The error this whole feature exists to prevent: ringing Denver on
    /// New York time and reading the silence as a store that will not
    /// talk.
    func testTheSameInstantIsOpenInOneZoneAndShutInAnother() {
        let instant = at("2026-09-10 20:30", "America/New_York")  // 6:30pm in Denver
        let denver = StoreClock.status(hours: mallHours, timezone: "America/Denver", now: instant)
        let cleveland = StoreClock.status(hours: mallHours, timezone: "America/New_York", now: instant)
        XCTAssertEqual(denver, .closingSoon(minutesToClose: 30))
        if case .closed = cleveland {} else { XCTFail("8:30pm in Ohio is shut, got \(cleveland)") }
    }

    func testBeforeOpeningSaysHowLong() {
        let s = StoreClock.status(hours: mallHours, timezone: "America/Chicago",
                                  now: at("2026-09-10 09:30", "America/Chicago"))
        XCTAssertEqual(s, .closed(minutesToOpen: 90))
    }

    func testAfterClosingCountsToTomorrow() {
        // Thursday 8pm, opens 11am Friday: 4h + 11h = 900 minutes.
        let s = StoreClock.status(hours: mallHours, timezone: "America/Chicago",
                                  now: at("2026-09-10 20:00", "America/Chicago"))
        XCTAssertEqual(s, .closed(minutesToOpen: 900))
    }

    func testSundayKeepsItsOwnHours() {
        // Sunday 11:30 is before a noon opening, even though every other
        // day opens at eleven. Matching the day by NAME rather than an
        // index is what keeps this honest.
        let s = StoreClock.status(hours: mallHours, timezone: "America/Chicago",
                                  now: at("2026-09-13 11:30", "America/Chicago"))
        XCTAssertEqual(s, .closed(minutesToOpen: 30))
    }

    func testNoHoursIsUnknownAndNeverGuessed() {
        XCTAssertEqual(StoreClock.status(hours: nil, timezone: "America/Chicago"), .unknown)
        XCTAssertEqual(StoreClock.status(hours: [], timezone: "America/Chicago"), .unknown)
        XCTAssertEqual(StoreClock.status(hours: mallHours, timezone: nil), .unknown)
        XCTAssertEqual(StoreClock.status(hours: mallHours, timezone: "Nowhere/Fake"), .unknown)
        XCTAssertFalse(StoreClock.Status.unknown.isCallable, "unknown must never read as open")
    }

    func testAMalformedTimeReadsAsUnknownRatherThanMidnight() {
        let bad = [StoreClock.Hours(day: "Thursday", opens: "", closes: "19:00")]
        XCTAssertEqual(StoreClock.status(hours: bad, timezone: "America/Chicago",
                                         now: at("2026-09-10 14:00", "America/Chicago")),
                       .closed(minutesToOpen: nil))
        XCTAssertNil(StoreClock.minutes("25:00"))
        XCTAssertNil(StoreClock.minutes("11:75"))
        XCTAssertEqual(StoreClock.minutes("11:00"), 660)
    }

    func testStatesThatStraddleAZoneGetNoGuess() {
        // A wrong zone is worse than no zone, because it answers
        // confidently. Tennessee and Kentucky are genuinely split.
        XCTAssertNil(StoreClock.zoneForState("TN"))
        XCTAssertNil(StoreClock.zoneForState("KY"))
        XCTAssertEqual(StoreClock.zoneForState("OH"), "America/New_York")
        XCTAssertEqual(StoreClock.zoneForState("mn"), "America/Chicago")
        XCTAssertEqual(StoreClock.zoneForState("CO"), "America/Denver")
        XCTAssertNil(StoreClock.zoneForState(nil))
    }

    func testBriefIsShortEnoughForAQueueRow() {
        XCTAssertEqual(StoreClock.brief(40), "40m")
        XCTAssertEqual(StoreClock.brief(60), "1h")
        XCTAssertEqual(StoreClock.brief(80), "1h 20m")
    }
}
