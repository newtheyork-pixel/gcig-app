import SwiftUI

// MGMT — leadership, board, comp and the interlocking-board network,
// all parsed from the ticker's latest DEF 14A.
//
// Shape comes from parseLeadership/parseBoard/parseComp/buildNetwork in
// governanceParsers.js via /terminal/governance/:ticker. Every section
// is best-effort and independently nullable — proxies are bespoke
// documents, and the server's contract is recall over precision with
// null for anything not confidently extractable. So a dash here is a
// parse fact, not a bug, and the panel says which of the two degraded
// worlds it is in: no DEF 14A on file at all (source == null), or a
// proxy that was fetched but resisted parsing (source set, every
// section empty). The web's AI brief from /terminal/annotate is
// skipped, same as DES and EARN — but the two honest sentences the
// web shows instead of a brief when there is nothing to summarize are
// ported, because those are facts, not model output.
//
// Executive bios ride a second, lazy endpoint
// (/governance/:ticker/exec-bios): by SEC rule the officer disclosure
// lives in the 10-K, not the proxy, and that filing runs tens of MB.
// The web fetches it at most once per ticker and only when someone
// opens a Leadership profile; same discipline here. That endpoint can
// never 5xx — any miss is a normal 200 with officers:[] — so the
// profile's empty state is "no bio disclosed", never an error.
struct GovernancePanel: View {
    let ticker: String

    // MARK: Server shapes

    struct Person: Decodable {
        let name: String?
        let title: String?
        let age: Int?
        let since: Int?
        let priorRoles: [String]?
        let totalComp: Double?
        /// Set when the name came from an ownership filing rather than
        /// the proxy. `isNew` means they took the office after the
        /// proxy went out, which is precisely the case the proxy alone
        /// gets wrong.
        let office: String?
        let appointedAt: String?
        let isNew: Bool?
        let former: Bool?
        let supersededBy: String?
        let supersededByAt: String?
    }

    /// Who holds the office today, and how we know.
    ///
    /// A DEF 14A is filed once a year, so reading leadership out of its
    /// compensation table means the panel is wrong for however many
    /// months separate a change from the next proxy — Mesa showed a CEO
    /// who had left in April right through July. Forms 3 and 4 carry the
    /// same titles in a structured field within days of an appointment,
    /// and that is what this section is.
    struct Leadership: Decodable {
        let source: String?
        let asOf: String?
        let proxyAsOf: String?
        let officers: [Person]?
        let former: [Person]?
        let events: [ChangeEvent]?
        let changedSinceProxy: Bool?
    }

    struct ChangeEvent: Decodable, Identifiable {
        let filedAt: String?
        let url: String?
        let summary: String?
        var id: String { (filedAt ?? "") + (url ?? "") }
    }

    struct Director: Decodable {
        let name: String?
        let age: Int?
        let since: Int?
        let committees: [String]?
        let otherBoards: [String]?
        let bio: String?
    }

    struct CompRow: Decodable {
        let name: String?
        let title: String?
        let total: Double?
        let salaryPct: Double?
        let stockPct: Double?
        let optionPct: Double?
        let otherPct: Double?
    }

    struct Comp: Decodable { let rows: [CompRow]? }

    struct Edge: Decodable {
        let person: String?
        let a: String?
        let b: String?
    }

    struct Network: Decodable {
        let nodes: [String]?
        let edges: [Edge]?
    }

    struct Payload: Decodable {
        let ticker: String?
        let asOf: String?
        let source: String?
        let ceo: Person?
        let execs: [Person]?
        let board: [Director]?
        let comp: Comp?
        let network: Network?
        let leadership: Leadership?
    }

    struct BiosPayload: Decodable {
        let ticker: String?
        let source: String?
        let officers: [Officer]?
        struct Officer: Decodable {
            let name: String?
            let bio: String?
        }
    }

    // MARK: Panel state

    private enum Tab: String, CaseIterable {
        case leadership = "Leadership"
        case board = "Board"
        case comp = "Comp"
        case network = "Network"
    }

    // The person whose profile is open. Directors carry their bio
    // inline (parsed straight from the DEF 14A); execs get one
    // stitched in from the lazily-fetched 10-K map below.
    private struct Profile {
        enum Kind { case director, exec }
        let kind: Kind
        let name: String
        let title: String?
        let age: Int?
        let since: Int?
        let total: Double?
        let bio: String?
    }

    // The 10-K bio map, tagged with the ticker it was fetched for. A
    // ticker switch resets this to .idle, but a fetch already in
    // flight for the old symbol can still resolve afterwards — the
    // tag lets every reader treat that stale payload as no data, the
    // native analogue of the web's execBiosTicker ref.
    private enum Bios {
        case idle
        case loading(String)
        case done(String, [String: String])
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var tab: Tab = .leadership
    @State private var selected: Profile? = nil
    @State private var bios: Bios = .idle

    var body: some View {
        ZStack {
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().overlay(Term.border)
                PanelState(state: state,
                           emptyWhen: { $0.source == nil },
                           emptyText: "No recent DEF 14A on file for \(ticker.uppercased()).",
                           retry: { Task { await load() } }) { p in
                    loaded(p)
                }
            }
            if let sel = selected { profileOverlay(sel) }
        }
        .task(id: ticker) { await load() }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Text(ticker.uppercased())
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            SectionLabel(text: "Management & Board")
            Spacer()
            if case .loaded(let p) = state, let a = p.asOf, !a.isEmpty {
                Text("DEF 14A \(a)")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgDim)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Loaded body

    private func hasData(_ p: Payload) -> Bool {
        p.ceo != nil
            || !(p.execs ?? []).isEmpty
            || !(p.board ?? []).isEmpty
            || !(p.comp?.rows ?? []).isEmpty
            || !(p.network?.edges ?? []).isEmpty
    }

    private func loaded(_ p: Payload) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // A proxy that was fetched but yielded nothing is a
            // different fact from no proxy at all, and the web states
            // it in place of the brief. Same sentence here.
            if !hasData(p) {
                Text("DEF 14A retrieved, but its structure could not be parsed (common for large multi-section proxies).")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
                    .lineSpacing(2)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                Divider().overlay(Term.border)
            }
            tabs
            Divider().overlay(Term.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    switch tab {
                    case .leadership: leadership(p)
                    case .board:      boardTable(p.board ?? [])
                    case .comp:       compTable(p.comp?.rows ?? [])
                    case .network:    networkTable(p.network?.edges ?? [])
                    }
                    footer
                }
                .padding(12)
            }
        }
    }

    private var tabs: some View {
        HStack(spacing: 4) {
            ForEach(Tab.allCases, id: \.self) { t in
                // Same selected-tab treatment as FA: re-stroke the
                // shared button style's border in amber.
                Button(t.rawValue) { tab = t }
                    .buttonStyle(TermButtonStyle())
                    .overlay(Rectangle().strokeBorder(tab == t ? Term.amber : .clear,
                                                      lineWidth: 1))
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var footer: some View {
        Text("Directors and compensation are parsed from the latest DEF 14A, including the bespoke bio-card proxies many large-caps file. Executive bios load from the latest 10-K when the filer discloses them. Click any name for the full profile. Coverage varies with each company's filing format.")
            .font(Term.mono(10))
            .foregroundStyle(Term.fgMuted)
            .lineSpacing(2)
    }

    // MARK: Leadership tab

    @ViewBuilder
    private func leadership(_ p: Payload) -> some View {
        provenance(p.leadership)
        if let ceo = p.ceo {
            ceoCard(ceo)
        }
        departures(p.leadership)
        changeEvents(p.leadership)
        let execs = p.execs ?? []
        if execs.isEmpty {
            Text("No executive bios parsed.")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text("Executive").frame(width: 160, alignment: .leading)
                    Text("Title")
                    Spacer(minLength: 6)
                    Text("Age").frame(width: 34, alignment: .trailing)
                    Text("Since").frame(width: 44, alignment: .trailing)
                }
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.fgMuted)
                .padding(.vertical, 4)
                Divider().overlay(Term.border)
                // Keyed by position: the SCT-fallback filers can list
                // the CEO both here and in comp, so no field is
                // guaranteed unique. The web keys on index too.
                ForEach(Array(execs.enumerated()), id: \.offset) { _, e in
                    execRow(e)
                }
            }
        }
    }

    /// Where these names came from and how old they are.
    ///
    /// Two dates, because they are two different documents and the gap
    /// between them is exactly the window in which a proxy-only panel
    /// tells you a lie with a straight face.
    @ViewBuilder
    private func provenance(_ l: Leadership?) -> some View {
        if let l, l.source == "sec-ownership" {
            HStack(spacing: 8) {
                Text("OFFICERS PER SEC FORMS 3/4")
                    .font(Term.mono(9, weight: .bold))
                    .foregroundStyle(Term.positive)
                if let a = l.asOf, !a.isEmpty {
                    Text("filed to \(a)").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                if let p = l.proxyAsOf, !p.isEmpty {
                    Text("· age and pay from the proxy of \(p)")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
                Spacer()
            }
            .padding(.bottom, 2)
        } else if let l, l.source == "proxy" {
            // Never let a degraded read look like the good one.
            Text("Leadership from the proxy only — no ownership filings resolved, so a recent change would not show here.")
                .font(Term.mono(9)).foregroundStyle(Term.amber)
                .padding(.bottom, 2)
        }
    }

    /// Who has left, and who replaced them.
    ///
    /// The old panel simply listed a departed CEO as staff, title and
    /// all. Naming him under a heading that says he is gone is the
    /// difference between stale data and a record.
    @ViewBuilder
    private func departures(_ l: Leadership?) -> some View {
        let gone = l?.former ?? []
        if !gone.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text("DEPARTED")
                    .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.fgMuted)
                ForEach(Array(gone.enumerated()), id: \.offset) { _, f in
                    Text(departureLine(f))
                        .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func departureLine(_ f: Person) -> String {
        var s = "\(f.name ?? "—") · \(f.title ?? "—")"
        if let by = f.supersededBy {
            s += " — succeeded by \(by)"
            // "by" rather than "on": the successor's first filing bounds
            // the handover, it does not date it.
            if let at = f.supersededByAt { s += " by \(at)" }
        }
        return s
    }

    /// The 8-K that announced the change, in the company's own words.
    @ViewBuilder
    private func changeEvents(_ l: Leadership?) -> some View {
        let events = (l?.events ?? []).prefix(2)
        if !events.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Text("ANNOUNCED (8-K ITEM 5.02)")
                    .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.fgMuted)
                ForEach(Array(events)) { e in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(e.filedAt ?? "—")
                            .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.blue)
                        Text(e.summary ?? "")
                            .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                            .lineLimit(4).lineSpacing(2)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if let u = e.url, let url = URL(string: u) { NSWorkspace.shared.open(url) }
                    }
                    .help("Open the filing on EDGAR")
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func ceoCard(_ ceo: Person) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(ceo.name ?? "—") · \(ceo.title ?? "—")")
                .font(Term.mono(13, weight: .bold))
                .foregroundStyle(Term.amber)
            Text(ceoSubline(ceo))
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .lineLimit(2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { openExec(ceo) }
        .help("Open \(ceo.name ?? "profile")")
    }

    private func ceoSubline(_ ceo: Person) -> String {
        // A chief executive appointed since the last proxy has no age or
        // tenure on file anywhere — the proxy is the only document that
        // carries them. Saying when they took the office beats two
        // dashes, and it is the more useful fact besides.
        var s: String
        if ceo.age == nil && ceo.since == nil, let at = ceo.appointedAt {
            s = "appointed \(at) · age and tenure not yet in a proxy"
        } else {
            s = "age \(ceo.age.map(String.init) ?? "—") · since \(ceo.since.map(String.init) ?? "—")"
        }
        if let prior = ceo.priorRoles, !prior.isEmpty {
            s += " · prior: \(prior.joined(separator: "; "))"
        }
        return s
    }

    private func execRow(_ e: Person) -> some View {
        HStack(spacing: 8) {
            Text(e.name ?? "—")
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.amber)
                .lineLimit(1)
                .frame(width: 160, alignment: .leading)
            Text(e.title ?? "—")
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .lineLimit(1)
            // Appointed after the last proxy, so this is a name the
            // compensation table cannot know about.
            if e.isNew == true {
                Text("NEW")
                    .font(Term.mono(8, weight: .bold))
                    .foregroundStyle(Term.positive)
                    .help("Appointed since the last proxy — \(e.appointedAt ?? "date on the Form 3")")
            }
            Spacer(minLength: 6)
            Text(e.age.map(String.init) ?? "—")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .frame(width: 34, alignment: .trailing)
            Text(e.since.map(String.init) ?? "—")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .frame(width: 44, alignment: .trailing)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { openExec(e) }
        .help("Open \(e.name ?? "profile")")
    }

    // MARK: Board tab

    @ViewBuilder
    private func boardTable(_ board: [Director]) -> some View {
        if board.isEmpty {
            Text("No board data parsed.")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text("Director").frame(width: 160, alignment: .leading)
                    Text("Age").frame(width: 34, alignment: .trailing)
                    Text("Since").frame(width: 44, alignment: .trailing)
                    Text("Committees").frame(width: 150, alignment: .leading)
                    Text("Other public boards")
                    Spacer(minLength: 0)
                }
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.fgMuted)
                .padding(.vertical, 4)
                Divider().overlay(Term.border)
                ForEach(Array(board.enumerated()), id: \.offset) { _, d in
                    boardRow(d)
                }
            }
        }
    }

    private func boardRow(_ d: Director) -> some View {
        HStack(spacing: 8) {
            Text(d.name ?? "—")
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.amber)
                .lineLimit(1)
                .frame(width: 160, alignment: .leading)
            Text(d.age.map(String.init) ?? "—")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .frame(width: 34, alignment: .trailing)
            Text(d.since.map(String.init) ?? "—")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .frame(width: 44, alignment: .trailing)
            Text(joined(d.committees))
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .lineLimit(1)
                .frame(width: 150, alignment: .leading)
            Text(joined(d.otherBoards))
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { openDirector(d) }
        .help("Open \(d.name ?? "profile")")
    }

    private func joined(_ items: [String]?) -> String {
        let a = items ?? []
        return a.isEmpty ? "—" : a.joined(separator: ", ")
    }

    // MARK: Comp tab

    @ViewBuilder
    private func compTable(_ rows: [CompRow]) -> some View {
        if rows.isEmpty {
            Text("No compensation data parsed.")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text("Name").frame(width: 160, alignment: .leading)
                    Spacer(minLength: 6)
                    Text("Salary%").frame(width: 52, alignment: .trailing)
                    Text("Stock%").frame(width: 52, alignment: .trailing)
                    Text("Option%").frame(width: 54, alignment: .trailing)
                    Text("Other%").frame(width: 50, alignment: .trailing)
                    Text("Total").frame(width: 92, alignment: .trailing)
                }
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.fgMuted)
                .padding(.vertical, 4)
                Divider().overlay(Term.border)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                    compRow(r)
                }
            }
        }
    }

    private func compRow(_ r: CompRow) -> some View {
        HStack(spacing: 8) {
            Text(r.name ?? "—")
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.amber)
                .lineLimit(1)
                .frame(width: 160, alignment: .leading)
            Spacer(minLength: 6)
            // Bare integers, exactly as the web renders them — the
            // column header carries the % — and a dash when the proxy
            // gave totals but no salary/stock/option split (the AMZN/
            // KO shape). Zero would be a lie there.
            Text(intText(r.salaryPct)).frame(width: 52, alignment: .trailing)
            Text(intText(r.stockPct)).frame(width: 52, alignment: .trailing)
            Text(intText(r.optionPct)).frame(width: 54, alignment: .trailing)
            Text(intText(r.otherPct)).frame(width: 50, alignment: .trailing)
            Text(dollars(r.total))
                .font(Term.mono(11, weight: .medium))
                .frame(width: 92, alignment: .trailing)
        }
        .font(Term.mono(11))
        .foregroundStyle(Term.white)
        .padding(.vertical, 3)
    }

    // MARK: Network tab

    @ViewBuilder
    private func networkTable(_ edges: [Edge]) -> some View {
        if edges.isEmpty {
            Text("No shared boards among current fund holdings.")
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text("Director").frame(width: 160, alignment: .leading)
                    Text("Focus").frame(width: 70, alignment: .leading)
                    Text("Also on (held)")
                    Spacer(minLength: 0)
                }
                .font(Term.mono(9, weight: .bold))
                .foregroundStyle(Term.fgMuted)
                .padding(.vertical, 4)
                Divider().overlay(Term.border)
                ForEach(Array(edges.enumerated()), id: \.offset) { _, e in
                    HStack(spacing: 8) {
                        Text(e.person ?? "—")
                            .font(Term.mono(11, weight: .medium))
                            .foregroundStyle(Term.amber)
                            .lineLimit(1)
                            .frame(width: 160, alignment: .leading)
                        Text(e.a ?? "—")
                            .font(Term.mono(11))
                            .foregroundStyle(Term.white)
                            .frame(width: 70, alignment: .leading)
                        Text(e.b ?? "—")
                            .font(Term.mono(11))
                            .foregroundStyle(Term.white)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
    }

    // MARK: Person profile

    private func openDirector(_ d: Director) {
        selected = Profile(kind: .director, name: d.name ?? "—", title: nil,
                           age: d.age, since: d.since, total: nil, bio: d.bio)
    }

    private func openExec(_ e: Person) {
        // The web passes e.total here, which parseLeadership never
        // sets — its field is totalComp, real money for the SCT-
        // fallback filers. Carrying the value the server actually
        // sends is the intent of that code, so the slip is not
        // ported.
        selected = Profile(kind: .exec, name: e.name ?? "—", title: e.title,
                           age: e.age, since: e.since, total: e.totalComp, bio: nil)
        Task { await loadExecBios() }
    }

    private func profileOverlay(_ sel: Profile) -> some View {
        ZStack {
            // Backdrop covers exactly this panel, dims what is behind
            // and dismisses on click — the web modal's contract.
            Term.bg.opacity(0.72)
                .contentShape(Rectangle())
                .onTapGesture { selected = nil }
            VStack(alignment: .leading, spacing: 0) {
                profileHeader(sel)
                Divider().overlay(Term.border)
                ScrollView { profileBody(sel) }
            }
            .background(Term.bgPanel)
            .overlay(Rectangle().strokeBorder(Term.borderFocus, lineWidth: 1))
            .frame(maxWidth: 540, maxHeight: 420)
            .padding(16)
        }
    }

    private func profileHeader(_ sel: Profile) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(sel.name)
                    .font(Term.mono(15, weight: .bold))
                    .foregroundStyle(Term.amber)
                // Compact fact line, same grammar as the tabs; each
                // part omitted when absent so a director (no comp)
                // doesn't show a row of dashes.
                let facts = factLine(sel)
                if !facts.isEmpty {
                    Text(facts)
                        .font(Term.mono(11))
                        .foregroundStyle(Term.fgDim)
                }
            }
            Spacer(minLength: 6)
            Button("×") { selected = nil }
                .buttonStyle(TermButtonStyle())
                .keyboardShortcut(.cancelAction)
        }
        .padding(12)
    }

    private func factLine(_ sel: Profile) -> String {
        var facts: [String] = []
        if let t = sel.title, !t.isEmpty { facts.append(t) }
        if let a = sel.age { facts.append("age \(a)") }
        if let s = sel.since { facts.append("since \(s)") }
        if let t = sel.total { facts.append("total \(dollars(t))") }
        return facts.joined(separator: " · ")
    }

    @ViewBuilder
    private func profileBody(_ sel: Profile) -> some View {
        let (loading, bio) = bioFor(sel)
        VStack(alignment: .leading, spacing: 8) {
            if loading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).tint(Term.amber)
                    Text("Loading bio…")
                        .font(Term.mono(11))
                        .foregroundStyle(Term.fgMuted)
                }
            } else if let bio {
                ForEach(Array(paragraphs(bio).enumerated()), id: \.offset) { _, para in
                    Text(para)
                        .font(Term.mono(11))
                        .foregroundStyle(Term.white)
                        .lineSpacing(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                // No fabrication: say plainly that the filing carried
                // no bio. The fact line above still gives the reader
                // the structured tenure/comp we do have.
                Text("No bio disclosed in this company's SEC filing.")
                    .font(Term.mono(11))
                    .italic()
                    .foregroundStyle(Term.fgDim)
            }
        }
        .padding(12)
    }

    // Directors carry their own bio and never load. Execs read the
    // lazily-fetched 10-K map: still fetching (or fetched for another
    // ticker) reads as loading; resolved reads the matched bio or nil,
    // which the body renders as the honest empty state.
    private func bioFor(_ sel: Profile) -> (loading: Bool, bio: String?) {
        if sel.kind == .director {
            let b = sel.bio?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (false, (b?.isEmpty ?? true) ? nil : b)
        }
        switch bios {
        case .done(let t, let map) where t == ticker:
            let b = map[Self.normName(sel.name)]
            return (false, (b?.isEmpty ?? true) ? nil : b)
        default:
            return (true, nil)
        }
    }

    // MARK: Formatting

    private func intText(_ v: Double?) -> String {
        guard let v else { return "—" }
        return String(Int(v.rounded()))
    }

    private func dollars(_ v: Double?) -> String {
        guard let v else { return "—" }
        return "$\(Fmt.money(v, decimals: 0))"
    }

    // SCT names ("Andrew R. Jassy") and 10-K officer names ("Andrew
    // Jassy") rarely agree on punctuation or spacing, so the bio map
    // keys on a flattened form: trim, collapse interior whitespace,
    // drop case. Imperfect across middle-name drift, but it recovers
    // the common mismatches without a fuzzy match that could cross
    // two different officers. Must mirror the web's normName exactly.
    private static func normName(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .lowercased()
    }

    // SEC prose arrives as either real newlines or sentences glued by
    // the double-space the parser leaves between source blocks; both
    // are paragraph breaks, and empties are dropped so a stray gap
    // can't render a blank one. Same split as the web modal.
    private func paragraphs(_ text: String) -> [String] {
        text.split(separator: /\n+|\s{2,}/)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    // MARK: Loading

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("MGMT needs a ticker.")
            return
        }
        state = .loading
        tab = .leadership
        // A new symbol must not show the prior company's profile, nor
        // reuse its 10-K bio map.
        selected = nil
        bios = .idle
        do {
            let data = try await API.shared.get("/terminal/governance/\(ticker)")
            let p = try await API.shared.decode(Payload.self, from: data)
            // Bespoke-card big-caps (AMZN, KO) parse a full Comp table
            // but an empty Leadership tab, so always opening on
            // Leadership made the web panel look broken. Land on the
            // first tab that has something; fall back to Leadership so
            // the empty-state copy is unchanged when nothing parsed.
            tab = Self.preferredTab(p)
            state = .loaded(p)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private static func preferredTab(_ p: Payload) -> Tab {
        if p.ceo != nil || !(p.execs ?? []).isEmpty { return .leadership }
        if !(p.board ?? []).isEmpty { return .board }
        if !(p.comp?.rows ?? []).isEmpty { return .comp }
        if !(p.network?.edges ?? []).isEmpty { return .network }
        return .leadership
    }

    // Fetched at most once per ticker, and only when someone actually
    // opens a Leadership profile — the 10-K is tens of MB and most
    // panel views never touch this. A miss is not an error the reader
    // should see: the endpoint's own contract is an honest-empty 200,
    // and any unexpected failure degrades to the same empty map so
    // the profile still shows its structured facts.
    private func loadExecBios() async {
        switch bios {
        case .loading(let t) where t == ticker: return
        case .done(let t, _) where t == ticker: return
        default: break
        }
        let startedFor = ticker
        bios = .loading(startedFor)
        do {
            let data = try await API.shared.get("/terminal/governance/\(startedFor)/exec-bios")
            let p = try await API.shared.decode(BiosPayload.self, from: data)
            var byName: [String: String] = [:]
            for o in p.officers ?? [] {
                if let n = o.name, !n.isEmpty { byName[Self.normName(n)] = o.bio ?? "" }
            }
            bios = .done(startedFor, byName)
        } catch {
            bios = .done(startedFor, [:])
        }
    }
}
