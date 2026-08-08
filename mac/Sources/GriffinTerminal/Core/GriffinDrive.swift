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
                try? await Task.sleep(for: .seconds(12))
            }
        }
        status.running = true
    }

    /// Ticker → project id, so a change under LISN/ knows where to go.
    private var projectByTicker: [String: Int] = [:]

    /// Fingerprint per project, as last pulled. A project whose count
    /// and high-water mark both match is a project with nothing to
    /// fetch, and skipping it is the whole reason this can run often.
    private var seen: [Int: String] = [:]

    private func pullAll() async {
        struct P: Decodable {
            let id: Int; let ticker: String?
            let artifacts: Int?; let stamp: String?
            /// Count AND timestamp. The timestamp alone misses a
            /// removal; the count alone misses an edit in place.
            var fingerprint: String { "\(artifacts ?? -1)@\(stamp ?? "")" }
        }
        guard let data = try? await API.shared.get("/research/projects/manifest") else { return }
        let list = (try? await API.shared.decode([P].self, from: data)) ?? []
        for p in list {
            guard let t = p.ticker, !t.isEmpty else { continue }
            projectByTicker[t.uppercased()] = p.id
            // Unchanged since the last cycle: do not spend a request, and
            // more importantly do not spend the 300KB.
            if seen[p.id] == p.fingerprint { continue }
            projectId = p.id
            ticker = t
            // Recorded only on a complete pull. The comment used to say
            // "a failed fetch is retried next cycle" while the code
            // stamped the fingerprint unconditionally — a transient
            // failure skipped the project until the server changed again.
            if await pull() {
                seen[p.id] = p.fingerprint
            }
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
                try? await Task.sleep(for: .seconds(12))
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

    /// Disk names that extend a bare artifact title with a sniffed
    /// extension ("Reports/Anglo" → "Reports/Anglo.pdf"). Reconcile
    /// must treat these as the artifacts they are — without the alias
    /// set, the very file we just named correctly reads as unknown and
    /// gets swept to the Trash on the next cycle.
    private var extendedNames: Set<String> = []

    /// The extensions a sniff can produce, in the order the existence
    /// check probes them. Small on purpose: research artifacts are
    /// papers, decks, sheets and images.
    private static let SNIFF_EXTS = ["pdf", "xlsx", "docx", "pptx", "png", "jpg", "zip", "csv", "txt"]

    /// What the bytes say the file is. A title with no extension gets
    /// one from the CONTENT, because Finder identifies files by name
    /// and a real PDF called "Anglo American" renders as a "?" nobody
    /// can open.
    nonisolated static func sniffExtension(_ bytes: Data) -> String? {
        if bytes.starts(with: [0x25, 0x50, 0x44, 0x46]) { return "pdf" } // %PDF
        if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "png" }
        if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpg" }
        if bytes.starts(with: [0x50, 0x4B]) { // PK zip container
            // Office files are zips; telling them apart needs the
            // member list, which names the format in its first entries.
            let head = String(decoding: bytes.prefix(4096), as: UTF8.self)
            if head.contains("xl/") { return "xlsx" }
            if head.contains("word/") { return "docx" }
            if head.contains("ppt/") { return "pptx" }
            return "zip"
        }
        return nil
    }

    /// Trash entries already acted on, so a sweep that runs on every
    /// filesystem event does not re-post the same deletion. Keyed by the
    /// trashed path, because the file stays in the Trash until the user
    /// empties it and would otherwise be seen forever.
    private var trashHandled: Set<String> = []

    /// True when the project is fully mirrored; false when the fetch
    /// failed or any download was missed, so the caller retries next
    /// cycle instead of recording the fingerprint as done.
    @discardableResult
    private func pull() async -> Bool {
        guard let pid = projectId, let base = root else { return false }
        struct Wrap: Decodable {
            let artifacts: [Row]?
            struct Row: Decodable { let id: Int; let title: String; let fileRef: String? }
        }
        guard let data = try? await API.shared.get("/research/projects/\(pid)"),
              let w = try? await API.shared.decode(Wrap.self, from: data) else { return false }

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
            if FileManager.default.fileExists(atPath: dest.path) {
                // Heal an earlier pull that materialized a bare title:
                // read the head, name the file by its bytes, once. The
                // SIG reports sat as "?" icons for exactly this reason.
                if (row.title as NSString).pathExtension.isEmpty,
                   let fh = FileHandle(forReadingAtPath: dest.path),
                   let head = try? fh.read(upToCount: 4096),
                   let ext = Self.sniffExtension(head) {
                    try? fh.close()
                    let newDest = dest.appendingPathExtension(ext)
                    if !FileManager.default.fileExists(atPath: newDest.path),
                       (try? FileManager.default.moveItem(at: dest, to: newDest)) != nil {
                        let diskName = "\(row.title).\(ext)"
                        let volOld = "\(base.lastPathComponent)/\(row.title)"
                        let volNew = "\(base.lastPathComponent)/\(diskName)"
                        extendedNames.insert(diskName)
                        remoteIdByPath[diskName] = row.id
                        artifactIdByVolumePath[volNew] = row.id
                        if let sz = known.removeValue(forKey: volOld) {
                            known[volNew] = sz
                        }
                    }
                } else {
                    // fh may be open with no sniffable head; close it.
                }
                continue
            }
            // A bare title may live on disk under a sniffed extension
            // from an earlier pull; finding it under any candidate name
            // means it is already here.
            if (row.title as NSString).pathExtension.isEmpty {
                let hit = Self.SNIFF_EXTS.first { ext in
                    FileManager.default.fileExists(atPath: dest.path + "." + ext)
                }
                if let ext = hit {
                    let extended = "\(base.lastPathComponent)/\(row.title).\(ext)"
                    extendedNames.insert("\(row.title).\(ext)")
                    remoteIdByPath["\(row.title).\(ext)"] = row.id
                    artifactIdByVolumePath[extended] = row.id
                    continue
                }
            }
            wanted.append((row, item, dest))
        }
        // Before the early return, not after it. Reconciling only when
        // something was downloaded meant a pure rename — where every
        // file already exists under its new name and nothing needs
        // fetching — skipped the cleanup entirely, which is why the old
        // copies survived the CHRW filing.
        //
        // Which means the sweep runs while the downloads are still
        // queued, and it has to be told which directories are about to
        // be filled. Told nothing, it deletes the folders created a few
        // lines above as empty, the writes below land in a parent that
        // no longer exists, and the failure is swallowed — so the folder
        // does not come back on the next pull either. It is recreated,
        // swept and failed again, identically, forever. That is how the
        // CHRW project lost "3 Regulatory" and "4 Company filings", and
        // why they stayed lost.
        let titles = Set((w.artifacts ?? []).map(\.title)).union(extendedNames)
        let awaiting = Self.awaitingDirectories(for: wanted.map { $0.dest }, under: base)
        reconcile(base: base, against: titles, awaiting: awaiting)
        guard !wanted.isEmpty else { return true }

        status.pending = wanted.count
        // Six at a time. Each fetch is our API waking OneDrive, so serial
        // is dominated by latency rather than bandwidth; unbounded would
        // open two hundred sockets and have Render rate-limit us.
        var pulled = 0
        var index = 0
        await withTaskGroup(of: (String, String, Int, Int)?.self) { group in
            func submit() {
                guard index < wanted.count else { return }
                let job = wanted[index]
                index += 1
                group.addTask {
                    guard let bytes = try? await API.shared.get("/files/\(Self.escape(job.item))") else { return nil }
                    do {
                        // Remade rather than assumed. The directory was
                        // created before the sweep ran, and one syscall
                        // is a cheap price for never writing into a
                        // parent that went away in between.
                        try FileManager.default.createDirectory(
                            at: job.dest.deletingLastPathComponent(),
                            withIntermediateDirectories: true)
                        // A title with no extension gets one from the
                        // bytes. The SIG project's reports arrived as
                        // prose titles, materialized as extension-less
                        // files, and rendered as a folder of "?" icons
                        // no double-click could open — real PDFs the
                        // Finder had no way to recognize.
                        var dest = job.dest
                        var diskName = job.row.title
                        if (job.row.title as NSString).pathExtension.isEmpty,
                           let ext = Self.sniffExtension(bytes) {
                            dest = dest.appendingPathExtension(ext)
                            diskName = "\(job.row.title).\(ext)"
                        }
                        try bytes.write(to: dest, options: .atomic)
                        return (job.row.title, diskName, bytes.count, job.row.id)
                    } catch { return nil }
                }
            }
            for _ in 0..<min(6, wanted.count) { submit() }
            while let done = await group.next() {
                if let (title, diskName, size, rowId) = done {
                    // Recorded before the watcher can see it, or our own
                    // download is read back as a local edit and pushed
                    // straight up again. Volume-relative, matching what
                    // the watcher's walk produces — the bare title never
                    // matched, so every pull re-uploaded its own
                    // downloads and churned the whole club's sync.
                    known["\(base.lastPathComponent)/\(diskName)"] = size
                    if diskName != title {
                        // The alias set is what keeps reconcile's hands
                        // off the extended name, and the id maps are
                        // what keep an edit or a trash of it pointed at
                        // the artifact it is.
                        extendedNames.insert(diskName)
                        remoteIdByPath[diskName] = rowId
                        artifactIdByVolumePath["\(base.lastPathComponent)/\(diskName)"] = rowId
                    }
                    pulled += 1
                    status.pending = max(0, wanted.count - pulled)
                }
                submit()
            }
        }
        status.pending = 0
        if pulled > 0 { status.lastPull = "\(pulled) file\(pulled == 1 ? "" : "s") at \(Fmt.localStamp())" }
        // Downloads that fail say so. Silence here is what let two
        // missing folders read as a filing decision for a day rather
        // than as the bug they were.
        let missed = wanted.count - pulled
        if missed > 0 {
            status.error = "\(missed) file\(missed == 1 ? "" : "s") did not download; the next sync retries"
        }
        return missed == 0
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
    /// Three safeties, because the cost of getting this wrong is a
    /// member's only copy:
    ///
    /// 1. Only files the server has seen. `known` holds exactly the
    ///    paths that completed a push or arrived by pull, so a file
    ///    whose upload FAILED — over-limit, role-refused, a 500 — is not
    ///    in it and is never touched. The old age check keyed off mtime,
    ///    which a Finder drag-copy preserves, so a 2023 PDF dropped in
    ///    yesterday looked two years old and had no protection at all.
    /// 2. The age check stays, for the window between a drop and the
    ///    push recording it.
    /// 3. The Trash, never removeItem. A wrong call here must cost a
    ///    trip to the Trash, not the file.
    ///
    /// `awaiting` is the directories with a download still queued into
    /// them. They are on disk and hold nothing, which is indistinguishable
    /// from abandoned unless the caller says otherwise — and getting it
    /// wrong does not cost a redundant folder, it costs the files.
    private func reconcile(base: URL, against titles: Set<String>, awaiting: Set<String> = []) {
        let cutoff = Date().addingTimeInterval(-120)
        let project = base.lastPathComponent
        for (path, _) in Self.walk(base) where !titles.contains(path) {
            let url = base.appendingPathComponent(path)
            let name = (path as NSString).lastPathComponent
            if name.hasPrefix(".") || name.hasPrefix("~$") { continue }
            // walk(base) is project-relative here but known is keyed on
            // volume-relative paths; the unprefixed lookup matched
            // nothing, which is how the sync-state check was silently
            // absent from this path.
            let volKey = "\(project)/\(path)"
            guard known[volKey] != nil else { continue }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? Date()
            guard modified < cutoff else { continue }
            if (try? FileManager.default.trashItem(at: url, resultingItemURL: nil)) != nil {
                known[volKey] = nil
            }
        }
        // Directories a rename emptied. Only empty ones, only inside this
        // project, and only when they have stood empty past the same
        // two-minute window — a "New Folder" someone just made in Finder
        // must survive until they find the files to drag into it.
        if let e = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey]) {
            let dirs = (e.allObjects as? [URL] ?? []).filter {
                (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            }
            for dir in dirs.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) {
                let created = (try? dir.resourceValues(forKeys: [.creationDateKey]))?.creationDate
                    ?? Date()
                guard created < cutoff else { continue }
                let kids = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
                if Self.isSweepable(dir: dir.standardizedFileURL.path,
                                    children: kids, awaiting: awaiting) {
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
            let text = error.localizedDescription
            // A REFUSAL IS NOT A FAILURE, and retrying it is worse than
            // useless. The server now allows a member to remove only
            // what they uploaded; anything else needs a Portfolio
            // Manager. That answer will not change on the next
            // filesystem event, so retrying every few seconds would
            // hammer the API forever and bury the one message that
            // explains why the file came back.
            // Now that API.send lets 403 through as .http rather than
            // masking it as an expired session, the status code is the
            // reliable signal; the phrase matches stay as a belt for
            // refusals worded by older server builds.
            if case API.Failure.http(403, _) = error {
                status.error = "\((suffix as NSString).lastPathComponent): \(text)"
                return    // stays in trashHandled, so it is not tried again
            }
            if text.contains("403") || text.localizedCaseInsensitiveContains("Portfolio Manager")
                || text.localizedCaseInsensitiveContains("super admin") {
                status.error = "\((suffix as NSString).lastPathComponent): \(text)"
                return    // stays in trashHandled, so it is not tried again
            }
            trashHandled.remove(suffix)
            status.error = "could not remove \(suffix): \(text)"
        }
    }

    // MARK: Helpers

    /// Whether the sweep may remove a directory.
    ///
    /// Two ways to survive: hold something visible, or have something on
    /// its way in. The second is the one that was missing, and its
    /// absence is not a cosmetic bug — an emptied folder can never refill
    /// itself, because the pull that would refill it sweeps it first.
    nonisolated static func isSweepable(dir: String, children: [String],
                                        awaiting: Set<String>) -> Bool {
        guard !awaiting.contains(dir) else { return false }
        return children.filter { !$0.hasPrefix(".") }.isEmpty
    }

    /// Every directory on the way down to a queued download, so the sweep
    /// can tell "empty" from "not filled yet".
    ///
    /// Walks up to the project root rather than taking the immediate
    /// parent alone: an artifact titled "3 Regulatory/pocket guide"
    /// arriving into a project with nothing else in that folder leaves
    /// both the file's directory and every directory above it empty at
    /// the moment the sweep looks.
    nonisolated static func awaitingDirectories(for destinations: [URL],
                                                under base: URL) -> Set<String> {
        let root = base.standardizedFileURL.path
        var out: Set<String> = []
        for dest in destinations {
            var dir = dest.standardizedFileURL.deletingLastPathComponent()
            while dir.path != root, dir.path.hasPrefix(root + "/") {
                out.insert(dir.path)
                dir = dir.deletingLastPathComponent()
            }
        }
        return out
    }

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
