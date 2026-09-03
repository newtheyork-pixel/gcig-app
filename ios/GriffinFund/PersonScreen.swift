import SwiftUI

// One person, and everything we have said to them.
//
// Today lists who is owed an answer and who is due a chase, and until now
// a row could not be opened: it named somebody and gave you no way to see
// what had actually passed between us. That is the wrong shape for the
// screen you check between classes, because the first question any of
// those rows raises is "what did I say last time".
//
// What this screen deliberately does NOT carry is any way to send. The
// desk owns sending, because that is where the screen, the approvals and
// a keyboard are, and a second door onto "did we write to them" is the
// thing that already made a contact's progress disagree with itself in
// four places. The phone reads the correspondence and nothing more.

@MainActor
final class PersonStore: ObservableObject {
    @Published private(set) var state: Loadable<Target> = .loading

    func load(_ id: Int) async {
        state = .loading
        await fetch(id, keepOld: false)
    }

    /// Pull-to-refresh and the stale strip's retry, and the reason it is a
    /// separate method: `load` blanks the screen to a spinner on the way in
    /// and to a bare error on the way out. Wiring pull-to-refresh to it
    /// meant one flaky request — the Render cold start this whole client is
    /// built around — replaced a member's visible correspondence thread with
    /// a RETRY button. Every other store here already had this split.
    func refresh(_ id: Int) async { await fetch(id, keepOld: true) }

    private func fetch(_ id: Int, keepOld: Bool) async {
        let previous = state.value
        do {
            state = .loaded(try await API.shared.get("/research/targets/\(id)", as: Target.self),
                            at: Date())
        } catch APIError.cancelled {
            return
        } catch {
            let msg = error.localizedDescription
            state = keepOld && previous != nil ? .stale(previous!, msg) : .failed(msg)
        }
    }
}

struct PersonScreen: View, Hashable {
    let targetId: Int
    /// What the Today row already knew, so the screen has a title the
    /// instant it opens rather than a spinner where a name should be.
    var knownName: String? = nil

    @StateObject private var store = PersonStore()
    @ObservedObject private var clock = StaleClock.shared

    static func == (a: PersonScreen, b: PersonScreen) -> Bool { a.targetId == b.targetId }
    func hash(into h: inout Hasher) { h.combine(targetId) }

    var body: some View {
        ScreenState(state: store.state.aged(after: 600, now: clock.tick),
                    retry: { Task { await store.load(targetId) } },
                    staleRetry: { Task { await store.refresh(targetId) } }) { t in
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    header(t)
                    statusSection(t)
                    threadSection(t)
                    draftsSection(t)
                }
            }
            // A reply can land at any moment and this screen is where you
            // find out. It had no refresh of any kind short of navigating
            // away and back.
            .refreshable { await store.refresh(targetId) }
        }
        .background(T.bg)
        .navigationTitle("")
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: Space.s) {
                    Text("FLD").font(Type.screenCode).foregroundStyle(T.white)
                    Text(store.state.value?.name ?? knownName ?? "Contact")
                        .font(Type.screenTitle).tracking(0.8)
                        .foregroundStyle(T.white).lineLimit(1)
                }
            }
        }
        .toolbarBackground(T.redBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task { if store.state.value == nil { await store.load(targetId) } }
    }

    private func header(_ t: Target) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(t.name ?? "Unnamed contact")
                .font(Font.prose(20, .semibold))
                .foregroundStyle(T.white)
                .fixedSize(horizontal: false, vertical: true)

            if let sub = [t.role, t.employer].compactMap({ $0 }).joined(separator: ", ").nilIfEmpty {
                Text(sub).font(Type.body).foregroundStyle(T.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: Space.s) {
                if let r = t.relationship { Chip(text: r, tone: T.blue) }
                if let tier = t.tier { Chip(text: tier, tone: T.muted) }
                // The project this person belongs to is a ticker, and a
                // ticker on our screens is always a door.
                if let tk = t.project?.ticker {
                    NavigationLink(value: TickerScreen(symbol: tk)) {
                        Chip(text: tk, tone: T.amber, style: .solid)
                    }
                    .buttonStyle(.plain)
                }
            }

            // The address is TEXT, not a link, and that is deliberate.
            //
            // It used to be a mailto:, on the theory that the phone should
            // open "the thread in a mail client that already has the
            // history". That theory is wrong twice. The thread lives in the
            // club Gmail account the letter was sent from — the reply sweep
            // keys on `sentById` for exactly this reason — so a member's
            // personal Mail app has no history of it and starts a new one.
            // And a message sent that way is a real approach to a management
            // contact that never passes the MNPI screen, never lands in the
            // OutreachMessage ledger, and is invisible to the follow-up
            // clock, which will then recommend chasing somebody who was
            // written to yesterday.
            //
            // This screen already refuses a Copy button on drafts on those
            // grounds. Offering tap-to-send two sections above it was the
            // larger version of the same door. The README's rule stands:
            // the phone tells you Kanter replied; answering him happens
            // where there is a keyboard.
            if let e = t.email, !e.isEmpty {
                Text(e)
                    .font(Type.meta).foregroundStyle(T.dim)
                    .textSelection(.enabled)
            } else if let c = t.channel {
                Text(c).font(Type.meta).foregroundStyle(T.muted)
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }

    /// The server's own recommendation sentence, rendered verbatim. It
    /// already explains the working-day arithmetic behind the state, and
    /// a client that paraphrased it would eventually contradict it.
    private func statusSection(_ t: Target) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.s) {
                    Chip(text: t.status ?? "Identified", tone: T.dim)
                    if let f = t.followUp?.state {
                        Chip(text: f, tone: stateTone(f), style: .solid)
                    }
                    Spacer(minLength: 0)
                }
                if let rec = t.followUp?.recommendation {
                    Text(rec).font(Type.body).foregroundStyle(T.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let d = t.followUp?.dueDay ?? t.followUp?.dueAt.map(Fmt.day) {
                    Text("Due \(d)").font(Type.meta).foregroundStyle(T.muted)
                }
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .hairline()
        } header: {
            SectionHeader(text: "Where this stands")
        }
    }

    private func stateTone(_ s: String) -> Color {
        switch s {
        case "owed", "overdue", "bounced": return T.negative
        case "due":                        return T.amber
        case "answered":                   return T.positive
        default:                           return T.muted
        }
    }

    /// Oldest first, because this is a correspondence and a thread that
    /// reads newest-down is a thread nobody can follow.
    @ViewBuilder private func threadSection(_ t: Target) -> some View {
        let msgs = t.messages ?? []
        Section {
            if msgs.isEmpty {
                EmptyState(text: "Nothing logged yet.")
                    .frame(height: 80)
            } else {
                ForEach(Array(msgs.enumerated()), id: \.offset) { _, m in
                    message(m)
                }
            }
        } header: {
            SectionHeader(text: "Correspondence", trailing: msgs.isEmpty ? nil : "\(msgs.count)")
        }
    }

    private func message(_ m: TargetMessage) -> some View {
        let inbound = m.direction == "in"
        return VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.s) {
                // Direction is the fact that matters most and the one a
                // wall of grey text hides, so it is a chip and a strip
                // rather than an indent.
                Chip(text: inbound ? "They wrote" : "We wrote",
                     tone: inbound ? T.positive : T.blue)
                if let k = m.kind, k != "Reply", k != "Other" { Chip(text: k, tone: T.orange) }
                Spacer(minLength: 0)
                Text(Fmt.shortDateTime(m.occurredAt))
                    .font(Type.meta).foregroundStyle(T.muted)
            }
            if let s = m.subject, !s.isEmpty {
                Text(s).font(Type.headline).foregroundStyle(T.white)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let b = m.body, !b.isEmpty {
                Text(b).font(Type.body).foregroundStyle(T.dim)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .edgeStrip(inbound ? T.positive : nil)
        .hairline()
    }

    /// Drafts are shown as status, never as something to send from here.
    /// A draft's blocked and screened state is computed on the server and
    /// rendered as computed: this screen has no Copy button precisely
    /// because a compliance veto you can copy past is not a veto.
    @ViewBuilder private func draftsSection(_ t: Target) -> some View {
        let drafts = t.drafts ?? []
        if !drafts.isEmpty {
            Section {
                ForEach(Array(drafts.enumerated()), id: \.offset) { _, d in
                    Row(title: d.subject ?? "Untitled draft",
                        subtitle: d.sentAt != nil ? "Sent \(Fmt.day(d.sentAt))" : "Not sent",
                        meta: d.stage,
                        strip: d.screenRisk == "prohibited" ? T.negative : nil) {
                        if d.screenRisk == "prohibited" {
                            Chip(text: "Blocked", tone: T.negative, style: .solid)
                        } else if d.screenedAt == nil {
                            Chip(text: "Unscreened", tone: T.muted)
                        } else if d.sentAt != nil {
                            Chip(text: "Sent", tone: T.positive)
                        } else if d.fullyApproved == true {
                            Chip(text: "Ready", tone: T.positive, style: .solid)
                        }
                    }
                }
                Text("Sending happens at the desk.")
                    .font(Type.meta).foregroundStyle(T.muted)
                    .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } header: {
                SectionHeader(text: "Drafts", trailing: "\(drafts.count)")
            }
        }
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
