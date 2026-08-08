import XCTest
@testable import GriffinTerminal

// The bells ring on a crossing, not a launch. These assert the pure
// schedule logic so nobody has to wait until half past nine to trust it.
final class MarketBellTests: XCTestCase {
    // A Thursday, chosen because it is unambiguously a weekday and far
    // from any DST fold.
    private let etCal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }()

    private func et(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int) -> Date {
        var c = DateComponents()
        c.year = y; c.month = mo; c.day = d; c.hour = h; c.minute = mi; c.second = 0
        c.timeZone = TimeZone(identifier: "America/New_York")
        return Calendar(identifier: .gregorian).date(from: c)!
    }

    func testCrossingTheOpenRingsTheOpen() {
        // 2026-08-06 is a Thursday.
        let bells = MarketBell.bellsCrossed(from: et(2026, 8, 6, 9, 29), to: et(2026, 8, 6, 9, 31))
        XCTAssertEqual(bells, [.open])
    }

    func testCrossingTheCloseRingsTheClose() {
        let bells = MarketBell.bellsCrossed(from: et(2026, 8, 6, 15, 59), to: et(2026, 8, 6, 16, 1))
        XCTAssertEqual(bells, [.close])
    }

    func testAWindowThatCrossesNeitherIsSilent() {
        let bells = MarketBell.bellsCrossed(from: et(2026, 8, 6, 11, 0), to: et(2026, 8, 6, 11, 5))
        XCTAssertTrue(bells.isEmpty)
    }

    func testLaunchingAfterTheOpenDoesNotReplayIt() {
        // A first real interval from noon onward never contains 9:30, so
        // opening the app at lunch is silent — the same guard that the
        // nil lastTick provides on the very first tick.
        let bells = MarketBell.bellsCrossed(from: et(2026, 8, 6, 12, 0), to: et(2026, 8, 6, 12, 10))
        XCTAssertTrue(bells.isEmpty)
    }

    func testTheBoundaryIsHalfOpenSoOneTickRingsOnce() {
        // 9:30:00 exactly is the ring instant. (9:28, 9:30] contains it;
        // (9:30, 9:32] does not — so two adjacent ticks ring exactly once.
        XCTAssertEqual(MarketBell.bellsCrossed(from: et(2026, 8, 6, 9, 28), to: et(2026, 8, 6, 9, 30)), [.open])
        XCTAssertTrue(MarketBell.bellsCrossed(from: et(2026, 8, 6, 9, 30), to: et(2026, 8, 6, 9, 32)).isEmpty)
    }

    func testSaturdayIsSilent() {
        // 2026-08-08 is a Saturday.
        let bells = MarketBell.bellsCrossed(from: et(2026, 8, 8, 9, 29), to: et(2026, 8, 8, 9, 31))
        XCTAssertTrue(bells.isEmpty)
    }
}
