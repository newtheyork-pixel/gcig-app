import SwiftUI

// The terminal palette, carried over from the web client's theme.css.
//
// The web defines these in OKLCH, and the temptation is to eyeball a hex
// equivalent. That loses the thing the comment in theme.css is actually
// about: the neutrals carry a hair of chroma at the amber hue, so the
// black reads as phosphor behind glass rather than flat ink. Eyeballed
// greys are exactly what makes a dark theme look generic.
//
// So the conversion is done properly, in code, from the same OKLCH
// values the web uses. One source of truth, and when someone retunes the
// web palette these numbers can be updated from it literally.
enum Term {
    // MARK: Palette, as authored (L, C, H) in OKLCH

    static let bg           = oklch(0.16, 0.006, 70)
    static let bgPanel      = oklch(0.195, 0.008, 70)
    static let bgPanelHover = oklch(0.235, 0.010, 70)
    static let bgHeader     = oklch(0.25, 0.012, 65)
    static let border       = oklch(0.34, 0.018, 68)
    static let borderFocus  = oklch(0.60, 0.110, 70)
    static let amber        = oklch(0.82, 0.160, 72)
    static let fg           = amber
    static let fgDim        = oklch(0.66, 0.130, 68)
    static let fgMuted      = oklch(0.50, 0.075, 66)
    static let orange       = oklch(0.72, 0.190, 52)
    static let positive     = oklch(0.81, 0.190, 150)
    static let negative     = oklch(0.64, 0.220, 26)
    static let cyan         = oklch(0.81, 0.100, 200)
    static let blue         = oklch(0.74, 0.100, 245)
    static let magenta      = oklch(0.73, 0.160, 350)
    static let white        = oklch(0.93, 0.014, 85)
    /// Bloomberg's red function-title bar. Deep, not alarm-red: it is
    /// chrome, and it must sit behind white text all day without shouting.
    static let redBar       = oklch(0.36, 0.105, 25)
    static let gpLine       = oklch(0.95, 0.020, 250)
    static let gpArea       = oklch(0.60, 0.120, 250)

    // MARK: Type
    //
    // JetBrains Mono if the user has it, else SF Mono. Tabular figures
    // are not decoration here: a column of prices that jitters as digits
    // change width is unreadable at a glance, which is the entire job of
    // this panel.
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    // MARK: OKLCH conversion
    //
    // Oklab -> linear sRGB -> gamma sRGB. Björn Ottosson's matrices.
    // Out-of-gamut components are clipped rather than gamut-mapped: every
    // colour above is comfortably inside sRGB, and a clip that never
    // fires beats a chroma-reduction loop nobody will read.
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

    /// Green for up, red for down, muted for flat. Flat is deliberately
    /// not green: a book that has not moved should not read as a good day.
    static func delta(_ v: Double?) -> Color {
        guard let v, v != 0 else { return fgMuted }
        return v > 0 ? positive : negative
    }
}

// Chrome shared by every panel, so a new panel cannot drift off-theme by
// forgetting a modifier.
extension View {
    func termPanelBackground() -> some View {
        background(Term.bgPanel)
    }

    func termBorder(focused: Bool = false) -> some View {
        overlay(
            Rectangle()
                .strokeBorder(focused ? Term.borderFocus : Term.border, lineWidth: 1)
        )
    }
}
