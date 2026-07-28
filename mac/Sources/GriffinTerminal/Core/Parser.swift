import Foundation

// Mnemonic parser. A literal port of client/src/terminal/parser.js, which
// itself mirrors server/src/routes/terminal.js#mnemonicParse.
//
// This is deliberately a port rather than an improvement. The whole value
// of a command line is that the same keystrokes do the same thing every
// time, and a Mac app that resolved `AIT` differently from the web would
// be worse than no Mac app. If the rules change, they change in three
// places together.
struct Command: Equatable {
    var ticker: String?
    var function: String
    var args: String?
}

enum Parser {
    /// Matches the JS `/^[A-Z][A-Z0-9.\-]{0,11}$/`.
    static func looksLikeTicker(_ s: String) -> Bool {
        guard let first = s.first, first.isLetter, first.isUppercase else { return false }
        guard s.count <= 12 else { return false }
        return s.dropFirst().allSatisfy { c in
            c.isUppercase || c.isNumber || c == "." || c == "-"
        }
    }

    static func parse(_ input: String) -> Command? {
        let cleaned = input
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
            .uppercased()
        if cleaned.isEmpty { return nil }

        let parts = cleaned.split(separator: " ").map(String.init)

        if parts.count == 1 {
            let tok = parts[0]
            if Registry.ids.contains(tok) {
                return Command(ticker: nil, function: tok, args: nil)
            }
            // A bare ticker opens DES, same as the web.
            if looksLikeTicker(tok) {
                return Command(ticker: tok, function: "DES", args: nil)
            }
            return nil
        }

        let t = parts[0]
        let f = parts[1]
        let rest = Array(parts.dropFirst(2))

        if Registry.ids.contains(f), looksLikeTicker(t) {
            return Command(ticker: t, function: f,
                           args: rest.isEmpty ? nil : String(rest.joined(separator: " ").prefix(80)))
        }

        if Registry.ids.contains(t) {
            let joined = ([f] + rest).joined(separator: " ")
            return Command(ticker: nil, function: t, args: String(joined.prefix(80)))
        }

        return nil
    }
}
