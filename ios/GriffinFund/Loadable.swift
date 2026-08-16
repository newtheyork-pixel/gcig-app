import SwiftUI

// The rule this file exists to enforce, inherited from the Mac's PanelKit:
// loading, failed and genuinely empty must never look alike. A spinner
// that stops on an error reads as "no data". An empty table under a
// successful header reads as "we checked, and there is nothing". Both have
// already put wrong numbers in front of people on the web side.
//
// The phone adds a fourth. Pull-to-refresh is an iOS path the Mac does not
// have, and it is the one place where a failed fetch leaves real numbers on
// the screen. Old numbers presented as current is the single lie a price
// screen must never tell, so staleness is a state and not a footnote. The
// first BookView had already grown a hand-rolled "Stale." section, which is
// the tell that it belonged here.

enum Loadable<T> {
    /// First load, or an explicit retry. Nothing to show yet.
    case loading
    /// Fresh, and when it became true.
    case loaded(T, at: Date)
    /// We have data, and the last refresh failed for the stated reason.
    case stale(T, String)
    /// Nothing to show, and the attempt failed.
    case failed(String)

    /// The payload, if any, for a store deciding whether a refresh can keep
    /// the screen populated.
    var value: T? {
        switch self {
        case .loaded(let v, _), .stale(let v, _): return v
        case .loading, .failed:                   return nil
        }
    }

    var loadedAt: Date? {
        if case .loaded(_, let at) = self { return at }
        return nil
    }
}

/// Every screen renders through this. It is the only place the four
/// branches exist, so no screen can collapse two of them, and empty is only
/// reachable through loaded: a thrown error has nowhere to land except the
/// failure state.
struct ScreenState<T, Content: View>: View {
    let state: Loadable<T>
    var emptyWhen: ((T) -> Bool)? = nil
    var emptyText = "Nothing to show."
    /// Some empty lists are good news and must read as good news.
    var emptyIsGood = false
    var retry: (() -> Void)? = nil
    @ViewBuilder let content: (T) -> Content

    var body: some View {
        switch state {
        case .loading:
            LoadingState()
        case .failed(let msg):
            ErrorState(message: msg, retry: retry)
        case .stale(let value, let msg):
            VStack(spacing: 0) {
                StaleStrip(message: msg, retry: retry)
                loadedBody(value)
            }
        case .loaded(let value, _):
            loadedBody(value)
        }
    }

    @ViewBuilder private func loadedBody(_ value: T) -> some View {
        if let emptyWhen, emptyWhen(value) {
            EmptyState(text: emptyText, good: emptyIsGood)
        } else {
            content(value)
        }
    }
}
