import SwiftUI

// BI — free-form research chat with workspace context.
//
// Ported from BloombergIntelligence.jsx. The server (POST
// /terminal/chat) awaits one llmChat call and returns { reply } as a
// single JSON object — no stream — so the panel does not pretend
// otherwise: one thinking row while the request is out, then the reply
// appended whole.
//
// The transcript lives in the pane, matching the web's v0 — DB
// persistence lands later alongside saved layouts. A failed request is
// appended to the transcript as a row rather than replacing the panel:
// the conversation is the only state BI has, and killing it over one
// dropped request throws away exactly the thing worth keeping.
struct IntelligencePanel: View {
    let ticker: String?

    struct Entry: Identifiable {
        enum Kind { case user, assistant, error }
        let id = UUID()
        let kind: Kind
        // Grows a token at a time while the answer is being written, so
        // both of these are var rather than let.
        var content: String
        /// True while tokens are still arriving. An empty bubble and a
        /// finished one look identical without it, and the first token
        /// can be several seconds away.
        var streaming: Bool = false
    }

    struct Reply: Decodable {
        let reply: String?
    }

    @State private var messages: [Entry] = []
    @State private var input = ""
    @State private var sending = false
    @FocusState private var inputFocused: Bool

    private static let bottomID = "bi-bottom"

    // The same workspace summary the web hands its chat: what is open,
    // for which tickers, and which pane has focus — so "what am I
    // looking at" is a question the model can actually answer. Built
    // from the shared Workspace object every pane already lives under.
    @EnvironmentObject private var ws: Workspace

    private var workspaceContext: String {
        var lines = ["Griffin Fund Terminal workspace (native macOS app):"]
        if ws.panes.isEmpty {
            lines.append("- (no panes open)")
        }
        for p in ws.panes {
            let focused = p.id == ws.focusedID ? " [focused]" : ""
            let t = p.ticker.map { " for \($0)" } ?? ""
            lines.append("- \(p.function.id) (\(p.function.label))\(t)\(focused)")
        }
        if let t = ws.focusTicker { lines.append("Focused ticker: \(t)") }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Divider().overlay(Term.border)
            inputRow
        }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if messages.isEmpty && !sending {
                        intro
                    } else {
                        ForEach(messages) { row($0) }
                    }
                    if sending { thinkingRow }
                    Color.clear.frame(height: 1).id(Self.bottomID)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
            .onChange(of: messages.count) {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
            // A streaming answer grows without the count changing, so
            // following only the count leaves the reader staring at the
            // top of a note that is being written below the fold.
            .onChange(of: messages.last?.content.count ?? 0) {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
            .onChange(of: sending) {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
        }
    }

    // The web's empty state, sentences intact: what this is, what to
    // ask, with the focused ticker substituted into the examples.
    private var intro: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("◢ BLOOMBERG INTELLIGENCE")
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.fgDim)
            Text("Ask anything about the focused ticker or the broader market."
                 + (ticker.map { " Currently watching \($0)." } ?? ""))
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
            Text("Examples: \"Why is \(ticker ?? "NVDA") up today?\" · \"Compare \(ticker ?? "AAPL") margins to peers\" · \"What's the bear case?\"")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
        }
    }

    private func row(_ m: Entry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(m.kind == .user ? "> YOU" : "◢ AI")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.6)
                .foregroundStyle(m.kind == .user ? Term.amber
                                 : m.kind == .error ? Term.negative
                                 : Term.fgMuted)
            // A block caret while the answer is still arriving, in the
            // same amber the command line uses. Without it an empty
            // bubble and a finished one are the same picture, and the
            // first token can be several seconds away.
            Text(m.content + (m.streaming ? "\u{2588}" : ""))
                .font(Term.mono(11))
                .foregroundStyle(m.kind == .user ? Term.amber
                                 : m.kind == .error ? Term.negative
                                 : Term.fgDim)
                .lineSpacing(2)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var thinkingRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("◢ AI")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.6)
                .foregroundStyle(Term.fgMuted)
            Text("Thinking…")
                .font(Term.mono(11).italic())
                .foregroundStyle(Term.fgDim)
        }
    }

    // MARK: Input

    private var inputRow: some View {
        HStack(spacing: 8) {
            // Return sends, Option-Return breaks a line — the native
            // reading of the web textarea's Enter / Shift-Enter split.
            TextField("", text: $input, prompt:
                        Text("Ask the terminal…").foregroundStyle(Term.fgMuted),
                      axis: .vertical)
                .textFieldStyle(.plain)
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .lineLimit(1...4)
                .focused($inputFocused)
                .disabled(sending)
                .onSubmit { Task { await send() } }
            Button("SEND") { Task { await send() } }
                .buttonStyle(TermButtonStyle())
                .disabled(sending || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(8)
    }

    // MARK: Send

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        messages.append(Entry(kind: .user, content: text))
        input = ""
        sending = true
        defer {
            sending = false
            // Disabling the field drops focus; hand it back so a
            // follow-up question does not start with a mouse trip.
            inputFocused = true
        }

        // Error rows stay out of the outbound transcript. The server
        // replays assistant turns to the model verbatim, and a transport
        // error is not something the model once said.
        let outbound = messages.compactMap { m -> [String: String]? in
            switch m.kind {
            case .user:      return ["role": "user", "content": m.content]
            case .assistant: return ["role": "assistant", "content": m.content]
            case .error:     return nil
            }
        }

        do {
            // Stream first, so the note appears as it is written rather
            // than a minute later all at once. A server that cannot
            // stream answers with ordinary JSON and we fall back — the
            // reader gets the same answer either way, just later.
            let index = messages.count
            messages.append(Entry(kind: .assistant, content: "", streaming: true))
            do {
                let tokens = try await API.shared.stream("/terminal/chat", json: [
                    "messages": outbound,
                    "context": workspaceContext,
                    "stream": true,
                ])
                for try await piece in tokens {
                    guard index < messages.count else { break }
                    messages[index].content += piece
                }
                messages[index].streaming = false
                if messages[index].content.isEmpty {
                    messages[index].content = "(no reply)"
                }
            } catch {
                // Drop the half-written bubble before retrying: a
                // fragment left on screen reads as a short answer.
                if index < messages.count { messages.remove(at: index) }
                let data = try await API.shared.post("/terminal/chat", json: [
                    "messages": outbound,
                    "context": workspaceContext,
                ])
                let r = try await API.shared.decode(Reply.self, from: data)
                let reply = (r.reply?.isEmpty == false) ? r.reply! : "(no reply)"
                messages.append(Entry(kind: .assistant, content: reply))
            }
        } catch {
            // The API layer already surfaces the server's own { error }
            // sentence; this row carries it into the conversation.
            messages.append(Entry(kind: .error,
                                  content: "Error: \(error.localizedDescription)"))
        }
    }
}
