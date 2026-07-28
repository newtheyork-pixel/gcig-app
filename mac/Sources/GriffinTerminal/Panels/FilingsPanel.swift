import SwiftUI

// FIL — a ticker's recent SEC filings off the EDGAR submissions feed
// (8-K, 10-Q, 10-K, DEF 14A, Form 4 …), with the panel-level AI brief
// the web version generates from the same list.
//
// One thing to know about the endpoint: it never fails. The route
// degrades every miss — unknown ticker, SEC unreachable, cache cold —
// to a 200 with an empty filings array, so the empty state below is
// doing double duty and its wording is deliberately about the data
// source, not about an error. A genuine transport failure to OUR
// server still surfaces as a failure through PanelState.
struct FilingsPanel: View {
    let ticker: String

    struct Filing: Decodable {
        let form: String?
        let filingDate: String?
        let description: String?
        let accessionNumber: String?
        let url: String?
    }

    struct Payload: Decodable {
        let ticker: String?
        let filings: [Filing]
    }

    private struct Brief: Decodable {
        let brief: String?
    }

    @State private var state: Loadable<Payload> = .loading
    // The brief is garnish, not the panel. It loads after the table is
    // already on screen and a failure collapses to "No brief
    // available." exactly as the web does — the filings list must
    // never wait on, or be hidden behind, an LLM round trip.
    @State private var briefLoading = false
    @State private var brief = ""

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.filings.isEmpty },
                   emptyText: "No recent SEC filings for \(ticker.uppercased()). Cash labels, ETFs with sparse schedules, and thinly-covered foreign issues often have nothing in the recent EDGAR window.",
                   retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                briefBlock
                ScrollView {
                    LazyVStack(spacing: 0) {
                        // EDGAR accession numbers are unique in
                        // practice but every field here is optional on
                        // paper, so identity comes from position — the
                        // list is replaced wholesale on reload, never
                        // diffed.
                        ForEach(Array(p.filings.enumerated()), id: \.offset) { _, f in
                            row(f)
                        }
                    }
                }
                Divider().overlay(Term.border)
                footer
            }
        }
        .task(id: ticker) { await load() }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            Text(p.ticker ?? ticker.uppercased())
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            Text("SEC Filings · \(p.filings.count) recent")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var briefBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("◢ AI BRIEF")
                .font(Term.mono(9, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(Term.amber)
            Text(briefLoading ? "Generating…"
                 : (brief.isEmpty ? "No brief available." : brief))
                .font(Term.mono(11))
                .italic(briefLoading)
                .foregroundStyle(Term.fgDim)
                .lineSpacing(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .overlay(Rectangle().strokeBorder(Term.fgMuted, lineWidth: 1))
        .padding(10)
    }

    private func row(_ f: Filing) -> some View {
        Button {
            // The web routes a plain click into an in-app PDF modal;
            // the native answer to "read the document" is the browser.
            if let s = f.url, let u = URL(string: s) {
                NSWorkspace.shared.open(u)
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // The form type is the tier chip of this panel: it is
                // what an analyst scans the column for.
                Text(f.form?.isEmpty == false ? f.form! : "—")
                    .font(Term.mono(9, weight: .bold))
                    .foregroundStyle(Term.cyan)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .overlay(Rectangle().strokeBorder(Term.cyan, lineWidth: 1))
                    .frame(width: 80, alignment: .leading)
                Text(Self.filedDate(f.filingDate))
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgDim)
                    .frame(width: 60, alignment: .leading)
                Text(f.description ?? f.form ?? "Filing")
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private var footer: some View {
        Text("SEC EDGAR submissions feed · newest first · 6h cache · click a row to open the filing on SEC.gov.")
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
    }

    // EDGAR hands dates as bare "YYYY-MM-DD" strings. Fmt.date expects
    // a full ISO timestamp and would fall through to echoing the raw
    // string, so this mirrors the web's fmtDate instead: pure string
    // slicing into MM/DD/YY, no Date round trip. The web's warning
    // holds here too — parsing a bare date lands on UTC midnight and
    // renders a day early anywhere west of Greenwich.
    private static func filedDate(_ s: String?) -> String {
        guard let s else { return "—" }
        let parts = s.prefix(10).split(separator: "-")
        guard parts.count == 3, parts[0].count == 4 else { return "—" }
        return "\(parts[1])/\(parts[2])/\(parts[0].suffix(2))"
    }

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("FIL needs a ticker.")
            return
        }
        state = .loading
        brief = ""
        do {
            let data = try await API.shared.get("/terminal/filings/\(ticker.uppercased())")
            let p = try await API.shared.decode(Payload.self, from: data)
            state = .loaded(p)
            // The confab-safe guard, same as the web: with zero
            // filings there is nothing for the model to read, so we
            // never ask it — the honest empty state beats an invited
            // fabrication.
            if !p.filings.isEmpty {
                await loadBrief(p)
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func loadBrief(_ p: Payload) async {
        briefLoading = true
        defer { briefLoading = false }
        // The context is built line-for-line the way the web builds
        // it, so both clients put the identical prompt in front of
        // the identical model and the briefs stay comparable.
        let tick = p.ticker ?? ticker.uppercased()
        let lines = p.filings.prefix(40).map { f in
            "\(Self.filedDate(f.filingDate)) \(f.form ?? "—") — \(f.description ?? f.form ?? "Filing")"
        }
        let context = (["Recent SEC filings for \(tick) (newest first):"] + lines)
            .joined(separator: "\n")
        do {
            let data = try await API.shared.post("/terminal/annotate", json: [
                "ticker": tick,
                "function": "FIL",
                "context": context,
            ])
            let b = try await API.shared.decode(Brief.self, from: data)
            brief = b.brief ?? ""
        } catch {
            brief = ""
        }
    }
}
