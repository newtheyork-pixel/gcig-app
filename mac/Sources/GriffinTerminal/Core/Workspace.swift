import SwiftUI

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

        static func == (a: Pane, b: Pane) -> Bool { a.id == b.id && a.frame == b.frame && a.z == b.z && a.minimized == b.minimized }
    }

    private var topZ = 0

    // MARK: Opening

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
