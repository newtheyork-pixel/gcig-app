import SwiftUI
import AppKit

// SUBS — what the club pays for, and how to get in.
//
// The credentials live in Render's environment and this panel never
// holds them: the list it shows carries no secrets at all, and a login
// is fetched only when somebody asks for it. Nothing is cached, so
// leaving the pane open leaves no password sitting in memory waiting for
// a screenshot.
//
// Reading one is logged on the server by who and which, never the value.
// A shared account with no record of who used it is how a club finds out
// the password changed and cannot work out by whom.
struct SubscriptionsPanel: View {
    @State private var state: Loadable<Payload> = .loading
    @State private var revealed: [String: Credential] = [:]
    @State private var busy: String?
    @State private var copied: String?
    @State private var error: String?

    struct Payload: Decodable {
        let configured: Bool?
        let items: [Item]?
    }

    struct Item: Decodable, Identifiable {
        let key: String
        let label: String
        let loginUrl: String?
        let note: String?
        let hasCredentials: Bool?
        var id: String { key }
    }

    struct Credential: Decodable {
        let username: String
        let password: String
        let loginUrl: String?
    }

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { !($0.configured ?? false) },
                   emptyText: "No subscriptions configured. They live in the SUBSCRIPTIONS variable on Render.",
                   retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    SectionLabel(text: "Subscriptions")
                    Text("\((p.items ?? []).count) the club pays for")
                        .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                    Spacer()
                    if let e = error {
                        Text(e).font(Term.mono(9)).foregroundStyle(Term.negative).lineLimit(1)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(p.items ?? []) { row($0) }
                    }
                }
                Text("Signing in inside the reader keeps you signed in: the browser pane keeps its cookies across relaunches, so this is usually a once-per-machine job.")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Term.bgHeader)
            }
        }
        .task { await load() }
    }

    private func row(_ i: Item) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(i.label)
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white)
                if i.hasCredentials != true {
                    Text("NO LOGIN STORED")
                        .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.amber)
                        .help("This one has no username and password on the server")
                }
                Spacer()
                if let u = i.loginUrl {
                    Button("Open sign-in") {
                        NotificationCenter.default.post(name: .openInReader, object: u)
                    }
                    .buttonStyle(TermButtonStyle())
                    .help("Opens the login page in the terminal's reader")
                }
                if i.hasCredentials == true {
                    Button(busy == i.key ? "…" : (revealed[i.key] == nil ? "Show login" : "Hide"))
                    {
                        if revealed[i.key] != nil { revealed[i.key] = nil } else { reveal(i.key) }
                    }
                    .buttonStyle(TermButtonStyle()).disabled(busy != nil)
                }
            }
            if let n = i.note, !n.isEmpty {
                Text(n).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            if let c = revealed[i.key] {
                HStack(spacing: 8) {
                    Text(c.username)
                        .font(Term.mono(10)).foregroundStyle(Term.amber).textSelection(.enabled)
                    Button(copied == "\(i.key):u" ? "copied" : "copy user") { copy(c.username, "\(i.key):u") }
                        .buttonStyle(TermButtonStyle())
                    // The password is never rendered. Copying it is the
                    // only thing anybody needs to do with it, and a
                    // password on screen is a password in the next
                    // screenshot somebody takes of this terminal.
                    Button(copied == "\(i.key):p" ? "copied" : "copy password") { copy(c.password, "\(i.key):p") }
                        .buttonStyle(TermButtonStyle())
                    Text("password hidden — copy it, do not read it aloud")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    Spacer()
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
    }

    private func copy(_ s: String, _ tag: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        copied = tag
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = nil }
    }

    private func reveal(_ key: String) {
        busy = key
        error = nil
        Task {
            do {
                let data = try await API.shared.get("/subscriptions/\(key)/credentials")
                revealed[key] = try await API.shared.decode(Credential.self, from: data)
            } catch {
                self.error = error.localizedDescription
            }
            busy = nil
        }
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/subscriptions")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
