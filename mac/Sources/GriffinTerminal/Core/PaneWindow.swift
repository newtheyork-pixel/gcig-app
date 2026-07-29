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
// @GestureState (only this pane re-renders while it moves) and the
// model is written exactly once, on release.
//
// @GestureState rather than @State because gestures CANCEL — Escape, a
// window deactivating, the system stealing the event stream — and a
// cancelled gesture never runs onEnded. A manually-reset @State offset
// would strand the pane wherever the cursor last was, painted at a
// position the model has never heard of. @GestureState resets itself on
// any end, clean or not, so the pane falls back to committed truth.
//
// The preview is also the contract: everything the release will do to
// the frame — clamp to the canvas, snap to edges — is applied to the
// live frame too, per frame. The first cut deferred both to commit,
// which let a pane slide under the .clipped() canvas edge and then
// JUMP back on release. Cheap enough: a handful of panes, arithmetic
// only.
struct PaneWindow: View {
    @EnvironmentObject var ws: Workspace
    let pane: Workspace.Pane
    let bounds: CGSize
    var onPopout: (PaneSeed) -> Void = { _ in }

    @GestureState private var dragOffset: CGSize = .zero
    @GestureState private var resizeDelta: CGSize = .zero
    /// The frame to restore after un-maximizing. Nil when not maximized.
    @State private var restoreFrame: CGRect?

    private var focused: Bool { ws.focusedID == pane.id }

    /// Frame including any in-flight gesture, which is what actually
    /// paints. The model's frame is the committed truth, and the whole
    /// point of this computation is that release changes nothing: the
    /// clamp and the snap the commit will apply are already applied
    /// here, so the last previewed frame IS the committed frame.
    private var liveFrame: CGRect {
        let w = max(pane.frame.width + resizeDelta.width, 340)
        let h = max(pane.frame.height + resizeDelta.height, 200)
        // Only run snap/clamp mid-drag. At rest the committed origin is
        // already legal, and re-deriving it could disagree with the
        // model by a snap threshold — the pane would twitch on commit.
        let origin = dragOffset == .zero
            ? pane.frame.origin
            : dragOrigin(for: dragOffset)
        return CGRect(x: origin.x, y: origin.y, width: w, height: h)
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
        // A pane is a wall, and until now it was a suggestion. Content
        // whose natural size exceeds the pane does not compress — a
        // twelve-column table in a 449pt pane simply drew straight
        // through the border and over its neighbours, so the chrome sat
        // at one size and the numbers at another. .clipped() INSIDE the
        // panel could never fix that: it clips to the content's own
        // overflowing bounds. It has to be here, against the fixed
        // frame, which is the only view in the stack that knows how big
        // the pane actually is.
        .clipped()
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
                // The loaded security is a dropdown of recents: pick a
                // ticker and THIS pane retargets in place, keeping the
                // function — the Bloomberg panel model.
                Menu {
                    ForEach(ws.recents.filter { $0 != t }, id: \.self) { r in
                        Button(r) { ws.retarget(pane.id, ticker: .some(r)) }
                    }
                } label: {
                    Text(t).foregroundStyle(focused ? Term.amber : Term.fgDim)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
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
        // simultaneousGesture is deliberate: composing the double-click
        // exclusively-before the drag would make every drag wait out
        // the double-click interval before its first frame — the exact
        // sluggishness this pane cannot afford. Run together, the tap
        // costs the drag nothing (a drag past 2pt is no longer a tap),
        // and a genuine double-click involves no drag to collide with.
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

    /// Where a drag translation puts the pane, snap and clamp included.
    /// The single source for BOTH the live preview and the commit — two
    /// copies of this arithmetic is exactly how a pane learns to jump
    /// on release.
    private func dragOrigin(for translation: CGSize) -> CGPoint {
        let raw = CGPoint(x: pane.frame.origin.x + translation.width,
                          y: pane.frame.origin.y + translation.height)
        return Workspace.clampOrigin(snapped(raw),
                                     paneWidth: pane.frame.width,
                                     in: bounds)
    }

    private var dragGesture: some Gesture {
        // The coordinate space is half the fix. A DragGesture defaults
        // to LOCAL space — the pane's own — and this pane MOVES by the
        // gesture's translation, so each frame re-measures against a
        // view that just shifted underneath the cursor: a feedback loop
        // that reads as jitter. Measuring in the workspace's space makes
        // the translation absolute and the drag glassy.
        DragGesture(minimumDistance: 2, coordinateSpace: .named("workspace"))
            .updating($dragOffset) { g, state, _ in
                state = g.translation
            }
            // Focus rides onChanged, not a state sentinel — the old
            // "first change has offset zero" test broke the moment the
            // offset became @GestureState (updating runs first, so the
            // sentinel never fired). The guard keeps it one model write
            // per drag: focus() bumps z through @Published panes, and
            // doing that per frame is the re-render storm this whole
            // file exists to avoid.
            .onChanged { _ in
                if ws.focusedID != pane.id { ws.focus(pane.id) }
            }
            .onEnded { g in
                // Model first. @GestureState resets itself when the
                // gesture ends; committing the move in the same pass
                // means SwiftUI coalesces reset + new frame into one
                // render and no frame ever paints at the pre-drag spot.
                ws.move(pane.id, to: dragOrigin(for: g.translation), in: bounds)
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
                .updating($resizeDelta) { g, state, _ in
                    state = g.translation
                }
                .onChanged { _ in
                    if ws.focusedID != pane.id { ws.focus(pane.id) }
                }
                .onEnded { g in
                    // Floor at the SAME 340×200 the live preview uses.
                    // Workspace.resize's own floor is lower (320×180),
                    // so leaning on it let a small pane shrink 20pt on
                    // release, under what the drag had been showing.
                    ws.resize(pane.id, to: CGSize(
                        width: max(pane.frame.width + g.translation.width, 340),
                        height: max(pane.frame.height + g.translation.height, 200)))
                    restoreFrame = nil
                }
        )
    }

    /// Magnetic edges, applied to every live frame AND the commit —
    /// same function, so the pane you watched settle against an edge
    /// is the pane you get. Workspace borders first, then other panes'
    /// edges — the thing that makes a hand-arranged grid actually line
    /// up instead of being two pixels off everywhere.
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
        VStack(spacing: 0) {
            // The Bloomberg chrome contract: every function tops with
            // the red bar; every security function carries the two-line
            // quote banner under it. Menus skip the banner — they are
            // navigation, not analysis.
            FunctionBar(code: pane.function.id, label: pane.function.label)
            if pane.function.requires == "ticker",
               let t = pane.ticker,
               pane.function.id != "SMENU" {
                QuoteBanner(ticker: t)
            }
            PanelRouter(functionID: pane.function.id, ticker: pane.ticker,
                        args: pane.args, paneID: pane.id)
        }
    }
}

/// The single switchboard from mnemonic to SwiftUI view, shared by
/// in-shell panes and popped-out windows so the two can never disagree
/// about what a code renders.
struct PanelRouter: View {
    let functionID: String
    let ticker: String?
    let args: String?
    /// Nil in a popped-out window, whose seed UUID matches no workspace
    /// pane — the menus retarget panes, so out there they refuse
    /// honestly instead of publishing numbers into the void.
    var paneID: UUID? = nil

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
        case "SMENU":
            if let id = paneID, let t = ticker {
                SecurityMenuPanel(paneID: id, ticker: t)
            } else {
                PanelMessage(text: "The security menu lives in the main terminal window.")
            }
        case "MAIN":
            if let id = paneID {
                MainMenuPanel(paneID: id)
            } else {
                PanelMessage(text: "The main menu lives in the main terminal window.")
            }
        case "LAST":
            if let id = paneID {
                LastPanel(paneID: id)
            } else {
                PanelMessage(text: "LAST lives in the main terminal window.")
            }
        case "ECO":
            // Coming Soon on the web too — saying "works on the web"
            // here would be a lie in the other direction.
            PanelMessage(text: "Economic calendar is not built yet — on the web either.")
        default:
            PanelMessage(text: "\(functionID) has no native panel yet.", bad: true)
        }
    }
}