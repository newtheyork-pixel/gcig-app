import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

// The far end of a phone call, captured without a virtual audio driver.
//
// When a call runs through the paired iPhone, or through a browser tab,
// the other person's voice arrives at this Mac as ordinary system audio.
// macOS 14.2 added process taps, which let an app read that stream
// directly. Before them the only way to do this was a kernel-level
// virtual device somebody had to install, which is exactly the kind of
// dependency this app does not take.
//
// The tap is GLOBAL, excluding ourselves, rather than aimed at one
// process. We do not know which app is carrying the call — FaceTime on a
// Mac with an iPhone nearby, or a browser tab if the call is placed
// through a web dialler — and a tap aimed at the wrong one records
// silence while looking like it worked. Excluding our own process keeps
// the terminal's own sounds out of the recording.
//
// Everything here can fail, on an OS too old, on a permission the user
// declines, or on an aggregate device the system will not build. None of
// those failures may take the call down with them: the caller gets a
// reason string and keeps recording the microphone, which is the half of
// the conversation that was never in doubt.
@available(macOS 14.2, *)
final class SystemAudioTap {

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Delivered on a Core Audio thread. Keep the work short.
    var onBuffer: ((AVAudioPCMBuffer) -> Void)?

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var format: AVAudioFormat?
    private let queue = DispatchQueue(label: "org.thegriffinfund.terminal.systemtap")

    /// The format the tap actually produced, known only after start().
    var captureFormat: AVAudioFormat? { format }

    // Aggregate-device dictionary keys are C string #defines, which Swift
    // does not import. The literals are the contract; if one is ever
    // wrong the aggregate simply fails to build and we fall back to the
    // microphone, which is why this degrades rather than throws upward.
    private enum Key {
        static let uid = "uid"
        static let name = "name"
        static let isPrivate = "private"
        static let isStacked = "stacked"
        static let tapAutoStart = "tapautostart"
        static let tapList = "taps"
        static let subDeviceList = "subdevices"
        static let subTapUID = "uid"
        static let subTapDrift = "drift"
    }

    func start() throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "Griffin call capture"
        // Private: it must not appear in Sound settings as a device
        // somebody could pick by accident.
        description.isPrivate = true
        // The call has to stay audible. Muting the tapped stream would
        // record the far end perfectly and leave the analyst talking to
        // somebody they can no longer hear.
        description.muteBehavior = .unmuted

        var newTap = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(description, &newTap)
        guard tapStatus == noErr, newTap != kAudioObjectUnknown else {
            throw Failure(message: "The system refused an audio tap (\(tapStatus)). "
                          + "Grant Griffin Terminal audio recording in Privacy & Security.")
        }
        tapID = newTap

        let tapUID = try uid(of: newTap)
        let aggregate: [String: Any] = [
            Key.name: "Griffin Call Capture",
            Key.uid: UUID().uuidString,
            Key.isPrivate: true,
            Key.isStacked: false,
            Key.tapAutoStart: true,
            Key.subDeviceList: [],
            Key.tapList: [[Key.subTapUID: tapUID, Key.subTapDrift: true]],
        ]
        var newDevice = AudioObjectID(kAudioObjectUnknown)
        let deviceStatus = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &newDevice)
        guard deviceStatus == noErr, newDevice != kAudioObjectUnknown else {
            cleanUp()
            throw Failure(message: "Could not build the capture device (\(deviceStatus)).")
        }
        deviceID = newDevice

        let asbd = try streamFormat(of: newDevice)
        guard let fmt = AVAudioFormat(streamDescription: [asbd].withUnsafeBufferPointer { $0.baseAddress! }) else {
            cleanUp()
            throw Failure(message: "The capture device reported a format we cannot read.")
        }
        format = fmt

        var newProc: AudioDeviceIOProcID?
        let procStatus = AudioDeviceCreateIOProcIDWithBlock(&newProc, newDevice, queue) {
            [weak self] _, inInputData, _, _, _ in
            guard let self, let handler = self.onBuffer, let fmt = self.format else { return }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: fmt,
                                                bufferListNoCopy: inInputData,
                                                deallocator: nil) else { return }
            handler(buffer)
        }
        guard procStatus == noErr, let newProc else {
            cleanUp()
            throw Failure(message: "Could not attach to the capture device (\(procStatus)).")
        }
        procID = newProc

        let startStatus = AudioDeviceStart(newDevice, newProc)
        guard startStatus == noErr else {
            cleanUp()
            throw Failure(message: "Could not start capturing system audio (\(startStatus)).")
        }
    }

    func stop() {
        if deviceID != kAudioObjectUnknown, let procID {
            AudioDeviceStop(deviceID, procID)
            AudioDeviceDestroyIOProcID(deviceID, procID)
        }
        procID = nil
        cleanUp()
    }

    private func cleanUp() {
        if deviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(deviceID)
            deviceID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    deinit {
        // Not `stop()`: an aggregate device or a tap left behind survives
        // the app and shows up in somebody's Sound settings.
        if deviceID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(deviceID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    }

    // MARK: Property reads

    private func uid(of object: AudioObjectID) throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: CFString? = nil
        let status = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(object, &address, 0, nil, &size, ptr)
        }
        guard status == noErr, let value else {
            throw Failure(message: "The tap would not name itself (\(status)).")
        }
        return value as String
    }

    private func streamFormat(of device: AudioObjectID) throws -> AudioStreamBasicDescription {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &asbd)
        guard status == noErr else {
            throw Failure(message: "The capture device would not describe its audio (\(status)).")
        }
        return asbd
    }
}
