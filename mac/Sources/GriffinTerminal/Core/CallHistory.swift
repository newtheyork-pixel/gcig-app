import Foundation
import AppKit
import SQLite3

// The phone's own record of a call, read back after you hang up.
//
// This is the difference between a log the desk typed and a log the
// handset kept. An app timer starts when somebody presses DIAL, so it
// counts the ringing, the misdial and the seconds spent finding the
// handset; macOS writes down when the call actually connected and how
// long it actually lasted. Both are useful and they are not the same
// measurement, which is why the server stores which one it was given.
//
// Two things make this harder than reading a file.
//
// It is behind Full Disk Access. The directory exists on every Mac and
// returns "Operation not permitted" until somebody grants it in System
// Settings, so the failure has to be diagnosed rather than reported as
// "no calls found" — the shape of the mistake here is a panel that says
// a call never happened because it could not open a database.
//
// And the schema is Apple's, undocumented, and has changed across
// releases. Nothing here hardcodes a column layout: the table and its
// columns are discovered at runtime and the reader says what it found
// when it cannot find what it needs. A hardcoded ZDATE that silently
// stops matching is how this kind of integration rots.
enum CallHistory {

    struct Record {
        let startedAt: Date
        let duration: TimeInterval
        let answered: Bool
        let originated: Bool
        let address: String
    }

    enum Availability: Equatable {
        /// Readable, and the columns we need were found.
        case ok
        /// The file is there and TCC is refusing us.
        case needsFullDiskAccess
        /// No database at this path at all, which on a Mac with no phone
        /// paired is the normal state rather than a fault.
        case absent
        /// Opened, but not shaped the way this reader expects. Carries
        /// what was actually found so the mismatch is debuggable.
        case unexpectedSchema(String)
        case failed(String)

        var isUsable: Bool { self == .ok }
    }

    static var databaseURL: URL {
        FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CallHistoryDB/CallHistory.storedata")
    }

    /// Cheap enough to call before showing a button that depends on it.
    static func probe() -> Availability {
        let url = databaseURL
        // `isReadableFile` answers false for both "not there" and "not
        // allowed", which are different problems with different fixes, so
        // the directory is checked separately to tell them apart.
        let dir = url.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) {
            // TCC makes a protected directory look absent to a process
            // without the grant, so this is checked by trying to list it:
            // a real absence and a refusal give different errors.
            do {
                _ = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            } catch let err as NSError {
                if err.code == NSFileReadNoPermissionError || err.code == 257 {
                    return .needsFullDiskAccess
                }
                return .absent
            }
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            if (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) == nil {
                return .needsFullDiskAccess
            }
            return .absent
        }

        var db: OpaquePointer?
        defer { if db != nil { sqlite3_close(db) } }
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(url.path, &db, flags, nil) == SQLITE_OK, let db else {
            return .needsFullDiskAccess
        }
        guard let table = findTable(db) else {
            return .unexpectedSchema("no call-record table in \(tableNames(db).joined(separator: ", "))")
        }
        let cols = columns(db, table: table)
        guard let layout = Layout(columns: cols) else {
            return .unexpectedSchema("\(table) has \(cols.joined(separator: ", "))")
        }
        _ = layout
        return .ok
    }

    /// The call that best matches a number we dialled, at a time we know.
    ///
    /// Matched on the last ten digits because the record stores whatever
    /// form the call was placed in and we store E.164, and bounded in
    /// time because ringing the same store twice in an afternoon is
    /// normal and attaching the wrong one would be worse than attaching
    /// none.
    static func mostRecent(matching e164: String,
                           placedAt: Date,
                           window: TimeInterval = 4 * 3600,
                           at path: URL? = nil) -> Record? {
        let wanted = lastTen(e164)
        guard !wanted.isEmpty else { return nil }

        var db: OpaquePointer?
        defer { if db != nil { sqlite3_close(db) } }
        guard sqlite3_open_v2((path ?? databaseURL).path, &db,
                              SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK,
              let db,
              let table = findTable(db),
              let layout = Layout(columns: columns(db, table: table))
        else { return nil }

        // Core Data counts from 2001. The window is applied in SQL so a
        // long history never has to be walked in Swift.
        //
        // The backward slack is 30 seconds and covers clock skew, nothing
        // more. It used to be five minutes, which is longer than the gap
        // between a voicemail and the redial that follows it — so the new
        // attempt picked up the old call's duration and answered flag and
        // stamped it `callhistory`, i.e. as the authoritative measurement.
        let from = placedAt.addingTimeInterval(-30).timeIntervalSinceReferenceDate
        let to = placedAt.addingTimeInterval(window).timeIntervalSinceReferenceDate
        let sql = """
        SELECT \(layout.date), \(layout.duration), \(layout.address), \
        \(layout.answered ?? "0"), \(layout.originated ?? "1") \
        FROM \(table) WHERE \(layout.date) >= ? AND \(layout.date) <= ? \
        ORDER BY \(layout.date) ASC
        """

        var stmt: OpaquePointer?
        defer { if stmt != nil { sqlite3_finalize(stmt) } }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { return nil }
        sqlite3_bind_double(stmt, 1, from)
        sqlite3_bind_double(stmt, 2, to)

        // The CLOSEST match to the moment we dialled, not the first one in
        // the window. Taking the first made a redial inherit the call
        // before it whenever both fell inside the slack.
        var best: Record?
        var bestGap = Double.greatestFiniteMagnitude
        while sqlite3_step(stmt) == SQLITE_ROW {
            let address = text(stmt, 2)
            guard lastTen(address) == wanted else { continue }
            let startedAt = Date(timeIntervalSinceReferenceDate: sqlite3_column_double(stmt, 0))
            let gap = abs(startedAt.timeIntervalSince(placedAt))
            guard gap < bestGap else { continue }
            bestGap = gap
            best = Record(
                startedAt: startedAt,
                duration: sqlite3_column_double(stmt, 1),
                answered: sqlite3_column_int(stmt, 3) != 0,
                originated: sqlite3_column_int(stmt, 4) != 0,
                address: address
            )
        }
        return best
    }

    /// Opens the pane the grant is made in. There is no API to request
    /// Full Disk Access, so the honest move is to take somebody to the
    /// switch rather than describe where it lives.
    static func openFullDiskAccessSettings() {
        let url = URL(string:
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")
        if let url { NSWorkspace.shared.open(url) }
    }

    // MARK: Schema discovery

    /// The columns this reader needs, found by suffix so a rename from
    /// ZDATE to DATE does not break it.
    private struct Layout {
        let date: String
        let duration: String
        let address: String
        let answered: String?
        let originated: String?

        init?(columns: [String]) {
            func find(_ needle: String) -> String? {
                columns.first { $0.uppercased() == needle || $0.uppercased() == "Z" + needle }
            }
            guard let d = find("DATE"), let dur = find("DURATION") else { return nil }
            // The number is under one of a few names depending on release.
            guard let addr = find("ADDRESS") ?? find("HANDLE") ?? find("REMOTEPARTY") else { return nil }
            date = d
            duration = dur
            address = addr
            answered = find("ANSWERED")
            originated = find("ORIGINATED")
        }
    }

    private static func tableNames(_ db: OpaquePointer) -> [String] {
        var out: [String] = []
        var stmt: OpaquePointer?
        defer { if stmt != nil { sqlite3_finalize(stmt) } }
        guard sqlite3_prepare_v2(db, "SELECT name FROM sqlite_master WHERE type='table'", -1, &stmt, nil) == SQLITE_OK,
              let stmt else { return out }
        while sqlite3_step(stmt) == SQLITE_ROW { out.append(text(stmt, 0)) }
        return out
    }

    private static func findTable(_ db: OpaquePointer) -> String? {
        let names = tableNames(db)
        let match = names.first { $0.uppercased().contains("CALLRECORD") }
            ?? names.first { $0.uppercased().contains("CALL") }
        // Interpolated into SQL, so it is checked rather than trusted even
        // though it came from the database's own catalogue.
        guard let match, match.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        return match
    }

    private static func columns(_ db: OpaquePointer, table: String) -> [String] {
        var out: [String] = []
        var stmt: OpaquePointer?
        defer { if stmt != nil { sqlite3_finalize(stmt) } }
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &stmt, nil) == SQLITE_OK,
              let stmt else { return out }
        while sqlite3_step(stmt) == SQLITE_ROW { out.append(text(stmt, 1)) }
        return out
    }

    // MARK: Values

    /// The number column is TEXT in some releases and a BLOB in others.
    /// Reading only one of them is how this returns "no match" for a call
    /// that is sitting right there.
    private static func text(_ stmt: OpaquePointer, _ index: Int32) -> String {
        switch sqlite3_column_type(stmt, index) {
        case SQLITE_TEXT:
            guard let c = sqlite3_column_text(stmt, index) else { return "" }
            return String(cString: c)
        case SQLITE_BLOB:
            guard let raw = sqlite3_column_blob(stmt, index) else { return "" }
            let n = Int(sqlite3_column_bytes(stmt, index))
            let data = Data(bytes: raw, count: n)
            return String(data: data, encoding: .utf8) ?? ""
        case SQLITE_INTEGER:
            return String(sqlite3_column_int64(stmt, index))
        default:
            return ""
        }
    }

    /// Last ten digits, which is the most two forms of a US number can be
    /// relied on to share. Anything shorter is left alone rather than
    /// padded into a false match.
    ///
    /// The extension is cut off first, and that is not cosmetic. We store
    /// dialled numbers as "+16145550134;ext=231", and running that
    /// through a naive digit filter yields 4550134231 — a plausible ten
    /// digits belonging to nobody, which matches no call and fails
    /// silently by looking like the store simply was not rung.
    static func lastTen(_ s: String) -> String {
        let trunk = s.split(separator: ";").first.map(String.init) ?? s
        let digits = trunk.filter(\.isNumber)
        return digits.count >= 10 ? String(digits.suffix(10)) : ""
    }
}
