import Foundation
import CoreAudio

// Is a phone call actually happening on this Mac right now?
//
// The timer used to be a stopwatch started by a button press, which meant
// it began when somebody pressed DIAL and ran until somebody pressed
// something else. It could not tell ringing from talking from a call that
// ended four minutes ago, and every attempt to infer the end from the
// phone's call-history database was a guess — one of which was wrong
// enough to close rows out from under live calls.
//
// Core Audio publishes the answer directly. Every process that touches
// audio has an object in kAudioHardwarePropertyProcessObjectList, and
// each one reports whether it is currently running input or output. When
// a call starts, FaceTime begins playing the ringback and the flag goes
// true; when the call ends it goes false. That is the same indicator the
// dictation apps use to notice you are on a call, and it needs no
// permission at all — the process list is readable without a TCC prompt.
//
// The limit is honest and worth stating: this sees calls that run THROUGH
// the Mac. A call dialled on a handset across the room is invisible here,
// because nothing on this machine is carrying it.
@available(macOS 14.2, *)
enum CallActivity {

    /// Bundles that carry a telephone call on a Mac. FaceTime handles
    /// Continuity calls; callservicesd is the daemon behind it and shows
    /// up on some releases instead.
    static let callBundles: Set<String> = [
        "com.apple.FaceTime",
        "com.apple.telephonyutilities.callservicesd",
        "com.apple.CallHistoryPluginHelper",
    ]

    struct Snapshot: Equatable {
        /// A call app is moving audio in either direction.
        let live: Bool
        /// Which one, for the times this needs explaining.
        let bundles: [String]
    }

    static func snapshot() -> Snapshot {
        var live: [String] = []
        for object in processObjects() {
            guard let bundle = string(object, kAudioProcessPropertyBundleID) else { continue }
            guard callBundles.contains(bundle) else { continue }
            let inRunning = flag(object, kAudioProcessPropertyIsRunningInput) ?? false
            let outRunning = flag(object, kAudioProcessPropertyIsRunningOutput) ?? false
            if inRunning || outRunning { live.append(bundle) }
        }
        return Snapshot(live: !live.isEmpty, bundles: live)
    }

    // MARK: Core Audio

    private static func processObjects() -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                             &address, 0, nil, &size) == noErr, size > 0
        else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &address, 0, nil, &size, &ids) == noErr
        else { return [] }
        return ids
    }

    private static func string(_ object: AudioObjectID,
                               _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: CFString? = nil
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
        }
        return status == noErr ? value as String? : nil
    }

    private static func flag(_ object: AudioObjectID,
                             _ selector: AudioObjectPropertySelector) -> Bool? {
        var address = AudioObjectPropertyAddress(mSelector: selector,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<UInt32>.size)
        var value: UInt32 = 0
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr
            ? value != 0 : nil
    }
}

/// Turns a stream of snapshots into the two moments that matter, with
/// enough hysteresis that a momentary gap is not a hangup.
///
/// Separated from the Core Audio reads so it can be tested without a
/// telephone: every mistake this file has made so far was in the
/// judgement about when a call starts and stops, not in the plumbing.
struct CallActivityTracker {
    /// Consecutive quiet observations before a call counts as over.
    let quietToEnd: Int
    private(set) var everLive = false
    private(set) var quiet = 0

    init(quietToEnd: Int = 4) { self.quietToEnd = quietToEnd }

    enum Event: Equatable {
        case nothingYet     // dialled, no audio yet: not even ringing
        case started        // audio just appeared: it is ringing
        case continuing
        case ended          // audio has been gone long enough to mean it
    }

    mutating func observe(live: Bool) -> Event {
        if live {
            quiet = 0
            if !everLive { everLive = true; return .started }
            return .continuing
        }
        guard everLive else { return .nothingYet }
        quiet += 1
        return quiet >= quietToEnd ? .ended : .continuing
    }
}
