import SwiftUI

// One floating panel: header, body, drag, resize.
//
// The header is the drag handle and the whole affordance, so it carries
// the title, the focus state, and the two controls. Bloomberg's panes
// are chrome-light and information-dense; a macOS titlebar with a traffic
// light per panel would eat the density this is for.
struct PaneWindow: View {
    @EnvironmentObject var ws: Workspace
    let pane: Workspace.Pane
    let bounds: CGSize

    @State private var dragOrigin: CGPoint?
    @State private var resizeStart: CGSize?

    private var focused: Bool { ws.focusedID == pane.id }

    var body: some View {
        VStack(spacing: 0) {
            header
            if !pane.minimized {
                PanelHost(pane: pane)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .clipped()
            }
        }
        .frame(width: pane.frame.width,
               height: pane.minimized ? 26 : pane.frame.height)
        .termPanelBackground()
        .termBorder(focused: focused)
        .shadow(color: .black.opacity(focused ? 0.55 : 0.3),
                radius: focused ? 14 : 6, y: focused ? 6 : 3)
        .overlay(alignment: .bottomTrailing) {
            if !pane.minimized { resizeGrip }
        }
        .position(x: pane.frame.midX,
                  y: pane.frame.origin.y + (pane.minimized ? 13 : pane.frame.height / 2))
        .zIndex(Double(pane.z))
        .onTapGesture { ws.focus(pane.id) }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(pane.title)
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(focused ? Term.white : Term.fgDim)
                .lineLimit(1)
            Spacer(minLength: 8)
            btn(pane.minimized ? "+" : "\u{2013}") { ws.toggleMinimize(pane.id) }
            btn("\u{00D7}") { ws.close(pane.id) }
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
        .background(focused ? Term.bgHeader : Term.bgPanel)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Term.border).frame(height: 1)
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(coordinateSpace: .named("workspace"))
                .onChanged { g in
                    if dragOrigin == nil {
                        dragOrigin = pane.frame.origin
                        ws.focus(pane.id)
                    }
                    guard let o = dragOrigin else { return }
                    ws.move(pane.id,
                            to: CGPoint(x: o.x + g.translation.width,
                                        y: o.y + g.translation.height),
                            in: bounds)
                }
                .onEnded { _ in dragOrigin = nil }
        )
    }

    private func btn(_ glyph: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(glyph)
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.fgDim)
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
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
        .padding(2)
        .contentShape(Rectangle())
        .onHover { $0 ? NSCursor.crosshair.push() : NSCursor.pop() }
        .gesture(
            DragGesture()
                .onChanged { g in
                    if resizeStart == nil {
                        resizeStart = pane.frame.size
                        ws.focus(pane.id)
                    }
                    guard let s = resizeStart else { return }
                    ws.resize(pane.id, to: CGSize(width: s.width + g.translation.width,
                                                  height: s.height + g.translation.height))
                }
                .onEnded { _ in resizeStart = nil }
        )
    }
}

/// Routes a pane to its panel. One place to add a function, mirroring the
/// registry on the web.
struct PanelHost: View {
    let pane: Workspace.Pane

    var body: some View {
        switch pane.function.id {
        case "DES":  DescriptionPanel(ticker: pane.ticker ?? "")
        case "PM":   PortfolioPanel()
        case "MOVR": MoversPanel()
        case "TOP":  TopNewsPanel()
        case "RSCH": ResearchPanel(ticker: pane.ticker)
        case "HELP": HelpPanel()
        default:
            PanelMessage(text: "\(pane.function.id) has no native panel yet.", bad: true)
        }
    }
}
