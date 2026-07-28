import SwiftUI

// ARCH — the club's own research archive, read inside the terminal.
//
// The web calls this RSCH; natively that code went to the field-research
// workspace, so the finished write-ups answer to ARCH. Same endpoints,
// same shape: Report and Pitch rows flattened into one chronology, with
// ids namespaced ("report:12", "pitch:12") because the two tables share
// row numbers. The whole string goes back to the server untouched —
// never parse a bare integer out of it.
//
// The panel reads the document itself, not a link to it: the server
// extracts text from the stored bytes and hands it over with whatever
// AI summary is already cached, so our own research stays legible even
// when nothing can render the file. The original is one click away.
//
// Two views in one pane rather than side-by-side, exactly like the web:
// a floating pane is often ~700px wide and a reading column beside a
// table would be too narrow for prose. A row click swaps to the reader;
// Back returns with the list — and the filter text — intact.
struct ArchivePanel: View {
    let ticker: String?

    struct Item: Decodable, Identifiable {
        let id: String
        let kind: String?
        let title: String?
        let author: String?
        let ticker: String?
        let date: String?
        let description: String?
        let fileRef: String?
        let outcome: String?
        let industry: String?
        let hasSummary: Bool?
        let managed: Bool?
    }

    struct Counts: Decodable {
        let reports: Int?
        let pitches: Int?
    }

    struct Payload: Decodable {
        let items: [Item]
        let counts: Counts?
    }

    @State private var state: Loadable<Payload> = .loading
    // Applied client-side against the already-loaded list, same call
    // the web made: the archive is hundreds of rows, not millions, and
    // a request per keystroke buys nothing. The server's `q` parameter
    // exists for callers that can't hold the list.
    @State private var query = ""
    @State private var openRef: String?

    var body: some View {
        Group {
            if let ref = openRef {
                ArchiveReader(refID: ref, onBack: { openRef = nil })
            } else {
                list
            }
        }
        // A ticker change is a different archive slice — drop whatever
        // reader was open rather than leaving an unrelated document up.
        .task(id: ticker) {
            openRef = nil
            await load()
        }
    }

    private var list: some View {
        PanelState(state: state,
                   retry: { Task { await load() } }) { p in
            let shown = filtered(p.items)
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().overlay(Term.border)
                filterField
                if shown.isEmpty {
                    // Two different sentences for two different facts:
                    // the archive (or its slice) has nothing, versus
                    // the filter ate everything that was there.
                    PanelMessage(text: p.items.isEmpty
                        ? (ticker.map { "No internal research on \($0.uppercased()) yet." }
                            ?? "The research archive is empty.")
                        : "Nothing matches \"\(query)\".")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(shown) { it in row(it) }
                        }
                    }
                }
                Divider().overlay(Term.border)
                footer(p)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            if let t = ticker {
                Text(t.uppercased())
                    .font(Term.mono(12, weight: .bold))
                    .foregroundStyle(Term.amber)
            }
            SectionLabel(text: "Archive")
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var filterField: some View {
        TextField("Filter by title, author, ticker, industry…", text: $query)
            .textFieldStyle(.plain)
            .font(Term.mono(11))
            .foregroundStyle(Term.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Term.bg)
            .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
            .padding(10)
    }

    private func row(_ it: Item) -> some View {
        Button { openRef = it.id } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Self.mdyy(it.date))
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgDim)
                    .frame(width: 58, alignment: .leading)
                Text(it.ticker ?? "—")
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(Term.amber)
                    .frame(width: 56, alignment: .leading)
                Text(it.title ?? "—")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .lineLimit(1)
                if let o = it.outcome {
                    // The web's chip verbatim: PASSED only for NoBuy,
                    // everything else reads BOUGHT and the color does
                    // the judging (unknown outcomes stay neutral).
                    Text(o == "NoBuy" ? "PASSED" : "BOUGHT")
                        .font(Term.mono(9))
                        .foregroundStyle(Self.outcomeTone(o))
                }
                Spacer(minLength: 6)
                Text(it.author ?? "—")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
                    .lineLimit(1)
                    .frame(width: 120, alignment: .trailing)
                // Tell the reader what they're walking into: an AI
                // read already exists, or there's no file at all.
                Group {
                    if it.fileRef == nil {
                        Text("NO FILE").foregroundStyle(Term.fgMuted)
                    } else if it.hasSummary == true {
                        Text("AI").foregroundStyle(Term.fgDim)
                    } else {
                        Text(" ")
                    }
                }
                .font(Term.mono(9))
                .frame(width: 44, alignment: .trailing)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private func footer(_ p: Payload) -> some View {
        var parts: [String] = []
        if let c = p.counts, let r = c.reports, let d = c.pitches {
            parts.append("\(r) report\(r == 1 ? "" : "s") · \(d) pitch deck\(d == 1 ? "" : "s")")
        }
        parts.append(ticker != nil ? "scoped to this ticker" : "whole archive")
        parts.append("click a row to read it here. AI marks a cached summary.")
        return Text(parts.joined(separator: " · "))
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
    }

    private func filtered(_ items: [Item]) -> [Item] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return items }
        return items.filter { it in
            [it.title, it.author, it.ticker, it.description, it.industry]
                .compactMap { $0 }
                .contains { $0.lowercased().contains(needle) }
        }
    }

    // Prisma emits "2026-05-12T00:00:00.000Z". Parsing that lands on
    // UTC midnight and renders a day early anywhere west of Greenwich,
    // so this slices the date out as a string — same MM/DD/YY the web
    // shows, same precedent FilingsPanel set.
    static func mdyy(_ s: String?) -> String {
        guard let s else { return "—" }
        let parts = s.prefix(10).split(separator: "-")
        guard parts.count == 3, parts[0].count == 4 else { return "—" }
        return "\(parts[1])/\(parts[2])/\(parts[0].suffix(2))"
    }

    // A name we bought reads positive, one we passed on reads negative.
    // Anything else is left neutral rather than guessed at.
    static func outcomeTone(_ o: String?) -> Color {
        switch o {
        case "Buy":   return Term.positive
        case "NoBuy": return Term.negative
        default:      return Term.fgMuted
        }
    }

    private func load() async {
        state = .loading
        do {
            let q = ticker.map { ["ticker": $0.uppercased()] } ?? [:]
            let data = try await API.shared.get("/terminal/research", query: q)
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

// MARK: Reader

private struct ArchiveReader: View {
    let refID: String
    let onBack: () -> Void

    struct Doc: Decodable {
        let id: String
        let kind: String?
        let title: String?
        let author: String?
        let ticker: String?
        let date: String?
        let description: String?
        let fileRef: String?
        let outcome: String?
        let industry: String?
        let summary: String?
        let summaryModel: String?
        let text: String?
        let chars: Int?
        let truncated: Bool?
        let unavailable: String?
    }

    private enum Tab { case summary, text }

    @State private var state: Loadable<Doc> = .loading
    @State private var tab: Tab = .summary
    @State private var fileBusy = false
    @State private var fileErr: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The back button lives outside PanelState so it stays
            // reachable while the document loads or after it fails —
            // a dead end behind a spinner is the web bug this mirrors
            // not having.
            HStack(spacing: 8) {
                Button("← Archive", action: onBack).buttonStyle(TermButtonStyle())
                if case .loaded(let d) = state, d.fileRef != nil {
                    Button("Open document") {
                        Task { await openOriginal(d) }
                    }
                    .buttonStyle(TermButtonStyle())
                    .disabled(fileBusy)
                }
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            Divider().overlay(Term.border)

            if let fileErr {
                Text(fileErr)
                    .font(Term.mono(10))
                    .foregroundStyle(Term.negative)
                    .padding(.horizontal, 10)
                    .padding(.top, 4)
            }

            PanelState(state: state, retry: { Task { await load() } }) { d in
                content(d)
            }
        }
        .task(id: refID) { await load() }
    }

    private func content(_ d: Doc) -> some View {
        let summary = d.summary?.isEmpty == false ? d.summary : nil
        let text = d.text?.isEmpty == false ? d.text : nil
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let t = d.ticker {
                    Text(t).font(Term.mono(12, weight: .bold)).foregroundStyle(Term.amber)
                }
                Text(d.title ?? "—")
                    .font(Term.mono(12, weight: .medium))
                    .foregroundStyle(Term.white)
                    .lineLimit(2)
            }

            metaLine(d)

            if let desc = d.description {
                Text(desc).font(Term.mono(11)).foregroundStyle(Term.fgDim)
            }

            // Whatever kept us from reading the bytes — an external
            // link, a missing upload, an image-only PDF. Said plainly,
            // because a silent empty pane reads as "no research
            // exists".
            if let u = d.unavailable {
                Text(u).font(Term.mono(11)).foregroundStyle(Term.negative)
            }

            if summary != nil || text != nil {
                tabBar(hasSummary: summary != nil, hasText: text != nil)
                if tab == .summary, let s = summary {
                    summaryView(s, model: d.summaryModel)
                } else if let t = text {
                    textView(t, chars: d.chars, truncated: d.truncated == true)
                }
            } else if d.unavailable == nil {
                Text("Nothing readable in this document yet.")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgMuted)
                    .padding(.top, 8)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
    }

    private func metaLine(_ d: Doc) -> some View {
        let bits = [
            d.author,
            ArchivePanel.mdyy(d.date),
            d.kind == "pitch" ? "Pitch deck" : "Research report",
            d.industry,
        ].compactMap { $0 }
        return HStack(spacing: 6) {
            Text(bits.joined(separator: " · "))
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            if let o = d.outcome {
                Text("· \(o == "NoBuy" ? "Club passed" : "Club bought")")
                    .font(Term.mono(10))
                    .foregroundStyle(ArchivePanel.outcomeTone(o))
            }
        }
    }

    private func tabBar(hasSummary: Bool, hasText: Bool) -> some View {
        HStack(spacing: 0) {
            if hasSummary { tabButton("AI SUMMARY", .summary) }
            if hasText { tabButton("FULL TEXT", .text) }
            Spacer()
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private func tabButton(_ label: String, _ value: Tab) -> some View {
        Button { tab = value } label: {
            Text(label)
                .font(Term.mono(10, weight: tab == value ? .bold : .regular))
                .foregroundStyle(tab == value ? Term.amber : Term.fgMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(tab == value ? Term.amber : .clear)
                        .frame(height: 1)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
    }

    private func summaryView(_ s: String, model: String?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                SummaryMarkdown(source: s)
                Text("AI summary of the document\(model.map { " · \($0)" } ?? "") — read the full text for anything you intend to cite.")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                    .padding(.top, 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func textView(_ t: String, chars: Int?, truncated: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView {
                Text(t)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .background(Term.bg)
            .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
            Text(extractionCaption(chars: chars, truncated: truncated))
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
        }
    }

    private func extractionCaption(chars: Int?, truncated: Bool) -> String {
        var s = chars.map { "\(Fmt.money(Double($0), decimals: 0)) characters extracted" }
            ?? "Extracted text"
        if truncated {
            s += " · truncated for display — open the document for the rest"
        }
        return s
    }

    // The original file, one click away. External URLs go straight to
    // the browser. Managed "onedrive:" refs are not URLs — the server
    // mints a short-lived signed one (the same grant the web feeds its
    // iframe, because a top-level GET can't carry our Bearer header)
    // and the browser opens that. A 415 here is the server saying the
    // type can't render inline; its sentence says download instead, so
    // it is shown rather than translated.
    private func openOriginal(_ d: Doc) async {
        guard let ref = d.fileRef else { return }
        fileErr = nil
        if ref.hasPrefix("onedrive:") {
            fileBusy = true
            defer { fileBusy = false }
            do {
                let itemID = String(ref.dropFirst("onedrive:".count))
                let data = try await API.shared.get("/files/\(itemID)/preview")
                struct Grant: Decodable { let url: String? }
                let g = try await API.shared.decode(Grant.self, from: data)
                if let s = g.url, let u = URL(string: s) {
                    NSWorkspace.shared.open(u)
                } else {
                    fileErr = "The server sent no preview URL for this file."
                }
            } catch {
                fileErr = error.localizedDescription
            }
        } else if let u = URL(string: ref) {
            NSWorkspace.shared.open(u)
        } else {
            fileErr = "This entry's file reference is not an openable link."
        }
    }

    private func load() async {
        state = .loading
        fileErr = nil
        do {
            let path = "/terminal/research/" +
                (refID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? refID)
            let data = try await API.shared.get(path)
            let d = try await API.shared.decode(Doc.self, from: data)
            state = .loaded(d)
            // Land on whichever view actually has something in it. A
            // document with no cached summary should open on its text
            // rather than an empty pane.
            tab = d.summary?.isEmpty == false ? .summary : .text
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

// MARK: Summary markdown

// The cached summaries come back as markdown with `## Thesis` /
// `## Key Points` headers, so headings and bullets are what matter and
// a full renderer is not worth its dependencies. Headings become the
// web's uppercase amber labels, bullets keep their indent, and inline
// bold flows through AttributedString. Anything the inline parser
// chokes on falls back to the raw line — degraded text beats a blank.
private struct SummaryMarkdown: View {
    let source: String

    private enum Block {
        case heading(String)
        case bullet(String)
        case paragraph(String)
    }

    var body: some View {
        let blocks = Self.parse(source)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .heading(let s):
                    Text(s.uppercased())
                        .font(Term.mono(10, weight: .bold))
                        .tracking(0.6)
                        .foregroundStyle(Term.amber)
                        .padding(.top, 8)
                case .bullet(let s):
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").font(Term.mono(11)).foregroundStyle(Term.fgMuted)
                        Text(Self.inline(s))
                            .font(Term.mono(11))
                            .foregroundStyle(Term.fgDim)
                            .lineSpacing(2)
                    }
                    .padding(.leading, 8)
                case .paragraph(let s):
                    Text(Self.inline(s))
                        .font(Term.mono(11))
                        .foregroundStyle(Term.fgDim)
                        .lineSpacing(2)
                        .padding(.bottom, 2)
                }
            }
        }
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }

    private static func parse(_ md: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        func flush() {
            guard !para.isEmpty else { return }
            out.append(.paragraph(para.joined(separator: " ")))
            para.removeAll()
        }
        for raw in md.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("#") {
                flush()
                out.append(.heading(
                    line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flush()
                out.append(.bullet(String(line.dropFirst(2))))
            } else {
                para.append(line)
            }
        }
        flush()
        return out
    }

    private static func inline(_ s: String) -> AttributedString {
        (try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}
