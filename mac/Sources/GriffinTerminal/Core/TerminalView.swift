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

    var body: some View {
        VStack(spacing: 0) {
            TopBar()
            CommandBarView().zIndex(100)
            BreakingStrip()
            HStack(spacing: 0) {
                SideRail()
                workspaceCanvas
            }
            StatusBar()
        }
        .background(Term.bg)
        .onAppear {
            ws.loadPrefs()
            ws.refreshLayoutNames()
            // The arrangement you left is the arrangement you get back.
            ws.restoreCurrentIfEmpty()
        }
        .sheet(isPresented: $namingLayout) { LayoutNameSheet() }
        .onReceive(NotificationCenter.default.publisher(for: .saveLayoutPrompt)) { _ in
            namingLayout = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .runCommand)) { note in
            if let cmd = note.object as? String { ws.run(cmd) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .escapeGesture)) { _ in
            ws.escapePressed()
        }
    }

    private var workspaceCanvas: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Term.bg
                if ws.panes.isEmpty { EmptyWorkspaceHint() }
                ForEach(ws.panes) { pane in
                    PaneWindow(pane: pane, bounds: geo.size) { seed in
                        openWindow(value: seed)
                    }
                }
            }
            .coordinateSpace(name: "workspace")
            .clipped()
            .onAppear { ws.canvasSize = geo.size }
            .onChange(of: geo.size) { _, s in ws.canvasSize = s }
            .onReceive(NotificationCenter.default.publisher(for: .tilePanes)) { _ in
                ws.tile(in: geo.size)
            }
        }
    }
}

// MARK: - Topbar

// GRIFFIN FUND · TERMINAL v0 · dot CONNECTED · user · ET clock. The
// clock ticks in New York time because that is the timezone the desk
// and the custodian both run on — an open terminal should feel alive
// even when no panel is refreshing.
private struct TopBar: View {
    @EnvironmentObject var session: Session

    var body: some View {
        HStack(spacing: 12) {
            Text("GRIFFIN FUND")
                .font(Term.mono(12, weight: .bold))
                .tracking(2)
                .foregroundStyle(Term.amber)
            Text("TERMINAL")
                .font(Term.mono(10)).tracking(1.6).foregroundStyle(Term.fgDim)
            + Text(" v1").font(Term.mono(10)).foregroundStyle(Term.fgMuted)

            Spacer()

            FocusQuote()

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
    @FocusState private var focused: Bool

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
            && !suggestions.isEmpty && !parsing
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(">")
                    .font(Term.mono(13, weight: .bold))
                    .foregroundStyle(Term.orange)
                TextField("", text: $value,
                          prompt: Text("TICKER FUNCTION — e.g. AAPL DES · or ask in plain English")
                              .foregroundStyle(Term.fgMuted))
                    .textFieldStyle(.plain)
                    .font(Term.mono(13))
                    .foregroundStyle(Term.amber)
                    .focused($focused)
                    .onSubmit { submit() }
                    .onChange(of: value) { _, _ in active = 0; menuOpen = true }
                    .onKeyPress(.upArrow) { move(-1) }
                    .onKeyPress(.downArrow) { move(1) }
                    .onKeyPress(.tab) { fill() }
                    .onKeyPress(.escape) {
                        if showMenu { menuOpen = false; return .handled }
                        return .ignored
                    }
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
            .overlay(alignment: .bottom) {
                Rectangle().fill(focused ? Term.borderFocus : Term.border).frame(height: 1)
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
            focused = true
            installSlashShortcut()
        }
        .onReceive(NotificationCenter.default.publisher(for: .focusCommand)) { _ in
            focused = true
        }
    }

    private var suggestionsHeight: CGFloat {
        CGFloat(min(suggestions.count, 8)) * 22 + 2
    }

    private var menu: some View {
        VStack(spacing: 0) {
            ForEach(Array(suggestions.enumerated()), id: \.element.id) { i, f in
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
                        if !f.native {
                            Text("web only").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                        }
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
        .frame(width: 380)
        .termBorder()
        .shadow(color: .black.opacity(0.5), radius: 12, y: 6)
    }

    private func move(_ d: Int) -> KeyPress.Result {
        guard showMenu else { return .ignored }
        active = max(0, min(suggestions.count - 1, active + d))
        return .handled
    }

    /// Tab completes the line the way a shell would: keeps the ticker,
    /// fills the highlighted mnemonic, leaves the cursor ready for args.
    private func fill() -> KeyPress.Result {
        guard showMenu, suggestions.indices.contains(active) else { return .ignored }
        let f = suggestions[active]
        value = (split.ticker.map { "\($0) " } ?? "") + f.id + " "
        return .handled
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

        // Priority order, same as the web: an exactly-parseable line
        // runs as typed; a partial match takes the highlighted
        // suggestion; anything else goes to the LLM.
        if let cmd = Parser.parse(raw) {
            ws.open(cmd)
            value = ""
            return
        }
        if showMenu, suggestions.indices.contains(active) {
            run(suggestions[active])
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
    private func installSlashShortcut() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.modifierFlags.intersection([.command, .option, .control]).isEmpty,
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
                    if let u = URL(string: a.url) { NSWorkspace.shared.open(u) }
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

    var body: some View {
        Group {
            if let t = ws.focusTicker {
                HStack(spacing: 6) {
                    Text(t).font(Term.mono(10, weight: .bold)).foregroundStyle(Term.white)
                    Text(Fmt.money(price)).font(Term.mono(10, weight: .medium)).foregroundStyle(Term.white)
                    Text(Fmt.pct(pct)).font(Term.mono(10, weight: .medium))
                        .foregroundStyle(Term.delta(pct))
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
        struct Q: Decodable { let price: Double?; let changePct: Double? }
        guard let data = try? await API.shared.get("/terminal/quotes", query: ["tickers": t]),
              let m = try? await API.shared.decode([String: Q].self, from: data),
              let q = m[t] else { return }
        if let p = q.price { price = p }
        if let c = q.changePct { pct = c * 100 }
    }
}

// MARK: - Status bar

private struct StatusBar: View {
    @EnvironmentObject var ws: Workspace

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
            Text(Date.now.formatted(date: .abbreviated, time: .omitted))
        }
        .font(Term.mono(9))
        .foregroundStyle(Term.fgMuted)
        .padding(.horizontal, 12)
        .frame(height: 22)
        .background(Term.bgHeader)
        .overlay(alignment: .top) { Rectangle().fill(Term.border).frame(height: 1) }
    }
}