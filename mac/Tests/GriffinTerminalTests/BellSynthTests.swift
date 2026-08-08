import XCTest
import AVFoundation
@testable import GriffinTerminal

// The bell is synthesized, so the render is what there is to test: it
// must be a well-formed WAV that the audio player can actually open,
// long enough to be a ring, and normalized so the overlapping strikes
// never clip into digital noise.
final class BellSynthTests: XCTestCase {
    func testOpenRingIsAPlayableWav() throws {
        let data = BellSynth.wav(.open)
        // RIFF/WAVE header present.
        XCTAssertGreaterThan(data.count, 44)
        XCTAssertEqual(String(decoding: data.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: data[8..<12], as: UTF8.self), "WAVE")
        // AVAudioPlayer opening it is the real contract: a malformed
        // buffer throws here rather than at half past nine.
        let player = try AVAudioPlayer(data: data)
        XCTAssertGreaterThan(player.duration, 4.0) // a ring, not a tap
    }

    func testCloseRingIsShorterButStillARing() throws {
        let open = try AVAudioPlayer(data: BellSynth.wav(.open))
        let close = try AVAudioPlayer(data: BellSynth.wav(.close))
        XCTAssertGreaterThan(close.duration, 3.0)
        XCTAssertLessThan(close.duration, open.duration)
    }

    func testDeterministicRender() {
        // Same seed, same bytes, every time — so the sound never drifts.
        XCTAssertEqual(BellSynth.wav(.open), BellSynth.wav(.open))
    }

    func testNeverClips() throws {
        // The 16-bit samples must stay strictly inside full scale; a
        // value at the rail is where additive synthesis turns to buzz.
        let data = BellSynth.wav(.open)
        let pcm = data.dropFirst(44)
        var maxAbs = 0
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for s in samples { maxAbs = max(maxAbs, abs(Int(Int16(littleEndian: s)))) }
        }
        XCTAssertLessThan(maxAbs, 32767) // under the rail, not at it
        XCTAssertGreaterThan(maxAbs, 20000) // but a full-bodied signal
    }
}
