import SwiftUI

// SPLC — supply-chain relationships read out of the focused ticker's
// latest 10-K, from /terminal/supply-chain/:ticker.
//
// This is the honest, free-tier cousin of Bloomberg's SPLC: no
// quantified 100k-company graph, only what the company itself
// discloses — customers above the 10% threshold (with the stated
// percentage), named principal suppliers, and key inputs. The footer
// says so plainly, so nobody mistakes a single-filing read for a
// market-wide network.
//
// Two shapes of "nothing" that must not blur: a 404 means there is no
// US 10-K at all (foreign filers, ETFs) and arrives as the server's
// own sentence through the failed branch; a 200 with three empty
// arrays means the filing was read and names nobody — that renders
// inline, keeping the header and source line, because "we looked and
// the filing is quiet" is a finding, not an absence of one.
struct SupplyChainPanel: View {
    let ticker: String

    // One shape for all three lists; suppliers and materials simply
    // never carry `pct`. The server guarantees pct is null rather
    // than 0 when unstated, and we render null as an em dash.
    struct Entity: Decodable, Identifiable {
        let name: String
        let note: String?
        let pct: Double?
        var id: String { name }
    }

    struct Payload: Decodable {
        let ticker: String?
        let sourceForm: String?
        let sourceDate: String?
        let sourceUrl: String?
        let summary: String?
        let concentration: String?
        let customers: [Entity]?
        let suppliers: [Entity]?
        let materials: [Entity]?
    }

    @State private var state: Loadable<Payload> = .loading

    var body: some View {
        // No emptyWhen here on purpose: the web keeps the header, the
        // filing read, and the source footer around its empty-state
        // sentence, so the empty branch lives inside the content.
        PanelState(state: state,
                   retry: { Task { await load() } }) { p in
            let customers = p.customers ?? []
            let suppliers = p.suppliers ?? []
            let materials = p.materials ?? []

            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if let s = p.summary, !s.isEmpty { filingRead(s) }
                        if let c = p.concentration, !c.isEmpty {
                            concentrationBlock(c)
                        }
                        if customers.isEmpty && suppliers.isEmpty
                            && materials.isEmpty {
                            emptySentence
                        }
                        if !customers.isEmpty { customersSection(customers) }
                        if !suppliers.isEmpty { suppliersSection(suppliers) }
                        if !materials.isEmpty { materialsSection(materials) }
                        footer(p)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .task(id: ticker) { await load() }
    }

    // MARK: Header

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            Text(p.ticker ?? ticker.uppercased())
                .font(Term.mono(12, weight: .bold))
                .foregroundStyle(Term.amber)
            Text("Supply Chain")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
            Text("Relationships from the latest 10-K")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Blocks

    private func filingRead(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("◢ FILING READ")
                .font(Term.mono(9, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(Term.amber)
            Text(text)
                .font(Term.mono(11))
                .foregroundStyle(Term.fgDim)
                .lineSpacing(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .overlay(Rectangle().strokeBorder(Term.fgMuted, lineWidth: 1))
    }

    // The one orange label in the panel — concentration risk is the
    // fact an analyst opens SPLC for, so it gets the warning hue.
    private func concentrationBlock(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("CUSTOMER CONCENTRATION")
                .font(Term.mono(9, weight: .bold))
                .tracking(1.4)
                .foregroundStyle(Term.orange)
            Text(text)
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .lineSpacing(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Term.bgPanelHover)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    // The web's sentence, verbatim. An empty read is the expected
    // answer for plenty of real companies, and saying why beats a
    // blank pane that looks broken.
    private var emptySentence: some View {
        Text("The latest 10-K names no specific customers, suppliers, or inputs — common for diversified consumer names that disclose no single customer above the 10% threshold.")
            .font(Term.mono(11))
            .foregroundStyle(Term.fgMuted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 8)
    }

    // MARK: Customers

    private func customersSection(_ customers: [Entity]) -> some View {
        // The largest stated share pins the bar rail, so a single 12%
        // customer reads as a full bar rather than a sliver against an
        // implied 100%. Same scale rule as the web.
        let maxPct = customers.compactMap(\.pct).max() ?? 0
        return VStack(alignment: .leading, spacing: 3) {
            SectionLabel(text: "Customers")
            Divider().overlay(Term.border)
            ForEach(customers) { c in
                HStack(spacing: 10) {
                    entityButton(c.name)
                    if let pct = c.pct {
                        exposureBar(pct: pct, maxPct: maxPct)
                    } else {
                        noteText(c.note)
                    }
                    Text(pctText(c.pct))
                        .font(Term.mono(11, weight: .medium))
                        .foregroundStyle(Term.white)
                        .frame(width: 52, alignment: .trailing)
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func exposureBar(pct: Double, maxPct: Double) -> some View {
        GeometryReader { geo in
            // Web floor: even the smallest stated share paints at
            // least 4% of the rail, so it exists to the eye.
            let frac = maxPct > 0 ? max(0.04, pct / maxPct) : 0
            Rectangle()
                .fill(Term.amber)
                .frame(width: geo.size.width * frac)
        }
        .frame(height: 10)
        .frame(maxWidth: .infinity)
        .background(Term.bgPanelHover)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
        .help(pctText(pct) + " of revenue")
    }

    // MARK: Suppliers

    private func suppliersSection(_ suppliers: [Entity]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            SectionLabel(text: "Suppliers & Partners")
            Divider().overlay(Term.border)
            ForEach(suppliers) { sp in
                HStack(spacing: 10) {
                    entityButton(sp.name)
                    noteText(sp.note)
                }
                .padding(.vertical, 2)
            }
        }
    }

    // MARK: Materials

    private func materialsSection(_ materials: [Entity]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            SectionLabel(text: "Key Inputs & Raw Materials")
            Divider().overlay(Term.border)
            ChipFlow(spacing: 6) {
                ForEach(materials) { m in
                    Text(m.name)
                        .font(Term.mono(10))
                        .foregroundStyle(Term.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .overlay(Rectangle().strokeBorder(Term.border,
                                                          lineWidth: 1))
                        .help(m.note ?? "")
                }
            }
        }
    }

    // MARK: Footer

    private func footer(_ p: Payload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider().overlay(Term.border)
            HStack(spacing: 6) {
                Text("Extracted by LLM from \(p.sourceForm ?? "10-K")"
                     + (p.sourceDate.map { " filed \($0)" } ?? ""))
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
                if let s = p.sourceUrl, let u = URL(string: s) {
                    Text("·").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    Button("view filing") { NSWorkspace.shared.open(u) }
                        .buttonStyle(.plain)
                        .font(Term.mono(9))
                        .foregroundStyle(Term.fgDim)
                        .underline()
                        .pointerCursor()
                }
                Spacer()
            }
            Text("Names are the filing's; percentages only where the 10-K states them. Not a market-wide graph — this is a single-filing read, not Bloomberg's SPLC dataset.")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Shared row pieces

    private func entityButton(_ name: String) -> some View {
        Button { drill(name) } label: {
            Text(name)
                .font(Term.mono(11))
                .foregroundStyle(Term.amber)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: 180, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Look up \(name)")
        .pointerCursor()
    }

    private func noteText(_ note: String?) -> some View {
        Text(note ?? "")
            .font(Term.mono(10))
            .foregroundStyle(Term.fgDim)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Web renders the stated share as the filing wrote it — "12%",
    /// "10.5%" — never a signed two-decimal delta. Nil is an em dash.
    private func pctText(_ v: Double?) -> String {
        guard let v else { return "—" }
        return Fmt.pct(v, decimals: v == v.rounded() ? 0 : 1, signed: false)
    }

    // MARK: Drill-down

    // Best-effort, same as the web: hand the name to the server's
    // command parser, which resolves well-known public companies to a
    // ticker, then open its DES through the shell. Private or
    // unresolved names simply don't open — there's no ticker to land
    // on, and inventing one would be worse than nothing.
    private func drill(_ name: String) {
        Task { @MainActor in
            guard let cmd = try? await API.shared.parseCommand(name),
                  let t = cmd.ticker, !t.isEmpty else { return }
            NotificationCenter.default.post(name: .runCommand,
                                            object: "\(t.uppercased()) DES")
        }
    }

    // MARK: Load

    private func load() async {
        guard !ticker.isEmpty else {
            state = .failed("SPLC needs a ticker.")
            return
        }
        state = .loading
        do {
            // A 404 here is the no-US-10-K case; API surfaces the
            // server's own sentence and PanelState names it a failure,
            // which is exactly the web's error render of it.
            let data = try await API.shared.get("/terminal/supply-chain/\(ticker)")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

// A minimal wrapping row for the material chips — SwiftUI has no
// public flow container, and a grid would force uniform cell widths
// on chips whose whole look is hugging their word.
private struct ChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews,
                      cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        var maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width {
                x = 0; y += rowH + spacing; rowH = 0
            }
            x += s.width + spacing
            maxX = max(maxX, x - spacing)
            rowH = max(rowH, s.height)
        }
        return CGSize(width: width.isFinite ? width : maxX,
                      height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize,
                       subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX {
                x = bounds.minX; y += rowH + spacing; rowH = 0
            }
            v.place(at: CGPoint(x: x, y: y),
                    proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}

// The web turns the pointer into a hand over every clickable entity;
// AppKit needs to be asked.
private extension View {
    func pointerCursor() -> some View {
        onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
    }
}
