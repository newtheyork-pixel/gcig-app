import SwiftUI
import AppKit

// Opening an interview, and everything it needs afterwards.
//
// The panel could read interviews from the day it shipped and could not
// create one, so the tab carried a line telling you to go and use the
// browser. Every gate the web enforces is enforced here too, because a
// second surface that is laxer than the first is not a second surface,
// it is a hole:
//
//   Consent is fixed at creation and the server refuses audio without
//   it. Nothing here can flip it afterwards, which is deliberate — an
//   interview opened without consent stays without it, and the audio
//   simply never gets stored.
//
//   The attestation is a claim about what happened before the call, so
//   it is off by default. Ticking it is a person saying they did the
//   thing, not a box the form ticks for them.
//
//   Extraction is disabled until a transcript exists, because the server
//   409s on that and a button that always fails teaches nothing.

/// Sources, fetched for the picker. An interview must belong to one, and
/// creating a source from inside the form is the difference between
/// logging a call now and logging it later.
struct SourcePicker: View {
    @Binding var sourceId: Int?
    @Binding var busy: Bool
    let run: RunAction

    @State private var sources: [Row] = []
    @State private var creating = false
    @State private var alias = ""
    @State private var employer = ""
    @State private var role = ""
    @State private var relationship = "IndustryExpert"
    @State private var loadError: String?

    struct Row: Decodable, Identifiable {
        let id: Int
        let alias: String?
        let employer: String?
        let relationship: String?
    }

    static let relationships = [
        "FormerEmployee", "CurrentEmployee", "Customer", "Distributor",
        "Supplier", "Competitor", "IndustryExpert", "Other",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("SOURCE").font(Term.mono(9, weight: .bold)).tracking(0.5)
                    .foregroundStyle(Term.fgMuted).frame(width: 74, alignment: .leading)
                Picker("", selection: $sourceId) {
                    Text("— pick one —").tag(Int?.none)
                    ForEach(sources) { s in
                        Text([s.alias, s.employer].compactMap { $0 }.joined(separator: " · "))
                            .tag(Int?.some(s.id))
                    }
                }
                .labelsHidden().frame(maxWidth: 320)
                Button(creating ? "Cancel" : "New source") { creating.toggle() }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
                Spacer()
            }
            if let e = loadError {
                Text(e).font(Term.mono(9)).foregroundStyle(Term.negative)
            }
            if creating {
                FormRow("ALIAS") { TermTextField(text: $alias, placeholder: "How we refer to them") }
                FormRow("EMPLOYER") { TermTextField(text: $employer, placeholder: "Where they work") }
                FormRow("ROLE") { TermTextField(text: $role, placeholder: "What they do there") }
                FormRow("RELATION") {
                    Picker("", selection: $relationship) {
                        ForEach(Self.relationships, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().frame(width: 200)
                }
                HStack {
                    Button("Save source") {
                        let a = alias, e = employer, r = role, rel = relationship
                        Task { await run {
                            let data = try await API.shared.post("/research/sources",
                                json: ["alias": a, "fullName": a, "employer": e,
                                       "role": r, "relationship": rel])
                            let made = try await API.shared.decode(Row.self, from: data)
                            sourceId = made.id
                            creating = false
                            await load()
                        } }
                    }
                    .buttonStyle(TermButtonStyle()).disabled(busy || alias.isEmpty)
                    Spacer()
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let data = try await API.shared.get("/research/sources")
            sources = try await API.shared.decode([Row].self, from: data)
            loadError = nil
        } catch {
            // An empty picker and a failed fetch look identical, so say
            // which one this is.
            loadError = "Could not load sources: \(error.localizedDescription)"
        }
    }
}

/// The create-an-interview form.
struct NewInterviewForm: View {
    let projectId: Int
    let ticker: String?
    @Binding var busy: Bool
    let run: RunAction
    let onDone: () -> Void

    @State private var sourceId: Int?
    @State private var title = ""
    @State private var whenText = ""
    @State private var consent = false
    @State private var consentNote = ""
    @State private var attested = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SourcePicker(sourceId: $sourceId, busy: $busy, run: run)
            FormRow("TITLE") { TermTextField(text: $title, placeholder: "Who, and what it was about") }
            FormRow("WHEN") { TermTextField(text: $whenText, placeholder: "YYYY-MM-DD HH:MM") }

            Toggle(isOn: $consent) {
                Text("They agreed to be recorded")
                    .font(Term.mono(10)).foregroundStyle(Term.white)
            }
            .toggleStyle(.checkbox)
            // Said at the point of decision, because it cannot be undone
            // from here and the audio path depends on it.
            Text(consent
                 ? "Audio can be stored and transcribed. This cannot be changed later."
                 : "Without consent the recording is refused by the server. The interview can still hold typed notes.")
                .font(Term.mono(9)).foregroundStyle(consent ? Term.fgMuted : Term.amber)
            if consent {
                FormRow("HOW") { TermTextField(text: $consentNote, placeholder: "Where the agreement is recorded") }
            }

            Toggle(isOn: $attested) {
                Text("I gave the pre-call attestation")
                    .font(Term.mono(10)).foregroundStyle(Term.white)
            }
            .toggleStyle(.checkbox)

            if let e = error {
                Text(e).font(Term.mono(9)).foregroundStyle(Term.negative)
            }
            HStack(spacing: 6) {
                Button("Open interview") { submit() }
                    .buttonStyle(TermButtonStyle())
                    .disabled(busy || sourceId == nil || title.isEmpty)
                Button("Cancel", action: onDone).buttonStyle(TermButtonStyle())
                Spacer()
            }
        }
        .onAppear { if whenText.isEmpty { whenText = Fmt.localStamp() } }
    }

    private func submit() {
        guard let sid = sourceId else { return }
        guard let iso = Fmt.isoFromLocal(whenText) else {
            error = "When did it happen? Use YYYY-MM-DD HH:MM."
            return
        }
        // Built inside the task rather than captured: [String: Any] is
        // not Sendable and strict concurrency is right to refuse it.
        let t = title, note = consentNote, gave = consent, att = attested
        let pid = projectId, tk = ticker ?? ""
        Task { await run {
            _ = try await API.shared.post("/research/interviews",
                json: ["sourceId": sid, "projectId": pid, "ticker": tk, "title": t,
                       "conductedAt": iso, "consentObtained": gave,
                       "consentNote": note, "attested": att])
            onDone()
        } }
    }
}

/// Paste a transcript that already exists. Kept beside the recording
/// upload because a call somebody typed up by hand is as real as one the
/// model heard.
struct TranscriptImportForm: View {
    let interviewId: Int
    @Binding var busy: Bool
    let run: RunAction
    let onDone: () -> Void

    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Paste the transcript. [MM:SS] speaker: text is understood and keeps its timings; anything else is stored as written.")
                .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            TextEditor(text: $text)
                .font(Term.mono(10)).foregroundStyle(Term.white)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 160)
                .padding(4).background(Term.bg).termBorder()
            HStack(spacing: 6) {
                Button("Import") {
                    let t = text
                    Task { await run {
                        _ = try await API.shared.post("/research/interviews/\(interviewId)/transcript",
                                                      json: ["text": t])
                        onDone()
                    } }
                }
                .buttonStyle(TermButtonStyle()).disabled(busy || text.count < 20)
                Button("Cancel", action: onDone).buttonStyle(TermButtonStyle())
                Spacer()
            }
        }
    }
}

// MARK: - Small shared pieces

struct FormRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content
    init(_ label: String, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.content = content
    }
    var body: some View {
        HStack(spacing: 6) {
            Text(label).font(Term.mono(9, weight: .bold)).tracking(0.5)
                .foregroundStyle(Term.fgMuted).frame(width: 74, alignment: .leading)
            content()
            Spacer(minLength: 0)
        }
    }
}

struct TermTextField: View {
    @Binding var text: String
    var placeholder: String = ""
    var body: some View {
        TextField("", text: $text,
                  prompt: Text(placeholder).foregroundStyle(Term.fgMuted))
            .textFieldStyle(.plain)
            .font(Term.mono(11)).foregroundStyle(Term.white)
            .padding(5).background(Term.bg).termBorder()
            .frame(maxWidth: 380)
    }
}
