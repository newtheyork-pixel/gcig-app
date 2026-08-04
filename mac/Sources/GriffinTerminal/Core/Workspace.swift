import SwiftUI
import AppKit

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
    // Every committed change autosaves the arrangement. Gestures only
    // write the model on release, so this is once per drag, not per
    // frame.
    @Published var panes: [Pane] = [] { didSet { autosaveCurrent() } }
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
        let raw = input.trimmingCharacters(in: .whitespaces).uppercased()

        // Number <GO>: a bare number activates the focused pane's
        // numbered menu row, Bloomberg's oldest navigation idiom.
        if let n = Int(raw), runNumber(n) { return }

        // A bare ticker no longer jumps straight to DES. On Bloomberg,
        // loading a security WITHOUT a function opens the menu of
        // everything you can do with it — the single best
        // discoverability move the terminal has, and the one a student
        // needs most. Explicit \"AIT DES\" still goes straight there.
        if !raw.contains(" "), Parser.looksLikeTicker(raw), !Registry.ids.contains(raw) {
            open(Command(ticker: raw, function: "SMENU", args: nil), in: bounds)
            return
        }

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

        // HELP twice — Bloomberg's most famous keystroke reaches their
        // help desk. Ours reaches the AI desk first: the chat panel,
        // which already knows the workspace. Humans are the escalation,
        // not the front line — the chat's own intro says where to mail
        // when it cannot help.
        if fn.id == "HELP",
           let f = panes.first(where: { $0.id == focusedID }),
           f.function.id == "HELP" {
            retarget(f.id, fn: "BI")
            flash = Flash(text: "The AI desk. Still stuck after asking? Mail wseirer@gcschool.org.", bad: false)
            return
        }

        // Sticky security, Bloomberg's state model: the FOCUSED pane's
        // loaded security wins over the global focus ticker, so a bare
        // GP typed while a CHRW pane is focused charts CHRW even if the
        // last thing loaded anywhere was AAPL.
        let paneTicker = panes.first(where: { $0.id == focusedID })?.ticker
        let ticker = cmd.ticker ?? paneTicker ?? focusTicker

        if fn.requires == "ticker", ticker == nil {
            flash = Flash(text: "\(fn.id) needs a ticker. Try  AIT \(fn.id)", bad: true)
            return
        }

        if fn.planned {
            flash = Flash(text: "\(fn.id) — \(fn.help) Planned for Phase 2, not built yet.", bad: false)
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
        recordHistory(fn.id, pane.ticker)
    }

    // MARK: LAST — the recall stack

    struct HistoryEntry: Codable, Equatable {
        var fn: String
        var ticker: String?
    }

    /// The last eight screens, Bloomberg's LAST. Deduplicated so
    /// bouncing between two panes does not fill all eight slots with
    /// the same pair.
    @Published private(set) var history: [HistoryEntry] = []

    func recordHistory(_ fn: String, _ ticker: String?) {
        guard !["HELP", "SMENU", "MAIN", "LAST"].contains(fn) else { return }
        let e = HistoryEntry(fn: fn, ticker: ticker)
        history.removeAll { $0 == e }
        history.insert(e, at: 0)
        history = Array(history.prefix(8))
        pushNav(e)
    }

    // MARK: Back and forward
    //
    // `history` is the LAST list: deduplicated, capped at eight, ordered
    // by recency. That is the right shape for "show me where I have
    // been" and the wrong one for a back button, which needs to keep
    // duplicates and needs an order that survives revisiting. So the
    // navigation stack is its own thing.
    //
    // Going back must not itself be recorded as a move, or back becomes
    // a loop between the last two screens — hence the guard flag.
    @Published private(set) var navStack: [HistoryEntry] = []
    @Published private(set) var navIndex: Int = -1
    private var navigating = false

    private func pushNav(_ e: HistoryEntry) {
        guard !navigating else { return }
        // A new move truncates anything ahead of the cursor, the way a
        // browser does: the forward path is only meaningful until you
        // choose a different one.
        if navIndex >= 0 && navIndex < navStack.count - 1 {
            navStack = Array(navStack.prefix(navIndex + 1))
        }
        if navStack.last != e { navStack.append(e) }
        navStack = Array(navStack.suffix(40))
        navIndex = navStack.count - 1
    }

    var canGoBack: Bool { navIndex > 0 }
    var canGoForward: Bool { navIndex >= 0 && navIndex < navStack.count - 1 }

    func goBack() {
        guard canGoBack else { return }
        navIndex -= 1
        replay(navStack[navIndex])
    }

    func goForward() {
        guard canGoForward else { return }
        navIndex += 1
        replay(navStack[navIndex])
    }

    /// Reuse the focused pane rather than spawning another. Back that
    /// opens a new window is not back.
    private func replay(_ e: HistoryEntry) {
        navigating = true
        defer { navigating = false }
        if let id = focusedID, panes.contains(where: { $0.id == id }) {
            retarget(id, fn: e.fn, ticker: .some(e.ticker))
        } else {
            open(Command(ticker: e.ticker, function: e.fn, args: nil))
        }
    }

    // MARK: Retarget — same pane, new security or function

    /// The Bloomberg panel model: content rotates inside the frame you
    /// arranged. Used by the security menu (pick a function, the menu
    /// pane BECOMES it), the header's recents dropdown, and Number <GO>.
    func retarget(_ id: UUID, fn fnID: String? = nil, ticker: String?? = .none) {
        guard let i = panes.firstIndex(where: { $0.id == id }) else { return }
        if let fnID, let fn = Registry.function(fnID), fn.native {
            panes[i].function = fn
        }
        if case .some(let t) = ticker {
            panes[i].ticker = t
            if let t { focusTicker = t; recordTicker(t) }
        }
        if panes[i].function.requires == "ticker", panes[i].ticker == nil {
            panes[i].ticker = focusTicker
        }
        recordHistory(panes[i].function.id, panes[i].ticker)
        focus(id)
    }

    // MARK: Number <GO>

    /// The focused pane's numbered rows. Menu-style panels publish
    /// theirs; the command line resolves a bare number against them.
    /// Keyed to the pane so a stale menu from an unfocused pane can
    /// never swallow a number meant for the one in front.
    struct NumberedMenu {
        var paneID: UUID
        var actions: [Int: () -> Void]
    }
    var numberedMenu: NumberedMenu?

    @discardableResult
    func runNumber(_ n: Int) -> Bool {
        guard let m = numberedMenu, m.paneID == focusedID, let act = m.actions[n] else { return false }
        act()
        return true
    }

    func publishNumbers(for paneID: UUID, _ actions: [Int: () -> Void]) {
        numberedMenu = NumberedMenu(paneID: paneID, actions: actions)
    }

    /// Which pane currently owns the digits. Exposed so a panel can tell
    /// whether the map still belongs to it before clearing on the way out
    /// — otherwise closing an old pane wipes the numbers a newer one just
    /// published, and Number <GO> silently stops working.
    var numbersOwner: UUID? { numberedMenu?.paneID }

    func clearNumbers(for paneID: UUID) {
        if numberedMenu?.paneID == paneID { numberedMenu = nil }
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

    /// ⌘1…⌘9 — Launchpad-style: panes numbered by the order they were
    /// opened, not by stacking, so the number a pane answers to does not
    /// change every time something else is clicked.
    func focusPane(index: Int) {
        guard panes.indices.contains(index) else { return }
        focus(panes[index].id)
    }

    /// The two-stroke Escape from the web shell: first press selects the
    /// top pane, second press closes it. Clicking elsewhere re-arms
    /// naturally because focus moves.
    var escapeArmedID: UUID?
    func escapePressed() {
        guard let top = panes.max(by: { $0.z < $1.z }) else { return }
        if escapeArmedID == focusedID, let id = focusedID {
            close(id)
            escapeArmedID = nil
        } else {
            focus(top.id)
            escapeArmedID = top.id
        }
    }

    func closeAll() {
        panes.removeAll()
        focusedID = nil
    }

    /// Clamp so at least the header stays grabbable. Losing a window
    /// behind the edge of the screen with no way to retrieve it is the
    /// failure that makes people stop moving windows at all.
    ///
    /// Static and pure because PaneWindow runs this on every frame of a
    /// live drag: the preview must clamp with EXACTLY the rule the
    /// commit will use, and one shared function is the only version of
    /// "exactly" that survives maintenance.
    nonisolated static func clampOrigin(_ origin: CGPoint,
                                        paneWidth w: CGFloat,
                                        in bounds: CGSize) -> CGPoint {
        CGPoint(x: min(max(origin.x, -(w - 120)), bounds.width - 120),
                y: min(max(origin.y, 0), bounds.height - 32))
    }

    /// Re-seat every pane inside a canvas that just changed size.
    ///
    /// Panes carry absolute frames, so resizing or zooming the window
    /// left them exactly where they were — and the canvas clips, so a
    /// pane that ended up past the new right edge was not merely
    /// awkward, it was gone, with no titlebar left to drag it back by.
    /// Sizes are deliberately untouched: shrinking panes to fit would
    /// make every window resize destructive, and a pane wider than the
    /// canvas is readable by scrolling. Only the origin moves, and only
    /// when it has to.
    func clampAll(to bounds: CGSize) {
        guard bounds.width > 0, bounds.height > 0 else { return }
        for i in panes.indices {
            panes[i].frame.origin = Self.clampOrigin(panes[i].frame.origin,
                                                     paneWidth: panes[i].frame.width,
                                                     in: bounds)
        }
    }

    func move(_ id: UUID, to origin: CGPoint, in bounds: CGSize) {
        guard let i = panes.firstIndex(where: { $0.id == id }) else { return }
        let w = panes[i].frame.width
        panes[i].frame.origin = Self.clampOrigin(origin, paneWidth: w, in: bounds)
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

    // MARK: Layout persistence
    //
    // The web deliberately forgets a session's arrangement when the tab
    // closes. A native app should not: Bloomberg's Launchpad treats the
    // arranged screen as a work product you come back to, and that is
    // the right model here too. The current workspace autosaves on
    // every committed change, restores on launch, and can be pinned
    // under a name — "earnings day", "CHRW work" — from the Layouts
    // menu.

    struct PaneSnapshot: Codable {
        var function: String
        var ticker: String?
        var args: String?
        var x: Double, y: Double, w: Double, h: Double
        var minimized: Bool
    }

    @Published private(set) var layoutNames: [String] = []

    private static let currentKey = "workspace.current.v1"
    private static let layoutsKey = "workspace.layouts.v1"
    private var restoring = false

    func snapshot() -> [PaneSnapshot] {
        panes.sorted { $0.z < $1.z }.map {
            PaneSnapshot(function: $0.function.id, ticker: $0.ticker, args: $0.args,
                         x: $0.frame.origin.x, y: $0.frame.origin.y,
                         w: $0.frame.width, h: $0.frame.height,
                         minimized: $0.minimized)
        }
    }

    func autosaveCurrent() {
        guard !restoring else { return }
        if let data = try? JSONEncoder().encode(snapshot()) {
            UserDefaults.standard.set(data, forKey: Self.currentKey)
        }
    }

    /// Restore an arrangement. Functions that no longer exist or are
    /// still web-only are skipped and SAID — a layout that silently
    /// comes back smaller reads as data loss.
    func restore(_ snaps: [PaneSnapshot]) {
        restoring = true
        defer { restoring = false; autosaveCurrent() }
        panes.removeAll()
        var skipped: [String] = []
        for s in snaps {
            guard let fn = Registry.function(s.function), fn.native else {
                skipped.append(s.function)
                continue
            }
            topZ += 1
            panes.append(Pane(function: fn, ticker: s.ticker, args: s.args,
                              frame: CGRect(x: s.x, y: s.y, width: s.w, height: s.h),
                              z: topZ, minimized: s.minimized))
        }
        focusedID = panes.max(by: { $0.z < $1.z })?.id
        if let t = panes.compactMap(\.ticker).last { focusTicker = t }
        if !skipped.isEmpty {
            flash = Flash(text: "Restored \(panes.count) panes. Skipped (web-only): \(skipped.joined(separator: ", ")).", bad: false)
        }
    }

    func restoreCurrentIfEmpty() {
        guard panes.isEmpty,
              let data = UserDefaults.standard.data(forKey: Self.currentKey),
              let snaps = try? JSONDecoder().decode([PaneSnapshot].self, from: data),
              !snaps.isEmpty else { return }
        restore(snaps)
    }

    private func loadLayouts() -> [String: [PaneSnapshot]] {
        guard let data = UserDefaults.standard.data(forKey: Self.layoutsKey),
              let m = try? JSONDecoder().decode([String: [PaneSnapshot]].self, from: data) else { return [:] }
        return m
    }

    private func storeLayouts(_ m: [String: [PaneSnapshot]]) {
        if let data = try? JSONEncoder().encode(m) {
            UserDefaults.standard.set(data, forKey: Self.layoutsKey)
        }
        layoutNames = m.keys.sorted()
    }

    func refreshLayoutNames() { layoutNames = loadLayouts().keys.sorted() }

    func saveLayout(named name: String) {
        var m = loadLayouts()
        m[name] = snapshot()
        storeLayouts(m)
        flash = Flash(text: "Layout \"\(name)\" saved (\(panes.count) panes).", bad: false)
    }

    func loadLayout(named name: String) {
        guard let snaps = loadLayouts()[name] else { return }
        restore(snaps)
    }

    func deleteLayout(named name: String) {
        var m = loadLayouts()
        m.removeValue(forKey: name)
        storeLayouts(m)
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
    // MARK: Second display

    /// Is there anywhere to send a window?
    ///
    /// The button is hidden when there is not. A control that opens a
    /// window onto a display you do not have is a control that loses
    /// your panel somewhere off-canvas.
    var hasSecondScreen: Bool { NSScreen.screens.count > 1 }

    /// The seed for whatever is focused, so the second monitor opens
    /// with the thing you were looking at rather than a blank frame.
    var focusedSeed: PaneSeed? {
        guard let p = panes.first(where: { $0.id == focusedID }) ?? panes.last else { return nil }
        return PaneSeed(function: p.function.id, ticker: p.ticker, args: p.args)
    }

    /// Move the newest popped-out window to the other display.
    ///
    /// SwiftUI's openWindow gives no handle on what it created, so the
    /// window is found afterwards: the frontmost one that is not the
    /// main shell. Deferred a beat because it does not exist yet at the
    /// moment openWindow returns.
    func placeNewestOnSecondScreen() {
        guard hasSecondScreen else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            let main = NSApp.mainWindow
            let target = NSApp.windows.first {
                $0 !== main && $0.isVisible && $0.contentView != nil
                    && $0.frame.width > 200 && $0.level == .normal
            }
            guard let w = target else { return }
            let here = main?.screen ?? NSScreen.screens.first
            guard let other = NSScreen.screens.first(where: { $0 !== here }) else { return }
            w.setFrame(other.visibleFrame.insetBy(dx: 60, dy: 60), display: true)
            w.makeKeyAndOrderFront(nil)
        }
    }

}
