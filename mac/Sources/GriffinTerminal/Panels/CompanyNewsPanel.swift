import SwiftUI

// CN — company news for the focused ticker.
//
// Same endpoint as the web panel: /holdings/news/:ticker, which is the
// Finnhub company-news feed normalized in services/news.js. The server
// wraps articles in { ticker, fetchedAt, ranked, narrative, articles },
// but the web reads only `articles` (with a bare-array fallback from an
// older shape), so that is the contract ported here. The AI brief is a
// separate POST /terminal/annotate — the payload's `narrative` field is
// for the holdings page and CN has never rendered it.
//
// The panel polls every 60s like the web does, and a poll that fails
// must never tear down headlines already on screen: the web only sets
// its error state on the initial fetch, and silently keeping yesterday's
// list beats replacing it with a red box because one refresh timed out.
struct CompanyNewsPanel: View {
    let ticker: String

    struct Article: Decodable, Identifiable {
        let title: String?
        let description: String?
        let url: String?
        let source: String?
        let publishedAt: String?
        // The server always sends both title and url (it filters on
        // them), so this id is stable in practice; the fallback only
        // guards a malformed row.
        var id: String { url ?? title ?? "" }
    }

    struct Payload: Decodable {
        let articles: [Article]?
    }

    private struct Brief: Decodable {
        let brief: String?
    }

    @State private var state: Loadable<[Article]> = .loading
    @State private var brief = ""
    @State private var briefLoading = false
    @State private var lastRefresh: Date?
    /// URLs seen on the previous fetch, so a poll can tell a genuinely
    /// new headline from a re-delivered one.
    @State private var knownIDs: Set<String> = []
    /// Headlines that arrived on the last poll, flashed amber briefly —
    /// the web's term-news-flash.
    @State private var freshIDs: Set<String> = []
    @State private var pulse = false

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.isEmpty },
                   emptyText: "No recent stories.",
                   retry: { Task { await load(initial: true); await generateBrief() } }) { articles in
            VStack(alignment: .leading, spacing: 0) {
                header
                briefBlock
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(articles) { a in row(a) }
                    }
                }
            }
        }
        .task(id: ticker) {
            guard !ticker.isEmpty else {
                state = .failed("CN needs a ticker.")
                return
            }
            await load(initial: true)
            await generateBrief()
            // 60s cadence, matching the web; the server caches the feed
            // for 15 minutes so most polls are free.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled { break }
                let fresh = await load(initial: false)
                if !fresh.isEmpty {
                    // Let the flash read before the brief regenerates —
                    // the annotate call can take many seconds and the
                    // highlight should not outlive its news-ness.
                    try? await Task.sleep(for: .seconds(4))
                    freshIDs = []
                    await generateBrief()
                }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Text(ticker.uppercased())
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.amber)
            Text("Company News")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
            Spacer()
            Text("● LIVE")
                .font(Term.mono(9, weight: .bold))
                .tracking(1.0)
                .foregroundStyle(Term.positive)
                .opacity(pulse ? 0.4 : 1)
                .onAppear {
                    withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) {
                        pulse = true
                    }
                }
            // A live clock, not the fetch time. The web ticks this every
            // second so the panel reads as running rather than frozen at
            // the last 60s poll.
            if lastRefresh != nil {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    Text(Self.clockTime(ctx.date))
                        .font(Term.mono(9))
                        .foregroundStyle(Term.fgMuted)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: AI brief

    private var briefBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("◢ AI BRIEF")
                .font(Term.mono(9, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(Term.amber)
            if briefLoading {
                Text("Generating…")
                    .font(Term.mono(11))
                    .italic()
                    .foregroundStyle(Term.fgDim)
            } else {
                // "No brief available." is the web's degraded line when
                // the annotate call fails or comes back empty — stated,
                // not blanked, so a dead LLM is visible.
                Text(brief.isEmpty ? "No brief available." : brief)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Term.amber.opacity(0.06))
        .overlay(Rectangle().strokeBorder(Term.fgMuted, lineWidth: 1))
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    // MARK: Rows

    private func row(_ a: Article) -> some View {
        Button {
            if let s = a.url, let u = URL(string: s) {
                NSWorkspace.shared.open(u)
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Self.rowTime(a.publishedAt))
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                    .frame(width: 52, alignment: .leading)
                if let s = a.source, !s.isEmpty {
                    Text(s.uppercased())
                        .font(Term.mono(9, weight: .bold))
                        .foregroundStyle(Term.orange)
                }
                Text(a.title ?? "")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .lineLimit(1)
                if a.url != nil {
                    // The web's faint trailing arrow: reads as "leaves
                    // for the outlet" without underlining every title.
                    Text("↗").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Term.amber.opacity(freshIDs.contains(a.id) ? 0.18 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(a.url == nil)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
        .animation(.easeOut(duration: 1.2), value: freshIDs)
    }

    // MARK: Loading

    /// Returns the ids of headlines not seen on the previous fetch, so
    /// the caller can flash them and refresh the brief. Empty on the
    /// initial load and on any failure.
    @discardableResult
    private func load(initial: Bool) async -> Set<String> {
        if initial {
            state = .loading
            brief = ""
            knownIDs = []
            freshIDs = []
        }
        do {
            let data = try await API.shared.get("/holdings/news/\(ticker)")
            // { articles: [...] } today; the web still accepts a bare
            // array from an older server, so this does too.
            let list: [Article]
            if let p = try? await API.shared.decode(Payload.self, from: data), let a = p.articles {
                list = a
            } else {
                list = try await API.shared.decode([Article].self, from: data)
            }

            // The feed is not reliably time-ordered; sort newest-first
            // so the list is a single timeline. Undated stories sink.
            let ordered = list
                .map { (art: $0, ts: Self.parse($0.publishedAt)) }
                .sorted { l, r in
                    switch (l.ts, r.ts) {
                    case let (a?, b?): return a > b
                    case (.some, .none): return true
                    default: return false
                    }
                }
                .prefix(20)
                .map(\.art)

            let ids = Set(ordered.map(\.id))
            var fresh: Set<String> = []
            if !initial, !knownIDs.isEmpty {
                fresh = ids.subtracting(knownIDs)
            }
            knownIDs = ids
            state = .loaded(ordered)
            lastRefresh = Date()
            if !fresh.isEmpty { freshIDs = fresh }
            return fresh
        } catch {
            // Only the initial fetch may surface as a failure; a broken
            // poll keeps the last good list on screen, as on the web.
            if initial { state = .failed(error.localizedDescription) }
            return []
        }
    }

    /// Same call the web makes: the eight newest headlines, timestamped,
    /// through POST /terminal/annotate. A failure is swallowed into the
    /// "No brief available." line rather than the panel's error state —
    /// the headlines are the product, the brief is garnish.
    private func generateBrief() async {
        guard case .loaded(let articles) = state, !articles.isEmpty else { return }
        briefLoading = true
        defer { briefLoading = false }
        let context = articles.prefix(8).enumerated()
            .map { "\($0.offset + 1). \(Self.rowTime($0.element.publishedAt)) — \($0.element.title ?? "")" }
            .joined(separator: "\n")
        do {
            let data = try await API.shared.post("/terminal/annotate",
                                                 json: ["ticker": ticker,
                                                        "function": "CN",
                                                        "context": context])
            let p = try await API.shared.decode(Brief.self, from: data)
            brief = p.brief ?? ""
        } catch {
            brief = ""
        }
    }

    // MARK: Time

    private static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// The web's formatTime: a clock time for today's stories, MM/dd for
    /// older ones — recency is the signal on a news wire, the year never
    /// is. Em dash when the feed sent no date.
    private static func rowTime(_ iso: String?) -> String {
        guard let d = parse(iso) else { return "—" }
        let f = DateFormatter()
        f.dateFormat = Calendar.current.isDateInToday(d) ? "h:mm a" : "MM/dd"
        return f.string(from: d)
    }

    private static func clockTime(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "h:mm:ss a"
        return f.string(from: d)
    }
}
