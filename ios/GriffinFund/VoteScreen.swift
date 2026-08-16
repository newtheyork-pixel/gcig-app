import SwiftUI

// Casting a ballot.
//
// This is the highest-value thing the phone can do, and the reasoning is
// not about convenience. A vote is open for days a few times a semester,
// and quorum lives on phones rather than on Macs: the member who forgets
// is not refusing, they are in class. Everything else in this app is a
// glance. This one changes an outcome.
//
// The ballot's shape is decided by the session, not by the screen, and the
// rules are the server's:
//
//   buy + average  Buy, Hold or Sell, and a Buy carries a proposed
//                  allocation between $1,500 and $10,000 which is averaged
//                  across everyone who voted Buy.
//   buy + fixed    the amount is already pinned, so the question collapses
//                  to supporting it or not. "No" is persisted as Hold, so
//                  the tally arithmetic never learns a fourth answer.
//   sell           Sell or Hold. No amount: we are exiting a position we
//                  already have, and its size is not up for a vote.
//
// Getting that wrong means offering somebody a choice the server will
// refuse, so the options are derived from the session in one place.

@MainActor
final class VoteStore: ObservableObject {
    @Published private(set) var state: Loadable<VoteSession> = .loading
    @Published private(set) var submitting = false
    @Published var castError: String?
    @Published private(set) var justCast = false

    func load(_ id: Int) async {
        state = .loading
        do {
            state = .loaded(try await API.shared.get("/votes/\(id)", as: VoteSession.self), at: Date())
        } catch APIError.cancelled {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func cast(_ id: Int, action: String, amount: Double?, note: String) async {
        submitting = true
        castError = nil
        defer { submitting = false }
        var body: [String: Any] = ["action": action]
        if let amount { body["investmentAmount"] = amount }
        if !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["note"] = note }
        do {
            _ = try await API.shared.post("/votes/\(id)/ballot", body: body, as: BallotReceipt.self)
            justCast = true
            // Re-read rather than patching local state: the tally moved,
            // and a screen that shows a stale count next to a fresh ballot
            // is the thing that makes people vote twice.
            await load(id)
        } catch {
            castError = error.localizedDescription
        }
    }
}

struct VoteScreen: View, Hashable {
    let sessionId: Int
    var knownTicker: String? = nil

    @StateObject private var store = VoteStore()
    @State private var action: String?
    @State private var amount: Double = 5_000
    @State private var note = ""

    static func == (a: VoteScreen, b: VoteScreen) -> Bool { a.sessionId == b.sessionId }
    func hash(into h: inout Hasher) { h.combine(sessionId) }

    var body: some View {
        ScreenState(state: store.state,
                    retry: { Task { await store.load(sessionId) } }) { s in
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    header(s)
                    if let mine = s.myBallot {
                        castRecord(mine, session: s)
                    } else if s.isOpen {
                        ballot(s)
                    } else {
                        EmptyState(text: "Voting closed and you did not cast a ballot.")
                            .frame(height: 90)
                    }
                    tallySection(s)
                }
            }
        }
        .background(T.bg)
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: Space.s) {
                    Text("VOTE").font(Type.screenCode).foregroundStyle(T.white)
                    Text(store.state.value?.ticker ?? knownTicker ?? "")
                        .font(Type.screenTitle).tracking(0.8).foregroundStyle(T.white)
                }
            }
        }
        .toolbarBackground(T.redBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task { if store.state.value == nil { await store.load(sessionId) } }
    }

    // MARK: pieces

    private func header(_ s: VoteSession) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: Space.s) {
                if let t = s.ticker {
                    NavigationLink(value: TickerScreen(symbol: t)) {
                        Chip(text: t, tone: T.amber, style: .solid)
                    }
                    .buttonStyle(.plain)
                }
                Chip(text: s.isSell ? "Sell vote" : "Buy vote", tone: T.blue)
                if s.isFixed { Chip(text: "Fixed amount", tone: T.muted) }
                Spacer(minLength: 0)
            }
            Text(s.title ?? s.pitch?.ticker ?? "Voting session")
                .font(Font.prose(20, .semibold)).foregroundStyle(T.white)
                .fixedSize(horizontal: false, vertical: true)
            if let p = s.pitch?.pitcherName {
                Text("Pitched by \(p)").font(Type.footnote).foregroundStyle(T.dim)
            }
            // The deadline is the whole reason this is on a phone.
            HStack(spacing: Space.s) {
                Chip(text: s.isOpen ? "Open" : "Closed",
                     tone: s.isOpen ? T.positive : T.muted, style: .solid)
                Text(s.isOpen ? "Closes \(Fmt.shortDateTime(s.deadline))"
                              : "Closed \(Fmt.shortDateTime(s.deadline))")
                    .font(Type.meta).foregroundStyle(T.muted)
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }

    private func ballot(_ s: VoteSession) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Space.m) {
                ForEach(s.choices, id: \.action) { c in
                    Button {
                        action = c.action
                    } label: {
                        HStack(spacing: Space.m) {
                            // A filled square rather than a radio dot: the
                            // rest of this app has no round corners and a
                            // control that borrows iOS's shapes reads as
                            // somebody else's screen.
                            Rectangle()
                                .fill(action == c.action ? T.amber : Color.clear)
                                .overlay(Rectangle().strokeBorder(
                                    action == c.action ? T.amber : T.border, lineWidth: 1))
                                .frame(width: 16, height: 16)
                            VStack(alignment: .leading, spacing: Space.xs) {
                                Text(c.label).font(Type.headline).foregroundStyle(T.white)
                                Text(c.detail).font(Type.footnote).foregroundStyle(T.dim)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, Space.s)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }

                // Only a Buy in average mode carries an amount, and the
                // band is the server's: anything outside it is refused.
                if action == "Buy" && !s.isFixed && !s.isSell {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("PROPOSED ALLOCATION")
                            .font(Type.label).tracking(0.8).foregroundStyle(T.muted)
                        Text(Fmt.money(amount))
                            .font(Type.valueBig).foregroundStyle(T.amber)
                        Slider(value: $amount, in: 1_500...10_000, step: 250)
                            .tint(T.amber)
                        Text("Averaged across everyone who votes Buy.")
                            .font(Type.meta).foregroundStyle(T.muted)
                    }
                    .padding(.top, Space.s)
                }

                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("NOTE (OPTIONAL)")
                        .font(Type.label).tracking(0.8).foregroundStyle(T.muted)
                    TextField("Why", text: $note, axis: .vertical)
                        .lineLimit(1...4)
                        .font(Type.body).foregroundStyle(T.white)
                        .padding(Space.m).background(T.bg)
                        .overlay(Rectangle().strokeBorder(T.border, lineWidth: 1))
                }

                if let e = store.castError {
                    Text(e).font(Type.footnote).foregroundStyle(T.negative)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    Task {
                        await store.cast(sessionId, action: action ?? "",
                                         amount: (action == "Buy" && !s.isFixed && !s.isSell) ? amount : nil,
                                         note: note)
                    }
                } label: {
                    Text(store.submitting ? "CASTING…" : "CAST BALLOT")
                        .font(Type.chip).tracking(0.8)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(action == nil ? T.card : T.amber)
                        .foregroundStyle(action == nil ? T.muted : T.bg)
                }
                .disabled(action == nil || store.submitting)
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .hairline()
        } header: {
            SectionHeader(text: "Your ballot")
        }
    }

    /// A ballot already cast is shown as a record, not as a form with the
    /// old answer preselected. The server upserts, so changing your mind is
    /// possible, but the default reading of this screen should be "you
    /// voted" rather than "vote again".
    private func castRecord(_ b: Ballot, session s: VoteSession) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.s) {
                    Chip(text: b.action ?? "?", tone: T.positive, style: .solid)
                    if let a = b.investmentAmount {
                        Text(Fmt.money(a)).font(Type.value).foregroundStyle(T.white)
                    }
                    Spacer(minLength: 0)
                    Text(Fmt.shortDateTime(b.castAt))
                        .font(Type.meta).foregroundStyle(T.muted)
                }
                if let n = b.note, !n.isEmpty {
                    Text(n).font(Type.body).foregroundStyle(T.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if s.isOpen {
                    Text("You can change this at the desk until voting closes.")
                        .font(Type.meta).foregroundStyle(T.muted)
                }
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .edgeStrip(T.positive)
            .hairline()
        } header: {
            SectionHeader(text: "You voted")
        }
    }

    @ViewBuilder private func tallySection(_ s: VoteSession) -> some View {
        if let t = s.tally {
            Section {
                VStack(spacing: 0) {
                    StatLine(label: "OUTCOME", value: t.result ?? "—",
                             tone: t.result == nil ? T.muted : T.white)
                    StatLine(label: "BALLOTS CAST", value: "\(s.ballots?.count ?? 0)")
                    if let avg = t.buyAmountStats?.avg {
                        StatLine(label: "AVERAGE ALLOCATION", value: Fmt.money(avg))
                    }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                .background(T.card)
                .hairline()

                if let syn = s.synthesis, !syn.isEmpty {
                    Text(syn).font(Type.body).foregroundStyle(T.dim)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(Space.l)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(T.card)
                        .hairline()
                }
            } header: {
                SectionHeader(text: s.isOpen ? "Where it stands" : "Result")
            }
        }
    }
}
