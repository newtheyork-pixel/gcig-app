import Foundation
import AppKit

// The Griffin Fund folder, kept in step with the project in both
// directions.
//
// What this is not, yet: the cloud icon in the Finder sidebar with
// download-on-demand placeholders. That is a File Provider extension and
// it needs an App Group entitlement and a provisioning profile, which
// need an Apple ID signed into Xcode. There is a Developer ID on this
// machine but no account in Xcode and no profiles on disk, so an
// extension built today would be refused at load and the location would
// never appear at all.
//
// What this IS: the sync engine underneath it. Put a file in the folder
// and it becomes an artifact everyone sees; change one and the change
// goes up; add one in the terminal and it appears on disk. When the
// entitlement exists, the File Provider becomes a presentation layer
// over exactly this, rather than a rewrite.
//
// Two rules that keep it honest:
//
//   Local edits are pushed, never merged. If a file changed on both
//   sides, the local write wins and the remote version is left in
//   OneDrive rather than deleted, because silently losing somebody's
//   edit is worse than keeping a file nobody opens.
//
//   Nothing is ever deleted from either side. A file vanishing from a
//   watched folder is far more often a move, a rename or a Finder
//   accident than an instruction to remove it from the project.
@MainActor
final class GriffinDrive: ObservableObject {
    static let shared = GriffinDrive()

    struct Status {
        var running = false
        var lastPush: String?
        var lastPull: String?
        var pending = 0
        var error: String?
    }

    @Published private(set) var status = Status()

    private var stream: FSEventStreamRef?
    private var poller: Task<Void, Never>?
    private var projectId: Int?
    private var ticker: String?
    /// Path → size, as last reconciled. A file whose size matches what we
    /// last saw is a file we have already dealt with, which is what stops
    /// our own downloads from being read back as local edits.
    private var known: [String: Int] = [:]
    private var pushing = false

    var root: URL? { ticker.map { FinderSync.root(project: $0) } }

    /// Begin watching one project. Idempotent: starting twice on the same
    /// project is a no-op rather than a second watcher racing the first.
    /// Watch the whole volume and keep every project in it. One watcher
    /// on the root rather than one per project: the first path component
    /// is the ticker, so a single tree tells us which project a change
    /// belongs to.
    func startAll() {
        guard !status.running else { return }
        let base = GriffinVolume.mountPoint
        guard FileManager.default.fileExists(atPath: base.path) else { return }
        seedKnown(base)
        startWatching(base)
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pullAll()
                try? await Task.sleep(for: .seconds(45))
            }
        }
        status.running = true
    }

    /// Ticker → project id, so a change under LISN/ knows where to go.
    private var projectByTicker: [String: Int] = [:]

    private func pullAll() async {
        struct P: Decodable { let id: Int; let ticker: String? }
        guard let data = try? await API.shared.get("/research/projects") else { return }
        let list = (try? await API.shared.decode([P].self, from: data)) ?? []
        for p in list {
            guard let t = p.ticker, !t.isEmpty else { continue }
            projectByTicker[t.uppercased()] = p.id
            projectId = p.id
            ticker = t
            await pull()
        }
    }

    func start(projectId: Int, ticker: String?) {
        guard self.projectId != projectId || !status.running else { return }
        stop()
        self.projectId = projectId
        self.ticker = ticker
        let base = FinderSync.root(project: ticker)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        seedKnown(base)
        startWatching(base)
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pull()
                try? await Task.sleep(for: .seconds(45))
            }
        }
        status.running = true
    }

    func stop() {
        if let s = stream {
            FSEventStreamStop(s)
            FSEventStreamInvalidate(s)
            FSEventStreamRelease(s)
            stream = nil
        }
        poller?.cancel()
        poller = nil
        status.running = false
    }

    // MARK: Local → remote

    /// Everything already on disk counts as reconciled at startup.
    /// Without this, the first scan reads every previously synced file as
    /// a brand new local addition and uploads the entire folder back.
    private func seedKnown(_ base: URL) {
        known = [:]
        for (path, size) in Self.walk(base) { known[path] = size }
    }

    private func startWatching(_ base: URL) {
        var ctx = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let me = Unmanaged<GriffinDrive>.fromOpaque(info).takeUnretainedValue()
            Task { @MainActor in me.scanAndPush() }
        }
        // A latency of one second coalesces a save that writes a temp file
        // and renames it — which is what Excel and Word both do — into a
        // single event instead of three.
        guard let s = FSEventStreamCreate(
            nil, callback, &ctx,
            [base.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            1.0,
            UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer))
        else { return }
        FSEventStreamSetDispatchQueue(s, DispatchQueue.main)
        FSEventStreamStart(s)
        stream = s
    }

    private func scanAndPush() {
        guard !pushing else { return }
        // The volume root, not one project's folder: a single watcher
        // covers every project and the first path segment says which.
        let base = GriffinVolume.mountPoint
        let current = Self.walk(base)
        let changed = current.filter { known[$0.key] != $0.value }
        guard !changed.isEmpty else { return }
        pushing = true
        status.pending = changed.count
        Task {
            var done = 0
            for (path, size) in changed {
                let url = base.appendingPathComponent(path)
                // Office writes a lock file beside the document while it
                // is open. Uploading ~$Model.xlsx would put junk in the
                // project that nobody could open.
                let name = (path as NSString).lastPathComponent
                if name.hasPrefix("~$") || name.hasPrefix(".") { known[path] = size; continue }
                // Strip the ticker segment: the artifact's title is the
                // path WITHIN its project, and storing LISN/model/x.xlsx
                // would nest every project inside itself on the next pull.
                let segs = path.split(separator: "/").map(String.init)
                guard segs.count >= 2, let pid = projectByTicker[segs[0].uppercased()] else {
                    known[path] = size
                    continue
                }
                let inProject = segs.dropFirst().joined(separator: "/")
                do {
                    try await push(url: url, path: inProject, projectId: pid)
                    known[path] = size
                    done += 1
                } catch {
                    status.error = "\(name): \(error.localizedDescription)"
                }
            }
            status.pending = 0
            if done > 0 { status.lastPush = "\(done) file\(done == 1 ? "" : "s") at \(Fmt.localStamp())" }
            pushing = false
        }
    }

    /// New file → a new artifact. Known file → replace its bytes, so one
    /// spreadsheet stays one row however many times it is saved.
    private func push(url: URL, path: String, projectId pid: Int) async throws {
        if let id = remoteIdByPath[path] {
            _ = try await API.shared.upload("/research/artifacts/\(id)/file", fileURL: url, fields: [:])
        } else {
            let data = try await API.shared.upload(
                "/research/projects/\(pid)/artifacts",
                fileURL: url,
                fields: ["title": path, "kind": Self.kind(for: url)])
            struct Made: Decodable { let id: Int }
            if let made = try? await API.shared.decode(Made.self, from: data) {
                remoteIdByPath[path] = made.id
            }
        }
    }

    // MARK: Remote → local

    private var remoteIdByPath: [String: Int] = [:]

    private func pull() async {
        guard let pid = projectId, let base = root else { return }
        struct Wrap: Decodable {
            let artifacts: [Row]?
            struct Row: Decodable { let id: Int; let title: String; let fileRef: String? }
        }
        guard let data = try? await API.shared.get("/research/projects/\(pid)"),
              let w = try? await API.shared.decode(Wrap.self, from: data) else { return }
        var pulled = 0
        for row in w.artifacts ?? [] {
            guard let item = DocumentViewer.itemId(from: row.fileRef) else { continue }
            remoteIdByPath[row.title] = row.id
            let dest = base.appendingPathComponent(row.title)
            if FileManager.default.fileExists(atPath: dest.path) { continue }
            do {
                try FileManager.default.createDirectory(
                    at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                let bytes = try await API.shared.get("/files/\(escaped(item))")
                try bytes.write(to: dest, options: .atomic)
                // Recorded before the watcher sees it, so our own write is
                // not read back as a local edit and pushed straight up
                // again — the loop that makes a naive two-way sync eat
                // itself.
                known[row.title] = bytes.count
                pulled += 1
            } catch {
                status.error = "pull \(row.title): \(error.localizedDescription)"
            }
        }
        if pulled > 0 { status.lastPull = "\(pulled) file\(pulled == 1 ? "" : "s") at \(Fmt.localStamp())" }
    }

    // MARK: Helpers

    private func escaped(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    static func kind(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "xlsx", "xls", "csv", "zip": return "data"
        case "png", "jpg", "jpeg", "heic", "gif": return "photo"
        case "docx", "doc", "md", "txt": return "memo"
        default: return "document"
        }
    }

    /// Relative path → size for every file under a root, skipping the
    /// noise a filesystem keeps to itself.
    static func walk(_ base: URL) -> [String: Int] {
        var out: [String: Int] = [:]
        let fm = FileManager.default
        guard let e = fm.enumerator(at: base, includingPropertiesForKeys: [.fileSizeKey, .isDirectoryKey],
                                    options: [.skipsHiddenFiles]) else { return out }
        for case let url as URL in e {
            let vals = try? url.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
            if vals?.isDirectory == true { continue }
            guard let size = vals?.fileSize else { continue }
            let rel = url.path.replacingOccurrences(of: base.path + "/", with: "")
            if rel.hasPrefix(".") || rel.contains("/.") { continue }
            out[rel] = size
        }
        return out
    }
}
