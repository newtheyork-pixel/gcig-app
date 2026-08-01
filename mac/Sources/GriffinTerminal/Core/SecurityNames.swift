import Foundation
import SwiftUI

/// Ticker to the name a person would say.
///
/// The panes were labelled "MLAB · DES · DESCRIPTION" — three codes and
/// no company. Bloomberg writes "ALPHABET INC-A Equity", and the reason
/// is not decoration: a screen holding six panes is a screen you scan,
/// and a ticker is only legible to somebody who already knows what they
/// opened.
///
/// Resolved from the SEC registrant directory we already serve for the
/// command bar's autocomplete, so this costs one cheap call per symbol
/// and nothing at all once warm. Names are held for the session: a
/// company does not rename itself while somebody is looking at a chart.
@MainActor
final class SecurityNames: ObservableObject {
    static let shared = SecurityNames()

    @Published private(set) var names: [String: String] = [:]
    private var inFlight: Set<String> = []

    private struct Match: Decodable { let ticker: String?; let name: String? }
    private struct Payload: Decodable { let matches: [Match]? }

    /// The name if we have it, the ticker if we do not — and a fetch
    /// started either way. Never nil, because a label that disappears
    /// while a request is in flight is worse than one that sharpens.
    func name(for ticker: String?) -> String? {
        guard let t = ticker?.uppercased(), !t.isEmpty else { return nil }
        if let hit = names[t] { return hit }
        resolve(t)
        return t
    }

    /// Bloomberg's form: the company, then what kind of instrument it is.
    /// Everything we carry is a listed equity or a fund, and calling a
    /// fund an equity would be wrong, so the suffix is only added where
    /// it is true.
    func label(for ticker: String?) -> String? {
        guard let t = ticker?.uppercased(), !t.isEmpty else { return nil }
        guard let n = names[t] else { resolve(t); return t }
        return "\(n) \(Self.isFund(n) ? "Fund" : "Equity")"
    }

    private static func isFund(_ name: String) -> Bool {
        let n = name.uppercased()
        return n.contains(" ETF") || n.contains("TRUST") || n.contains(" FUND")
            || n.contains("INDEX FD") || n.contains(" SPDR")
    }

    private func resolve(_ ticker: String) {
        guard !inFlight.contains(ticker) else { return }
        inFlight.insert(ticker)
        Task { [weak self] in
            defer { Task { @MainActor in self?.inFlight.remove(ticker) } }
            guard let data = try? await API.shared.get("/terminal/symbol-search",
                                                       query: ["q": ticker]),
                  let payload = try? await API.shared.decode(Payload.self, from: data)
            else { return }
            // Exact ticker only. The search ranks partial matches, and
            // labelling a pane with a company somebody did not open is
            // worse than labelling it with the symbol they typed.
            guard let hit = (payload.matches ?? []).first(where: {
                $0.ticker?.uppercased() == ticker
            }), let name = hit.name, !name.isEmpty else { return }
            await MainActor.run { self?.names[ticker] = Self.tidy(name) }
        }
    }

    /// EDGAR shouts, and it carries the corporate furniture a reader
    /// does not need on a tab: "MESA LABORATORIES INC /CO/" is Mesa
    /// Laboratories Inc.
    static func tidy(_ raw: String) -> String {
        var s = raw.replacingOccurrences(of: #"\s*/[A-Z]{2}(/|\b)"#,
                                         with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s*\\?/(DE|MD|NY|OH|CO|MN|NV)/?$"#,
                                   with: "", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        // All-capitals is EDGAR's habit, not the company's name.
        if s.range(of: "[a-z]", options: .regularExpression) == nil {
            s = s.split(separator: " ").map { word -> String in
                let w = String(word)
                // Keep the initialisms: CH, USA, NV, and the suffixes.
                if w.count <= 3 && !["AND", "THE", "FOR"].contains(w) { return w }
                return w.prefix(1) + w.dropFirst().lowercased()
            }.joined(separator: " ")
        }
        return s
    }
}
