import SwiftUI
import AppKit

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
            CommandGroup(replacing: .help) {
                Button("Terminal Functions") {
                    NotificationCenter.default.post(name: .runCommand, object: "HELP")
                }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // Register before the browser can possibly redirect back.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURLEvent(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    /// griffin-terminal://auth?code=...
    ///
    /// The code is posted straight through to the session rather than
    /// parsed into anything durable: it is worth nothing after one use
    /// and ninety seconds, and the fewer places it is written down the
    /// better.
    @objc func handleURLEvent(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: s),
              url.scheme == "griffin-terminal",
              url.host == "auth" || url.path.contains("auth"),
              let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == "code" })?.value
        else { return }
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
        signInError = nil
        do {
            user = try await API.shared.exchangeHandoff(code: code)
        } catch {
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

            if session.awaitingBrowser {
                Button("Cancel") { session.awaitingBrowser = false }
                    .buttonStyle(.plain)
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
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
}
