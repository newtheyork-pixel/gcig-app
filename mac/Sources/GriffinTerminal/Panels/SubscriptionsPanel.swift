import SwiftUI
import AppKit

// SUBS — what the club pays for.
//
// This panel shows no credential and has no way to reveal one. It used to
// offer copy-username and copy-password, which made the club's WSJ
// account portable: anyone who opened the pane could walk off with the
// login. The purpose was always reading articles in the terminal, not
// distributing the account, and a copy button is distribution.
//
// The reader fills the form itself and the password is never drawn on
// screen. Reads are still logged server-side by who and which, never the
// value, because a shared account with no record of use is how a club
// finds the password changed and cannot say by whom.
struct SubscriptionsPanel: View {
    @State private var state: Loadable<Payload> = .loading
    @State private var busy: String?
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
                Text("Open a story and the reader signs in for you. The login itself is not shown and cannot be copied — the point is reading the articles, not handing round the account.")
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
                    Text("SIGNS IN FOR YOU")
                        .font(Term.mono(9)).foregroundStyle(Term.positive)
                        .help("The reader fills this login itself. The credential is never shown.")
                }
            }
            if let n = i.note, !n.isEmpty {
                Text(n).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1).opacity(0.5) }
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
