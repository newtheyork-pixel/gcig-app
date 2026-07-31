import Foundation
import AppKit

// The Griffin Fund volume in Finder's Locations.
//
// Three mechanisms were tried and the difference between them is the
// whole story of why this looks the way it does.
//
//   A synced FOLDER cannot work: a folder dragged to the sidebar lands in
//   Favorites, and Locations holds volumes and File Providers only.
//
//   WEBDAV mounts, and the files were live, but Finder labels a WebDAV
//   sidebar entry with the SERVER rather than the share — so it read
//   "127.0.0.1" however the share was named, and pointing it at the
//   Bonjour host only changed that to "Thomass-MacBook-Pro". Serving it
//   from the API was impossible anyway: Cloudflare rejects PROPFIND at
//   the edge, measured as a 405 carrying its own headers and none of
//   ours.
//
//   A DISK IMAGE is labelled with its VOLUME name, which is the thing
//   being asked for. Sparse, so a 30GB ceiling costs 31MB until something
//   is written, and the sync engine fills it.
//
// What it is not, still: a File Provider. There are no download-on-demand
// placeholders, so a file exists locally or not at all. That needs an App
// Group entitlement, which needs an Apple ID in a working Xcode.
@MainActor
final class GriffinVolume: ObservableObject {
    static let shared = GriffinVolume()

    struct State {
        var mounted = false
        var error: String?
    }

    @Published private(set) var state = State()

    // Nonisolated: the sync engine reads these off the main actor, and a
    // constant path has no state to protect.
    nonisolated static let volumeName = "Griffin Fund"
    nonisolated static var mountPoint: URL { URL(fileURLWithPath: "/Volumes/\(volumeName)") }

    private var image: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Griffin Terminal/GriffinFund.sparsebundle")
    }

    /// Mount and start syncing. Safe to call when already mounted, which
    /// is what makes it usable as one button that also means "show me the
    /// folder".
    func startAndMount() {
        if isMounted {
            state.mounted = true
            GriffinDrive.shared.startAll()
            reveal()
            return
        }
        do {
            if !FileManager.default.fileExists(atPath: image.path) { try create() }
            try attach()
            state.mounted = true
            state.error = nil
            GriffinDrive.shared.startAll()
            reveal()
        } catch {
            state.error = error.localizedDescription
            state.mounted = false
        }
    }

    /// Mount silently at launch if the image already exists. Somebody who
    /// set this up once should find the volume there, not a button they
    /// press every morning.
    func mountIfPrepared() {
        guard FileManager.default.fileExists(atPath: image.path) else { return }
        if !isMounted { try? attach() }
        state.mounted = isMounted
        if state.mounted { GriffinDrive.shared.startAll() }
    }

    var isMounted: Bool {
        var isDir: ObjCBool = false
        let there = FileManager.default.fileExists(atPath: Self.mountPoint.path, isDirectory: &isDir)
        return there && isDir.boolValue
    }

    func reveal() {
        NSWorkspace.shared.activateFileViewerSelecting([Self.mountPoint])
    }

    func unmount() {
        GriffinDrive.shared.stop()
        run("/usr/sbin/diskutil", ["unmount", Self.mountPoint.path])
        state.mounted = false
    }

    // MARK: The image

    private func create() throws {
        try FileManager.default.createDirectory(
            at: image.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Sparse: the ceiling is a maximum, not an allocation. APFS
        // because the research filenames include characters the older
        // filesystems mangle, and 30GB because the Lindt project alone is
        // gigabytes once its archives land.
        if !run("/usr/bin/hdiutil", [
            "create", "-size", "30g", "-type", "SPARSEBUNDLE", "-fs", "APFS",
            "-volname", Self.volumeName, "-quiet", image.path,
        ]) { throw Failure.create }
    }

    private func attach() throws {
        if !run("/usr/bin/hdiutil", ["attach", image.path, "-quiet"]) || !isMounted {
            throw Failure.attach
        }
    }

    @discardableResult
    private func run(_ tool: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardError = Pipe()
        p.standardOutput = Pipe()
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }

    enum Failure: LocalizedError {
        case create, attach
        var errorDescription: String? {
            switch self {
            case .create: return "Could not create the Griffin Fund volume."
            case .attach: return "Could not mount the Griffin Fund volume."
            }
        }
    }
}
