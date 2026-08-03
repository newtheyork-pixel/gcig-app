import SwiftUI

// The two rows Bloomberg puts above everything: what is open, and where
// you are.
//
// The panes float, which is the right model for comparing four things at
// once and the wrong one for answering "what have I got open". A window
// behind another window is invisible, and the only way back to it was to
// move the one in front. So the strip lists every pane whether or not
// you can see it.
//
// The label is the company, not the symbol. "MLAB · DES · DESCRIPTION"
// is three codes and no business; Bloomberg writes "ALPHABET INC-A
// Equity" because a screen holding six panes is a screen you scan, and a
// ticker is only legible to somebody who already knows what they opened.
struct TabStrip: View {
    @EnvironmentObject private var ws: Workspace
    @ObservedObject private var names = SecurityNames.shared

    var body: some View {
        VStack(spacing: 0) {
            tabs
            Divider().overlay(Term.border)
            breadcrumb
        }
        .background(Term.bgHeader)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    // MARK: Row one — what is open

    private var tabs: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    if ws.panes.isEmpty {
                        Text("NOTHING OPEN — type a ticker and a function, or press F1 for the menu")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                    }
                    ForEach(ws.panes) { pane in
                        tab(pane)
                            .id(pane.id)
                    }
                }
            }
            // A pane opened behind the fold is a pane nobody finds.
            .onChange(of: ws.focusedID) { _, id in
                guard let id else { return }
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(id, anchor: .center) }
            }
        }
        .frame(height: 26)
    }

    private func tab(_ pane: Workspace.Pane) -> some View {
        let on = ws.focusedID == pane.id
        return HStack(spacing: 6) {
            Text(pane.function.id)
                .font(Term.mono(9, weight: .bold)).tracking(0.5)
                .foregroundStyle(on ? Term.bg : Term.amber)
            Text(label(for: pane))
                .font(Term.mono(10))
                .foregroundStyle(on ? Term.bg : Term.fgDim)
                .lineLimit(1)
            // Closing from the strip matters more than it looks: a
            // minimised pane has no visible close button at all.
            Button {
                ws.close(pane.id)
            } label: {
                Text("✕")
                    .font(Term.mono(9))
                    .foregroundStyle(on ? Term.bg.opacity(0.7) : Term.fgMuted)
            }
            .buttonStyle(.plain)
            .help("Close this panel")
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(on ? Term.amber : Color.clear)
        .overlay(alignment: .trailing) {
            Rectangle().fill(Term.border).frame(width: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture { ws.focus(pane.id) }
        .help(pane.minimized ? "\(pane.title) — minimised" : pane.title)
    }

    /// The security, then the function's own name for the things that
    /// are not about one company. "TOP Top News" reads better than
    /// "TOP —".
    private func label(for pane: Workspace.Pane) -> String {
        if let t = pane.ticker, !t.isEmpty {
            return names.label(for: t) ?? t
        }
        return pane.function.label
    }

    // MARK: Row two — where you are

    private var breadcrumb: some View {
        HStack(spacing: 8) {
            Button { ws.goBack() } label: { Text("‹").font(Term.mono(13)) }
                .buttonStyle(.plain)
                .foregroundStyle(ws.canGoBack ? Term.fgDim : Term.fgMuted.opacity(0.4))
                .disabled(!ws.canGoBack)
                .help("Back to the previous screen")
            Button { ws.goForward() } label: { Text("›").font(Term.mono(13)) }
                .buttonStyle(.plain)
                .foregroundStyle(ws.canGoForward ? Term.fgDim : Term.fgMuted.opacity(0.4))
                .disabled(!ws.canGoForward)
                .help("Forward")

            Rectangle().fill(Term.border).frame(width: 1, height: 12)

            securityMenu
            Rectangle().fill(Term.border).frame(width: 1, height: 12)
            functionMenu
            Rectangle().fill(Term.border).frame(width: 1, height: 12)
            relatedMenu

            Spacer()
        }
        .padding(.horizontal, 10)
        .frame(height: 24)
    }

    /// Every security currently on screen, so switching the subject does
    /// not mean retyping it.
    private var securityMenu: some View {
        let tickers = Array(NSOrderedSet(array: ws.panes.compactMap { $0.ticker })) as? [String] ?? []
        let current = ws.panes.first { $0.id == ws.focusedID }?.ticker
        return Menu {
            if tickers.isEmpty {
                Text("No security open")
            }
            ForEach(tickers, id: \.self) { t in
                Button(names.label(for: t) ?? t) {
                    if let id = ws.focusedID { ws.retarget(id, ticker: .some(t)) }
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text(current.flatMap { names.label(for: $0) } ?? "No security")
                    .font(Term.mono(10)).foregroundStyle(Term.white).lineLimit(1)
                Text("▾").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Point the focused panel at another security you have open")
    }

    /// The focused pane's function, and the whole list to switch to.
    private var functionMenu: some View {
        let current = ws.panes.first { $0.id == ws.focusedID }?.function
        return Menu {
            ForEach(Registry.all.filter { $0.native }, id: \.id) { fn in
                Button("\(fn.id)  \(fn.label)") {
                    if let id = ws.focusedID { ws.retarget(id, fn: fn.id) }
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text(current?.id ?? "—")
                    .font(Term.mono(10, weight: .bold)).foregroundStyle(Term.amber)
                Text("▾").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Switch this panel to another function")
    }

    /// What somebody looking at this usually wants next.
    ///
    /// Bloomberg's Related Functions is the thing that turns a terminal
    /// from a lookup tool into a path: you arrive at a description and
    /// leave through the financials. The groupings already exist for the
    /// security menu, so this is the same knowledge pointed at the pane
    /// you are on rather than at a blank page.
    private var relatedMenu: some View {
        let current = ws.panes.first { $0.id == ws.focusedID }
        let related = Self.related(to: current?.function.id)
        return Menu {
            if related.isEmpty {
                Text("Nothing related")
            }
            ForEach(related, id: \.id) { fn in
                Button("\(fn.id)  \(fn.label)") {
                    ws.open(Command(ticker: current?.ticker, function: fn.id, args: nil))
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text("Related Functions")
                    .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                Text("⌄").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Where people usually go from here")
    }

    /// Hand-drawn rather than derived. What follows a description is the
    /// financials, and no amount of category metadata knows that — the
    /// menu groupings are about where a function FILES, which is a
    /// different question from where a reader GOES.
    private static let PATHS: [String: [String]] = [
        "DES":   ["FA", "GF", "GP", "CN", "MGMT", "PEER", "TRK"],
        "GP":    ["GIP", "DES", "FA", "CN"],
        "GIP":   ["GP", "DES", "CN"],
        "FA":    ["GF", "DES", "PEER", "CMP", "FIL"],
        "GF":    ["FA", "DES", "PEER", "CMP"],
        "FIL":   ["FA", "DES", "MGMT", "SPLC"],
        "PEER":  ["CMP", "FA", "DES"],
        "CMP":   ["PEER", "FA", "GF"],
        "INSDR": ["ICLUSTER", "MGMT", "DES"],
        "ICLUSTER": ["INSDR", "MGMT"],
        "MGMT":  ["INSDR", "FIL", "DES", "ORG"],
        "EARN":  ["CON", "FA", "GF", "CN"],
        "CON":   ["EARN", "FA", "PEER"],
        "CN":    ["TOP", "DES", "GP"],
        "TOP":   ["CN", "MOVR", "WEI"],
        "SPLC":  ["FAC", "FIL", "DES"],
        "FAC":   ["SPLC", "WX", "DES"],
        "WX":    ["RDR", "FAC", "PM"],
        "RDR":   ["WX", "FAC"],
        "PM":    ["TRK", "MOVR", "MACRO", "WEI"],
        // The report card belongs beside the book and beside the
        // archive, because the question it answers ("was that call
        // right") is the one a reader has just after either.
        "TRK":   ["PM", "PAPER", "RSCH", "DES"],
        "PAPER": ["TRK", "PM", "DES"],
        "MOVR":  ["PM", "TOP", "WEI"],
        "MACRO": ["PM", "WEI"],
        "WEI":   ["TOP", "MOVR", "MACRO"],
        "RSCH":  ["ARCH", "NOTE", "TRK", "DES"],
        "ARCH":  ["RSCH", "NOTE"],
        "NOTE":  ["RSCH", "DES"],
        "WL":    ["DES", "PM", "MOVR"],
    ]

    static func related(to code: String?) -> [TerminalFunction] {
        guard let code else { return [] }
        let ids = PATHS[code.uppercased()] ?? []
        return ids.compactMap { id in Registry.all.first { $0.id == id && $0.native } }
    }
}
