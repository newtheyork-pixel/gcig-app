import SwiftUI

// ALRT on the phone. The whole point of this screen is a distinction the
// server went to some trouble to make and that a careless client would
// flatten in one line of Swift.
//
// The payload carries three different facts, not two:
//
//   breached / action   something crossed a line the charter draws, and a
//                       member has to do something about it.
//   unchecked           a rule could not be evaluated. That is OUR outage,
//                       not a finding about the book, and it must never
//                       render as quiet.
//   clear               every rule ran and the book is inside all of them.
//                       Genuinely good news, and it should read that way.
//
// services/alerts.js says it plainly: "Silence means checked and clear,
// never unchecked ... a data outage cannot look like compliance, which is
// the failure mode that makes a compliance screen worse than no compliance
// screen." A phone that shows an empty list because the sheet failed to
// load has done precisely that.

// MARK: Decodables
//
// Written from server/src/routes/alerts.js and the service it delegates to.
// Every field optional, because a renamed key decodes to nil in silence and
// a dash is the only honest rendering of a fact we did not receive.

/// routes/alerts.js:59 — `res.json({ alerts, summary: summarize(alerts), policy: IPS })`.
struct AlertsPayload: Decodable {
    let alerts: [AlertsItem]?
    let summary: AlertsSummary?
    let policy: AlertsPolicy?
}

/// The alert objects pushed in services/alerts.js:68-77 (drawdown review),
/// :103-114 (concentration), :127-134 and :138-145 (cash floor, equity
/// band), :162-172 (summer picks), :183-190 (earnings) and :199-201
/// (`unchecked()`).
///
/// Note what is NOT uniform across those six shapes. `ticker` is absent on
/// the fund-level rules and on every unchecked row. `value` and `threshold`
/// are absent on unchecked rows entirely — and, far more dangerous, `value`
/// carries a DIFFERENT UNIT per rule: a percentage for the drawdown,
/// concentration, cash and equity rules, a COUNT of names for summer picks,
/// and a number of DAYS for earnings. That is why this screen never formats
/// `value` itself. The server has already written the number into `title`
/// in the unit it belongs to; rendering its sentence is both less code and
/// the only way the figure cannot be mislabelled.
struct AlertsItem: Decodable {
    let id: String?
    /// "breach" | "action" | "watch" | "unchecked" (services/alerts.js:44
    /// defines the severity order, and `sort` at :204 has already applied it).
    let kind: String?
    let ticker: String?
    let title: String?
    let detail: String?
    let value: Double?
    let threshold: Double?
    /// "ips.md — Target Asset Allocation Policy", "earnings calendar".
    let source: String?
}

/// services/alerts.js:213-222 — `summarize()`.
///
/// `clear` is the field to be careful with. It is
/// `alerts.every(a => a.kind === 'unchecked') || alerts.length === 0`, so a
/// book where NOTHING could be evaluated reports `clear: true` with
/// `unchecked: 2`. Read on its own it says all is well; it actually says we
/// know nothing. Everything this screen renders is counted off the rows it
/// is putting on the glass, and `clear` is used for exactly one thing: as a
/// second signature on the good-news banner, never as its author.
struct AlertsSummary: Decodable {
    let total: Int?
    let breach: Int?
    let action: Int?
    let watch: Int?
    let unchecked: Int?
    let clear: Bool?
}

/// services/alerts.js:32-39 — the IPS constants, shipped with the payload
/// rather than copied into the app. The charter is the club's to change,
/// and a threshold hardcoded here would keep quoting last year's number
/// long after the document moved.
struct AlertsPolicy: Decodable {
    let maxSinglePositionPct: Double?
    let minCashPct: Double?
    let minEquityPct: Double?
    let maxEquityPct: Double?
    let reviewDrawdownPct: Double?
    /// Months, not a percentage. It sits in a struct of percentages and is
    /// the one field that must never reach Fmt.pct.
    let minHoldMonths: Double?
}

// MARK: Grouping
//
// Urgency order is the server's, and it is already applied: `sev` at
// services/alerts.js:44 ranks breach 3, action 2, watch 1, and the sort at
// :204 breaks ties on the magnitude of `value`. Filtering by kind preserves
// that order, so this screen groups without ever re-sorting — two sort
// rules that can disagree is a worse problem than the one it solves.

extension AlertsPayload {
    var rows: [AlertsItem] { alerts ?? [] }

    private func rows(_ kind: String) -> [AlertsItem] {
        rows.filter { ($0.kind ?? "").lowercased() == kind }
    }

    var breaches: [AlertsItem]  { rows("breach") }
    var actions: [AlertsItem]   { rows("action") }
    var watches: [AlertsItem]   { rows("watch") }
    var unchecked: [AlertsItem] { rows("unchecked") }

    /// A kind this build has never heard of. Rendered rather than dropped:
    /// a rule added to services/alerts.js after this app shipped would
    /// otherwise go silent on the phone, which is the same defect as an
    /// unchecked rule reading as clear.
    var others: [AlertsItem] {
        let known: Set<String> = ["breach", "action", "watch", "unchecked"]
        return rows.filter { !known.contains(($0.kind ?? "").lowercased()) }
    }

    /// The headline count: what a member has to do something about. Watches
    /// are deliberately excluded — an earnings date is a diary entry, and
    /// folding it in here would make the number cry wolf every quarter.
    var pressing: Int { breaches.count + actions.count }

    var everyRuleRan: Bool { unchecked.isEmpty }
}

/// ForEach needs stable identity, and the server's `id` is optional. The
/// index is folded in for the same reason Holding.keyed does it in
/// Models.swift: two rows that decode without an id would otherwise collide
/// and hand SwiftUI duplicate identities.
private struct AlertsRowKey: Identifiable {
    let id: String
    let alert: AlertsItem
}

private func keyed(_ items: [AlertsItem]) -> [AlertsRowKey] {
    items.enumerated().map { i, a in
        AlertsRowKey(id: "\(i)-\(a.id ?? a.title ?? "row")", alert: a)
    }
}

// MARK: Store

@MainActor
final class AlertsStore: ObservableObject {
    @Published private(set) var state: Loadable<AlertsPayload> = .loading
    /// A 403 is an answer, not a failure, and it lives outside `state` so it
    /// can be rendered as a sentence instead of as COULD NOT LOAD over a
    /// RETRY that will never succeed. /api/alerts is behind
    /// requireTerminalAccess (routes/alerts.js:31), and JuniorAnalyst is the
    /// default role for a Google self-signup — so this is the ordinary first
    /// experience of a new member, not an edge case.
    @Published private(set) var accessNote: String?
    @Published private(set) var lastLoad: Date?

    func load() async {
        accessNote = nil
        state = .loading
        await fetch(keepingOldOnFailure: false)
    }

    /// Pull-to-refresh and the stale strip. Keeps what is on screen: a
    /// member who pulled still wants to see which positions are in breach,
    /// and a failed refetch is no reason to hide them.
    func refresh() async {
        await fetch(keepingOldOnFailure: true)
    }

    /// Tab re-entry, and the app coming back to the front. Five minutes
    /// rather than the book's two: this reads a sheet plus an earnings
    /// calendar cached twelve hours upstream, so hammering it buys nothing.
    func refreshIfStale(after seconds: TimeInterval = 300) async {
        if case .loading = state { return }
        guard let last = lastLoad, Date().timeIntervalSince(last) > seconds else { return }
        await refresh()
    }

    private func fetch(keepingOldOnFailure keepOld: Bool) async {
        let previous = state.value
        do {
            // Deliberately uncached. Cache.read exists for the book and the
            // wire, where a slightly old number beats an empty screen on a
            // cold dyno. A compliance verdict is the opposite trade: last
            // week's "nothing to report", painted instantly and confidently
            // on launch, is the single most misleading thing this screen
            // could show.
            let payload = try await API.shared.get("/alerts", as: AlertsPayload.self)
            accessNote = nil
            lastLoad = Date()
            state = .loaded(payload, at: Date())
        } catch APIError.cancelled {
            // Leaving the tab mid-load is not a failure. Say nothing.
            return
        } catch APIError.forbidden(let message) {
            // Whatever we were holding goes away with the permission. We
            // have just been told this member may not read the book's
            // compliance state, and continuing to show it under a note
            // saying they may not would be a strange kind of honesty.
            accessNote = message
            state = .loading
        } catch {
            let msg = error.localizedDescription
            if keepOld, let previous {
                state = .stale(previous, msg)
            } else {
                state = .failed(msg)
            }
        }
    }
}

// MARK: Screen

struct AlertsScreen: View {
    @StateObject private var store = AlertsStore()
    /// Drives the clock-based stale strip; see StaleClock.
    @ObservedObject private var clock = StaleClock.shared

    var body: some View {
        VStack(spacing: 0) {
            FunctionBar(code: "ALRT", title: "Needs attention")

            if let note = store.accessNote {
                AlertsAccessNote(serverMessage: note)
            } else {
                // No `emptyWhen`, on purpose. An empty alerts array is not an
                // empty screen, it is a verdict — and the verdict belongs
                // above the charter it was measured against, inside a view
                // that can still be pulled to re-check. EmptyState would put
                // one grey sentence on a page with nothing else on it and no
                // way to ask again.
                ScreenState(state: store.state.aged(after: 900, now: clock.tick),
                            retry: { Task { await store.load() } },
                            staleRetry: { Task { await store.refresh() } }) { payload in
                    content(payload)
                }
            }
        }
        .background(T.bg)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: TickerScreen.self) { $0 }
        // A gated member is not re-asked on every tab entry: the note would
        // flicker into a spinner and back several times a session to answer
        // a question whose answer changes about once a year. A promotion
        // lands on the next launch.
        .task { if store.state.value == nil && store.accessNote == nil { await store.load() } }
        .task { await store.refreshIfStale() }
        .refreshOnForeground(after: 120) { await store.refreshIfStale(after: 120) }
    }

    private func content(_ p: AlertsPayload) -> some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                headline(p)

                section("Breaches", keyed(p.breaches), strip: T.negative)
                section("Action required", keyed(p.actions), strip: T.amber)
                // No strip on a watch. The leading accent is this app's
                // urgency vocabulary, and an earnings date is a diary entry.
                section("Coming up", keyed(p.watches), strip: nil)
                section("Other", keyed(p.others), strip: nil)

                uncheckedSection(p)
                policySection(p)
                footer()
            }
        }
        .refreshable { await store.refresh() }
    }

    // MARK: The three verdicts

    @ViewBuilder private func headline(_ p: AlertsPayload) -> some View {
        // A zero here is counted, not missing — it is the length of a list
        // this screen is holding, not a figure the server declined to send.
        // That is the whole difference between an honest 0 and the fabricated
        // one Fmt exists to prevent.
        StatBlock(label: "Needs attention",
                  value: "\(p.pressing)",
                  caption: countLine(p))

        if p.rows.isEmpty && (p.summary?.clear ?? false) {
            banner(chip: "Clear",
                   tone: T.positive,
                   text: "Every rule in the charter ran and the book is inside all of them.")
        } else if p.rows.isEmpty {
            // Nothing raised, but the server's own summary did not sign off
            // on it. The two can only disagree if the payload changed shape
            // beneath us, and an unexplained silence is not a clearance.
            banner(chip: "Unconfirmed",
                   tone: T.muted,
                   text: "Nothing was raised, but the server did not confirm a clear reading. Treat this as unchecked.")
        }

        if !p.everyRuleRan {
            // This sits at the top, above the fold, and not only down in its
            // own section — because the failure this whole file guards
            // against is a member glancing at a small number and leaving.
            banner(chip: "Unchecked",
                   tone: T.orange,
                   text: "\(p.unchecked.count) of the charter's rules could not be checked, so this is not an all-clear.")
        }
    }

    /// The reconciliation under the headline number: what the sections below
    /// actually contain. Nil when there is nothing at all, so the good-news
    /// banner is the only thing speaking in that case.
    private func countLine(_ p: AlertsPayload) -> String? {
        var parts: [String] = []
        let b = p.breaches.count, a = p.actions.count
        let w = p.watches.count, o = p.others.count, u = p.unchecked.count
        if b > 0 { parts.append("\(b) breach\(b == 1 ? "" : "es")") }
        if a > 0 { parts.append("\(a) needing a decision") }
        if w > 0 { parts.append("\(w) coming up") }
        if o > 0 { parts.append("\(o) other") }
        if u > 0 { parts.append("\(u) not checked") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The unchecked rules, kept apart from everything else and introduced
    /// in its own words. A row reading "Not checked: cash" sitting in the
    /// same list as a real breach invites a reader to skim past it as a
    /// minor finding, and it is not a finding at all.
    @ViewBuilder private func uncheckedSection(_ p: AlertsPayload) -> some View {
        if !p.unchecked.isEmpty {
            Section {
                Text("We could not evaluate these. That is our data failing to load, not something the book did — nothing below is a result, and none of it can be read as a pass.")
                    .font(Type.footnote)
                    .foregroundStyle(T.dim)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Space.l)
                    .padding(.vertical, Space.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T.card)
                    .hairline()

                ForEach(keyed(p.unchecked)) { entry in
                    row(entry.alert, strip: T.muted)
                }
            } header: {
                SectionHeader(text: "Could not be checked",
                              trailing: "\(p.unchecked.count)")
            }
        }
    }

    // MARK: Rows

    @ViewBuilder private func section(_ title: String,
                                      _ entries: [AlertsRowKey],
                                      strip: Color?) -> some View {
        if !entries.isEmpty {
            Section {
                ForEach(entries) { entry in
                    row(entry.alert, strip: strip)
                }
            } header: {
                SectionHeader(text: title, trailing: "\(entries.count)")
            }
        }
    }

    /// An alert that names a position opens it. The ones that do not name
    /// one — the cash floor, the equity band, an unchecked rule — are facts
    /// about the fund, and there is nowhere for them to lead.
    @ViewBuilder private func row(_ a: AlertsItem, strip: Color?) -> some View {
        if let symbol = cleanTicker(a.ticker) {
            NavigationLink(value: TickerScreen(symbol: symbol)) {
                alertRow(a, strip: strip)
            }
            .buttonStyle(.plain)
        } else {
            alertRow(a, strip: strip)
        }
    }

    /// The server's sentence, whole.
    ///
    /// `detail` runs to a couple of hundred characters on the drawdown rule
    /// because it quotes the charter, and it is not truncated: the service's
    /// own reasoning is that "a member who has never read the IPS should
    /// learn what it says from the alert, and an exec who disagrees should
    /// be arguing with the document rather than with us". A three-line clamp
    /// would cut the quotation in half and leave the argument to us.
    private func alertRow(_ a: AlertsItem, strip: Color?) -> some View {
        Row(title: a.title ?? "Unnamed alert",
            subtitle: a.detail,
            meta: a.source,
            strip: strip) {
            tickerChip(a.ticker)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder private func tickerChip(_ ticker: String?) -> some View {
        if let symbol = cleanTicker(ticker) {
            Chip(text: symbol, tone: T.amber, style: .solid)
        }
    }

    private func cleanTicker(_ ticker: String?) -> String? {
        guard let t = ticker?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
        return t.uppercased()
    }

    // MARK: The charter, and when we read it

    /// The numbers the rules above were measured against, straight from the
    /// payload's `policy` block. Worth the space: an alert saying a position
    /// is past a threshold is only arguable if the reader can see what the
    /// threshold is.
    @ViewBuilder private func policySection(_ p: AlertsPayload) -> some View {
        if let ips = p.policy {
            Section {
                VStack(spacing: 0) {
                    StatLine(label: "Max in one security",
                             value: Fmt.pct(ips.maxSinglePositionPct, decimals: 0, signed: false))
                    StatLine(label: "Cash floor",
                             value: Fmt.pct(ips.minCashPct, decimals: 0, signed: false))
                    StatLine(label: "US equities",
                             value: band(ips.minEquityPct, ips.maxEquityPct))
                    StatLine(label: "Review a position past",
                             value: Fmt.pct(ips.reviewDrawdownPct, decimals: 0))
                    StatLine(label: "Minimum hold",
                             value: months(ips.minHoldMonths))
                }
                .padding(.horizontal, Space.l)
                .padding(.vertical, Space.m)
                .frame(maxWidth: .infinity)
                .background(T.card)
                .hairline()
            } header: {
                SectionHeader(text: "The charter", trailing: "IPS")
            }
        }
    }

    private func band(_ low: Double?, _ high: Double?) -> String {
        guard low != nil, high != nil else { return "—" }
        return "\(Fmt.pct(low, decimals: 0, signed: false))–\(Fmt.pct(high, decimals: 0, signed: false))"
    }

    /// Months. Its own formatter because `minHoldMonths` sits in a struct of
    /// percentages and is not one — running it through Fmt.pct would print
    /// the club's three-month holding period as "3%".
    private func months(_ v: Double?) -> String {
        guard let v else { return "—" }
        let whole = Int(v.rounded())
        return "\(whole) month\(whole == 1 ? "" : "s")"
    }

    private func footer() -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            AsOfStamp(date: store.lastLoad)
            Text("Checked against ips.md, the club's Investment Policy Statement. Every rule reports whether it could run, so an outage cannot pass for compliance.")
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Banner

    /// The tinted one-line verdict, the same shape BookScreen uses for its
    /// unpriced-positions warning. A chip carrying the state and a sentence
    /// carrying what it means, because neither alone survives a glance.
    private func banner(chip: String, tone: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            Chip(text: chip, tone: tone, style: .solid)
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
}

// MARK: The gate

/// What a JuniorAnalyst sees. One quiet sentence and no button.
///
/// The temptation is to write "no alerts to show", which would be the app
/// reporting its own permission gate as a fact about the fund — the exact
/// thing that made /terminal/chart print "No price history available for
/// this name" about companies whose history was fine. There is no RETRY
/// either: a retry that cannot succeed is worse than no retry, because it
/// tells a member the problem is transient and asks them to keep tapping.
private struct AlertsAccessNote: View {
    /// requireTerminalAccess's own words (middleware/auth.js:352), kept
    /// verbatim so the app and the server never drift into naming two
    /// different roles.
    let serverMessage: String

    var body: some View {
        VStack(spacing: Space.m) {
            Text("Alerts are Analyst and above.")
                .font(Type.footnote)
                .foregroundStyle(T.dim)
            Text("That is a permission, not a verdict. This screen has not told you the book is clear — it has not looked.")
                .font(Type.footnote)
                .foregroundStyle(T.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text(serverMessage)
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .multilineTextAlignment(.center)
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
