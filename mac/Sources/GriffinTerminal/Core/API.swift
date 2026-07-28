import Foundation
import Security

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
            case .unauthorized:        return "Session expired. Sign in again."
            case .http(let c, let m):  return m.isEmpty ? "Server returned \(c)." : m
            case .transport(let m):    return "Could not reach the server. \(m)"
            case .decoding(let m):     return "Server sent something unexpected. \(m)"
            }
        }
    }

    func setToken(_ t: String?) {
        if let t { TokenStore.write("jwt", t) } else { TokenStore.delete("jwt") }
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
                      query: [String: String], body: Data?) async throws -> Data {
        guard var comps = URLComponents(string: base + path) else {
            throw Failure.transport("Bad URL for \(path)")
        }
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps.url else { throw Failure.transport("Bad URL for \(path)") }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.httpBody = body
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw Failure.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw Failure.transport("No HTTP response.")
        }

        // Silent rotation. Without this an active session dies at 24h.
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token"), !fresh.isEmpty {
            TokenStore.write("jwt", fresh)
        }

        if http.statusCode == 401 || http.statusCode == 403 {
            throw Failure.unauthorized
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
}
