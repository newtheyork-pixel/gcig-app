import XCTest
import SQLite3
@testable import GriffinTerminal

/// The real database is Apple's, undocumented, and behind Full Disk
/// Access, so it cannot be read from a test run. What CAN be pinned down
/// is everything this reader does once it has a handle: the epoch
/// conversion, the two storage forms of a phone number, the time window,
/// and the refusal to match on too few digits.
///
/// The schema built here is the one the reader expects to meet. If Apple
/// changes theirs, `probe()` reports a mismatch rather than this suite
/// going quiet, which is the whole reason the columns are discovered at
/// runtime instead of hardcoded.
final class CallHistoryTests: XCTestCase {

    /// Seconds between the Unix epoch and Core Data's 2001 reference date.
    private let coreDataEpoch = Date(timeIntervalSinceReferenceDate: 0)

    private func makeDB(_ rows: [(date: Date, duration: Double, number: String,
                                  answered: Int, originated: Int, asBlob: Bool)]) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("callhistory-\(UUID().uuidString).storedata")
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }

        XCTAssertEqual(sqlite3_exec(db, """
        CREATE TABLE ZCALLRECORD (
            Z_PK INTEGER PRIMARY KEY, ZDATE REAL, ZDURATION REAL,
            ZADDRESS BLOB, ZANSWERED INTEGER, ZORIGINATED INTEGER
        );
        """, nil, nil, nil), SQLITE_OK)

        for r in rows {
            let stored = r.asBlob
                ? "X'\(r.number.utf8.map { String(format: "%02X", $0) }.joined())'"
                : "'\(r.number)'"
            let sql = """
            INSERT INTO ZCALLRECORD (ZDATE, ZDURATION, ZADDRESS, ZANSWERED, ZORIGINATED)
            VALUES (\(r.date.timeIntervalSinceReferenceDate), \(r.duration), \(stored), \
            \(r.answered), \(r.originated));
            """
            XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
        }
        return url
    }

    func testFindsTheCallWeJustPlaced() throws {
        let placed = Date()
        let url = try makeDB([
            (placed.addingTimeInterval(12), 214, "+16145550134", 1, 1, false),
        ])
        let rec = CallHistory.mostRecent(matching: "+16145550134", placedAt: placed, at: url)
        XCTAssertNotNil(rec)
        XCTAssertEqual(rec?.duration, 214)
        XCTAssertTrue(rec?.answered == true)
        // The stamp survives the 2001 epoch conversion.
        XCTAssertEqual(rec!.startedAt.timeIntervalSince1970,
                       placed.addingTimeInterval(12).timeIntervalSince1970, accuracy: 1)
    }

    /// The number column is TEXT on some releases and a BLOB on others.
    /// Reading only one of them returns "no such call" for a call that is
    /// sitting right there in the table.
    func testReadsTheNumberWhetherItIsTextOrBlob() throws {
        for asBlob in [true, false] {
            let placed = Date()
            let url = try makeDB([(placed.addingTimeInterval(5), 60, "(614) 555-0134", 1, 1, asBlob)])
            XCTAssertNotNil(CallHistory.mostRecent(matching: "+16145550134", placedAt: placed, at: url),
                            "blob: \(asBlob)")
        }
    }

    /// The record stores whatever form the call was placed in; we store
    /// E.164. Ten digits is the most the two can be relied on to share.
    func testMatchesAcrossTheFormsAPhoneNumberIsWrittenIn() throws {
        let placed = Date()
        for written in ["+1 (614) 555-0134", "6145550134", "1-614-555-0134", "614.555.0134"] {
            let url = try makeDB([(placed.addingTimeInterval(3), 42, written, 1, 1, false)])
            XCTAssertNotNil(CallHistory.mostRecent(matching: "+16145550134", placedAt: placed, at: url),
                            written)
        }
    }

    func testADifferentStoreIsNotOurCall() throws {
        let placed = Date()
        let url = try makeDB([(placed.addingTimeInterval(10), 300, "+16145559999", 1, 1, false)])
        XCTAssertNil(CallHistory.mostRecent(matching: "+16145550134", placedAt: placed, at: url))
    }

    /// Ringing the same store twice in an afternoon is normal. Attaching
    /// the morning's call to the evening's row would be worse than
    /// attaching nothing, so the window is bounded and the earliest call
    /// inside it wins.
    func testTakesTheCallInsideTheWindowNotTheOneBeforeIt() throws {
        let placed = Date()
        let url = try makeDB([
            (placed.addingTimeInterval(-6 * 3600), 600, "+16145550134", 1, 1, false),
            (placed.addingTimeInterval(30), 95, "+16145550134", 1, 1, false),
        ])
        let rec = CallHistory.mostRecent(matching: "+16145550134", placedAt: placed, at: url)
        XCTAssertEqual(rec?.duration, 95)
    }

    func testACallAfterTheWindowIsNotOurs() throws {
        let placed = Date()
        let url = try makeDB([(placed.addingTimeInterval(9 * 3600), 120, "+16145550134", 1, 1, false)])
        XCTAssertNil(CallHistory.mostRecent(matching: "+16145550134", placedAt: placed,
                                            window: 4 * 3600, at: url))
    }

    func testARingOutIsFoundAndReportedAsUnanswered() throws {
        let placed = Date()
        let url = try makeDB([(placed.addingTimeInterval(4), 0, "+16145550134", 0, 1, false)])
        let rec = CallHistory.mostRecent(matching: "+16145550134", placedAt: placed, at: url)
        XCTAssertEqual(rec?.answered, false)
        XCTAssertEqual(rec?.duration, 0)
    }

    func testTooFewDigitsNeverMatches() throws {
        // Padding a short string into a comparison is how a three-digit
        // internal extension becomes somebody's store.
        XCTAssertEqual(CallHistory.lastTen("911"), "")
        XCTAssertEqual(CallHistory.lastTen("+16145550134"), "6145550134")
        let placed = Date()
        let url = try makeDB([(placed.addingTimeInterval(2), 10, "411", 1, 1, false)])
        XCTAssertNil(CallHistory.mostRecent(matching: "411", placedAt: placed, at: url))
    }

    /// We store dialled numbers with the extension attached. A naive
    /// digit filter over "+16145550134;ext=231" yields ten digits that
    /// belong to nobody, and the failure is invisible: the panel reports
    /// no call record for a store that was rung and answered.
    /// The gap between a voicemail and the redial that follows it is
    /// under a minute, and the window used to reach five minutes back.
    /// The second attempt then inherited the first call's duration and
    /// answered flag, stamped `callhistory` — labelled as the phone's own
    /// authoritative measurement while being the wrong call entirely.
    func testARedialDoesNotInheritThePreviousCall() throws {
        let firstPlaced = Date()
        let redialPlaced = firstPlaced.addingTimeInterval(45)
        let url = try makeDB([
            (firstPlaced.addingTimeInterval(3), 20, "+16145550134", 0, 1, false),
            (redialPlaced.addingTimeInterval(4), 260, "+16145550134", 1, 1, false),
        ])
        let second = CallHistory.mostRecent(matching: "+16145550134", placedAt: redialPlaced, at: url)
        XCTAssertEqual(second?.duration, 260, "the redial takes its own record")
        XCTAssertEqual(second?.answered, true)

        let first = CallHistory.mostRecent(matching: "+16145550134", placedAt: firstPlaced, at: url)
        XCTAssertEqual(first?.duration, 20, "and the first attempt keeps its own")
    }

    func testAnExtensionDoesNotPoisonTheMatch() throws {
        XCTAssertEqual(CallHistory.lastTen("+16145550134;ext=231"), "6145550134")
        let placed = Date()
        let url = try makeDB([(placed.addingTimeInterval(8), 180, "+16145550134", 1, 1, false)])
        XCTAssertNotNil(CallHistory.mostRecent(matching: "+16145550134;ext=231",
                                               placedAt: placed, at: url))
    }

    func testAnAbsentDatabaseIsNotACrash() {
        let nowhere = FileManager.default.temporaryDirectory
            .appendingPathComponent("no-such-\(UUID().uuidString).storedata")
        XCTAssertNil(CallHistory.mostRecent(matching: "+16145550134", placedAt: Date(), at: nowhere))
    }
}
