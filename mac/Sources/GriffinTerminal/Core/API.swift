import Foundation
import UniformTypeIdentifiers
import Security

// One session for everything we send to our own API, and the whole
// point of it is that it does not cache.
//
// URLSession.shared writes to a shared on-disk cache, and every gcig-api
// route answers with an ETag and no Cache-Control at all. CFNetwork
// reads that combination as permission to store the response and
// revalidate it later. When it does, the server answers 304 Not
// Modified — and URLSession hands the app the STORED 200 instead,
// headers included. The headers are the dangerous half: a response
// cached at breakfast still carries that morning's X-New-Token, and
// replaying it at lunch writes an expired credential over the live one.
// That is how this app came to delete its own valid session at launch.
// A stale rotation header was adopted, the next call 401'd with code
// AUTH, the teardown fired, and a member who had done nothing wrong was
// signed out with no way back.
//
// So: an ephemeral configuration with no URLCache at all, plus every
// request asking for the network explicitly. Belt and braces, because
// nothing about the failure is visible when it happens — the damage
// shows up one call later, wearing the server's clothes.
enum Net {
    static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()
}

// The client for gcig-api.
//
// Two things this has to get right, both learned the hard way on the web
// client and both worth carrying over rather than rediscovering.
//
// The JWT rotates. The server sets X-New-Token once a token is past its
// 12-hour half-life, and a client that ignores that header logs an active
// user out every 24 hours for no reason. Every response is inspected for
// it.
//
// A failure has to be distinguishable from an empty result. `[]` and
// "the request died" render identically if the error is swallowed, and
// a panel that shows nothing while claiming success is worse than one
// that shows an error, because the reader believes it.
actor API {
    static let shared = API()

    // The same origin the web client talks to. Overridable for a local
    // server without a rebuild.
    private let base = ProcessInfo.processInfo.environment["GRIFFIN_API"]
        ?? "https://gcig-api.onrender.com/api"

    /// The API root, so a caller can tell one of our own URLs from a
    /// third party's and only attach a token to ours.
    var origin: String { base }

    /// A request carrying the session token, for callers that cannot go
    /// through `get`/`post` because they need the response streamed to
    /// disk rather than held in memory. The updater is the only one: a
    /// 4MB app bundle should not become a Data in RAM, and the download
    /// endpoint is members-only so it cannot be fetched anonymously.
    ///
    /// Nil when there is no token, rather than a request without an
    /// Authorization header. The caller's job is then to not ask: a
    /// members-only route answers a credential-less request with a 401
    /// that reads exactly like a broken release, and we would be the
    /// ones who broke it.
    func authorizedRequest(_ path: String) -> URLRequest? {
        guard let token, let url = URL(string: base + path) else { return nil }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    private var token: String? {
        get { TokenStore.read("jwt") }
    }

    enum Failure: LocalizedError {
        case unauthorized
        case http(Int, String)
        case transport(String)
        case decoding(String)

        var errorDescription: String? {
            switch self {
            case .unauthorized:        return "Signed out. Reopen the terminal to sign in."
            case .http(let c, let m):  return m.isEmpty ? "Server returned \(c)." : m
            case .transport(let m):    return "Could not reach the server. \(m)"
            case .decoding(let m):     return "Server sent something unexpected. \(m)"
            }
        }
    }

    func setToken(_ t: String?) {
        if let t { TokenStore.write("jwt", t) } else { TokenStore.delete("jwt") }
    }

    /// A WebSocket URL under our origin, carrying the session token as a
    /// query parameter — a WebSocket cannot set an Authorization header,
    /// same as the browser. `path` is rooted at the host (e.g. "/ws/hoot"),
    /// not under /api.
    func webSocketURL(_ path: String) -> URL? {
        guard let apiURL = URL(string: base) else { return nil }
        var comps = URLComponents()
        comps.scheme = apiURL.scheme == "http" ? "ws" : "wss"
        comps.host = apiURL.host
        comps.port = apiURL.port
        comps.path = path
        if let token { comps.queryItems = [URLQueryItem(name: "token", value: token)] }
        return comps.url
    }

    var isSignedIn: Bool { token != nil }

    // MARK: Requests

    func get(_ path: String, query: [String: String] = [:]) async throws -> Data {
        try await send("GET", path, query: query, body: nil)
    }

    func post(_ path: String, json: [String: Any]) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await send("POST", path, query: [:], body: body)
    }

    /// DELETE, for the two routes that remove something rather than
    /// creating it. No body, because a delete that carries one is a delete
    /// somebody will eventually treat as an update.
    func delete(_ path: String) async throws -> Data {
        try await send("DELETE", path, query: [:], body: nil)
    }

    /// multipart/form-data, for the one route that takes a file.
    ///
    /// Hand-rolled because URLSession has no multipart builder and the
    /// alternative is a dependency for eighteen lines of string joining.
    /// The boundary is generated per call from a UUID: a fixed one would
    /// corrupt any upload whose bytes happened to contain it, which is
    /// exactly the kind of failure that only shows up on the file
    /// somebody actually cared about.
    ///
    /// Timeout is raised well above the default because this carries
    /// real bytes over a home connection to a server that then forwards
    /// them to Graph, and a 30-second ceiling would fail every
    /// spreadsheet worth uploading.
    func upload(_ path: String,
                fileURL: URL,
                fields: [String: String]) async throws -> Data {
        let boundary = "griffin-\(UUID().uuidString)"
        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }

        for (k, v) in fields where !v.isEmpty {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(k)\"\r\n\r\n")
            append("\(v)\r\n")
        }

        // Read on the calling side so a permission failure surfaces as a
        // file error rather than a mystery HTTP one.
        let bytes = try Data(contentsOf: fileURL)
        let name = fileURL.lastPathComponent
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        append("Content-Type: \(Self.mimeType(for: fileURL))\r\n\r\n")
        body.append(bytes)
        append("\r\n--\(boundary)--\r\n")

        return try await send("POST", path, query: [:], body: body,
                              contentType: "multipart/form-data; boundary=\(boundary)",
                              timeout: 300)
    }

    /// The system's own table, so a .xlsx is announced as a spreadsheet
    /// rather than octet-stream. OneDrive stores what we tell it, and a
    /// mistyped file is one that downloads and will not open.
    private static func mimeType(for url: URL) -> String {
        if let t = UTType(filenameExtension: url.pathExtension.lowercased()),
           let mime = t.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            let d = JSONDecoder()
            d.dateDecodingStrategy = .iso8601
            return try d.decode(T.self, from: data)
        } catch {
            throw Failure.decoding(String(describing: error).prefix(180).description)
        }
    }

    private func send(_ method: String, _ path: String,
                      query: [String: String], body: Data?,
                      contentType: String = "application/json",
                      timeout: TimeInterval = 30) async throws -> Data {
        guard var comps = URLComponents(string: base + path) else {
            throw Failure.transport("Bad URL for \(path)")
        }
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps.url else { throw Failure.transport("Bad URL for \(path)") }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout
        // Never from a cache, never into one. See `Net` above: a
        // revalidated response is served to us as the original 200 with
        // its original headers, and one of those headers rotates our
        // credential.
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.httpBody = body
        if body != nil { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        // Remembered, because a 401 means two entirely different things
        // depending on whether we sent anything to be refused.
        let sentCredential = token != nil
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let data: Data, response: URLResponse
        do {
            (data, response) = try await Net.session.data(for: req)
        } catch {
            throw Failure.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw Failure.transport("No HTTP response.")
        }

        // Silent rotation. Without this an active session dies at 24h —
        // and with it done credulously, it dies at launch instead, which
        // is why this goes through `adopt` rather than `write`. A
        // rotation header is only ever worth having if it is NEWER than
        // what we already hold.
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token") {
            TokenStore.adopt(fresh)
        }

        // TWO DIFFERENT 401s, and treating them alike is what left the app
        // telling somebody to sign in again while offering no way to do it.
        //
        // verifyJwt answers a DEAD TOKEN with 401 and code "AUTH". That is
        // the only thing that means the session is over, and it is the one
        // case where the stored token must be thrown away: keeping it means
        // every later call re-sends a credential the server has already
        // rejected, forever, and the app never returns to a sign-in screen.
        // Clearing it here is what makes the next launch recover by itself.
        //
        // A data route's own 401 carries no such code. That is a live
        // session being refused ONE thing, and answering it by destroying
        // the login is the longest-running bug in this codebase, fixed on
        // the web side and never on this one.
        //
        // And there is a third case, which is the one that made the
        // teardown dangerous: a 401 on a request that carried NO
        // credential. verifyJwt answers that with "Missing token" and the
        // same code AUTH, because from the server's side it cannot tell
        // an unauthenticated caller from an expired one. We can. A
        // request we sent without a credential is evidence about our own
        // race — a poller that fired while the store was momentarily
        // empty — and never evidence that the credential we hold is
        // dead. Reading it the other way threw away good tokens.
        if http.statusCode == 401 {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let reason = (body?["error"] as? String) ?? ""
            let weSentNothing = !sentCredential
                || reason.range(of: "missing token", options: .caseInsensitive) != nil
            if !weSentNothing, (body?["code"] as? String) == "AUTH" {
                TokenStore.delete("jwt")
                throw Failure.unauthorized
            }
            throw Failure.http(401, reason.isEmpty ? "Not permitted." : reason)
        }
        guard (200..<300).contains(http.statusCode) else {
            // Surface the server's own sentence when it sent one. Our
            // routes return { error } with something a person can act
            // on, and replacing that with "Request failed" throws away
            // the only useful part.
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { $0?["error"] as? String } ?? ""
            throw Failure.http(http.statusCode, msg)
        }
        return data
    }

    // MARK: Auth

    struct Me: Decodable {
        let id: Int
        let name: String
        let email: String
        let role: String
    }

    func signIn(email: String, password: String) async throws -> Me {
        let data = try await send("POST", "/auth/login", query: [:],
                                  body: try JSONSerialization.data(withJSONObject: [
                                      "email": email, "password": password,
                                  ]))
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure.decoding("login response was not an object")
        }
        // 2FA and other multi-step outcomes come back without a token.
        // Saying so beats a blank window and a spinner that never stops.
        guard let t = obj["token"] as? String else {
            let msg = obj["error"] as? String
                ?? "That account needs a step this app does not handle yet. Sign in on the website."
            throw Failure.http(200, msg)
        }
        TokenStore.write("jwt", t)
        let userObj = obj["user"] as? [String: Any] ?? [:]
        return Me(
            id: userObj["id"] as? Int ?? 0,
            name: userObj["name"] as? String ?? "",
            email: userObj["email"] as? String ?? email,
            role: userObj["role"] as? String ?? ""
        )
    }

    func me() async throws -> Me {
        let data = try await get("/auth/me")
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let u = obj["user"] as? [String: Any] ?? obj as [String: Any]? else {
            throw Failure.decoding("/auth/me response was not an object")
        }
        return Me(
            id: u["id"] as? Int ?? 0,
            name: u["name"] as? String ?? "",
            email: u["email"] as? String ?? "",
            role: u["role"] as? String ?? ""
        )
    }

    /// SECF, effectively: partial ticker or company name -> ranked
    /// matches from the SEC registrant directory.
    struct SymbolMatch: Decodable, Sendable, Hashable {
        let ticker: String
        let name: String
    }

    func symbolSearch(_ q: String) async throws -> [SymbolMatch] {
        struct Wrap: Decodable { let matches: [SymbolMatch]? }
        let data = try await get("/terminal/symbol-search", query: ["q": q])
        return try decode(Wrap.self, from: data).matches ?? []
    }

    /// The server's LLM command parser — the fallback for plain-English
    /// input that matches no mnemonic, same as the web command bar.
    struct ParsedCommand: Decodable {
        let ticker: String?
        let function: String?
        let args: String?
        let explanation: String?
    }

    func parseCommand(_ input: String) async throws -> ParsedCommand {
        let data = try await post("/terminal/parse-command", json: ["input": input])
        return try decode(ParsedCommand.self, from: data)
    }

    /// Trade a browser handoff code for a real token.
    ///
    /// The code is single-use and lives ninety seconds, so the two
    /// failure modes worth telling apart are "expired or already spent"
    /// (the user waited, or clicked twice) and everything else. The
    /// server sends the first as a sentence; pass it through rather than
    /// replacing it with something generic.
    func exchangeHandoff(code: String) async throws -> Me {
        let body = try JSONSerialization.data(withJSONObject: ["code": code])
        let data = try await send("POST", "/auth/native/exchange", query: [:], body: body)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["token"] as? String else {
            throw Failure.decoding("exchange response carried no token")
        }
        TokenStore.write("jwt", t)
        let u = obj["user"] as? [String: Any] ?? [:]
        return Me(
            id: u["id"] as? Int ?? 0,
            name: u["name"] as? String ?? "",
            email: u["email"] as? String ?? "",
            role: u["role"] as? String ?? ""
        )
    }

    func signOut() { TokenStore.delete("jwt") }
}

// Where the session token lives, and why it is a file.
//
// It was in the Keychain first, which is the textbook answer — and the
// textbook assumes a stable code-signing identity. This app is ad-hoc
// signed during development, so every rebuild is a NEW identity as far
// as Keychain ACLs are concerned: "Always Allow" binds to one binary,
// the next build prompts again, and the test runner is a third identity
// prompting on its own. The password dialog on every rebuild is not a
// security feature, it is a training course in clicking Allow.
//
// So: a 0600 file under the user's own Application Support, readable by
// exactly this user, on a FileVault-encrypted disk. Honest trade for a
// development-phase club tool. When the app ships Developer-ID-signed
// with a stable identity, the Keychain becomes viable again and this
// store is one type swap away.
enum TokenStore {
    private static var url: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("Griffin Terminal", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("session.token")
    }

    static func read(_ key: String = "jwt") -> String? {
        guard let s = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    static func write(_ key: String = "jwt", _ value: String) {
        try? value.write(to: url, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                               ofItemAtPath: url.path)
    }

    static func delete(_ key: String = "jwt") {
        try? FileManager.default.removeItem(at: url)
    }

    /// Take a rotated token only when it is genuinely newer than the one
    /// we hold. Returns whether it was taken, which is mostly for the
    /// benefit of anyone testing this.
    ///
    /// The rotation header cannot be trusted on its own, because a
    /// response can be a REPLAY. An HTTP cache that revalidates our
    /// request and receives a 304 hands the client the STORED 200 with
    /// its original headers, so a token minted hours ago arrives looking
    /// exactly like one minted a second ago. We have stopped caching
    /// these responses (see `Net`), and this is the second lock on the
    /// same door: even if a stale header reaches us by some route nobody
    /// has thought of yet, it cannot overwrite a live credential.
    ///
    /// No signature check, deliberately. The question here is not
    /// whether the token is authentic — the server settles that on every
    /// call, and a forged one buys its bearer nothing. The question is
    /// only whether it is NEWER, and `iat` answers that.
    @discardableResult
    static func adopt(_ fresh: String) -> Bool {
        let candidate = fresh.trimmingCharacters(in: .whitespacesAndNewlines)
        // Empty or unparseable is not a rotation, it is noise on the
        // wire, and writing it would sign the member out as surely as a
        // stale one.
        guard !candidate.isEmpty, let freshIat = issuedAt(candidate) else { return false }

        // Rotation presumes a session. With nothing in the store there is
        // nothing to rotate: either we never signed in, or we have just
        // torn a dead session down on purpose. A response still in flight
        // must not put the token back.
        guard let current = read() else { return false }

        // We hold something we cannot read — a truncated write, an older
        // token format. A well-formed JWT is a strict improvement on
        // that, so take it.
        guard let currentIat = issuedAt(current) else { return true.then { write("jwt", candidate) } }

        guard freshIat > currentIat else { return false }
        write("jwt", candidate)
        return true
    }

    /// The `iat` claim, read without verifying anything.
    ///
    /// base64url, and the padding is stripped on the wire — restoring it
    /// is the detail that hand-rolled decoders get wrong, and the
    /// symptom is a decode that silently fails on two tokens in three.
    static func issuedAt(_ jwt: String) -> Int? {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let raw = Data(base64Encoded: payload),
              let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              // Read as a Double so an issuer that writes a fractional
              // second still parses; the comparison holds either way.
              let iat = obj["iat"] as? Double else { return nil }
        return Int(iat)
    }
}

private extension Bool {
    /// Sugar for the one place above that wants to do a thing and return
    /// true in a single expression. Nothing clever, just keeps the guard
    /// readable.
    func then(_ body: () -> Void) -> Bool { body(); return self }
}

extension API {
    /// A server-sent event stream, delivered a token at a time.
    ///
    /// The model writes at roughly twenty tokens a second, so a research
    /// note takes most of a minute — and holding all of it back until
    /// the last token means the panel shows nothing for that whole time
    /// and looks broken rather than busy.
    ///
    /// `URLSession.bytes(for:)` rather than `data(for:)`: the latter
    /// waits for the body to complete, which is the exact thing being
    /// avoided here.
    ///
    /// Throws on transport failure or on a server that answered with
    /// something other than an event stream, so the caller can fall back
    /// to the ordinary blocking post rather than showing an empty pane.
    /// Returns the token sequence. An AsyncSequence rather than a
    /// callback because a callback has to be `@Sendable` to cross the
    /// concurrency boundary, and the natural caller is a SwiftUI view
    /// mutating `@State` — which is MainActor-isolated and therefore
    /// exactly what a Sendable closure may not capture. Iterating with
    /// `for try await` keeps every mutation on the caller's actor.
    func stream(_ path: String, json: [String: Any]) async throws -> AsyncThrowingStream<String, Error> {
        guard let url = URL(string: base + path) else {
            throw Failure.transport("Bad URL for \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        // Generous: the deadline that matters is silence, and URLSession
        // resets this on each delivered byte.
        req.timeoutInterval = 120
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let (bytes, response) = try await Net.session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw Failure.transport("No HTTP response.")
        }
        let type = http.value(forHTTPHeaderField: "Content-Type") ?? ""
        guard http.statusCode == 200, type.contains("text/event-stream") else {
            throw Failure.transport("Server did not stream (\(http.statusCode)).")
        }

        // The wire format is `event: NAME` then `data: JSON`, blank line
        // between. Reading by line rather than by chunk means the
        // framing is handled for us and a token cannot be split.
        return AsyncThrowingStream { continuation in
            let reader = Task {
                var event = ""
                var sawToken = false
                do {
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            let raw = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                            switch event {
                            case "token":
                                // Each token is a JSON string, so quoting
                                // and escapes survive: a model writing a
                                // quote or a newline must not arrive as
                                // the literal characters.
                                if let d = raw.data(using: .utf8),
                                   let piece = try? JSONDecoder().decode(String.self, from: d) {
                                    sawToken = true
                                    continuation.yield(piece)
                                }
                            case "error":
                                throw Failure.transport("The answer stopped part way through. Try again.")
                            default:
                                break
                            }
                        }
                    }
                    // A stream that opened and said nothing is a failure.
                    // Finishing quietly would leave an empty bubble that
                    // reads as an answer.
                    if !sawToken {
                        continuation.finish(throwing: Failure.transport("The stream produced no text."))
                    } else {
                        continuation.finish()
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // A consumer that stops listening — the pane closed mid-
            // answer — must stop the HTTP read with it, or the reader
            // drains the whole stream into a buffer nobody will collect.
            continuation.onTermination = { _ in reader.cancel() }
        }
    }
}
