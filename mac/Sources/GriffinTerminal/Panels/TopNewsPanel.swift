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
        let summary: String?
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
        .task { await load() }
    }

    private func item(_ a: Article) -> some View {
        Button {
            if let u = URL(string: a.url) { NSWorkspace.shared.open(u) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(a.title)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.white)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
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

    private func load() async {
        state = .loading
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
            state = .failed(error.localizedDescription)
        }
    }
}
