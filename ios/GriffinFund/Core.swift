import SwiftUI

// The phone is not the terminal and must not pretend to be.
//
// Bloomberg's own mobile app does not ship Launchpad; it ships news,
// messages, market data, worksheets and alerts, and lets the dense
// multi-panel grid stay on the desk. The same logic applies here: a
// six-inch screen holds a reader, an alerter and a messenger. Anything
// with columns belongs on the Mac.
// The palette, type scale and formatters live in Theme.swift and Fmt.swift.
// They used to live here as eyeballed hex and a currency formatter pinned to
// the POSIX locale, which is how the book came to read $ 137070.

enum APIError: LocalizedError {
    case noResponse, sessionOver, cancelled
    case server(Int, String)
    var errorDescription: String? {
        switch self {
        case .noResponse:            return "No response from the server."
        case .sessionOver:           return "Signed out. Sign in again."
        case .cancelled:             return "Cancelled."
        case .server(let c, let m):  return "\(m) (\(c))"
        }
    }
}

/// The networking layer, deliberately NOT on the main actor.
///
/// It used to be a method on `Session`, which is `@MainActor`, so every
/// response was JSON-decoded on the UI thread. With payloads that carry full
/// interview transcripts, that is the hitching: the main thread parses
/// hundreds of kilobytes while it is supposed to be scrolling.
///
/// Session keeps auth lifecycle and the keychain. Everything else is here.
actor API {
    static let shared = API()
    static let base = "https://gcig-api.onrender.com/api"

    /// Set once at launch. Called when, and only when, the server says the
    /// token itself is dead.
    private var onSessionOver: (@Sendable () async -> Void)?
    /// Called with a rotated token so Session can persist it.
    private var onFreshToken: (@Sendable (String) async -> Void)?
    private var token: String?

    func configure(token: String?,
                   onSessionOver: @escaping @Sendable () async -> Void,
                   onFreshToken: @escaping @Sendable (String) async -> Void) {
        self.token = token
        self.onSessionOver = onSessionOver
        self.onFreshToken = onFreshToken
    }

    func setToken(_ t: String?) { token = t }

    /// One or two attempts, and the second exists for one specific reason:
    /// the API sleeps on Render's free tier, so the first request of the day
    /// wakes a cold dyno and returns 502 or times out. The web client already
    /// retries for exactly this. Without it, the first open of the morning
    /// greets a member with a full-screen error for a server that is fine.
    ///
    /// Only cold-start shapes are retried. A 403 is an answer, not a hiccup.
    func get<R: Decodable>(_ path: String, as type: R.Type) async throws -> R {
        do {
            return try await attempt(path, as: type)
        } catch let e as APIError {
            guard case .server(let code, _) = e, code == 502 || code == 503 || code == 504 else { throw e }
            try await Task.sleep(for: .seconds(3))
            return try await attempt(path, as: type)
        } catch let e as URLError where e.code == .timedOut || e.code == .networkConnectionLost {
            try await Task.sleep(for: .seconds(3))
            return try await attempt(path, as: type)
        }
    }

    /// A write. Deliberately NOT retried: the cold-start retry above is
    /// safe because a GET can be repeated, and this cannot. A ballot that
    /// arrives twice because the first response was slow is a bug nobody
    /// would find, so a write that times out is reported as failed and the
    /// person decides whether to try again.
    func post<R: Decodable>(_ path: String, body: [String: Any], as type: R.Type) async throws -> R {
        try await attempt(path, as: type, method: "POST", body: body)
    }

    private func attempt<R: Decodable>(_ path: String, as: R.Type,
                                       method: String = "GET",
                                       body: [String: Any]? = nil) async throws -> R {
        guard let token else { throw APIError.sessionOver }
        guard let url = URL(string: API.base + path) else { throw APIError.noResponse }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        r.timeoutInterval = 30

        let d: Data, resp: URLResponse
        do {
            (d, resp) = try await URLSession.shared.data(for: r)
        } catch is CancellationError {
            throw APIError.cancelled
        } catch let e as URLError where e.code == .cancelled {
            // Leaving a tab mid-load is not a failure and must never be
            // reported as one. The old code caught this with `try?` and
            // told the member it "could not read" three projects.
            throw APIError.cancelled
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.noResponse }

        // Silent rotation. verifyJwt mints a fresh token past the 12h
        // half-life and returns it here; tokens hard-expire at 24h. A client
        // that ignores this header signs an active member out every day.
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token"), !fresh.isEmpty {
            self.token = fresh
            await onFreshToken?(fresh)
        }

        // ONLY THE SERVER MAY END A SESSION, and only with the code that says
        // the token itself is dead. A data route's own 401 carries no code and
        // must not nuke the login: that distinction is the fix for the
        // longest-running bug in this codebase.
        if http.statusCode == 401 {
            let body = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            if (body?["code"] as? String) == "AUTH" {
                self.token = nil
                await onSessionOver?()
                throw APIError.sessionOver
            }
            throw APIError.server(401, (body?["error"] as? String) ?? "Not permitted")
        }

        // Every field on every model is optional, so an error body decodes
        // "successfully" into an empty object and the screen renders a
        // fabricated zero as fact. The status is checked before the decode.
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            throw APIError.server(http.statusCode,
                                  (body?["error"] as? String) ?? "Request failed")
        }
        return try JSONDecoder().decode(R.self, from: d)
    }
}

/// The session. Token in the keychain, never UserDefaults: this one grants
/// President-level access to the club's whole book, and a phone gets lost
/// far more often than a laptop.
@MainActor
final class Session: ObservableObject {
    @Published var token: String?
    @Published var name: String?
    @Published var error: String?
    @Published var busy = false

    static let base = API.base
    private static let account = "griffin.session"

    init() {
        token = Self.keychainRead()
        wire()
    }

    /// Hands the API layer the token and the two callbacks it needs. Called
    /// on launch and after every token change, so the actor and the keychain
    /// never disagree about what the current token is.
    private func wire() {
        let t = token
        Task {
            await API.shared.configure(
                token: t,
                onSessionOver: { @Sendable in await MainActor.run { self.signOut() } },
                onFreshToken: { @Sendable fresh in
                    await MainActor.run {
                        Session.keychainWrite(fresh)
                        self.token = fresh
                    }
                })
        }
    }

    private func adopt(_ t: String) {
        Self.keychainWrite(t)
        token = t
        Task { await API.shared.setToken(t) }
    }

    /// Hand sign-in to the website.
    ///
    /// The password path cannot do Google and cannot do two-factor: the
    /// server answers 2FA with a 200 carrying no token, and there is no
    /// sane way to reimplement either flow in a first build. The website
    /// already does both, so it does them, mints a 90-second single-use
    /// code, and hands it back over the same custom scheme the Mac
    /// registers. Every login method the club has works for free.
    static let handoffURL = URL(string: "https://thegriffinfund.org/native-auth")!

    func exchange(code: String) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            var r = URLRequest(url: URL(string: "\(Self.base)/auth/native/exchange")!)
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
            let (d, resp) = try await URLSession.shared.data(for: r)
            let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let tok = j?["token"] as? String else {
                error = (j?["error"] as? String) ?? "That sign-in link did not work. Try again."
                return
            }
            adopt(tok)
            name = ((j?["user"] as? [String: Any])?["name"] as? String)
        } catch { self.error = error.localizedDescription }
    }

    func logIn(email: String, password: String) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            var r = URLRequest(url: URL(string: "\(Self.base)/auth/login")!)
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
            let (d, resp) = try await URLSession.shared.data(for: r)
            guard let http = resp as? HTTPURLResponse else { error = "No response"; return }
            let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            guard http.statusCode == 200, let tok = j?["token"] as? String else {
                // 2FA returns 200 with no token; say so rather than "failed".
                if j?["twoFactorRequired"] != nil {
                    error = "This account uses two-factor. Sign in on the web for now."
                } else {
                    error = (j?["error"] as? String) ?? "Sign in failed (\(http.statusCode))"
                }
                return
            }
            adopt(tok)
            name = ((j?["user"] as? [String: Any])?["name"] as? String)
        } catch { self.error = error.localizedDescription }
    }

    func signOut() {
        Self.keychainDelete(); token = nil; name = nil
        Task { await API.shared.setToken(nil) }
    }

    // MARK: keychain
    private static func query(_ extra: [String: Any] = [:]) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: "GriffinFund",
                                kSecAttrAccount as String: account]
        extra.forEach { q[$0] = $1 }
        return q
    }
    private static func keychainRead() -> String? {
        var out: AnyObject?
        let s = SecItemCopyMatching(query([kSecReturnData as String: true,
                                           kSecMatchLimit as String: kSecMatchLimitOne]) as CFDictionary, &out)
        guard s == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    private static func keychainWrite(_ t: String) {
        keychainDelete()
        // ThisDeviceOnly: without it the item rides encrypted backups and
        // restores onto another handset, so a token this file's own comment
        // calls President-level access to the whole book survives a backup
        // taken from a lost phone. The status is checked rather than
        // discarded, or a failed write reports success and the member is
        // silently back at the sign-in screen next launch.
        let st = SecItemAdd(query([kSecValueData as String: Data(t.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]) as CFDictionary, nil)
        if st != errSecSuccess { NSLog("Griffin: keychain write failed, OSStatus %d", st) }
    }
    private static func keychainDelete() { SecItemDelete(query() as CFDictionary) }
}
