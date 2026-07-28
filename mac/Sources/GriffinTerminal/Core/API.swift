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
        get { Keychain.read("jwt") }
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
        if let t { Keychain.write("jwt", t) } else { Keychain.delete("jwt") }
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
            Keychain.write("jwt", fresh)
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
        Keychain.write("jwt", t)
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
        Keychain.write("jwt", t)
        let u = obj["user"] as? [String: Any] ?? [:]
        return Me(
            id: u["id"] as? Int ?? 0,
            name: u["name"] as? String ?? "",
            email: u["email"] as? String ?? "",
            role: u["role"] as? String ?? ""
        )
    }

    func signOut() { Keychain.delete("jwt") }
}

// The token lives in the Keychain, not in UserDefaults.
//
// UserDefaults is a plist in the container, readable by anything running
// as this user. It holds a bearer token for a system of record that
// carries the club's portfolio and its primary research, so it belongs
// somewhere the OS protects.
enum Keychain {
    private static let service = "org.thegriffinfund.terminal"

    static func read(_ key: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String) {
        delete(key)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func delete(_ key: String) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(q as CFDictionary)
    }
}
