import SwiftUI
import AppKit
import os

@main
struct GriffinTerminalApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var session = Session()
    @StateObject private var ws = Workspace()

    var body: some Scene {
        Window("Griffin Terminal", id: "main") {
            RootView()
                .environmentObject(session)
                .environmentObject(ws)
                .frame(minWidth: 900, minHeight: 600)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1440, height: 900)
        .commands {
            // The keystrokes a terminal user expects. ⌘K for the command
            // line above all: the whole interaction model is type-a-code,
            // and reaching for the mouse to focus the input breaks it.
            CommandGroup(replacing: .newItem) {
                Button("Focus Command Line") { NotificationCenter.default.post(name: .focusCommand, object: nil) }
                    .keyboardShortcut("k", modifiers: .command)
                Button("Close Pane") { ws.closeFocused() }
                    .keyboardShortcut("w", modifiers: .command)
                Button("Close All Panes") { ws.closeAll() }
                    .keyboardShortcut("w", modifiers: [.command, .shift])
                Divider()
                Button("Tile Panes") { NotificationCenter.default.post(name: .tilePanes, object: nil) }
                    .keyboardShortcut("t", modifiers: [.command, .shift])
            }
            // Launchpad. The arranged screen is a work product; these
            // make it durable and addressable.
            // The opening and closing bells, and the switch to silence
            // them. A market terminal rings at 9:30 and 4:00 ET; a
            // student in a lecture at 9:30 can turn it off.
            CommandMenu("Market") {
                Toggle("Ring the Bells", isOn: Binding(
                    get: { MarketBell.shared.enabled },
                    set: { MarketBell.shared.enabled = $0 }
                ))
                Divider()
                Button("Preview Opening Bell") { MarketBell.shared.preview(.open) }
                Button("Preview Closing Bell") { MarketBell.shared.preview(.close) }
            }
            CommandMenu("Layouts") {
                Button("Save Layout As…") {
                    NotificationCenter.default.post(name: .saveLayoutPrompt, object: nil)
                }
                .keyboardShortcut("s", modifiers: [.command, .shift])
                if !ws.layoutNames.isEmpty {
                    Divider()
                    ForEach(ws.layoutNames, id: \.self) { name in
                        Button(name) { ws.loadLayout(named: name) }
                    }
                    Divider()
                    Menu("Delete") {
                        ForEach(ws.layoutNames, id: \.self) { name in
                            Button(name, role: .destructive) { ws.deleteLayout(named: name) }
                        }
                    }
                }
                Divider()
                ForEach(1..<10) { n in
                    Button("Focus Pane \(n)") { ws.focusPane(index: n - 1) }
                        .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .command)
                }
            }
            CommandGroup(replacing: .help) {
                Button("Terminal Functions") {
                    NotificationCenter.default.post(name: .runCommand, object: "HELP")
                }
            }
        }

        // The second display: a WHOLE terminal, not a floating panel.
        //
        // The first attempt sent one pane to the other monitor, which is
        // not a two-screen desk — it is a desk with a sticky note beside
        // it. This is the same shell, command bar and all, drawing the
        // panes that belong to screen 1, sharing one Workspace and one
        // Session so the focus ticker, recents and history stay a single
        // truth across both.
        WindowGroup("Griffin Terminal — Screen 2", id: "screen2") {
            TerminalView(surface: 1)
                .environmentObject(session)
                .environmentObject(ws)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1400, height: 900)

        // Panes promoted to real windows. Same Workspace and Session
        // objects as the shell, so focus ticker and auth stay one truth
        // across every window.
        WindowGroup(id: "pane", for: PaneSeed.self) { $seed in
            if let seed {
                PopoutWindow(seed: seed)
                    .environmentObject(session)
                    .environmentObject(ws)
                    .frame(minWidth: 420, minHeight: 280)
            }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 720, height: 540)
    }
}

let appLog = Logger(subsystem: "org.thegriffinfund.terminal", category: "auth")

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // Belt and braces. Under the SwiftUI lifecycle the URL normally
        // arrives via application(_:open:) below, but registering here
        // too costs nothing and covers the AppKit path.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURLEvent(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    /// The one that actually fires under SwiftUI.
    ///
    /// The first version of this registered only an NSAppleEventManager
    /// handler in applicationDidFinishLaunching, which is the AppKit
    /// recipe and is silently pre-empted here: SwiftUI installs its own
    /// kAEGetURL handler and routes to this method instead. The symptom
    /// was the worst kind — the browser said it had handed off, the app
    /// sat on "waiting", and nothing anywhere said why.
    func application(_ application: NSApplication, open urls: [URL]) {
        appLog.info("application(open:) got \(urls.count) url(s)")
        FileHandle.standardError.write("[auth] application(open:) \(urls.map(\.absoluteString))\n".data(using: .utf8)!)
        for url in urls { consume(url) }
    }

    @objc func handleURLEvent(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: s) else { return }
        appLog.info("AppleEvent got url")
        FileHandle.standardError.write("[auth] appleEvent \(url.absoluteString)\n".data(using: .utf8)!)
        consume(url)
    }

    /// griffin-terminal://auth?code=...
    ///
    /// Accepts the code wherever it appears, because the shape of a
    /// custom-scheme URL is not worth being strict about: host is "auth"
    /// for `://auth?code=`, but a browser that normalises the URL can
    /// move it. A code we can see is a code we should use.
    private func consume(_ url: URL) {
        guard url.scheme == "griffin-terminal" else {
            appLog.error("ignoring url with scheme \(url.scheme ?? "nil")")
            return
        }
        guard let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            appLog.error("no code in \(url.absoluteString)")
            return
        }
        appLog.info("handoff code received, posting to session")
        FileHandle.standardError.write("[auth] code received, posting\n".data(using: .utf8)!)
        NSApp.activate(ignoringOtherApps: true)
        NotificationCenter.default.post(name: .handoffCode, object: code)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

extension Notification.Name {
    static let focusCommand = Notification.Name("focusCommand")
    static let runCommand = Notification.Name("runCommand")
    static let tilePanes = Notification.Name("tilePanes")
    static let handoffCode = Notification.Name("handoffCode")
    static let saveLayoutPrompt = Notification.Name("saveLayoutPrompt")
    static let escapeGesture = Notification.Name("escapeGesture")
    /// A story to read in the terminal rather than in Safari. Posted by
    /// any list that holds a URL; the workspace decides where it lands.
    static let openInReader = Notification.Name("openInReader")
}

// MARK: Session

@MainActor
final class Session: ObservableObject {
    @Published var user: API.Me?
    @Published var checking = true
    @Published var signInError: String?
    /// True from the moment the browser is opened until a code comes
    /// back. Without it the app looks idle while the whole flow is
    /// happening in another application.
    @Published var awaitingBrowser = false

    func restore() async {
        checking = true
        defer { checking = false }
        guard await API.shared.isSignedIn else { user = nil; return }
        do { user = try await API.shared.me() } catch { user = nil }
    }

    func signIn(email: String, password: String) async {
        signInError = nil
        do {
            user = try await API.shared.signIn(email: email, password: password)
        } catch {
            signInError = error.localizedDescription
            user = nil
        }
    }

    /// Open the website and let it sign the user in however they
    /// normally do. The app deliberately does not reimplement Google or
    /// 2FA: the browser already has both, correctly, and it is where the
    /// user's Google session already lives.
    func signInWithBrowser() {
        signInError = nil
        awaitingBrowser = true
        let origin = ProcessInfo.processInfo.environment["GRIFFIN_WEB"]
            ?? "https://thegriffinfund.org"
        if let url = URL(string: "\(origin)/native-auth") {
            NSWorkspace.shared.open(url)
        }
    }

    func completeHandoff(code: String) async {
        FileHandle.standardError.write("[auth] completeHandoff entered\n".data(using: .utf8)!)
        signInError = nil
        do {
            user = try await API.shared.exchangeHandoff(code: code)
        } catch {
            FileHandle.standardError.write("[auth] exchange failed: \(error.localizedDescription)\n".data(using: .utf8)!)
            signInError = error.localizedDescription
            user = nil
        }
        awaitingBrowser = false
    }

    func signOut() async {
        await API.shared.signOut()
        user = nil
        awaitingBrowser = false
    }
}

// MARK: Root

struct RootView: View {
    @EnvironmentObject var session: Session

    var body: some View {
        ZStack {
            Term.bg.ignoresSafeArea()
            if session.checking {
                ProgressView().tint(Term.amber)
            } else if session.user == nil {
                LoginView()
            } else {
                TerminalView()
            }
        }
        .task { await session.restore() }
        .onReceive(NotificationCenter.default.publisher(for: .handoffCode)) { note in
            guard let code = note.object as? String else { return }
            Task { await session.completeHandoff(code: code) }
        }
    }
}

struct LoginView: View {
    @EnvironmentObject var session: Session
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var showPassword = false
    @State private var manualCode = ""

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 2) {
                Text("THE GRIFFIN FUND")
                    .font(Term.mono(16, weight: .bold)).foregroundStyle(Term.amber)
                Text("TERMINAL")
                    .font(Term.mono(10)).tracking(4).foregroundStyle(Term.fgMuted)
            }
            .padding(.bottom, 6)

            // Browser first, and by a distance. It is the only path that
            // covers Google, password and 2FA, because it IS the website
            // that already implements all three.
            Button(session.awaitingBrowser ? "Waiting for the browser…" : "Sign in with browser") {
                session.signInWithBrowser()
            }
            .buttonStyle(TermButtonStyle())
            .disabled(session.awaitingBrowser)

            Text("Opens thegriffinfund.org. Sign in there however you normally do,\nincluding Google, and it hands this app back a one-time code.")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
                .multilineTextAlignment(.center)

            // The escape hatch, and it is not optional.
            //
            // A custom URL scheme is the happy path and it fails in ways
            // nobody can diagnose from the app: a browser silently
            // refusing the first navigation, a corporate profile
            // blocking it, the wrong copy of the app registered. Sitting
            // on "waiting for the browser" with no way forward is a dead
            // end, and it is exactly what happened the first time this
            // shipped. The page prints the code; this takes it.
            if session.awaitingBrowser {
                VStack(spacing: 6) {
                    Text("Didn't come back automatically?")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    HStack(spacing: 6) {
                        TextField("paste the code from the page", text: $manualCode)
                            .textFieldStyle(.plain).font(Term.mono(11))
                            .padding(5).background(Term.bgPanel).termBorder()
                            .frame(width: 240)
                            .onSubmit { useManualCode() }
                        Button("Use code", action: useManualCode)
                            .buttonStyle(TermButtonStyle())
                            .disabled(manualCode.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    Button("Cancel") { session.awaitingBrowser = false }
                        .buttonStyle(.plain)
                        .font(Term.mono(9))
                        .foregroundStyle(Term.fgMuted)
                }
            }

            if let e = session.signInError {
                Text(e)
                    .font(Term.mono(10)).foregroundStyle(Term.negative)
                    .frame(width: 340).multilineTextAlignment(.center)
            }

            // Kept, but folded away. It works for password accounts and
            // is the fallback when the browser handoff is the thing that
            // is broken.
            Divider().frame(width: 300).overlay(Term.border)
            Button(showPassword ? "Hide password sign-in" : "Sign in with a password instead") {
                withAnimation { showPassword.toggle() }
            }
            .buttonStyle(.plain)
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)

            if showPassword {
                VStack(spacing: 8) {
                    TextField("email", text: $email)
                        .textFieldStyle(.plain).font(Term.mono(12))
                        .padding(6).background(Term.bgPanel).termBorder()
                    SecureField("password", text: $password)
                        .textFieldStyle(.plain).font(Term.mono(12))
                        .padding(6).background(Term.bgPanel).termBorder()
                        .onSubmit { go() }
                    Button(busy ? "Signing in…" : "Sign in", action: go)
                        .buttonStyle(TermButtonStyle())
                        .disabled(busy || email.isEmpty || password.isEmpty)
                    Text("2FA accounts cannot finish here. Use the browser button.")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                .frame(width: 300)
            }
        }
        .foregroundStyle(Term.fg)
    }

    private func go() {
        busy = true
        Task {
            await session.signIn(email: email, password: password)
            busy = false
        }
    }

    private func useManualCode() {
        let code = manualCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return }
        manualCode = ""
        Task { await session.completeHandoff(code: code) }
    }
}
