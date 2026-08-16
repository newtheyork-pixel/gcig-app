import SwiftUI

// The shared kit. Screens compose these and only these.
//
// The Mac reads as one product because four things are enforced rather
// than merely matched: the palette, the state machine, the formatters and
// the chrome. This file is the fourth. A screen that needs a new pattern
// adds it here, where the next screen inherits it, instead of inline,
// where it drifts.
//
// Corners are square everywhere. Squareness is the cheapest signal that
// this is the terminal's sibling rather than another rounded-card app.
// The only exception is a text field at radius 4, so the iOS selection
// loupe does not clip.

// MARK: Chrome

/// The red function bar that tops every screen, ported from the Mac's
/// FunctionBar: code on the LEFT for what this screen is, title on the
/// RIGHT as confirmation. Deep red because it is furniture that holds
/// white text all day without shouting.
///
/// It has no loading state and no failure state, by design. Chrome may go
/// quiet; chrome may never fail. The one thing a member must always be
/// able to read is which screen they are looking at.
struct FunctionBar: View {
    let code: String        // TODAY, BOOK, WIRE, CLUB, or a ticker
    let title: String

    var body: some View {
        HStack(spacing: Space.s) {
            Text(code.uppercased())
                .font(Type.screenCode)
                .foregroundStyle(T.white)
            Spacer(minLength: Space.s)
            Text(title.uppercased())
                .font(Type.screenTitle)
                .tracking(0.8)
                .foregroundStyle(T.white)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, Space.l)
        .frame(maxWidth: .infinity)
        .frame(height: 28)
        .background(T.redBar)
        .hairline()
    }
}

// MARK: Rows

/// The workhorse. Prose on the left, data on the right.
struct Row<Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    /// The mono meta line: source, stamp, count.
    var meta: String? = nil
    /// The leading accent, when this row has something urgent to say.
    var strip: Color? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .center, spacing: Space.s) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title)
                    .font(Type.headline)
                    .foregroundStyle(T.white)
                    .fixedSize(horizontal: false, vertical: true)
                if let subtitle {
                    Text(subtitle)
                        .font(Type.footnote)
                        .foregroundStyle(T.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let meta {
                    Text(meta)
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                }
            }
            Spacer(minLength: Space.s)
            trailing()
        }
        .padding(.vertical, Space.m)
        .padding(.horizontal, Space.l)
        .frame(minHeight: 44)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .edgeStrip(strip)
        .hairline()
    }
}

extension Row where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, meta: String? = nil, strip: Color? = nil) {
        self.init(title: title, subtitle: subtitle, meta: meta, strip: strip) { EmptyView() }
    }
}

/// A row led by a ticker rather than a name: the book's shape.
struct TickerRow<Trailing: View>: View {
    let ticker: String
    var name: String? = nil
    var meta: String? = nil
    var strip: Color? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .center, spacing: Space.s) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(ticker)
                    .font(Type.ticker)
                    .foregroundStyle(T.amber)
                if let name {
                    Text(name)
                        .font(Type.footnote)
                        .foregroundStyle(T.dim)
                        .lineLimit(1)
                }
                if let meta {
                    Text(meta)
                        .font(Type.meta)
                        .foregroundStyle(T.muted)
                }
            }
            Spacer(minLength: Space.s)
            trailing()
        }
        .padding(.vertical, Space.m)
        .padding(.horizontal, Space.l)
        .frame(minHeight: 44)
        .background(T.card)
        .edgeStrip(strip)
        .hairline()
    }
}

/// The right-hand number stack most rows carry.
struct ValueStack: View {
    /// Pre-formatted, through Fmt. Never a raw Double.
    let value: String
    /// Drives the colour, so the number and its sign cannot disagree.
    var delta: Double? = nil
    var deltaText: String? = nil
    /// Feeds the tick flash when this number is live.
    var flash: Double? = nil

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            Text(value)
                .font(Type.value)
                .foregroundStyle(T.white)
                .tickFlash(flash)
            if let deltaText {
                Text(deltaText)
                    .font(Type.delta)
                    .foregroundStyle(T.delta(delta))
            }
        }
    }
}

// MARK: Structure

/// Blue, uppercase, tracked: the grid's spine. Use inside a
/// LazyVStack(pinnedViews: [.sectionHeaders]) so scrolling keeps it.
struct SectionHeader: View {
    let text: String
    /// A count or stamp, mono and muted, on the right.
    var trailing: String? = nil

    var body: some View {
        HStack {
            Text(text.uppercased())
                .font(Type.label)
                .tracking(0.8)
                .foregroundStyle(T.blue)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(Type.meta)
                    .foregroundStyle(T.muted)
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(T.header)
    }
}

/// The screen-top headline number.
struct StatBlock: View {
    let label: String
    /// Fmt output, never a raw Double.
    let value: String
    var delta: Double? = nil
    var deltaText: String? = nil
    /// The reconciliation line: what this number includes that a reader
    /// might otherwise have to work out.
    var caption: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label.uppercased())
                .font(Type.label)
                .tracking(0.8)
                .foregroundStyle(T.muted)
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                Text(value)
                    .font(Type.valueBig)
                    .foregroundStyle(T.white)
                    .tickFlash(delta)
                if let deltaText {
                    Text(deltaText)
                        .font(Type.delta)
                        .foregroundStyle(T.delta(delta))
                }
            }
            if let caption {
                Text(caption)
                    .font(Type.meta)
                    .foregroundStyle(T.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.card)
        .hairline()
    }
}

/// Label and value on one line, for detail screens. A direct port.
struct StatLine: View {
    let label: String
    let value: String
    var tone: Color = T.white

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Text(label)
                .font(Type.meta)
                .foregroundStyle(T.muted)
            Spacer(minLength: Space.s)
            Text(value)
                .font(Type.value)
                .foregroundStyle(tone)
        }
        .padding(.vertical, Space.xs)
    }
}

/// Square, mono, two styles. `.solid` is identity, the held-ticker badge:
/// colour fill with ground-coloured ink. `.quiet` is status: a tinted fill
/// with coloured text.
struct Chip: View {
    enum Style { case solid, quiet }
    let text: String
    var tone: Color = T.dim
    var style: Style = .quiet

    var body: some View {
        Text(text.uppercased())
            .font(Type.chip)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .foregroundStyle(style == .solid ? T.bg : tone)
            .background(style == .solid ? tone : tone.opacity(0.15))
    }
}

// MARK: The four states

struct LoadingState: View {
    var body: some View {
        HStack(spacing: Space.s) {
            ProgressView().tint(T.amber)
            Text("Loading").font(Type.meta).foregroundStyle(T.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Named as a failure, never dressed as an empty result. The cap is a
/// system label and stays mono; the explanation beneath it is prose.
struct ErrorState: View {
    let message: String
    var retry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: Space.m) {
            Text("COULD NOT LOAD")
                .font(Type.chip)
                .tracking(0.8)
                .foregroundStyle(T.negative)
            Text(message)
                .font(Type.footnote)
                .foregroundStyle(T.dim)
                .multilineTextAlignment(.center)
            if let retry {
                Button("RETRY", action: retry).buttonStyle(GriffinButtonStyle())
            }
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct EmptyState: View {
    let text: String
    /// An empty chase list is good news and should read as good news.
    var good = false

    var body: some View {
        Text(text)
            .font(Type.footnote)
            .foregroundStyle(good ? T.positive : T.muted)
            .multilineTextAlignment(.center)
            .padding(Space.xl)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Shown above loaded content when a refresh failed, generalising the Mac's
/// single global OFFLINE strip. The numbers stay; the claim that they are
/// current does not.
struct StaleStrip: View {
    let message: String
    var retry: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: Space.s) {
            Chip(text: "Stale", tone: T.amber, style: .solid)
            Text(message)
                .font(Type.meta)
                .foregroundStyle(T.muted)
                .lineLimit(2)
            Spacer(minLength: Space.s)
            if let retry {
                Button("RETRY", action: retry)
                    .font(Type.chip)
                    .foregroundStyle(T.cyan)
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T.amber.opacity(0.12))
    }
}

/// Every screen showing money says when the money was true.
struct AsOfStamp: View {
    let date: Date?
    var body: some View {
        Text(date == nil ? "—" : "AS OF \(Fmt.clock(date))")
            .font(Type.meta)
            .foregroundStyle(T.muted)
    }
}

// MARK: Controls

/// Square, hairline border, mono label, because a button is a command.
struct GriffinButtonStyle: ButtonStyle {
    var tone: Color = T.amber
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Type.chip)
            .foregroundStyle(tone)
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.s)
            .background(configuration.isPressed ? T.cardPress : T.card)
            .overlay(Rectangle().strokeBorder(T.border, lineWidth: 1))
            .contentShape(Rectangle())
    }
}
