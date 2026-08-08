import Foundation
import AppKit
import AVFoundation

// The opening bell and the closing bell.
//
// A trading floor rings a bell at the open and the close, and a terminal
// that pretends to be one should too. Rung on the market's own clock:
// 9:30 AM ET open, 4:00 PM ET close, weekdays only. (US market holidays
// are not excluded — a weekday-only rule is the honest 95% of it without
// carrying a holiday calendar the app would have to keep current.)
//
// It rings only when the clock CROSSES the moment while the app is
// running, never on a launch that happens to land after it — nobody
// wants the closing bell at 8pm because they opened the app then. The
// crossing check makes a missed tick (a busy main thread) still fire on
// the next one, and makes a launch at noon silent.
@MainActor
final class MarketBell: ObservableObject {
    static let shared = MarketBell()

    /// Persisted so a mute survives relaunch. Default on: it was asked
    /// for, and a bell nobody wants is one keystroke from silence.
    @Published var enabled: Bool {
        didSet { UserDefaults.standard.set(enabled, forKey: Self.prefKey) }
    }
    private static let prefKey = "marketBellEnabled"

    // ET, the one clock the desk and the custodian share.
    nonisolated(unsafe) private static let etCal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }()

    /// Minutes-since-midnight ET for each bell.
    nonisolated static let openMinute = 9 * 60 + 30   // 09:30
    nonisolated static let closeMinute = 16 * 60      // 16:00

    private var lastTick: Date?
    private var loop: Task<Void, Never>?

    // Rendered once, off the main thread, and kept: the ring is a few
    // hundred KB of PCM and takes a beat to synthesize, which should not
    // land on the main actor at half past nine. A retained player, so it
    // is not deallocated mid-ring.
    private var openWav: Data?
    private var closeWav: Data?
    private var player: AVAudioPlayer?

    private init() {
        enabled = UserDefaults.standard.object(forKey: Self.prefKey) as? Bool ?? true
    }

    func start() {
        loop?.cancel()
        // Pre-render the bells so the first ring is instant.
        if openWav == nil {
            Task.detached(priority: .utility) {
                let o = BellSynth.wav(.open)
                let c = BellSynth.wav(.close)
                await MainActor.run { self.openWav = o; self.closeWav = c }
            }
        }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick(now: Date())
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func stop() { loop?.cancel(); loop = nil }

    /// Ring whichever bells the interval (lastTick, now] crossed. Pure
    /// but for the ring side effect, so the crossing logic is unit
    /// tested without waiting for half past nine.
    func tick(now: Date) {
        defer { lastTick = now }
        guard let prev = lastTick else { return } // first tick only arms
        for event in Self.bellsCrossed(from: prev, to: now) {
            ring(event)
        }
    }

    enum Bell: Equatable { case open, close }

    /// Which bells sit inside (from, to]. Static and side-effect-free so
    /// a test can assert "9:29 to 9:31 rings the open, 9:31 to 9:33
    /// rings nothing, Saturday rings nothing".
    nonisolated static func bellsCrossed(from: Date, to: Date) -> [Bell] {
        guard to > from else { return [] }
        var out: [Bell] = []
        for (minute, bell) in [(openMinute, Bell.open), (closeMinute, Bell.close)] {
            if let moment = momentToday(minute: minute, near: to),
               moment > from, moment <= to,
               isWeekday(moment) {
                out.append(bell)
            }
        }
        return out
    }

    /// The ET instant for a given minutes-since-midnight on the same ET
    /// day as `near`. nil if the calendar cannot form it (DST folds are
    /// far from 9:30 and 16:00, so this is defensive rather than real).
    nonisolated private static func momentToday(minute: Int, near: Date) -> Date? {
        var comps = etCal.dateComponents([.year, .month, .day], from: near)
        comps.hour = minute / 60
        comps.minute = minute % 60
        comps.second = 0
        return etCal.date(from: comps)
    }

    nonisolated private static func isWeekday(_ date: Date) -> Bool {
        let wd = etCal.component(.weekday, from: date) // 1 = Sunday
        return wd >= 2 && wd <= 6
    }

    private func ring(_ bell: Bell) {
        guard enabled else { return }
        play(bell)
    }

    // MARK: Sound

    private func play(_ bell: Bell) {
        // Cache may still be rendering on a cold first ring; synthesize
        // inline as a fallback so the bell is never silent.
        let data = (bell == .open ? openWav : closeWav) ?? BellSynth.wav(bell == .open ? .open : .close)
        do {
            let p = try AVAudioPlayer(data: data)
            p.prepareToPlay()
            p.play()
            player = p
        } catch {
            // A bell that cannot open the audio device is a nice-to-have
            // that failed; never let it disturb anything else.
        }
    }

    /// Ring a bell now, for the menu's preview — bypasses the enabled
    /// gate so a muted user can still hear what they turned off.
    func preview(_ bell: Bell) {
        play(bell)
    }
}
