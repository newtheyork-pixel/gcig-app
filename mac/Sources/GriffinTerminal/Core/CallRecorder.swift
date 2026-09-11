import Foundation
import AVFoundation

// Recording a phone call that is not happening inside this app.
//
// Two sources, captured separately and joined at the end. The microphone
// is the analyst, and the system-audio tap is whoever they are talking
// to. Keeping them apart until the last moment is what makes the result
// worth more than a speakerphone recording: the left channel is one
// speaker and the right channel is the other, by construction rather
// than by a model's guess, and an attribution that comes from the wiring
// cannot be wrong in the way a diarizer can.
//
// The microphone path is the one that has to work. It is the same
// AVAudioEngine capture the squawk box has used for a year. The tap is
// newer, needs macOS 14.2, needs a permission, and can be refused by the
// system for reasons we cannot see from here — so it is treated as a
// bonus throughout. A failure there costs the far channel and a line of
// explanation, never the recording and never the call.
//
// Output is 16 kHz PCM, which is what speech recognition wants and a
// twentieth of the bytes of CD audio on a home connection.
/// Holds the far end's converter, which cannot be built until the first
/// buffer reveals the tap's format. Serialised by the audio thread that
/// is its only caller.
private final class ConverterBox: @unchecked Sendable {
    private var converter: AVAudioConverter?
    private var from: AVAudioFormat?

    func get(for format: AVAudioFormat, to wire: AVAudioFormat) -> AVAudioConverter? {
        if converter == nil || from != format {
            converter = AVAudioConverter(from: format, to: wire)
            from = format
        }
        return converter
    }
}

/// One channel's bytes on their way to disk.
///
/// Audio arrives on Core Audio's own threads and must not visit the main
/// actor to be written. The first version hopped every buffer through
/// `Task { @MainActor in … }`, which cost three things: ~45 synchronous
/// file writes a second on the thread drawing the UI, a `@Published`
/// assignment per buffer that re-rendered the whole panel, and — the one
/// that actually corrupts a recording — no ordering guarantee, because
/// unstructured Tasks are not delivered to an actor in submission order.
/// PCM frames appended out of order are a garbled call.
///
/// A serial queue fixes all three. `finish()` drains it before closing,
/// so the last seconds of a call are on disk before the file is read.
private final class TrackWriter: @unchecked Sendable {
    let url: URL
    private let queue: DispatchQueue
    private var handle: FileHandle?
    private var first: Date?
    private var heardAnything = false
    /// When this channel last carried something audible. A live call
    /// pushes line noise continuously; a call that has ended pushes
    /// digital silence or nothing at all, which is the difference that
    /// lets the console notice a hangup without any permission.
    private var lastAudible: Date?
    /// Called once, the first time AUDIBLE audio lands.
    ///
    /// Audible, not merely written: a channel delivering buffers of
    /// silence looks identical to a working one from the outside, and
    /// that is precisely how a store call reached the ledger transcribed
    /// to a single voice while the panel said nothing was wrong.
    var onFirstAudio: (@Sendable () -> Void)?

    init(url: URL, label: String) throws {
        self.url = url
        self.queue = DispatchQueue(label: "org.thegriffinfund.terminal.\(label)")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.handle = try FileHandle(forWritingTo: url)
    }

    func write(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async { [self] in
            guard handle != nil else { return }
            if first == nil { first = Date() }
            if Self.isAudible(data) {
                lastAudible = Date()
                if !heardAnything {
                    heardAnything = true
                    onFirstAudio?()
                }
            }
            handle?.write(data)
        }
    }

    /// Seconds since this channel last carried audio, or nil if it never
    /// has. Read under the queue so it cannot tear.
    func silentFor() -> TimeInterval? {
        var since: TimeInterval?
        queue.sync { [self] in
            if let lastAudible { since = Date().timeIntervalSince(lastAudible) }
        }
        return since
    }

    /// Any sample past a floor that ordinary line noise clears easily and
    /// digital silence cannot. Sampled rather than scanned: a buffer is
    /// thousands of frames and this runs on every one of them.
    private static func isAudible(_ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            let count = raw.count / MemoryLayout<Int16>.size
            guard count > 0 else { return false }
            let p = raw.baseAddress!.assumingMemoryBound(to: Int16.self)
            let step = max(1, count / 64)
            var i = 0
            while i < count {
                if abs(Int(p[i])) > 96 { return true }
                i += step
            }
            return false
        }
    }

    /// Drains every queued write, then closes. The `sync` is the whole
    /// point: a serial queue runs FIFO, so returning from it means the
    /// last buffer handed over is already on disk.
    @discardableResult
    func finish() -> Date? {
        var startedAt: Date?
        queue.sync { [self] in
            startedAt = first
            try? handle?.close()
            handle = nil
        }
        return startedAt
    }
}

@MainActor
final class CallRecorder: ObservableObject {

    enum State: Equatable {
        case idle
        case recording
        case finished(URL)
    }

    @Published private(set) var state: State = .idle
    /// Whether the other side of the call made it onto tape. Published
    /// because the console has to say so before somebody relies on it.
    @Published private(set) var farEndCaptured = false
    /// Why it did not, in words somebody can act on.
    @Published private(set) var farEndNote: String?
    /// Both channels have actually carried audio. Distinct from
    /// `farEndCaptured`, which only says the tap is delivering: a
    /// microphone that is being read but producing silence looked
    /// identical to a working one, and shipped a store call transcribed
    /// to a single voice.
    var bothSidesLive: Bool { micHasAudio && farEndCaptured }
    @Published private(set) var micHasAudio = false
    /// The microphone was refused, so this recording is one-sided by
    /// permission rather than by fault.
    @Published private(set) var micDenied = false

    /// How long the far end has been silent, or nil if it has never
    /// carried audio. The console reads this to notice a hangup on a Mac
    /// that has not granted Full Disk Access.
    var farEndSilentFor: TimeInterval? { farTrack?.silentFor() }

    /// Whether the microphone channel is having the speakers subtracted
    /// out of it. On a speakerphone desk this is what keeps the two
    /// channels apart; with a headset there is nothing to cancel.
    @Published private(set) var echoCancelled = false

    nonisolated static let sampleRate: Double = 16_000

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var tap: AnyObject?

    private var micTrack: TrackWriter?
    private var farTrack: TrackWriter?
    private var workingDir: URL?
    private var micFirstAt: Date?
    private var farFirstAt: Date?

    private lazy var wire: AVAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: Self.sampleRate,
        channels: 1,
        interleaved: true)!

    // MARK: Lifecycle

    func start() throws {
        guard state == .idle else { return }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("griffin-call-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        workingDir = dir
        micTrack = try TrackWriter(url: dir.appendingPathComponent("mic.pcm"), label: "mic")
        farTrack = try TrackWriter(url: dir.appendingPathComponent("far.pcm"), label: "far")
        micFirstAt = nil
        farFirstAt = nil
        farEndCaptured = false
        farEndNote = nil

        // The microphone is allowed to fail. The far end is the half we
        // cannot reconstruct from notes, and a one-sided recording of a
        // refusal still evidences the refusal.
        do { try startMicrophone() } catch {
            farEndNote = "Your side is not being recorded: \(error.localizedDescription)"
        }
        startFarEnd()
        state = .recording
    }

    /// Returns the finished recording, or nil if nothing was captured.
    ///
    /// Never throws. A call has just ended and somebody is waiting to
    /// pick an outcome; a recorder that refuses to stop would hold the
    /// whole console hostage over a file.
    func stop() -> URL? {
        guard state == .recording else { return nil }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if #available(macOS 14.2, *), let tap = tap as? SystemAudioTap { tap.stop() }
        tap = nil

        // Drain before reading. `finish()` blocks until the last buffer
        // handed to the queue is on disk, which is how the tail of a call
        // stops disappearing into a closed file handle.
        micFirstAt = micTrack?.finish()
        farFirstAt = farTrack?.finish()
        let micURL = micTrack?.url
        let farURL = farTrack?.url
        micTrack = nil
        farTrack = nil

        defer { state = .idle }
        guard let micURL, let farURL else { return nil }
        let out = micURL.deletingLastPathComponent().appendingPathComponent("call.wav")
        let offset = Self.leadingSilenceFrames(micFirstAt: micFirstAt, farFirstAt: farFirstAt)
        do {
            try Self.merge(micPCM: micURL, farPCM: farURL,
                           micLeadFrames: offset.mic, farLeadFrames: offset.far,
                           farUsable: farEndCaptured, to: out)
            state = .finished(out)
            return out
        } catch {
            farEndNote = "Could not assemble the recording: \(error.localizedDescription)"
            return nil
        }
    }

    /// Hands the finished recording's directory to the caller and forgets
    /// it, so the next call can start while the last one is still
    /// uploading. Without this the recorder either blocks the queue or
    /// deletes a file that is still being sent.
    func detachWorkingDirectory() -> URL? {
        let dir = workingDir
        workingDir = nil
        state = .idle
        return dir
    }

    /// Removes the working directory. Called once the transcript is home,
    /// so a machine that records forty calls in an afternoon is not
    /// quietly filling up with other people's voices.
    func discard() {
        guard let dir = workingDir else { return }
        try? FileManager.default.removeItem(at: dir)
        workingDir = nil
        state = .idle
    }

    // MARK: Sources

    /// Where macOS stands on letting us hear the microphone.
    ///
    /// Asked explicitly, because starting an AVAudioEngine does not
    /// reliably raise the prompt: the engine runs, the tap fires, and the
    /// buffers are silence. That failure is indistinguishable from a
    /// working recorder in a quiet room, and it is how a store call
    /// reached the ledger with only the shop assistant on it while nobody
    /// had ever been asked for permission.
    static var microphoneAuthorization: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    /// Raises the system prompt if it has never been shown. Returns what
    /// the answer was.
    @discardableResult
    static func requestMicrophone() async -> AVAuthorizationStatus {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        }
        return AVCaptureDevice.authorizationStatus(for: .audio)
    }

    private func startMicrophone() throws {
        // Refuse loudly rather than record silence. A denied microphone
        // produces buffers of zeroes, not an error, so without this check
        // the only symptom is a transcript with one voice in it.
        // A denied microphone stops the microphone, not the recording.
        //
        // The first version of this threw, which meant a refusal in a
        // state where we could not hear ourselves produced no transcript
        // at all. That is the wrong trade: a store declining to discuss
        // pricing is a finding, and half the tape proves it. So we capture
        // what we can and say loudly which half is missing, rather than
        // capturing nothing and saying nothing.
        switch Self.microphoneAuthorization {
        case .denied, .restricted, .notDetermined:
            micDenied = true
            farEndNote = "Your microphone is off for this app, so only the other side of the call is "
                + "being recorded. The transcript will hold their voice and not yours."
            return
        default:
            micDenied = false
        }

        let input = engine.inputNode

        // Echo cancellation, and it is load-bearing rather than polish.
        //
        // The desk setup is the Mac's own microphone and its own
        // speakers. That means the other person's voice comes out of the
        // speakers eighteen inches from the microphone and lands in the
        // left channel alongside ours. Without this the two channels stop
        // being two speakers: one holds the analyst plus a hollow copy of
        // the store, and the separation that made a dual-channel
        // recording worth making is gone.
        //
        // Voice processing has to be enabled before the engine starts and
        // before any tap is installed, and it can change the input
        // format, so the format is read afterwards. It is allowed to
        // fail: on a headset there is nothing to cancel, and a recording
        // with some bleed beats no recording.
        if ProcessInfo.processInfo.environment["GRIFFIN_NO_AEC"] == nil {
            do {
                try input.setVoiceProcessingEnabled(true)
                echoCancelled = true
            } catch {
                echoCancelled = false
            }
        }

        let inFormat = input.inputFormat(forBus: 0)
        if ProcessInfo.processInfo.environment["GRIFFIN_MIC_DIAG"] != nil {
            FileHandle.standardError.write(Data("MICFMT \(inFormat)\n".utf8))
        }
        guard inFormat.sampleRate > 0 else {
            throw NSError(domain: "CallRecorder", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No microphone is available.",
            ])
        }
        // Convert from a MONO version of the input, not from the input
        // itself.
        //
        // The default input on this machine reports NINE channels, and
        // AVAudioConverter handed a 9-channel source and a 1-channel
        // destination returns the right NUMBER of samples and fills them
        // with silence. That is the whole bug behind a real store call
        // transcribing to one voice: the tap fired, buffers arrived with
        // audio in them, bytes were written, and every one of those bytes
        // was zero. Nothing errored anywhere.
        //
        // So the downmix happens here, where it can be seen, and the
        // converter only ever does the job it is reliable at: one channel
        // at one rate to one channel at another.
        let monoIn = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                   sampleRate: inFormat.sampleRate,
                                   channels: 1,
                                   interleaved: false)
        converter = monoIn.flatMap { AVAudioConverter(from: $0, to: self.wire) }
        let track = micTrack
        track?.onFirstAudio = { [weak self] in
            Task { @MainActor in self?.micHasAudio = true }
        }
        let converter = self.converter
        let wire = self.wire
        // @Sendable is doing real work here and removing it crashes the
        // app on the first buffer.
        //
        // This class is @MainActor, and a plain closure written inside it
        // INHERITS that isolation. AVAudioEngine then calls it from a
        // real-time audio thread, Swift 6 checks whether it is on the main
        // actor, and traps. The symptom is the whole app quitting the
        // instant a call starts, with the dial already placed — which is
        // exactly as confusing as it sounds from the outside.
        //
        // Marking it @Sendable makes it non-isolated, which is the truth:
        // everything it touches (TrackWriter, the converter, the format)
        // is safe off the main actor by construction.
        let diag = ProcessInfo.processInfo.environment["GRIFFIN_MIC_DIAG"] != nil
        let onMic: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = { buffer, _ in
            let data = Self.convert(Self.downmix(buffer) ?? buffer, using: converter, to: wire)
            if diag {
                var peakIn: Float = 0
                if let ch = buffer.floatChannelData {
                    for i in 0..<Int(buffer.frameLength) { peakIn = max(peakIn, abs(ch[0][i])) }
                }
                FileHandle.standardError.write(Data("MICBUF frames=\(buffer.frameLength) peakIn=\(peakIn) outBytes=\(data.count)\n".utf8))
            }
            track?.write(data)
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat, block: onMic)
        engine.prepare()
        try engine.start()
    }

    private func startFarEnd() {
        guard #available(macOS 14.2, *) else {
            farEndNote = "Only your side was recorded: capturing the other end needs macOS 14.2 or later."
            return
        }
        let capture = SystemAudioTap()
        let track = farTrack
        let wire = self.wire
        // Announced ONCE, on the first buffer that carries audio. Setting
        // a @Published property per buffer re-rendered the whole panel
        // twenty-three times a second for the length of the call.
        track?.onFirstAudio = { [weak self] in
            Task { @MainActor in self?.farEndCaptured = true }
        }
        // Same trap as the microphone block above: written inside a
        // @MainActor type, a plain closure inherits that isolation and
        // Core Audio calls it from its own thread. The converter is built
        // once on first buffer and only ever touched from that thread, so
        // a box keeps it out of the isolation checker's way.
        let farConverter = ConverterBox()
        capture.onBuffer = { @Sendable buffer in
            guard let mono = Self.downmix(buffer) else { return }
            track?.write(Self.convert(mono, using: farConverter.get(for: mono.format, to: wire), to: wire))
        }
        do {
            try capture.start()
            tap = capture
        } catch {
            // The call is not in trouble. One channel is.
            farEndNote = "Only your side was recorded. \(error.localizedDescription)"
        }
    }

    // MARK: Conversion

    /// Every channel averaged into one, at the source rate.
    ///
    /// Done by hand because AVAudioConverter does not do it reliably:
    /// given a many-channel source and a one-channel destination it
    /// returns the correct number of silent samples. Averaging rather
    /// than taking channel zero, because on a device with nine inputs
    /// there is no guarantee the live microphone is the first one.
    nonisolated static func downmix(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let channels = Int(buffer.format.channelCount)
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return nil }
        if channels == 1, buffer.format.commonFormat == .pcmFormatFloat32 { return buffer }
        guard let src = buffer.floatChannelData else { return nil }
        guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: buffer.format.sampleRate,
                                      channels: 1, interleaved: false),
              let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)),
              let dst = out.floatChannelData
        else { return nil }
        out.frameLength = AVAudioFrameCount(frames)
        let scale = 1.0 / Float(channels)
        for i in 0..<frames {
            var sum: Float = 0
            for c in 0..<channels { sum += src[c][i] }
            dst[0][i] = sum * scale
        }
        return out
    }

    /// One buffer, resampled to the wire format, as raw little-endian
    /// Int16. Empty on any failure, because a dropped buffer is a click
    /// and a thrown error mid-call is a lost recording.
    ///
    /// A sample-rate converter has a filter delay: the first buffer comes
    /// back short and the stream then runs a couple of hundred frames
    /// behind for the rest of the call. It settles rather than
    /// compounding, and the residue left inside the converter when the
    /// call ends is about thirteen milliseconds, which is not worth a
    /// drain step on the way out. Measured in CallRecorderTests.
    nonisolated static func convert(_ buffer: AVAudioPCMBuffer,
                                    using converter: AVAudioConverter?,
                                    to wire: AVAudioFormat) -> Data {
        guard let converter else { return Data() }
        let ratio = wire.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: capacity) else { return Data() }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, out.frameLength > 0, let channel = out.int16ChannelData else { return Data() }
        return Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }

    /// How much silence each channel needs at the front so the two line
    /// up. The tap and the microphone start milliseconds apart, and
    /// stacking them without this makes one speaker permanently early.
    nonisolated static func leadingSilenceFrames(micFirstAt: Date?,
                                                 farFirstAt: Date?) -> (mic: Int, far: Int) {
        guard let micFirstAt, let farFirstAt else { return (0, 0) }
        let delta = farFirstAt.timeIntervalSince(micFirstAt)
        let frames = Int((abs(delta) * sampleRate).rounded())
        return delta >= 0 ? (0, frames) : (frames, 0)
    }

    // MARK: Assembly

    /// Two raw mono streams into one WAV.
    ///
    /// Stereo when both sides were captured, mono when only the
    /// microphone was: a right channel of pure silence is a file that
    /// looks like it holds the other half of the conversation.
    nonisolated static func merge(micPCM: URL, farPCM: URL,
                                  micLeadFrames: Int, farLeadFrames: Int,
                                  farUsable: Bool, to output: URL) throws {
        let mic = try Data(contentsOf: micPCM)
        let far = farUsable ? try Data(contentsOf: farPCM) : Data()

        let micSamples = samples(mic, lead: micLeadFrames)
        if far.isEmpty {
            try write(channels: [micSamples], to: output)
            return
        }
        // A microphone that was refused leaves an empty file, and pairing
        // it with the far end would write a stereo recording whose left
        // channel is pure silence. Mono says what actually happened.
        if mic.isEmpty {
            try write(channels: [samples(far, lead: 0)], to: output)
            return
        }
        let farSamples = samples(far, lead: farLeadFrames)
        let length = max(micSamples.count, farSamples.count)
        try write(channels: [padded(micSamples, to: length), padded(farSamples, to: length)],
                  to: output)
    }

    private nonisolated static func samples(_ data: Data, lead: Int) -> [Int16] {
        var out = [Int16](repeating: 0, count: lead)
        out.append(contentsOf: data.withUnsafeBytes { raw -> [Int16] in
            let count = raw.count / MemoryLayout<Int16>.size
            guard count > 0 else { return [] }
            return Array(UnsafeBufferPointer(
                start: raw.baseAddress!.assumingMemoryBound(to: Int16.self), count: count))
        })
        return out
    }

    private nonisolated static func padded(_ s: [Int16], to length: Int) -> [Int16] {
        s.count >= length ? s : s + [Int16](repeating: 0, count: length - s.count)
    }

    /// A WAV header written by hand. Forty lines against a file format
    /// that has not changed since 1991, versus a dependency.
    nonisolated static func write(channels: [[Int16]], to url: URL) throws {
        let channelCount = channels.count
        let frames = channels.first?.count ?? 0
        var body = Data(capacity: frames * channelCount * 2)
        for frame in 0..<frames {
            for channel in channels {
                var sample = channel[frame].littleEndian
                withUnsafeBytes(of: &sample) { body.append(contentsOf: $0) }
            }
        }

        let bitsPerSample: UInt16 = 16
        let blockAlign = UInt16(channelCount) * bitsPerSample / 8
        let byteRate = UInt32(sampleRate) * UInt32(blockAlign)

        var header = Data()
        func ascii(_ s: String) { header.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { header.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { header.append(contentsOf: $0) } }

        ascii("RIFF")
        u32(UInt32(36 + body.count))
        ascii("WAVE")
        ascii("fmt ")
        u32(16)
        u16(1)                        // PCM
        u16(UInt16(channelCount))
        u32(UInt32(sampleRate))
        u32(byteRate)
        u16(blockAlign)
        u16(bitsPerSample)
        ascii("data")
        u32(UInt32(body.count))

        try (header + body).write(to: url)
    }
}
