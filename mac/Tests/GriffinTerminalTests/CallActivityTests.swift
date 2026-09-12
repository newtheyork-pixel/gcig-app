import XCTest
@testable import GriffinTerminal

/// Every mistake this feature has made about call state was a judgement
/// about when a call starts and stops, never the plumbing. So the
/// judgement is tested and the plumbing is not, because the plumbing is
/// a hardware read and the judgement is where rows got closed out from
/// under live calls.
final class CallActivityTests: XCTestCase {

    func testDiallingWithNoAudioIsNotACall() {
        // The gap between pressing DIAL and the line ringing. The old
        // timer started here and counted regardless, which is why it
        // could not tell ringing from talking.
        var t = CallActivityTracker()
        XCTAssertEqual(t.observe(live: false), .nothingYet)
        XCTAssertEqual(t.observe(live: false), .nothingYet)
        XCTAssertFalse(t.everLive)
    }

    func testRingingIsTheStart() {
        var t = CallActivityTracker()
        _ = t.observe(live: false)
        XCTAssertEqual(t.observe(live: true), .started)
        XCTAssertEqual(t.observe(live: true), .continuing)
    }

    func testAMomentaryGapIsNotAHangup() {
        // Audio flickers. Treating one quiet sample as the end is how a
        // call gets closed while somebody is still talking.
        var t = CallActivityTracker(quietToEnd: 4)
        _ = t.observe(live: true)
        XCTAssertEqual(t.observe(live: false), .continuing)
        XCTAssertEqual(t.observe(live: false), .continuing)
        XCTAssertEqual(t.observe(live: true), .continuing, "it came back")
        XCTAssertEqual(t.observe(live: false), .continuing)
    }

    func testSustainedQuietEndsIt() {
        var t = CallActivityTracker(quietToEnd: 4)
        _ = t.observe(live: true)
        for _ in 1..<4 { XCTAssertEqual(t.observe(live: false), .continuing) }
        XCTAssertEqual(t.observe(live: false), .ended)
    }

    func testQuietBeforeAnythingEverStartedNeverEnds() {
        // A call placed on a handset across the room never shows up here.
        // It must sit as "not started" forever rather than declaring
        // itself over, because declaring it over would close the row.
        var t = CallActivityTracker(quietToEnd: 2)
        for _ in 0..<50 {
            XCTAssertEqual(t.observe(live: false), .nothingYet)
        }
    }

    func testTheCallBundlesAreTheCallBundles() throws {
        guard #available(macOS 14.2, *) else { throw XCTSkip("needs macOS 14.2") }
        XCTAssertTrue(CallActivity.callBundles.contains("com.apple.FaceTime"))
    }

    /// Reads the real process list. Asserts only that it can be read and
    /// does not crash, because whether a call is up depends on whether
    /// somebody is on the phone while the suite runs.
    func testTheProcessListIsReadableWithoutAnyPermission() throws {
        guard #available(macOS 14.2, *) else { throw XCTSkip("needs macOS 14.2") }
        let snap = CallActivity.snapshot()
        XCTAssertEqual(snap.live, !snap.bundles.isEmpty)
    }
}
