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
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, !self.closed else { return }
            self.connect()
        }
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
            if let me = obj["self"] as? [String: Any] { selfId = me["id"] as? Int }
            members = Self.parseMembers(obj["members"])
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

    var socket: URLSessionWebSocketTask?
    var transmitting = false

    func startEngine() {
        guard !started else { return }
        let out = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.attach(player)
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

    func stopEngine() {
        stopCapture()
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
        capConv = AVAudioConverter(from: fmt, to: wire)
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

    private func onCapture(_ buf: AVAudioPCMBuffer, inFmt: AVAudioFormat) {
        guard transmitting, let conv = capConv, let sock = socket else { return }
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
