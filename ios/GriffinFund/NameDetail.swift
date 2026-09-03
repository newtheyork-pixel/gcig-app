import SwiftUI

// The rest of what we already know about a name.
//
// The ticker screen shows a quote, a chart, our position and the club's
// own record. The server has been serving six more reads for the Mac all
// along — SEC fundamentals, the three statements, Form 4 activity, a
// peer set, dividend history and FINRA short interest — and none of it
// has ever reached the phone. This file is that block, dropped in as one
// view.
//
// Two shaping rules run through everything below.
//
// The first is the app's: anything with columns stays on the desk. The
// Mac's FA prints thirty statement lines across five period columns and
// PEER prints seven metrics across seven names, and both are correct
// THERE. Here every one of them collapses to StatLines and short lists,
// which means choosing a handful of figures and dropping the rest rather
// than shrinking a grid until it is unreadable. Each decodable says what
// it left behind and why.
//
// The second is about units, and it is the bug this codebase has already
// paid for: a fractional dividendYield went through a percent formatter
// and printed a 2.34% yield as 0.02%. Four of these six payloads mix the
// two conventions — sometimes inside one response — so nothing here
// reaches Fmt.pct directly. It goes through NDUnits, where the call site
// has to name which convention the server used.

// MARK: Units
//
// Fmt.pct takes percent POINTS. Half the server's percentages are
// fractions. Naming the convention at the call site is the whole point:
// `NDUnits.pct(fraction: d.yield)` cannot be misread the way
// `Fmt.pct(d.yield)` was.
private enum NDUnits {
    /// 0.0234 → "2.34%". The NASDAQ dividend yield, the peer snapshot's
    /// day change and dividend yield, the derived margins in GF, and the
    /// Reg SHO daily short share all arrive this way.
    static func pct(fraction v: Double?, decimals: Int = 2, signed: Bool = false) -> String {
        Fmt.pct(v.map { $0 * 100 }, decimals: decimals, signed: signed)
    }

    /// -7.97 → "-7.97%". FINRA's `changePercent` is already in points;
    /// rescaling it would understate a settlement move by a hundred.
    /// (client/src/terminal/functions/ShortInterest.jsx:26 says the same.)
    static func pct(points v: Double?, decimals: Int = 2, signed: Bool = true) -> String {
        Fmt.pct(v, decimals: decimals, signed: signed)
    }
}

// MARK: Decodables
//
// Every one of these was written from the handler, not from the Mac's
// JSX, and every field is optional. A wrong key decodes to nil in
// silence and renders a dash as fact, so the citations above each type
// are load-bearing: they are how the next person checks these without
// guessing.

/// GET /api/terminal/fundamentals/:ticker
///
/// Handler: server/src/routes/terminal.js:198. The body is
/// services/secFundamentals.js `shape()` (:313-322) wrapping rows from
/// `extractFundamentals` (:188-216), so the keys are exactly ticker,
/// cik, name, freq, rows[] and — only when rows is empty — `note`.
///
/// Rows run OLDEST FIRST (:202-203, sorted ascending by period end), so
/// the latest year is `rows.last`, not `rows.first`. Getting that
/// backwards would print a five-year-old income statement as current.
///
/// Dropped: `cik` (an EDGAR key with nothing to say to a reader) and
/// `t` (the period end as epoch milliseconds — `period` already labels
/// the year, and a second date field only invites the two to disagree).
struct NDFundamentals: Decodable {
    struct Row: Decodable {
        /// "FY2025" annually, "2025 Q3" quarterly (secFundamentals.js:128).
        let period: String?
        let revenue: Double?
        let grossProfit: Double?
        let operatingIncome: Double?
        let netIncome: Double?
        let cfo: Double?
        let epsDiluted: Double?
        /// Derived server-side as x/revenue (:212-214): FRACTIONS.
        let grossMargin: Double?
        let operatingMargin: Double?
        let netMargin: Double?
    }
    let name: String?
    let freq: String?
    let rows: [Row]?
    /// Present only on an empty result, and it is the interesting half:
    /// a 40-F filer tags no us-gaap XBRL at all, which is a fact about
    /// the filer and not a hole in our extractor. Printed verbatim.
    let note: String?
}

/// GET /api/terminal/statements/:ticker
///
/// Handler: server/src/routes/terminal.js:228, body built at
/// services/secFundamentals.js:532-542. Three arrays of lines, each
/// line's `values` positionally aligned to the shared `periods` axis,
/// which again runs oldest first (:503-504).
///
/// Dropped: everything about presentation. The Mac's FA is the whole
/// three-statement grid and that is a table; here we read a handful of
/// keys out of it at one period. `periods[].fy` and `.fp` are dropped
/// because the server already composes them into `label`, and two
/// sources for one string is how they drift apart.
struct NDStatements: Decodable {
    struct Period: Decodable {
        let period: String?
        /// "FY 2025" / "Q3 2025", composed server-side at :509.
        let label: String?
    }
    struct Line: Decodable {
        /// The stable handle — `revenue`, `totalAssets`, `capex`. The
        /// label is prose and the key is the contract, so lookups here
        /// go through the key.
        let key: String?
        let label: String?
        let unit: String?
        /// Nulls are real: a line the filer did not report in that
        /// period is null, not zero. [Double?] preserves that; [Double]
        /// would fail the whole decode on the first missing year.
        let values: [Double?]?
    }
    let periods: [Period]?
    let balance: [Line]?
    let cashflow: [Line]?
    // `income` is served and deliberately not decoded. The same income
    // statement arrives from /fundamentals above and is already on
    // screen; decoding it here would leave a second copy of revenue one
    // scroll below the first, waiting for the two to disagree.
}

/// GET /api/terminal/insiders/:ticker
///
/// Handler: server/src/routes/terminal.js:251, payload assembled at
/// services/insiderTx.js:228 as { ticker, transactions, _source }.
/// Transaction rows are normalizeFinnhub (:101-111) or, when Finnhub
/// has nothing, parseForm4Xml (:73-83) — the same nine keys either way,
/// except that `role` is always null on the Finnhub path (:104).
///
/// `shares` is already absolute on the Finnhub path (:97), so the
/// direction lives in isBuy/isSell and never in the sign.
struct NDInsiders: Decodable {
    struct Tx: Decodable {
        let date: String?
        let name: String?
        let role: String?
        /// Form 4 code. P and S are open-market purchase and sale;
        /// M, A, F, G and the rest are exercises, grants, tax
        /// withholding and gifts, which are not somebody buying.
        let code: String?
        let isBuy: Bool?
        let isSell: Bool?
        let shares: Double?
        let price: Double?
        let value: Double?
    }
    let transactions: [Tx]?
    /// "finnhub", "sec", or null. Null with an empty list is ambiguous
    /// by construction (insiderTx.js:228 returns the same shape whether
    /// the tape was quiet or both vendors failed), which is why the
    /// empty rendering below refuses to claim the tape was quiet.
    let source: String?

    enum CodingKeys: String, CodingKey {
        case transactions
        case source = "_source"
    }
}

/// GET /api/terminal/peers/:ticker
///
/// Handler: server/src/routes/terminal.js:1287. Rows are built at
/// :1315-1329 and the envelope at :1336-1339.
///
/// `changePct` and `dividendYield` are FRACTIONS — services/
/// marketData.js:533 and :541 divide both down before they leave the
/// snapshot.
///
/// Dropped: forwardPE, dividendYield and beta. Seven metrics across
/// seven names is the Mac's PEER grid; on a phone the row has space for
/// who it is, how big it is and what it trades at, and a fourth column
/// would win nothing but a wrap.
struct NDPeers: Decodable {
    struct Row: Decodable {
        let ticker: String?
        let isFocus: Bool?
        /// "filing", "peer" or "sector" — WHY this name is on the list.
        /// The server volunteers it because a sub-industry cohort and a
        /// competitor named in the 10-K answer different questions, and
        /// a reader can only tell which one they got if the row says so.
        let source: String?
        let name: String?
        let price: Double?
        let changePct: Double?
        let marketCap: Double?
        let trailingPE: Double?
    }
    struct Labels: Decodable {
        let filing: String?
        let peer: String?
        let sector: String?
    }
    let count: Int?
    let rows: [Row]?
    let sourceLabels: Labels?
    /// Non-null only when a judgement row is present (peerSet.js:236).
    let caveat: String?
}

/// GET /api/dividends/:ticker
///
/// Handler: server/src/routes/dividends.js:19 over
/// services/dividends.js, payload literal at :213-222.
///
/// `yield` is a FRACTION: parsePct divides by 100 on the way out
/// (dividends.js:63). This is the exact key that once printed a 2.34%
/// yield as 0.02%.
///
/// Dropped: recordDate and declared. Four dates on one payment is a
/// table; the two a member acts on are when it goes ex and when it pays.
struct NDDividends: Decodable {
    struct Row: Decodable {
        let exDate: String?
        let payDate: String?
        let amount: Double?
    }
    let yield: Double?
    let annualized: Double?
    let exDate: String?
    let rows: [Row]?
    /// The upstream's own sentence, and the reason this section can be
    /// honest. NASDAQ serves dividend history for NASDAQ-listed symbols
    /// only, so a NYSE name comes back empty with "Dividend History for
    /// Non-Nasdaq symbols is not available" (dividends.js:12-16). That
    /// is a licensing wall, not a company that pays nothing, and the two
    /// must never render alike.
    let note: String?
    let source: String?
}

/// GET /api/short-interest/:ticker
///
/// Handler: server/src/routes/shortInterest.js:11 over
/// services/shortInterest.js, payload at :284-307. Two independent
/// feeds that fail independently, which is why there are two
/// `available` flags rather than one.
///
/// UNITS DIFFER INSIDE THIS ONE PAYLOAD. `settlements[].changePct` is
/// FINRA's changePercent and is in percent points (:89), while
/// `dailyShortPct.pct` is a fraction (:268-270). Both go through
/// NDUnits, each naming its own convention.
///
/// Dropped: shortVol and totalVol. The ratio of the two is the read;
/// the raw volumes are a column pair.
struct NDShortInterest: Decodable {
    struct Settlement: Decodable {
        let date: String?
        let shares: Double?
        let prior: Double?
        let changePct: Double?
        let daysToCover: Double?
        let adv: Double?
    }
    struct Daily: Decodable {
        let date: String?
        let pct: Double?
    }
    struct Sources: Decodable {
        let consolidated: String?
        let daily: String?
    }
    let settlements: [Settlement]?
    /// False means FINRA refused this deployment, not that nobody is
    /// short. Rendering those alike would be reporting our outage as a
    /// fact about the company.
    let consolidatedAvailable: Bool?
    let dailyShortPct: Daily?
    let dailyAvailable: Bool?
    let sources: Sources?
}

// MARK: Store

/// Six reads, each fired independently and each silent when it fails.
///
/// These are context around a name, not the name itself. The quote and
/// the position are already on screen above; a peer set that could not
/// be built must not put COULD NOT LOAD over them. So the failure
/// vocabulary here is deliberately narrow: a section either has data, or
/// has a SENTENCE worth printing, or is simply not drawn.
///
/// The sentence cases are the ones that matter, and there are three.
/// A 403, because every one of these routes is Analyst-and-above and
/// JuniorAnalyst is the default role for a Google self-signup, so a
/// member seeing nothing here is the ordinary case rather than an edge
/// one. A 404 from the SEC services, because those carry the filer's own
/// reason — a fund has no XBRL, a 40-F files statements as exhibits —
/// and that is a better answer than blankness. And an empty result the
/// upstream explained, like NASDAQ declining a NYSE symbol.
@MainActor
final class NameDetailStore: ObservableObject {

    /// One section's outcome. `note` is a sentence to print INSTEAD of
    /// data; both nil means the section says nothing at all and is not
    /// drawn.
    struct Read<T> {
        // Explicit `= nil` rather than leaning on the implicit default
        // for optional properties: this type is constructed empty
        // (`Read()`) in every failure path, and the memberwise
        // initialiser has to accept that with no arguments.
        var value: T? = nil
        var note: String? = nil
    }

    /// Set by whichever read 403s first. One sentence for the whole
    /// block, not six identical ones: the routes share a single gate
    /// (terminal.js:65, dividends.js:16, shortInterest.js:9), so six
    /// copies would be six statements of the same fact.
    @Published private(set) var gate: String?

    @Published private(set) var fundamentals = Read<NDFundamentals>()
    @Published private(set) var statements = Read<NDStatements>()
    @Published private(set) var insiders = Read<NDInsiders>()
    @Published private(set) var peers = Read<NDPeers>()
    @Published private(set) var dividends = Read<NDDividends>()
    @Published private(set) var shorts = Read<NDShortInterest>()

    /// When we last asked for the peer set. The peer rows carry a live
    /// price and a day change off a 15-minute server cache, and this
    /// screen has no tick and no stale strip of its own — so the section
    /// stamps when WE asked rather than implying the number is current.
    @Published private(set) var peersAt: Date?

    /// True once all six have finished, so the view can tell "still
    /// arriving" from "we asked, and there is nothing here". Without it
    /// a member watching an empty screen cannot tell which.
    @Published private(set) var settled = false

    private static let gateSentence =
        "Fundamentals, statements, insiders, peers, dividends and short interest need Analyst access."

    func load(_ ticker: String) async {
        settled = false
        // Six independent reads, concurrent: the wait should be the
        // slowest of them and not the sum. Insiders alone can take a
        // Finnhub round trip plus an EDGAR fallback.
        async let a: Void = loadFundamentals(ticker)
        async let b: Void = loadStatements(ticker)
        async let c: Void = loadInsiders(ticker)
        async let d: Void = loadPeers(ticker)
        async let e: Void = loadDividends(ticker)
        async let f: Void = loadShorts(ticker)
        _ = await (a, b, c, d, e, f)
        settled = true
    }

    /// The only thing here worth refetching on a foreground. Filings,
    /// Form 4s and bi-monthly settlements do not move while a phone is
    /// in a pocket; a peer's day change does, and it is the one figure
    /// in this block that could quietly become a lie.
    func refreshPeers(_ ticker: String) async {
        await loadPeers(ticker)
    }

    // Each loader catches in the same order, and the order is the rule:
    // cancelled first, then the gate, then a 404 the server explained,
    // then silence.

    private func loadFundamentals(_ t: String) async {
        do {
            let p = try await API.shared.get("/terminal/fundamentals/\(t)",
                                             as: NDFundamentals.self)
            fundamentals = Read(value: p, note: p.note)
        } catch APIError.cancelled {
            // Leaving the screen mid-load is not a failure.
            return
        } catch APIError.forbidden {
            gate = Self.gateSentence
        } catch APIError.server(let code, let msg) where code == 404 {
            // "No XBRL financial data on file — this is a fund or trust,
            // not an operating company" beats an absent section.
            fundamentals = Read(value: nil, note: msg)
        } catch {
            fundamentals = Read()
        }
    }

    private func loadStatements(_ t: String) async {
        do {
            statements = Read(value: try await API.shared.get("/terminal/statements/\(t)",
                                                              as: NDStatements.self))
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden {
            gate = Self.gateSentence
        } catch {
            // Deliberately silent, including on 404: the fundamentals
            // section above shares this source and has already said why
            // there is nothing, and saying it twice reads as two faults.
            statements = Read()
        }
    }

    private func loadInsiders(_ t: String) async {
        do {
            insiders = Read(value: try await API.shared.get("/terminal/insiders/\(t)",
                                                            as: NDInsiders.self))
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden {
            gate = Self.gateSentence
        } catch {
            insiders = Read()
        }
    }

    private func loadPeers(_ t: String) async {
        do {
            peers = Read(value: try await API.shared.get("/terminal/peers/\(t)",
                                                         as: NDPeers.self))
            peersAt = Date()
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden {
            gate = Self.gateSentence
        } catch {
            // A 404 here is the server's "No data for this ticker"
            // (terminal.js:1332), which is about the vendor's coverage
            // rather than about the company. Not worth a sentence.
            peers = Read()
        }
    }

    private func loadDividends(_ t: String) async {
        do {
            let p = try await API.shared.get("/dividends/\(t)", as: NDDividends.self)
            // The note only earns the screen when there is nothing else
            // to show. A payer whose header also carries the upstream's
            // boilerplate should show the payments, not the boilerplate.
            let empty = (p.rows ?? []).isEmpty && p.yield == nil && p.annualized == nil
            dividends = Read(value: p, note: empty ? p.note : nil)
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden {
            gate = Self.gateSentence
        } catch {
            dividends = Read()
        }
    }

    private func loadShorts(_ t: String) async {
        do {
            shorts = Read(value: try await API.shared.get("/short-interest/\(t)",
                                                          as: NDShortInterest.self))
        } catch APIError.cancelled {
            return
        } catch APIError.forbidden {
            gate = Self.gateSentence
        } catch {
            shorts = Read()
        }
    }
}

// MARK: The block

/// The deep-dive half of a ticker screen: everything the server knows
/// about a name beyond its quote, its chart and our position.
///
/// Drop it into the ticker screen's LazyVStack below the club record. It
/// owns its own loads, so it costs the host screen nothing but a line.
struct NameDetailSections: View {
    let ticker: String

    @StateObject private var store = NameDetailStore()

    private var symbol: String { ticker.uppercased() }

    var body: some View {
        // A VStack and deliberately NOT a Group. SwiftUI applies a
        // modifier on a Group to each of its children, so the .task
        // below would fire once per section — seven loads of six
        // endpoints on every open of a name. The stack applies it once.
        VStack(spacing: 0) {
            if let gate = store.gate {
                gateSection(gate)
            } else {
                fundamentalsSection
                statementsSection
                peersSection
                insidersSection
                dividendsSection
                shortSection
                nothingSection
            }
        }
        // id: the ticker, so pushing a peer from this very block reloads
        // against the new name instead of showing the old one's numbers
        // under the new one's header.
        .task(id: symbol) { await store.load(symbol) }
        .refreshOnForeground(after: 300) { await store.refreshPeers(symbol) }
    }

    // MARK: the gate
    //
    // One quiet sentence, under a header so it does not float loose, and
    // with no RETRY: there is nothing to retry. A member below Analyst
    // sees this every time they open a name, so it has to read as an
    // answer about their access rather than as six broken panels.
    private func gateSection(_ text: String) -> some View {
        Section {
            quiet(text)
        } header: {
            SectionHeader(text: "The rest of the record")
        }
    }

    // MARK: fundamentals

    @ViewBuilder private var fundamentalsSection: some View {
        if let note = store.fundamentals.note {
            Section {
                quiet(note)
            } header: {
                SectionHeader(text: "Fundamentals")
            }
        } else if let latest = (store.fundamentals.value?.rows ?? []).last {
            Section {
                card {
                    StatLine(label: "REVENUE", value: Fmt.compact(latest.revenue))
                    StatLine(label: "GROSS PROFIT", value: Fmt.compact(latest.grossProfit))
                    StatLine(label: "OPERATING INCOME", value: Fmt.compact(latest.operatingIncome))
                    StatLine(label: "NET INCOME", value: Fmt.compact(latest.netIncome))
                    StatLine(label: "OPERATING CASH FLOW", value: Fmt.compact(latest.cfo))
                    StatLine(label: "DILUTED EPS", value: Fmt.money(latest.epsDiluted, decimals: 2))
                    StatLine(label: "GROSS MARGIN",
                             value: NDUnits.pct(fraction: latest.grossMargin))
                    StatLine(label: "OPERATING MARGIN",
                             value: NDUnits.pct(fraction: latest.operatingMargin))
                    StatLine(label: "NET MARGIN",
                             value: NDUnits.pct(fraction: latest.netMargin))
                }
                priorYears
                footnote("Dollars as filed, from SEC XBRL company facts. A blank line is a figure the filer does not tag, not a zero.")
            } header: {
                SectionHeader(text: "Fundamentals", trailing: latest.period ?? "—")
            }
        }
    }

    /// The three years before the latest, newest first. A single year of
    /// revenue says almost nothing; the direction is the whole read, and
    /// three short rows carry it without becoming a grid.
    ///
    /// Growth is computed here rather than read, because the server does
    /// not send it — and it is suppressed when the older year is zero or
    /// missing, since a percentage against nothing is not a percentage.
    @ViewBuilder private var priorYears: some View {
        let rows = store.fundamentals.value?.rows ?? []
        if rows.count > 1 {
            let recent = Array(rows.suffix(4).reversed())
            ForEach(Array(recent.enumerated()), id: \.offset) { idx, r in
                let older = idx + 1 < recent.count ? recent[idx + 1].revenue : nil
                let growth = growthPct(new: r.revenue, old: older)
                Row(title: r.period ?? "—",
                    subtitle: nil,
                    meta: "NET MARGIN \(NDUnits.pct(fraction: r.netMargin))") {
                    ValueStack(value: Fmt.compact(r.revenue),
                               delta: growth,
                               deltaText: growth == nil ? nil : Fmt.pct(growth))
                }
            }
        }
    }

    private func growthPct(new: Double?, old: Double?) -> Double? {
        guard let new, let old, old != 0 else { return nil }
        return (new / old - 1) * 100
    }

    // MARK: statements

    /// The balance sheet and the cash flow at the same period the block
    /// above reads, and deliberately not the income statement: that is
    /// already stated above from the same source, and printing revenue
    /// twice on one screen reads as a screen that lost track of itself.
    ///
    /// Every line is pinned to ONE period — the newest on the shared
    /// axis. Taking each line's own last non-null value instead would
    /// silently mix a 2025 balance sheet with a 2023 cash flow under a
    /// single heading, which is the sort of quiet composition error that
    /// survives review.
    @ViewBuilder private var statementsSection: some View {
        if let s = store.statements.value,
           let periods = s.periods,
           let idx = latestStatementIndex,
           idx < periods.count {
            let lines = statementLines(s, at: idx)
            if !lines.isEmpty {
                Section {
                    card {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            StatLine(label: line.label, value: line.value)
                        }
                    }
                    footnote("Balance sheet and cash flow from the same filings as the fundamentals above. The full line-by-line statements are a terminal screen.")
                } header: {
                    SectionHeader(text: "Statements",
                                  trailing: periods[idx].label ?? periods[idx].period ?? "—")
                }
            }
        }
    }

    /// The newest period on the shared axis that any of these lines
    /// actually filled — not simply the newest period.
    ///
    /// The axis is the union of all three statements (secFundamentals.js
    /// :494-502), so a company whose latest income line is filed and
    /// whose balance sheet is not has a trailing period where every row
    /// below is null. Pinning blindly to `last` would hide the whole
    /// section for a name whose statements are perfectly readable one
    /// period back.
    private var latestStatementIndex: Int? {
        guard let s = store.statements.value, let periods = s.periods else { return nil }
        for i in periods.indices.reversed() where !statementLines(s, at: i).isEmpty {
            return i
        }
        return nil
    }

    /// The keys worth a phone, in print order. Anything the filer did
    /// not report at this period is absent rather than dashed: a bank
    /// files no inventory and Coca-Cola no R&D, and an empty row makes a
    /// correct statement look broken.
    private func statementLines(_ s: NDStatements, at index: Int) -> [(label: String, value: String)] {
        // Our labels, not the server's, because the server's are written
        // for a column head ("Cash & Equivalents") and these sit in a
        // StatLine's mono label column. The KEY is the contract either
        // way, and `key` is what the lookup matches on.
        let wanted: [(String, String)] = [
            ("cash", "CASH & EQUIVALENTS"),
            ("totalAssets", "TOTAL ASSETS"),
            ("longTermDebt", "LONG-TERM DEBT"),
            ("totalLiabilities", "TOTAL LIABILITIES"),
            ("equity", "TOTAL EQUITY"),
            ("cfo", "OPERATING CASH FLOW"),
            ("capex", "CAPITAL EXPENDITURE"),
            ("dividends", "DIVIDENDS PAID"),
            ("sbc", "STOCK-BASED COMP"),
            ("dilutedShares", "DILUTED SHARES"),
        ]
        let all = (s.balance ?? []) + (s.cashflow ?? [])
        var out: [(label: String, value: String)] = []
        for (key, label) in wanted {
            guard let line = all.first(where: { $0.key == key }),
                  let values = line.values,
                  index < values.count,
                  let v = values[index] else { continue }
            // Compact for everything, dollars and share counts alike: a
            // phone row has no space for 1,483,000,000, and the two are
            // told apart by the label rather than by the format.
            out.append((label, Fmt.compact(v)))
        }
        return out
    }

    /// Whether the statements section will draw anything, asked without
    /// drawing it. Both the section and the "nothing on file" line need
    /// the answer, and computing it twice by different routes is how the
    /// two come to disagree.
    private var statementLineCount: Int {
        guard let s = store.statements.value, let idx = latestStatementIndex else { return 0 }
        return statementLines(s, at: idx).count
    }

    // MARK: peers

    /// Tappable, because a comparable you cannot open is a list of
    /// strings. The focus row is dropped — it is the name already on
    /// screen, and a row that navigates to where you are is a dead end.
    @ViewBuilder private var peersSection: some View {
        let rows = (store.peers.value?.rows ?? []).filter { $0.isFocus != true }
        if !rows.isEmpty {
            Section {
                ForEach(Array(rows.prefix(6).enumerated()), id: \.offset) { _, p in
                    NavigationLink(value: TickerScreen(symbol: p.ticker ?? "")) {
                        peerRow(p)
                    }
                    .buttonStyle(.plain)
                    .disabled((p.ticker ?? "").isEmpty)
                }
                peerLegend
            } header: {
                SectionHeader(text: "Comparables",
                              trailing: store.peersAt == nil ? nil : "AS OF \(Fmt.clock(store.peersAt))")
            }
        }
    }

    private func peerRow(_ p: NDPeers.Row) -> some View {
        TickerRow(ticker: p.ticker ?? "—",
                  name: p.name,
                  meta: "\(peerSourceShort(p.source)) · \(Fmt.compact(p.marketCap)) · \(Fmt.multiple(p.trailingPE))") {
            ValueStack(value: Fmt.money(p.price, decimals: 2),
                       delta: p.changePct,
                       deltaText: NDUnits.pct(fraction: p.changePct, signed: true))
        }
        .contentShape(Rectangle())
    }

    /// Two words in the row, the server's own full sentence in the
    /// legend below it. The full labels run to "same GICS sub-industry
    /// (classification, not a competitive view)" — true, necessary, and
    /// six copies of it would be most of the section.
    private func peerSourceShort(_ source: String?) -> String {
        switch source {
        case "filing": return "10-K"
        case "peer":   return "our read"
        case "sector": return "sub-industry"
        default:       return "—"
        }
    }

    /// Why each row is on the list, in the server's words, plus its
    /// caveat when it sent one. A comparable set with no stated basis is
    /// an opinion wearing a vendor's clothes.
    @ViewBuilder private var peerLegend: some View {
        let labels = store.peers.value?.sourceLabels
        let lines = [labels?.filing.map { "10-K — \($0)" },
                     labels?.peer.map { "Our read — \($0)" },
                     labels?.sector.map { "Sub-industry — \($0)" },
                     store.peers.value?.caveat].compactMap { $0 }
        if !lines.isEmpty {
            footnote(lines.joined(separator: "\n"))
        }
    }

    // MARK: insiders

    @ViewBuilder private var insidersSection: some View {
        if let i = store.insiders.value {
            let txs = i.transactions ?? []
            Section {
                if txs.isEmpty {
                    // Not "no insider activity". The payload is the same
                    // shape whether the tape was quiet or both vendors
                    // failed (insiderTx.js:228), so this says what we
                    // know — that nothing came back — and stops there.
                    quiet("No Form 4 activity came back for this name.")
                } else {
                    ForEach(Array(txs.prefix(8).enumerated()), id: \.offset) { _, t in
                        insiderRow(t)
                    }
                    footnote("Form 4 filings over roughly the last two years. Only codes P and S are open-market purchases and sales; a grant, an option exercise or shares withheld for tax is not somebody buying.")
                }
            } header: {
                SectionHeader(text: "Insiders",
                              trailing: txs.isEmpty ? nil : "\(txs.count)")
            }
        }
    }

    private func insiderRow(_ t: NDInsiders.Tx) -> some View {
        Row(title: t.name ?? "Unknown",
            subtitle: t.role,
            meta: "\(Fmt.day(t.date)) · \(insiderAction(t))",
            // The strip is a fact about the row, so only a real purchase
            // or sale gets one. Colouring an option exercise green would
            // claim a conviction buy that nobody made.
            strip: t.isBuy == true ? T.positive : (t.isSell == true ? T.negative : nil)) {
            ValueStack(value: Fmt.money(t.value),
                       deltaText: t.shares == nil ? nil : "\(Fmt.shares(t.shares)) sh")
        }
    }

    private func insiderAction(_ t: NDInsiders.Tx) -> String {
        if t.isBuy == true { return "BOUGHT" }
        if t.isSell == true { return "SOLD" }
        guard let c = t.code, !c.isEmpty else { return "FORM 4" }
        return "CODE \(c)"
    }

    // MARK: dividends

    @ViewBuilder private var dividendsSection: some View {
        if let note = store.dividends.note {
            Section {
                // The upstream's own sentence, verbatim. NASDAQ declining
                // a NYSE symbol is a licensing wall, and rendering it as
                // an empty payment history would tell a member that
                // Johnson & Johnson pays no dividend.
                quiet(note)
            } header: {
                SectionHeader(text: "Dividends")
            }
        } else if let d = store.dividends.value, hasDividendContent(d) {
            Section {
                card {
                    StatLine(label: "YIELD", value: NDUnits.pct(fraction: d.yield))
                    StatLine(label: "ANNUALISED RATE", value: dividendAmount(d.annualized))
                    StatLine(label: "EX-DIVIDEND", value: Fmt.day(d.exDate))
                }
                ForEach(Array((d.rows ?? []).prefix(4).enumerated()), id: \.offset) { _, r in
                    Row(title: dividendAmount(r.amount),
                        subtitle: nil,
                        meta: "EX \(Fmt.day(r.exDate)) · PAID \(Fmt.day(r.payDate))")
                }
                if let s = d.source { footnote("Source: \(s). Nasdaq-listed symbols only.") }
            } header: {
                SectionHeader(text: "Dividends")
            }
        }
    }

    private func hasDividendContent(_ d: NDDividends) -> Bool {
        d.yield != nil || d.annualized != nil || !(d.rows ?? []).isEmpty
    }

    /// Per-share dividends are the one figure on this screen where two
    /// decimals lose real precision: a $0.185 payment rounds to $0.19,
    /// which is a number the company never declared. Four decimals only
    /// where the extra two say something.
    private func dividendAmount(_ v: Double?) -> String {
        guard let v else { return "—" }
        let cents = v * 100
        let exact = abs(cents.rounded() - cents) < 0.0001
        return Fmt.money(v, decimals: exact ? 2 : 4)
    }

    // MARK: short interest

    @ViewBuilder private var shortSection: some View {
        if let s = store.shorts.value, shortHasSomethingToSay(s) {
            Section {
                if s.consolidatedAvailable == false {
                    // Our outage, or FINRA refusing this deployment's IP
                    // — either way a fact about the feed. The one thing
                    // this must never read as is a company nobody shorts.
                    quiet("FINRA's settlement feed did not answer, so the position is unknown rather than nil.")
                } else if let latest = (s.settlements ?? []).first {
                    card {
                        StatLine(label: "SHARES SHORT", value: Fmt.compact(latest.shares))
                        StatLine(label: "CHANGE",
                                 value: NDUnits.pct(points: latest.changePct),
                                 // Rising short interest is not good news
                                 // for a holder, so the sign is inverted
                                 // against the usual green-is-up rule.
                                 tone: T.delta(latest.changePct.map { -$0 }))
                        StatLine(label: "DAYS TO COVER", value: Fmt.multiple(latest.daysToCover))
                        StatLine(label: "AVG DAILY VOLUME", value: Fmt.compact(latest.adv))
                        StatLine(label: "SETTLEMENT", value: Fmt.day(latest.date))
                    }
                    priorSettlements(s)
                }
                dailyShortLine(s)
                shortFootnote(s)
            } header: {
                SectionHeader(text: "Short interest")
            }
        }
    }

    private func shortHasSomethingToSay(_ s: NDShortInterest) -> Bool {
        !(s.settlements ?? []).isEmpty
            || s.dailyShortPct != nil
            || s.consolidatedAvailable == false
            || s.dailyAvailable == false
    }

    /// Three prints back. Short interest is a position that moves twice
    /// a month, so one settlement is a level and four is a direction.
    @ViewBuilder private func priorSettlements(_ s: NDShortInterest) -> some View {
        let rest = Array((s.settlements ?? []).dropFirst().prefix(3))
        ForEach(Array(rest.enumerated()), id: \.offset) { _, x in
            Row(title: Fmt.day(x.date),
                subtitle: nil,
                meta: "DAYS TO COVER \(Fmt.multiple(x.daysToCover))") {
                ValueStack(value: Fmt.compact(x.shares),
                           delta: x.changePct.map { -$0 },
                           deltaText: NDUnits.pct(points: x.changePct))
            }
        }
    }

    /// A different question from the one above, and labelled as one:
    /// the settlement file says how big the position IS, this says what
    /// share of one day's off-exchange prints were short sales. Flow,
    /// not position.
    @ViewBuilder private func dailyShortLine(_ s: NDShortInterest) -> some View {
        if s.dailyAvailable == false {
            quiet("FINRA's daily short-volume file did not answer for that day.")
        } else if let d = s.dailyShortPct {
            card {
                StatLine(label: "OFF-EXCHANGE SHORT VOLUME",
                         value: NDUnits.pct(fraction: d.pct, decimals: 1))
                StatLine(label: "TRADING DAY", value: Fmt.day(d.date))
            }
        }
    }

    @ViewBuilder private func shortFootnote(_ s: NDShortInterest) -> some View {
        let lines = [s.sources?.consolidated, s.sources?.daily].compactMap { $0 }
        if !lines.isEmpty {
            footnote(lines.joined(separator: "\n"))
        }
    }

    // MARK: nothing at all

    /// Said once, and only once everything has finished. A member
    /// looking at a screen that simply stops cannot tell whether the
    /// rest is still coming; silence and emptiness must not look alike
    /// here any more than anywhere else in this app.
    @ViewBuilder private var nothingSection: some View {
        if store.settled && !showsAnything {
            Section {
                quiet("Nothing further on file for \(symbol).")
            } header: {
                SectionHeader(text: "The rest of the record")
            }
        }
    }

    /// Asked against what each section will actually DRAW, not against
    /// whether its request came back. A payload that decoded fine and
    /// carries nothing renders nothing, and a member staring at the gap
    /// deserves the sentence just as much as one whose requests failed.
    private var showsAnything: Bool {
        if store.fundamentals.note != nil { return true }
        if !((store.fundamentals.value?.rows ?? []).isEmpty) { return true }
        if statementLineCount > 0 { return true }
        // The insiders section always has something to say once its read
        // lands — either the transactions or the sentence saying none
        // came back.
        if store.insiders.value != nil { return true }
        if (store.peers.value?.rows ?? []).contains(where: { $0.isFocus != true }) { return true }
        if store.dividends.note != nil { return true }
        if let d = store.dividends.value, hasDividendContent(d) { return true }
        if let s = store.shorts.value, shortHasSomethingToSay(s) { return true }
        return false
    }

    // MARK: shared pieces

    /// The StatLine block every section leans on, so the padding and the
    /// hairline are stated once rather than nine times.
    private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(spacing: 0) { content() }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.s)
            .frame(maxWidth: .infinity)
            .background(T.card)
            .hairline()
    }

    /// A sentence, in prose, at footnote size. Used for every "we cannot
    /// show you this and here is why" in the file — never ErrorState,
    /// which names a failure and offers a retry, and neither of those is
    /// true of a permission gate or a filer who tags no XBRL.
    private func quiet(_ text: String) -> some View {
        Text(text)
            .font(Type.footnote)
            .foregroundStyle(T.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Provenance, in the mono voice: where a number came from is a
    /// system fact, and the muted tone is the one that clears contrast
    /// on all three grounds.
    private func footnote(_ text: String) -> some View {
        Text(text)
            .font(Type.meta)
            .foregroundStyle(T.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.s)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
