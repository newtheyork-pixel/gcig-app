import SwiftUI

// The palette, converted from the same OKLCH values the web and the Mac
// use, in code, from the same numbers.
//
// The first version of this file was eyeballed hex, which is precisely
// what mac/Core/Theme.swift warns against: the neutrals carry a hair of
// chroma at the amber hue, so the ground reads as phosphor behind glass
// rather than flat ink, and an approximated grey throws that away. That
// is most of why this app did not look related to the terminal.
//
// Every colour below is a MEANING, not a decoration. Adding a colour here
// means adding a fact the app can state; picking one off-list in a screen
// means stating a fact nobody defined.
enum T {

    // MARK: Surfaces

    /// The app ground. Never pure black.
    static let bg        = oklch(0.16,  0.006, 70)
    /// Raised surface: rows, fields, the quiet fill behind a chip.
    static let card      = oklch(0.195, 0.008, 70)
    /// A pressed row.
    static let cardPress = oklch(0.235, 0.010, 70)
    /// Pinned section fills and totals rows. Opaque, so content scrolls under.
    static let header    = oklch(0.25,  0.012, 65)
    /// Every hairline in the app.
    static let border    = oklch(0.34,  0.018, 68)

    // MARK: Ink

    /// Primary values and titles.
    static let white = oklch(0.93, 0.014, 85)
    /// Secondary prose.
    ///
    /// The one deliberate departure from the Mac. Its fgDim sits at chroma
    /// 0.130 because the Mac's body ink IS amber, so dim amber under bright
    /// amber reads as secondary. Here body ink is white, and 0.130 beside
    /// white reads as highlighted text rather than quieter text. Re-authored
    /// at low chroma: still warm, still OKLCH, no eyeballed grey.
    static let dim   = oklch(0.64, 0.020, 75)
    /// Tertiary and meta text, and the colour of a FLAT delta.
    static let muted = oklch(0.50, 0.075, 66)

    // MARK: Voice

    /// Identity and action: tickers, tab tint, buttons, the tappable thing.
    static let amber    = oklch(0.82, 0.160, 72)
    /// Money moved up. Also a good-news empty state.
    static let positive = oklch(0.81, 0.190, 150)
    /// Money moved down. Also a failure.
    static let negative = oklch(0.64, 0.220, 26)
    /// Structure only: section labels. The one cool note, so the grid has a
    /// spine that is not more amber.
    static let blue     = oklch(0.74, 0.100, 245)
    /// Provenance: source tags, staleness. Which feed a thing came from is a
    /// different fact from which way it is going, and must not share a colour.
    static let orange   = oklch(0.72, 0.190, 52)
    /// Cash instruments, and tertiary links such as RETRY.
    static let cyan     = oklch(0.81, 0.100, 200)
    /// Chrome ONLY: the function bar. Deep, not alarm red, because it sits
    /// behind white text all day and must never read as an alert.
    static let redBar   = oklch(0.36, 0.105, 25)

    // MARK: OKLCH conversion
    //
    // Oklab -> linear sRGB -> gamma sRGB, Bjorn Ottosson's matrices, copied
    // from the Mac unchanged. Out-of-gamut components are clipped rather
    // than gamut-mapped: every colour above is comfortably inside sRGB, so
    // the clip never fires.
    static func oklch(_ l: Double, _ c: Double, _ hDeg: Double) -> Color {
        let h = hDeg * .pi / 180
        let a = c * cos(h)
        let bb = c * sin(h)

        let l_ = l + 0.3963377774 * a + 0.2158037573 * bb
        let m_ = l - 0.1055613458 * a - 0.0638541728 * bb
        let s_ = l - 0.0894841775 * a - 1.2914855480 * bb

        let lc = l_ * l_ * l_
        let mc = m_ * m_ * m_
        let sc = s_ * s_ * s_

        let r =  4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc
        let g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc
        let b = -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc

        return Color(.sRGB, red: gamma(r), green: gamma(g), blue: gamma(b), opacity: 1)
    }

    private static func gamma(_ x: Double) -> Double {
        let v = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
        return min(max(v, 0), 1)
    }

    /// Green up, red down, muted flat. Flat is deliberately not green: a
    /// book that has not moved should not read as a good day. The old iOS
    /// code used `d >= 0`, which painted every flat position green.
    static func delta(_ v: Double?) -> Color {
        guard let v, v != 0 else { return muted }
        return v > 0 ? positive : negative
    }
}

// MARK: Type
//
// Where the monospace line falls, stated once.
//
// The Mac is monospace everywhere because it is a terminal: the surface is
// one grid and alignment is the medium. A phone is not. Monospaced prose
// at reading size costs a fifth of the line, rags badly and reads as code.
//
//     Monospace is for what the system says.
//     Proportional is for what people say.
//
// Mono, always: every digit a reader might compare with another digit,
// tickers, timestamps, chips, section labels, the function bar, and button
// labels, because a button is a command. Proportional, always: headlines,
// names in running position, recommendations, explanations, any sentence
// that wraps. The two coexist inside one component, which is the point:
// COULD NOT LOAD is a system label and stays mono; the explanation beneath
// it is prose.

extension Font {
    /// The terminal's voice. Tabular figures are not decoration: a column
    /// of prices that jitters as digit widths change is unreadable at a
    /// glance, which is the entire job of the screen.
    static func data(_ s: CGFloat, _ w: Font.Weight = .regular) -> Font {
        .system(size: s, weight: w, design: .monospaced)
    }
    /// The human voice.
    static func prose(_ s: CGFloat, _ w: Font.Weight = .regular) -> Font {
        .system(size: s, weight: w)
    }
}

/// The type scale. Screens use these names, never a raw size, so the scale
/// stays a scale.
///
/// Sizes are fixed rather than Dynamic Type, the same trade Bloomberg's own
/// mobile app makes: dense financial rows break under scaling and a column
/// of prices that rewraps is unreadable. This is a deliberate departure
/// from iOS convention and a revisitable one. Bold Text still applies.
enum Type {
    static let screenCode  = Font.data(11, .bold)      // function bar, left
    static let screenTitle = Font.data(10)             // function bar, right
    static let label       = Font.data(11, .bold)      // SECTION HEADER
    static let ticker      = Font.data(15, .bold)
    static let value       = Font.data(15, .medium)    // a row's right-hand number
    static let valueBig    = Font.data(28, .bold)      // the headline number
    static let delta       = Font.data(12, .medium)
    static let meta        = Font.data(11)             // stamps, sources, counts
    static let chip        = Font.data(10, .bold)
    static let headline    = Font.prose(16, .semibold) // row titles, news heads
    static let body        = Font.prose(15)
    static let footnote    = Font.prose(13)            // subtitles, explanations
}

/// The spacing scale. The gutter is 16 rather than the Mac's 10, because a
/// thumb is not a cursor.
enum Space {
    static let hair: CGFloat = 2
    static let xs: CGFloat   = 4
    static let s: CGFloat    = 8
    static let m: CGFloat    = 12
    static let l: CGFloat    = 16
    static let xl: CGFloat   = 24
}

extension View {
    /// The leading accent strip: the Mac's urgency vocabulary at touch
    /// scale. A strip is a fact about the row, never decoration, so the
    /// colour is optional and absent means "nothing to say".
    func edgeStrip(_ color: Color?) -> some View {
        overlay(alignment: .leading) {
            if let color { Rectangle().fill(color).frame(width: 3) }
        }
    }

    /// A hairline along one edge. Rules are 1px and T.border, everywhere.
    func hairline(_ edge: Alignment = .bottom) -> some View {
        overlay(alignment: edge) { Rectangle().fill(T.border).frame(height: 1) }
    }
}

// MARK: Tick flash
//
// Bloomberg's heartbeat: when a price ticks, the background pulses, green
// up and red down, and decays. It is the ONLY animation in the product
// besides system transitions, which is what makes it read as data arriving
// rather than decoration. Identity does the work, so a row that re-renders
// with an unchanged value stays quiet.
struct TickFlash: ViewModifier {
    let value: Double?
    @State private var flash: Color = .clear

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 3)
            .background(flash)
            .onChange(of: value) { old, new in
                guard let o = old, let n = new, n != o else { return }
                flash = (n > o ? T.positive : T.negative).opacity(0.45)
                withAnimation(.easeOut(duration: 0.9)) { flash = .clear }
            }
    }
}

extension View {
    func tickFlash(_ value: Double?) -> some View { modifier(TickFlash(value: value)) }
}
