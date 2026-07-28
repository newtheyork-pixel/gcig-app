import SwiftUI

// MOVR — the day's moves across the book.
//
// Shape comes from getPortfolioMovers in sheetPortfolio.js. The field
// worth carrying over most carefully is `unpriced`: the server counts
// positions it could not price and hands the number back precisely so a
// panel showing 3 of 13 holdings does not read as a 3-holding book. That
// bug already happened once on the web (MOVR ranked 1 of 12), so the
// count is rendered, not dropped.
//
// Two feeds, the web Movers.jsx split. The SHEET decides the list —
// which tickers, the order, cash-exclusion, the header counts — and is
// fetched once, plus manual Retry. Re-polling it was this panel's dead
// end: the sheet read is server-cached far longer than any sane poll,
// so a 30s re-fetch returned identical numbers and the tick flash had
// nothing to fire on. LAST and DAY % instead go live off
// GET /terminal/quotes on a 20s loop while the panel is open — 20s is
// also the server's per-ticker quote TTL (liveQuotes.QUOTE_TTL_MS), so
// most polls can actually carry a new print. The overlay changes only
// the two price columns; order and counts stay the sheet's, exactly as
// the web leaves them.
struct MoversPanel: View {
    struct Row: Decodable, Identifiable {
        let ticker: String
        let name: String?
        let last: Double?
        let dayUsd: Double?
        let changePct: Double?
        let source: String?
        var id: String { ticker }
    }

    struct Payload: Decodable {
        let asOf: String?
        let count: Int?
        let positions: Int?
        let unpriced: Int?
        let rows: [Row]
    }

    /// One /terminal/quotes value. A ticker Finnhub missed comes back
    /// as JSON null; it never lands in `quotes`, so a miss keeps
    /// whatever the cell was already showing.
    struct Quote: Decodable {
        let last: Double?
        let changePct: Double?
        let prevClose: Double?
    }

    @State private var state: Loadable<Payload> = .loading
    @State private var quotes: [String: Quote] = [:]

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.rows.isEmpty },
                   emptyText: "No priced positions in the book today.",
                   retry: { Task { await load() } }) { p in
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider().overlay(Term.border)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(p.rows) { r in row(merged(r)) }
                    }
                }
            }
        }
        .task {
            await load()
            // Only the quote overlay loops. The sheet is never
            // re-fetched here, so loading / failed / empty stay owned
            // by load() and the Retry button alone — the loop just
            // reads whatever the loaded sheet says to poll.
            while !Task.isCancelled {
                await pollQuotes()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    /// Overlay a live quote onto a sheet row, in place.
    ///
    /// UNITS BOUNDARY: /terminal/quotes' changePct is Finnhub's `dp`,
    /// ALREADY a percent (1.23 == +1.23%); the sheet rows — and the
    /// Fmt.pct call in row(), which does the ×100 — speak the fraction
    /// convention (0.0123 == +1.23%). The ÷100 here is the only place
    /// the two conventions meet; everything downstream is a fraction.
    private func merged(_ r: Row) -> Row {
        guard let q = quotes[r.ticker.uppercased()] else { return r }
        return Row(ticker: r.ticker,
                   name: r.name,
                   last: q.last ?? r.last,
                   dayUsd: r.dayUsd,
                   changePct: q.changePct.map { $0 / 100 } ?? r.changePct,
                   source: r.source)
    }

    // The live tap. A failed poll returns silently and the last good
    // overlay stands — same swallow as the web's useLiveRefresh — and
    // per-ticker nulls are skipped, so a value is never wiped to nil.
    private func pollQuotes() async {
        guard case .loaded(let p) = state, !p.rows.isEmpty else { return }
        let key = Set(p.rows.map { $0.ticker.uppercased() })
            .sorted().joined(separator: ",")
        guard let data = try? await API.shared.get("/terminal/quotes",
                                                   query: ["tickers": key]),
              let q = try? await API.shared.decode([String: Quote?].self,
                                                   from: data) else { return }
        for (t, v) in q { if let v { quotes[t] = v } }
    }

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Movers")
            Text("\(p.rows.count) of \(p.positions ?? p.rows.count) priced")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            // The whole point: an unpriced position is stated, never
            // silently omitted from a ranking that looks complete.
            if let u = p.unpriced, u > 0 {
                Text("\(u) unpriced")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.negative)
            }
            Spacer()
            if let d = p.asOf {
                Text(d).font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func row(_ r: Row) -> some View {
        HStack(spacing: 8) {
            // Drill-down: the ticker is a door, same as the web.
            Button {
                NotificationCenter.default.post(name: .runCommand, object: "\(r.ticker) DES")
            } label: {
                Text(r.ticker)
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(Term.amber)
                    .frame(width: 62, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
            Text(r.name ?? "")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(Fmt.money(r.last))
                .font(Term.mono(11))
                .foregroundStyle(Term.white)
                .frame(width: 74, alignment: .trailing)
                .tickFlash(r.last)
            Text(Fmt.pct(r.changePct.map { $0 * 100 }))
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(Term.delta(r.changePct))
                .frame(width: 68, alignment: .trailing)
                .tickFlash(r.changePct)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/movers")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
