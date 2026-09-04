import SwiftUI

// ORG — the club org chart, in the terminal.
//
// A port of client/src/pages/Organization.jsx, which stays the source
// of truth for tier order, role labels and the advisory split. Same
// deal as the web page: this is a map, not a dossier — every person is
// one click from their profile, and the profile page (pitch record,
// hit rate, coverage) is where the substance lives. The terminal has
// no profile panel, so the click opens the website in the browser.
//
// PM-and-above on purpose, mirroring the web's isPmOrAbove gate: the
// chart shows the whole membership with reporting structure at a
// glance, which is leadership information. Below that role the panel
// degrades politely — it is not an error to be a junior analyst.
struct OrganizationPanel: View {
    struct IndustryRef: Decodable {
        let id: Int
        let name: String
    }

    struct Member: Decodable, Identifiable {
        let id: Int
        let name: String
        let role: String?
        let extraRoles: [String]?
        let industries: [IndustryRef]?
    }

    struct PersonRef: Decodable, Identifiable {
        let id: Int
        let name: String
        let role: String?
    }

    struct Industry: Decodable, Identifiable {
        let id: Int
        let name: String
        let leader: PersonRef?
        let members: [PersonRef]?
    }

    struct Payload {
        let users: [Member]
        let industries: [Industry]
        // The web silently degrades a dead /industries to an empty
        // list. Here the degradation is kept but stated: pods missing
        // because the feed failed must not read as "no industries".
        let industriesNote: String?
    }

    // Tier order is the chart. Analysts share a rung with senior
    // analysts, as on the web; junior analysts are the wide base and
    // render compact so they cannot push the structure off screen.
    private struct Tier {
        let label: String
        let roles: [String]
        var compact = false
    }

    private static let tiers: [Tier] = [
        Tier(label: "Presidents", roles: ["President"]),
        Tier(label: "Director of Research", roles: ["DirectorOfResearch"]),
        Tier(label: "Chief Investment Officers", roles: ["CIO"]),
        Tier(label: "Chief of Communication", roles: ["ChiefOfCommunication"]),
        Tier(label: "Senior Portfolio Managers", roles: ["SeniorPortfolioManager"]),
        Tier(label: "Portfolio Managers", roles: ["PortfolioManager"]),
        Tier(label: "Analysts", roles: ["SeniorAnalyst", "Analyst"]),
        Tier(label: "Junior Analysts", roles: ["JuniorAnalyst"], compact: true),
    ]

    private static let advisoryRoles: Set<String> =
        ["AdvisoryBoardMember", "FacultyAdvisory", "FacultyAdvisor"]

    private static let roleShort: [String: String] = [
        "President": "President",
        "DirectorOfResearch": "Director of Research",
        "CIO": "CIO",
        "ChiefOfCommunication": "Comms",
        "SeniorPortfolioManager": "Senior PM",
        "PortfolioManager": "PM",
        "SeniorAnalyst": "Senior Analyst",
        "Analyst": "Analyst",
        "JuniorAnalyst": "Junior Analyst",
        "AdvisoryBoardMember": "Advisory Board",
        "FacultyAdvisory": "Faculty Advisor",
        "FacultyAdvisor": "Faculty Advisor",
    ]

    private static func short(_ role: String?) -> String {
        guard let role, !role.isEmpty else { return "—" }
        return roleShort[role] ?? role
    }

    @EnvironmentObject var session: Session
    @State private var state: Loadable<Payload> = .loading

    // Mirrors the web's isPmOrAbove exactly. Super admin is an email
    // match on the server and is not surfaced on API.Me, so it cannot
    // be checked here — same as the web page, which also gates on role
    // alone. The server serves /users to any member regardless; this
    // gate is about what the panel shows, not what it could fetch.
    private var pmOrAbove: Bool {
        guard let role = session.user?.role else { return false }
        return ["President", "DirectorOfResearch", "CIO", "SeniorPortfolioManager", "PortfolioManager"]
            .contains(role)
    }

    var body: some View {
        if pmOrAbove {
            PanelState(state: state,
                       emptyWhen: { $0.users.isEmpty },
                       emptyText: "No members on file.",
                       retry: { Task { await load() } }) { p in
                VStack(alignment: .leading, spacing: 0) {
                    header(p)
                    Divider().overlay(Term.border)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            chart(p)
                            advisory(p)
                            pods(p)
                        }
                        .padding(10)
                    }
                }
            }
            .task { await load() }
        } else {
            // Degraded, not broken. The sentence is the whole render.
            PanelMessage(text: "ORG is PM and above.")
        }
    }

    // MARK: Header

    private func header(_ p: Payload) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Organization")
            Text("\(p.users.count) members")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            Spacer()
            Text("click a name to open the profile")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgMuted)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: The chart

    private func chart(_ p: Payload) -> some View {
        // Industries each person LEADS — leadership is the org-chart
        // fact; membership stays down on the pods.
        var ledBy: [Int: [String]] = [:]
        for ind in p.industries {
            if let id = ind.leader?.id { ledBy[id, default: []].append(ind.name) }
        }
        return ForEach(Self.tiers, id: \.label) { tier in
            let people = p.users.filter { tier.roles.contains($0.role ?? "") }
            if !people.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    tierRule(tier.label, count: people.count)
                    if tier.compact {
                        compactGrid(people)
                    } else {
                        ForEach(people) { person in
                            personRow(person, leads: ledBy[person.id] ?? [])
                        }
                    }
                }
            }
        }
    }

    /// A ruled tier header: the horizontal line is what makes seven
    /// groups read as one descending structure rather than seven lists.
    private func tierRule(_ label: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(label.uppercased())
                .font(Term.mono(9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(Term.fgMuted)
            Text("\(count)")
                .font(Term.mono(9))
                .foregroundStyle(Term.fgDim)
            Rectangle().fill(Term.border).frame(height: 1)
        }
    }

    private func personRow(_ p: Member, leads: [String], muted: Bool = false) -> some View {
        HStack(spacing: 8) {
            personLink(id: p.id) {
                Text(p.name)
                    .font(Term.mono(11, weight: .bold))
                    .foregroundStyle(muted ? Term.fgDim : Term.white)
                    .lineLimit(1)
            }
            Text(Self.short(p.role))
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            ForEach(p.extraRoles ?? [], id: \.self) { r in
                chip(Self.short(r), tone: Term.fgMuted)
            }
            // Amber for the books they run — the one fact the chart
            // adds on top of the role ladder.
            ForEach(leads, id: \.self) { name in
                chip(name, tone: Term.amber)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 4)
    }

    /// Junior analysts as a name grid, not rows. Full rows for the
    /// widest tier would scroll the actual structure out of view; a
    /// grid keeps them present and clickable at a glance.
    private func compactGrid(_ people: [Member]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 8, alignment: .leading)],
                  alignment: .leading, spacing: 2) {
            ForEach(people) { p in
                personLink(id: p.id) {
                    Text(p.name)
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgDim)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.leading, 4)
    }

    // MARK: Advisory

    // Beside the chart, not inside it — advisors advise the structure,
    // they are not a rung of it. Muted for the same reason.
    @ViewBuilder
    private func advisory(_ p: Payload) -> some View {
        let people = p.users.filter { Self.advisoryRoles.contains($0.role ?? "") }
        if !people.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                SectionLabel(text: "Advisory Board & Faculty")
                ForEach(people) { person in
                    personRow(person, leads: [], muted: true)
                }
            }
        }
    }

    // MARK: Industry pods

    @ViewBuilder
    private func pods(_ p: Payload) -> some View {
        if let note = p.industriesNote {
            VStack(alignment: .leading, spacing: 3) {
                SectionLabel(text: "Industry Groups")
                Text("Could not load industry groups. \(note)")
                    .font(Term.mono(10))
                    .foregroundStyle(Term.negative)
            }
        } else if !p.industries.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel(text: "Industry Groups")
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 8, alignment: .topLeading)],
                          alignment: .leading, spacing: 8) {
                    ForEach(p.industries) { ind in pod(ind) }
                }
            }
        }
    }

    private func pod(_ ind: Industry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(ind.name)
                .font(Term.mono(11, weight: .bold))
                .foregroundStyle(Term.white)
                .lineLimit(1)
            let members = sortedMembers(ind)
            ForEach(members) { m in
                HStack(spacing: 5) {
                    // The star is the leader; the fixed slot keeps the
                    // names in a column whether or not a row has one.
                    Text(m.id == ind.leader?.id ? "★" : " ")
                        .font(Term.mono(10))
                        .foregroundStyle(Term.amber)
                        .frame(width: 10, alignment: .leading)
                    personLink(id: m.id) {
                        Text(m.name)
                            .font(Term.mono(10))
                            .foregroundStyle(Term.fg)
                            .lineLimit(1)
                    }
                    Text(Self.short(m.role))
                        .font(Term.mono(9))
                        .foregroundStyle(Term.fgMuted)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            if members.isEmpty {
                Text("No members assigned.")
                    .font(Term.mono(9))
                    .foregroundStyle(Term.fgMuted)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Term.bg)
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
    }

    /// Leader first, then alphabetical — same ordering the web pods use.
    private func sortedMembers(_ ind: Industry) -> [PersonRef] {
        let leaderId = ind.leader?.id
        return (ind.members ?? []).sorted { a, b in
            if a.id == leaderId { return true }
            if b.id == leaderId { return false }
            return a.name.localizedCompare(b.name) == .orderedAscending
        }
    }

    // MARK: Shared bits

    /// Every clickable person goes through here so the door is the
    /// same everywhere: the member's profile page, in the browser.
    private func personLink<Label: View>(id: Int, @ViewBuilder label: () -> Label) -> some View {
        Button {
            NSWorkspace.shared.open(URL(string: "https://thegriffinfund.org/members/\(id)")!)
        } label: {
            label().contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
    }

    private func chip(_ text: String, tone: Color) -> some View {
        Text(text.uppercased())
            .font(Term.mono(8, weight: .bold))
            .tracking(0.5)
            .foregroundStyle(tone)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Term.bgHeader)
            .lineLimit(1)
    }

    // MARK: Load

    private func load() async {
        state = .loading
        async let usersLeg = fetchUsers()
        async let industriesLeg = fetchIndustries()
        let (users, industries) = await (usersLeg, industriesLeg)

        switch users {
        case .failure(let e):
            // No roster, no chart. The server's own sentence survives
            // through localizedDescription.
            state = .failed(e.localizedDescription)
        case .success(let u):
            switch industries {
            case .success(let i):
                state = .loaded(Payload(users: u, industries: i, industriesNote: nil))
            case .failure(let e):
                // The chart is still worth having with the pods dark —
                // but dark is stated, not passed off as empty.
                state = .loaded(Payload(users: u, industries: [],
                                        industriesNote: e.localizedDescription))
            }
        }
    }

    private func fetchUsers() async -> Result<[Member], Error> {
        do {
            let data = try await API.shared.get("/users")
            return .success(try await API.shared.decode([Member].self, from: data))
        } catch { return .failure(error) }
    }

    private func fetchIndustries() async -> Result<[Industry], Error> {
        do {
            let data = try await API.shared.get("/industries")
            return .success(try await API.shared.decode([Industry].self, from: data))
        } catch { return .failure(error) }
    }
}
