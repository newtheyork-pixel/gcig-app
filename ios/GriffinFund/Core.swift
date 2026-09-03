import SwiftUI

// The phone is not the terminal and must not pretend to be.
//
// Bloomberg's own mobile app does not ship Launchpad; it ships news,
// messages, market data and alerts, and lets the dense multi-panel grid
// stay on the desk. The same logic applies here: a six-inch screen holds a
// reader, an alerter and a messenger. Anything with columns belongs on the
// Mac.
// The palette, type scale and formatters live in Theme.swift and Fmt.swift.
// They used to live here as eyeballed hex and a currency formatter pinned to
// the POSIX locale, which is how the book came to read $ 137070.

enum APIError: LocalizedError {
    case noResponse, sessionOver, cancelled
    case server(Int, String)
    /// A 403 is not a failure, it is an answer: this member may not open
    /// this. It carries its own case so a screen can say so in one quiet
    /// line instead of painting COULD NOT LOAD over a RETRY button that
    /// will never succeed.
    case forbidden(String)

    var errorDescription: String? {
        switch self {
        case .noResponse:            return "No response from the server."
        case .sessionOver:           return "Signed out. Sign in again."
        case .cancelled:             return "Cancelled."
        case .forbidden(let m):      return m
        case .server(let c, let m):
            // The API sleeps on Render's free tier and answers the first
            // request of the morning with a gateway error. That is a server
            // waking up, not a server that is broken, and the two used to
            // read identically to a member — who then reports the app as
            // down when it is thirty seconds from fine.
            if c == 502 || c == 503 || c == 504 {
                return "The server is still waking up. Try again in a moment."
            }
            return "\(m) (\(c))"
        }
    }

    /// True for the shapes worth trying again: a cold dyno, or a gateway
    /// that dropped one request. A 403 is an answer and a 400 is our own
    /// mistake; neither improves on a second attempt.
    ///
    /// 429 is deliberately NOT here. The server's limiter uses a fixed
    /// window, so the whole 3/6/12s ladder expires inside it and buys
    /// twenty-one seconds of spinner before the same refusal — while the
    /// club is a school, where everyone is behind one address at once.
    var isTransient: Bool {
        if case .server(let c, _) = self { return c == 502 || c == 503 || c == 504 }
        return false
    }
}

/// One URLSession for the whole app, and deliberately not `URLSession.shared`.
///
/// The Mac client's own Core/API.swift records where that leads: the shared
/// session caches to disk, Express stamps an ETag on responses that carry no
/// Cache-Control, and a cached 200 therefore replays a morning-old
/// `X-New-Token` hours later. The client adopts the stale token, the next
/// request 401s with code AUTH, and the session is torn down — which is how
/// that app "came to delete its own valid session at launch".
///
/// It is also the wrong store for this app's data. The token grants
/// President-level access to the whole book, and the responses behind it are
/// the book: positions, cost, cash, and members' names. None of that should
/// sit in a plaintext cache on a phone that gets lost.
enum Net {
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpCookieStorage = nil
        c.timeoutIntervalForRequest = 30
        // Sized against a sleeping free-tier dyno rather than a healthy
        // one: the wake-up can outlast any per-request timeout worth
        // setting, and the retry ladder below is what actually covers it.
        c.timeoutIntervalForResource = 90
        return URLSession(configuration: c)
    }()
}

/// The claims we care about out of our own JWT. Only `iat` is read, and only
/// to answer one question: is this token newer than the one we hold.
enum JWTClaims {
    static func issuedAt(_ token: String) -> Double? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var b64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let d = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
        else { return nil }
        return obj["iat"] as? Double
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
    private var tokenIssuedAt: Double?

    /// Bumped every time the session ends. A response that was already in
    /// flight when somebody pressed Sign out belongs to the old session and
    /// must not write anything back — least of all a rotated token, which
    /// would put a live credential back in the keychain moments after the
    /// member asked us to remove it.
    private var generation = 0

    func configure(token: String?,
                   onSessionOver: @escaping @Sendable () async -> Void,
                   onFreshToken: @escaping @Sendable (String) async -> Void) {
        self.token = token
        self.tokenIssuedAt = token.flatMap(JWTClaims.issuedAt)
        self.onSessionOver = onSessionOver
        self.onFreshToken = onFreshToken
    }

    func setToken(_ t: String?) {
        token = t
        tokenIssuedAt = t.flatMap(JWTClaims.issuedAt)
        if t == nil { generation &+= 1 }
    }

    /// Ends the session inside the actor, so every request already in flight
    /// is orphaned in the same instant rather than one at a time.
    func endSession() {
        token = nil
        tokenIssuedAt = nil
        generation &+= 1
    }

    /// Adopt a rotated token only if it is genuinely newer than the one we
    /// hold, and only if the session it belongs to is still the current one.
    ///
    /// `verifyJwt` mints a fresh token past the 12h half-life and returns it
    /// in a header. Adopting unconditionally means any replayed response —
    /// from a cache, a retry, or a request that raced a sign-out — can walk
    /// the credential backwards.
    private func adopt(_ fresh: String, generation gen: Int) async {
        guard gen == generation, token != nil else { return }
        guard let freshIat = JWTClaims.issuedAt(fresh) else { return }
        if let currentIat = tokenIssuedAt, freshIat <= currentIat { return }
        token = fresh
        tokenIssuedAt = freshIat
        await onFreshToken?(fresh)
    }

    /// A read. Retried on cold-start shapes only.
    ///
    /// The API sleeps on Render's free tier, so the first request of the day
    /// wakes a dyno and returns 502 or times out. The web client retries for
    /// exactly this, on a 1.5/3/6/12s ladder sized to outlast a wake-up. A
    /// single three-second retry — which is what this was — gives up while
    /// the server is still starting, and the member gets a full-screen error
    /// for a server that is fine.
    ///
    /// Only cold-start shapes are retried. A 403 is an answer, not a hiccup.
    func get<R: Decodable>(_ path: String, as type: R.Type) async throws -> R {
        let backoff: [Double] = [3, 6, 12]
        var lastError: Error = APIError.noResponse
        for attemptIndex in 0...backoff.count {
            do {
                return try await attempt(path, as: type)
            } catch let e as APIError {
                guard e.isTransient, attemptIndex < backoff.count else { throw e }
                lastError = e
            } catch let e as URLError where e.code == .timedOut
                        || e.code == .networkConnectionLost
                        || e.code == .cannotConnectToHost {
                guard attemptIndex < backoff.count else { throw e }
                lastError = e
            }
            // Cancellation during the wait is cancellation, not failure.
            // Task.sleep throws CancellationError, which used to escape
            // get() raw and land on screen as "The operation was
            // cancelled." under a COULD NOT LOAD header — on a screen the
            // member had already left.
            do { try await Task.sleep(for: .seconds(backoff[attemptIndex])) }
            catch { throw APIError.cancelled }
        }
        throw lastError
    }

    /// A write. Deliberately NOT retried: the cold-start retry above is
    /// safe because a GET can be repeated, and this cannot. A ballot that
    /// arrives twice because the first response was slow is a bug nobody
    /// would find, so a write that times out is reported as failed and the
    /// person decides whether to try again.
    func post<R: Decodable>(_ path: String, body: [String: Any], as type: R.Type) async throws -> R {
        try await attempt(path, as: type, method: "POST", body: body)
    }

    func delete<R: Decodable>(_ path: String, as type: R.Type) async throws -> R {
        try await attempt(path, as: type, method: "DELETE")
    }

    private func attempt<R: Decodable>(_ path: String, as: R.Type,
                                       method: String = "GET",
                                       body: [String: Any]? = nil) async throws -> R {
        guard let token else { throw APIError.sessionOver }
        guard let url = URL(string: API.base + path) else { throw APIError.noResponse }
        let gen = generation
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        r.timeoutInterval = 30

        let d: Data, resp: URLResponse
        do {
            (d, resp) = try await Net.session.data(for: r)
        } catch is CancellationError {
            throw APIError.cancelled
        } catch let e as URLError where e.code == .cancelled {
            // Leaving a tab mid-load is not a failure and must never be
            // reported as one. The old code caught this with `try?` and
            // told the member it "could not read" three projects.
            throw APIError.cancelled
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.noResponse }

        // Silent rotation, guarded. See adopt(_:generation:).
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token"), !fresh.isEmpty {
            await adopt(fresh, generation: gen)
        }

        // ONLY THE SERVER MAY END A SESSION, and only with the code that says
        // the token itself is dead. A data route's own 401 carries no code and
        // must not nuke the login: that distinction is the fix for the
        // longest-running bug in this codebase.
        if http.statusCode == 401 {
            let body = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            if (body?["code"] as? String) == "AUTH" {
                // Third case, and the one the Mac learned the hard way: if
                // the session has already moved on beneath this request,
                // an AUTH 401 is evidence about our own race and not about
                // the token the member is currently holding.
                guard gen == generation else { throw APIError.cancelled }
                self.token = nil
                self.tokenIssuedAt = nil
                generation &+= 1
                await onSessionOver?()
                throw APIError.sessionOver
            }
            throw APIError.server(401, (body?["error"] as? String) ?? "Not permitted")
        }

        if http.statusCode == 403 {
            let body = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            throw APIError.forbidden((body?["error"] as? String)
                                     ?? "Your role does not open this.")
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

/// Who is holding the phone. The server answers this rather than the client
/// inferring it from a role string: `terminalAccess` is computed by the same
/// predicate the route gates use, so the app and the API cannot disagree
/// about what this member may open.
struct Me: Decodable {
    let id: Int?
    let name: String?
    let email: String?
    let role: String?
    let isSuperAdmin: Bool?
    let terminalAccess: Bool?
}

/// The session. Token in the keychain, never UserDefaults: this one grants
/// President-level access to the club's whole book, and a phone gets lost
/// far more often than a laptop.
@MainActor
final class Session: ObservableObject {
    @Published var token: String?
    @Published var name: String?
    @Published var role: String?
    @Published var error: String?
    @Published var busy = false
    /// Nil until /auth/me answers. Nil is not "no access" — it is "we have
    /// not asked yet", and the tabs stay visible through it so a slow
    /// identity call never looks like a demotion.
    @Published var terminalAccess: Bool?
    /// Surfaced rather than swallowed. A keychain write that fails silently
    /// means the member is back at the sign-in screen next launch with no
    /// idea why, which reads as the app losing their session at random.
    @Published var keychainWarning: String?

    static let base = API.base
    private static let account = "griffin.session"
    private static let nameKey = "griffin.member.name"
    private static let roleKey = "griffin.member.role"
    private static let accessKey = "griffin.member.terminalAccess"

    init() {
        token = Self.keychainRead()
        // Identity is remembered so a cold launch shows the member's name
        // instead of the placeholder "Signed in". Only the token is secret;
        // a name and a role are not, and keeping them out of the keychain
        // keeps the keychain item a single-purpose thing.
        name = UserDefaults.standard.string(forKey: Self.nameKey)
        role = UserDefaults.standard.string(forKey: Self.roleKey)
        if UserDefaults.standard.object(forKey: Self.accessKey) != nil {
            terminalAccess = UserDefaults.standard.bool(forKey: Self.accessKey)
        }
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
                        // A rotation that lands after sign-out is dropped.
                        // The actor guards this too; both run because the
                        // cost is one comparison and the failure mode is a
                        // live credential written back to a phone whose
                        // owner just asked us to forget it.
                        guard self.token != nil else { return }
                        Session.keychainWrite(fresh) { self.keychainWarning = $0 }
                        self.token = fresh
                    }
                })
        }
    }

    private func adopt(_ t: String) {
        Self.keychainWrite(t) { self.keychainWarning = $0 }
        token = t
        Task {
            await API.shared.setToken(t)
            await self.refreshIdentity()
        }
    }

    /// Who is signed in, and what they may open. Called after every sign-in
    /// and on every foreground, because a role can change between sessions
    /// and a stale answer is how somebody keeps looking at a tab that was
    /// taken away from them.
    func refreshIdentity() async {
        guard token != nil else { return }
        guard let me = try? await API.shared.get("/auth/me", as: Me.self) else { return }
        if let n = me.name, !n.isEmpty {
            name = n
            UserDefaults.standard.set(n, forKey: Self.nameKey)
        }
        if let r = me.role {
            role = r
            UserDefaults.standard.set(r, forKey: Self.roleKey)
        }
        if let a = me.terminalAccess {
            terminalAccess = a
            UserDefaults.standard.set(a, forKey: Self.accessKey)
        }
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

    /// The sign-in calls do not go through `API.get`, so they need the
    /// cold-start ladder themselves. Without it the first open of the
    /// morning fails the handoff with "That sign-in link did not work" —
    /// for a link that was fine — while the ninety-second single-use code
    /// burns down behind the error.
    ///
    /// `retryAmbiguous` is false for the sign-in code exchange, and the
    /// distinction is the difference between a retry that helps and one that
    /// destroys the thing it is retrying. The server DELETES the 90-second
    /// code the moment it reads it, so a timeout — where the request may well
    /// have arrived and only the response was lost — must not be tried again:
    /// the second attempt spends a code that has already been redeemed and
    /// turns a slow success into "That sign-in link did not work". A gateway
    /// error is different: Render's proxy answering 502 means it could not
    /// reach the app, so the code was never read.
    private func postJSON(_ path: String, _ body: [String: Any],
                          retryAmbiguous: Bool = true) async throws -> (Int, [String: Any]?) {
        var r = URLRequest(url: URL(string: Self.base + path)!)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        r.timeoutInterval = 30

        for delay in [0.0, 3.0, 6.0] {
            if delay > 0 {
                do { try await Task.sleep(for: .seconds(delay)) }
                catch { throw APIError.cancelled }
            }
            do {
                let (d, resp) = try await Net.session.data(for: r)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
                if code == 502 || code == 503 || code == 504 { continue }
                return (code, j)
            } catch let e as URLError where e.code == .cannotConnectToHost {
                // No connection was established, so nothing was consumed.
                continue
            } catch let e as URLError where (e.code == .timedOut
                        || e.code == .networkConnectionLost) && retryAmbiguous {
                continue
            }
        }
        throw APIError.server(503, "The server did not wake up.")
    }

    func exchange(code: String) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let (status, j) = try await postJSON("/auth/native/exchange", ["code": code],
                                                 retryAmbiguous: false)
            guard status == 200, let tok = j?["token"] as? String else {
                error = (j?["error"] as? String) ?? "That sign-in link did not work. Try again."
                return
            }
            adopt(tok)
            name = ((j?["user"] as? [String: Any])?["name"] as? String) ?? name
        } catch { self.error = error.localizedDescription }
    }

    func logIn(email: String, password: String) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let (status, j) = try await postJSON("/auth/login",
                                                 ["email": email, "password": password])
            guard status == 200, let tok = j?["token"] as? String else {
                // 2FA returns 200 with no token; say so rather than "failed".
                if j?["twoFactorRequired"] != nil {
                    error = "This account uses two-factor. Sign in on the web for now."
                } else {
                    error = (j?["error"] as? String) ?? "Sign in failed (\(status))"
                }
                return
            }
            adopt(tok)
            name = ((j?["user"] as? [String: Any])?["name"] as? String) ?? name
        } catch { self.error = error.localizedDescription }
    }

    func signOut() {
        Self.keychainDelete()
        token = nil; name = nil; role = nil; terminalAccess = nil; keychainWarning = nil
        UserDefaults.standard.removeObject(forKey: Self.nameKey)
        UserDefaults.standard.removeObject(forKey: Self.roleKey)
        UserDefaults.standard.removeObject(forKey: Self.accessKey)
        Task { await API.shared.endSession() }
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

    /// WhenUnlockedThisDeviceOnly, not AfterFirstUnlock.
    ///
    /// ThisDeviceOnly keeps the item off encrypted backups, so a token this
    /// file's own comment calls President-level access cannot be restored
    /// onto a second handset from a backup taken off a lost phone.
    /// WhenUnlocked is the tighter half: nothing in this app reads the token
    /// while the screen is locked — there is no background refresh and no
    /// push extension — so there is no reason for it to be readable then.
    /// Revisit only when something genuinely runs locked.
    ///
    /// The status is checked, and a failure is reported rather than logged
    /// into a console nobody is reading. One retry, because the common
    /// failure here is a transient duplicate rather than a broken keychain.
    private static func keychainWrite(_ t: String, warn: (String?) -> Void) {
        func attempt() -> OSStatus {
            keychainDelete()
            return SecItemAdd(query([kSecValueData as String: Data(t.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) as CFDictionary, nil)
        }
        var st = attempt()
        if st != errSecSuccess { st = attempt() }
        if st != errSecSuccess {
            NSLog("Griffin: keychain write failed, OSStatus %d", st)
            warn("This phone could not remember your sign-in. You may need to sign in again next time.")
        } else {
            warn(nil)
        }
    }
    private static func keychainDelete() { SecItemDelete(query() as CFDictionary) }
}
