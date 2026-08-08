import Foundation

// A struck brass bell, synthesized.
//
// The NYSE bell is not a chime — it is a brass bell a person rings hard
// and fast for several seconds, each strike ringing out over the last
// into a continuous celebratory clangor. macOS system sounds cannot do
// that, and the actual recording is not ours to bundle. So it is built
// from physics instead: a bell's tone is a stack of INHARMONIC partials
// (the hum, the prime, the tierce, the nominal, the clang above them),
// each with its own exponential decay, struck repeatedly with a little
// human unevenness so it rings rather than loops.
//
// The partial ratios, relative amplitudes and relative decays are the
// classic bell set (after Risset's bell studies): paired partials are
// detuned a hair to beat, which is what gives brass its shimmer.
enum BellSynth {
    private static let sampleRate = 44_100.0

    // ratio, amplitude, decay-weight, detune(Hz). Paired near-duplicates
    // with a small detune are deliberate: the beating between them is
    // the metallic shimmer.
    private static let partials: [(ratio: Double, amp: Double, dur: Double, detune: Double)] = [
        (0.56, 1.00, 1.00, 0.0),
        (0.56, 0.67, 0.90, 1.0),
        (0.92, 1.00, 0.65, 0.0),
        (0.92, 1.80, 0.55, 1.7),
        (1.19, 2.90, 0.33, 0.0),
        (1.70, 1.90, 0.35, 0.0),
        (2.00, 1.70, 0.25, 0.0),
        (2.74, 1.55, 0.20, 0.0),
        (3.00, 1.55, 0.15, 0.0),
        (3.76, 1.25, 0.10, 0.0),
        (4.07, 1.55, 0.08, 0.0),
    ]

    /// One strike rendered additively into `buf` starting at `start`,
    /// scaled by velocity. `fundamental` sets the pitch; `ring` is how
    /// long the longest partial takes to fade.
    private static func strike(
        into buf: inout [Double], start: Int, velocity: Double,
        fundamental: Double, ring: Double
    ) {
        let attack = Int(0.003 * sampleRate) // 3ms, a struck edge not a swell
        for p in partials {
            let freq = fundamental * p.ratio + p.detune
            let tau = ring * p.dur / 5.0 // seconds to 1/e
            let life = min(Int(tau * 6.0 * sampleRate), buf.count - start)
            if life <= 0 { continue }
            let w = 2.0 * Double.pi * freq / sampleRate
            let decayPerSample = exp(-1.0 / (tau * sampleRate))
            var env = velocity * p.amp
            for n in 0..<life {
                let i = start + n
                if i >= buf.count { break }
                let a = n < attack ? Double(n) / Double(attack) : 1.0
                buf[i] += env * a * sin(w * Double(n))
                env *= decayPerSample
            }
        }
    }

    enum Kind { case open, close }

    /// The whole ring as a mono WAV, ready for AVAudioPlayer(data:).
    /// Deterministic (a fixed jitter seed) so it renders identically
    /// every time and a test can pin it.
    static func wav(_ kind: Kind) -> Data {
        // The bell is one physical object: open and close share its
        // timbre. Open is the IPO ring — longer and more vigorous;
        // close is firm and a touch shorter.
        let fundamental = 660.0 // E5 — the bright, small brass podium bell
        let ring = 1.7          // each strike sings ~1.7s
        let strikes = kind == .open ? 16 : 11
        let interval = 0.29     // ~3.4 strikes a second, rung hard
        let tail = 1.8          // let the last strike fade fully

        let total = Int((Double(strikes) * interval + tail) * sampleRate)
        var buf = [Double](repeating: 0, count: total)

        var rng = SplitMix(seed: kind == .open ? 0x0DDBE11 : 0xC105E)
        for s in 0..<strikes {
            // A person swings in: the first few land softer, then it is
            // rung at full tilt with a little natural unevenness.
            let swell = s < 3 ? 0.55 + 0.15 * Double(s) : 1.0
            let vel = swell * (0.85 + 0.15 * rng.unit())
            let jitter = (rng.unit() - 0.5) * 0.04 // +-20ms of human timing
            let at = Int((Double(s) * interval + jitter) * sampleRate)
            strike(into: &buf, start: max(0, at), velocity: vel, fundamental: fundamental, ring: ring)
        }

        // Normalize to just under full scale so the overlap never clips.
        var peak = 0.0
        for v in buf { peak = max(peak, abs(v)) }
        let gain = peak > 0 ? 0.92 / peak : 1.0

        return encodeWav(buf.map { $0 * gain })
    }

    // MARK: WAV

    private static func encodeWav(_ samples: [Double]) -> Data {
        let n = samples.count
        var d = Data(capacity: 44 + n * 2)
        func str(_ s: String) { d.append(contentsOf: s.utf8) }
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }

        let byteRate = UInt32(sampleRate) * 2
        str("RIFF"); u32(UInt32(36 + n * 2)); str("WAVE")
        str("fmt "); u32(16); u16(1); u16(1)          // PCM, mono
        u32(UInt32(sampleRate)); u32(byteRate); u16(2); u16(16) // 16-bit
        str("data"); u32(UInt32(n * 2))
        for s in samples {
            let clamped = max(-1.0, min(1.0, s))
            u16(UInt16(bitPattern: Int16(clamped * 32767.0)))
        }
        return d
    }
}

/// A tiny deterministic RNG so the ring's human unevenness is the same
/// every render (Date-based randomness is both unavailable in tests and
/// pointless here).
private struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
}
