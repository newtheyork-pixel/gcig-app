import XCTest
import AVFoundation
@testable import GriffinTerminal

/// The microphone and the tap are hardware and cannot be driven from a
/// test. Everything downstream of them can be, and that is where the
/// mistakes with consequences live: a channel that drifts, a file whose
/// header lies about its length, or a right channel of silence being
/// passed off as the other half of a conversation.
final class CallRecorderTests: XCTestCase {

    private func tempURL(_ ext: String) -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("rec-\(UUID().uuidString).\(ext)")
    }

    private func pcm(_ samples: [Int16]) throws -> URL {
        let url = tempURL("pcm")
        var data = Data()
        for s in samples {
            var le = s.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        try data.write(to: url)
        return url
    }

    /// Reads a WAV back into (channelCount, sampleRate, frames).
    private func readWAV(_ url: URL) throws -> (channels: Int, rate: Int, frames: [[Int16]]) {
        let d = try Data(contentsOf: url)
        XCTAssertEqual(String(bytes: d[0..<4], encoding: .ascii), "RIFF")
        XCTAssertEqual(String(bytes: d[8..<12], encoding: .ascii), "WAVE")
        func u32(_ at: Int) -> UInt32 { d[at..<at+4].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian }
        func u16(_ at: Int) -> UInt16 { d[at..<at+2].withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) }.littleEndian }
        let channels = Int(u16(22))
        let rate = Int(u32(24))
        let dataSize = Int(u32(40))
        // The header must agree with the bytes that follow it, or every
        // player reads past the end of the audio.
        XCTAssertEqual(dataSize, d.count - 44, "data chunk size")
        XCTAssertEqual(Int(u32(4)), d.count - 8, "RIFF size")
        var out = [[Int16]](repeating: [], count: channels)
        var offset = 44
        while offset + channels * 2 <= d.count {
            for c in 0..<channels {
                let v = d[offset..<offset+2].withUnsafeBytes { $0.loadUnaligned(as: Int16.self) }
                out[c].append(Int16(littleEndian: v))
                offset += 2
            }
        }
        return (channels, rate, out)
    }

    func testBothSidesBecomeTwoChannels() throws {
        let mic = try pcm([100, 200, 300])
        let far = try pcm([-100, -200, -300])
        let out = tempURL("wav")
        try CallRecorder.merge(micPCM: mic, farPCM: far,
                               micLeadFrames: 0, farLeadFrames: 0,
                               farUsable: true, to: out)
        let wav = try readWAV(out)
        XCTAssertEqual(wav.channels, 2)
        XCTAssertEqual(wav.rate, 16_000)
        XCTAssertEqual(wav.frames[0], [100, 200, 300], "left is the analyst")
        XCTAssertEqual(wav.frames[1], [-100, -200, -300], "right is the store")
    }

    /// A silent right channel looks like a recording of somebody who
    /// never spoke. Mono says what actually happened.
    func testOnlyTheMicrophoneGivesAMonoFile() throws {
        let mic = try pcm([1, 2, 3, 4])
        let far = try pcm([9, 9, 9, 9])
        let out = tempURL("wav")
        try CallRecorder.merge(micPCM: mic, farPCM: far,
                               micLeadFrames: 0, farLeadFrames: 0,
                               farUsable: false, to: out)
        let wav = try readWAV(out)
        XCTAssertEqual(wav.channels, 1)
        XCTAssertEqual(wav.frames[0], [1, 2, 3, 4])
    }

    /// The two sources never start on the same millisecond. Stacking them
    /// raw puts one speaker permanently early, which is exactly the kind
    /// of error that survives into a quoted timestamp.
    func testTheLaterSourceIsPaddedIntoAlignment() throws {
        let mic = try pcm([5, 5, 5])
        let far = try pcm([7, 7, 7])
        let out = tempURL("wav")
        try CallRecorder.merge(micPCM: mic, farPCM: far,
                               micLeadFrames: 0, farLeadFrames: 2,
                               farUsable: true, to: out)
        let wav = try readWAV(out)
        XCTAssertEqual(wav.frames[0], [5, 5, 5, 0, 0], "mic padded at the end to match")
        XCTAssertEqual(wav.frames[1], [0, 0, 7, 7, 7], "far pushed back by its lead")
    }

    func testChannelsOfDifferentLengthsBothSurvive() throws {
        let mic = try pcm([1, 2, 3, 4, 5, 6])
        let far = try pcm([8])
        let out = tempURL("wav")
        try CallRecorder.merge(micPCM: mic, farPCM: far,
                               micLeadFrames: 0, farLeadFrames: 0,
                               farUsable: true, to: out)
        let wav = try readWAV(out)
        XCTAssertEqual(wav.frames[0].count, 6)
        XCTAssertEqual(wav.frames[1], [8, 0, 0, 0, 0, 0])
    }

    func testAnEmptyRecordingIsAValidFileNotACrash() throws {
        let mic = try pcm([])
        let far = try pcm([])
        let out = tempURL("wav")
        try CallRecorder.merge(micPCM: mic, farPCM: far,
                               micLeadFrames: 0, farLeadFrames: 0,
                               farUsable: true, to: out)
        let wav = try readWAV(out)
        XCTAssertEqual(wav.frames[0].count, 0)
    }

    // MARK: Alignment arithmetic

    func testWhicheverStartedSecondGetsTheSilence() {
        let t0 = Date()
        // Tap came up 40ms after the microphone.
        let late = CallRecorder.leadingSilenceFrames(micFirstAt: t0,
                                                     farFirstAt: t0.addingTimeInterval(0.04))
        XCTAssertEqual(late.mic, 0)
        XCTAssertEqual(late.far, 640, "40ms at 16kHz")

        // And the other way round.
        let early = CallRecorder.leadingSilenceFrames(micFirstAt: t0.addingTimeInterval(0.1),
                                                      farFirstAt: t0)
        XCTAssertEqual(early.mic, 1600)
        XCTAssertEqual(early.far, 0)
    }

    func testNoSecondSourceMeansNoOffsetAtAll() {
        // A missing timestamp is not an offset of zero seconds; it means
        // the source never produced a buffer, and inventing an alignment
        // for it would shift the channel that did.
        XCTAssertEqual(CallRecorder.leadingSilenceFrames(micFirstAt: Date(), farFirstAt: nil).far, 0)
        XCTAssertEqual(CallRecorder.leadingSilenceFrames(micFirstAt: nil, farFirstAt: Date()).mic, 0)
    }

    // MARK: Conversion

    func testConversionWithoutAConverterIsSilentNotFatal() {
        // Mid-call, a dropped buffer is a click. A thrown error is the
        // whole recording.
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000,
                                channels: 1, interleaved: false)!
        let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 128)!
        buf.frameLength = 128
        let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                 channels: 1, interleaved: true)!
        XCTAssertEqual(CallRecorder.convert(buf, using: nil, to: wire).count, 0)
    }

    /// A sample-rate converter has a filter delay, so the FIRST buffer
    /// comes back short by roughly 240 frames at 16 kHz and the missing
    /// audio arrives on the next call rather than being lost. Worth
    /// pinning down: the obvious assertion here is "48k in, exactly a
    /// third out", and when that failed the tempting fix was to loosen
    /// the number rather than understand it.
    func testResamplingLandsOnTheWireFormat() {
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000,
                                channels: 1, interleaved: false)!
        let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                 channels: 1, interleaved: true)!
        let converter = AVAudioConverter(from: fmt, to: wire)

        func tone(_ frames: AVAudioFrameCount, phase: Int) -> AVAudioPCMBuffer {
            let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames)!
            buf.frameLength = frames
            for i in 0..<Int(frames) {
                buf.floatChannelData![0][i] = sin(Float(i + phase) * 0.05) * 0.5
            }
            return buf
        }

        let first = CallRecorder.convert(tone(4800, phase: 0), using: converter, to: wire)
        XCTAssertTrue(first.contains { $0 != 0 }, "a tone must not convert to silence")
        let firstFrames = first.count / 2
        XCTAssertLessThan(firstFrames, 1600, "the converter primes on the first buffer")
        XCTAssertGreaterThan(firstFrames, 1200)

        // Across two buffers the delay is paid once and does not
        // compound: the pipeline settles a couple of hundred frames
        // behind and stays there. That residue is the ~13ms still inside
        // the converter when the call ends, which we never flush and
        // never will notice.
        let second = CallRecorder.convert(tone(4800, phase: 4800), using: converter, to: wire)
        let total = firstFrames + second.count / 2
        XCTAssertGreaterThan(total, 2900, "0.2s of audio is ~3200 frames at 16kHz")
        XCTAssertLessThanOrEqual(total, 3200)
        XCTAssertLessThan(3200 - total, 1600 - firstFrames + 1,
                          "the shortfall must not grow with each buffer")
    }
}

