import SwiftUI

// PERFORMANCE — the question the app could not answer.
//
// BOOK says what we own and what it is worth. It never said whether any
// of it worked, which is the first thing a member asks and the last
// thing this app could tell them. This screen answers it from
// /holdings/period-returns, and it has to be careful about two things,
// because both have already put a confident wrong number in front of
// somebody in this codebase.
//
// The first is UNITS. Every `pct` on that route is a PERCENT, not a
// fraction: the handler multiplies by 100 itself before it serialises
// (holdings.js:1538 for the day, :1571 for the lookbacks), and the
// since-purchase column arrives from a CSV export of the sheet, where
// toNumber() strips the "%" off "12.40%" and leaves 12.4. So nothing is
// rescaled on the way in. Rescaling it would print a 2.3% year as 0.02%,
// which is precisely how the dividend-yield bug shipped.
//
// The second is what a period MEANS here. The route prices TODAY'S
// positions across each window; it does not follow the fund through
// time. A name bought three weeks ago still carries its whole one-year
// price move, weighted by the shares we hold now. That is an honest
// answer to "how are the things we own doing" and a wrong answer to
// "how did the fund do", and the screen says so on the screen rather
// than leaving a member to work it out from a number that looks
// official.

// MARK: Decodables
//
// Written from the handlers, every field optional. A key that does not
// exist decodes to nil in silence and renders as a dash, so the only
// protection is having read the route.

/// One cell of the period-returns map.
///
/// server/src/routes/holdings.js:1518 — `GET /api/holdings/period-returns`.
/// The body has no envelope: it is a bare object keyed by ticker, each
/// value an object keyed by period.
///
///     { "AIT": { "1D": {pct,usd}, "1W": …, "1M": …, "1Y": …,
///                "purchase": {pct,usd} }, … }
///
/// `pct` is a percent (see the file header). `usd` is whole dollars for
/// the whole position — the price move times the share count
/// (holdings.js:1539, :1572) — and is null wherever the sheet has no
/// share count. Cash is skipped by the handler at :1528, so everything
/// below is the EQUITY book and never the fund.
struct PerfCell: Decodable {
    let pct: Double?
    let usd: Double?
}

/// server/src/routes/dashboard.js:177 — `GET /api/dashboard/macro`,
/// served by services/fredMacro.js:107.
///
/// `configured:false` with an empty list is the deliberate shape when
/// FRED_API_KEY is unset. That is a fact about OUR server and gets said
/// as one; it is not a claim that the world has no ten-year yield.
struct PerfMacro: Decodable {
    let configured: Bool?
    let indicators: [PerfMacroRow]?
    let fetchedAt: String?
}

/// fredMacro.js:127 builds these; the CPI row at :99 is the same shape.
///
/// `value` is already a STRING — the service has run toFixed(precision)
/// on it — so it is printed as sent rather than parsed back into a
/// Double and reformatted, which is the one way this screen could
/// disagree with the dashboard about a number they both read from FRED.
/// `unit` is cosmetic: "%" is a suffix, "$" a prefix, "" nothing.
///
/// `change` is deliberately NOT rendered. It is a raw difference in each
/// series' own units — percentage points for the ten-year, index points
/// for VIX, and null for CPI because a monthly series has no daily move
/// — and there is no formatter in Fmt for "a bare difference in an
/// unnamed unit". Printing 0.04 next to a value carrying a "%" suffix
/// invites reading it as 0.04%, which is the units mistake this file
/// opens by warning about. The reading and its date are the context this
/// screen needs.
struct PerfMacroRow: Decodable, Identifiable {
    let id: String?
    let label: String?
    let unit: String?
    let value: String?
    let change: Double?
    let asOf: String?
}

/// server/src/routes/terminal.js:1468 — `GET /api/terminal/indices`.
/// Rows are built in services/worldIndices.js:236-273.
///
/// This whole router sits behind requireTerminalAccess (terminal.js:65),
/// which is Analyst and above, and JuniorAnalyst is the default role for
/// every self-signup. A 403 here is the ordinary case for a new member,
/// not an edge one.
struct PerfIndices: Decodable {
    let asOf: String?
    let rows: [PerfIndexRow]?
}

/// Only `changePercent` is rendered, and that is a decision rather than
/// laziness. When Yahoo and FRED both miss, the service falls back to a
/// tracking ETF and sets `approx:true`: the fund's share price is a
/// wrong LEVEL under the index's name (747 where the S&P is near 7,500)
/// while its PERCENTAGE move is faithful. Showing the move alone means
/// every row is true whichever source answered — and the move is the
/// only part of this block that compares to our own returns anyway.
/// Levels belong on the desk.
struct PerfIndexRow: Decodable, Identifiable {
    let name: String?
    let region: String?
    let symbol: String?
    let last: Double?
    let change: Double?
    let changePercent: Double?
    let source: String?
    let moveSource: String?
    let approx: Bool?

    /// Stable across refreshes so a re-render does not rebuild every
    /// row: the service always sends a symbol, and the name is the
    /// fallback rather than a fresh UUID, which would.
    var id: String { symbol ?? name ?? "" }
}

// MARK: The book's own number

/// One window, aggregated up from the positions.
struct PerfPeriod: Identifiable {
    let key: String
    let label: String
    let pct: Double?
    let usd: Double?
    /// How many positions actually carried this window, and out of how
    /// many. A one-year figure covering four of twelve names is a
    /// different statement from one covering all twelve, and the row has
    /// to be able to say which it is.
    let priced: Int
    let total: Int

    var id: String { key }
}

/// The screen's subject: the equity book rolled up per window.
///
/// The route is per-ticker and there is no book-level row, so the roll-up
/// happens here. The arithmetic is worth reading once.
///
/// For a position, `usd` is the dollar move and `pct` is that move over
/// its own starting value, so `usd / (pct/100)` recovers what the
/// position was WORTH at the start of the window. Summing those gives
/// the book's opening base; summing `usd` gives what the book made. The
/// quotient is the value-weighted return, which is the right way to
/// combine positions of unequal size — averaging the percentages would
/// let a $900 stub swing the book's year as hard as a $30,000 holding.
///
/// Numerator and denominator are taken over the SAME positions on
/// purpose. A position with dollars but no percent (or the reverse) is
/// dropped from both rather than from one, because feeding a position's
/// dollars into the top while its base is missing from the bottom
/// inflates the book's return by exactly the share of the book we could
/// not price. What that costs us is coverage, and coverage is printed.
struct PerfBook {
    let periods: [PerfPeriod]
    let positions: Int

    /// Server key on the left, what a person calls it on the right. The
    /// order is the order the rows render in, oldest window last, with
    /// the cumulative figure at the bottom where a total belongs.
    private static let windows: [(key: String, label: String)] = [
        ("1D", "Today"),
        ("1W", "Past week"),
        ("1M", "Past month"),
        ("1Y", "Past year"),
        ("purchase", "Since we bought"),
    ]

    init(_ payload: [String: [String: PerfCell]]) {
        let tickers = payload.keys.sorted()
        positions = tickers.count
        periods = Self.windows.map { window in
            var moved = 0.0
            var base = 0.0
            var priced = 0
            for ticker in tickers {
                guard let cell = payload[ticker]?[window.key],
                      let pct = cell.pct, let usd = cell.usd,
                      pct.isFinite, usd.isFinite,
                      // A position that moved exactly nothing has no
                      // recoverable base — usd/0 is not a number. It
                      // contributes nothing to the top either, so
                      // dropping it leaves the weighted return correct
                      // and only understates the base it is measured
                      // over. Exact equality on a Double makes this
                      // vanishingly rare in practice.
                      pct != 0
                else { continue }
                let opening = usd / (pct / 100)
                guard opening.isFinite, opening > 0 else { continue }
                moved += usd
                base += opening
                priced += 1
            }
            return PerfPeriod(
                key: window.key,
                label: window.label,
                pct: base > 0 ? (moved / base) * 100 : nil,
                usd: priced > 0 ? moved : nil,
                priced: priced,
                total: tickers.count
            )
        }
    }

    func period(_ key: String) -> PerfPeriod? { periods.first { $0.key == key } }
}

/// What a context block has to say when it is not showing numbers.
///
/// `.absent` renders nothing at all, which is what a failed macro call
/// deserves: the returns are the subject and a FRED hiccup must never
/// become the loudest thing on the screen. `.note` is the one quiet
/// sentence a permission gate earns — never COULD NOT LOAD over a RETRY
/// that cannot succeed, and never phrased as a fact about the world.
enum PerfAside<T> {
    case absent
    case ready(T)
    case note(String)
}

// MARK: Store

@MainActor
final class PerformanceStore: ObservableObject {
    @Published private(set) var state: Loadable<PerfBook> = .loading
    /// Context, not subject. Each is fetched and fails on its own.
    @Published private(set) var macro: PerfAside<[PerfMacroRow]> = .absent
    @Published private(set) var indices: PerfAside<[PerfIndexRow]> = .absent

    private var lastLoad: Date?

    /// Deliberately not disk-cached, unlike the book.
    ///
    /// The handler's failure path serves `{}` with a 200 (holdings.js's
    /// catch at the end of /period-returns), so an upstream sheet outage
    /// is indistinguishable from an empty book at the transport layer. If
    /// this screen cached responses, one such minute would overwrite a
    /// good copy with an empty one and the next cold launch would open on
    /// "no positions" — our outage, painted as a fact about the fund.
    func load() async {
        state = .loading
        async let book: Void = fetch(keepingOldOnFailure: false)
        async let context: Void = loadContext()
        _ = await (book, context)
    }

    /// Pull-to-refresh and the stale strip's retry. Never blanks: a
    /// member who pulled still wants to see the numbers, under a strip
    /// saying they are old.
    func refresh() async {
        async let book: Void = fetch(keepingOldOnFailure: true)
        async let context: Void = loadContext()
        _ = await (book, context)
    }

    /// Tab re-entry, silent, and only once the figures have had time to
    /// go stale — switching tabs twice must not hammer the sheet.
    func refreshIfStale(after seconds: TimeInterval = 120) async {
        if case .loading = state { return }
        guard let last = lastLoad, Date().timeIntervalSince(last) > seconds else { return }
        await refresh()
    }

    private func fetch(keepingOldOnFailure keepOld: Bool) async {
        let previous = state.value
        do {
            let raw = try await API.shared.get("/holdings/period-returns",
                                               as: [String: [String: PerfCell]].self)
            lastLoad = Date()
            state = .loaded(PerfBook(raw), at: Date())
        } catch APIError.cancelled {
            // Leaving the tab mid-load is not a failure. Say nothing,
            // change nothing — this catch must stay above the others.
            return
        } catch APIError.forbidden(let why) {
            // /holdings is behind denyGuest, so the club's outside
            // collaborator lands here. One sentence about our gate.
            state = .failed(why)
        } catch {
            let msg = error.localizedDescription
            if keepOld, let previous {
                state = .stale(previous, msg)
            } else {
                state = .failed(msg)
            }
        }
    }

    private func loadContext() async {
        async let m: Void = loadMacro()
        async let i: Void = loadIndices()
        _ = await (m, i)
    }

    private func loadMacro() async {
        do {
            let payload = try await API.shared.get("/dashboard/macro", as: PerfMacro.self)
            if payload.configured == false {
                macro = .note("The server has no FRED key, so it is not reading the macro series. That is our gap, not a quiet market.")
                return
            }
            let rows = (payload.indicators ?? []).filter { !($0.value ?? "").isEmpty }
            macro = rows.isEmpty ? .absent : .ready(rows)
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden(_) {
            macro = .note("Macro readings are not open to your role.")
        } catch {
            // Silent, and specifically: leave standing whatever is
            // already up. Blanking a block that loaded a minute ago on a
            // failed refresh is a worse screen than one that quietly
            // keeps its last reading beside a returns list that just
            // succeeded.
            return
        }
    }

    private func loadIndices() async {
        do {
            let payload = try await API.shared.get("/terminal/indices", as: PerfIndices.self)
            // Americas only. The route sends twenty-one indices across
            // four regions, which is a desk-sized table; here they are
            // context for one book of US equities, and VIX already
            // arrives through the macro block from FRED.
            let rows = (payload.rows ?? []).filter {
                $0.region == "Americas" && $0.changePercent != nil
            }
            indices = rows.isEmpty ? .absent : .ready(rows)
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden(_) {
            indices = .note("Index moves need Analyst access, which is the terminal gate rather than anything about the market.")
        } catch {
            return
        }
    }
}

// MARK: Screen

struct PerformanceScreen: View {
    @StateObject private var store = PerformanceStore()
    /// Drives the clock-based stale strip; see StaleClock.
    @ObservedObject private var clock = StaleClock.shared

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "PERF", title: "Performance")
            ScreenState(state: store.state.aged(after: 600, now: clock.tick),
                        emptyWhen: { $0.positions == 0 },
                        // Not good news, and not a claim either. The
                        // route answers an upstream failure with an
                        // empty object and a 200, so an empty book and a
                        // dead sheet arrive identically — and saying
                        // "the book is flat" for the second one would be
                        // reporting our own outage as a fact.
                        emptyText: "No positions came back with returns. The route serves an empty set when the sheet is unreachable, so this is not a statement that the book is flat.",
                        retry: { Task { await store.load() } },
                        staleRetry: { Task { await store.refresh() } }) { book in
                content(book)
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .task { if store.state.value == nil { await store.load() } }
        .task { await store.refreshIfStale() }
        // Tab re-entry fires on construction and on nothing else. A phone
        // that was pocketed at the open and unlocked at lunch needs this
        // one too, or the screen reports the morning as today.
        .refreshOnForeground(after: 60) { await store.refreshIfStale(after: 60) }
    }

    private func content(_ book: PerfBook) -> some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                headline(book)

                Section {
                    ForEach(book.periods) { PerfPeriodRow(period: $0) }
                    windowsFootnote
                } header: {
                    SectionHeader(text: "Returns",
                                  trailing: "\(book.positions) position\(book.positions == 1 ? "" : "s")")
                }

                macroSection
                marketSection(book)
                stamp
            }
        }
        .refreshable { await store.refresh() }
    }

    // MARK: pieces

    /// The cumulative figure leads, because "are we up on what we bought"
    /// is the question, and because it is the one window on this screen
    /// that measures something we actually lived through: every other row
    /// prices today's positions over a window we may not have held them
    /// for.
    private func headline(_ book: PerfBook) -> some View {
        let p = book.period("purchase")
        return StatBlock(
            label: "Open positions vs cost",
            value: Fmt.moneyDelta(p?.usd),
            delta: p?.pct,
            deltaText: Fmt.pct(p?.pct),
            caption: "Equities only, marked against what we paid. Cash, the sleeves and anything we have already sold are not in it."
        )
    }

    /// The caveat that keeps every row above from being read as the
    /// fund's track record, plus the benchmark we do not have. The route
    /// sends no comparison of any kind — no SPY, no index, nothing — and
    /// the honest move is to say that rather than to quietly compute one
    /// against a number fetched from somewhere else and pass it off as
    /// matched.
    private var windowsFootnote: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Each window prices the positions we hold TODAY across that window, weighted by today's share count. A name bought last month still carries its full year here, so read these as how our holdings have done, not as what the fund earned.")
            Text("The returns route sends no benchmark, so nothing above is measured against the S&P 500. Today's index move is below, from a different route.")
        }
        .font(Type.footnote)
        .foregroundStyle(T.dim)
        .fixedSize(horizontal: false, vertical: true)
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }

    @ViewBuilder private var macroSection: some View {
        switch store.macro {
        case .absent:
            EmptyView()
        case .note(let sentence):
            Section {
                PerfQuietNote(sentence)
            } header: {
                SectionHeader(text: "Macro")
            }
        case .ready(let rows):
            Section {
                ForEach(rows) { row in
                    Row(title: row.label ?? row.id ?? "—",
                        meta: row.asOf == nil ? nil : "as of \(Fmt.day(row.asOf))") {
                        Text(PerformanceScreen.reading(row))
                            .font(Type.value)
                            .foregroundStyle(T.white)
                    }
                }
            } header: {
                SectionHeader(text: "Macro", trailing: "FRED")
            }
        }
    }

    @ViewBuilder private func marketSection(_ book: PerfBook) -> some View {
        switch store.indices {
        case .absent:
            EmptyView()
        case .note(let sentence):
            Section {
                PerfQuietNote(sentence)
            } header: {
                SectionHeader(text: "Market today")
            }
        case .ready(let rows):
            Section {
                ForEach(rows) { row in
                    Row(title: row.name ?? row.symbol ?? "—",
                        subtitle: row.name == "S&P 500" ? "The club's stated benchmark." : nil,
                        meta: row.moveSource ?? row.source) {
                        Text(Fmt.pct(row.changePercent))
                            .font(Type.value)
                            .foregroundStyle(T.delta(row.changePercent))
                    }
                }
                sideBySide(book, rows)
            } header: {
                SectionHeader(text: "Market today", trailing: "Americas")
            }
        }
    }

    /// Our day beside the index's day — placed next to each other and
    /// deliberately not subtracted. Both are same-day percentage moves,
    /// which makes them comparable in direction; they are not comparable
    /// to the basis point, because ours is the sheet's mark and the
    /// index is live, minutes apart. Printing "we beat by 11bp" would
    /// assert a precision neither source supports.
    @ViewBuilder private func sideBySide(_ book: PerfBook, _ rows: [PerfIndexRow]) -> some View {
        let ours = book.period("1D")?.pct
        let spx = rows.first { $0.name == "S&P 500" }?.changePercent
        if let ours, let spx {
            Text("Our equities are \(Fmt.pct(ours)) on the sheet's mark today; the S&P 500 is \(Fmt.pct(spx)) live. Different sources minutes apart, so read the direction rather than the margin.")
                .font(Type.footnote)
                .foregroundStyle(T.dim)
                .fixedSize(horizontal: false, vertical: true)
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T.card)
                .hairline()
        }
    }

    private var stamp: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            AsOfStamp(date: store.state.loadedAt)
            Text("Returns are cached by the server for fifteen minutes, so a figure can lag the last trade by that much.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The server has already decided the precision and sent a string;
    /// this only glues on the unit it declared. Parsing it back into a
    /// Double to reformat is how this screen would come to disagree with
    /// the dashboard about a number they both read from FRED.
    private static func reading(_ row: PerfMacroRow) -> String {
        guard let v = row.value, !v.isEmpty else { return "—" }
        switch row.unit {
        case "%": return v + "%"
        case "$": return "$" + v
        default:  return v
        }
    }
}

// MARK: Rows

/// One window: name on the left, return on the right, coloured by the
/// house rule that flat is muted rather than green.
///
/// StatLine carries the pair, and the line beneath it carries the two
/// things a percentage alone will not tell you — what it was worth in
/// dollars, and how much of the book the percentage actually covers. A
/// one-year figure standing on four of twelve names looks identical to
/// one standing on all twelve until somebody says otherwise.
private struct PerfPeriodRow: View {
    let period: PerfPeriod

    private var caption: String {
        if period.priced == 0 {
            return "No position carried a figure for this window."
        }
        let money = Fmt.moneyDelta(period.usd)
        return period.priced == period.total
            ? money
            : "\(money) · \(period.priced) of \(period.total) positions priced"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            StatLine(label: period.label.uppercased(),
                     value: Fmt.pct(period.pct),
                     tone: T.delta(period.pct))
            Text(caption)
                .font(Type.meta)
                .foregroundStyle(T.muted)
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
        // One VoiceOver stop for the window, not three.
        .accessibilityElement(children: .combine)
    }
}

/// A gate or a gap, stated once and quietly. Never COULD NOT LOAD, and
/// never phrased as something the market failed to do.
private struct PerfQuietNote: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Type.footnote)
            .foregroundStyle(T.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T.card)
            .hairline()
    }
}
