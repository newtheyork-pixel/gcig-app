import SwiftUI

// HOOT — the desk squawk box panel. Who is on the terminal (idle, muted,
// talking), the shared Trade Desk, and a direct line to any one person.
// Tap the Trade Desk or a person to point your push-to-talk at them; hold
// the button to be heard. Reads the shared, always-on Hoot.
struct HootPanel: View {
    @ObservedObject var hoot: Hoot

    private var others: [Hoot.Member] { hoot.members.filter { $0.id != hoot.selfId } }
    private var callingMe: [Hoot.Member] { others.filter { $0.target == hoot.selfId } }
    private var targetName: String {
        if let t = hoot.target, let m = hoot.members.first(where: { $0.id == t }) {
            return m.name.split(separator: " ").first.map(String.init) ?? m.name
        }
        return "Trade Desk"
    }
    private var dotColor: Color {
        switch hoot.status {
        case .on: return Term.positive
        case .off: return Term.negative
        case .connecting: return Term.amber
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(dotColor).frame(width: 7, height: 7)
                Text("TRADE DESK").font(Term.mono(11, weight: .semibold)).foregroundStyle(Term.white).tracking(0.5)
                Spacer()
                Text(hoot.status == .on ? "\(others.count + 1) on the desk"
                     : hoot.status == .connecting ? "joining…" : "offline")
                    .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)

            if !callingMe.isEmpty {
                Text("\(callingMe.map(\.name).joined(separator: ", ")) on your line")
                    .font(Term.mono(10)).foregroundStyle(Term.positive)
                    .padding(.horizontal, 12).padding(.bottom, 8)
            }

            Rectangle().fill(Term.border).frame(height: 1)

            ScrollView {
                VStack(spacing: 0) {
                    row(selected: hoot.target == nil, dot: true, action: { hoot.setTarget(nil) }) {
                        Text("Trade Desk").font(Term.mono(11)).foregroundStyle(Term.fg)
                        Spacer()
                        Text("everyone").font(Term.mono(9)).foregroundStyle(Term.fgDim)
                    }
                    ForEach(others) { m in
                        let selected = hoot.target == m.id
                        row(selected: selected, dot: true, action: { hoot.setTarget(selected ? nil : m.id) }) {
                            Text(m.talking ? "◉" : "○")
                                .foregroundStyle(m.talking ? Term.positive : Term.fgMuted).font(Term.mono(10))
                            Text(m.name)
                                .font(Term.mono(11, weight: m.talking ? .semibold : .regular))
                                .foregroundStyle(Term.fg).lineLimit(1)
                            // Your own account on another device — labelled so
                            // it does not read as a stranger who shares your name.
                            if let sn = hoot.selfName, m.name == sn {
                                Text("· your other device")
                                    .font(Term.mono(9)).foregroundStyle(Term.cyan)
                            }
                            if m.muted {
                                Image(systemName: "mic.slash.fill").foregroundStyle(Term.fgMuted).font(.system(size: 9))
                            }
                            if m.target == hoot.selfId {
                                Text("→ you").font(Term.mono(9)).foregroundStyle(Term.positive)
                            }
                            Spacer()
                            Text(idleLabel(m.idleMs))
                                .font(Term.mono(9))
                                .foregroundStyle(m.idleMs < 30_000 ? Term.fgDim : Term.fgMuted)
                        }
                    }
                    if others.isEmpty {
                        Text("nobody else on the terminal right now")
                            .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                }
            }

            Rectangle().fill(Term.border).frame(height: 1)

            HStack(spacing: 8) {
                Text(hoot.talking ? "● LIVE · \(targetName)" : "HOLD TO TALK · \(targetName)")
                    .font(Term.mono(11, weight: .semibold)).tracking(0.4)
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                    .foregroundStyle(hoot.talking ? Color.white : (hoot.muted ? Term.fgMuted : Term.fg))
                    .background(hoot.talking ? Term.negative : Color.clear)
                    .overlay(RoundedRectangle(cornerRadius: 5)
                        .stroke(hoot.talking ? Term.negative : Term.border, lineWidth: 1))
                    .opacity(hoot.muted ? 0.5 : 1)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in if !hoot.talking { hoot.pressToTalk() } }
                            .onEnded { _ in hoot.releaseToTalk() }
                    )

                Button { hoot.toggleMute() } label: {
                    Image(systemName: hoot.muted ? "mic.slash.fill" : "mic.fill")
                        .foregroundStyle(hoot.muted ? Term.negative : Term.fg)
                        .frame(width: 40, height: 34)
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Term.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help(hoot.muted ? "Unmute" : "Mute your mic")
            }
            .padding(12)

            if hoot.micDenied {
                Text("mic blocked — allow the microphone in System Settings ▸ Privacy")
                    .font(Term.mono(10)).foregroundStyle(Term.negative)
                    .padding(.horizontal, 12).padding(.bottom, 10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Term.bgPanel)
        .onAppear { Hoot.shared.start() }
        // Safety: if the panel closes while you are still holding the
        // button, do not leave the mic keyed open.
        .onDisappear { hoot.releaseToTalk() }
    }

    @ViewBuilder
    private func row<Content: View>(
        selected: Bool, dot: Bool, action: @escaping () -> Void, @ViewBuilder content: () -> Content
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if dot {
                    Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(selected ? Term.positive : Term.fgMuted)
                        .font(.system(size: 11))
                }
                content()
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(selected ? Term.bgPanelHover : Color.clear)
        }
        .buttonStyle(.plain)
    }

    private func idleLabel(_ ms: Int) -> String {
        let s = ms / 1000
        if s < 30 { return "active" }
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m idle" }
        return "\(m / 60)h idle"
    }
}
