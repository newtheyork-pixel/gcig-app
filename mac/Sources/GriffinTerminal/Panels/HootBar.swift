import SwiftUI

// The desk squawk box, across the top of the terminal, always on while the
// terminal is open. Hold the button and your voice goes out live to
// everyone else on the desk; let go and you are listening again. Mirrors
// the web hoot bar; the audio and socket live in Hoot.
struct HootBar: View {
    @StateObject private var hoot = Hoot()

    private var dotColor: Color {
        switch hoot.status {
        case .on: return Term.positive
        case .off: return Term.negative
        case .connecting: return Term.amber
        }
    }

    var body: some View {
        let others = hoot.members.filter { $0.id != hoot.selfId }
        let live = hoot.members.filter { $0.talking }.map(\.name)

        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(dotColor).frame(width: 7, height: 7)
                Text("HOOT").font(Term.mono(10)).foregroundStyle(Term.fgMuted).tracking(0.5)
            }

            Text(hoot.talking ? "● LIVE" : "HOLD TO TALK")
                .font(Term.mono(10, weight: .semibold))
                .tracking(0.4)
                .padding(.horizontal, 12)
                .padding(.vertical, 3)
                .foregroundStyle(hoot.talking ? Color.white : Term.fg)
                .background(hoot.talking ? Term.negative : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(hoot.talking ? Term.negative : Term.border, lineWidth: 1)
                )
                .contentShape(Rectangle())
                .opacity(hoot.status == .on ? 1 : 0.5)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in if !hoot.talking { hoot.pressToTalk() } }
                        .onEnded { _ in hoot.releaseToTalk() }
                )
                .help("Hold to talk to the desk")

            Group {
                if hoot.status != .on {
                    Text(hoot.status == .connecting ? "joining the desk…" : "reconnecting…")
                        .foregroundStyle(Term.fgDim)
                } else if !live.isEmpty {
                    Text("\(live.joined(separator: ", ")) \(live.count == 1 ? "is" : "are") live")
                        .foregroundStyle(Term.positive)
                } else if others.isEmpty {
                    Text("you are the only one here").foregroundStyle(Term.fgDim)
                } else {
                    Text("\(others.count) on the desk").foregroundStyle(Term.fgDim)
                }
            }
            .font(Term.mono(10))
            .lineLimit(1)

            HStack(spacing: 8) {
                ForEach(others) { m in
                    Text("\(m.talking ? "◉" : "○") \(m.name.split(separator: " ").first.map(String.init) ?? m.name)")
                        .font(Term.mono(10, weight: m.talking ? .bold : .regular))
                        .foregroundStyle(m.talking ? Term.positive : Term.fgMuted)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if hoot.micDenied {
                Text("mic blocked — allow the microphone")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.negative)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Term.bg)
        .overlay(alignment: .bottom) { Rectangle().fill(Term.border).frame(height: 1) }
        .onAppear { hoot.start() }
        .onDisappear { hoot.stop() }
    }
}
