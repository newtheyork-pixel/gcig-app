import SwiftUI

// HELP — every mnemonic, and honestly which ones run here.
//
// Functions not yet native are listed rather than hidden. Hiding them
// would make the app look complete and leave someone typing SPLC and
// concluding they misremembered the code.
struct HelpPanel: View {
    var body: some View {
        let native = Registry.all.filter(\.native)
        let web = Registry.all.filter { !$0.native }

        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    SectionLabel(text: "How to drive it")
                    Text("TICKER FUNCTION   e.g.  AIT DES\nFUNCTION          e.g.  PM\nTICKER            opens DES\n\nThe focused ticker carries forward, so AIT DES then PM then a bare\nGP stays on AIT. ⌘K focuses the command line, ⌘W closes the top\npane, ⌘⇧T tiles everything.")
                        .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                }

                VStack(alignment: .leading, spacing: 3) {
                    SectionLabel(text: "Native here (\(native.count))")
                    ForEach(native) { f in row(f, tone: Term.amber) }
                }

                VStack(alignment: .leading, spacing: 3) {
                    SectionLabel(text: "On the web terminal only (\(web.count))")
                    Text("These parse and are recognised. They just have no native panel yet.")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    ForEach(web) { f in row(f, tone: Term.fgMuted) }
                }
            }
            .padding(12)
        }
    }

    private func row(_ f: TerminalFunction, tone: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(f.id)
                .font(Term.mono(11, weight: .bold)).foregroundStyle(tone)
                .frame(width: 76, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(f.label).font(Term.mono(10)).foregroundStyle(Term.white)
                    if f.requires == "ticker" {
                        Text("needs ticker").font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    }
                    if !f.aliases.isEmpty {
                        Text("also \(f.aliases.joined(separator: ", "))")
                            .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    }
                }
                Text(f.help).font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
