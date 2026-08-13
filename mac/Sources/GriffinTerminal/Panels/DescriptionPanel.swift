import SwiftUI

// DES — the company snapshot, laid out the way Bloomberg's is.
//
// The old panel was a price, six valuation rows and a wall of prose. The
// prose was the worse half: it came straight off the top of the 10-K's
// Item 1, so Mesa's description opened "In this annual report, Mesa
// Laboratories, Inc., a Colorado corporation, together with its
// subsidiaries is collectively referred to as 'we,' 'us,' 'our'…" —
// drafting conventions, not a description. The server now opens on the
// sentence that says what the company does.
//
// What Bloomberg puts on this screen and we did not: where the company
// is actually run from, when it was founded, how many people work there,
// when its year ends, and a chart. Those are the fields being added, and
// three of them come from the submissions feed rather than being read
// out of prose — a head office extracted from a sentence put General
// Dynamics in St. Louis, because the sentence was about a customer's
// building.
//
// Every one of these is nullable and renders as a dash. A dash here is a
// fact about the filing, not a hole in the panel.
struct DescriptionPanel: View {
    let ticker: String

    struct Info: Decodable {
        let name: String?
        let legalName: String?
        let sector: String?
        let industry: String?
        let price: Double?
        let previousClose: Double?
        let marketCap: Double?
        let trailingPE: Double?
        let forwardPE: Double?
        let dividendYield: Double?
        let fiftyTwoWeekLow: Double?
        let fiftyTwoWeekHigh: Double?
        let beta: Double?
        let volume: Double?
        let avgVolume: Double?
        let summary: String?
        /// The LLM rewrite of Item 1 in data-provider register. The
        /// server has produced this for months; only the holdings page
        /// ever rendered it, so DES led with the brochure.
        let description: String?
        let exchange: String?
        let website: String?
        let country: String?

        // The corporate block.
        let employees: Double?
        let founded: Int?
        let headquarters: String?
        let street: String?
        let phone: String?
        let sicDescription: String?
        let fiscalYearEnd: String?
        let stateOfIncorporation: String?
        let formerNames: [String]?
        let summarySource: SummarySource?

        struct SummarySource: Decodable {
            let form: String?
            let filedAt: String?
            let url: String?
        }
    }

    /// The blocks Bloomberg's DES carries beside the description, each
    /// from an endpoint we already serve. All optional and all fetched
    /// after the snapshot: a missing analyst count must never be the
    /// reason the company's name does not appear.
    struct Estimates: Decodable {
        let upcoming: Upcoming?
        let history: [Past]?
        struct Upcoming: Decodable { let date: String?; let epsEstimate: Double? }
        struct Past: Decodable {
            let period: String?; let date: String?
            let epsEstimate: Double?; let epsActual: Double?; let surprisePct: Double?
        }
    }

    struct Consensus: Decodable {
        let latest: Row?
        struct Row: Decodable {
            let strongBuy: Int?; let buy: Int?; let hold: Int?
            let sell: Int?; let strongSell: Int?
            var total: Int {
                (strongBuy ?? 0) + (buy ?? 0) + (hold ?? 0) + (sell ?? 0) + (strongSell ?? 0)
            }
            var bullish: Int { (strongBuy ?? 0) + (buy ?? 0) }
            var bearish: Int { (sell ?? 0) + (strongSell ?? 0) }
        }
    }

    struct Leadership: Decodable {
        let ceo: Person?
        let execs: [Person]?
        struct Person: Decodable { let name: String?; let title: String?; let office: String? }
    }

    /// The club's own record on this name. The reason this terminal
    /// exists rather than a browser tab: whether we own it, who pitched
    /// it, what the room decided, and what was written down afterwards.
    struct Coverage: Decodable {
        let holding: Position?
        let decisions: [Decision]?
        let pitches: [Pitch]?
        let research: [Research]?
        let reports: [Report]?

        struct Report: Decodable {
            let title: String?
            let author: String?
            let date: String?
        }

        struct Research: Decodable {
            let name: String?
            let status: String?
            let initiatedAt: String?
            let analyst: String?
            let buyBelow: Double?
            let currency: String?
        }

        struct Position: Decodable {
            let shares: Double?; let costBasis: Double?; let addedAt: String?
        }
        struct Decision: Decodable {
            let id: Int?; let kind: String?; let closedAt: String?
            let decision: String?; let ballots: Int?
            let synthesis: String?
            let proposed: Proposed?
            struct Proposed: Decodable { let avg: Double?; let min: Double?; let max: Double? }
        }
        struct Pitch: Decodable {
            let date: String?; let presenters: [String]?; let slideshowUrl: String?
        }
    }

    struct Chart: Decodable {
        let points: [Point]?
        let range: String?
        struct Point: Decodable { let t: Double?; let close: Double? }
    }

    @State private var state: Loadable<Info> = .loading
    /// The chart is a second request and must never gate the panel: a
    /// missing sparkline is a missing sparkline, not a failed DES.
    @State private var chart: [Double] = []
    @State private var chartRange: String?
    @State private var estimates: Estimates?
    @State private var consensus: Consensus.Row?
    @State private var leadership: Leadership?
    @State private var coverage: Coverage?
    /// Whether the raw Item 1 is unfolded. Off by default: the summary
    /// above it is the answer for almost every reader, and the filing is
    /// for the one checking it.
    @State private var showFiled = false

    private var changePct: Double? {
        guard case .loaded(let i) = state,
              let p = i.price, let pc = i.previousClose, pc > 0 else { return nil }
        return (p - pc) / pc * 100
    }

    var body: some View {
        PanelState(state: state, retry: { Task { await load() } }) { i in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    quote(i)
                    sparkline(i)
                    clubBlock()
                    Divider().overlay(Term.border)
                    // Two columns, because Bloomberg's DES is two
                    // columns and the reason is sound: the numbers and
                    // the particulars are read separately, and stacking
                    // them means scrolling past one to reach the other.
                    HStack(alignment: .top, spacing: 18) {
                        VStack(alignment: .leading, spacing: 10) { stats(i) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .leading, spacing: 10) {
                            estimatesBlock()
                            ratingsBlock()
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .leading, spacing: 10) {
                            corporate(i)
                            managementBlock()
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Divider().overlay(Term.border)
                    business(i)
                }
                .padding(12)
            }
        }
        .task(id: ticker) { await load() }
    }

    // MARK: Header

    private func quote(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ticker)
                    .font(Term.mono(18, weight: .bold))
                    .foregroundStyle(Term.amber)
                if let ex = i.exchange {
                    Text(ex).font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(1)
                }
                Spacer()
                Text(Fmt.money(i.price))
                    .font(Term.mono(20, weight: .bold))
                    .foregroundStyle(Term.white)
            }
            HStack {
                Text(i.name ?? "")
                    .font(Term.mono(11)).foregroundStyle(Term.fgDim).lineLimit(1)
                Spacer()
                if let c = changePct {
                    Text(Fmt.pct(c)).font(Term.mono(12, weight: .medium))
                        .foregroundStyle(Term.delta(c))
                }
            }
            if let s = i.sector {
                // SIC is the registrant's own classification and is
                // usually more specific than the vendor's, which for
                // Applied printed "Trading Companies & Distributors"
                // as both sector and industry — one fact, twice.
                let vendor = [s, i.industry].compactMap { $0 }
                let parts = Array(NSOrderedSet(array: vendor + [i.sicDescription].compactMap { $0 })) as? [String] ?? vendor
                Text(parts.joined(separator: " · "))
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted).lineLimit(2)
            }
        }
    }

    // MARK: The chart Bloomberg has and we did not

    @ViewBuilder
    private func sparkline(_ i: Info) -> some View {
        if chart.count > 1 {
            let lo = chart.min() ?? 0
            let hi = chart.max() ?? 1
            let span = max(hi - lo, 0.0001)
            let rising = (chart.last ?? 0) >= (chart.first ?? 0)
            let tint = rising ? Term.positive : Term.negative
            VStack(alignment: .leading, spacing: 3) {
                GeometryReader { geo in
                    let w = geo.size.width
                    let h = geo.size.height
                    let step = w / CGFloat(max(chart.count - 1, 1))
                    let pt: (Int) -> CGPoint = { idx in
                        CGPoint(x: CGFloat(idx) * step,
                                y: h - CGFloat((chart[idx] - lo) / span) * h)
                    }
                    ZStack {
                        // Filled under the line, the way a terminal
                        // draws it — the shape reads at a glance and
                        // the axis labels are the range beneath.
                        Path { p in
                            p.move(to: CGPoint(x: 0, y: h))
                            for idx in chart.indices { p.addLine(to: pt(idx)) }
                            p.addLine(to: CGPoint(x: w, y: h))
                            p.closeSubpath()
                        }
                        .fill(LinearGradient(colors: [tint.opacity(0.22), tint.opacity(0.01)],
                                             startPoint: .top, endPoint: .bottom))
                        Path { p in
                            for idx in chart.indices {
                                idx == 0 ? p.move(to: pt(idx)) : p.addLine(to: pt(idx))
                            }
                        }
                        .stroke(tint, style: StrokeStyle(lineWidth: 1.2, lineJoin: .round))
                    }
                }
                .frame(height: 54)
                HStack {
                    Text(chartRange.map { $0.uppercased() } ?? "")
                        .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                    Spacer()
                    Text("\(Fmt.money(lo)) – \(Fmt.money(hi))")
                        .font(Term.mono(8)).foregroundStyle(Term.fgMuted)
                }
            }
        }
    }



    // MARK: The club

    /// What WE know about this name, above everything a browser could
    /// tell you.
    ///
    /// Placed directly under the price on purpose. Of thirty-five panels
    /// in this app only five touched club-owned data, and they were the
    /// five nobody opens in a normal week — so the club's own record sat
    /// in rooms members never walked into. This is the first screen
    /// every ticker lookup lands on.
    @ViewBuilder
    private func clubBlock() -> some View {
        if let c = coverage, hasAnything(c) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    SectionLabel(text: "The club")
                    if let h = c.holding, (h.shares ?? 0) > 0 {
                        Text("HELD")
                            .font(Term.mono(9, weight: .bold))
                            .foregroundStyle(Term.positive)
                    } else if (c.decisions ?? []).contains(where: { $0.decision == "Sell" }) {
                        // Sold is not the same as never owned, and the
                        // difference is the whole lesson of the position.
                        Text("EXITED")
                            .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.fgMuted)
                    }
                    Spacer()
                }

                if let h = c.holding, (h.shares ?? 0) > 0 {
                    StatRow(label: "Position",
                            value: "\(Fmt.compact(h.shares)) sh at \(Fmt.money(h.costBasis)) blended")
                }

                // The research desk's coverage: who opened the work,
                // when it was initiated, and the price the valuation
                // says we would want. The initiation date is createdAt
                // on purpose — the updated stamp moves whenever a row
                // is relabelled and had every project reading "Aug 6".
                ForEach(Array((c.research ?? []).prefix(2).enumerated()), id: \.offset) { _, r in
                    VStack(alignment: .leading, spacing: 2) {
                        StatRow(label: "Coverage",
                                value: [r.analyst,
                                        r.initiatedAt.map { "initiated \(Fmt.date($0))" },
                                        r.status?.lowercased()]
                                    .compactMap { $0 }.joined(separator: " · "))
                        if let b = r.buyBelow {
                            StatRow(label: "Buy below",
                                    value: "\(r.currency ?? "USD") \(Fmt.money(b))")
                        }
                    }
                }

                if let p = (c.pitches ?? []).first {
                    let who = (p.presenters ?? []).joined(separator: ", ")
                    StatRow(label: "Pitched",
                            value: [who.isEmpty ? nil : who, p.date.map { Fmt.date($0) }]
                                .compactMap { $0 }.joined(separator: " · "))
                }

                // Written reports ARE coverage — most of the club's
                // pre-app work lives here, and a held name with three
                // reports on file used to read "never pitched or voted"
                // as if nobody had ever looked at it.
                ForEach(Array((c.reports ?? []).prefix(2).enumerated()), id: \.offset) { _, r in
                    StatRow(label: "Report",
                            value: [r.title, r.author, r.date.map { Fmt.date($0) }]
                                .compactMap { $0 }.joined(separator: " · "))
                }

                // Newest decision first. A name can carry several — a buy
                // and a later sell — and the pair is the record worth
                // reading.
                ForEach(Array((c.decisions ?? []).prefix(3).enumerated()), id: \.offset) { _, d in
                    decisionRow(d)
                }

                if (c.decisions ?? []).isEmpty && (c.pitches ?? []).isEmpty
                    && (c.reports ?? []).isEmpty && (c.research ?? []).isEmpty {
                    Text("Owned, but no pitch, vote, report, or research project on file.")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Term.bgHeader)
            .overlay(alignment: .leading) { Rectangle().fill(Term.amber).frame(width: 2) }
        }
    }

    private func hasAnything(_ c: Coverage) -> Bool {
        (c.holding != nil && (c.holding?.shares ?? 0) > 0)
            || !(c.decisions ?? []).isEmpty
            || !(c.pitches ?? []).isEmpty
            || !(c.research ?? []).isEmpty
            || !(c.reports ?? []).isEmpty
    }

    @ViewBuilder
    private func decisionRow(_ d: Coverage.Decision) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
                Text(d.decision?.uppercased() ?? "—")
                    .font(Term.mono(10, weight: .bold))
                    .foregroundStyle(tone(d.decision))
                Text([d.closedAt.map { Fmt.date($0) },
                      d.ballots.map { "\($0) ballot\($0 == 1 ? "" : "s")" }]
                        .compactMap { $0 }.joined(separator: " · "))
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                // What the room wanted, beside what it got. A position
                // the club proposed at $4,000 and sized at $9,000 is a
                // fact nobody can currently see.
                if let avg = d.proposed?.avg, avg > 0 {
                    Text("proposed \(Fmt.money(avg)) avg")
                        .font(Term.mono(9)).foregroundStyle(Term.fgDim)
                }
                Spacer()
            }
            if let syn = d.synthesis, !syn.isEmpty {
                Text(syn)
                    .font(Term.mono(9)).foregroundStyle(Term.fgDim)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func tone(_ decision: String?) -> Color {
        switch decision {
        case "Buy": return Term.positive
        case "Sell": return Term.negative
        default: return Term.fgDim
        }
    }

    // MARK: The blocks Bloomberg puts beside the description

    /// What the street expects next, and how the last one went.
    @ViewBuilder
    private func estimatesBlock() -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Estimates")
            if let e = estimates, e.upcoming != nil || !(e.history ?? []).isEmpty {
                StatRow(label: "Next report", value: e.upcoming?.date ?? "—")
                StatRow(label: "EPS estimate",
                        value: e.upcoming?.epsEstimate.map { String(format: "%.2f", $0) } ?? "—")
                if let last = (e.history ?? []).first {
                    StatRow(label: "Last \(last.period ?? "quarter")",
                            value: last.epsActual.map { String(format: "%.2f", $0) } ?? "—")
                    // The surprise is the part that carries information:
                    // a beat and a miss are the same number until you
                    // know what was expected.
                    if let s = last.surprisePct {
                        HStack {
                            Text("Surprise").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                            Spacer()
                            Text(Fmt.pct(s))
                                .font(Term.mono(10, weight: .medium))
                                .foregroundStyle(Term.delta(s))
                        }
                    }
                }
            } else {
                Text("No estimates on file.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
        }
    }

    /// The analyst split, as a bar rather than five numbers.
    ///
    /// "7 strong buy, 14 buy, 11 hold, 1 sell" is four facts nobody
    /// holds in their head; the shape of the bar is the one they wanted.
    @ViewBuilder
    private func ratingsBlock() -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Analysts")
            if let c = consensus, c.total > 0 {
                GeometryReader { geo in
                    HStack(spacing: 1) {
                        let w = geo.size.width
                        let unit = w / CGFloat(c.total)
                        Rectangle().fill(Term.positive)
                            .frame(width: unit * CGFloat(c.bullish))
                        Rectangle().fill(Term.fgMuted)
                            .frame(width: unit * CGFloat(c.hold ?? 0))
                        Rectangle().fill(Term.negative)
                            .frame(width: unit * CGFloat(c.bearish))
                    }
                }
                .frame(height: 8)
                HStack(spacing: 8) {
                    Text("\(c.bullish) buy").font(Term.mono(9)).foregroundStyle(Term.positive)
                    Text("\(c.hold ?? 0) hold").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    Text("\(c.bearish) sell").font(Term.mono(9)).foregroundStyle(Term.negative)
                    Spacer()
                    Text("\(c.total)").font(Term.mono(9)).foregroundStyle(Term.fgDim)
                }
            } else {
                Text("No analyst coverage on file.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
        }
    }

    /// Who runs it. Read from ownership filings rather than the proxy,
    /// so a chief executive who started this year is the one named.
    @ViewBuilder
    private func managementBlock() -> some View {
        let people = ([leadership?.ceo].compactMap { $0 } + (leadership?.execs ?? []))
            .reduce(into: [Leadership.Person]()) { acc, p in
                if !acc.contains(where: { $0.name == p.name }) { acc.append(p) }
            }
            .prefix(4)
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Management")
            if people.isEmpty {
                Text("No officers on file.")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            } else {
                ForEach(Array(people.enumerated()), id: \.offset) { _, p in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(p.name ?? "—")
                            .font(Term.mono(10, weight: .medium)).foregroundStyle(Term.white)
                            .lineLimit(1)
                        Text(p.title ?? "—")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(1)
                    }
                }
            }
        }
    }

    // MARK: Columns

    private func stats(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Valuation")
            StatRow(label: "Market cap", value: Fmt.compact(i.marketCap))
            StatRow(label: "Trailing P/E", value: i.trailingPE.map { Fmt.money($0) } ?? "—")
            StatRow(label: "Forward P/E", value: i.forwardPE.map { Fmt.money($0) } ?? "—")
            StatRow(label: "Dividend yield",
                    value: i.dividendYield.map { Fmt.pct($0 * 100, signed: false) } ?? "—")
            StatRow(label: "Beta", value: i.beta.map { String(format: "%.2f", $0) } ?? "—")
            StatRow(label: "Previous close", value: Fmt.money(i.previousClose))
            StatRow(label: "Avg volume", value: Fmt.compact(i.avgVolume))
            StatRow(label: "52w range",
                    value: (i.fiftyTwoWeekLow != nil && i.fiftyTwoWeekHigh != nil)
                        ? "\(Fmt.money(i.fiftyTwoWeekLow))  –  \(Fmt.money(i.fiftyTwoWeekHigh))"
                        : "—")
            rangeBar(i)
        }
    }

    /// Where today sits in the year's range. The two numbers alone do
    /// not answer "is this near its high", which is the question anybody
    /// reading them is asking.
    @ViewBuilder
    private func rangeBar(_ i: Info) -> some View {
        if let lo = i.fiftyTwoWeekLow, let hi = i.fiftyTwoWeekHigh,
           let p = i.price, hi > lo {
            let frac = min(max((p - lo) / (hi - lo), 0), 1)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Term.border).frame(height: 3)
                    Circle().fill(Term.amber)
                        .frame(width: 7, height: 7)
                        .offset(x: geo.size.width * CGFloat(frac) - 3.5)
                }
                .frame(height: 8)
            }
            .frame(height: 8)
            .padding(.top, 2)
            .help("\(Int(frac * 100))% of the way up the 52-week range")
        }
    }

    private func corporate(_ i: Info) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel(text: "Corporate")
            StatRow(label: "Head office", value: i.headquarters ?? "—")
            StatRow(label: "Founded", value: i.founded.map(String.init) ?? "—")
            StatRow(label: "Employees",
                    value: i.employees.map { Fmt.compact($0) } ?? "—")
            StatRow(label: "Fiscal year end", value: i.fiscalYearEnd ?? "—")
            StatRow(label: "Incorporated", value: i.stateOfIncorporation ?? "—")
            StatRow(label: "Phone", value: i.phone ?? "—")
            if let w = i.website, !w.isEmpty {
                Button {
                    if let u = URL(string: w) { NSWorkspace.shared.open(u) }
                } label: {
                    HStack(spacing: 0) {
                        Text("Website").font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                        Spacer()
                        Text(w.replacingOccurrences(of: "https://", with: ""))
                            .font(Term.mono(10)).foregroundStyle(Term.blue).lineLimit(1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            // A company that changed its name is worth knowing about:
            // Applied Industrial filed as Bearings Inc, and a search of
            // old coverage under the current name finds nothing.
            if let f = i.formerNames, !f.isEmpty {
                Text("Formerly \(f.joined(separator: ", "))")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .padding(.top, 2)
            }
        }
    }

    // MARK: Description

    @ViewBuilder
    private func business(_ i: Info) -> some View {
        if (i.description ?? i.summary)?.isEmpty == false {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    SectionLabel(text: "Business")
                    // Say where the paragraph came from, in words. The
                    // panel used to print the summary and then the raw
                    // Item 1 straight underneath it behind an "AS FILED"
                    // tag, which read as the same company described
                    // twice for no stated reason. One is ours, one is
                    // theirs, and a reader cannot be expected to infer
                    // that from a two-word label.
                    if i.description?.isEmpty == false {
                        Text("summarised from the filing")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                            .help("Written by our own model from the 10-K's Item 1 and nothing else — it is not allowed to add a fact the filing does not state. The filing's own wording is underneath, unedited.")
                    }
                    if let src = i.summarySource, let filed = src.filedAt {
                        // The company's own words, and which filing they
                        // are from — a description with no date is an
                        // assertion.
                        Button {
                            if let u = src.url, let url = URL(string: u) { NSWorkspace.shared.open(url) }
                        } label: {
                            Text("\(src.form ?? "10-K") filed \(filed)")
                                .font(Term.mono(9)).foregroundStyle(Term.blue)
                        }
                        .buttonStyle(.plain)
                        .help("Open the filing on EDGAR")
                    }
                    Spacer()
                }
                // Lead with the readable rewrite where the server made
                // one — tight, third person, data-provider register.
                // The filing's own first-person prose stays underneath,
                // dimmer, because it is the primary source the rewrite
                // was distilled from.
                if let d = i.description, !d.isEmpty {
                    Text(d)
                        .font(Term.mono(11))
                        .foregroundStyle(Term.fg)
                        .lineSpacing(2)
                        .textSelection(.enabled)
                }
                if let s = i.summary, !s.isEmpty {
                    if i.description?.isEmpty == false {
                        // FOLDED AWAY, not deleted. Item 1 is the
                        // primary source and it has to stay reachable —
                        // but it runs to thousands of words of the
                        // company's own first-person prose (General
                        // Dynamics opens "We offer a broad portfolio of
                        // products and services in business aviation"),
                        // and pasting all of it under a four-sentence
                        // summary of itself is what made this section
                        // look like a mistake.
                        Button {
                            showFiled.toggle()
                        } label: {
                            HStack(spacing: 4) {
                                Text(showFiled ? "▾" : "▸")
                                Text(showFiled
                                     ? "Hide the filing's own words"
                                     : "Read the filing's own words (Item 1, \(s.count.formatted()) characters)")
                            }
                            .font(Term.mono(9)).foregroundStyle(Term.blue)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 4)
                        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }

                        if showFiled {
                            Text(s)
                                .font(Term.mono(10))
                                .foregroundStyle(Term.fgDim)
                                .lineSpacing(2)
                                .textSelection(.enabled)
                        }
                    } else {
                        // No summary was produced, so the filing IS the
                        // description. Shown outright and at full size —
                        // hiding the only text there is behind a
                        // disclosure would leave an empty panel.
                        Text(s)
                            .font(Term.mono(11))
                            .foregroundStyle(Term.fgDim)
                            .lineSpacing(2)
                            .textSelection(.enabled)
                    }
                }
            }
        } else {
            // Absence of a summary is a fact about the source, not a
            // rendering gap. EDGAR has no Item 1 for foreign issuers or
            // ETFs.
            Text("No business summary. Foreign issuers and ETFs often have no US 10-K to draw one from.")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
        }
    }

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("DES needs a ticker.")
            return
        }
        state = .loading
        chart = []
        chartRange = nil
        // Folded back up on every new ticker. @State outlives the load,
        // so without this an expanded Item 1 stays expanded into the
        // next company and the disclosure reads as the panel's default.
        showFiled = false
        estimates = nil
        consensus = nil
        leadership = nil
        coverage = nil
        do {
            let data = try await API.shared.get("/holdings/info/\(ticker)")
            state = .loaded(try await API.shared.decode(Info.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
            return
        }
        // Separate and deliberately after: the snapshot IS the panel and
        // everything below is decoration on it. Each is optional and
        // each failure is silent by design — a missing analyst count
        // must never be the reason the company's name does not appear.
        if let d = try? await API.shared.get("/terminal/chart/\(ticker)"),
           let c = try? await API.shared.decode(Chart.self, from: d) {
            chart = (c.points ?? []).compactMap { $0.close }
            chartRange = c.range
        }
        if let d = try? await API.shared.get("/terminal/earnings/\(ticker)") {
            estimates = try? await API.shared.decode(Estimates.self, from: d)
        }
        if let d = try? await API.shared.get("/terminal/consensus/\(ticker)"),
           let c = try? await API.shared.decode(Consensus.self, from: d) {
            consensus = c.latest
        }
        if let d = try? await API.shared.get("/terminal/governance/\(ticker)") {
            leadership = try? await API.shared.decode(Leadership.self, from: d)
        }
        if let d = try? await API.shared.get("/holdings/coverage/\(ticker)") {
            coverage = try? await API.shared.decode(Coverage.self, from: d)
        }
    }
}
