import Foundation

// Why the app felt slow, and it was never the network.
//
// Nothing was persisted. Every cold launch began at `.loading` with an empty
// screen and a spinner, and the first request of the morning wakes a sleeping
// Render dyno, so the honest measure of "how long until the member sees the
// book" was however long the dyno took to get out of bed — thirty seconds is
// normal and the retry ladder in Core.swift exists because of it. A phone is
// opened for four seconds at a time. An app that shows nothing for thirty is
// an app nobody opens twice.
//
// So: the last good payload for a screen is written to disk, and the next
// launch renders it INSTANTLY while the refresh happens behind it. The screen
// is populated in the time it takes to read a file, and the numbers correct
// themselves a moment later under a strip that says how old they were.
//
// This deliberately reintroduces something Core.swift went to trouble to
// remove, so the difference matters. `URLSession.shared`'s cache was disabled
// because it stored whole HTTP RESPONSES — headers included — and replaying a
// cached response replays its `X-New-Token`, which is the mechanism that
// deleted the Mac client's own session at launch. This stores response BODIES
// only, keyed by path, never consulted by the transport layer, and never able
// to hand a stale credential to anything.
//
// The other reason that cache was disabled still applies in full: this is the
// club's book — positions, cost, cash, members' names — on a device that gets
// lost. So every file is written with complete protection (unreadable while
// the phone is locked, which is the state a lost phone is in), it lives in
// Application Support rather than anywhere a backup or a file browser reaches
// casually, and signing out deletes all of it.
enum Cache {

    /// One directory, created lazily. Application Support rather than Caches:
    /// the system evicts Caches under pressure, and a book that vanishes
    /// because the phone needed room is a screen that goes blank for no reason
    /// the member can see.
    private static let dir: URL? = {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                                  in: .userDomainMask).first else { return nil }
        let d = base.appendingPathComponent("GriffinCache", isDirectory: true)
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true,
                                                     attributes: [.protectionKey: FileProtectionType.complete])
        }
        return d
    }()

    /// A path becomes a filename. Percent-encoding rather than a hash so the
    /// directory is legible when something goes wrong at 2am, and so a stale
    /// entry can be reasoned about instead of guessed at.
    private static func file(for path: String) -> URL? {
        let safe = path.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        guard !safe.isEmpty else { return nil }
        return dir?.appendingPathComponent(safe + ".json")
    }

    static func write(_ data: Data, for path: String) {
        guard let f = file(for: path) else { return }
        // Atomic so a kill mid-write cannot leave a truncated file that then
        // fails to decode forever, which would look exactly like a screen
        // that has simply stopped working.
        try? data.write(to: f, options: [.atomic, .completeFileProtection])
    }

    /// The cached value and WHEN it was stored, because a value with no age is
    /// the thing this whole codebase refuses to show. The caller renders it
    /// through `.loaded(v, at:)`, so `aged(after:)` puts the stale strip up on
    /// its own once the clock says so.
    static func read<T: Decodable>(_ path: String, as type: T.Type) -> (T, Date)? {
        guard let f = file(for: path),
              let data = try? Data(contentsOf: f),
              let value = try? JSONDecoder().decode(T.self, from: data)
        else { return nil }
        let at = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? Date.distantPast
        return (value, at)
    }

    /// Called on sign-out. The token leaves the keychain in the same breath;
    /// leaving the book on disk behind it would make the sign-out cosmetic.
    static func clear() {
        guard let dir else { return }
        try? FileManager.default.removeItem(at: dir)
    }
}
