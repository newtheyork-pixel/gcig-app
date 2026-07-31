import Foundation
import Network

// The HTTP plumbing under GriffinVolume, and the project data it serves.
//
// Hand-rolled because the no-third-party rule holds here too and because
// the surface is small: one local client, ten verbs, no TLS, no
// keep-alive. Anything more would be a web server, and a web server is
// not what this is.

struct Request {
    var method = ""
    var path = ""
    var headers: [String: String] = [:]
    var body = Data()

    /// Percent-decoded path segments, with the leading slash and any
    /// trailing slash gone. Finder sends both forms for the same folder.
    var pathComponents: [String] {
        let raw = path.split(separator: "?").first
            .map(String.init)?
            .split(separator: "/")
            .map { $0.removingPercentEncoding ?? String($0) }
            .filter { !$0.isEmpty } ?? []
        // macOS names a WebDAV volume after the last path component of
        // the mounted URL, so mounting the bare host gives a volume
        // called 127.0.0.1. Mounting /Griffin Fund/ names it properly,
        // which means the server has to accept that segment and treat it
        // as the root rather than as a ticker.
        if raw.first == Request.volumeName { return Array(raw.dropFirst()) }
        return raw
    }

    static let volumeName = "Griffin Fund"

    func authorized(_ secret: String) -> Bool {
        guard let h = headers["authorization"], h.hasPrefix("Basic ") else { return false }
        guard let d = Data(base64Encoded: String(h.dropFirst(6))),
              let pair = String(data: d, encoding: .utf8),
              let colon = pair.firstIndex(of: ":") else { return false }
        return String(pair[pair.index(after: colon)...]) == secret
    }

    /// Read one request. Headers first, then exactly Content-Length bytes,
    /// because a PUT body is a file and stopping early truncates it.
    static func read(from conn: NWConnection) async -> Request? {
        var buffer = Data()
        var req = Request()
        var headerEnd: Range<Data.Index>?

        while headerEnd == nil {
            guard let chunk = await receive(conn) else { return nil }
            buffer.append(chunk)
            headerEnd = buffer.range(of: Data("\r\n\r\n".utf8))
            if buffer.count > 1_000_000 { return nil }
        }
        guard let end = headerEnd,
              let head = String(data: buffer[..<end.lowerBound], encoding: .utf8) else { return nil }

        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        req.method = String(requestLine[0]).uppercased()
        req.path = String(requestLine[1])
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let k = line[line.startIndex..<colon].lowercased()
            let v = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            req.headers[k] = v
        }

        var body = buffer[end.upperBound...]
        let expected = Int(req.headers["content-length"] ?? "0") ?? 0
        while body.count < expected {
            guard let chunk = await receive(conn) else { break }
            body.append(chunk)
        }
        req.body = Data(body.prefix(expected))
        return req
    }

    private static func receive(_ conn: NWConnection) async -> Data? {
        await withCheckedContinuation { cont in
            conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, _ in
                cont.resume(returning: (data?.isEmpty == false) ? data : (done ? nil : Data()))
            }
        }
    }
}

struct Response {
    var status = 200
    var headers: [String: String] = [:]
    var body = Data()
    var contentType: String?
    var contentLength: Int?

    func send(on conn: NWConnection) async {
        var head = "HTTP/1.1 \(status) \(Response.reason(status))\r\n"
        head += "Content-Length: \(contentLength ?? body.count)\r\n"
        if let contentType { head += "Content-Type: \(contentType)\r\n" }
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            conn.send(content: out, completion: .contentProcessed { _ in cont.resume() })
        }
    }

    static func reason(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 201: return "Created"
        case 204: return "No Content"
        case 207: return "Multi-Status"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 500: return "Internal Server Error"
        case 502: return "Bad Gateway"
        default:  return "OK"
        }
    }
}

/// Projects and their files, kept briefly so browsing a folder is not one
/// API round trip per keystroke of Finder's. Short TTL rather than a
/// listener, because a stale listing that corrects itself in half a
/// minute is a smaller problem than a cache nobody can see is wrong.
actor Cache {
    struct Project: Decodable { let id: Int; let ticker: String?; let name: String? }
    struct File {
        let path: String
        let name: String
        let itemId: String?
        let artifactId: Int?
        var size: Int
    }

    private var projectList: [Project] = []
    private var projectsAt: Date?
    private var byProject: [Int: [File]] = [:]
    private var filesAt: [Int: Date] = [:]
    private let ttl: TimeInterval = 30

    func projects() async -> [Project] {
        if let at = projectsAt, Date().timeIntervalSince(at) < ttl { return projectList }
        struct Wrap: Decodable { let projects: [Project]? }
        guard let data = try? await API.shared.get("/research/projects") else { return projectList }
        if let list = try? await API.shared.decode([Project].self, from: data) {
            projectList = list
        } else if let w = try? await API.shared.decode(Wrap.self, from: data) {
            projectList = w.projects ?? []
        }
        projectsAt = Date()
        return projectList
    }

    func project(ticker: String) async -> Project? {
        await projects().first { ($0.ticker ?? "").caseInsensitiveCompare(ticker) == .orderedSame }
    }

    func files(project id: Int) async -> [File] {
        if let at = filesAt[id], Date().timeIntervalSince(at) < ttl, let f = byProject[id] { return f }
        struct Wrap: Decodable {
            let artifacts: [Row]?
            struct Row: Decodable { let id: Int; let title: String; let fileRef: String? }
        }
        guard let data = try? await API.shared.get("/research/projects/\(id)"),
              let w = try? await API.shared.decode(Wrap.self, from: data) else { return byProject[id] ?? [] }
        let previous = Dictionary(uniqueKeysWithValues: (byProject[id] ?? []).map { ($0.path, $0.size) })
        byProject[id] = (w.artifacts ?? []).compactMap { row in
            guard let ref = row.fileRef, ref.hasPrefix("onedrive:") else { return nil }
            return File(path: row.title,
                        name: row.title.split(separator: "/").last.map(String.init) ?? row.title,
                        itemId: String(ref.dropFirst("onedrive:".count)),
                        artifactId: row.id,
                        // Sizes we learned by fetching survive a refresh.
                        size: previous[row.title] ?? 0)
        }
        filesAt[id] = Date()
        return byProject[id] ?? []
    }

    func note(size: Int, for path: String, project id: Int) {
        guard var list = byProject[id], let i = list.firstIndex(where: { $0.path == path }) else { return }
        list[i].size = size
        byProject[id] = list
    }

    func invalidate(project id: Int) {
        filesAt[id] = nil
    }
}
