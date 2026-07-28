import SwiftUI

// The workspace surface: status strip, floating panes, command line.
//
// Command line at the BOTTOM, like the web client and like the thing it
// is imitating. It is the one control always in the same place, and
// every keystroke starts there.
struct TerminalView: View {
    @EnvironmentObject var ws: Workspace
    @EnvironmentObject var session: Session

    @State private var input = ""
    @FocusState private var commandFocused: Bool
    @State private var history: [String] = []
    @State private var historyIndex: Int?

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                statusStrip
                ZStack(alignment: .topLeading) {
                    Term.bg
                    if ws.panes.isEmpty { emptyState }
                    ForEach(ws.panes) { pane in
                        PaneWindow(pane: pane, bounds: geo.size)
                    }
                }
                .coordinateSpace(name: "workspace")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                commandLine(bounds: geo.size)
            }
            .onReceive(NotificationCenter.default.publisher(for: .focusCommand)) { _ in
                commandFocused = true
            }
            .onReceive(NotificationCenter.default.publisher(for: .tilePanes)) { _ in
                ws.tile(in: geo.size)
            }
            .onReceive(NotificationCenter.default.publisher(for: .runCommand)) { note in
                if let cmd = note.object as? String { ws.run(cmd, in: geo.size) }
            }
        }
        .background(Term.bg)
        .onAppear { commandFocused = true }
    }

    private var statusStrip: some View {
        HStack(spacing: 12) {
            Text("GRIFFIN")
                .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
            if let t = ws.focusTicker {
                Text(t).font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white)
            }
            Text("\(ws.panes.count) pane\(ws.panes.count == 1 ? "" : "s")")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            Spacer()
            if let u = session.user {
                Text("\(u.name) · \(u.role)")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
            Button("Sign out") { Task { await session.signOut() } }
                .buttonStyle(.plain)
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Term.bgHeader)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("Type a command below.")
                .font(Term.mono(12)).foregroundStyle(Term.fgDim)
            Text("AIT DES  ·  PM  ·  MOVR  ·  TOP  ·  RSCH  ·  HELP")
                .font(Term.mono(11)).foregroundStyle(Term.fgMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func commandLine(bounds: CGSize) -> some View {
        VStack(spacing: 0) {
            // The flash is where a rejected command explains itself.
            // Silence after a keystroke that did nothing is the worst
            // outcome: the user cannot tell whether they mistyped, the
            // function needs a ticker, or the app is broken.
            if let f = ws.flash {
                HStack {
                    Text(f.text)
                        .font(Term.mono(10))
                        .foregroundStyle(f.bad ? Term.negative : Term.fgDim)
                    Spacer()
                }
                .padding(.horizontal, 10).padding(.vertical, 3)
                .background(Term.bgPanel)
            }
            HStack(spacing: 8) {
                Text(ws.focusTicker ?? "—")
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(Term.orange)
                    .frame(width: 58, alignment: .leading)
                TextField("", text: $input, prompt: Text("command").foregroundStyle(Term.fgMuted))
                    .textFieldStyle(.plain)
                    .font(Term.mono(13))
                    .foregroundStyle(Term.white)
                    .focused($commandFocused)
                    .onSubmit { submit(bounds: bounds) }
                    .onKeyPress(.upArrow) { recall(-1); return .handled }
                    .onKeyPress(.downArrow) { recall(1); return .handled }
                Text("⏎")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(Term.bgHeader)
            .overlay(alignment: .top) { Rectangle().fill(Term.borderFocus).frame(height: 1) }
        }
    }

    private func submit(bounds: CGSize) {
        let cmd = input.trimmingCharacters(in: .whitespaces)
        guard !cmd.isEmpty else { return }
        ws.run(cmd, in: bounds)
        history.append(cmd)
        historyIndex = nil
        input = ""
    }

    /// Up/down through what was typed before, the way a shell does.
    private func recall(_ delta: Int) {
        guard !history.isEmpty else { return }
        let current = historyIndex ?? history.count
        let next = min(max(current + delta, 0), history.count)
        historyIndex = next
        input = next < history.count ? history[next] : ""
    }
}
