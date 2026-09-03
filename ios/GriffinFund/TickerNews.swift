import SwiftUI

// Per-name news: the section that answers "why did this move".
//
// The wire (NewsScreen) is the market talking. This is one company
// talking, and the two are deliberately the same object on screen —
// same headline treatment, same chips, same right-hand stamp — because
// two news lists that are laid out differently read as two apps.
//
// Everything hard here is a distinction the server already draws and
// that this file must not flatten:
//
//   - The score on these articles is MATERIALITY (articleRanker.js),
//     which is how much a story should move a thesis. It is NOT the
//     wire's `breaking` urgency score (breakingClassifier.js), which
//     asks the narrower question of whether something just happened.
//     A deeply material earnings preview is not breaking, and a
//     genuinely breaking headline can be noise. This route carries
//     only the first, so nothing in this section may say "breaking".
//   - `ranked:false` means nobody scored the batch. That changes what
//     the ORDER of the list means, so the order is labelled rather
//     than left for the reader to assume.
//   - `topic` non-nil means the server quietly served the general
//     market feed instead of company news, which for a fund we hold is
//     an answer to a different question and has to be said out loud.
//   - `stale:true` means Finnhub refused and the server served its
//     last good batch. Their staleness, not ours, and still staleness.
//
// An empty list is a quiet company, not a failure, and reads as one.

// MARK: The feed
//
// Written from server/src/routes/holdings.js:495 (GET
// /api/holdings/news/:ticker), which returns exactly what
// services/news.js getNewsForTicker() assembles — the healthy shape at
// news.js:168-176 and the degraded one at news.js:148-154. Every field
// optional, because a key we guessed wrong decodes to nil in silence
// and renders as fact.
struct TickerNewsFeed: Decodable {
    let ticker: String?
    /// Set ONLY for the broad-market tickers listed at news.js:46 —
    /// VOO, SPY, QQQ, VGT, XLK, XLV — where the service swaps company
    /// news for Finnhub's general category. Those headlines are about
    /// the market and not about the fund, and a section that prints
    /// them under the fund's ticker without saying so is putting words
    /// in the filer's mouth.
    let topic: String?
    let fetchedAt: String?
    /// True when at least one article came back with a materiality
    /// score (news.js:173). False is not "nothing is material" — it is
    /// "nobody scored this", which happens whenever the LLM is
    /// unreachable, and it means the list is in publication order.
    let ranked: Bool?
    /// Two or three sentences of machine-written synthesis across the
    /// batch (articleSummarizer.js:224). Null when the model judged the
    /// batch too thin to have a narrative, which is it declining rather
    /// than failing, so null draws nothing at all.
    let narrative: String?
    let articles: [TickerNewsItem]?
    /// Finnhub failed and the server served the previous batch anyway
    /// (news.js:148-154), because minutes-old headlines beat a red
    /// panel. True here is a fact about the vendor.
    let stale: Bool?
    /// "rate_limit" or "upstream_error" (news.js:152).
    let staleReason: String?
}

/// One headline. Shape from news.js:95-103, with `score` and `reason`
/// merged on by articleRanker.js:196 when the batch was ranked.
struct TickerNewsItem: Decodable, Identifiable {
    let title: String?
    let description: String?
    let url: String?
    let source: String?
    /// Finnhub sends no author on company news (news.js:100 hardcodes
    /// null); kept so the decodable matches the handler rather than
    /// matching what happens to be populated today.
    let author: String?
    let publishedAt: String?
    let imageUrl: String?
    /// 0.0-10.0 MATERIALITY, one decimal, calibrated by the prompt at
    /// articleRanker.js:18: 9+ is thesis-defining, 7-8.9 materially
    /// relevant, under 3 is a ticker collision or a puff piece. Absent
    /// when the batch was never ranked.
    let score: Double?
    /// The model's twelve-word justification for the score. Ours, not
    /// the publisher's — the section footer says so once rather than
    /// every row saying it.
    let reason: String?

    /// Stable, because it also drives sheet presentation. Article's own
    /// `id` in Models.swift falls back to a fresh UUID, which is fine
    /// for a ForEach and would make a sheet flicker itself closed.
    var id: String { url ?? title ?? "untitled" }

    /// The tiers are the ranking prompt's own calibration bands, not
    /// thresholds invented here. Below 7 nothing is marked: a chip on
    /// every row is a chip on none.
    var tier: String? {
        guard let score else { return nil }
        if score >= 9 { return "Thesis" }
        if score >= 7 { return "Material" }
        return nil
    }
}

// MARK: The reader
//
// From holdings.js:480 (GET /api/holdings/news/article?url=…), which
// returns services/news.js extractArticle() at news.js:420-431. The
// server runs Mozilla Readability and sanitizes the result, so what
// arrives is trusted HTML — but it is still HTML, and see
// TickerNewsHTML below for why we render it as plain paragraphs.
struct TickerNewsArticle: Decodable {
    let url: String?
    let title: String?
    let byline: String?
    let siteName: String?
    let excerpt: String?
    /// Readability's guess at the publication time, in whatever form
    /// the page's metadata used. Deliberately unused: the feed item
    /// already carries a real ISO stamp from Finnhub, and Fmt's date
    /// parsers would silently truncate an unrecognised string.
    let publishedTime: String?
    let contentHtml: String?
    /// The LLM's TL;DR of the body, cached per URL server-side
    /// (news.js:418). Null when no provider was reachable.
    let summary: String?
    let fetchedAt: String?
}

/// What the reader sheet actually has to draw. Extraction failing is an
/// ordinary outcome here — publishers block datacenter IPs, paywalls
/// return stubs — so it is a LOADED state carrying a sentence and a way
/// out, not a failure state under COULD NOT LOAD.
enum TickerNewsReading {
    case text(TickerNewsArticle, [String])
    case unavailable(String)
}

// MARK: HTML to paragraphs
//
// We chose the in-app reader over always opening Safari, because the
// point of opening a holding is to stay in the position. But the route
// returns sanitized HTML and iOS has no cheap way to render that: the
// NSAttributedString HTML importer spins up WebKit on the main thread
// (a documented hang, on a sheet that opens from a tap), and a
// WKWebView would be a second browser with its own typography sitting
// inside a terminal that spent a whole file getting typography right.
//
// So the body is reduced to paragraphs and set in the house prose face.
// Block-level tags become breaks BEFORE tags are stripped, or every
// article arrives as one unreadable wall; entities are decoded AFTER
// markup is gone, or an escaped &lt;p&gt; turns back into live markup
// that the stripper has already walked past. Both orderings are the
// same lesson newsFeeds.js learned on the server.
enum TickerNewsHTML {
    /// A body shorter than this is a cookie banner, a paywall stub or a
    /// navigation column that Readability mistook for prose. Showing it
    /// as the article would be the worst outcome available: it looks
    /// like we read the story and it says nothing.
    static let usableFloor = 400

    static func paragraphs(from html: String?) -> [String] {
        guard let html, !html.isEmpty else { return [] }
        var s = html

        // Script and style never survived the server's allowlist
        // (news.js:213), but this function is the only thing standing
        // between a publisher's markup and the screen, so it does not
        // rely on that.
        s = s.replacingOccurrences(of: "<script[^>]*>[\\s\\S]*?</script>",
                                   with: " ", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "<style[^>]*>[\\s\\S]*?</style>",
                                   with: " ", options: [.regularExpression, .caseInsensitive])

        // Everything that ends a block ends a paragraph.
        s = s.replacingOccurrences(of: "<br[^>]*>",
                                   with: "\n\n", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(
            of: "</(p|div|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|figure|figcaption|tr|section|article)>",
            with: "\n\n", options: [.regularExpression, .caseInsensitive])

        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        s = decodeEntities(s)

        return s
            .components(separatedBy: "\n")
            .map { $0.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
                     .trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static let named: [(String, String)] = [
        ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""),
        ("&apos;", "'"), ("&#39;", "'"), ("&rsquo;", "\u{2019}"),
        ("&lsquo;", "\u{2018}"), ("&ldquo;", "\u{201C}"), ("&rdquo;", "\u{201D}"),
        ("&mdash;", "\u{2014}"), ("&ndash;", "\u{2013}"), ("&hellip;", "\u{2026}"),
        // Ampersand LAST, so an escaped "&amp;lt;" stays the text it was
        // written as instead of becoming a tag we already stopped
        // looking for.
        ("&amp;", "&"),
    ]

    private static func decodeEntities(_ input: String) -> String {
        var s = input

        // Numeric entities first, and the cursor is the whole trick: it
        // resumes AFTER each replacement, so a decoded "&" can never
        // combine with the text behind it into a fresh entity — which
        // is both an escaping bypass and, since the search would keep
        // finding a match, a loop that never ends.
        var cursor = s.startIndex
        while cursor < s.endIndex,
              let r = s.range(of: "&#[xX]?[0-9A-Fa-f]{1,6};",
                              options: .regularExpression,
                              range: cursor..<s.endIndex) {
            let digits = s[r].dropFirst(2).dropLast()
            let value: UInt32? = (digits.first == "x" || digits.first == "X")
                ? UInt32(digits.dropFirst(), radix: 16)
                : UInt32(digits, radix: 10)
            var replacement = ""
            if let value, let scalar = Unicode.Scalar(value) {
                replacement = String(Character(scalar))
            }
            // The offset is taken before the edit and the cursor rebuilt
            // after it: replaceSubrange invalidates the indices we were
            // holding, and reusing one is the kind of bug that only shows
            // up on the one article that has an entity in it.
            let offset = s.distance(from: s.startIndex, to: r.lowerBound)
            s.replaceSubrange(r, with: replacement)
            cursor = s.index(s.startIndex, offsetBy: offset + replacement.count,
                             limitedBy: s.endIndex) ?? s.endIndex
        }

        for (entity, char) in named {
            s = s.replacingOccurrences(of: entity, with: char, options: .caseInsensitive)
        }
        return s
    }
}

// MARK: Stores

@MainActor
final class TickerNewsStore: ObservableObject {
    @Published private(set) var state: Loadable<TickerNewsFeed> = .loading
    /// A 403 is an answer, not an outage: /api/holdings is closed to
    /// guests (holdings.js:253), and a guest is a real member of this
    /// app. It renders as one quiet sentence, never as COULD NOT LOAD
    /// over a RETRY that can never succeed.
    @Published private(set) var denied: String?

    private var symbol: String?

    /// Called on appear. A second appearance of the same name refetches
    /// nothing; a different name starts over.
    func open(_ ticker: String) async {
        if ticker != symbol {
            symbol = ticker
            await load()
            return
        }
        if state.value == nil && denied == nil { await load() }
    }

    func load() async {
        state = .loading
        await fetch(keepOld: false)
    }

    /// Pull-to-refresh, the stale strip's retry, and coming back to the
    /// app. Keeps the headlines up when the refetch fails, because a
    /// member who pulled still wants to read what is already there.
    func refresh() async { await fetch(keepOld: true) }

    private func fetch(keepOld: Bool) async {
        guard let symbol else { return }
        let previous = state.value
        denied = nil
        do {
            // No `?name=` even though the route accepts one
            // (holdings.js:503). Finnhub's company-news call is keyed on
            // the symbol alone and the name only ever reaches the cache
            // key (news.js:33), so sending it would split the server's
            // cache per spelling and buy nothing.
            let feed = try await API.shared.get("/holdings/news/\(symbol)",
                                                as: TickerNewsFeed.self)
            state = .loaded(feed, at: Date())
        } catch APIError.cancelled {
            // Leaving the name mid-load is not a failure.
            return
        } catch APIError.forbidden(let msg) {
            denied = msg
            state = .failed(msg)
        } catch {
            let msg = error.localizedDescription
            state = keepOld && previous != nil ? .stale(previous!, msg) : .failed(msg)
        }
    }
}

@MainActor
final class TickerNewsReaderStore: ObservableObject {
    @Published private(set) var state: Loadable<TickerNewsReading> = .loading

    /// One shot, on open. There is no refresh(): a published article
    /// does not change, which is the same assumption the server's
    /// one-hour article cache rests on (news.js:201), so there is never
    /// an old value worth keeping under a stale strip.
    func load(_ raw: String?) async {
        state = .loading
        guard let raw, !raw.isEmpty, let path = Self.articlePath(raw) else {
            state = .loaded(.unavailable("This headline arrived without a link."), at: Date())
            return
        }
        do {
            let a = try await API.shared.get(path, as: TickerNewsArticle.self)
            let paras = TickerNewsHTML.paragraphs(from: a.contentHtml)
            let chars = paras.reduce(0) { $0 + $1.count }
            if paras.isEmpty || chars < TickerNewsHTML.usableFloor {
                state = .loaded(.unavailable("Only a fragment of this page came back, so there is nothing worth showing here."), at: Date())
            } else {
                state = .loaded(.text(a, paras), at: Date())
            }
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden(let msg) {
            state = .loaded(.unavailable(msg), at: Date())
        } catch let e as APIError {
            state = .loaded(.unavailable(Self.explain(e)), at: Date())
        } catch {
            state = .loaded(.unavailable("The reader did not come back."), at: Date())
        }
    }

    /// Why the in-app reader could not run, said without blaming the
    /// wrong party.
    ///
    /// The 4xx family is the extractor's own verdict on the page
    /// (news.js:375-411: not HTML, too large, not readable) and belongs
    /// to the publisher. A 5xx is genuinely ambiguous by the time we
    /// see it — `API.get` has already spent the 3/6/12s cold-start
    /// ladder on it, because it cannot tell a publisher refusing us
    /// from a Render dyno waking up — so it says so rather than
    /// borrowing APIError's "the server is still waking up", which
    /// would be a confident claim about our own health that we have no
    /// evidence for.
    private static func explain(_ e: APIError) -> String {
        switch e {
        case .server(let code, let msg):
            if code == 429 { return msg }
            if (400..<500).contains(code) {
                return "This publisher's page could not be turned into readable text."
            }
            return "The page did not come back. It may be the publisher blocking us, or our own server."
        case .sessionOver: return "Signed out. Sign in again."
        case .noResponse:  return "No response from the server."
        case .forbidden(let m): return m
        case .cancelled:   return "Cancelled."
        }
    }

    /// The article URL is a query parameter, and this is the one place
    /// in the app that puts arbitrary text into one. Encoded against an
    /// explicit unreserved set rather than URLComponents, which leaves
    /// "+" alone — and Express reads a raw "+" in a query value as a
    /// space, so a URL carrying one would be fetched with a hole in it.
    private static func articlePath(_ raw: String) -> String? {
        let unreserved = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        guard let encoded = raw.addingPercentEncoding(withAllowedCharacters: unreserved),
              !encoded.isEmpty else { return nil }
        return "/holdings/news/article?url=\(encoded)"
    }
}

// MARK: The section

/// Recent headlines for one name. Drop it into a ticker screen's
/// LazyVStack alongside the other sections; it owns its own fetch,
/// its own staleness and its own reader sheet.
struct TickerNewsSection: View {
    let ticker: String

    @StateObject private var store = TickerNewsStore()
    @ObservedObject private var clock = StaleClock.shared
    @State private var reading: TickerNewsItem?

    var body: some View {
        // A symbol the route would reject is not a name we can look up,
        // and the section simply does not exist for it — the same
        // honesty as a position block that is absent for a name we do
        // not own, rather than a header over an error we caused.
        if let symbol = Self.routeSymbol(ticker) {
            Section {
                content(symbol)
            } header: {
                SectionHeader(text: "News", trailing: headerTrailing)
            }
        }
    }

    @ViewBuilder private func content(_ symbol: String) -> some View {
        VStack(spacing: 0) {
            if let denied = store.denied {
                // One sentence. This member may not read this; that is
                // an answer and there is nothing to retry.
                quiet(denied)
            } else {
                // Fifteen minutes matches the wire. The server's own
                // headline cache is ten (news.js:30), so anything older
                // than this is ours to admit to.
                ScreenState(state: store.state.aged(after: 900, now: clock.tick),
                            emptyWhen: { ($0.articles ?? []).isEmpty },
                            emptyText: emptyText(symbol),
                            emptyIsGood: true,
                            retry: { Task { await store.load() } },
                            staleRetry: { Task { await store.refresh() } }) { feed in
                    feedBody(feed)
                }
            }
        }
        .task(id: symbol) { await store.open(symbol) }
        .refreshOnForeground { await store.refresh() }
        .sheet(item: $reading) { item in
            TickerNewsReaderSheet(item: item, code: symbol)
        }
    }

    // MARK: pieces

    private func feedBody(_ feed: TickerNewsFeed) -> some View {
        let items = feed.articles ?? []
        return VStack(spacing: 0) {
            if feed.topic != nil {
                // The reader asked about a fund and Finnhub answered
                // about the market. Both are true; only one is what
                // they clicked on.
                notice("These are general market headlines. Finnhub carries no company wire for a fund, so nothing here is specifically about this holding.",
                       tone: T.orange)
            }
            if feed.stale == true {
                notice(feed.staleReason == "rate_limit"
                       ? "Finnhub is rate-limiting us, so these are the last headlines we managed to pull."
                       : "Finnhub did not answer, so these are the last headlines we managed to pull.",
                       tone: T.amber)
            }
            if let n = feed.narrative, !n.isEmpty {
                narrativeBlock(n)
            }

            // Order is left exactly as the server sent it. When the
            // batch was ranked, articleRanker.js:200 has already sorted
            // it by materiality; when it was not, it is publication
            // order. Re-sorting here would mean the header's label and
            // the list disagreed.
            ForEach(items) { item in
                Button { reading = item } label: { row(item) }
                    .buttonStyle(.plain)
            }

            footer(feed, count: items.count)
        }
    }

    /// The wire's row, copied deliberately rather than rebuilt out of
    /// Row. A headline needs the full width to wrap and Row reserves a
    /// trailing column for a number, which is why NewsScreen does not
    /// use it either — and if this section and the wire laid out the
    /// same object differently, they would read as two apps.
    private func row(_ a: TickerNewsItem) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(a.title ?? "Untitled")
                .font(Type.headline)
                .foregroundStyle(T.white)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            if let why = a.reason, !why.isEmpty {
                Text(why)
                    .font(Type.footnote)
                    .foregroundStyle(T.dim)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: Space.s) {
                // Amber is the app's "look at this", and materiality is
                // the only thing here worth pulling an eye. It is
                // pointedly not green or red: a thesis-defining story
                // is not good news or bad news, and the score says
                // nothing about direction.
                if let tier = a.tier { Chip(text: tier, tone: T.amber) }
                if let s = a.source { Chip(text: s, tone: T.orange) }
                Spacer(minLength: 0)
                Text(age(a.publishedAt))
                    .font(Type.meta)
                    .foregroundStyle(T.muted)
            }
        }
        .padding(.vertical, Space.m)
        .padding(.horizontal, Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .edgeStrip((a.score ?? 0) >= 9 ? T.amber : nil)
        .hairline()
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// Machine-written, and labelled as such in the same breath. The
    /// club reads this section to decide things; a synthesis nobody
    /// signed has to say so where it is read, not in a footnote.
    private func narrativeBlock(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Chip(text: "Machine read", tone: T.muted)
            Text(text)
                .font(Type.body)
                .foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }

    private func footer(_ feed: TickerNewsFeed, count: Int) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            AsOfStamp(date: Fmt.parseISO(feed.fetchedAt))
            Text(feed.ranked == true
                 ? "Ordered by how much each story could move the thesis, judged by our own model — not by how urgent it is. Headlines from Finnhub."
                 : "Newest first. Nobody scored this batch, so no story here is marked material. Headlines from Finnhub.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func notice(_ text: String, tone: Color) -> some View {
        HStack(spacing: Space.s) {
            Text(text)
                .font(Type.meta)
                .foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.opacity(0.12))
    }

    private func quiet(_ text: String) -> some View {
        Text(text)
            .font(Type.footnote)
            .foregroundStyle(T.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: labels

    /// The header says what the order MEANS, because the same list in
    /// the same layout means two different things depending on whether
    /// the ranker ran, and only the payload knows which.
    private var headerTrailing: String? {
        guard let feed = store.state.value else { return nil }
        let n = (feed.articles ?? []).count
        guard n > 0 else { return nil }
        return feed.ranked == true ? "\(n) · by materiality" : "\(n) · newest first"
    }

    /// Quiet, not broken — so it is drawn in the good-news colour. The
    /// sixty days is the service's own window (news.js:66) and worth
    /// naming: it is what makes "nothing" a real answer rather than a
    /// short look.
    private func emptyText(_ symbol: String) -> String {
        "Nothing on the wire for \(symbol) in the last sixty days. A quiet name, not a failure."
    }

    /// Fmt.since is written for numbers whose lifetime is minutes and
    /// collapses anything older than an hour to "at 09:31", which on a
    /// sixty-day window would date half these headlines to this
    /// morning. So: since() while it is still fresh enough to be about
    /// today, and the dated stamp after that. Both are Fmt.
    private func age(_ iso: String?) -> String {
        guard let d = Fmt.parseISO(iso) else { return Fmt.shortDateTime(iso) }
        return Date().timeIntervalSince(d) < 3600 ? Fmt.since(d) : Fmt.shortDateTime(iso)
    }

    /// Mirrors the route's own guard at holdings.js:497. Anything it
    /// would 400 on is filtered out here rather than sent.
    private static func routeSymbol(_ raw: String) -> String? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")
        let s = String(raw.uppercased().filter { allowed.contains($0) })
        guard !s.isEmpty, s.count <= 10 else { return nil }
        return s
    }
}

// MARK: The reader sheet

/// Tapping a headline opens the story here rather than in Safari.
///
/// That is the deliberate choice: the reason to open a holding in this
/// app is to stay inside the position, and the server already does the
/// hard half — it fetches, runs Readability and sanitizes (news.js:338).
/// The link out is kept as the honest fallback and is one tap away from
/// every state, including a successful read, because our extraction is
/// a copy and the publisher's page is the thing itself.
private struct TickerNewsReaderSheet: View {
    let item: TickerNewsItem
    /// The ticker, for the function bar's left slot.
    let code: String

    @StateObject private var store = TickerNewsReaderStore()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: code, title: "Reader")
            metaStrip
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    switch store.state {
                    case .loading:
                        LoadingState().padding(.vertical, Space.xl)
                    case .failed(let msg):
                        // Nothing sets this today - every way the reader
                        // can lose is an answer about the page and lands
                        // in .unavailable with a link out. The branch
                        // stays because Loadable has four states and the
                        // day one of them means "our fault", COULD NOT
                        // LOAD over a RETRY is the right rendering.
                        ErrorState(message: msg, retry: { Task { await store.load(item.url) } })
                    case .stale(let reading, _), .loaded(let reading, _):
                        reader(reading)
                    }
                }
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(T.bg)
        .presentationDragIndicator(.visible)
        .task { await store.load(item.url) }
    }

    private var metaStrip: some View {
        HStack(spacing: Space.s) {
            if let s = item.source { Chip(text: s, tone: T.orange) }
            // The feed's own ISO stamp, not the one Readability guessed
            // from the page's metadata: this one is known to parse.
            Text(Fmt.shortDateTime(item.publishedAt))
                .font(Type.meta)
                .foregroundStyle(T.muted)
            Spacer(minLength: Space.s)
            Button("DONE") { dismiss() }.buttonStyle(GriffinButtonStyle())
        }
        .padding(.horizontal, Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }

    @ViewBuilder private func reader(_ reading: TickerNewsReading) -> some View {
        switch reading {
        case .unavailable(let why):
            VStack(alignment: .leading, spacing: Space.m) {
                Text(item.title ?? "Untitled")
                    .font(Type.headline)
                    .foregroundStyle(T.white)
                    .fixedSize(horizontal: false, vertical: true)
                // The headline's own summary line is still ours to
                // show — Finnhub sent it with the feed and it does not
                // depend on the extraction that just failed.
                if let d = item.description, !d.isEmpty {
                    Text(d)
                        .font(Type.body)
                        .foregroundStyle(T.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(why)
                    .font(Type.footnote)
                    .foregroundStyle(T.muted)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Space.m) {
                    sourceLink
                    Button("TRY AGAIN") { Task { await store.load(item.url) } }
                        .buttonStyle(GriffinButtonStyle(tone: T.cyan))
                }
            }

        case .text(let a, let paragraphs):
            VStack(alignment: .leading, spacing: Space.l) {
                Text(a.title ?? item.title ?? "Untitled")
                    .font(Type.headline)
                    .foregroundStyle(T.white)
                    .fixedSize(horizontal: false, vertical: true)

                if let by = byline(a) {
                    Text(by).font(Type.meta).foregroundStyle(T.muted)
                }

                if let s = a.summary, !s.isEmpty {
                    VStack(alignment: .leading, spacing: Space.s) {
                        Chip(text: "Machine read", tone: T.muted)
                        Text(s)
                            .font(Type.body)
                            .foregroundStyle(T.dim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(Space.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T.card)
                    .hairline()
                }

                // Prose face, generous leading. Everything else in this
                // app is mono because the system is speaking; an
                // article is a person writing, and it gets read the way
                // people read.
                ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, p in
                    Text(p)
                        .font(Type.body)
                        .foregroundStyle(T.white)
                        .lineSpacing(Space.xs)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: Space.s) {
                    Text("Extracted from the publisher's page. Formatting, images and anything interactive are gone.")
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    sourceLink
                }
                .padding(.top, Space.m)
            }
        }
    }

    /// Byline and outlet, whichever of them Readability found. Built
    /// from what is present rather than printed with empty slots.
    private func byline(_ a: TickerNewsArticle) -> String? {
        let parts = [a.byline, a.siteName ?? item.source].compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private var sourceLink: some View {
        if let raw = item.url, let url = URL(string: raw) {
            Link("OPEN AT SOURCE", destination: url)
                .buttonStyle(GriffinButtonStyle())
        }
    }
}
