import SwiftUI
import AppKit

// A pane promoted to a real macOS window.
//
// Past a certain point you stop imitating windows and use the ones the
// OS ships: native drag and resize, Mission Control, Stage Manager, and
// the system window-tiling that macOS provides for free. The in-shell
// floating panes stay the default because the arranged-workspace look
// IS the terminal; this is for the pane you want on your other monitor.
//
// Bloomberg behaviour on purpose: the window carries its own command
// line, and a command typed here REPLACES this window's content rather
// than opening yet another window. PANEL <GO>, effectively.
struct PopoutWindow: View {
    let seed: PaneSeed
    @EnvironmentObject var ws: Workspace
    @EnvironmentObject var session: Session

    @State private var function: TerminalFunction?
    @State private var ticker: String?
    @State private var args: String?
    @State private var input = ""
    @State private var flash: String?
    @FocusState private var cmdFocused: Bool

    private var title: String {
        let f = function?.id ?? seed.function
        return "\(ticker.map { "\($0) · " } ?? "")\(f)"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Group {
                if session.user == nil {
                    PanelMessage(text: "Signed out. Sign in from the main terminal window.")
                } else if let f = function {
                    PanelRouter(functionID: f.id, ticker: ticker, args: args)
                } else {
                    PanelMessage(text: "\(seed.function) is not a function this app knows.", bad: true)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            commandLine
        }
        .background(Term.bg)
        .navigationTitle(title)
        .preferredColorScheme(.dark)
        .background(WindowConfigurator { w in
            w.backgroundColor = NSColor(Term.bg)
            w.titlebarAppearsTransparent = true
            w.minSize = NSSize(width: 420, height: 280)
            if let f = Registry.function(seed.function) {
                w.setContentSize(NSSize(width: f.width + 40, height: f.height + 60))
            }
        })
        .onAppear {
            function = Registry.function(seed.function)
            ticker = seed.ticker
            args = seed.args
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            // Room for the traffic lights, which overlay content under
            // the hidden-titlebar style.
            Spacer().frame(width: 66)

            if let t = ticker {
                Text(t).foregroundStyle(Term.amber)
                Text("·").foregroundStyle(Term.fgMuted)
            }
            Text(function?.id ?? seed.function).foregroundStyle(Term.amber)
            Text("·").foregroundStyle(Term.fgMuted)
            Text((function?.label ?? "?").uppercased()).foregroundStyle(Term.white)

            Spacer()

            Menu {
                ForEach(Registry.all.filter(\.native)) { f in
                    Button("\(f.id) · \(f.label)") { switchTo(f) }
                }
            } label: {
                Text("⌄").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.fgDim)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help("Switch function")
        }
        .font(Term.mono(10, weight: .medium))
        .padding(.horizontal, 8)
        .frame(height: 30)
        .background(Term.bgHeader)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
        .contentShape(Rectangle())
        .gesture(WindowDragGesture())
    }

    private var commandLine: some View {
        VStack(spacing: 0) {
            if let f = flash {
                HStack {
                    Text(f).font(Term.mono(9)).foregroundStyle(Term.negative)
                    Spacer()
                }
                .padding(.horizontal, 10).padding(.vertical, 2)
                .background(Term.bgPanel)
            }
            HStack(spacing: 6) {
                Text(">").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.orange)
                TextField("", text: $input,
                          prompt: Text("command replaces this window — e.g. \(ticker ?? "AIT") GP")
                              .foregroundStyle(Term.fgMuted))
                    .textFieldStyle(.plain)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.amber)
                    .focused($cmdFocused)
                    .onSubmit { submit() }
            }
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Term.bg)
            .overlay(alignment: .top) {
                Rectangle().fill(cmdFocused ? Term.borderFocus : Term.border).frame(height: 1)
            }
        }
    }

    private func switchTo(_ f: TerminalFunction) {
        if f.requires == "ticker", ticker == nil, ws.focusTicker == nil {
            flash = "\(f.id) needs a ticker."
            return
        }
        function = f
        if f.requires == "ticker", ticker == nil { ticker = ws.focusTicker }
        flash = nil
    }

    private func submit() {
        let raw = input.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return }
        guard let cmd = Parser.parse(raw) else {
            flash = "\(raw.uppercased()) is not a function or a ticker. Type HELP."
            return
        }
        guard let f = Registry.function(cmd.function) else { return }
        guard f.native else {
            flash = "\(f.id) is not native yet. It works on the web terminal."
            return
        }
        let t = cmd.ticker ?? ticker ?? ws.focusTicker
        if f.requires == "ticker", t == nil {
            flash = "\(f.id) needs a ticker. Try  AIT \(f.id)"
            return
        }
        function = f
        ticker = f.requires == "ticker" ? t : cmd.ticker
        args = cmd.args
        if let t = cmd.ticker {
            ws.focusTicker = t
            ws.recordTicker(t)
        }
        flash = nil
        input = ""
    }
}

/// Reaches the hosting NSWindow once it exists. SwiftUI has no sanctioned
/// way to set a window's background or minimum size from inside the
/// hierarchy, and a popped-out pane flashing white before first paint is
/// exactly the kind of seam this app exists to not have.
struct WindowConfigurator: NSViewRepresentable {
    var configure: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            if let w = v.window { configure(w) }
        }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}