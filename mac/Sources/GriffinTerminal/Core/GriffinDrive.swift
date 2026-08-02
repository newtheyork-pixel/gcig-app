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
        // Once the index exists, and not only when a file happens to
        // change. Something dragged to the Trash while the app was shut
        // fires no filesystem event on the next launch, so without this
        // the gesture is simply lost — which is the bug this feature was
        // written to fix, reappearing one restart later.
        sweepTrash()
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
        // Before the early return. A trash is a REMOVAL from the tree, so
        // nothing about it shows up as a changed file — checking it after
        // the "nothing changed" guard would mean the sweep only ever ran
        // when something else happened to be saved at the same moment.
        sweepTrash()
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

    /// Artifact id keyed by the path AS IT SITS ON THE VOLUME —
    /// "LISN/filings/complaint.pdf", ticker folder included.
    ///
    /// `remoteIdByPath` cannot serve this. It is keyed by the artifact
    /// title, which is the path WITHIN a project, so two projects each
    /// holding a "model.xlsx" collide and the last pull silently wins.
    /// Guessing wrong here does not render a stale row, it trashes
    /// somebody else's document.
    private var artifactIdByVolumePath: [String: Int] = [:]

    /// Trash entries already acted on, so a sweep that runs on every
    /// filesystem event does not re-post the same deletion. Keyed by the
    /// trashed path, because the file stays in the Trash until the user
    /// empties it and would otherwise be seen forever.
    private var trashHandled: Set<String> = []

    private func pull() async {
        guard let pid = projectId, let base = root else { return }
        struct Wrap: Decodable {
            let artifacts: [Row]?
            struct Row: Decodable { let id: Int; let title: String; let fileRef: String? }
        }
        guard let data = try? await API.shared.get("/research/projects/\(pid)"),
              let w = try? await API.shared.decode(Wrap.self, from: data) else { return }

        // The shape first, the bytes after.
        //
        // Two hundred files fetched one at a time is minutes of an empty
        // folder, which reads as broken rather than busy — it is what
        // Thomas saw. Creating every directory up front costs
        // milliseconds and means opening the volume shows the whole
        // project immediately, with files filling in underneath.
        var wanted: [(row: Wrap.Row, item: String, dest: URL)] = []
        for row in w.artifacts ?? [] {
            guard let item = DocumentViewer.itemId(from: row.fileRef) else { continue }
            remoteIdByPath[row.title] = row.id
            artifactIdByVolumePath["\(base.lastPathComponent)/\(row.title)"] = row.id
            let dest = base.appendingPathComponent(row.title)
            try? FileManager.default.createDirectory(
                at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: dest.path) { continue }
            wanted.append((row, item, dest))
        }
        // Before the early return, not after it. Reconciling only when
        // something was downloaded meant a pure rename — where every
        // file already exists under its new name and nothing needs
        // fetching — skipped the cleanup entirely, which is why the old
        // copies survived the CHRW filing.
        let titles = Set((w.artifacts ?? []).map(\.title))
        reconcile(base: base, against: titles)
        guard !wanted.isEmpty else { return }

        status.pending = wanted.count
        // Six at a time. Each fetch is our API waking OneDrive, so serial
        // is dominated by latency rather than bandwidth; unbounded would
        // open two hundred sockets and have Render rate-limit us.
        var pulled = 0
        var index = 0
        await withTaskGroup(of: (String, Int)?.self) { group in
            func submit() {
                guard index < wanted.count else { return }
                let job = wanted[index]
                index += 1
                group.addTask {
                    guard let bytes = try? await API.shared.get("/files/\(Self.escape(job.item))") else { return nil }
                    do {
                        try bytes.write(to: job.dest, options: .atomic)
                        return (job.row.title, bytes.count)
                    } catch { return nil }
                }
            }
            for _ in 0..<min(6, wanted.count) { submit() }
            while let done = await group.next() {
                if let (title, size) = done {
                    // Recorded before the watcher can see it, or our own
                    // download is read back as a local edit and pushed
                    // straight up again.
                    known[title] = size
                    pulled += 1
                    status.pending = max(0, wanted.count - pulled)
                }
                submit()
            }
        }
        status.pending = 0
        if pulled > 0 { status.lastPull = "\(pulled) file\(pulled == 1 ? "" : "s") at \(Fmt.localStamp())" }
    }

    /// Remove local files the project no longer has.
    ///
    /// "Never delete" was the rule and it was right in one direction
    /// only. A file disappearing from the volume is usually a move or a
    /// Finder accident, so a local deletion must not delete the artifact.
    /// But a rename on the SERVER is a delete-and-add from the volume's
    /// point of view, and without this every rename left the old copy
    /// behind — filing twenty-three CHRW artifacts into folders produced
    /// twenty-three duplicates sitting loose beside them.
    ///
    /// The safety is the age check. Anything touched in the last two
    /// minutes is left alone, because a file somebody has just dropped in
    /// has not been uploaded yet and is not in the artifact list either —
    /// deleting it would eat their work between the drop and the push.
    private func reconcile(base: URL, against titles: Set<String>) {
        let cutoff = Date().addingTimeInterval(-120)
        for (path, _) in Self.walk(base) where !titles.contains(path) {
            let url = base.appendingPathComponent(path)
            let name = (path as NSString).lastPathComponent
            if name.hasPrefix(".") || name.hasPrefix("~$") { continue }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? Date()
            guard modified < cutoff else { continue }
            try? FileManager.default.removeItem(at: url)
            known[path] = nil
        }
        // Directories a rename emptied. Only empty ones, and only inside
        // this project, so nothing a person made by hand is swept up.
        if let e = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey]) {
            let dirs = (e.allObjects as? [URL] ?? []).filter {
                (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            }
            for dir in dirs.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) {
                let kids = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
                if kids.filter({ !$0.hasPrefix(".") }).isEmpty {
                    try? FileManager.default.removeItem(at: dir)
                }
            }
        }
    }


    // MARK: The Trash

    /// A file dragged to the Trash is the one deletion we believe.
    ///
    /// The engine's founding rule is that nothing is ever deleted,
    /// because a file vanishing from a watched folder is usually a move,
    /// a rename, or a Finder accident. That rule is right, and it made
    /// the volume feel broken: dragging a document to the Trash left it
    /// sitting on the page in the terminal, and the next pull downloaded
    /// it straight back.
    ///
    /// Trashing is different from vanishing, and macOS tells us which is
    /// which. A file removed from a mounted volume goes to
    /// `.Trashes/<uid>/` ON THAT VOLUME, so its presence there is an
    /// explicit gesture and not an inference from absence. Nothing is
    /// guessed from a diff — which matters, because `known` is keyed
    /// inconsistently between push and pull and a diff would read half
    /// the project as deleted.
    ///
    /// Everything here fails toward keeping the file. An ambiguous match
    /// does nothing, an unreadable Trash does nothing, and the removal
    /// is soft on the server anyway.
    private func sweepTrash() {
        let vol = GriffinVolume.mountPoint
        let bin = vol.appendingPathComponent(".Trashes/\(getuid())", isDirectory: true)
        guard FileManager.default.fileExists(atPath: bin.path) else { return }

        // Every path inside the Trash, relative to it. A trashed FOLDER
        // arrives as one entry with its contents intact, so the tree is
        // walked rather than listed: dragging a folder of filings should
        // remove the filings.
        var suffixes: [String] = []
        let fm = FileManager.default
        for entry in (try? fm.contentsOfDirectory(atPath: bin.path)) ?? [] {
            if entry.hasPrefix(".") { continue }
            let url = bin.appendingPathComponent(entry)
            var isDir: ObjCBool = false
            fm.fileExists(atPath: url.path, isDirectory: &isDir)
            if isDir.boolValue {
                for (rel, _) in Self.walk(url) { suffixes.append("\(entry)/\(rel)") }
            } else {
                suffixes.append(entry)
            }
        }
        guard !suffixes.isEmpty else { return }

        for suffix in suffixes {
            guard !trashHandled.contains(suffix) else { continue }
            // Match on the tail of the volume path. The Trash is flat at
            // its top level, so "complaint.pdf" has lost the project
            // folder that would have identified it.
            let hits = Self.candidates(for: suffix, in: artifactIdByVolumePath)
            // Exactly one, or nothing. Two projects holding a file of the
            // same name is the case this guard exists for: removing the
            // wrong club's evidence is far worse than leaving a row on a
            // page, and the person can always remove it in the app.
            guard hits.count == 1, let (path, id) = hits.first else {
                if hits.count > 1 {
                    status.error = "\(suffix) matches \(hits.count) documents; remove it in the app instead"
                }
                continue
            }
            trashHandled.insert(suffix)
            Task { await self.trashRemotely(id: id, volumePath: path, suffix: suffix) }
        }
    }

    /// Which artifacts could this trashed path be?
    ///
    /// Split out and made static because it is the one piece here whose
    /// bugs are destructive rather than cosmetic, and because the whole
    /// safety of the feature rests on it returning MORE than one result
    /// when it is not sure.
    nonisolated static func candidates(for suffix: String, in index: [String: Int]) -> [(String, Int)] {
        let s = suffix.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return [] }
        return index
            // A path component boundary, never a bare string match:
            // "notes.pdf" must not match "meeting-notes.pdf", and
            // "model.xlsx" must not match "old/model.xlsx.bak".
            .filter { $0.key == s || $0.key.hasSuffix("/" + s) }
            .map { ($0.key, $0.value) }
    }

    private func trashRemotely(id: Int, volumePath: String, suffix: String) async {
        do {
            _ = try await API.shared.post("/research/artifacts/\(id)/trash", json: [:])
            artifactIdByVolumePath[volumePath] = nil
            // The title is the path within the project, which is the
            // volume path minus its ticker folder.
            let title = volumePath.split(separator: "/").dropFirst().joined(separator: "/")
            remoteIdByPath[title] = nil
            known[volumePath] = nil
            status.lastPush = "removed \((suffix as NSString).lastPathComponent) at \(Fmt.localStamp())"
        } catch {
            // Let it be retried on the next event rather than pretending
            // it worked — the file is still in the Trash, so the gesture
            // is still there to read.
            trashHandled.remove(suffix)
            status.error = "could not remove \(suffix): \(error.localizedDescription)"
        }
    }

    // MARK: Helpers

    nonisolated static func escape(_ s: String) -> String {
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
