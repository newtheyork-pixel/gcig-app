import SwiftUI

// WL — names worth following, and where each one came from.
//
// Provenance is the column that matters. A ticker we own, a ticker a
// manager we respect disclosed in a filing, and a ticker somebody typed
// in are three different claims about how much attention a name has
// earned, and a watchlist that flattens them into one list cannot be
// weighed. So the source is a chip on every row and a filter across the
// top, and the two lists are never silently merged.
//
// The holdings come from the sheet rather than this table. The sheet is
// the system of record for what we own, and a second copy would be wrong
// the first time somebody traded.
struct WatchlistPanel: View {
    @State private var state: Loadable<Payload> = .loading
    @State private var adding = false
    @State private var newTicker = ""
    @State private var newNote = ""
    @State private var busy = false

    struct Payload: Decodable {
        let items: [Item]?
        let counts: Counts?
        let quotesAvailable: Bool?
        struct Counts: Decodable { let holdings: Int?; let seg13f: Int?; let manual: Int? }
    }

    struct Item: Decodable, Identifiable {
        let id: String
        let ticker: String
        let name: String?
        let source: String
        let note: String?
        let asOf: String?
        let shares: Double?
        let weight: Double?
        let alsoHeld: Bool?
        let quote: Quote?
        let stats: Stats?
        struct Quote: Decodable { let last: Double?; let changePct: Double?; let prevClose: Double? }
        /// Volume and the longer windows, off the same bars the charts
        /// use. Absent when a name has no usable history, which renders
        /// as dashes rather than zeros.
        struct Stats: Decodable {
            let avgVolume20d: Double?
            let pct1m: Double?
            let pct3m: Double?
            let pct1y: Double?
            let ytd: Double?
        }

        var display: (String, Color) {
            switch source {
            case "holding": return ("HELD", Term.positive)
            case "seg13f":  return ("SEG 13F", Term.blue)
            default:        return ("MANUAL", Term.fgMuted)
            }
        }
    }

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { ($0.items ?? []).isEmpty },
                   emptyText: "Nothing on the watchlist yet.",
                   retry: { Task { await load() } }) { p in
            // One list. Filtering by where a name came from split a
            // watchlist into four short lists nobody scanned; the source
            // is still on the row for anyone who wants it.
            let items = p.items ?? []
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                columnHeads
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { row($0) }
                    }
                }
            }
        }
        .task { await load() }
    }

    private func header(_ p: Payload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                SectionLabel(text: "Watchlist")
                Text("\((p.items ?? []).count) names")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                Spacer()
                if p.quotesAvailable == false {
                    // A blank price column and a dead vendor look the
                    // same. Say which one this is.
                    Text("NO QUOTES").font(Term.mono(9)).foregroundStyle(Term.amber)
                }
                Button(adding ? "Cancel" : "+ Add") { adding.toggle() }
                    .buttonStyle(TermButtonStyle()).disabled(busy)
            }
            if adding {
                HStack(spacing: 6) {
                    TextField("", text: $newTicker, prompt: Text("TICKER").foregroundStyle(Term.fgMuted))
                        .textFieldStyle(.plain).font(Term.mono(11)).foregroundStyle(Term.amber)
                        .padding(4).background(Term.bg).termBorder().frame(width: 100)
                    TextField("", text: $newNote, prompt: Text("Why it is here").foregroundStyle(Term.fgMuted))
                        .textFieldStyle(.plain).font(Term.mono(11)).foregroundStyle(Term.white)
                        .padding(4).background(Term.bg).termBorder().frame(maxWidth: 320)
                    Button("Add") { add() }
                        .buttonStyle(TermButtonStyle()).disabled(busy || newTicker.isEmpty)
                    Spacer()
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }


    private var columnHeads: some View {
        HStack(spacing: 8) {
            Text("TICKER").frame(width: 62, alignment: .leading)
            Text("SOURCE").frame(width: 62, alignment: .leading)
            Text("NAME").frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            Text("LAST").frame(width: 76, alignment: .trailing)
            Text("DAY").frame(width: 58, alignment: .trailing)
            Text("1M").frame(width: 58, alignment: .trailing)
            Text("3M").frame(width: 58, alignment: .trailing)
            Text("YTD").frame(width: 58, alignment: .trailing)
            Text("1Y").frame(width: 58, alignment: .trailing)
            Text("AVG VOL").frame(width: 74, alignment: .trailing)
        }
        .font(Term.mono(9, weight: .bold)).tracking(0.5)
        .foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func row(_ i: Item) -> some View {
        let (label, tone) = i.display
        return HStack(spacing: 8) {
            Button {
                NotificationCenter.default.post(name: .runCommand, object: "\(i.ticker) DES")
            } label: {
                Text(i.ticker)
                    .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
                    .frame(width: 62, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
            HStack(spacing: 3) {
                Text(label).font(Term.mono(9, weight: .bold)).foregroundStyle(tone)
                // A name on a filing that we also own is the most
                // interesting row on the list, so it is marked.
                if i.alsoHeld == true {
                    Text("•").font(Term.mono(9)).foregroundStyle(Term.positive)
                        .help("We hold this too")
                }
            }
            .frame(width: 62, alignment: .leading)
            Text(i.name ?? "")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                .lineLimit(1).frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            Text(Fmt.money(i.quote?.last))
                .frame(width: 76, alignment: .trailing).tickFlash(i.quote?.last)
            perf(i.quote?.changePct, 58)
            perf(i.stats?.pct1m, 58)
            perf(i.stats?.pct3m, 58)
            perf(i.stats?.ytd, 58)
            perf(i.stats?.pct1y, 58)
            Text(Self.vol(i.stats?.avgVolume20d))
                .foregroundStyle(Term.fgDim)
                .frame(width: 74, alignment: .trailing)
                .help("Average daily volume over the last 20 sessions")

        }
        .font(Term.mono(11)).foregroundStyle(Term.white)
        .padding(.horizontal, 10).padding(.vertical, 3)
    }

    private func perf(_ v: Double?, _ w: CGFloat) -> some View {
        Text(v.map { Fmt.pct($0, decimals: 1) } ?? "—")
            .foregroundStyle(Term.delta(v))
            .frame(width: w, alignment: .trailing)
    }

    /// Volume in the units a person reads it in. 1,240,000 is a number
    /// you have to count the digits of; 1.2M is one you do not.
    static func vol(_ v: Double?) -> String {
        guard let v, v > 0 else { return "—" }
        if v >= 1_000_000_000 { return String(format: "%.1fB", v / 1_000_000_000) }
        if v >= 1_000_000 { return String(format: "%.1fM", v / 1_000_000) }
        if v >= 1_000 { return String(format: "%.0fK", v / 1_000) }
        return String(format: "%.0f", v)
    }

    private func add() {
        let t = newTicker.uppercased(), n = newNote
        busy = true
        Task {
            _ = try? await API.shared.post("/watchlist", json: ["ticker": t, "note": n, "source": "manual"])
            newTicker = ""; newNote = ""; adding = false; busy = false
            await load()
        }
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/watchlist")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
