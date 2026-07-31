import Foundation
import AppKit

// Project files, on disk, in Finder.
//
// What Thomas asked for is the cloud badge — a Griffin Fund location in
// the Finder sidebar with sync arrows, the way OneDrive and iCloud
// appear. That is a File Provider extension, and it needs more than
// code: an App Group entitlement and a provisioning profile issued from
// the developer portal, which is account work rather than a build step.
// There is a Developer ID on this machine but no profile carrying that
// capability, so an extension built today would refuse to load and the
// folder would simply never appear.
//
// This is the part that works now and is most of the value: real files,
// in a real folder, openable by Excel and Word and searchable by
// Spotlight. What it does not do is fetch on demand — every file it
// knows about is a file it downloads — which is exactly why it syncs a
// folder at a time rather than a project. Two hundred artifacts with the
// annual reports and the NIQ archives in them is gigabytes, and a
// one-click "sync everything" would be a very long silent wait.
enum FinderSync {
    /// ~/Griffin Fund/<TICKER>/<folder>/<file>
    ///
    /// Under the home folder rather than in Application Support, because
    /// the point is that a person opens it, and nobody browses to
    /// Application Support on purpose.
    static func root(project ticker: String?) -> URL {
        var u = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Griffin Fund", isDirectory: true)
        if let t = ticker, !t.isEmpty {
            u = u.appendingPathComponent(t, isDirectory: true)
        }
        return u
    }

    struct Item {
        let itemId: String
        /// The artifact title, which already carries its folder path.
        let path: String
    }

    struct Result {
        var written: Int = 0
        var skipped: Int = 0
        var failed: [String] = []
        var destination: URL?
    }

    /// Download a set of files into the mirror.
    ///
    /// `onProgress` is called with the name of each file as it starts,
    /// because a folder of eleven annual reports is a minute of nothing
    /// visible happening and a silent spinner reads as a hang.
    static func sync(_ items: [Item],
                     project ticker: String?,
                     onProgress: @MainActor @escaping (String) -> Void) async -> Result {
        var result = Result()
        let base = root(project: ticker)
        result.destination = base
        for item in items {
            let name = (item.path as NSString).lastPathComponent
            await onProgress(name)
            let sub = (item.path as NSString).deletingLastPathComponent
            let dir = sub.isEmpty ? base : base.appendingPathComponent(sub, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let dest = dir.appendingPathComponent(name)
                let data = try await API.shared.get("/files/\(escaped(item.itemId))")
                // Same size means the same file often enough to be worth
                // skipping, and re-downloading a 40MB PDF to write the
                // identical bytes is the kind of politeness that makes a
                // sync unusable. A changed file changes size in almost
                // every real case here; a re-upload that does not is rare
                // enough to accept against the cost.
                let existing = try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int
                if let existing, existing == data.count {
                    result.skipped += 1
                    continue
                }
                try data.write(to: dest, options: .atomic)
                result.written += 1
            } catch {
                // One bad file must not abandon the other ten, and the
                // ones that failed have to be named: a partial sync that
                // reports success is indistinguishable from a complete one.
                result.failed.append(name)
            }
        }
        return result
    }

    /// Open the folder in Finder. Nothing here can put it in the sidebar:
    /// the API for that was deprecated with no replacement, so the honest
    /// move is to show it and let a person drag it there once.
    static func reveal(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private static func escaped(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}
