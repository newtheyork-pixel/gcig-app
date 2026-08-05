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
        if case .ready = phase { return }
        phase = .checking
        do {
            let data = try await API.shared.get("/app/latest", query: ["current": installed])
            let r = try await API.shared.decode(Release.self, from: data)
            guard r.available == true, let v = r.version, r.url != nil, r.sha256 != nil else {
                phase = .idle
                return
            }
            phase = .available(.init(version: v, notes: r.notes, mandatory: r.mandatory ?? false))
            pending = r
        } catch {
            // A failed check is not worth a banner. The app works; it is
            // simply not certain it is current, and saying so every hour
            // would train people to ignore the one time it matters.
            phase = .idle
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
        let current = Bundle.main.bundleURL
        let backup = current.deletingLastPathComponent()
            .appendingPathComponent(".GriffinTerminal.previous")

        let script = """
        while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done
        rm -rf '\(backup.path)'
        mv '\(current.path)' '\(backup.path)' || exit 1
        if ! mv '\(staged.path)' '\(current.path)'; then
          mv '\(backup.path)' '\(current.path)'
          exit 1
        fi
        rm -rf '\(backup.path)'
        xattr -dr com.apple.quarantine '\(current.path)' 2>/dev/null
        open '\(current.path)'
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        try? p.run()
        NSApp.terminate(nil)
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
