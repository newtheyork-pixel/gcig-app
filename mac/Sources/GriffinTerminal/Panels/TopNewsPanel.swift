import SwiftUI

// TOP — the market-wide wire.
//
// The server merges Finnhub with keyless public RSS (Fed releases, WSJ
// Markets, CNBC, MarketWatch) and dedupes on URL. It returns 502 when it
// has nothing at all, which is why a failure here is rendered as a
// failure: a blank news panel and a broken news panel look identical
// otherwise, and one of them means the market is quiet.
struct TopNewsPanel: View {
    struct Article: Decodable, Identifiable {
        let title: String
        let url: String
        let source: String?
        let publishedAt: String?
        /// Held-name badge: set when the headline mentions a portfolio
        /// company, so the club's own names stand out on the wire.
        let heldTicker: String?
        var id: String { url }
    }

    struct Payload: Decodable {
        let articles: [Article]?
    }

    @State private var state: Loadable<[Article]> = .loading

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { $0.isEmpty },
                   emptyText: "The wire is quiet. Nothing published recently.",
                   retry: { Task { await load() } }) { articles in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(articles) { a in item(a) }
                }
            }
        }
        .task {
            // Load, then keep loading. A wire that renders once and
            // freezes is not a wire — the web polls every 60s and the
            // native panel showed whatever was true when it opened.
            await load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { break }
                await load(quietly: true)
            }
        }
    }

    private func item(_ a: Article) -> some View {
        Button {
            NotificationCenter.default.post(name: .openInReader, object: a.url)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(a.title)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if let h = a.heldTicker {
                        Text(h)
                            .font(Term.mono(9, weight: .bold))
                            .foregroundStyle(Term.bg)
                            .padding(.horizontal, 4)
                            .background(Term.amber)
                    }
                    if let s = a.source {
                        Text(s.uppercased())
                            .font(Term.mono(9, weight: .bold))
                            .foregroundStyle(Term.orange)
                    }
                    if let d = a.publishedAt {
                        Text(Fmt.date(d)).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
    }

    private func load(quietly: Bool = false) async {
        // A refresh keeps the list on screen; only the first load and a
        // manual retry may blank the panel into a spinner.
        if !quietly { state = .loading }
        do {
            let data = try await API.shared.get("/terminal/top-news", query: ["all": "1"])
            // The endpoint has returned both a bare array and { articles }
            // across versions; accept either rather than break on a shape.
            if let p = try? await API.shared.decode(Payload.self, from: data), let a = p.articles {
                state = .loaded(a)
            } else {
                state = .loaded(try await API.shared.decode([Article].self, from: data))
            }
        } catch {
            // A blip mid-poll keeps the last good headlines up; only a
            // load the user asked for reports failure.
            if !quietly { state = .failed(error.localizedDescription) }
        }
    }
}
