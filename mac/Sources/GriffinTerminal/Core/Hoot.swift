import SwiftUI
import AVFoundation

// The desk squawk box, native. Shared for the whole terminal session: it
// joins presence the moment the terminal opens (silent — no bar), so the
// HOOT panel can show who is on the desk. Two ways to be heard, matching
// server/src/realtime/hoot.js: the shared Trade Desk (target nil), or a
// direct line to one person (target = their id). You always hear the desk
// and any direct call; the mic only engages when you hold to talk.
//
// Wire: 16 kHz mono Int16 PCM in binary frames (prefixed with a 4-byte
// speaker id we skip on playback); presence, keyed-up, mute, target and
// activity are JSON.

@MainActor
final class Hoot: ObservableObject {
    static let shared = Hoot()

    struct Member: Identifiable, Equatable {
        let id: Int
        let name: String
        var talking: Bool
        var muted: Bool
        var idleMs: Int
        var target: Int?
    }
    enum Status { case connecting, on, off }

    @Published private(set) var status: Status = .off
    @Published private(set) var members: [Member] = []
    @Published private(set) var talking = false
    @Published private(set) var muted = false
    @Published private(set) var target: Int?  // nil = Trade Desk
    @Published private(set) var micDenied = false
    private(set) var selfId: Int?
    /// This connection's own display name, from `welcome`. Used to label a
    /// roster entry that is your OWN account on another device — with
    /// per-connection presence, your second device shows up as a separate
    /// participant, and this stops it reading as a stranger with your name.
    private(set) var selfName: String?
    /// Seconds before the next reconnect attempt, doubling to a ceiling.
    private var retryDelay: TimeInterval = 3

    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var closed = true
    private var activeTimer: Timer?
    private let audio = HootAudio()

    // ---- lifecycle ----

    func start() {
        guard closed else { return }
        closed = false
        audio.startEngine()  // playback only; the mic waits for the button
        connect()
        activeTimer?.invalidate()
        activeTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.send(["t": "active"]) }
        }
    }

    func stop() {
        closed = true
        talking = false
        audio.transmitting = false
        activeTimer?.invalidate()
        activeTimer = nil
        audio.stopEngine()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        status = .off
    }

    private func connect() {
        status = .connecting
        Task { [weak self] in
            guard let self else { return }
            let url = await API.shared.webSocketURL("/ws/hoot")
            guard !self.closed else { return }
            guard let url else {
                self.status = .off
                return
            }
            let t = self.session.webSocketTask(with: url)
            self.task = t
            self.audio.socket = t
            t.resume()
            self.receive()
        }
    }

    private func onDrop() {
        guard !closed else { return }
        status = .off
        // Backoff with a ceiling. This used to retry every three seconds
        // forever, and the cases that never succeed are common ones: a
        // guest account, a member below Analyst, a signed-out session. A
        // full TLS and auth round trip every three seconds for as long as
        // the app is open is a lot of noise for a socket that is never
        // going to open.
        retryDelay = min(retryDelay * 2, 60)
        DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay) { [weak self] in
            guard let self, !self.closed else { return }
            self.connect()
        }
    }

    /// Tell the server what we already believe, the moment it says hello.
    ///
    /// A reconnect gives us a BRAND NEW connection, and the server starts
    /// it at target: null, muted: false, talking: false. The client kept
    /// its own idea of all three and never mentioned them again, so after
    /// a wifi blip the panel still read "HOLD TO TALK · Sarah" while every
    /// word went to the whole desk, a mute silently lapsed, and a button
    /// held across the reconnect streamed audio the server discarded
    /// because as far as it knew nobody was keyed up.
    private func resendState() {
        if let target { send(["t": "target", "to": target]) }
        if muted { send(["t": "mute", "on": true]) }
        if talking { send(["t": "ptt", "on": true]) }
    }

    private func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(s)) { _ in }
    }

    // ---- receive loop ----
    private func receive() {
        task?.receive { [weak self] result in
            switch result {
            case .failure:
                Task { @MainActor in self?.onDrop() }
            case .success(let message):
                switch message {
                case .string(let s):
                    Task { @MainActor in
                        self?.handleText(s)
                        self?.receive()
                    }
                case .data(let d):
                    Task { @MainActor in
                        if d.count > 4 { self?.audio.play(d.subdata(in: 4 ..< d.count)) }
                        self?.receive()
                    }
                @unknown default:
                    Task { @MainActor in self?.receive() }
                }
            }
        }
    }

    private func handleText(_ s: String) {
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["t"] as? String
        else { return }
        switch t {
        case "welcome":
            status = .on
            if let me = obj["self"] as? [String: Any] {
                selfId = me["id"] as? Int
                selfName = me["name"] as? String
            }
            members = Self.parseMembers(obj["members"])
            retryDelay = 3
            resendState()
        case "presence":
            members = Self.parseMembers(obj["members"])
        case "ptt":
            if let id = obj["id"] as? Int, let on = obj["on"] as? Bool,
               let idx = members.firstIndex(where: { $0.id == id }) {
                members[idx].talking = on
            }
        default:
            break
        }
    }

    private static func parseMembers(_ raw: Any?) -> [Member] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        return arr.compactMap { m in
            guard let id = m["id"] as? Int, let name = m["name"] as? String else { return nil }
            return Member(
                id: id, name: name,
                talking: (m["talking"] as? Bool) ?? false,
                muted: (m["muted"] as? Bool) ?? false,
                idleMs: (m["idleMs"] as? Int) ?? 0,
                target: m["target"] as? Int)
        }
    }

    // ---- controls ----

    /// Point push-to-talk at the Trade Desk (nil) or one person's line.
    func setTarget(_ memberId: Int?) {
        target = memberId
        send(["t": "target", "to": memberId ?? "desk"])
    }

    func toggleMute() {
        muted.toggle()
        if muted, talking {
            talking = false
            audio.transmitting = false
            audio.stopCapture() // release the mic — muting mid-hold left it on
            send(["t": "ptt", "on": false])
        }
        send(["t": "mute", "on": muted])
    }

    func pressToTalk() {
        guard !talking, !muted else { return }
        // Optimistic: the button turns LIVE the instant you press, which
        // proves the gesture fired even before the mic is granted. The mic
        // engages independently of the socket; only the send waits on it.
        talking = true
        if status == .on { send(["t": "ptt", "on": true]) }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            Task { @MainActor in
                guard let self, self.talking, !self.muted else { return }
                if !granted {
                    self.micDenied = true
                    self.releaseToTalk()
                    return
                }
                self.micDenied = false
                self.audio.startCapture()
                self.audio.transmitting = true
            }
        }
    }

    func releaseToTalk() {
        guard talking else { return }
        talking = false
        audio.transmitting = false
        audio.stopCapture()
        if status == .on { send(["t": "ptt", "on": false]) }
    }
}

// The realtime audio path, off the main actor. @unchecked Sendable because
// AVAudioEngine's tap callback and URLSessionWebSocketTask.send are both
// thread-safe and the only shared state is a couple of flags.
final class HootAudio: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let wire = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private var playConv: AVAudioConverter?
    private var capConv: AVAudioConverter?
    private var started = false
    private var captureEngine: AVAudioEngine?
    private var configObserver: NSObjectProtocol?

    var socket: URLSessionWebSocketTask?
    var transmitting = false
    private var lastRebuild = Date.distantPast

    func startEngine() {
        guard !started else { return }
        buildPlaybackGraph()
        // Restart the playback engine whenever the audio configuration
        // changes. macOS STOPS an AVAudioEngine on any output-device or
        // format change, and one routinely fires in the first seconds
        // after launch as the audio system settles. Left unhandled, the
        // engine started once here silently stops and never renders
        // another buffer — which is exactly why incoming voice was never
        // heard, while SENDING (on its own capture engine, freshly started
        // on every key-up) worked every time.
        if configObserver == nil {
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in self?.restartPlayback() }
        }
    }

    /// (Re)wire player -> mixer against the CURRENT hardware format and
    /// start. Split out so a configuration change can rebuild the graph
    /// rather than reuse a converter aimed at a format that no longer
    /// exists.
    private func buildPlaybackGraph() {
        _ = engine.outputNode  // force the output chain to exist
        let out = engine.mainMixerNode.outputFormat(forBus: 0)
        // No sample rate means no usable output — every output removed,
        // or a virtual device vanishing, which is precisely the
        // configuration change this code exists to survive.
        // AVAudioEngine.connect answers that with an uncatchable
        // CoreAudio exception, so the app does not fail to play, it quits.
        guard out.sampleRate > 0, out.channelCount > 0 else {
            started = false
            return
        }
        if player.engine == nil { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: out)
        playConv = AVAudioConverter(from: wire, to: out)
        engine.prepare()
        do {
            try engine.start()
            player.play()
            started = true
        } catch {
            started = false
        }
    }

    private func restartPlayback() {
        started = false
        engine.stop()
        buildPlaybackGraph()
    }

    func stopEngine() {
        stopCapture()
        if let o = configObserver { NotificationCenter.default.removeObserver(o); configObserver = nil }
        player.stop()
        engine.stop()
        started = false
    }

    // Capture runs on its OWN engine, created when you key up and torn
    // down when you release. A separate engine, STARTED after the tap is
    // installed, is the reliable way to actually pull the microphone on
    // macOS — installing an input tap on the shared playback engine
    // mid-run does not engage the mic (no orange indicator, no frames).
    func startCapture() {
        guard captureEngine == nil else { return }
        let eng = AVAudioEngine()
        let input = eng.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0 else { return }
        // Convert from a MONO version of the input, never from the input
        // itself.
        //
        // Handed a many-channel source and a one-channel destination,
        // AVAudioConverter returns the correct NUMBER of samples and
        // fills every one with zero. No error, no nil, no short buffer —
        // so the mic engages, frames go out at the right rate, and
        // everybody on the desk hears silence. The identical bug was
        // found in the call recorder the same day, where a nine-channel
        // default input made a real store call transcribe to one voice.
        //
        // One channel is the common case and this costs nothing there.
        // It costs everything the day somebody's default input is an
        // aggregate, a virtual device like Teams, or a multichannel
        // interface — and the failure is silent in both senses.
        let monoIn = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                   sampleRate: fmt.sampleRate,
                                   channels: 1, interleaved: false)
        capConv = monoIn.flatMap { AVAudioConverter(from: $0, to: wire) }
        input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { [weak self] buf, _ in
            self?.onCapture(buf, inFmt: fmt)
        }
        eng.prepare()
        do {
            try eng.start()
            captureEngine = eng
        } catch {
            captureEngine = nil
        }
    }

    func stopCapture() {
        guard let eng = captureEngine else { return }
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        captureEngine = nil
    }

    /// Every channel averaged into one, at the source rate.
    ///
    /// By hand, because AVAudioConverter does not do this reliably. See
    /// the note where `capConv` is built. Averaging rather than taking
    /// channel zero, because on a device with several inputs there is no
    /// guarantee the live microphone is the first one.
    static func downmix(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let channels = Int(buffer.format.channelCount)
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return nil }
        if channels == 1, buffer.format.commonFormat == .pcmFormatFloat32 { return buffer }
        guard let src = buffer.floatChannelData,
              let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
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

    private func onCapture(_ raw: AVAudioPCMBuffer, inFmt: AVAudioFormat) {
        guard transmitting, let conv = capConv, let sock = socket else { return }
        guard let buf = Self.downmix(raw) else { return }
        let ratio = wire.sampleRate / inFmt.sampleRate
        let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 32
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        conv.convert(to: outBuf, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, outBuf.frameLength > 0, let ch = outBuf.int16ChannelData else { return }
        let data = Data(bytes: ch[0], count: Int(outBuf.frameLength) * MemoryLayout<Int16>.size)
        sock.send(.data(data)) { _ in }
    }

    func play(_ pcm: Data) {
        // Heal a stopped engine on the next incoming frame, in case a
        // configuration change slipped through without a notification —
        // but not faster than once a second. Frames arrive every 20 to 40
        // milliseconds, so an engine that will not start turned this into
        // twenty-five to fifty full graph rebuilds a second on the main
        // thread, for as long as anybody was talking.
        if !engine.isRunning, Date().timeIntervalSince(lastRebuild) > 1 {
            lastRebuild = Date()
            restartPlayback()
        }
        guard started, let conv = playConv else { return }
        let frames = pcm.count / MemoryLayout<Int16>.size
        guard frames > 0,
              let inBuf = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: AVAudioFrameCount(frames))
        else { return }
        inBuf.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            if let base = raw.baseAddress, let dst = inBuf.int16ChannelData {
                memcpy(dst[0], base, frames * MemoryLayout<Int16>.size)
            }
        }
        let out = engine.mainMixerNode.outputFormat(forBus: 0)
        let ratio = out.sampleRate / wire.sampleRate
        let cap = AVAudioFrameCount(Double(frames) * ratio) + 32
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        conv.convert(to: outBuf, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return inBuf
        }
        if err == nil, outBuf.frameLength > 0 {
            player.scheduleBuffer(outBuf, at: nil, options: [], completionHandler: nil)
        }
    }
}
