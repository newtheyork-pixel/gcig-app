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

    /// Staleness reachable by the CLOCK, not only by a failed refresh.
    ///
    /// `.stale` could previously only be entered through a refresh that
    /// errored, so data that was simply never refetched looked identical to
    /// data fetched a second ago — which on a price screen is the one lie
    /// this file exists to prevent. Ten minutes is chosen against the
    /// member's judgement rather than the market's: long enough that a
    /// quick tab switch does not cry stale, short enough that nobody acts
    /// on it.
    func aged(after seconds: TimeInterval, now: Date = Date()) -> Loadable<T> {
        guard case .loaded(let v, let at) = self,
              now.timeIntervalSince(at) > seconds else { return self }
        return .stale(v, "Last updated \(Fmt.since(at)). Pull to refresh.")
    }
}

/// The thing that makes `aged(after:)` actually fire.
///
/// `aged` is a pure function of the current time, evaluated while a view's
/// body runs — so on a screen nobody is touching, it is never re-evaluated
/// and the strip that says "these numbers are old" never appears, which is
/// precisely the screen it was written for. One shared minute tick drives
/// the re-render; a screen opts in by reading `clock.tick`.
///
/// One timer for the app, not one per screen, and on the common run-loop
/// mode so it keeps ticking while a list is being scrolled.
@MainActor
final class StaleClock: ObservableObject {
    static let shared = StaleClock()
    @Published private(set) var tick = Date()

    private init() {
        let t = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick = Date() }
        }
        RunLoop.main.add(t, forMode: .common)
    }
}

/// Refresh when the app comes back to the front, not only when a view
/// happens to be constructed.
///
/// There was no scene-phase handling anywhere in this app. A member who
/// locked their phone at the open and unlocked it at lunch was looking at
/// morning prices with nothing on screen saying so — the Mac added
/// sync-on-didBecomeActive for exactly this and the phone, which is the
/// device that actually gets pocketed, had no equivalent.
private struct RefreshOnForeground: ViewModifier {
    @Environment(\.scenePhase) private var phase
    let after: TimeInterval
    let action: () async -> Void
    @State private var leftAt: Date?

    func body(content: Content) -> some View {
        content.onChange(of: phase) { _, now in
            switch now {
            case .active:
                let gap = leftAt.map { Date().timeIntervalSince($0) } ?? 0
                leftAt = nil
                // A control-centre pull is a scene change and not an
                // absence. Only a real gap earns a refetch.
                if gap > after { Task { await action() } }
            case .inactive, .background:
                if leftAt == nil { leftAt = Date() }
            @unknown default:
                break
            }
        }
    }
}

extension View {
    func refreshOnForeground(after: TimeInterval = 120,
                             _ action: @escaping () async -> Void) -> some View {
        modifier(RefreshOnForeground(after: after, action: action))
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
    /// The stale strip's own retry, which is a DIFFERENT action.
    ///
    /// One closure served both states, and on most screens it was `load()`
    /// — which sets `.loading` and blanks the screen. So the strip whose
    /// entire purpose is "the numbers stay, the claim that they are current
    /// does not" shipped a button that threw the numbers away. Falls back to
    /// `retry` so a screen that has only one sensible action keeps working.
    var staleRetry: (() -> Void)? = nil
    @ViewBuilder let content: (T) -> Content

    var body: some View {
        switch state {
        case .loading:
            LoadingState()
        case .failed(let msg):
            ErrorState(message: msg, retry: retry)
        case .stale(let value, let msg):
            VStack(spacing: 0) {
                StaleStrip(message: msg, retry: staleRetry ?? retry)
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
