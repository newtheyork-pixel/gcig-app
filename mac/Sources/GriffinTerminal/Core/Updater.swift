import Foundation
import AppKit

// Keeping every member on the current build without anyone thinking
// about it.
//
// The app is handed out as a zip. Without this, a fix reaches whoever
// happens to download again, which in practice is the person who
// reported the bug and nobody else — so the club runs four different
// terminals and every report has to start by establishing which one.
//
// THE HASH IS THE WHOLE SECURITY MODEL, and it is checked before
// anything is replaced. An updater that installs whatever answers a URL
// is a remote-code-execution hole with a friendly button on it: whoever
// controls that host, or anyone able to sit between us and it, owns
// every machine that has the app open. The digest comes from our own API
// over TLS and the download must match it byte for byte.
//
// Nothing is ever installed silently. The swap happens when somebody
// presses the button, because an app that replaces itself underneath a
// half-typed order is worse than an app one version behind.
@MainActor
final class Updater: ObservableObject {
    static let shared = Updater()

    struct Release: Decodable {
        let available: Bool?
        let version: String?
        let url: String?
        let sha256: String?
        let bytes: Int?
        let notes: String?
        let mandatory: Bool?
    }

    enum Phase: Equatable {
        case idle
        case checking
        case available(Release2)
        case downloading(Double)
        case ready(URL, String)     // staged bundle, version
        case failed(String)

        /// A trimmed copy so Phase can be Equatable without dragging the
        /// whole payload into every comparison.
        struct Release2: Equatable {
            let version: String
            let notes: String?
            let mandatory: Bool
        }
    }

    @Published private(set) var phase: Phase = .idle

    var installed: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    private var timer: Task<Void, Never>?

    /// Check on launch and hourly after. Hourly rather than every few
    /// minutes because a build lands once a week at most, and a request
    /// nobody needs is still a request somebody's laptop made on a train.
    func start() {
        // A swap that failed after the app quit had no one left to report
        // it — the member pressed RESTART, the app closed, and the old
        // version came back with no explanation. The install script
        // leaves a note on failure; deliver it now.
        if let note = Self.consumeFailureMarker() {
            phase = .failed(note)
        }
        timer?.cancel()
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check()
                try? await Task.sleep(for: .seconds(3600))
            }
        }
    }

    func check() async {
        if case .downloading = phase { return }
        // A failure notice stays up until the member dismisses it —
        // being replaced by the same UPDATE chip that just failed would
        // erase the only explanation they get.
        if case .failed = phase { return }
        // A staged build is NOT a reason to stop looking. It used to
        // be: once somebody pressed UPDATE, the download was pinned and
        // the hourly check stood down, so a release published minutes
        // later stayed invisible until they had restarted into the old
        // one — a member two versions behind climbed the ladder one
        // rung per restart. The staged copy is remembered so a newer
        // offer can supersede it below.
        var staged: (url: URL, version: String)?
        if case .ready(let u, let v) = phase { staged = (u, v) }

        if staged == nil { phase = .checking }
        do {
            let data = try await API.shared.get("/app/latest", query: ["current": installed])
            let r = try await API.shared.decode(Release.self, from: data)
            guard r.available == true, let v = r.version, r.url != nil, r.sha256 != nil else {
                if staged == nil { phase = .idle }
                return
            }
            if let s = staged {
                if s.version == v { return } // RESTART already points at the newest
                // Superseded mid-wait: throw the old download away and
                // stage the new one. The member asked to update; giving
                // them yesterday's update instead of today's would honor
                // the button and betray the intent. Still nothing
                // installs without the RESTART press.
                try? FileManager.default.removeItem(at: s.url)
            }
            pending = r
            phase = .available(.init(version: v, notes: r.notes, mandatory: r.mandatory ?? false))
            if staged != nil { await download() }
        } catch {
            // A failed check is not worth a banner. The app works; it is
            // simply not certain it is current, and saying so every hour
            // would train people to ignore the one time it matters.
            if staged == nil { phase = .idle }
        }
    }

    private var pending: Release?

    /// Download, verify, and stage. Does NOT install — that needs a press.
    func download() async {
        guard let r = pending, let urlStr = r.url, let url = URL(string: urlStr),
              let want = r.sha256?.lowercased() else { return }
        phase = .downloading(0)
        do {
            // Carries the session token, because the build is served
            // members-only from our own API rather than from a public
            // bucket. An anonymous download would 401, and the updater
            // would report a broken release rather than a missing login.
            var req = URLRequest(url: url)
            let origin = await API.shared.origin
            if urlStr.hasPrefix(origin),
               let authed = await API.shared.authorizedRequest(String(urlStr.dropFirst(origin.count))) {
                req = authed
            }
            let (tmp, response) = try await URLSession.shared.download(for: req)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                throw NSError(domain: "update", code: http.statusCode,
                              userInfo: [NSLocalizedDescriptionKey: "download returned \(http.statusCode)"])
            }
            let got = try Self.sha256(of: tmp)
            guard got == want else {
                // Refuse and say why. A mismatch is either a corrupted
                // download or someone substituting the file, and the app
                // cannot tell which — so it treats both as hostile.
                try? FileManager.default.removeItem(at: tmp)
                phase = .failed("Download did not match its checksum. Nothing was installed.")
                return
            }
            let staged = try Self.unzip(tmp)
            // The bundle we are about to offer must BE the release we
            // announced. A wrong artifact behind the right URL should
            // fail here, with both numbers, not after the swap.
            let plist = staged.appendingPathComponent("Contents/Info.plist")
            let stagedVersion =
                NSDictionary(contentsOf: plist)?["CFBundleShortVersionString"] as? String
            guard stagedVersion == r.version else {
                try? FileManager.default.removeItem(at: staged)
                phase = .failed(
                    "The download reports version \(stagedVersion ?? "unknown"), not \(r.version ?? "?"). Nothing was installed.")
                return
            }
            phase = .ready(staged, r.version ?? "")
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Replace the running app and relaunch it.
    ///
    /// A process cannot delete its own bundle out from under itself and
    /// keep running, so the swap is handed to a detached shell that waits
    /// for this process to exit first. The old bundle is moved aside
    /// rather than deleted until the new one is in place, so a failure
    /// halfway leaves a working app rather than a hole.
    func installAndRestart() {
        guard case .ready(let staged, _) = phase else { return }
        // Swap the app where it actually LIVES, not where Gatekeeper ran
        // it from. A quarantined app opened straight from Downloads runs
        // as a read-only translocated copy under $TMPDIR/AppTranslocation
        // — every mv against that mount fails, the app quits, and the
        // member reopens the untouched old version wondering why RESTART
        // did nothing. That was 0.2.1's launch day.
        let current = Self.originalBundleURL()
        if current.path.contains("/AppTranslocation/") {
            // The resolver could not find the real bundle. Say what to
            // do rather than pretend a doomed swap might work.
            phase = .failed(
                "macOS is running this copy from a protected location. Drag Griffin Terminal into your Applications folder, reopen it, and update again.")
            return
        }
        let backup = current.deletingLastPathComponent()
            .appendingPathComponent(".GriffinTerminal.previous")

        // Paths travel as argv, never spliced into the script text — a
        // quote in a folder name must not become shell syntax. On any
        // failure the script writes one line to the marker file, which
        // the next launch reports (see start()).
        let script = """
        rm -f "$5"
        while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
        rm -rf "$3"
        if ! mv "$2" "$3"; then
          echo "the old app could not be moved aside ($2)" > "$5"
          exit 1
        fi
        if ! mv "$4" "$2"; then
          rm -rf "$2"
          if ! mv "$3" "$2"; then
            echo "the update failed and the previous version is at $3 — drag it back by hand" > "$5"
            exit 1
          fi
          echo "the new app could not be put in place; the previous version was restored" > "$5"
          exit 1
        fi
        rm -rf "$3"
        xattr -dr com.apple.quarantine "$2" 2>/dev/null
        open "$2"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [
            "-c", script, "sh",
            String(getpid()), current.path, backup.path, staged.path,
            Self.failureMarkerURL.path,
        ]
        try? p.run()
        NSApp.terminate(nil)
    }

    /// The bundle's real on-disk location. When the running copy is a
    /// Gatekeeper translocation, the original path comes back from the
    /// Security framework's resolver; the two symbols are SPI, so they
    /// are looked up at runtime and a miss degrades to the translocated
    /// URL, which installAndRestart refuses with instructions instead of
    /// failing silently.
    private static func originalBundleURL() -> URL {
        let url = Bundle.main.bundleURL
        guard url.path.contains("/AppTranslocation/") else { return url }
        typealias CreateOriginal = @convention(c) (
            CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?
        ) -> Unmanaged<CFURL>?
        guard
            let handle = dlopen(
                "/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
            let sym = dlsym(handle, "SecTranslocateCreateOriginalPathForURL")
        else { return url }
        let fn = unsafeBitCast(sym, to: CreateOriginal.self)
        guard let orig = fn(url as CFURL, nil)?.takeRetainedValue() else { return url }
        return orig as URL
    }

    /// Where the install script leaves its one-line failure note.
    private static var failureMarkerURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("Griffin Terminal", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("update-failed.note")
    }

    private static func consumeFailureMarker() -> String? {
        let url = failureMarkerURL
        guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        try? FileManager.default.removeItem(at: url)
        let note = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return note.isEmpty ? nil : "The last update did not install: \(note)."
    }

    func dismiss() { phase = .idle }

    // MARK: Plumbing

    private static func sha256(of file: URL) throws -> String {
        // Shelling out to keep CryptoKit out of the dependency surface
        // for one call, and because the output is the same string the
        // release script prints.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/shasum")
        p.arguments = ["-a", "256", file.path]
        let pipe = Pipe()
        p.standardOutput = pipe
        try p.run()
        p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return out.split(separator: " ").first.map(String.init)?.lowercased() ?? ""
    }

    private static func unzip(_ zip: URL) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("griffin-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", zip.path, dir.path]
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw NSError(domain: "update", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "could not expand the download"])
        }
        let apps = (try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "app" }
        guard let app = apps.first else {
            throw NSError(domain: "update", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "no app inside the download"])
        }
        return app
    }
}
