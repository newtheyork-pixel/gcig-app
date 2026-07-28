import SwiftUI

/// What crosses from the in-shell workspace to a real macOS window when
/// a pane is popped out. Codable because WindowGroup(for:) requires it;
/// the UUID keeps two pop-outs of the same function distinct.
struct PaneSeed: Codable, Hashable {
    var id = UUID()
    var function: String
    var ticker: String?
    var args: String?
}

// The workspace: what is open, where, and which pane has focus.
//
// Modelled on the web client's FloatingWindow, because the layout IS the
// product here. A terminal where panels tile automatically is a
// dashboard; the reason to keep free-floating, overlapping, manually
// placed windows is that the arrangement carries meaning the software
// does not know about. Somebody puts the ledger next to the valuation
// because those two things argue with each other.
@MainActor
final class Workspace: ObservableObject {
    @Published var panes: [Pane] = []
    @Published var focusedID: UUID?
    /// The ticker the command bar last resolved. `AIT DES` then a bare
    /// `GP` should stay on AIT, the same as the web.
    @Published var focusTicker: String?
    @Published var flash: Flash?

    struct Flash: Identifiable, Equatable {
        let id = UUID()
        var text: String
        var bad: Bool
    }

    struct Pane: Identifiable, Equatable {
        let id = UUID()
        var function: TerminalFunction
        var ticker: String?
        var args: String?
        var frame: CGRect
        var z: Int
        var minimized = false

        var title: String {
            let code = ticker.map { "\($0) " } ?? ""
            return "\(code)\(function.id) · \(function.label.uppercased())"
        }

        static func == (a: Pane, b: Pane) -> Bool {
            a.id == b.id && a.frame == b.frame && a.z == b.z && a.minimized == b.minimized
                && a.function == b.function && a.ticker == b.ticker
        }
    }

    private var topZ = 0

    /// The floating canvas's current size, kept fresh by the shell so
    /// commands arriving from the command bar, the rail, or a menu item
    /// can spawn sensibly without threading geometry through every
    /// caller.
    var canvasSize = CGSize(width: 1280, height: 800)

    // MARK: Opening

    func run(_ input: String) { run(input, in: canvasSize) }
    func open(_ cmd: Command) { open(cmd, in: canvasSize) }

    func run(_ input: String, in bounds: CGSize) {
        guard let cmd = Parser.parse(input) else {
            // Distinguish "I do not know that word" from "that needs a
            // ticker". Only one of them is the user's mistake.
            flash = Flash(text: "\(input.uppercased()) is not a function or a ticker. Type HELP.", bad: true)
            return
        }
        open(cmd, in: bounds)
    }

    func open(_ cmd: Command, in bounds: CGSize) {
        guard let fn = Registry.function(cmd.function) else {
            flash = Flash(text: "\(cmd.function) is not a function. Type HELP.", bad: true)
            return
        }

        // Carry the focused ticker forward, so `GP` after `AIT DES` works.
        let ticker = cmd.ticker ?? focusTicker

        if fn.requires == "ticker", ticker == nil {
            flash = Flash(text: "\(fn.id) needs a ticker. Try  AIT \(fn.id)", bad: true)
            return
        }

        guard fn.native else {
            // The honest message. This function exists, the user did not
            // mistype, it just is not built here yet.
            flash = Flash(text: "\(fn.id) is not native yet. It works on the web terminal.", bad: true)
            return
        }

        if let t = cmd.ticker { focusTicker = t }
        // Any ticker-bearing open feeds the Recents rail — recorded here
        // so every path (command bar, rail, panel drill-down) records
        // once, same as the web shell.
        if let t = ticker { recordTicker(t) }

        topZ += 1
        let pane = Pane(
            function: fn,
            ticker: fn.requires == "ticker" ? ticker : cmd.ticker,
            args: cmd.args,
            frame: nextFrame(w: fn.width, h: fn.height, in: bounds),
            z: topZ
        )
        panes.append(pane)
        focusedID = pane.id
        flash = nil
    }

    /// Cascade from the top-left, wrapping before a pane can open with its
    /// title bar off-screen — an unreachable window is the one bug that
    /// makes a floating layout feel broken rather than flexible.
    private func nextFrame(w: CGFloat, h: CGFloat, in bounds: CGSize) -> CGRect {
        let step: CGFloat = 26
        let n = CGFloat(panes.count)
        let maxX = max(bounds.width - w - 12, 12)
        let maxY = max(bounds.height - h - 12, 12)
        var x = 16 + step * n
        var y = 16 + step * n
        if x > maxX { x = 16 + fmod(x - 16, max(maxX - 16, 1)) }
        if y > maxY { y = 16 + fmod(y - 16, max(maxY - 16, 1)) }
        return CGRect(x: x, y: y,
                      width: min(w, bounds.width - 24),
                      height: min(h, bounds.height - 24))
    }

    // MARK: Manipulation

    func focus(_ id: UUID) {
        topZ += 1
        if let i = panes.firstIndex(where: { $0.id == id }) {
            panes[i].z = topZ
            focusedID = id
        }
    }

    func close(_ id: UUID) {
        panes.removeAll { $0.id == id }
        if focusedID == id { focusedID = panes.max(by: { $0.z < $1.z })?.id }
    }

    func closeFocused() {
        if let id = focusedID { close(id) }
    }

    func closeAll() {
        panes.removeAll()
        focusedID = nil
    }

    func move(_ id: UUID, to origin: CGPoint, in bounds: CGSize) {
        guard let i = panes.firstIndex(where: { $0.id == id }) else { return }
        // Clamp so at least the header stays grabbable. Losing a window
        // behind the edge of the screen with no way to retrieve it is the
        // failure that makes people stop moving windows at all.
        let w = panes[i].frame.width
        let x = min(max(origin.x, -(w - 120)), bounds.width - 120)
        let y = min(max(origin.y, 0), bounds.height - 32)
        panes[i].frame.origin = CGPoint(x: x, y: y)
    }

    func resize(_ id: UUID, to size: CGSize) {
        guard let i = panes.firstIndex(where: { $0.id == id }) else { return }
        panes[i].frame.size = CGSize(width: max(size.width, 320),
                                     height: max(size.height, 180))
    }

    func toggleMinimize(_ id: UUID) {
        guard let i = panes.firstIndex(where: { $0.id == id }) else { return }
        panes[i].minimized.toggle()
    }

    /// Maximize/restore support — one write, no clamping, caller knows
    /// what it is doing.
    func setFrame(_ id: UUID, _ frame: CGRect) {
        guard let i = panes.firstIndex(where: { $0.id == id }) else { return }
        panes[i].frame = frame
    }

    /// Same pane, same ticker, different function — the titlebar
    /// switcher. Keeps position and size, which is the point: you built
    /// the layout, the content rotates within it.
    func switchFunction(_ id: UUID, to fnID: String) {
        guard let i = panes.firstIndex(where: { $0.id == id }),
              let fn = Registry.function(fnID) else { return }
        if fn.requires == "ticker", panes[i].ticker == nil, focusTicker == nil {
            flash = Flash(text: "\(fn.id) needs a ticker.", bad: true)
            return
        }
        panes[i].function = fn
        if fn.requires == "ticker", panes[i].ticker == nil {
            panes[i].ticker = focusTicker
        }
    }

    /// Detach a pane into a real macOS window. The pane leaves the
    /// in-shell workspace and the caller hands the seed to openWindow —
    /// from there the OS owns drag, resize, Mission Control, and (on
    /// current macOS) native tiling. This is the answer to "the fake
    /// windows feel weird": past a certain point you stop imitating
    /// windows and use the real ones.
    func popOut(_ id: UUID) -> PaneSeed? {
        guard let pane = panes.first(where: { $0.id == id }) else { return nil }
        close(id)
        return PaneSeed(function: pane.function.id, ticker: pane.ticker, args: pane.args)
    }

    // MARK: Favorites and recents
    //
    // Mirrors the web rail: favorites are (function, ticker) pairs you
    // pinned; recents are the tickers you actually opened, newest first.
    // Persisted in UserDefaults — this is preference data, not a
    // credential, so the Keychain would be ceremony.

    struct Favorite: Codable, Equatable, Identifiable {
        var fn: String
        var ticker: String?
        var id: String { "\(fn)|\(ticker ?? "")" }
    }

    @Published var favorites: [Favorite] = [] { didSet { savePrefs() } }
    @Published var recents: [String] = [] { didSet { savePrefs() } }

    private static let prefsKey = "terminalPrefs.v1"

    func loadPrefs() {
        guard let data = UserDefaults.standard.data(forKey: Self.prefsKey),
              let obj = try? JSONDecoder().decode(Prefs.self, from: data) else { return }
        favorites = obj.favorites
        recents = obj.recents
    }

    private struct Prefs: Codable {
        var favorites: [Favorite]
        var recents: [String]
    }

    private func savePrefs() {
        let obj = Prefs(favorites: favorites, recents: recents)
        if let data = try? JSONEncoder().encode(obj) {
            UserDefaults.standard.set(data, forKey: Self.prefsKey)
        }
    }

    func recordTicker(_ t: String) {
        var r = recents.filter { $0 != t }
        r.insert(t, at: 0)
        recents = Array(r.prefix(8))
    }

    func isFavorite(_ fn: String, _ ticker: String?) -> Bool {
        favorites.contains { $0.fn == fn && $0.ticker == ticker }
    }

    func toggleFavorite(_ fn: String, _ ticker: String?) {
        if let i = favorites.firstIndex(where: { $0.fn == fn && $0.ticker == ticker }) {
            favorites.remove(at: i)
        } else {
            favorites.append(Favorite(fn: fn, ticker: ticker))
        }
    }

    /// Tile everything visible. Not the default arrangement, but the
    /// escape hatch when a workspace has got away from you.
    func tile(in bounds: CGSize) {
        let visible = panes.indices.filter { !panes[$0].minimized }
        guard !visible.isEmpty else { return }
        let cols = Int(ceil(sqrt(Double(visible.count))))
        let rows = Int(ceil(Double(visible.count) / Double(cols)))
        let w = (bounds.width - 8) / CGFloat(cols) - 8
        let h = (bounds.height - 8) / CGFloat(rows) - 8
        for (n, i) in visible.enumerated() {
            let c = n % cols, r = n / cols
            panes[i].frame = CGRect(
                x: 8 + CGFloat(c) * (w + 8),
                y: 8 + CGFloat(r) * (h + 8),
                width: w, height: h
            )
        }
    }
}
