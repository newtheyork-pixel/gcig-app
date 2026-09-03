import SwiftUI

// Symbol search. The only screen where the member, rather than the club,
// decides what the app is about — every other list is something we chose
// for them. It is also the cheapest way to make the phone feel like a
// terminal instead of a report: type three letters, get the name.
//
// Three things here are not obvious and each is load-bearing.
//
// The request is debounced rather than fired per keystroke, because the
// route reads a 24-hour cache of the whole EDGAR directory behind a
// 900/10min data limiter that the club shares from one school address.
// Six members typing AAPL is 24 requests unthrottled and 6 debounced.
//
// The header names the query the rows on screen answer. A search field
// cannot avoid showing an answer to a slightly older question while the
// new one is in flight; the fix is not to hide it but to label it, so a
// lagging list can never be read as a wrong one.
//
// And a 502 from this route is OUR outage, not a verdict on the symbol.
// The server says "Symbol directory unavailable" when the SEC ticker map
// could not be loaded at all, which is the same shape as "nothing
// matches" if you only look at the row count. Those are different facts
// and this file keeps them apart.

// MARK: What the server actually sends

/// GET /api/terminal/symbol-search
/// server/src/routes/terminal.js:1129-1137 — `res.json({ query, matches })`,
/// where `matches` is `searchSymbols(q, 8)`. Every field optional: a
/// renamed key decodes to nil in silence and would render a dash as fact.
///
/// The route also answers `{ query, matches: [] }` for an empty or
/// over-40-character query WITHOUT searching (terminal.js:1131), which is
/// why the store refuses to send one rather than believing the answer.
struct SearchHits: Decodable {
    let query: String?
    let matches: [SearchMatch]?
}

/// server/src/services/secFilings.js:121 — the result is mapped down to
/// exactly `{ ticker, name }`. The scoring keeps `rank` internally and
/// deliberately does not ship it; do not add a field here hoping for it.
struct SearchMatch: Decodable, Hashable {
    let ticker: String?
    let name: String?
}

/// One query and its answer, kept together on purpose. The rows alone
/// cannot say what question they answer, and on a screen that re-queries
/// as you type that is the whole risk.
struct SearchAnswer {
    let query: String
    let matches: [SearchMatch]
}

// MARK: Store

@MainActor
final class SymbolSearchStore: ObservableObject {
    @Published private(set) var state: Loadable<SearchAnswer> = .loaded(SearchAnswer(query: "", matches: []), at: Date())

    /// A sentence that REPLACES the result list without claiming failure.
    /// Two things land here: a 403, which is an answer about this member
    /// rather than a fault, and a query longer than the directory will
    /// search. Neither gets COULD NOT LOAD over a RETRY that cannot help.
    @Published private(set) var quiet: String?

    /// The server's own cap (terminal.js:1132). Held here so the footnote
    /// that admits the list is truncated cannot drift from the truth.
    static let resultCap = 8
    /// terminal.js:1131 refuses anything longer, silently, with an empty
    /// list. Sending it anyway would print "no such symbol" about a query
    /// nobody looked up.
    static let maxQuery = 40

    private var debounce: Task<Void, Never>?
    /// The query the newest request belongs to. Responses can land out of
    /// order — a three-letter search that hits a cold cache finishes after
    /// the five-letter one typed behind it — and the later keystroke must
    /// win regardless of which reply arrives first.
    private var inFlight: String?
    /// A 403 does not improve while the app is open, so once one lands we
    /// stop asking. Retrying a permission gate on every keystroke is how a
    /// gated member generates the most traffic of anyone.
    private var gateClosed = false

    // MARK: entry points

    /// Called on every keystroke; sends nothing for 300ms. Typing is not a
    /// request, a pause is.
    func typed(_ raw: String) {
        debounce?.cancel()
        let q = Self.normalise(raw)
        guard !q.isEmpty else { clear(); return }
        guard !gateClosed else { return }
        debounce = Task { [weak self] in
            // Sleep throws on cancellation, which is the ordinary case
            // here: it means another character arrived. Returning is
            // correct and silent — a superseded search is not a failure.
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            if Task.isCancelled { return }
            await self?.fetch(q, keepingOldOnFailure: false)
        }
    }

    /// Return key, and the retry under a failure. Skips the wait: the
    /// member has already stopped typing by definition.
    func runNow(_ raw: String) async {
        debounce?.cancel()
        let q = Self.normalise(raw)
        guard !q.isEmpty else { clear(); return }
        await fetch(q, keepingOldOnFailure: false)
    }

    /// Pull-to-refresh and the stale strip's retry. Re-asks the SAME
    /// question and keeps the rows if it fails, which is the difference
    /// between this and `runNow`.
    func refresh(_ raw: String) async {
        debounce?.cancel()
        let q = Self.normalise(raw)
        guard !q.isEmpty else { clear(); return }
        await fetch(q, keepingOldOnFailure: true)
    }

    /// Emptying the field is not a search returning nothing. Everything
    /// resets except the gate, which is a fact about the member.
    func clear() {
        debounce?.cancel()
        debounce = nil
        inFlight = nil
        if !gateClosed { quiet = nil }
        state = .loaded(SearchAnswer(query: "", matches: []), at: Date())
    }

    // MARK: the request

    private func fetch(_ q: String, keepingOldOnFailure keepOld: Bool) async {
        guard !gateClosed else { return }
        guard q.count <= Self.maxQuery else {
            quiet = "That is longer than the directory will search, so nothing was looked up. Try just the ticker."
            state = .loaded(SearchAnswer(query: q, matches: []), at: Date())
            return
        }
        guard let encoded = q.addingPercentEncoding(withAllowedCharacters: Self.queryValue) else {
            state = .failed("That query could not be sent.")
            return
        }

        quiet = nil
        inFlight = q
        let previous = state.value
        // Keep rows up while the next answer is in flight: swapping a
        // populated list for a spinner on every pause makes the field feel
        // broken, and the section header names the query those rows
        // answer, so a lagging list cannot be misread.
        //
        // An EMPTY previous answer does not get the same treatment. There
        // is nothing to preserve, and "no symbol matches" left standing
        // while a shorter query is in flight is the one wrong sentence
        // this screen can produce: deleting a character can turn a genuine
        // no-match into a hit. Extending a query cannot, which is why the
        // reverse case needs no guard.
        if previous?.matches.isEmpty ?? true { state = .loading }

        do {
            let hits = try await API.shared.get("/terminal/symbol-search?q=\(encoded)",
                                                as: SearchHits.self)
            guard inFlight == q else { return }
            // A match with no ticker has nowhere to navigate to, and a row
            // that does nothing when tapped reads as a broken app rather
            // than as a thin record. Drop it rather than render it.
            let rows = (hits.matches ?? []).filter { !($0.ticker ?? "").isEmpty }
            state = .loaded(SearchAnswer(query: hits.query ?? q, matches: rows), at: Date())
        } catch APIError.cancelled {
            // The member typed another letter, or left the screen. Neither
            // is a failure and neither may touch what is on screen.
            return
        } catch APIError.forbidden {
            // The server's own words are about roles and route names. This
            // one is about the member, and it is the whole message: no cap,
            // no retry, nothing red.
            gateClosed = true
            quiet = "Symbol search needs Analyst access."
            state = .loaded(SearchAnswer(query: q, matches: []), at: Date())
        } catch APIError.server(let code, let raw) where code == 502 || code == 503 || code == 504 {
            guard inFlight == q else { return }
            // APIError renders every 5xx as "the server is waking up",
            // which is right for a cold Render dyno and wrong for this
            // route's own 502 — that one means the SEC ticker map could not
            // be loaded, so the search never ran. The associated value
            // still carries the server's sentence, so the two are
            // separable here even though the rendered description is not.
            let directoryDown = raw.lowercased().contains("directory")
            let msg = directoryDown
                ? "The SEC symbol directory is not answering, so the search could not run. This says nothing about the name you typed."
                : "The server is still waking up. Try again in a moment."
            settle(msg, keepOld: keepOld, previous: previous)
        } catch {
            guard inFlight == q else { return }
            settle(error.localizedDescription, keepOld: keepOld, previous: previous)
        }
    }

    /// A refresh keeps the rows it already had under a stale strip; a
    /// fresh search has nothing worth keeping and says so plainly.
    private func settle(_ msg: String, keepOld: Bool, previous: SearchAnswer?) {
        if keepOld, let previous, !previous.matches.isEmpty {
            state = .stale(previous, msg)
        } else {
            state = .failed(msg)
        }
    }

    // MARK: helpers

    private static func normalise(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `.urlQueryAllowed` passes `&`, `+` and `=` through untouched, which
    /// is fine for a whole query string and wrong for one value inside it:
    /// a member typing "AT&T" would otherwise send a second parameter.
    private static let queryValue: CharacterSet = {
        var s = CharacterSet.urlQueryAllowed
        s.remove(charactersIn: "&+=?#")
        return s
    }()
}

// MARK: Recents

/// One opened name. The company name rides along so a recent list reads
/// like the search that produced it rather than like four letters.
struct SearchRecent: Codable, Hashable, Identifiable {
    let ticker: String
    var name: String?
    var id: String { ticker }
}

/// The last eight names opened from search, on this handset only.
///
/// UserDefaults and not the keychain: this is a convenience, not a secret,
/// and it says nothing the club's own book does not already say to anyone
/// holding the phone. It is also deliberately not synced anywhere — a
/// member's half-formed interest in a name is not club data, and the phone
/// does not send.
@MainActor
final class SearchRecents: ObservableObject {
    private static let key = "griffin.search.recentTickers.v1"
    static let limit = 8

    @Published private(set) var items: [SearchRecent] = []

    init() { items = Self.read() }

    /// Most recent first, deduped on the symbol. Re-opening a name moves
    /// it up rather than adding it twice, which is what "last eight
    /// opened" has to mean if the list is to stay useful.
    func remember(ticker: String, name: String?) {
        let symbol = ticker.uppercased().trimmingCharacters(in: .whitespaces)
        guard !symbol.isEmpty else { return }
        var next = items.filter { $0.ticker != symbol }
        // Keep the name we already had if this tap arrived without one, so
        // a row cannot lose its company name by being opened again.
        let keptName = name ?? items.first(where: { $0.ticker == symbol })?.name
        next.insert(SearchRecent(ticker: symbol, name: keptName), at: 0)
        items = Array(next.prefix(Self.limit))
        write()
    }

    func clear() {
        items = []
        UserDefaults.standard.removeObject(forKey: Self.key)
    }

    private func write() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        UserDefaults.standard.set(data, forKey: Self.key)
    }

    /// A stored list that will not decode is dropped, not repaired. It is
    /// eight tickers; guessing at half of them is worse than an empty
    /// list, which at least reads as "nothing yet".
    private static func read() -> [SearchRecent] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let rows = try? JSONDecoder().decode([SearchRecent].self, from: data)
        else { return [] }
        return Array(rows.prefix(limit))
    }
}

// MARK: Screen

struct SearchScreen: View {
    @StateObject private var store = SymbolSearchStore()
    @StateObject private var recents = SearchRecents()
    @State private var text = ""
    @FocusState private var focused: Bool
    /// Focus is claimed once per screen lifetime, not on every appearance.
    /// `onAppear` fires again when the member comes back from a ticker,
    /// and a keyboard that reopens over the results they just came back to
    /// read is the most annoying possible way to be helpful.
    @State private var didFocus = false

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "SRCH", title: "Symbol search")
            field
            results
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: TickerScreen.self) { $0 }
        .onChange(of: text) { _, new in store.typed(new) }
        .task {
            guard !didFocus else { return }
            didFocus = true
            // Focus set in the same run loop as the first layout is
            // dropped on device often enough to look like a dead field.
            try? await Task.sleep(for: .milliseconds(150))
            focused = true
        }
    }

    // MARK: the field

    private var field: some View {
        HStack(spacing: Space.s) {
            Text(">")
                .font(Type.ticker)
                .foregroundStyle(T.muted)
            // Capitalised because the server uppercases both sides of the
            // comparison anyway (secFilings.js:103), so it costs nothing
            // and makes the field read as a command line rather than a
            // note. Autocorrect off for the obvious reason: iOS turns AIT
            // into "air" and LISN into "listen".
            TextField("", text: $text, prompt: Text("Ticker or company"))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .font(Type.ticker)
                .foregroundStyle(T.amber)
                .tint(T.amber)
                .focused($focused)
                .onSubmit { Task { await store.runNow(text) } }
            if !text.isEmpty {
                Button {
                    text = ""
                    focused = true
                } label: {
                    Text("CLEAR")
                        .font(Type.chip)
                        .foregroundStyle(T.cyan)
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
            }
        }
        .padding(.horizontal, Space.l)
        .frame(minHeight: 44)
        .background(T.card)
        .hairline()
    }

    // MARK: what sits under it

    @ViewBuilder private var results: some View {
        if let quiet = store.quiet {
            // Our own gate, or a query we declined to send. Said once, in
            // one line, with nothing to press.
            EmptyState(text: quiet)
        } else if trimmed.isEmpty {
            recentList
        } else {
            ScreenState(state: store.state,
                        emptyWhen: { $0.matches.isEmpty },
                        // Good news, and coloured as such: the search ran
                        // and the directory is complete. Nothing failed.
                        emptyText: "The SEC directory has no symbol matching \(trimmed.uppercased()). The search ran; try the company name instead.",
                        emptyIsGood: true,
                        retry: { Task { await store.runNow(text) } },
                        staleRetry: { Task { await store.refresh(text) } }) { answer in
                matchList(answer)
            }
        }
    }

    private func matchList(_ answer: SearchAnswer) -> some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    // Positional rather than keyed on the ticker. EDGAR's
                    // directory is unique by symbol today and this is a
                    // list of at most eight rows that is replaced whole,
                    // so identity buys nothing — while a duplicate key
                    // would silently render one row where there are two.
                    ForEach(answer.matches.indices, id: \.self) { i in
                        matchRow(answer.matches[i])
                    }
                } header: {
                    SectionHeader(text: "Matches",
                                  trailing: "\(answer.query.uppercased()) · \(answer.matches.count)")
                }

                if answer.matches.count >= SymbolSearchStore.resultCap {
                    truncationNote
                }
            }
        }
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await store.refresh(text) }
    }

    @ViewBuilder private func matchRow(_ match: SearchMatch) -> some View {
        let symbol = (match.ticker ?? "").uppercased()
        NavigationLink(value: TickerScreen(symbol: symbol)) {
            TickerRow(ticker: symbol, name: match.name) {
                // The function code this row opens onto, in the terminal's
                // own vocabulary, rather than a chevron.
                Chip(text: "DES", tone: T.dim)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A NavigationLink carrying a value has no "was activated" hook,
        // and the destination is TickerScreen, which lives in another file
        // this change may not touch. A simultaneous tap is the honest
        // place to record the visit.
        .simultaneousGesture(TapGesture().onEnded {
            recents.remember(ticker: symbol, name: match.name)
        })
    }

    /// The route hands back the eight best and says nothing about what it
    /// dropped, so the screen says it instead. Without this line a member
    /// searching a common prefix concludes the name is not in EDGAR.
    private var truncationNote: some View {
        Text("The directory returns the \(SymbolSearchStore.resultCap) closest matches. A name you expected may sit just below the cut, so type more of the symbol.")
            .font(Type.meta)
            .foregroundStyle(T.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: recents, which is what an empty field should show

    @ViewBuilder private var recentList: some View {
        if recents.items.isEmpty {
            // A first-run screen with no history is not an error and not
            // an empty result. It is an invitation, and it should read as
            // one rather than as something having gone wrong.
            EmptyState(text: "Type a ticker or a company name.\nAAPL, LISN, Lindt.")
        } else {
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        ForEach(recents.items) { item in
                            NavigationLink(value: TickerScreen(symbol: item.ticker)) {
                                TickerRow(ticker: item.ticker, name: item.name) {
                                    Chip(text: "DES", tone: T.dim)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            // Re-opening moves the name back to the top.
                            // The list reorders under the finger as the
                            // push begins, which is the correct record and
                            // is gone by the time the member returns.
                            .simultaneousGesture(TapGesture().onEnded {
                                recents.remember(ticker: item.ticker, name: item.name)
                            })
                        }
                    } header: {
                        SectionHeader(text: "Recent", trailing: "\(recents.items.count)")
                    }

                    VStack(alignment: .leading, spacing: Space.m) {
                        Text("Kept on this phone only. Nothing here is sent to the club.")
                            .font(Type.meta)
                            .foregroundStyle(T.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("CLEAR RECENTS") { recents.clear() }
                            .buttonStyle(GriffinButtonStyle(tone: T.dim))
                    }
                    .padding(Space.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .scrollDismissesKeyboard(.immediately)
        }
    }
}
