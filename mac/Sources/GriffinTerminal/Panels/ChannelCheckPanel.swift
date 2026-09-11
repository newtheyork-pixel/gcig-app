import SwiftUI
import AppKit
import AVFoundation

// CHK — store channel checks, placed from the terminal.
//
// The club does not own a phone system. This panel owns the queue, the
// disclosure, the timer, the outcome and the transcript; the ringing is
// done by the analyst's own handset through a tel: URL, which on a Mac
// with a paired iPhone means the call goes out on a plan somebody is
// already paying for. There is no carrier in this app and there does not
// need to be one.
//
// Two things here are load-bearing and easy to mistake for chrome.
//
// EVERY DIAL IS A ROW, opened before the phone rings. Ring forty doors
// and eleven answer; a console that only wrote down the conversations
// would delete the denominator and turn the afternoon's read into "what
// the stores that felt like talking said". So the outcome buttons are
// the only way out of a call, and "Refused" is as much a result as
// "Answered".
//
// THE DISCLOSURE IS READ ALOUD, and the tick box records that it was.
// Recording somebody who has not agreed is unlawful in two-party states
// and fatal to the relationship. A call where they say no still proceeds
// — it just proceeds without a recorder, which is why the outcome
// buttons work whether or not the box is ticked and the upload does not.
struct ChannelCheckPanel: View {
    let ticker: String?

    @State private var projects: Loadable<[Proj]> = .loading
    @State private var project: Proj?
    @State private var queue: Loadable<QueuePayload> = .loading
    @State private var rollup: Rollup?
    @State private var selected: Door?

    /// The live call. Non-nil from the moment the row is written, which
    /// is before the handset rings, so a call that fails still has a row
    /// to record the failure on.
    @State private var call: OpenCall?
    @State private var startedAt: Date?
    @State private var elapsed = 0
    /// Set only when somebody on the other end says no. It is the one
    /// thing that stops a transcript being made, and it is a button
    /// rather than a checkbox because the default case is the one that
    /// happens forty times an afternoon.
    @State private var objected = false
    @StateObject private var recorder = CallRecorder()
    @State private var history: CallHistory.Availability = .absent
    /// A finished recording whose upload has not succeeded yet. Held so a
    /// network blip does not silently cost the tape.
    @State private var pendingRecording: URL?
    /// Guards against the tick firing `close()` twice while it runs.
    @State private var autoClosing = false
    /// Recordings still uploading. Shown in the header rather than as a
    /// spinner over the console, because the console is needed for the
    /// next call.
    @State private var transcribing = 0
    @State private var micAuth: AVAuthorizationStatus = .notDetermined
    /// This row is a call that already finished somewhere else. No
    /// timer, no recorder, just somewhere to put the outcome.
    @State private var loggingOnly = false
    @State private var notes = ""

    @State private var adding = false
    @State private var newName = ""
    @State private var newPhone = ""
    @State private var newState = ""
    @State private var newBanner = ""
    /// Whose counter it is. This is not bookkeeping: it decides whether
    /// the person who answers is filed as a current employee of the name
    /// under study, which sets the MNPI floor on everything they say.
    @State private var newOwned = true

    @State private var analystName: String?
    @State private var working: String?
    @State private var problem: String?

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    // MARK: Shapes

    struct Proj: Decodable, Identifiable, Hashable {
        let id: Int
        // `name`, because that is the column. This said `title` and the
        // whole pane died at bootstrap: a required key that the server
        // never sends makes JSONDecoder throw, and the failure is total
        // rather than a blank field. The house rule exists for this
        // exact mistake — decodables come from reading the handler.
        let name: String
        let ticker: String?
    }

    struct QueuePayload: Decodable {
        let undialable: Int
        /// Targets on this project with no number at all. Not listed, but
        /// counted: a queue that silently dropped them reads as a
        /// complete sample when it is not.
        let withoutPhone: Int?
        let targets: [Door]
    }

    struct Door: Decodable, Identifiable, Hashable {
        let id: Int
        let name: String
        let employer: String?
        let tier: String?
        let status: String?
        let locationState: String?
        let dialable: Bool
        let phoneDisplay: String?
        let telUrl: String?
        let attemptCount: Int
        let everAnswered: Bool
        let lastAttempt: LastAttempt?
    }

    struct LastAttempt: Decodable, Hashable {
        let id: Int
        let startedAt: String?
        let outcome: String?
        let durationMs: Int?
        let interviewId: Int?
    }

    struct OpenCall: Decodable {
        let id: Int
        let telUrl: String?
        let phoneDisplay: String?
        let dialedNumber: String
        /// Decided by the SERVER from the states at both ends, not picked
        /// here. Asking an analyst mid-call to rule on a state they have
        /// not looked up produced the safe answer every time, which threw
        /// away the tape even where keeping it was the point.
        let consentRegime: String?
        let consentReason: String?
        let consentUnknownEnd: Bool?
    }

    private var regime: String { call?.consentRegime ?? "all-party" }

    struct LogPayload: Decodable { let rollup: Rollup }

    struct Rollup: Decodable {
        let dials: Int
        let byOutcome: [String: Int]
        let transcribed: Int
    }

    /// Every one of these is a different fact. A single "didn't work"
    /// button would collect none of them: a refusal is evidence about the
    /// banner, a ring-out is evidence about the hour you chose.
    private static let outcomes: [(String, String)] = [
        ("Answered", "Answered"),
        ("Refused", "Wouldn't talk"),
        ("NoAnswer", "No answer"),
        ("Busy", "Busy"),
        ("Voicemail", "Voicemail"),
        ("CallBackLater", "Call back"),
        ("WrongNumber", "Wrong number"),
        ("Failed", "Didn't connect"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Term.border)
            HStack(spacing: 0) {
                queueColumn.frame(width: 330)
                Divider().overlay(Term.border)
                console.frame(maxWidth: .infinity)
            }
        }
        .background(Term.bgPanel)
        .task { await bootstrap() }
        .onReceive(tick) { _ in
            if let startedAt { elapsed = Int(Date().timeIntervalSince(startedAt)) }
            checkWhetherTheCallEnded()
        }
        .onDisappear {
            // Closing the pane mid-call must not leave a system-audio tap
            // running. It would go on capturing everything this Mac
            // plays, silently, with nothing on screen to say so.
            if recorder.state == .recording {
                _ = recorder.stop()
                recorder.discard()
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 14) {
            Text("CHK")
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            if let project {
                Text(project.name)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .lineLimit(1)
            }
            Spacer()
            if let r = rollup {
                // The denominator, always on screen. A channel check that
                // reports what eleven stores said without saying forty
                // were rung is a friendlier finding than the one the
                // afternoon produced.
                HStack(spacing: 12) {
                    stat("DIALS", "\(r.dials)")
                    stat("ANSWERED", "\(r.byOutcome["Answered"] ?? 0)")
                    stat("REFUSED", "\(r.byOutcome["Refused"] ?? 0)", tone: Term.orange)
                    stat("TRANSCRIBED", "\(r.transcribed)")
                    if transcribing > 0 {
                        stat("UPLOADING", "\(transcribing)", tone: Term.cyan)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Term.bgHeader)
    }

    private func stat(_ label: String, _ value: String, tone: Color = Term.fg) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(label).font(Term.mono(8)).foregroundStyle(Term.fgMuted)
            Text(value).font(Term.mono(12, weight: .bold)).foregroundStyle(tone)
        }
    }

    // MARK: Queue

    /// What a door's row says about itself.
    ///
    /// Refused is a RESULT, not a failure to get one. The protocol says
    /// accept the first no, so a door that declined is worked and done,
    /// and showing it as an untouched row is how somebody rings it four
    /// times. Fox Valley was rung four times this afternoon.
    static func badge(for door: Door) -> (text: String, tone: Color)? {
        if door.everAnswered { return ("DONE", Term.positive) }
        switch door.status {
        case "Declined":    return ("WOULDN'T TALK", Term.orange)
        case "Unreachable": return ("BAD NUMBER", Term.negative)
        case "Contacted":   return ("REACHED", Term.positive)
        default:            return nil
        }
    }

    private var queueColumn: some View {
        VStack(spacing: 0) {
            addBar
            Divider().overlay(Term.border)
            queueList
        }
    }

    private var addBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                adding.toggle()
            } label: {
                HStack(spacing: 5) {
                    Text(adding ? "▾" : "▸").font(Term.mono(9))
                    Text("ADD A DOOR").font(Term.mono(9, weight: .bold))
                }
                .foregroundStyle(Term.cyan)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if adding {
                field("Store", $newName, "Kay #1247 Easton, Columbus OH")
                field("Phone", $newPhone, "(614) 555-0134")
                HStack(spacing: 6) {
                    field("State", $newState, "OH")
                    field("Banner", $newBanner, "Kay")
                }
                Picker("", selection: $newOwned) {
                    Text("Company's own store").tag(true)
                    Text("Third party that stocks it").tag(false)
                }
                .pickerStyle(.radioGroup)
                .font(Term.mono(9))
                Button {
                    Task { await addDoor() }
                } label: {
                    Text("ADD")
                        .font(Term.mono(10, weight: .bold))
                        .foregroundStyle(Term.bg)
                        .padding(.horizontal, 14).padding(.vertical, 5)
                        .background(newName.isEmpty || newPhone.isEmpty ? Term.fgMuted : Term.cyan)
                }
                .buttonStyle(.plain)
                .disabled(newName.isEmpty || newPhone.isEmpty || working != nil)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func field(_ label: String, _ text: Binding<String>, _ hint: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(Term.mono(8)).foregroundStyle(Term.fgMuted)
            TextField(hint, text: text)
                .textFieldStyle(.plain)
                .font(Term.mono(10))
                .foregroundStyle(Term.fg)
                .padding(4)
                .background(Term.bg)
                .overlay(Rectangle().stroke(Term.border, lineWidth: 1))
        }
    }

    private var queueList: some View {
        PanelState(state: queue,
                   emptyWhen: { $0.targets.isEmpty },
                   emptyText: "No door on this project has a number yet. Add one above.",
                   retry: { Task { await loadQueue() } }) { payload in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if let missing = payload.withoutPhone, missing > 0 {
                        Text("\(missing) target\(missing == 1 ? "" : "s") on this project have no number")
                            .font(Term.mono(9))
                            .foregroundStyle(Term.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                    }
                    if payload.undialable > 0 {
                        // Said out loud rather than filtered away: a door
                        // you cannot ring is a gap in the sample.
                        Text("\(payload.undialable) number\(payload.undialable == 1 ? "" : "s") will not dial")
                            .font(Term.mono(9))
                            .foregroundStyle(Term.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                    }
                    ForEach(payload.targets) { door in
                        doorRow(door)
                        Divider().overlay(Term.border.opacity(0.4))
                    }
                }
            }
        }
    }

    private func doorRow(_ door: Door) -> some View {
        Button {
            guard call == nil else { return }
            selected = door
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(door.name)
                        .font(Term.mono(11, weight: selected?.id == door.id ? .bold : .regular))
                        .foregroundStyle(door.dialable ? Term.fg : Term.fgMuted)
                        .lineLimit(1)
                    Spacer()
                    // The disposition, which the server has been keeping
                    // all along and the list never showed. A door that
                    // refused looked exactly like one nobody had rung,
                    // so the only way to know what was left was to
                    // remember it.
                    if let badge = Self.badge(for: door) {
                        Text(badge.text).font(Term.mono(8, weight: .bold)).foregroundStyle(badge.tone)
                    } else if door.attemptCount > 0 {
                        Text("×\(door.attemptCount)").font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                    }
                }
                HStack(spacing: 6) {
                    Text(door.phoneDisplay ?? "no number")
                        .font(Term.mono(9))
                        .foregroundStyle(door.dialable ? Term.fgDim : Term.negative)
                    if let st = door.locationState, !st.isEmpty {
                        Text(st).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    }
                    if let tier = door.tier, !tier.isEmpty {
                        Text(tier).font(Term.mono(9)).foregroundStyle(Term.cyan)
                    }
                }
                if let last = door.lastAttempt, let outcome = last.outcome {
                    Text("last: \(outcome) · \(Fmt.date(last.startedAt))")
                        .font(Term.mono(8))
                        .foregroundStyle(Term.fgMuted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected?.id == door.id ? Term.bgPanelHover : Color.clear)
            .opacity(Self.badge(for: door) == nil ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(call != nil)
    }

    // MARK: Console

    private var console: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let problem {
                    Text(problem)
                        .font(Term.mono(10))
                        .foregroundStyle(Term.negative)
                        .textSelection(.enabled)
                }
                if let working {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small).tint(Term.amber)
                        Text(working).font(Term.mono(10)).foregroundStyle(Term.fgDim)
                    }
                }

                if let door = selected {
                    doorHeading(door)
                    if call == nil {
                        dialButton(door)
                    } else {
                        liveCall(door)
                    }
                } else {
                    PanelMessage(text: "Pick a door on the left.")
                        .frame(height: 120)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func doorHeading(_ door: Door) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(door.name).font(Term.mono(14, weight: .bold)).foregroundStyle(Term.white)
            HStack(spacing: 8) {
                Text(door.phoneDisplay ?? "—").font(Term.mono(11)).foregroundStyle(Term.fgDim)
                if let e = door.employer, !e.isEmpty {
                    Text(e).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                }
                if let st = door.locationState, !st.isEmpty {
                    Text(st).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                }
            }
        }
    }

    private func dialButton(_ door: Door) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if door.everAnswered {
                Text("This door has already been reached. A second conversation arrives as a duplicate data point unless there is a reason for it.")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                Task { await openCall(door) }
            } label: {
                Text("DIAL")
                    .font(Term.mono(13, weight: .bold))
                    .foregroundStyle(Term.bg)
                    .padding(.horizontal, 26)
                    .padding(.vertical, 9)
                    .background(door.dialable ? Term.amber : Term.fgMuted)
            }
            .buttonStyle(.plain)
            .disabled(!door.dialable || working != nil)

            Text("Opens the call on your phone and records both sides here. The row is written before it rings, so a call that fails is still logged.")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
                .fixedSize(horizontal: false, vertical: true)

            Divider().overlay(Term.border).padding(.vertical, 2)

            // The other way of working, and the ordinary one for anybody
            // not sitting at this Mac. The desk records both sides because
            // both sides are on the desk; a call made on a handset in a
            // car is recorded by the handset, and all this end has to do
            // is hold the row and take the file afterwards.
            Button {
                Task { await openCall(door, dial: false) }
            } label: {
                Text("RECORD")
                    .font(Term.mono(10, weight: .bold))
                    .foregroundStyle(Term.bg)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(Term.cyan)
            }
            .buttonStyle(.plain)
            .disabled(working != nil)

            Text("Starts recording without dialling, for a call you placed on your own handset. Put it on speaker next to the Mac and this captures it the same way.")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
                .fixedSize(horizontal: false, vertical: true)

            // For a call that is already over. Without this the only way
            // to record that a door was rung is to have pressed a button
            // before ringing it, and a call nobody logged is a hole in
            // the denominator that looks like a door nobody tried.
            Button {
                Task { await openCall(door, dial: false, record: false) }
            } label: {
                Text("ALREADY CALLED THEM")
                    .font(Term.mono(9, weight: .bold))
                    .foregroundStyle(Term.cyan)
            }
            .buttonStyle(.plain)
            .disabled(working != nil)

            Text("Writes the row for a call that already finished, so you can mark how it went. No recording.")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func liveCall(_ door: Door) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text(clock(elapsed))
                    .font(Term.mono(22, weight: .bold))
                    .foregroundStyle(Term.positive)
                // The clock cannot see your call end. Saying what it is
                // waiting for is the difference between a timer and a
                // stopwatch somebody thinks has broken.
                Text(loggingOnly ? "logging a call that already happened"
                     : autoClosing ? "closing"
                     : (history.isUsable || recorder.farEndCaptured) ? "closes when you hang up"
                     : "running until you pick an outcome")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                Spacer()
                if let url = call?.telUrl {
                    Button("Re-dial") { open(url) }
                        .buttonStyle(.plain)
                        .font(Term.mono(10))
                        .foregroundStyle(Term.cyan)
                }
            }

            // Rendered again. It was defined and never called after the
            // consent block was rewritten, which meant the one line that
            // says whether your own voice is being captured was missing
            // from the screen for the whole of the first real calling
            // session. A recorder you cannot see is a recorder you cannot
            // check.
            recorderStatus

            if micAuth == .denied || micAuth == .restricted {
                // Stated where it will be read, in the colour of a
                // problem. Without the microphone this records the store
                // and not you, which looks like a working channel check
                // until somebody reads the transcript.
                HStack(spacing: 8) {
                    Text("Microphone is OFF for this app, so only the store will be recorded.")
                        .font(Term.mono(10))
                        .foregroundStyle(Term.negative)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Open settings") {
                        if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                            NSWorkspace.shared.open(u)
                        }
                    }
                    .buttonStyle(.plain)
                    .font(Term.mono(9))
                    .foregroundStyle(Term.cyan)
                }
            }

            if history == .needsFullDiskAccess {
                // Offered rather than demanded. Without it the duration
                // is the app's own timer, which is honest but coarser,
                // and the log says which one it got.
                HStack(spacing: 8) {
                    Text("Durations are this app's timer. Let it read the phone's own call record for the real ones.")
                        .font(Term.mono(9))
                        .foregroundStyle(Term.fgMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Grant") { CallHistory.openFullDiskAccessSettings() }
                        .buttonStyle(.plain)
                        .font(Term.mono(9))
                        .foregroundStyle(Term.cyan)
                }
            }

            consentBlock(door)

            scriptBlock

            VStack(alignment: .leading, spacing: 4) {
                Text("NOTES").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                TextEditor(text: $notes)
                    .font(Term.mono(11))
                    .scrollContentBackground(.hidden)
                    .background(Term.bg)
                    .frame(height: 120)
                    .overlay(Rectangle().stroke(Term.border, lineWidth: 1))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text((history.isUsable || recorder.farEndCaptured)
                     ? "IT CLOSES ITSELF WHEN YOU HANG UP — OR OVERRIDE HERE"
                     : "HOW DID IT END")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 6)], spacing: 6) {
                    ForEach(Self.outcomes, id: \.0) { code, label in
                        Button {
                            Task { await close(outcome: code) }
                        } label: {
                            Text(label)
                                .font(Term.mono(10))
                                .foregroundStyle(code == "Answered" ? Term.bg : Term.fg)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 7)
                                .background(code == "Answered" ? Term.positive : Term.bgPanelHover)
                        }
                        .buttonStyle(.plain)
                        .disabled(working != nil)
                    }
                }
            }

            if !objected {
                // The fallback, for a call recorded on a handset instead
                // of by this app. Kept even now the recorder works,
                // because an analyst in a car with a phone is the
                // ordinary case and the desk is the exception.
                Button {
                    pickRecording()
                } label: {
                    Text(recorder.state == .recording ? "ATTACH A FILE INSTEAD" : "ATTACH RECORDING")
                        .font(Term.mono(10, weight: .bold))
                        .foregroundStyle(Term.bg)
                        .padding(.horizontal, 16).padding(.vertical, 7)
                        .background(Term.cyan)
                }
                .buttonStyle(.plain)
                .disabled(working != nil)
            }
        }
    }

    private func consentBlock(_ door: Door) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Read on EVERY call, which is what makes the recording lawful
            // at both ends. It is not a gate and there is nothing to tick:
            // a gate that is satisfied forty times an afternoon stops
            // being read and starts being clicked.
            Text("READ THIS OUT, FIRST THING")
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.orange)
            Text(disclosure)
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .background(Term.bg)
                .overlay(Rectangle().stroke(Term.orange.opacity(0.5), lineWidth: 1))

            HStack(spacing: 10) {
                // The regime is shown, with its reason, rather than asked.
                Text(regime == "one-party" ? "Tape kept" : "Tape deleted after transcribing")
                    .font(Term.mono(10, weight: .bold))
                    .foregroundStyle(regime == "one-party" ? Term.positive : Term.fgDim)
                if let why = call?.consentReason {
                    Text(why)
                        .font(Term.mono(9))
                        .foregroundStyle(call?.consentUnknownEnd == true ? Term.orange : Term.fgMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if objected {
                Text("Marked as objected to. The recording has been destroyed and no transcript will be made.")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.negative)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Button {
                    // One press, for the rare person who says no. Stops
                    // and destroys rather than pausing: somebody
                    // withdrawing means the audio should not exist.
                    objected = true
                    stopAndDiscard()
                } label: {
                    Text("THEY SAID NO — STOP RECORDING")
                        .font(Term.mono(9, weight: .bold))
                        .foregroundStyle(Term.bg)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(Term.negative)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// The banner's questions, on screen while the call is live.
    ///
    /// These are not variations on one sheet. Banter sells no bridal and
    /// carries no engagement-ring question at all; Jared's anchors are
    /// four and eight thousand dollars where Banter's is a hundred and
    /// fifty. The wrong sheet in front of somebody mid-call is a wasted
    /// door, which is why it keys off the banner rather than being one
    /// list everybody scrolls past.
    @ViewBuilder
    private var scriptBlock: some View {
        if let script {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("\(script.banner.uppercased()) — \(script.questions.count) QUESTIONS")
                        .font(Term.mono(9, weight: .bold))
                        .foregroundStyle(Term.amber)
                }
                Text(script.note)
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)

                ForEach(Array(script.questions.enumerated()), id: \.offset) { i, q in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(i + 1)")
                                .font(Term.mono(10, weight: .bold))
                                .foregroundStyle(Term.bg)
                                .frame(width: 16, height: 16)
                                .background(Term.amber)
                            Text(q.text)
                                .font(Term.mono(11))
                                .foregroundStyle(Term.white)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if !q.why.isEmpty {
                            Text(q.why)
                                .font(Term.mono(9))
                                .foregroundStyle(Term.fgMuted)
                                .padding(.leading, 24)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                Text(script.followUps)
                    .font(Term.mono(9))
                    .foregroundStyle(Term.cyan)
                    .fixedSize(horizontal: false, vertical: true)
                Text("DO NOT ASK: \(script.doNotAsk)")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(Term.bg)
            .overlay(Rectangle().stroke(Term.border, lineWidth: 1))
        } else {
            Text("No call sheet for this banner. Set the door's banner to Kay, Kay Outlet, Zales, Jared or Banter and the questions appear here.")
                .font(Term.mono(9))
                .foregroundStyle(Term.orange)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var recorderStatus: some View {
        if recorder.state == .recording {
            HStack(spacing: 6) {
                Circle().fill(Term.negative).frame(width: 7, height: 7)
                Text(recorder.bothSidesLive ? "Recording both sides"
                     : recorder.farEndCaptured ? "Recording them, NOT you"
                     : "Recording the microphone")
                    .font(Term.mono(10))
                    .foregroundStyle(recorder.bothSidesLive ? Term.fg
                                     : recorder.micHasAudio ? Term.fg : Term.orange)
                if regime == "one-party" {
                    Text("· tape kept").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                } else {
                    Text("· tape deleted after transcribing").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
            }
            if recorder.micHasAudio && !recorder.farEndCaptured {
                // Not a fault. It means the call is not running through
                // this Mac, which is the normal case when somebody dials
                // on their own handset. On speaker the microphone carries
                // both voices and the transcript separates them, which is
                // how the first two-speaker transcript we got was made.
                Text("The call is not routed through this Mac, so only the microphone is capturing. "
                     + "Put the handset on SPEAKER and both voices land on it.")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if recorder.farEndCaptured && !recorder.echoCancelled {
                // Worth saying only in this combination. On speakers
                // without cancellation the store's voice is in both
                // channels, so the separation is softer than it looks.
                Text("Echo cancellation is off, so the two channels will bleed into each other. Headphones fix it.")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let note = recorder.farEndNote {
                // Said plainly. A recording that holds one voice and looks
                // like it holds two is the failure worth shouting about.
                Text(note)
                    .font(Term.mono(9))
                    .foregroundStyle(Term.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// What gets read out, and then stored verbatim as the call's consent
    /// note and copied onto the interview.
    ///
    /// It used to name the jewelry business. CHK opens on any project, so
    /// on CHRW that script was read to a trucking depot and the false
    /// sentence was then persisted as the record of what was disclosed.
    /// Nothing here names a sector: the store knows what it sells.
    /// The banner's own sheet where there is one, and Thomas wrote them
    /// under the heading SAY IT EXACTLY LIKE THIS, so they are verbatim
    /// with the caller's name filled in.
    ///
    /// One sentence is appended: the recording disclosure. The sheets
    /// were written for a process that took notes and did not record, and
    /// this app records. Reading the sheet as written while a recorder
    /// runs would remove the thing that makes the recording lawful.
    private var script: CallScript? { CallScript.forBanner(selected?.tier) }

    private var disclosure: String {
        let who = analystName ?? "[name]"
        if let script {
            return script.opener.replacingOccurrences(of: "[name]", with: who)
                + " " + CallScript.recordingLine
        }
        return "Hi, my name is \(who). I'm a high school student at Grace Church School in New York "
            + "and I'm doing a research project on the jewellery business for our school investment club. "
            + "Do you have two minutes for a few questions about what's in the store? "
            + CallScript.recordingLine
    }

    // MARK: Actions

    private func bootstrap() async {
        analystName = try? await API.shared.me().name
        history = CallHistory.probe()
        // Raise the microphone prompt when the panel opens, not when a
        // call starts. A permission dialog appearing over a live call is
        // a dialog somebody dismisses to get back to the person talking,
        // and the cost of dismissing it is a recording with one voice.
        micAuth = await CallRecorder.requestMicrophone()
        do {
            var query: [String: String] = [:]
            if let ticker, !ticker.isEmpty { query["ticker"] = ticker.uppercased() }
            let data = try await API.shared.get("/research/projects", query: query)
            let list = try await decodeProjects(data)
            projects = .loaded(list)
            project = list.first
            if project == nil {
                queue = .failed(ticker.map { "No research project for \($0). Open one in FLD first." }
                                ?? "No research project open.")
                return
            }
            await loadQueue()
        } catch {
            projects = .failed(String(describing: error).prefix(160).description)
            queue = .failed("Could not load projects.")
        }
    }

    /// /research/projects answers with a bare array for a member and a
    /// wrapped object elsewhere. Both shapes have been live, so both are
    /// read rather than whichever one this account happens to get.
    private func decodeProjects(_ data: Data) async throws -> [Proj] {
        if let list = try? await API.shared.decode([Proj].self, from: data) { return list }
        struct Wrap: Decodable { let projects: [Proj] }
        return try await API.shared.decode(Wrap.self, from: data).projects
    }

    private func loadQueue() async {
        guard let project else { return }
        queue = .loading
        do {
            let data = try await API.shared.get("/research/projects/\(project.id)/call-queue")
            let payload = try await API.shared.decode(QueuePayload.self, from: data)
            queue = .loaded(payload)
            // Re-resolve the open door against the rows we just fetched.
            // Without it the selection keeps the attempt list it was drawn
            // with, so the "already reached" warning stays suppressed for
            // a door that answered thirty seconds ago.
            if let current = selected {
                selected = payload.targets.first { $0.id == current.id }
            }
        } catch {
            queue = .failed(String(describing: error).prefix(160).description)
            return
        }
        // The roll-up is a header statistic over a five-hundred-row query.
        // It failing must not take the dial list down with it, which is
        // what a shared catch did.
        if let log = try? await API.shared.get("/research/projects/\(project.id)/calls") {
            rollup = try? await API.shared.decode(LogPayload.self, from: log).rollup
        }
    }

    private func addDoor() async {
        guard let project else { return }
        problem = nil
        working = "Adding…"
        defer { working = nil }
        do {
            var body: [String: Any] = [
                "name": newName,
                // Whose counter it is, carried through to the source the
                // call becomes. See the note on `newOwned`.
                "relationship": newOwned ? "CurrentEmployee" : "Distributor",
                "phone": newPhone,
            ]
            if !newBanner.isEmpty { body["tier"] = newBanner }
            if !newState.isEmpty { body["locationState"] = newState.uppercased() }
            _ = try await API.shared.post("/research/projects/\(project.id)/targets", json: body)
            newName = ""; newPhone = ""; newState = ""; newBanner = ""
            await loadQueue()
        } catch {
            // The server refuses a number it cannot dial rather than
            // storing it, so this is usually a typo in the number and
            // saying which is more use than "could not save".
            problem = "Could not add the door: \(String(describing: error).prefix(160))"
        }
    }

    /// Open a call row, and optionally place the call.
    ///
    /// `dial: false` is the handset path: somebody rang the store from
    /// their own phone and has it on speaker next to the Mac. The row,
    /// the disclosure, the regime, the recording and the transcript are
    /// all identical; the only difference is that nothing is handed to
    /// FaceTime. Recording starts either way, because it starting is the
    /// entire point of the button.
    private func openCall(_ door: Door, dial: Bool = true, record: Bool = true) async {
        guard let project else { return }
        problem = nil
        working = "Opening the call…"
        defer { working = nil }
        do {
            let data = try await API.shared.post("/research/projects/\(project.id)/calls",
                                                 json: ["targetId": door.id])
            let opened = try await API.shared.decode(OpenCall.self, from: data)
            call = opened
            startedAt = Date()
            elapsed = 0
            objected = false
            autoClosing = false
            notes = ""
            if dial, let url = opened.telUrl { open(url) }
            loggingOnly = !record
            // Always, unless this is a call that already happened and we
            // are only writing it down. The disclosure is the first thing
            // said on a live call, so there is nothing to wait for, and a
            // recorder that starts late loses the opening of every one.
            if record { beginRecording() }
        } catch {
            problem = "Could not open the call: \(String(describing: error).prefix(140))"
        }
    }

    /// macOS writes a call into its own history when the call ENDS, so
    /// the row appearing is the only signal we can get that the handset
    /// hung up. There is no public API for live call state, which is why
    /// the timer used to run until somebody pressed a button.
    ///
    /// Without Full Disk Access there is no record to read and the
    /// buttons remain the way out. The panel says so rather than leaving
    /// a clock running with no explanation.
    private func checkWhetherTheCallEnded() {
        guard call != nil, startedAt != nil, !autoClosing, working == nil else { return }
        // Do not race the dial. A record can exist for a previous attempt
        // and the nearest-match rule needs a few seconds of daylight.
        guard elapsed >= 12 else { return }

        if endedAccordingToThePhone() || endedAccordingToTheAudio() {
            autoClosing = true
            Task { await close() }
        }
    }

    /// The reliable signal, and the one that also gives a true duration.
    /// Needs Full Disk Access, which is why the audio fallback exists.
    private func endedAccordingToThePhone() -> Bool {
        guard history.isUsable, let call, let startedAt else { return false }
        guard let record = CallHistory.mostRecent(matching: call.dialedNumber, placedAt: startedAt)
        else { return false }
        // A duration means a finished conversation. A record with none,
        // once the phone has plainly given up ringing, is a ring-out.
        return record.duration > 0 || (record.answered == false && elapsed >= 45)
    }

    /// The signal that needs no permission at all.
    ///
    /// A live call pushes line noise into the far channel continuously,
    /// even while nobody is talking. A call that has ended pushes digital
    /// silence. Twenty-five seconds of that, on a call that had audio in
    /// the first place, is a hangup rather than a pause — and the cost of
    /// being wrong is a row closed early, which a person can reopen, not
    /// a recording lost.
    private func endedAccordingToTheAudio() -> Bool {
        guard recorder.farEndCaptured, elapsed >= 30 else { return false }
        guard let silent = recorder.farEndSilentFor else { return false }
        return silent >= 25
    }

    /// Move to the next door worth ringing.
    ///
    /// An afternoon of channel checks is a queue worked top to bottom,
    /// and making somebody find their place again after every call is how
    /// a list of forty becomes a list of eleven.
    private func advanceToNextDoor() {
        guard case .loaded(let payload) = queue else { return }
        let current = selected?.id
        let untried = payload.targets.filter { $0.dialable && $0.attemptCount == 0 && $0.id != current }
        // A door that already declined is finished. Advancing onto one is
        // how a store gets rung four times in an afternoon, which is
        // exactly what happened to Fox Valley.
        selected = untried.first
            ?? payload.targets.first { $0.dialable && Self.badge(for: $0) == nil && $0.id != current }
    }

    private func beginRecording() {
        // `start()` returns silently when it is already running, so a
        // re-tick used to look like it had begun a fresh recording while
        // the old one, started before consent, kept going.
        guard recorder.state != .recording else { return }
        do {
            try recorder.start()
        } catch {
            problem = "Could not start recording: \(error.localizedDescription). The call is fine; take notes."
        }
    }

    /// Stop and destroy. Used whenever the authority the recording rested
    /// on has gone away.
    private func stopAndDiscard() {
        _ = recorder.stop()
        recorder.discard()
    }

    /// Hanging up: stop the tape, ask the phone what actually happened,
    /// write the outcome, then send the audio.
    ///
    /// The order matters. The outcome is saved before the upload because
    /// a transcription failure must not cost the log its row — the dial
    /// happened whether or not the recording survived, and that is the
    /// number the denominator is built from.
    /// Close the call.
    ///
    /// `outcome` is optional and usually nil. It used to be the only way
    /// out of a row, eight buttons at the moment an analyst is still
    /// thinking about what the manager said, and a forgotten press left
    /// the timer running forever. The phone's record says whether anybody
    /// picked up and the model reads the transcript for the rest; a
    /// button press is now an override, not a toll.
    private func close(outcome: String? = nil) async {
        guard let call else { return }
        working = "Saving…"
        defer { working = nil }

        let file = recorder.stop()

        var body: [String: Any] = [
            "endedAt": ISO8601DateFormatter().string(from: Date()),
            "durationMs": elapsed * 1000,
            // Named for what it is. This clock started when a human
            // pressed DIAL, so it counts ringing and the seconds spent
            // finding the handset.
            "metadataSource": "apptimer",
            // False only if somebody objected. The disclosure is read
            // every time, so the default is the honest one.
            "consentSpoken": !objected,
        ]
        // Sent only when a human overrode it. Absent, the server works it
        // out from the call record and the transcript.
        if let outcome { body["outcome"] = outcome }
        // The phone kept its own record. Where it is readable it wins,
        // because it knows when the call CONNECTED and our clock only
        // knows when somebody pressed a button.
        if history.isUsable, let placed = startedAt,
           let record = CallHistory.mostRecent(matching: call.dialedNumber, placedAt: placed) {
            body["durationMs"] = Int(record.duration * 1000)
            body["metadataSource"] = "callhistory"
            body["answered"] = record.answered
        }
        body["consentNote"] = objected
            ? "Disclosure read; they objected. Recording destroyed, no transcript made."
            : "Read aloud at the top of the call: \(disclosure)"
        if !notes.isEmpty { body["notes"] = notes }

        do {
            _ = try await API.shared.patch("/research/calls/\(call.id)", json: body)
        } catch {
            // The recorder has already been stopped and merged, so an
            // early return here used to strand the finished WAV: pressing
            // an outcome again got nil back from a recorder that was now
            // idle, and the call was saved with no recording at all.
            // The file is remembered instead, and the retry uses it.
            pendingRecording = file ?? pendingRecording
            problem = "Could not save the outcome: \(String(describing: error).prefix(140)). "
                + (pendingRecording != nil ? "The recording is held; press an outcome again." : "")
            return
        }

        // The upload runs BEHIND you, not in front of you.
        //
        // Transcription is a minute of somebody else's server time, and
        // making the analyst watch it meant the queue stopped dead after
        // every call. The row is already saved by this point, so the only
        // thing still outstanding is audio, and nothing about the next
        // door depends on it.
        let toUpload = file ?? pendingRecording
        let dir = recorder.detachWorkingDirectory()
        let callId = call.id
        let keepOnFailure = (regime == "one-party")
        if let toUpload, !objected {
            transcribing += 1
            Task {
                defer { transcribing -= 1 }
                do {
                    _ = try await API.shared.upload("/research/calls/\(callId)/recording",
                                                    fileURL: toUpload, fields: [:])
                    if let dir { try? FileManager.default.removeItem(at: dir) }
                } catch {
                    // Under all-party the audio goes either way: they
                    // agreed to a conversation being transcribed, not to
                    // us holding a copy. Under one-party the tape is what
                    // a contested claim gets walked back to, so a failed
                    // upload keeps it rather than deleting the only copy.
                    if keepOnFailure {
                        problem = "Call \(callId) is logged, but its recording did not go through. "
                            + "It is kept at \(toUpload.path)."
                    } else {
                        if let dir { try? FileManager.default.removeItem(at: dir) }
                        problem = "Call \(callId) is logged, but the transcript failed and the audio is gone, "
                            + "because this one was all-party."
                    }
                }
                await loadQueue()
            }
        } else if let dir {
            try? FileManager.default.removeItem(at: dir)
        }
        pendingRecording = nil

        self.call = nil
        startedAt = nil
        elapsed = 0
        objected = false
        autoClosing = false
        loggingOnly = false
        await loadQueue()
        advanceToNextDoor()
    }

    /// Audio only. The server takes what it is given, but a video file is
    /// a hundred megabytes of pixels nobody transcribes.
    private func pickRecording() {
        guard let call else { return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Pick the recording of this call"
        panel.prompt = "Upload"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            working = "Transcribing \(url.lastPathComponent)…"
            defer { working = nil }
            do {
                // Consent lives on the call row and is only written when
                // the call is closed, so attaching a file DURING a live
                // all-party call posted audio the server had no record of
                // anyone agreeing to, and it 409'd. Write it first.
                _ = try await API.shared.patch("/research/calls/\(call.id)", json: [
                    "consentSpoken": !objected,
                ])
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                _ = try await API.shared.upload("/research/calls/\(call.id)/recording",
                                                fileURL: url, fields: [:])
                await loadQueue()
            } catch {
                problem = "Upload failed: \(String(describing: error).prefix(160))"
            }
        }
    }

    private func open(_ url: String) {
        guard let u = URL(string: url) else { return }
        NSWorkspace.shared.open(u)
    }

    // MARK: Formatting

    /// Duration on the wall clock. Not `Fmt`: everything there formats a
    /// date, and this is an elapsed count that has to tick every second.
    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
