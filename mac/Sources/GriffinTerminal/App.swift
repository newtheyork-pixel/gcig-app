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
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

extension Notification.Name {
    static let focusCommand = Notification.Name("focusCommand")
    static let runCommand = Notification.Name("runCommand")
    static let tilePanes = Notification.Name("tilePanes")
}

// MARK: Session

@MainActor
final class Session: ObservableObject {
    @Published var user: API.Me?
    @Published var checking = true
    @Published var signInError: String?

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

    func signOut() async {
        await API.shared.signOut()
        user = nil
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
    }
}

struct LoginView: View {
    @EnvironmentObject var session: Session
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 2) {
                Text("THE GRIFFIN FUND")
                    .font(Term.mono(16, weight: .bold)).foregroundStyle(Term.amber)
                Text("TERMINAL")
                    .font(Term.mono(10)).tracking(4).foregroundStyle(Term.fgMuted)
            }
            .padding(.bottom, 6)

            VStack(spacing: 8) {
                TextField("email", text: $email)
                    .textFieldStyle(.plain)
                    .font(Term.mono(12))
                    .padding(6)
                    .background(Term.bgPanel)
                    .termBorder()
                SecureField("password", text: $password)
                    .textFieldStyle(.plain)
                    .font(Term.mono(12))
                    .padding(6)
                    .background(Term.bgPanel)
                    .termBorder()
                    .onSubmit { go() }
            }
            .frame(width: 300)

            Button(busy ? "Signing in…" : "Sign in", action: go)
                .buttonStyle(TermButtonStyle())
                .disabled(busy || email.isEmpty || password.isEmpty)

            if let e = session.signInError {
                Text(e)
                    .font(Term.mono(10)).foregroundStyle(Term.negative)
                    .frame(width: 320).multilineTextAlignment(.center)
            }

            // Google sign-in and 2FA both live on the website. Saying so
            // beats a login box that silently cannot serve half the club.
            Text("Google sign-in and two-factor accounts: sign in on thegriffinfund.org.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                .frame(width: 340).multilineTextAlignment(.center)
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
