import SwiftUI

// The numbered menus — SMENU, MAIN, LAST — Bloomberg's grammar of
// discoverability. A menu is a page of numbered rows; typing the
// number and Return swaps THIS pane's content in place, because the
// frame you arranged is yours and the content rotates within it. No
// menu ever spawns a pane.
//
// Two rules keep the idiom honest. Numbering is continuous 1..N down
// the whole page — Bloomberg numbers the page, not the section, so a
// number is a complete address without naming a group. And every row
// is a plain Button running the identical closure the number map
// holds, so the mouse and the keyboard can never drift apart: if a
// click works, its number works, and vice versa.
//
// The groupings are curated by hand, but the row SET is derived from
// Registry.all, with an explicit drift net: a native function added
// to the registry but not yet claimed by a group lands in a trailing
// "More" section rather than silently vanishing from the menu. A menu
// that quietly omits a function is worse than an ugly one — it
// teaches people the function does not exist.

// MARK: - Shared menu machinery

/// One numbered row: its page-wide number and the function it opens.
private struct MenuItem: Identifiable {
    let n: Int
    let fn: TerminalFunction
    var id: String { fn.id }
}

private struct MenuGroup: Identifiable {
    let title: String
    let items: [MenuItem]
    var id: String { title }
}

private enum MenuBuild {
    /// Lay a curated grouping over a registry-derived pool, numbering
    /// continuously across groups. IDs in the layout that are not in
    /// the pool are skipped (a function gone non-native just drops
    /// out); pool members no layout claims fall into "More" — the
    /// drift net for functions added after this file was written.
    static func groups(_ layout: [(String, [String])],
                       from pool: [TerminalFunction]) -> [MenuGroup] {
        var unclaimed = Dictionary(uniqueKeysWithValues: pool.map { ($0.id, $0) })
        var n = 0
        var out: [MenuGroup] = []
        for (title, ids) in layout {
            var items: [MenuItem] = []
            for id in ids {
                guard let fn = unclaimed.removeValue(forKey: id) else { continue }
                n += 1
                items.append(MenuItem(n: n, fn: fn))
            }
            if !items.isEmpty { out.append(MenuGroup(title: title, items: items)) }
        }
        // Registry order, not dictionary order, so the net is stable.
        let rest = pool.filter { unclaimed[$0.id] != nil }
        if !rest.isEmpty {
            var items: [MenuItem] = []
            for fn in rest { n += 1; items.append(MenuItem(n: n, fn: fn)) }
            out.append(MenuGroup(title: "More", items: items))
        }
        return out
    }
}

/// A menu row. The button runs the very closure published under its
/// number — one code path, so hover, click, and digit agree forever.
private struct MenuRow: View {
    let n: Int
    let code: String
    let label: String
    var codeWidth: CGFloat? = 68
    var trailing: String? = nil
    var trailingTone: Color = Term.orange
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text("\(n))")
                    .font(Term.mono(11, weight: .medium))
                    .foregroundStyle(Term.orange)
                    .frame(width: 30, alignment: .trailing)
                Text(code)
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(Term.amber)
                    .frame(width: codeWidth, alignment: .leading)
                Text(label)
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgDim)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let trailing {
                    Text(trailing)
                        .font(Term.mono(10, weight: .medium))
                        .foregroundStyle(trailingTone)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background(hovered ? Term.bgPanelHover : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in
            hovered = h
            h ? NSCursor.pointingHand.push() : NSCursor.pop()
        }
    }
}

// MARK: - SMENU — the security menu

// What a bare ticker opens. On Bloomberg, loading a security without
// a function shows everything you can DO with it — the single best
// discoverability move the terminal has, and the one a student needs
// most. Every row keeps this pane and this ticker; only the function
// rotates.
struct SecurityMenuPanel: View {
    let paneID: UUID
    let ticker: String
    @EnvironmentObject var ws: Workspace

    private static let layout: [(String, [String])] = [
        ("Snapshot & Chart",     ["DES", "GP", "GIP"]),
        ("Financials & Filings", ["FA", "GF", "EARN", "FIL"]),
        ("Ownership & Street",   ["PEER", "CON", "INSDR", "MGMT"]),
        ("News",                 ["CN"]),
        ("Research",             ["NOTE", "SPLC"]),
    ]

    /// Derived, not listed: every native function that takes a ticker
    /// belongs here, minus the menu itself — a menu offering to open
    /// itself is a rabbit hole, not a row.
    private var groups: [MenuGroup] {
        MenuBuild.groups(Self.layout, from: Registry.all.filter {
            $0.native && $0.requires == "ticker" && $0.id != "SMENU"
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ticker)
                    .font(Term.mono(20, weight: .bold))
                    .foregroundStyle(Term.amber)
                Text("Select a function — type its number and press Return.")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider().overlay(Term.border)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(groups) { g in
                        VStack(alignment: .leading, spacing: 2) {
                            SectionLabel(text: g.title)
                                .padding(.horizontal, 10)
                            ForEach(g.items) { item in
                                MenuRow(n: item.n, code: item.fn.id,
                                        label: item.fn.label,
                                        action: action(for: item))
                            }
                        }
                    }
                }
                .padding(.vertical, 10)
            }
        }
        .onAppear(perform: publish)
        // Focus returning to this pane must re-arm its numbers — some
        // other menu may have published over the single slot since.
        .onChange(of: ws.focusedID) { _, id in
            if id == paneID { publish() }
        }
    }

    private func action(for item: MenuItem) -> () -> Void {
        let fnID = item.fn.id
        let t = ticker
        let id = paneID
        return { [weak ws] in
            guard let ws else { return }
            ws.retarget(id, fn: fnID, ticker: .some(t))
            // The pane is no longer a menu, so its numbers must die
            // with it — a stale map would let a bare digit fire a row
            // that is no longer on screen. If the new content is
            // itself a menu, its onAppear publishes after this.
            ws.numberedMenu = nil
        }
    }

    private func publish() {
        var map: [Int: () -> Void] = [:]
        for g in groups {
            for item in g.items { map[item.n] = action(for: item) }
        }
        ws.publishNumbers(for: paneID, map)
    }
}

// MARK: - MAIN — the top of the tree

// MAIN / MENU / HOME: every native function, one page, numbered.
// Ticker-taking rows show the security they would actually use — the
// sticky focus ticker — or an honest muted <tkr> when there is none,
// in which case the row flashes rather than opening an empty panel.
// The menu never guesses a security.
struct MainMenuPanel: View {
    let paneID: UUID
    @EnvironmentObject var ws: Workspace

    private static let layout: [(String, [String])] = [
        ("Market Data",      ["GP", "GIP", "CMP", "WEI", "ECO"]),
        ("Company",          ["DES", "SMENU", "FA", "GF", "EARN", "CON",
                              "PEER", "FIL", "MGMT", "INSDR", "SPLC"]),
        ("Portfolio & Club", ["PM", "MOVR", "MACRO", "ICLUSTER", "ORG"]),
        ("News & World",     ["TOP", "CN", "WX", "RDR"]),
        ("Research",         ["RSCH", "BI", "NOTE", "ARCH"]),
        ("System",           ["HELP", "LAST"]),
    ]

    /// Everything native except MAIN itself.
    private var groups: [MenuGroup] {
        MenuBuild.groups(Self.layout, from: Registry.all.filter {
            $0.native && $0.id != "MAIN"
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("GRIFFIN TERMINAL")
                    .font(Term.mono(16, weight: .bold))
                    .foregroundStyle(Term.amber)
                Text("Select a function — type its number and press Return.")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider().overlay(Term.border)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(groups) { g in
                        VStack(alignment: .leading, spacing: 2) {
                            SectionLabel(text: g.title)
                                .padding(.horizontal, 10)
                            ForEach(g.items) { item in row(item) }
                        }
                    }
                }
                .padding(.vertical, 10)
            }
        }
        .onAppear(perform: publish)
        .onChange(of: ws.focusedID) { _, id in
            if id == paneID { publish() }
        }
    }

    private func row(_ item: MenuItem) -> some View {
        // The trailing chip reads ws.focusTicker on every render, so
        // loading a security elsewhere updates the whole page live.
        let needsTicker = item.fn.requires == "ticker"
        return MenuRow(
            n: item.n, code: item.fn.id, label: item.fn.label,
            trailing: needsTicker ? (ws.focusTicker ?? "<tkr>") : nil,
            trailingTone: ws.focusTicker == nil ? Term.fgMuted : Term.orange,
            action: action(for: item)
        )
    }

    private func action(for item: MenuItem) -> () -> Void {
        let fn = item.fn
        let id = paneID
        return { [weak ws] in
            guard let ws else { return }
            // Checked at fire time, not publish time: the sticky
            // ticker set after this menu appeared still counts.
            if fn.requires == "ticker", ws.focusTicker == nil {
                ws.flash = Workspace.Flash(
                    text: "\(fn.id) needs a ticker. Try  AIT \(fn.id)",
                    bad: true)
                return
            }
            // No ticker passed: retarget backfills the sticky ticker
            // for functions that need one, which is exactly what a
            // menu row promises by showing it.
            ws.retarget(id, fn: fn.id)
            ws.numberedMenu = nil
        }
    }

    private func publish() {
        var map: [Int: () -> Void] = [:]
        for g in groups {
            for item in g.items { map[item.n] = action(for: item) }
        }
        ws.publishNumbers(for: paneID, map)
    }
}

// MARK: - LAST — the recall stack

// The last eight screens, straight off ws.history. Menus and HELP are
// already excluded at record time, so every row here is a real screen
// worth going back to. Recalling one re-records it, which floats it
// back to slot 1 — the stack is most-recently-USED, like the real one.
struct LastPanel: View {
    let paneID: UUID
    @EnvironmentObject var ws: Workspace

    var body: some View {
        Group {
            if ws.history.isEmpty {
                PanelMessage(text: "No screens yet. Run a function — the last eight land here, numbered for recall.")
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        SectionLabel(text: "Last screens")
                        Spacer()
                        Text("number + Return recalls")
                            .font(Term.mono(9))
                            .foregroundStyle(Term.fgMuted)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)

                    Divider().overlay(Term.border)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(ws.history.enumerated()), id: \.offset) { i, e in
                                MenuRow(
                                    n: i + 1,
                                    code: e.ticker.map { "\($0) · \(e.fn)" } ?? e.fn,
                                    label: Registry.function(e.fn)?.label ?? "",
                                    codeWidth: 120,
                                    action: action(for: e)
                                )
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
        }
        .onAppear(perform: publish)
        .onChange(of: ws.focusedID) { _, id in
            if id == paneID { publish() }
        }
        // The published closures snapshot entries, so a history that
        // shifts under a focused LAST pane must republish or a digit
        // would recall what USED to be in that slot.
        .onChange(of: ws.history) { _, _ in
            if ws.focusedID == paneID { publish() }
        }
    }

    private func action(for entry: Workspace.HistoryEntry) -> () -> Void {
        let id = paneID
        return { [weak ws] in
            guard let ws else { return }
            // .some(entry.ticker) even when nil: recalling WEI must
            // WRITE the nil, not inherit whatever this pane held —
            // .none would mean "leave the ticker alone", which is a
            // different promise than "restore that screen".
            ws.retarget(id, fn: entry.fn, ticker: .some(entry.ticker))
            ws.numberedMenu = nil
        }
    }

    private func publish() {
        var map: [Int: () -> Void] = [:]
        for (i, e) in ws.history.enumerated() {
            map[i + 1] = action(for: e)
        }
        ws.publishNumbers(for: paneID, map)
    }
}
