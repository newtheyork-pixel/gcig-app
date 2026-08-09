import SwiftUI

// The shell, mirroring the web terminal's anatomy exactly: topbar,
// command bar directly under it, breaking strip, side rail beside the
// floating workspace, status bar along the bottom. The web is the
// design source of truth — anyone moving between the browser and this
// app should not have to re-learn where anything lives.
struct TerminalView: View {
    @EnvironmentObject var ws: Workspace
    @EnvironmentObject var session: Session
    @Environment(\.openWindow) private var openWindow
    @State private var namingLayout = false
    /// Which display this instance draws. 0 is the main window; a second
    /// terminal opened on another screen passes 1 and renders only the
    /// panes that belong to it.
    var surface: Int = 0

    var body: some View {
        VStack(spacing: 0) {
            TopBar()
            // What is open, and where you are — above the command line
            // because it is the answer to a question you have before you
            // type, not after.
            TabStrip()
            CommandBarView().zIndex(100)
            HootBar()
            BreakingStrip()
            HStack(spacing: 0) {
                SideRail()
                workspaceCanvas
            }
            StatusBar()
        }
        .background(Term.bg)
        // Whichever terminal you are looking at is the one a command
        // opens into. Without this, typing on the second screen would
        // put the panel on the first, which is the behaviour that made
        // the earlier popout version useless.
        .onTapGesture { ws.activeSurface = surface }
        .onAppear { ws.activeSurface = surface }
        .onAppear {
            ws.loadPrefs()
            ws.refreshLayoutNames()
            // The arrangement you left is the arrangement you get back.
            ws.restoreCurrentIfEmpty()
            GriffinVolume.shared.mountIfPrepared()
            GriffinVolume.shared.clearFileProviderDomains()
            Updater.shared.start()
            MarketBell.shared.start()
        }
        .background(BlockCaretInstaller().frame(width: 0, height: 0))
        .sheet(isPresented: $namingLayout) { LayoutNameSheet() }
        // Workspace-wide notifications are handled by the primary
        // instance ONLY. Screen 2 is a second TerminalView over the same
        // Workspace, and with both subscribed every post ran twice: two
        // panes per ticker click, two reader windows per headline, and —
        // the nasty one — one Escape press arming AND firing the
        // two-stroke close, so a single Escape shut the pane outright.
        .onReceive(NotificationCenter.default.publisher(for: .saveLayoutPrompt)) { _ in
            if surface == 0 { namingLayout = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: .runCommand)) { note in
            guard surface == 0 else { return }
            if let cmd = note.object as? String { ws.run(cmd) }
        }
        // A headline opens in the terminal, not in Safari. Panels post
        // the URL and the workspace decides where it lands, which keeps
        // every news list ignorant of how reading works.
        .onReceive(NotificationCenter.default.publisher(for: .openInReader)) { note in
            guard surface == 0 else { return }
            if let u = note.object as? String {
                ws.open(Command(ticker: nil, function: "WEB", args: u))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .escapeGesture)) { _ in
            if surface == 0 { ws.escapePressed() }
        }
    }

    private var workspaceCanvas: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Term.bg
                if ws.panes(on: surface).isEmpty { EmptyWorkspaceHint() }
                ForEach(ws.panes(on: surface)) { pane in
                    PaneWindow(pane: pane, bounds: geo.size) { seed in
                        openWindow(value: seed)
                    }
                }
            }
            .coordinateSpace(name: "workspace")
            .clipped()
            .onAppear {
                // Only the main window owns canvasSize; the second screen
                // has its own geometry and would otherwise overwrite the
                // value every other placement calculation reads.
                if surface == 0 { ws.canvasSize = geo.size }
                // A layout saved on a larger display restores with panes
                // outside a smaller one, so this runs at launch too.
                ws.clampAll(to: geo.size, surface: surface)
            }
            .onChange(of: geo.size) { _, s in
                if surface == 0 { ws.canvasSize = s }
                ws.clampAll(to: s, surface: surface)
            }
            .onReceive(NotificationCenter.default.publisher(for: .tilePanes)) { _ in
                // Tile only what this window shows, and only when it is
                // the window being looked at.
                if ws.activeSurface == surface { ws.tile(in: geo.size, surface: surface) }
            }
        }
    }
}

// MARK: - Topbar

// GRIFFIN FUND · TERMINAL v0 · dot CONNECTED · user · ET clock. The
// clock ticks in New York time because that is the timezone the desk
// and the custodian both run on — an open terminal should feel alive
// even when no panel is refreshing.

// The update affordance: one chip that says what it is doing.
//
// Never installs on its own. An app that replaces itself underneath a
// half-typed order is worse than an app one version behind, so the swap
// waits for a press — and the press is the same button throughout, which
// is why the label carries the state rather than a separate indicator.
private struct UpdateChip: View {
    @ObservedObject private var updater = Updater.shared

    var body: some View {
        switch updater.phase {
        case .idle, .checking:
            EmptyView()
        case .available(let r):
            Button {
                Task { await updater.download() }
            } label: {
                Text("UPDATE \(r.version)").font(Term.mono(9, weight: .bold))
            }
            .buttonStyle(TermButtonStyle())
            .foregroundStyle(r.mandatory ? Term.negative : Term.amber)
            .help(r.notes ?? "A newer build is available. Downloads now, installs when you say so.")
        case .downloading:
            Text("DOWNLOADING…").font(Term.mono(9)).foregroundStyle(Term.fgDim)
        case .ready(_, let v):
            Button {
                updater.installAndRestart()
            } label: {
                Text("RESTART FOR \(v)").font(Term.mono(9, weight: .bold))
            }
            .buttonStyle(TermButtonStyle())
            .foregroundStyle(Term.positive)
            .help("Verified and staged. Restarts the app to finish.")
        case .failed(let why):
            Button { updater.dismiss() } label: {
                Text("UPDATE FAILED").font(Term.mono(9, weight: .bold))
            }
            .buttonStyle(TermButtonStyle())
            .foregroundStyle(Term.negative)
            .help(why)
        }
    }
}

private struct TopBar: View {
    @ObservedObject private var volume = GriffinVolume.shared
    @ObservedObject private var updater = Updater.shared
    @EnvironmentObject var ws: Workspace
    @EnvironmentObject var session: Session
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 12) {
            Text("GRIFFIN FUND")
                .font(Term.mono(12, weight: .bold))
                .tracking(2)
                .foregroundStyle(Term.amber)
            // TERMINAL and the version are one concatenated Text, so
            // nothing may be inserted between them.
            (Text("TERMINAL")
                .font(Term.mono(10)).tracking(1.6).foregroundStyle(Term.fgDim)
             + Text(" v\(Updater.shared.installed)")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted))
            // One button, for everybody. The app already holds the
            // session token, so nobody types a credential and there is no
            // setup to write down.
            Button(volume.state.mounted ? "◉ GRIFFIN FUND" : "ADD TO FINDER") {
                if volume.state.mounted { volume.reveal() } else { volume.startAndMount() }
            }
            .buttonStyle(TermButtonStyle())
            .help(volume.state.mounted
                  ? "Open the Griffin Fund volume in Finder"
                  : "Mount the research files as a volume in Finder")
            if let e = volume.state.error {
                Text(e).font(Term.mono(9)).foregroundStyle(Term.negative).lineLimit(1)
            }

            Spacer()

            FocusQuote()

            UpdateChip()

            // Second monitor. Only offered when there IS one — a button
            // that opens a window onto a screen you do not have is a
            // button that loses your panels somewhere off-canvas.
            if ws.hasSecondScreen {
                Button {
                    openWindow(id: "screen2")
                    ws.placeNewestOnSecondScreen()
                } label: {
                    Text("◫◫").font(Term.mono(12))
                }
                .buttonStyle(TermButtonStyle())
                .help("Open a second full terminal on your other display")
            }

            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Circle().fill(Term.positive).frame(width: 6, height: 6)
                    Text("CONNECTED").font(Term.mono(9)).tracking(1)
                }
                .foregroundStyle(Term.fgDim)
                Text("·").foregroundStyle(Term.fgMuted)
                Text((session.user?.name ?? "USER").uppercased())
                    .font(Term.mono(9)).tracking(1).foregroundStyle(Term.fgDim)
                Text("·").foregroundStyle(Term.fgMuted)
                MarketClock()
                Button("SIGN OUT") { Task { await session.signOut() } }
                    .buttonStyle(.plain)
                    .font(Term.mono(9)).tracking(1)
                    .foregroundStyle(Term.fgMuted)
                    .padding(.leading, 6)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 30)
        .background(Term.bgHeader)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }
}

struct MarketClock: View {
    private static let fmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        f.timeZone = TimeZone(identifier: "America/New_York")
        return f
    }()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            (Text(Self.fmt.string(from: ctx.date))
                .foregroundStyle(Term.white)
             + Text(" ET").foregroundStyle(Term.fgMuted))
                .font(Term.mono(10, weight: .medium))
        }
    }
}

// MARK: - Command bar

// The amber command line, at the TOP like the web, with the Bloomberg
// autocomplete dropping out of it: a ranked list of matching functions
// that the arrow keys walk and Enter or Tab fills. Plain English that
// matches no mnemonic falls through to the server's LLM parser on
// Enter, so the "just ask" path works here too.
private struct CommandBarView: View {
    @EnvironmentObject var ws: Workspace
    @State private var value = ""
    @State private var active = 0
    @State private var menuOpen = true
    @State private var parsing = false
    @State private var interpretation: String?
    @State private var symMatches: [API.SymbolMatch] = []
    /// Focus is requested by counter and reported by AppKit. See
    /// CommandField for why a Bool cannot do this job.
    @State private var focusTick = 1
    @State private var fieldFocused = false

    /// One flat list for the arrow keys: functions first, securities
    /// after, exactly like the web menu.
    private enum Entry: Hashable {
        case fn(TerminalFunction)
        case sym(API.SymbolMatch)
        static func == (a: Entry, b: Entry) -> Bool {
            switch (a, b) {
            case let (.fn(x), .fn(y)): return x.id == y.id
            case let (.sym(x), .sym(y)): return x == y
            default: return false
            }
        }
        func hash(into h: inout Hasher) {
            switch self {
            case .fn(let f): h.combine("f"); h.combine(f.id)
            case .sym(let m): h.combine("s"); h.combine(m.ticker)
            }
        }
    }

    private var entries: [Entry] {
        suggestions.map(Entry.fn) + symMatches.prefix(6).map(Entry.sym)
    }

    /// The first token, when it is symbol-shaped and not a mnemonic —
    /// what goes to the SEC directory. Type AMZ, get AMZN.
    private var symQuery: String {
        guard let t = split.ticker, t.count >= 2,
              !Registry.ids.contains(t) else { return "" }
        return t
    }

    private static let tickerRe = try! NSRegularExpression(pattern: "^[A-Z][A-Z0-9.\\-]{0,11}$")

    /// "AAPL DE" → (AAPL, DE); "DE" → (nil, DE); "AAPL" → (AAPL, "").
    /// A lone token reads as a function query when it prefixes a
    /// mnemonic, else as a ticker if it is shaped like one — the same
    /// rules as the web's splitInput, because the two must rank alike.
    private var split: (ticker: String?, q: String) {
        let cleaned = value.trimmingCharacters(in: .whitespaces)
            .split(separator: " ").map { $0.uppercased() }
        guard let first = cleaned.first else { return (nil, "") }
        if cleaned.count >= 2 {
            return (Parser.looksLikeTicker(first) ? first : nil,
                    cleaned.dropFirst().joined(separator: " "))
        }
        if Registry.all.contains(where: { $0.id.hasPrefix(first) }) { return (nil, first) }
        if Parser.looksLikeTicker(first) { return (first, "") }
        return (nil, first)
    }

    private var suggestions: [TerminalFunction] {
        let q = split.q
        func score(_ f: TerminalFunction) -> Int {
            if q.isEmpty { return 1 }
            let label = f.label.uppercased()
            if f.id == q { return 100 }
            if f.id.hasPrefix(q) { return 80 }
            if label.hasPrefix(q) { return 60 }
            if f.id.contains(q) { return 40 }
            if label.contains(q) { return 20 }
            return -1
        }
        return Registry.all
            .map { ($0, score($0)) }
            .filter { $0.1 >= 0 }
            .sorted { $0.1 > $1.1 }
            .prefix(8)
            .map(\.0)
    }

    private var showMenu: Bool {
        menuOpen && !value.trimmingCharacters(in: .whitespaces).isEmpty
            && !entries.isEmpty && !parsing
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(">")
                    .font(Term.mono(13, weight: .bold))
                    .foregroundStyle(Term.orange)
                // Ours, not SwiftUI's, so the caret can be an amber
                // block. Every key the old field handled with .onKeyPress
                // is now an explicit closure — see CommandField.
                CommandField(
                    text: $value,
                    placeholder: "TICKER FUNCTION — e.g. AAPL DES · or ask in plain English",
                    focusTick: focusTick,
                    onSubmit: { submit() },
                    onEscape: {
                        // The field owns focus almost permanently, so if
                        // Escape only worked when focus was elsewhere it
                        // would effectively never work — which is exactly
                        // the bug this replaces. Bloomberg's <CANCL>
                        // cascade: shut the menu, then clear the line,
                        // then the two-stroke select/close on the panes.
                        if showMenu { menuOpen = false; return }
                        if !value.isEmpty { value = ""; return }
                        NotificationCenter.default.post(name: .escapeGesture, object: nil)
                    },
                    onMove: { d in _ = move(d) },
                    onTab: { _ = fill() },
                    onFocusChange: { fieldFocused = $0 })
                    .frame(height: 17)
                    .onChange(of: value) { _, _ in active = 0; menuOpen = true }
                if parsing {
                    Text("PARSING…").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                if let t = ws.focusTicker {
                    Text(t).font(Term.mono(10, weight: .bold)).foregroundStyle(Term.orange)
                        .help("Focused ticker — a bare function opens against it")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(Term.bg)
            // The whole 34pt row is the click target, not the 17pt text
            // line inside it. A command line you have to hit within a few
            // pixels is a command line that reads as gone.
            .contentShape(Rectangle())
            .onTapGesture { focusTick &+= 1 }
            .overlay(alignment: .bottom) {
                Rectangle().fill(fieldFocused ? Term.borderFocus : Term.border).frame(height: 1)
            }
            .overlay(alignment: .bottomLeading) {
                if showMenu { menu.offset(y: suggestionsHeight) }
            }
            .zIndex(50)

            if let f = ws.flash {
                HStack {
                    Text(f.text).font(Term.mono(10))
                        .foregroundStyle(f.bad ? Term.negative : Term.fgDim)
                    Spacer()
                }
                .padding(.horizontal, 12).padding(.vertical, 3)
                .background(Term.bgPanel)
            } else if let i = interpretation {
                HStack {
                    Text(i).font(Term.mono(10)).foregroundStyle(Term.cyan)
                    Spacer()
                }
                .padding(.horizontal, 12).padding(.vertical, 3)
                .background(Term.bgPanel)
            }
        }
        .onAppear {
            focusTick &+= 1
            installSlashShortcut()
        }
        .task(id: symQuery) {
            guard !symQuery.isEmpty else { symMatches = []; return }
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled else { return }
            // Autocomplete going quiet on error is fine; stale rows for
            // the wrong query are not — the id-task cancellation is
            // what guarantees against that.
            let found = (try? await API.shared.symbolSearch(symQuery)) ?? []
            if !Task.isCancelled {
                symMatches = (found.count == 1 && found[0].ticker == symQuery) ? [] : found
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .focusCommand)) { _ in
            focusTick &+= 1
        }
    }

    private var suggestionsHeight: CGFloat {
        CGFloat(entries.count) * 22 + (symMatches.isEmpty ? 2 : 20)
    }

    private var menu: some View {
        VStack(spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element) { i, ent in
                switch ent {
                case .fn(let f):
                    Button { run(f) } label: {
                        HStack(spacing: 8) {
                            Text(f.id).font(Term.mono(11, weight: .bold))
                                .foregroundStyle(Term.amber)
                                .frame(width: 72, alignment: .leading)
                            Text(f.label).font(Term.mono(10))
                                .foregroundStyle(i == active ? Term.white : Term.fgDim)
                            if f.requires == "ticker", let t = split.ticker ?? ws.focusTicker {
                                Text(t).font(Term.mono(9)).foregroundStyle(Term.orange)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 22)
                        .background(i == active ? Term.bgPanelHover : Term.bgPanel)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { if $0 { active = i } }

                case .sym(let m):
                    if case .sym = entries[max(i - 1, 0)], i > 0 {} else {
                        HStack(spacing: 6) {
                            Text("SECURITIES").font(Term.mono(8, weight: .bold)).tracking(1.2)
                                .foregroundStyle(Term.blue)
                            Rectangle().fill(Term.border).frame(height: 1)
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 18)
                        .background(Term.bgPanel)
                    }
                    Button { pickSymbol(m) } label: {
                        HStack(spacing: 8) {
                            Text(m.ticker).font(Term.mono(11, weight: .bold))
                                .foregroundStyle(Term.white)
                                .frame(width: 72, alignment: .leading)
                            Text(m.name).font(Term.mono(10))
                                .foregroundStyle(i == active ? Term.white : Term.fgMuted)
                                .lineLimit(1)
                            Spacer()
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 22)
                        .background(i == active ? Term.bgPanelHover : Term.bgPanel)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { if $0 { active = i } }
                }
            }
        }
        .frame(width: 400)
        .termBorder()
        .shadow(color: .black.opacity(0.5), radius: 12, y: 6)
    }

    private func move(_ d: Int) -> KeyPress.Result {
        guard showMenu else { return .ignored }
        active = max(0, min(entries.count - 1, active + d))
        return .handled
    }

    /// Tab completes the line the way a shell would: a function fills
    /// its mnemonic keeping the ticker, a security corrects the symbol
    /// in place keeping the rest.
    private func fill() -> KeyPress.Result {
        guard showMenu, entries.indices.contains(active) else { return .ignored }
        switch entries[active] {
        case .fn(let f):
            value = (split.ticker.map { "\($0) " } ?? "") + f.id + " "
        case .sym(let m):
            let rest = value.trimmingCharacters(in: .whitespaces)
                .split(separator: " ").dropFirst().joined(separator: " ")
            value = rest.isEmpty ? "\(m.ticker) " : "\(m.ticker) \(rest)"
        }
        return .handled
    }

    /// A picked security either runs immediately (a function was
    /// already typed after it) or corrects the symbol and waits.
    private func pickSymbol(_ m: API.SymbolMatch) {
        let rest = value.trimmingCharacters(in: .whitespaces)
            .split(separator: " ").dropFirst().joined(separator: " ")
        if !rest.isEmpty, let cmd = Parser.parse("\(m.ticker) \(rest)") {
            ws.open(cmd)
            value = ""
            interpretation = nil
            return
        }
        value = "\(m.ticker) "
    }

    private func run(_ f: TerminalFunction) {
        ws.open(Command(ticker: split.ticker, function: f.id, args: nil))
        value = ""
        interpretation = nil
    }

    private func submit() {
        let raw = value.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty, !parsing else { return }
        interpretation = nil

        // Number <GO> — a bare number activates the focused pane's
        // numbered row. Checked before the parser because "3" is not a
        // ticker, not a function, and must never fall through to the
        // LLM asking what three means.
        if let n = Int(raw), ws.runNumber(n) {
            value = ""
            return
        }

        // Priority order, same as the web: an exactly-parseable line
        // runs as typed; a partial match takes the highlighted
        // suggestion; anything else goes to the LLM.
        if let cmd = Parser.parse(raw) {
            ws.open(cmd)
            value = ""
            return
        }
        if showMenu, entries.indices.contains(active) {
            switch entries[active] {
            case .fn(let f): run(f)
            case .sym(let m): pickSymbol(m)
            }
            return
        }

        // Plain English → the server's LLM parser, exactly like the web.
        parsing = true
        Task {
            defer { parsing = false }
            do {
                let parsed = try await API.shared.parseCommand(raw)
                guard let fn = parsed.function else {
                    ws.flash = Workspace.Flash(text: "Could not interpret that. Type HELP for the function list.", bad: true)
                    return
                }
                ws.open(Command(ticker: parsed.ticker, function: fn, args: parsed.args))
                if let e = parsed.explanation, !e.isEmpty { interpretation = "→ \(e)" }
                value = ""
            } catch {
                ws.flash = Workspace.Flash(text: error.localizedDescription, bad: true)
            }
        }
    }

    /// "/" refocuses the command line; Escape is the web shell's
    /// two-stroke close (select the top pane, then shut it). Both stand
    /// down whenever the user is typing in a real text field.
    /// One monitor for the app's lifetime. This is called from a view's
    /// onAppear, which fires again for every screen-2 open — each call
    /// used to stack another monitor that was never removed, so the same
    /// keystroke was handled once per historical window.
    private static var slashMonitorInstalled = false
    private func installSlashShortcut() {
        guard !Self.slashMonitorInstalled else { return }
        Self.slashMonitorInstalled = true
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            // Only the shell window. A popped-out pane is a real macOS
            // window with its own focus; keys pressed there must not
            // reach across and manipulate the main workspace unseen.
            guard NSApp.keyWindow?.title == "Griffin Terminal",
                  event.modifierFlags.intersection([.command, .option, .control]).isEmpty,
                  !(NSApp.keyWindow?.firstResponder is NSTextView)
            else { return event }
            if event.charactersIgnoringModifiers == "/" {
                NotificationCenter.default.post(name: .focusCommand, object: nil)
                return nil
            }
            if event.keyCode == 53 { // Escape
                NotificationCenter.default.post(name: .escapeGesture, object: nil)
                return nil
            }
            return event
        }
    }
}

// MARK: - Breaking strip

// The thin live wire pinned under the command bar. Headlines arrive
// scored server-side; the three states the server distinguishes stay
// distinguished here, because they look identical if you only count
// articles: real breaking news gets the badge, a quiet day is labelled
// WIRE, and an unclassified feed must not claim to be anything more.
private struct BreakingStrip: View {
    struct Article: Decodable {
        let title: String
        let url: String
        let source: String?
        let breaking: Double?
    }
    struct Payload: Decodable {
        let articles: [Article]?
        let classified: Bool?
        let threshold: Double?
    }

    @State private var payload: Payload?
    @State private var idx = 0
    @State private var hovering = false

    var body: some View {
        Group {
            if let p = payload, let arts = p.articles, !arts.isEmpty {
                let a = arts[idx % arts.count]
                let isBreaking = (p.classified ?? false) && (a.breaking ?? 0) >= (p.threshold ?? 7)
                Button {
                    NotificationCenter.default.post(name: .openInReader, object: a.url)
                } label: {
                    HStack(spacing: 8) {
                        Text(isBreaking ? "● BREAKING" : ((p.classified ?? false) ? "WIRE" : "WIRE·RAW"))
                            .font(Term.mono(8, weight: .bold)).tracking(1)
                            .foregroundStyle(isBreaking ? Term.negative : Term.fgMuted)
                        Text(a.title)
                            .font(Term.mono(10))
                            .foregroundStyle(Term.fgDim)
                            .lineLimit(1)
                        if let s = a.source {
                            Text(s.uppercased()).font(Term.mono(8)).foregroundStyle(Term.orange)
                        }
                        Spacer()
                        Text("\(idx % arts.count + 1)/\(arts.count)")
                            .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 20)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .background(Term.bgPanel)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
        .task {
            var sinceLoad = 0
            await load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(9))
                sinceLoad += 9
                if !hovering { idx += 1 }
                if sinceLoad >= 1800 { await load(); sinceLoad = 0 }
            }
        }
    }

    private func load() async {
        // Degraded is invisible here by design: the strip simply absent
        // beats a strip crying about a fetch error above every panel.
        if let data = try? await API.shared.get("/terminal/top-news"),
           let p = try? await API.shared.decode(Payload.self, from: data) {
            payload = p
        }
    }
}

// MARK: - Side rail

// Favorites and recent tickers, exactly the web's rail: pin a
// (function, ticker) pair from any pane's titlebar star, click a recent
// to open its DES. Collapse persists.
private struct SideRail: View {
    @EnvironmentObject var ws: Workspace
    @AppStorage("railCollapsed") private var collapsed = false

    var body: some View {
        Group {
            if collapsed {
                VStack {
                    railToggle
                    Spacer()
                }
                .frame(width: 22)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("RAIL").font(Term.mono(8, weight: .bold)).tracking(1.5)
                            .foregroundStyle(Term.fgMuted)
                        Spacer()
                        railToggle
                    }

                    SectionLabel(text: "Favorites")
                    if ws.favorites.isEmpty {
                        Text("Pin a pane with its ★")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    } else {
                        ForEach(ws.favorites) { f in
                            Button {
                                ws.open(Command(ticker: f.ticker, function: f.fn, args: nil))
                            } label: {
                                HStack(spacing: 4) {
                                    if let t = f.ticker {
                                        Text(t).foregroundStyle(Term.white)
                                        Text("·").foregroundStyle(Term.fgMuted)
                                    }
                                    Text(f.fn).foregroundStyle(Term.amber)
                                    Spacer()
                                }
                                .font(Term.mono(10))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Remove") { ws.toggleFavorite(f.fn, f.ticker) }
                            }
                        }
                    }

                    SectionLabel(text: "Recent")
                    if ws.recents.isEmpty {
                        Text("Open a ticker").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    } else {
                        ForEach(ws.recents, id: \.self) { t in
                            Button {
                                ws.open(Command(ticker: t, function: "DES", args: nil))
                            } label: {
                                Text(t).font(Term.mono(10, weight: .medium))
                                    .foregroundStyle(Term.amber)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        Button("clear") { ws.recents = [] }
                            .buttonStyle(.plain)
                            .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                    }

                    Spacer()
                }
                .padding(8)
                .frame(width: 148)
            }
        }
        .frame(maxHeight: .infinity)
        .background(Term.bgPanel)
        .overlay(alignment: .trailing) { Rectangle().fill(Term.border).frame(width: 1) }
    }

    private var railToggle: some View {
        Button { collapsed.toggle() } label: {
            Text(collapsed ? "❯" : "❮")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(collapsed ? "Expand rail" : "Collapse rail")
    }
}

// MARK: - Empty workspace

private struct EmptyWorkspaceHint: View {
    @EnvironmentObject var ws: Workspace

    var body: some View {
        VStack(spacing: 10) {
            Text("EMPTY WORKSPACE")
                .font(Term.mono(13, weight: .bold)).tracking(3)
                .foregroundStyle(Term.fgDim)
            Text("Type a command to open a window — e.g. AAPL DES, MOVR — or ask in plain English.")
                .font(Term.mono(11)).foregroundStyle(Term.fgMuted)

            HStack(spacing: 10) {
                quick(1, "AAPL DES") { ws.open(Command(ticker: "AAPL", function: "DES", args: nil)) }
                quick(2, "Movers") { ws.open(Command(ticker: nil, function: "MOVR", args: nil)) }
                quick(3, "Portfolio") { ws.open(Command(ticker: nil, function: "PM", args: nil)) }
                quick(4, "Function menu") { ws.open(Command(ticker: nil, function: "HELP", args: nil)) }
            }
            .padding(.top, 4)

            Text("Drag a pane by its title bar · resize from the corner · ⧉ pops it into a real window.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // The web's numbered quick actions — orange numerals, Bloomberg's
    // menu idiom.
    private func quick(_ n: Int, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text("\(n))").foregroundStyle(Term.orange)
                Text(label).foregroundStyle(Term.amber)
            }
            .font(Term.mono(11))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Term.bgPanel)
            .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
    }
}

// MARK: - Save layout sheet

private struct LayoutNameSheet: View {
    @EnvironmentObject var ws: Workspace
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Save layout")
            Text("Pins the current arrangement — \(ws.panes.count) pane\(ws.panes.count == 1 ? "" : "s") — under a name in the Layouts menu.")
                .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                .fixedSize(horizontal: false, vertical: true)
            TextField("", text: $name, prompt: Text("earnings day").foregroundStyle(Term.fgMuted))
                .textFieldStyle(.plain).font(Term.mono(12))
                .padding(6).background(Term.bgPanel).termBorder()
                .onSubmit { save() }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(TermButtonStyle())
                Button("Save") { save() }.buttonStyle(TermButtonStyle())
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 360)
        .background(Term.bg)
    }

    private func save() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        ws.saveLayout(named: n)
        dismiss()
    }
}

// MARK: - Focus quote

// The focused ticker's live price, always in the chrome — Bloomberg
// never makes you open a panel to know where your security is trading.
// Polls the same /terminal/quotes the panels use, only while a ticker
// is focused.
private struct FocusQuote: View {
    @EnvironmentObject var ws: Workspace
    @State private var price: Double?
    @State private var pct: Double?
    @State private var session: String?
    @State private var extendedPct: Double?

    var body: some View {
        Group {
            if let t = ws.focusTicker {
                HStack(spacing: 6) {
                    Text(t).font(Term.mono(10, weight: .bold)).foregroundStyle(Term.white)
                    Text(Fmt.money(price)).font(Term.mono(10, weight: .medium)).foregroundStyle(Term.white)
                        .tickFlash(price)
                    Text(Fmt.pct(pct)).font(Term.mono(10, weight: .medium))
                        .foregroundStyle(Term.delta(pct))
                    // The session tag, because a moving price at 5pm is
                    // a different fact from a moving price at 2pm and
                    // Bloomberg is right to say which one you are
                    // looking at. The extended move rides next to it,
                    // separate from the day change on purpose.
                    if let sess = session, sess == "pre" || sess == "post" {
                        (Text(sess.uppercased())
                            .foregroundStyle(Term.orange)
                         + Text(extendedPct.map { " \(Fmt.pct($0))" } ?? "")
                            .foregroundStyle(Term.delta(extendedPct)))
                            .font(Term.mono(9, weight: .bold))
                            .tickFlash(extendedPct)
                    }
                }
                .task(id: t) {
                    price = nil; pct = nil
                    while !Task.isCancelled {
                        await poll(t)
                        try? await Task.sleep(for: .seconds(20))
                    }
                }
            }
        }
    }

    private func poll(_ t: String) async {
        // A failed poll keeps the last good numbers; a stale quote in
        // the chrome beats a flickering dash.
        // Field names verified against the live handler, because this
        // exact function shipped decoding `price` where the server sends
        // `last` — an all-optional struct decodes the mismatch silently
        // and the chrome just shows a dash forever. And changePct
        // arrives ALREADY as a percent (Finnhub's dp); scaling it again
        // turns -2.9 into -293.
        struct Q: Decodable {
            let last: Double?
            let changePct: Double?
            let session: String?
            let extendedPct: Double?
        }
        guard let data = try? await API.shared.get("/terminal/quotes", query: ["tickers": t]),
              let m = try? await API.shared.decode([String: Q?].self, from: data),
              let q = m[t] ?? nil else { return }
        if let p = q.last { price = p }
        if let c = q.changePct { pct = c }
        session = q.session
        extendedPct = q.extendedPct
    }
}

// MARK: - Status bar

private struct StatusBar: View {
    @EnvironmentObject var ws: Workspace
    @EnvironmentObject var session: Session

    private var focusedDesc: String {
        guard let id = ws.focusedID,
              let p = ws.panes.first(where: { $0.id == id }) else { return "NONE FOCUSED" }
        return "\(p.ticker ?? "—") · \(p.function.id)"
    }

    var body: some View {
        HStack(spacing: 8) {
            Text("WINDOWS: \(ws.panes.count)")
            Text("|").foregroundStyle(Term.border)
            Text(focusedDesc)
            Text("|").foregroundStyle(Term.border)
            (Text("HELP").foregroundStyle(Term.amber)
             + Text(" for the function menu · ").foregroundStyle(Term.fgMuted)
             + Text("/").foregroundStyle(Term.amber)
             + Text(" or ").foregroundStyle(Term.fgMuted)
             + Text("⌘K").foregroundStyle(Term.amber)
             + Text(" to jump to the command line").foregroundStyle(Term.fgMuted))
            Spacer()
            // The SN + timestamp ribbon — after amber-on-black, the most
            // recognizable Bloomberg tell there is. SN is the member id;
            // the clock ticks with the topbar's.
            (Text("The Griffin Fund  ").foregroundStyle(Term.fgMuted)
             + Text("SN \(session.user?.id ?? 0)").foregroundStyle(Term.fgDim))
                .font(Term.mono(9))
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text(ctx.date.formatted(.dateTime.day().month(.abbreviated).year()
                        .hour(.twoDigits(amPM: .omitted)).minute().second()))
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgDim)
            }
        }
        .font(Term.mono(9))
        .foregroundStyle(Term.fgMuted)
        .padding(.horizontal, 12)
        .frame(height: 22)
        .background(Term.bgHeader)
        .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1) }
    }
}