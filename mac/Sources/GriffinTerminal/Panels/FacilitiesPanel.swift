import SwiftUI
import MapKit

// FAC — where a company's plants are.
//
// The question this answers is the one Thomas asked: which of our
// companies has something in my town. A 10-K says "we operate 40
// manufacturing facilities"; this says Johns Manville, 1465 17th Ave,
// McPherson, Kansas, and gives you the coordinates.
//
// The filter is the point rather than a convenience. Two hundred and
// seventy Berkshire sites is a list nobody reads; "KS" is three
// keystrokes and the answer.
struct FacilitiesPanel: View {
    let ticker: String

    @State private var state: Loadable<Payload> = .loading
    @State private var query = ""
    @State private var camera: MapCameraPosition = .automatic
    @State private var picked: Site?
    /// The map is the point; the list is the fallback for records EPA
    /// never geocoded, which cannot be pinned and would otherwise vanish.
    @State private var asList = false

    struct Payload: Decodable {
        let ticker: String?
        let company: String?
        let term: String?
        let facilities: [Site]?
        let mapped: Int?
        let truncated: Bool?
        let caveat: String?
    }

    struct Site: Decodable, Identifiable {
        let id: String?
        let name: String?
        let parent: String?
        let address: String?
        let city: String?
        let county: String?
        let state: String?
        let zip: String?
        let lat: Double?
        let lon: Double?
        /// True when we worked the position out from the street address
        /// rather than EPA surveying it. Shown, because one is measured
        /// and the other inferred.
        let geocoded: Bool?
        var key: String { id ?? "\(name ?? "")-\(city ?? "")-\(state ?? "")" }

        /// Everything a person might type: the town, the state, the
        /// street, the plant's own name.
        func matches(_ q: String) -> Bool {
            guard !q.isEmpty else { return true }
            let hay = [name, city, county, state, address, zip, parent]
                .compactMap { $0 }.joined(separator: " ").uppercased()
            return hay.contains(q.uppercased())
        }
    }

    var body: some View {
        PanelState(state: state,
                   emptyWhen: { ($0.facilities ?? []).isEmpty },
                   emptyText: "No facilities on file. EPA's registry covers manufacturing and processing sites above a reporting threshold, so a bank, an insurer or a software company files nothing here. That is not evidence of no operations.",
                   retry: { Task { await load() } }) { p in
            let all = p.facilities ?? []
            let shown = all.filter { $0.matches(query) }
            VStack(alignment: .leading, spacing: 0) {
                header(p, showing: shown.count, total: all.count)
                Divider().overlay(Term.border)
                if asList {
                    columnHeads
                    Divider().overlay(Term.border)
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(shown) { row($0) }
                        }
                    }
                } else {
                    map(shown)
                }
                if let c = p.caveat {
                    Text(c)
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Term.bgHeader)
                }
            }
        }
        .task(id: ticker) { await load() }
    }

    private func header(_ p: Payload, showing: Int, total: Int) -> some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Facilities")
            Text(p.company ?? ticker)
                .font(Term.mono(11)).foregroundStyle(Term.white).lineLimit(1)
            Text(showing == total ? "\(total) sites" : "\(showing) of \(total)")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
            // Coordinates are missing on plenty of older records. Saying
            // how many are mappable stops a future map looking broken.
            if let m = p.mapped, m < total {
                Text("\(m) with coordinates")
                    .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
            }
            if p.truncated == true {
                Text("TRUNCATED")
                    .font(Term.mono(9, weight: .bold)).foregroundStyle(Term.amber)
                    .help("The registry returned its maximum page — there are more sites than these")
            }
            Button(asList ? "Map" : "List") { asList.toggle() }
                .buttonStyle(TermButtonStyle())
            Spacer()
            TextField("", text: $query,
                      prompt: Text("town, state or street").foregroundStyle(Term.fgMuted))
                .textFieldStyle(.plain)
                .font(Term.mono(10)).foregroundStyle(Term.amber)
                .padding(4).background(Term.bg).termBorder()
                .frame(width: 200)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    /// Pins, and the ones that cannot be pinned said out loud.
    @ViewBuilder
    private func map(_ sites: [Site]) -> some View {
        let placed = sites.filter { $0.lat != nil && $0.lon != nil }
        ZStack(alignment: .bottomLeading) {
            Map(position: $camera) {
                ForEach(placed) { s in
                    Annotation(s.name ?? "", coordinate: CLLocationCoordinate2D(
                        latitude: s.lat!, longitude: s.lon!)) {
                        Button { picked = s } label: {
                            // Amber, because it is a thing of ours on a
                            // map that belongs to Apple.
                            Circle()
                                .fill(Term.amber)
                                .stroke(Term.bg, lineWidth: 1.5)
                                .frame(width: picked?.key == s.key ? 13 : 9,
                                       height: picked?.key == s.key ? 13 : 9)
                        }
                        .buttonStyle(.plain)
                        .help("\(s.name ?? "") — \(s.city ?? ""), \(s.state ?? "")")
                    }
                }
            }
            .mapStyle(.standard(elevation: .flat))

            VStack(alignment: .leading, spacing: 4) {
                if let s = picked {
                    // The detail sits over the map rather than in a
                    // sidebar: one pin at a time is what anybody clicking
                    // a map wants, and a permanent panel would eat the
                    // half of the country you are looking at.
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.name ?? "").font(Term.mono(11, weight: .bold)).foregroundStyle(Term.white)
                        Text([s.address, s.city, s.state, s.zip].compactMap { $0 }.joined(separator: ", "))
                            .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                        HStack(spacing: 8) {
                            Button("Open in Maps") { if let u = mapsURL(s) { NSWorkspace.shared.open(u) } }
                                .buttonStyle(TermButtonStyle())
                            Button("Close") { picked = nil }.buttonStyle(TermButtonStyle())
                        }
                    }
                    .padding(8)
                    .background(Term.bgPanel)
                    .termBorder()
                }
                if placed.count < sites.count && placed.count > 0 {
                    // Never silently drop them. A site with no coordinates
                    // is a real plant EPA never geocoded, and the list
                    // view is where it can still be read.
                    Text("\(sites.count - placed.count) of \(sites.count) not placed yet — their addresses are being geocoded, reopen shortly")
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(Term.bgHeader)
                }
            }
            .padding(10)
        }
    }

    private var columnHeads: some View {
        HStack(spacing: 8) {
            Text("ST").frame(width: 28, alignment: .leading)
            Text("FACILITY").frame(width: 240, alignment: .leading)
            Text("CITY").frame(width: 150, alignment: .leading)
            Text("ADDRESS").frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            Text("COORDS").frame(width: 150, alignment: .trailing)
        }
        .font(Term.mono(9, weight: .bold)).tracking(0.5)
        .foregroundStyle(Term.blue)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }

    private func row(_ s: Site) -> some View {
        HStack(spacing: 8) {
            Text(s.state ?? "—")
                .font(Term.mono(11, weight: .bold)).foregroundStyle(Term.amber)
                .frame(width: 28, alignment: .leading)
            Text(s.name ?? "—")
                .font(Term.mono(11)).foregroundStyle(Term.white)
                .lineLimit(1).frame(width: 240, alignment: .leading)
            Text(s.city ?? "")
                .font(Term.mono(10)).foregroundStyle(Term.fgDim)
                .lineLimit(1).frame(width: 150, alignment: .leading)
            Text(s.address ?? "")
                .font(Term.mono(10)).foregroundStyle(Term.fgMuted)
                .lineLimit(1).frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            // A dash, not a blank: a site without coordinates is a real
            // record with one field missing, not an empty row.
            Text(coords(s))
                .font(Term.mono(9)).foregroundStyle(s.lat == nil ? Term.fgMuted : Term.fgDim)
                .frame(width: 150, alignment: .trailing)
        }
        .padding(.horizontal, 10).padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { if let u = mapsURL(s) { NSWorkspace.shared.open(u) } }
        .help(mapsURL(s) == nil ? "No coordinates on this record" : "Open in Maps")
    }

    private func coords(_ s: Site) -> String {
        guard let la = s.lat, let lo = s.lon else { return "not placed yet" }
        // A tilde marks a position we derived from the address rather
        // than one EPA surveyed. Same map pin, different provenance.
        return String(format: "%@%.4f, %.4f", s.geocoded == true ? "~" : "", la, lo)
    }

    private func mapsURL(_ s: Site) -> URL? {
        if let la = s.lat, let lo = s.lon {
            return URL(string: "https://maps.apple.com/?ll=\(la),\(lo)&q=\(enc(s.name ?? "Facility"))")
        }
        // Fall back to the address, which is on every record even when
        // the coordinates are not.
        let parts = [s.address, s.city, s.state, s.zip].compactMap { $0 }.joined(separator: " ")
        guard !parts.isEmpty else { return nil }
        return URL(string: "https://maps.apple.com/?q=\(enc(parts))")
    }

    private func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
    }

    private func load() async {
        state = .loading
        do {
            let data = try await API.shared.get("/terminal/facilities/\(ticker)")
            state = .loaded(try await API.shared.decode(Payload.self, from: data))
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
