import SwiftUI

// The phone is not the terminal and must not pretend to be.
//
// Bloomberg's own mobile app does not ship Launchpad; it ships news,
// messages, market data, worksheets and alerts, and lets the dense
// multi-panel grid stay on the desk. The same logic applies here: a
// six-inch screen holds a reader, an alerter and a messenger. Anything
// with columns belongs on the Mac.
enum T {
    static let bg       = Color(red: 0.043, green: 0.043, blue: 0.047)
    static let panel    = Color(red: 0.078, green: 0.078, blue: 0.086)
    static let border   = Color(red: 0.18,  green: 0.18,  blue: 0.20)
    static let amber    = Color(red: 1.0,   green: 0.686, blue: 0.196)
    static let white    = Color(red: 0.93,  green: 0.93,  blue: 0.94)
    static let dim      = Color(red: 0.62,  green: 0.62,  blue: 0.65)
    static let muted    = Color(red: 0.42,  green: 0.42,  blue: 0.45)
    static let positive = Color(red: 0.31,  green: 0.82,  blue: 0.51)
    static let negative = Color(red: 0.94,  green: 0.36,  blue: 0.36)
    static let cyan     = Color(red: 0.35,  green: 0.78,  blue: 0.86)
    static func mono(_ s: CGFloat, _ w: Font.Weight = .regular) -> Font {
        .system(size: s, weight: w, design: .monospaced)
    }
}

enum Fmt {
    /// Optional in, dash out. A missing figure rendered as "$0" is a
    /// fabricated number in 17pt bold, and the all-optional decodables
    /// mean a renamed key produces exactly that.
    static func money(_ v: Double?) -> String {
        guard let v else { return "—" }
        let f = NumberFormatter()
        f.numberStyle = .currency; f.maximumFractionDigits = 0
        f.currencyCode = "USD"; f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: NSNumber(value: v)) ?? "—"
    }
    static func pct(_ v: Double) -> String { String(format: "%@%.2f%%", v >= 0 ? "+" : "", v) }
    /// "2026-08-19" to "19 Aug", the house short form. Returns the input
    /// untouched rather than a wrong date when it will not parse.
    static func day(_ iso: String?) -> String {
        guard let iso, iso.count >= 10 else { return "—" }
        let inF = DateFormatter(); inF.dateFormat = "yyyy-MM-dd"
        // The POSIX locale is not decoration. A fixed format string is
        // parsed against the user's own calendar unless told otherwise, so
        // a Thai Buddhist or Japanese Imperial phone reads yyyy in that era
        // and lands centuries off, or fails and prints the raw ISO string
        // into a column sized for "31 Jul".
        inF.locale = Locale(identifier: "en_US_POSIX")
        inF.timeZone = TimeZone(identifier: "UTC")
        guard let d = inF.date(from: String(iso.prefix(10))) else { return iso }
        let out = DateFormatter(); out.dateFormat = "d MMM"
        out.locale = Locale(identifier: "en_US_POSIX")
        out.timeZone = TimeZone(identifier: "UTC")
        return out.string(from: d)
    }
}

/// The session. Token in the keychain, never UserDefaults: this one grants
/// President-level access to the club's whole book, and a phone gets lost
/// far more often than a laptop.
enum APIError: LocalizedError {
    case noResponse, sessionOver
    case server(Int, String)
    var errorDescription: String? {
        switch self {
        case .noResponse:            return "No response from the server."
        case .sessionOver:           return "Signed out. Sign in again."
        case .server(let c, let m):  return "\(m) (\(c))"
        }
    }
}

@MainActor
final class Session: ObservableObject {
    @Published var token: String?
    @Published var name: String?
    @Published var error: String?
    @Published var busy = false

    static let base = "https://gcig-api.onrender.com/api"
    private static let account = "griffin.session"

    init() { token = Self.keychainRead() }

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
            Self.keychainWrite(tok)
            token = tok
            name = ((j?["user"] as? [String: Any])?["name"] as? String)
        } catch { self.error = error.localizedDescription }
    }

    func signOut() { Self.keychainDelete(); token = nil; name = nil }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        guard let token else { throw URLError(.userAuthenticationRequired) }
        var r = URLRequest(url: URL(string: Self.base + path)!)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.timeoutInterval = 45
        let (d, resp) = try await URLSession.shared.data(for: r)
        guard let http = resp as? HTTPURLResponse else { throw APIError.noResponse }

        // Silent rotation. verifyJwt mints a fresh token past the 12h
        // half-life and returns it here; tokens hard-expire at 24h. A
        // client that ignores this header signs an active member out every
        // single day for no reason.
        if let fresh = http.value(forHTTPHeaderField: "X-New-Token"), !fresh.isEmpty {
            Self.keychainWrite(fresh)
            await MainActor.run { self.token = fresh }
        }

        // ONLY THE SERVER MAY END A SESSION, and only with the code that
        // says the token itself is dead. A data route's own 401 carries no
        // code and must not nuke the login: that distinction is the fix for
        // the longest-running bug in this codebase.
        if http.statusCode == 401 {
            let body = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            if (body?["code"] as? String) == "AUTH" {
                await MainActor.run { self.signOut() }
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
        return try JSONDecoder().decode(T.self, from: d)
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
