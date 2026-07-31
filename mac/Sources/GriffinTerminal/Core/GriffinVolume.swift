import Foundation
import Network
import AppKit

// The Griffin Fund volume: a WebDAV server on the loopback, mounted by
// Finder so the research files appear under Locations.
//
// Why it lives here and not on the API. Render sits behind Cloudflare and
// Cloudflare rejects PROPFIND at the edge — measured, a 405 carrying
// `server: cloudflare` and none of our own headers, while a GET on the
// same path arrives with helmet's headers attached. No amount of server
// code gets past that. A listener on 127.0.0.1 is never asked to.
//
// It also makes the thing genuinely one button. The app already holds the
// member's session token, so nobody types a credential, and every member
// gets the same behaviour from the same click rather than a setup guide.
//
// The trade, stated plainly: the volume exists while the app runs.
// Quitting the terminal unmounts it. The alternative is a File Provider
// extension, which survives quitting and does download-on-demand, and
// which needs an App Group entitlement this machine cannot currently
// produce.
@MainActor
final class GriffinVolume: ObservableObject {
    static let shared = GriffinVolume()

    struct State {
        var listening = false
        var mounted = false
        var port: UInt16 = 0
        var error: String?
    }

    @Published private(set) var state = State()

    private var listener: NWListener?
    /// Fresh every launch. The listener is loopback-only, but a machine
    /// has other users and other processes on it, and "only local" is not
    /// the same as "only you".
    private let secret = UUID().uuidString
    private var cache = Cache()

    // MARK: Lifecycle

    /// Bring the listener up without mounting. Separated because the
    /// server being ready and the volume being mounted are different
    /// states: the first is ours to arrange, the second is the member's
    /// to ask for.
    func prepare() {
        try? startListener()
    }

    func startAndMount() {
        if state.mounted { reveal(); return }
        do {
            try startListener()
        } catch {
            state.error = "Could not start: \(error.localizedDescription)"
            return
        }
        Task { await mount() }
    }

    func unmount() {
        guard state.mounted else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/diskutil")
        p.arguments = ["unmount", "/Volumes/Griffin Fund"]
        try? p.run()
        state.mounted = false
    }

    func reveal() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: "/Volumes/Griffin Fund")])
    }

    private func startListener() throws {
        guard listener == nil else { return }
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        let l = try NWListener(using: params, on: .any)
        l.newConnectionHandler = { [weak self] conn in
            conn.start(queue: .global(qos: .userInitiated))
            Task { await self?.serve(conn) }
        }
        l.stateUpdateHandler = { [weak self] st in
            Task { @MainActor in
                switch st {
                case .ready:
                    self?.state.listening = true
                    self?.state.port = l.port?.rawValue ?? 0
                    self?.writeHandle()
                case .failed(let e):
                    self?.state.error = e.localizedDescription
                    self?.state.listening = false
                default: break
                }
            }
        }
        l.start(queue: .main)
        listener = l
    }

    /// Where the port and this launch's secret are recorded, 0600, beside
    /// the session token. Written so the mount can be reproduced and
    /// diagnosed from outside the app; deliberately not in the repo and
    /// deliberately not long-lived, since the secret changes every launch.
    private func writeHandle() {
        guard state.port != 0 else { return }
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Griffin Terminal", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("volume.json")
        let json = #"{"port":\#(state.port),"secret":"\#(secret)"}"#
        try? Data(json.utf8).write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Finder's own mount call. AppleScript rather than mount_webdav
    /// because mount_webdav needs a mount point under /Volumes, and
    /// creating one needs root; Finder's path goes through NetAuthAgent
    /// and needs nothing.
    private func mount() async {
        // Wait for the port, or the URL is http://127.0.0.1:0.
        for _ in 0..<40 where state.port == 0 {
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard state.port != 0 else { state.error = "Never got a port."; return }
        // The trailing segment is what Finder shows in the sidebar.
        let url = "http://127.0.0.1:\(state.port)/Griffin%20Fund/"
        let script = """
        tell application "Finder"
            mount volume "\(url)" as user name "griffin" with password "\(secret)"
        end tell
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        let err = Pipe()
        p.standardError = err
        do {
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus == 0 {
                state.mounted = true
                state.error = nil
                reveal()
            } else {
                let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                state.error = msg.isEmpty ? "Finder refused the mount." : msg.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        } catch {
            state.error = error.localizedDescription
        }
    }

    // MARK: The server

    private func serve(_ conn: NWConnection) async {
        guard let req = await Request.read(from: conn) else { conn.cancel(); return }
        guard req.authorized(secret) else {
            await Response(status: 401, headers: ["WWW-Authenticate": "Basic realm=\"Griffin Fund\""])
                .send(on: conn)
            return
        }
        let res = await handle(req)
        await res.send(on: conn)
        // One request per connection. Keep-alive would be faster and this
        // is a local mount serving one Finder; correctness first.
        conn.cancel()
    }

    private func handle(_ req: Request) async -> Response {
        let dav = ["DAV": "1, 2",
                   "MS-Author-Via": "DAV",
                   "Allow": "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, LOCK, UNLOCK"]
        switch req.method {
        case "OPTIONS":
            return Response(status: 200, headers: dav)
        case "LOCK":
            // A token we never remember. Refusing the verb makes Finder
            // treat the whole volume as read-only.
            return Response(status: 200,
                            headers: dav.merging(["Lock-Token": "<opaquelocktoken:griffin>"]) { a, _ in a },
                            body: Data("""
                            <?xml version="1.0" encoding="utf-8"?>
                            <D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
                            <D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>
                            <D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>
                            <D:locktoken><D:href>opaquelocktoken:griffin</D:href></D:locktoken>
                            </D:activelock></D:lockdiscovery></D:prop>
                            """.utf8),
                            contentType: "application/xml; charset=utf-8")
        case "UNLOCK":
            return Response(status: 204, headers: dav)
        case "MKCOL":
            // Folders here are implied by the paths of the files in them,
            // so an empty one has nothing to exist as. Succeeding anyway
            // keeps Finder's "New Folder" from erroring; the folder shows
            // up for real once something is dropped into it.
            return Response(status: 201, headers: dav)
        case "PROPFIND":
            return await propfind(req)
        case "GET", "HEAD":
            return await get(req, headOnly: req.method == "HEAD")
        case "PUT":
            return await put(req)
        default:
            return Response(status: 405, headers: dav)
        }
    }

    // MARK: Verbs

    private func propfind(_ req: Request) async -> Response {
        let depth = req.headers["depth"] == "0" ? 0 : 1
        let parts = req.pathComponents
        var entries: [String] = []

        if parts.isEmpty {
            entries.append(Self.entry(href: Self.base, name: "Griffin Fund", isDir: true))
            if depth == 1 {
                for p in await cache.projects() where !(p.ticker ?? "").isEmpty {
                    entries.append(Self.entry(href: "\(Self.base)\(esc(p.ticker!))/", name: p.ticker!, isDir: true))
                }
            }
            return Self.multistatus(entries)
        }

        guard let project = await cache.project(ticker: parts[0]) else {
            return Response(status: 404)
        }
        let files = await cache.files(project: project.id)
        let prefix = parts.dropFirst().joined(separator: "/")

        if let hit = files.first(where: { $0.path == prefix }) {
            return Self.multistatus([Self.entry(href: Self.base + parts.map(esc).joined(separator: "/"),
                                                name: hit.name, isDir: false, size: hit.size)])
        }

        let here = Self.base + parts.map(esc).joined(separator: "/")
        entries.append(Self.entry(href: here + "/", name: parts.last!, isDir: true))
        if depth == 1 {
            var seenDirs = Set<String>()
            for f in files {
                guard prefix.isEmpty || f.path.hasPrefix(prefix + "/") else { continue }
                let tail = prefix.isEmpty ? f.path : String(f.path.dropFirst(prefix.count + 1))
                if let slash = tail.firstIndex(of: "/") {
                    let dir = String(tail[tail.startIndex..<slash])
                    if seenDirs.insert(dir).inserted {
                        entries.append(Self.entry(href: "\(here)/\(esc(dir))/", name: dir, isDir: true))
                    }
                } else {
                    entries.append(Self.entry(href: "\(here)/\(esc(tail))", name: tail,
                                              isDir: false, size: f.size))
                }
            }
        }
        return Self.multistatus(entries)
    }

    private func get(_ req: Request, headOnly: Bool) async -> Response {
        let parts = req.pathComponents
        guard parts.count >= 2, let project = await cache.project(ticker: parts[0]) else {
            return Response(status: 404)
        }
        let path = parts.dropFirst().joined(separator: "/")
        guard let f = await cache.files(project: project.id).first(where: { $0.path == path }),
              let item = f.itemId else { return Response(status: 404) }
        do {
            let data = try await API.shared.get("/files/\(esc(item))")
            // The real length, recorded so the next listing stops saying
            // zero bytes for a file we have already fetched.
            await cache.note(size: data.count, for: f.path, project: project.id)
            return Response(status: 200,
                            headers: ["Accept-Ranges": "none"],
                            body: headOnly ? Data() : data,
                            contentType: "application/octet-stream",
                            contentLength: data.count)
        } catch {
            return Response(status: 502)
        }
    }

    private func put(_ req: Request) async -> Response {
        let parts = req.pathComponents
        guard parts.count >= 2, let project = await cache.project(ticker: parts[0]) else {
            return Response(status: 404)
        }
        let path = parts.dropFirst().joined(separator: "/")
        let name = parts.last!
        // Finder writes its own bookkeeping into any volume it opens, and
        // Office drops a lock file beside every document. Accepting and
        // discarding them keeps .DS_Store out of the project.
        if name.hasPrefix(".") || name.hasPrefix("~$") { return Response(status: 201) }
        let existing = await cache.files(project: project.id).first { $0.path == path }
        do {
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try req.body.write(to: tmp)
            defer { try? FileManager.default.removeItem(at: tmp) }
            if let existing, let id = existing.artifactId {
                _ = try await API.shared.upload("/research/artifacts/\(id)/file", fileURL: tmp, fields: [:])
            } else {
                _ = try await API.shared.upload("/research/projects/\(project.id)/artifacts",
                                                fileURL: tmp,
                                                fields: ["title": path, "kind": "document"])
            }
            await cache.invalidate(project: project.id)
            return Response(status: 201)
        } catch {
            return Response(status: 500)
        }
    }

    /// Every href is rooted at the mounted URL, or Finder follows a link
    /// one level above the volume and gets a 404 it renders as an empty
    /// folder.
    static let base = "/Griffin%20Fund/"

    private func esc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    // MARK: XML

    static func entry(href: String, name: String, isDir: Bool, size: Int = 0) -> String {
        let when = Self.httpDate.string(from: Date())
        let body = isDir
            ? "<D:resourcetype><D:collection/></D:resourcetype>"
            : "<D:resourcetype/><D:getcontentlength>\(size)</D:getcontentlength>"
        return """
        <D:response><D:href>\(xml(href))</D:href><D:propstat><D:prop>
        <D:displayname>\(xml(name))</D:displayname>
        <D:getlastmodified>\(when)</D:getlastmodified>
        \(body)
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
        """
    }

    static func multistatus(_ entries: [String]) -> Response {
        let xml = """
        <?xml version="1.0" encoding="utf-8"?>
        <D:multistatus xmlns:D="DAV:">
        \(entries.joined(separator: "\n"))
        </D:multistatus>
        """
        return Response(status: 207, body: Data(xml.utf8), contentType: "application/xml; charset=utf-8")
    }

    static func xml(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    static let httpDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return f
    }()
}
