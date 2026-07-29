import SwiftUI
import PDFKit
import AppKit

// Reading a stored file without leaving the terminal.
//
// Until now a OneDrive artifact in RSCH said "open on the web terminal",
// which is a fair description of a dead end: the whole point of the
// native app is that the work happens here. The server already had the
// pieces — a signed, short-lived, same-origin stream that converts
// Office documents to PDF on the way through — and nothing was reading
// them.
//
// Two different jobs, deliberately kept apart:
//
//   PREVIEW is for reading. PDFs and images stream as themselves; Word,
//   PowerPoint and Excel arrive as a PDF rendering. Fast, and enough to
//   answer "what is in this file".
//
//   OPEN ORIGINAL is for working. A merger model rendered to PDF is a
//   picture of a spreadsheet — you cannot trace a formula through it or
//   change an assumption. So the real bytes download and hand off to
//   whatever owns the file type, and that button is offered for every
//   file rather than only the ones we cannot preview.
//
// The distinction matters most for exactly the documents this feature
// was asked for. The DCF and the merger model preview fine and are
// nearly useless as previews.
struct DocumentViewer: View {
    let itemId: String
    let title: String
    let onBack: () -> Void

    @State private var state: Loadable<Payload> = .loading
    @State private var opening = false
    @State private var openError: String?

    struct Payload {
        let data: Data
        let filename: String?
        /// True when the bytes are a PDF rendering of something else,
        /// which the reader is told rather than left to infer from a
        /// spreadsheet that has stopped behaving like one.
        let converted: Bool
        let kind: Kind
        enum Kind { case pdf, image, text }
    }

    /// What the preview endpoint hands back. A 415 here is not a
    /// failure: it means this type has no inline rendering, which is a
    /// different sentence from "something went wrong" and gets its own
    /// screen with the download on it.
    private struct PreviewRef: Decodable {
        let url: String
        let filename: String?
        let converted: Bool?
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Term.border)
            content
        }
        .task { await load() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button("← Files", action: onBack).buttonStyle(TermButtonStyle())
            Text(title)
                .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white)
                .lineLimit(1)
            if case .loaded(let p) = state, p.converted {
                // Said plainly, because a converted spreadsheet looks
                // exactly like a spreadsheet until you try to use it.
                Text("PDF RENDERING · NOT THE LIVE FILE")
                    .font(Term.mono(9, weight: .bold)).tracking(0.5)
                    .foregroundStyle(Term.amber)
            }
            Spacer()
            if let e = openError {
                Text(e).font(Term.mono(9)).foregroundStyle(Term.negative).lineLimit(1)
            }
            Button(opening ? "Opening…" : "Open original") { openOriginal() }
                .buttonStyle(TermButtonStyle())
                .disabled(opening)
                .help("Download the real file and open it in whatever owns that type")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            PanelMessage(text: "Fetching \(title)…")
        case .failed(let msg):
            VStack(alignment: .leading, spacing: 8) {
                Text(msg).font(Term.mono(11)).foregroundStyle(Term.fgDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // A file we cannot render inline is still a file we can
                // hand to the app that owns it, so this screen is never
                // a dead end.
                Button("Download and open it") { openOriginal() }
                    .buttonStyle(TermButtonStyle()).disabled(opening)
                Button("Try the preview again") { Task { await load() } }
                    .buttonStyle(TermButtonStyle())
            }
            .padding(14)
        case .loaded(let p):
            switch p.kind {
            case .pdf:
                if let doc = PDFDocument(data: p.data) {
                    PDFViewer(document: doc)
                } else {
                    PanelMessage(text: "Those bytes did not parse as a PDF.")
                }
            case .image:
                if let img = NSImage(data: p.data) {
                    ScrollView([.horizontal, .vertical]) {
                        Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                    }
                } else {
                    PanelMessage(text: "Those bytes did not parse as an image.")
                }
            case .text:
                ScrollView {
                    Text(String(data: p.data, encoding: .utf8) ?? "")
                        .font(Term.mono(11)).foregroundStyle(Term.fgDim)
                        .lineSpacing(3).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
            }
        }
    }

    private func load() async {
        state = .loading
        do {
            let meta = try await API.shared.get("/files/\(escaped(itemId))/preview")
            let ref = try await API.shared.decode(PreviewRef.self, from: meta)
            guard let url = URL(string: ref.url) else {
                state = .failed("The server sent a preview link that is not a URL.")
                return
            }
            // The signed link carries its own short-lived token in the
            // query, so this request deliberately does NOT send the
            // session bearer.
            let (data, resp) = try await URLSession.shared.data(from: url)
            if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                state = .failed(http.statusCode == 403
                    ? "That preview link expired. Open the file again."
                    : "The file stream returned \(http.statusCode).")
                return
            }
            let name = ref.filename ?? title
            state = .loaded(Payload(data: data,
                                    filename: ref.filename,
                                    converted: ref.converted ?? false,
                                    kind: kind(for: name, converted: ref.converted ?? false)))
        } catch let e as API.Failure {
            if case .http(415, let msg) = e {
                state = .failed(msg.isEmpty
                    ? "This type has no inline preview."
                    : msg)
            } else {
                state = .failed(e.localizedDescription)
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// A converted file is always a PDF whatever its name says, so the
    /// flag wins over the extension.
    private func kind(for name: String, converted: Bool) -> Payload.Kind {
        if converted { return .pdf }
        switch (name as NSString).pathExtension.lowercased() {
        case "pdf":                              return .pdf
        case "png", "jpg", "jpeg", "gif", "webp": return .image
        default:                                  return .text
        }
    }

    /// The real bytes, handed to the system. Written under the file's
    /// own name so the app it opens in shows something recognisable
    /// rather than a UUID.
    private func openOriginal() {
        opening = true
        openError = nil
        Task {
            do {
                let data = try await API.shared.get("/files/\(escaped(itemId))")
                var name = (try? await filename()) ?? title
                if name.isEmpty { name = "document" }
                let dir = FileManager.default.temporaryDirectory
                    .appendingPathComponent("griffin-files", isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let dest = dir.appendingPathComponent(name.replacingOccurrences(of: "/", with: "-"))
                try data.write(to: dest)
                NSWorkspace.shared.open(dest)
            } catch {
                openError = error.localizedDescription
            }
            opening = false
        }
    }

    private func filename() async throws -> String {
        if case .loaded(let p) = state, let f = p.filename, !f.isEmpty { return f }
        struct Info: Decodable { let name: String? }
        let data = try await API.shared.get("/files/\(escaped(itemId))/info")
        return (try? await API.shared.decode(Info.self, from: data))?.name ?? title
    }

    private func escaped(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}

// PDFKit is a system framework, so this stays inside the no-third-party
// rule. autoScales is what makes a page fit the pane instead of opening
// at 100% and needing a scroll to find the top-left corner.
private struct PDFViewer: NSViewRepresentable {
    let document: PDFDocument

    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.document = document
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        v.backgroundColor = .black
        return v
    }

    func updateNSView(_ v: PDFView, context: Context) {
        if v.document !== document { v.document = document }
    }
}

extension DocumentViewer {
    /// Artifacts store "onedrive:ITEM_ID". Anything else is not a stored
    /// file and must not be guessed at.
    static func itemId(from fileRef: String?) -> String? {
        guard let r = fileRef, r.hasPrefix("onedrive:") else { return nil }
        let id = String(r.dropFirst("onedrive:".count))
        return id.isEmpty ? nil : id
    }
}

