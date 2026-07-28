import SwiftUI

// One floating panel: header, body, drag, resize.
//
// The header is the drag handle and the whole affordance, so it carries
// the title, the focus state, and the controls. Bloomberg's panes are
// chrome-light and information-dense; a macOS titlebar with traffic
// lights per pane would eat the density this exists for. A pane that
// wants real OS chrome has the pop-out button, which promotes it to an
// actual window.
//
// THE DRAG MUST BE CHEAP. The first version wrote every mouse move into
// the shared Workspace model, which invalidated every pane on every
// frame — the "weird, can't really move the windows" feel was thirty
// panes re-rendering at 120Hz. Now the in-flight offset lives in local
// @State (only this pane re-renders while it moves) and the model is
// written exactly once, on release. Snapping happens at commit for the
// same reason: guidance during the gesture is not worth the churn.
struct PaneWindow: View {
    @EnvironmentObject var ws: Workspace
    let pane: Workspace.Pane
    let bounds: CGSize
    var onPopout: (PaneSeed) -> Void = { _ in }

    @State private var dragOffset: CGSize = .zero
    @State private var resizeDelta: CGSize = .zero
    /// The frame to restore after un-maximizing. Nil when not maximized.
    @State private var restoreFrame: CGRect?

    private var focused: Bool { ws.focusedID == pane.id }

    /// Frame including any in-flight gesture, which is what actually
    /// paints. The model's frame is the committed truth.
    private var liveFrame: CGRect {
        CGRect(
            x: pane.frame.origin.x + dragOffset.width,
            y: pane.frame.origin.y + dragOffset.height,
            width: max(pane.frame.width + resizeDelta.width, 340),
            height: max(pane.frame.height + resizeDelta.height, 200)
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if !pane.minimized {
                PanelHost(pane: pane)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .clipped()
            }
        }
        .frame(width: liveFrame.width,
               height: pane.minimized ? 25 : liveFrame.height)
        .termPanelBackground()
        .termBorder(focused: focused)
        .shadow(color: .black.opacity(focused ? 0.55 : 0.3),
                radius: focused ? 16 : 7, y: focused ? 7 : 3)
        .overlay(alignment: .bottomTrailing) {
            if !pane.minimized { resizeGrip }
        }
        .position(x: liveFrame.midX,
                  y: liveFrame.origin.y + (pane.minimized ? 12.5 : liveFrame.height / 2))
        .zIndex(Double(pane.z))
        .onTapGesture { ws.focus(pane.id) }
        .animation(nil, value: liveFrame)
    }

    // MARK: Header

    private var title: some View {
        // The web renders "AIT · DES · Description"; ticker and code in
        // amber, the label dimmer. Mirrored so the two products read as
        // one.
        HStack(spacing: 5) {
            if let t = pane.ticker {
                Text(t).foregroundStyle(focused ? Term.amber : Term.fgDim)
                Text("·").foregroundStyle(Term.fgMuted)
            }
            Text(pane.function.id).foregroundStyle(focused ? Term.amber : Term.fgDim)
            Text("·").foregroundStyle(Term.fgMuted)
            Text(pane.function.label.uppercased())
                .foregroundStyle(focused ? Term.white : Term.fgMuted)
                .lineLimit(1)
        }
        .font(Term.mono(10, weight: .medium))
    }

    private var header: some View {
        HStack(spacing: 6) {
            title
            Spacer(minLength: 8)

            // Star pins this (function, ticker) to the rail, same as the
            // web titlebar.
            btn(ws.isFavorite(pane.function.id, pane.ticker) ? "★" : "☆",
                help: "Pin to favorites") {
                ws.toggleFavorite(pane.function.id, pane.ticker)
            }
            .foregroundStyle(ws.isFavorite(pane.function.id, pane.ticker) ? Term.amber : Term.fgMuted)

            // Function switcher: same pane, same ticker, different
            // function — the web titlebar's dropdown.
            Menu {
                ForEach(Registry.all.filter(\.native)) { f in
                    Button("\(f.id) · \(f.label)") {
                        ws.switchFunction(pane.id, to: f.id)
                    }
                }
            } label: {
                Text("⌄").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.fgDim)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 18)
            .help("Switch function")

            btn("⧉", help: "Pop out to its own window") {
                if let seed = ws.popOut(pane.id) { onPopout(seed) }
            }
            btn(pane.minimized ? "+" : "\u{2013}", help: pane.minimized ? "Restore" : "Minimize") {
                ws.toggleMinimize(pane.id)
            }
            btn("\u{00D7}", help: "Close (⌘W)") { ws.close(pane.id) }
        }
        .padding(.horizontal, 8)
        .frame(height: 25)
        .background(focused ? Term.bgHeader : Term.bgPanel)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Term.border).frame(height: 1)
        }
        .contentShape(Rectangle())
        .gesture(dragGesture)
        .simultaneousGesture(
            TapGesture(count: 2).onEnded { toggleMaximize() }
        )
    }

    private func btn(_ glyph: String, help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(glyph)
                .font(Term.mono(11, weight: .bold))
                .frame(width: 17, height: 17)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Term.fgDim)
        .help(help)
    }

    // MARK: Gestures

    private var dragGesture: some Gesture {
        // The coordinate space is the whole fix. A DragGesture defaults
        // to LOCAL space — the pane's own — and this pane MOVES by the
        // gesture's translation, so each frame re-measures against a
        // view that just shifted underneath the cursor: a feedback loop
        // that reads as jitter. Measuring in the workspace's space makes
        // the translation absolute and the drag glassy.
        DragGesture(minimumDistance: 2, coordinateSpace: .named("workspace"))
            .onChanged { g in
                if dragOffset == .zero { ws.focus(pane.id) }
                dragOffset = g.translation
            }
            .onEnded { g in
                dragOffset = .zero
                var origin = CGPoint(x: pane.frame.origin.x + g.translation.width,
                                     y: pane.frame.origin.y + g.translation.height)
                origin = snapped(origin)
                ws.move(pane.id, to: origin, in: bounds)
                restoreFrame = nil
            }
    }

    private var resizeGrip: some View {
        Path { p in
            for i in stride(from: 2, through: 10, by: 4) {
                p.move(to: CGPoint(x: 12, y: CGFloat(i)))
                p.addLine(to: CGPoint(x: CGFloat(i), y: 12))
            }
        }
        .stroke(Term.fgMuted, lineWidth: 1)
        .frame(width: 14, height: 14)
        .padding(3)
        .contentShape(Rectangle())
        .gesture(
            // Workspace space for the same reason as the drag: the grip
            // sits on the corner being moved, so local space feeds back.
            DragGesture(minimumDistance: 1, coordinateSpace: .named("workspace"))
                .onChanged { g in
                    if resizeDelta == .zero { ws.focus(pane.id) }
                    resizeDelta = g.translation
                }
                .onEnded { g in
                    resizeDelta = .zero
                    ws.resize(pane.id, to: CGSize(width: pane.frame.width + g.translation.width,
                                                  height: pane.frame.height + g.translation.height))
                    restoreFrame = nil
                }
        )
    }

    /// Magnetic edges, applied once at release. Workspace borders first,
    /// then other panes' edges — the thing that makes a hand-arranged
    /// grid actually line up instead of being two pixels off everywhere.
    private func snapped(_ origin: CGPoint) -> CGPoint {
        let snap: CGFloat = 10
        var p = origin
        let w = pane.frame.width
        let h = pane.frame.height

        // Workspace edges.
        if abs(p.x - 8) < snap { p.x = 8 }
        if abs(p.y - 8) < snap { p.y = 8 }
        if abs((p.x + w) - (bounds.width - 8)) < snap { p.x = bounds.width - 8 - w }
        if abs((p.y + h) - (bounds.height - 8)) < snap { p.y = bounds.height - 8 - h }

        // Sibling edges: left/right to their left/right, top/bottom to
        // their top/bottom.
        for other in ws.panes where other.id != pane.id {
            let f = other.frame
            for edge in [f.minX, f.maxX] {
                if abs(p.x - edge) < snap { p.x = edge }
                if abs((p.x + w) - edge) < snap { p.x = edge - w }
            }
            for edge in [f.minY, f.maxY] {
                if abs(p.y - edge) < snap { p.y = edge }
                if abs((p.y + h) - edge) < snap { p.y = edge - h }
            }
        }
        return p
    }

    private func toggleMaximize() {
        if let back = restoreFrame {
            ws.setFrame(pane.id, back)
            restoreFrame = nil
        } else {
            restoreFrame = pane.frame
            ws.setFrame(pane.id, CGRect(x: 8, y: 8,
                                        width: bounds.width - 16,
                                        height: bounds.height - 16))
        }
        ws.focus(pane.id)
    }
}

/// Routes a pane to its panel. One place to add a function, mirroring the
/// registry on the web.
struct PanelHost: View {
    let pane: Workspace.Pane

    var body: some View {
        PanelRouter(functionID: pane.function.id, ticker: pane.ticker, args: pane.args)
    }
}

/// The single switchboard from mnemonic to SwiftUI view, shared by
/// in-shell panes and popped-out windows so the two can never disagree
/// about what a code renders.
struct PanelRouter: View {
    let functionID: String
    let ticker: String?
    let args: String?

    var body: some View {
        switch functionID {
        case "DES":  DescriptionPanel(ticker: ticker ?? "")
        case "PM":   PortfolioPanel()
        case "MOVR": MoversPanel()
        case "TOP":  TopNewsPanel()
        case "RSCH", "FLD": ResearchPanel(ticker: ticker)
        case "HELP": HelpPanel()
        case "GP":   ChartPanel(ticker: ticker ?? "")
        case "GIP":  IntradayPanel(ticker: ticker ?? "")
        case "CN":   CompanyNewsPanel(ticker: ticker ?? "")
        case "FA":   FinancialsPanel(ticker: ticker ?? "")
        case "GF":   FundamentalsPanel(ticker: ticker ?? "")
        case "PEER": PeersPanel(ticker: ticker ?? "")
        case "EARN": EarningsPanel(ticker: ticker ?? "")
        case "CON":  ConsensusPanel(ticker: ticker ?? "")
        case "WEI":  WorldIndicesPanel()
        case "FIL":  FilingsPanel(ticker: ticker ?? "")
        case "BI":   IntelligencePanel(ticker: ticker)
        case "CMP":  ComparePanel(initial: [ticker, args].compactMap { $0 }.joined(separator: " "))
        case "INSDR": InsiderPanel(ticker: ticker ?? "")
        case "MGMT": GovernancePanel(ticker: ticker ?? "")
        case "SPLC": SupplyChainPanel(ticker: ticker ?? "")
        case "ARCH": ArchivePanel(ticker: ticker)
        case "NOTE": NotesPanel(ticker: ticker ?? "")
        case "MACRO": MacroPanel()
        case "WX":   WeatherImpactPanel()
        case "ICLUSTER": InsiderClustersPanel()
        case "RDR":  RadarPanel()
        case "ORG":  OrganizationPanel()
        case "ECO":
            // Coming Soon on the web too — saying "works on the web"
            // here would be a lie in the other direction.
            PanelMessage(text: "Economic calendar is not built yet — on the web either.")
        default:
            PanelMessage(text: "\(functionID) has no native panel yet.", bad: true)
        }
    }
}