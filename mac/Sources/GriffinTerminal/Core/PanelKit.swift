import SwiftUI

// Shared panel furniture.
//
// The rule this file exists to enforce: loading, failed, and genuinely
// empty must never look alike. A spinner that stops on an error reads as
// "no data". An empty table under a successful header reads as "we
// checked and there is nothing". Both have already put wrong numbers in
// front of people on the web side, and both are one forgotten `catch`
// away in any panel. Making the honest version the easiest thing to
// write is the only defence that survives a hurried afternoon.

/// The three states every fetching panel is in, plus the payload.
enum Loadable<T> {
    case loading
    case loaded(T)
    case failed(String)
}

struct PanelMessage: View {
    let text: String
    var bad = false

    var body: some View {
        Text(text)
            .font(Term.mono(11))
            .foregroundStyle(bad ? Term.negative : Term.fgMuted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .multilineTextAlignment(.center)
            .padding(20)
    }
}

/// Wraps a Loadable so no panel has to hand-roll the three branches and
/// accidentally collapse two of them.
struct PanelState<T, Content: View>: View {
    let state: Loadable<T>
    var emptyWhen: ((T) -> Bool)? = nil
    var emptyText: String = "Nothing to show."
    var retry: (() -> Void)? = nil
    @ViewBuilder let content: (T) -> Content

    var body: some View {
        switch state {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(Term.amber)
                Text("Loading").font(Term.mono(11)).foregroundStyle(Term.fgMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed(let msg):
            VStack(spacing: 10) {
                // Named as a failure, not dressed as an empty result.
                Text("COULD NOT LOAD")
                    .font(Term.mono(10, weight: .bold))
                    .foregroundStyle(Term.negative)
                Text(msg)
                    .font(Term.mono(11))
                    .foregroundStyle(Term.fgDim)
                    .multilineTextAlignment(.center)
                if let retry {
                    Button("Retry", action: retry)
                        .buttonStyle(TermButtonStyle())
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .loaded(let value):
            if let emptyWhen, emptyWhen(value) {
                PanelMessage(text: emptyText)
            } else {
                content(value)
            }
        }
    }
}

struct TermButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Term.mono(11))
            .foregroundStyle(Term.amber)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background(configuration.isPressed ? Term.bgPanelHover : Term.bgPanel)
            .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
            .contentShape(Rectangle())
    }
}

/// A section label. The web uses the one cool note in the palette for
/// these so the grid has a spine that is not more amber.
struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(Term.mono(9, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(Term.blue)
    }
}

/// Label/value row, the workhorse of DES-style panels.
struct StatRow: View {
    let label: String
    let value: String
    var tone: Color = Term.white

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(Term.mono(11))
                .foregroundStyle(Term.fgMuted)
            Spacer(minLength: 6)
            Text(value)
                .font(Term.mono(11, weight: .medium))
                .foregroundStyle(tone)
        }
    }
}

// MARK: Formatting
//
// A terminal lives on aligned numbers, and inconsistent formatting is
// what makes a dense grid unreadable. These are the only formatters.

enum Fmt {
    static func money(_ v: Double?, decimals: Int = 2) -> String {
        guard let v else { return "—" }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = decimals
        f.maximumFractionDigits = decimals
        return f.string(from: NSNumber(value: v)) ?? "—"
    }

    static func pct(_ v: Double?, decimals: Int = 2, signed: Bool = true) -> String {
        guard let v else { return "—" }
        let s = String(format: "%.\(decimals)f", abs(v))
        let sign = !signed ? "" : (v > 0 ? "+" : (v < 0 ? "-" : ""))
        return "\(sign)\(s)%"
    }

    /// 1.2B / 340.5M / 12.3K. Big numbers in a narrow column.
    static func compact(_ v: Double?) -> String {
        guard let v else { return "—" }
        let a = abs(v)
        let sign = v < 0 ? "-" : ""
        switch a {
        case 1_000_000_000_000...: return "\(sign)\(String(format: "%.2f", a / 1_000_000_000_000))T"
        case 1_000_000_000...: return "\(sign)\(String(format: "%.2f", a / 1_000_000_000))B"
        case 1_000_000...:     return "\(sign)\(String(format: "%.1f", a / 1_000_000))M"
        case 1_000...:         return "\(sign)\(String(format: "%.1f", a / 1_000))K"
        default:               return "\(sign)\(String(format: "%.2f", a))"
        }
    }

    static func date(_ iso: String?) -> String {
        guard let iso else { return "—" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let d else { return iso.prefix(10).description }
        let out = DateFormatter()
        out.dateFormat = "dd MMM yy"
        return out.string(from: d)
    }
}
