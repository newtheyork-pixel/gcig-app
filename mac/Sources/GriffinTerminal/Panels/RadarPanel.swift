import SwiftUI
import MapKit

// RDR — live US weather radar under active NWS warnings.
//
// Same two feeds, same two paths as the web panel. The NEXRAD base
// reflectivity tiles come straight from the Iowa Environmental
// Mesonet to the app — public images, no datacenter-IP wall, no
// reason to proxy hundreds of tiles through our API. The warning
// polygons come from /terminal/wx-alerts, the one server hop,
// because NWS wants a User-Agent a browser fetch can't set (the
// server can). Shape from wxAlerts.js: the FeatureCollection is
// mapped storm-based warnings only; zone/county advisories arrive
// with no inline geometry and are counted (`areaOnlyCount`), never
// fabricated. Distinct from WX (the historical landfall event
// study): this is what is happening now.
//
// The web draws the detail card on polygon click. Here the list
// below the map is the click surface — a row expands to the same
// card content — because polygon hit-testing through an MKMapView
// gesture buys nothing the list doesn't already give.
struct RadarPanel: View {
    // MARK: Server shape (wxAlerts.js)

    struct ListItem: Decodable {
        // `color` is stripped from list rows server-side; the paint
        // color rides only on the mapped features.
        let id: String?
        let event: String?
        let severity: String?
        let headline: String?
        let areaDesc: String?
        let effective: String?
        let expires: String?
    }

    struct AlertProps: Decodable {
        let id: String?
        let event: String?
        let severity: String?
        let headline: String?
        let areaDesc: String?
        let expires: String?
        let color: String?
    }

    // GeoJSON geometry, reduced to what the map draws. NWS storm
    // polygons don't carry holes, so interior rings are dropped
    // rather than round-tripped through MKPolygon(interiorPolygons:)
    // for a case that never occurs.
    struct AlertGeometry: Decodable {
        let outerRings: [[[Double]]]

        private enum K: String, CodingKey { case type, coordinates }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            let t = (try? c.decode(String.self, forKey: .type)) ?? ""
            switch t {
            case "Polygon":
                let rings = (try? c.decode([[[Double]]].self, forKey: .coordinates)) ?? []
                outerRings = rings.first.map { [$0] } ?? []
            case "MultiPolygon":
                let polys = (try? c.decode([[[[Double]]]].self, forKey: .coordinates)) ?? []
                outerRings = polys.compactMap(\.first)
            default:
                outerRings = []
            }
        }
    }

    struct AlertFeature: Decodable {
        let geometry: AlertGeometry?
        let properties: AlertProps?
    }

    struct FeatureCollection: Decodable {
        let features: [AlertFeature]?
    }

    struct Payload: Decodable {
        let asOf: String?
        let total: Int?
        let mappedCount: Int?
        let areaOnlyCount: Int?
        let counts: [String: Int]?
        let features: FeatureCollection?
        let list: [ListItem]?
    }

    private struct Brief: Decodable { let brief: String? }

    // MARK: State

    @State private var state: Loadable<Payload> = .loading
    // Bumped every refresh and appended to the tile template as ?v=,
    // the web's exact cache-bust: IEM re-renders the same path ~5 min,
    // so without the bump the URL cache serves stale reflectivity.
    @State private var radarVersion = 1
    @State private var lastUpdated: Date? = nil
    @State private var selectedID: String? = nil

    @State private var brief: String? = nil
    @State private var briefLoading = false
    @State private var briefTask: Task<Void, Never>? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Term.border)
            mapBlock
            Divider().overlay(Term.border)
            alertsSection
                .frame(height: 176)
            Divider().overlay(Term.border)
            briefBlock
            Divider().overlay(Term.border)
            footer
        }
        // First fetch + the web's 5-minute loop: each tick re-pulls
        // the alerts and busts the radar tiles. Dies with the view.
        .task {
            await load(first: true)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(300))
                guard !Task.isCancelled else { break }
                radarVersion += 1
                await load(first: false)
            }
        }
    }

    // MARK: Derived

    private var loaded: Payload? {
        if case .loaded(let p) = state { return p }
        return nil
    }

    private var alertsFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    private func totalActive(_ p: Payload) -> Int {
        (p.mappedCount ?? 0) + (p.areaOnlyCount ?? 0)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Weather Radar · Live")
            Spacer()
            Text("updated \(lastUpdated.map(clock) ?? "—")")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
            Button("↻") {
                radarVersion += 1
                Task { await load(first: false) }
            }
            .buttonStyle(TermButtonStyle())
            .help("Refresh radar + alerts")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: Map

    private var mapBlock: some View {
        ZStack(alignment: .bottomLeading) {
            RadarMap(
                features: loaded?.features?.features ?? [],
                stamp: "\(loaded?.asOf ?? "none")#\(loaded?.features?.features?.count ?? 0)",
                radarVersion: radarVersion
            )
            legendOverlay
        }
        .frame(minHeight: 280, maxHeight: .infinity)
    }

    // The server's own paint palette (COLOR_RULES in wxAlerts.js),
    // mirrored exactly the way the web's LEGEND constant mirrors it.
    // These are data colors the polygons arrive wearing in the
    // payload's `color` field, not theme colors — Term has no claim
    // on them, and retuning them here would desynchronize the legend
    // from the shapes it explains.
    private static let legendEntries: [(String, String)] = [
        ("Tornado", "#ff2d2d"),
        ("Severe T-storm", "#ff8c00"),
        ("Flood", "#2ecc71"),
        ("Tropical", "#ff5fa2"),
        ("Winter", "#4aa3ff"),
        ("Heat / Fire", "#ffd23f"),
    ]

    private var legendOverlay: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                ForEach(Self.legendEntries.prefix(3), id: \.0) { entry in
                    legendChip(entry.0, entry.1)
                }
            }
            HStack(spacing: 10) {
                ForEach(Self.legendEntries.suffix(3), id: \.0) { entry in
                    legendChip(entry.0, entry.1)
                }
            }
            // The web's two degraded sentences, verbatim. A dead
            // alerts feed still leaves a working radar, and saying so
            // on the map beats a blank chip.
            if alertsFailed {
                Text("NWS alerts unavailable — radar only.")
                    .foregroundStyle(Term.negative)
            } else if let a = loaded?.areaOnlyCount, a > 0 {
                Text("+\(a) area-based advisories not drawn")
                    .foregroundStyle(Term.fgMuted)
            }
        }
        .font(Term.mono(9))
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Term.bg.opacity(0.85))
        .overlay(Rectangle().strokeBorder(Term.border, lineWidth: 1))
        .padding(8)
        .allowsHitTesting(false)
    }

    private func legendChip(_ label: String, _ hex: String) -> some View {
        HStack(spacing: 4) {
            Rectangle().fill(dataColor(hex)).frame(width: 9, height: 9)
            Text(label)
        }
        .foregroundStyle(Term.fgDim)
    }

    // MARK: Alerts list

    private var alertsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                SectionLabel(text: "Active Warnings")
                if let p = loaded {
                    Text("\(p.list?.count ?? 0) drawn · \(p.areaOnlyCount ?? 0) area-only")
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgMuted)
                }
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            // Three renders that must never collapse into each other:
            // still fetching, feed dead (radar survives; the failure
            // is named, with the transport sentence), and genuinely
            // quiet skies.
            switch state {
            case .loading:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).tint(Term.amber)
                    Text("Loading").font(Term.mono(11)).foregroundStyle(Term.fgMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            case .failed(let msg):
                VStack(spacing: 6) {
                    Text("NWS alerts unavailable — radar only.")
                        .font(Term.mono(11))
                        .foregroundStyle(Term.negative)
                    Text(msg)
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgDim)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await load(first: true) } }
                        .buttonStyle(TermButtonStyle())
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            case .loaded(let p):
                if totalActive(p) == 0 {
                    PanelMessage(text: "No active NWS warnings nationwide.")
                } else if (p.list ?? []).isEmpty {
                    // Active advisories exist but none carry a shape —
                    // an empty list here is not an empty country.
                    PanelMessage(text: "No storm-based warnings to draw — "
                        + "\(p.areaOnlyCount ?? 0) area-based advisories "
                        + "active (no inline shape).")
                } else {
                    alertList(p)
                }
            }
        }
    }

    private func alertList(_ p: Payload) -> some View {
        // The list drops `color`, but ids match the mapped features,
        // so the swatch that keys a row to its polygon is a join away.
        var paint: [String: String] = [:]
        for f in p.features?.features ?? [] {
            if let id = f.properties?.id, let c = f.properties?.color,
               paint[id] == nil {
                paint[id] = c
            }
        }
        let items = p.list ?? []
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, a in
                    alertRow(idx: idx, a: a, hex: paint[a.id ?? ""])
                }
            }
        }
    }

    private func rowKey(_ idx: Int, _ a: ListItem) -> String {
        (a.id?.isEmpty == false ? a.id : nil) ?? "row-\(idx)"
    }

    private func alertRow(idx: Int, a: ListItem, hex: String?) -> some View {
        let key = rowKey(idx, a)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                selectedID = (selectedID == key) ? nil : key
            } label: {
                HStack(spacing: 8) {
                    Rectangle()
                        .fill(dataColor(hex ?? "#9aa0a6"))
                        .frame(width: 9, height: 9)
                    Text(a.event ?? "Alert")
                        .font(Term.mono(11, weight: .medium))
                        .foregroundStyle(Term.white)
                        .lineLimit(1)
                        .frame(width: 186, alignment: .leading)
                    Text(a.severity ?? "Unknown")
                        .font(Term.mono(10))
                        .foregroundStyle(severityTone(a.severity))
                        .frame(width: 66, alignment: .leading)
                    Text(a.areaDesc?.isEmpty == false ? (a.areaDesc ?? "") : "—")
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgMuted)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(fmtExpires(a.expires))
                        .font(Term.mono(10))
                        .foregroundStyle(Term.fgDim)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)

            if selectedID == key { detail(a) }
        }
    }

    // The clicked-alert card from the web, inline under its row.
    private func detail(_ a: ListItem) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let area = a.areaDesc, !area.isEmpty {
                Text(area)
                    .font(Term.mono(10))
                    .foregroundStyle(Term.white)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let h = a.headline, !h.isEmpty {
                Text(h)
                    .font(Term.mono(10))
                    .foregroundStyle(Term.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("expires \(fmtExpires(a.expires))")
                .font(Term.mono(10))
                .foregroundStyle(Term.fgMuted)
        }
        .padding(.leading, 27)
        .padding(.trailing, 10)
        .padding(.bottom, 5)
    }

    // The NWS severity enum, most urgent hottest. Unknown stays
    // muted — an unranked alert should not borrow urgency.
    private func severityTone(_ s: String?) -> Color {
        switch s {
        case "Extreme":  return Term.negative
        case "Severe":   return Term.orange
        case "Moderate": return Term.amber
        case "Minor":    return Term.blue
        default:         return Term.fgMuted
        }
    }

    // MARK: AI brief

    private var briefBlock: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("◢ AI BRIEF")
                .font(Term.mono(9, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(Term.amber)
            Text(briefText)
                .font(Term.mono(10))
                .foregroundStyle(Term.fgDim)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var briefText: String {
        if briefLoading { return "Generating…" }
        if let p = loaded, totalActive(p) == 0 {
            return "No active NWS warnings nationwide."
        }
        if let b = brief, !b.isEmpty { return b }
        return "No brief available."
    }

    // The web's footer sentence, verbatim — the honesty line about
    // what is drawn versus merely counted belongs next to the map.
    private var footer: some View {
        Text("Radar: NEXRAD base reflectivity (Iowa Environmental "
             + "Mesonet), refreshed ~5 min. Warnings: NWS active alerts "
             + "(api.weather.gov). Storm-based warnings (tornado / severe "
             + "TS / flash flood) draw as polygons; many county/zone "
             + "advisories carry no inline shape and are counted, not "
             + "drawn. Current conditions, not a forecast.")
            .font(Term.mono(9))
            .foregroundStyle(Term.fgMuted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
    }

    // MARK: Loading

    private func load(first: Bool) async {
        if first { state = .loading }
        do {
            let data = try await API.shared.get("/terminal/wx-alerts")
            let p = try await API.shared.decode(Payload.self, from: data)
            state = .loaded(p)
            lastUpdated = Date()
            // Confab-safe brief, the web's rule: only ask the LLM when
            // there is something to read. Zero active warnings skips
            // the call entirely. Re-requested per refresh (5-minute
            // cadence, same as the web's data-change effect), with the
            // previous request cancelled so answers can't cross.
            briefTask?.cancel()
            if totalActive(p) == 0 {
                brief = ""
                briefLoading = false
            } else {
                let snapshot = p
                briefTask = Task { await requestBrief(snapshot) }
            }
        } catch {
            // The web stamps the attempt clock on failure too — the
            // header says when we last tried, the chip says it failed.
            lastUpdated = Date()
            // A dropped refresh keeps the last good tape; only a true
            // first-paint failure renders as one.
            if case .loaded = state { return }
            state = .failed(error.localizedDescription)
        }
    }

    private func requestBrief(_ p: Payload) async {
        briefLoading = true
        defer { if !Task.isCancelled { briefLoading = false } }
        var lines: [String] = []
        lines.append("Active warnings drawn on map: \(p.mappedCount ?? 0).")
        // Sorted for a stable prompt; JS object order is insertion
        // luck and not worth reproducing.
        let counts = (p.counts ?? [:]).sorted { $0.key < $1.key }
        if !counts.isEmpty {
            lines.append("By type: "
                + counts.map { "\($0.key): \($0.value)" }.joined(separator: ", ")
                + ".")
        }
        if let a = p.areaOnlyCount, a > 0 {
            lines.append("Plus \(a) area-based advisories without inline geometry.")
        }
        lines.append("")
        lines.append("Most severe (severity · event · area · expires):")
        for a in (p.list ?? []).prefix(12) {
            let area = a.areaDesc?.isEmpty == false ? (a.areaDesc ?? "") : "—"
            lines.append("  \(a.severity ?? "Unknown") · \(a.event ?? "Alert")"
                + " · \(area) · expires \(fmtExpires(a.expires))")
        }
        do {
            let data = try await API.shared.post(
                "/terminal/annotate",
                json: ["function": "RDR", "context": lines.joined(separator: "\n")])
            guard !Task.isCancelled else { return }
            brief = (try await API.shared.decode(Brief.self, from: data)).brief ?? ""
        } catch {
            // The brief is garnish; the warnings are the payload. The
            // web swallows this the same way.
            guard !Task.isCancelled else { return }
            brief = ""
        }
    }

    // MARK: Formatting

    // Wall-clock and MM/dd HH:mm stamps, matching the web's fmtClock
    // and fmtExpires (viewer-local, 24h). Formatters built per call —
    // DateFormatter is not Sendable, so a static would trip strict
    // concurrency.
    private func clock(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    private func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    private func fmtExpires(_ s: String?) -> String {
        guard let d = parseISO(s) else { return "—" }
        let f = DateFormatter()
        f.dateFormat = "MM/dd HH:mm"
        return f.string(from: d)
    }

    // Payload hex → components. The server coalesces missing colors
    // to #9aa0a6; a bad string falls to the same default here so the
    // two ends can never disagree about the fallback.
    private func dataColor(_ hex: String?) -> Color {
        let (r, g, b) = Self.rgb(hex)
        return Color(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }

    static func rgb(_ hex: String?) -> (Double, Double, Double) {
        var s = (hex ?? "").trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else {
            return (0.604, 0.627, 0.651) // #9aa0a6
        }
        return (Double((v >> 16) & 0xff) / 255,
                Double((v >> 8) & 0xff) / 255,
                Double(v & 0xff) / 255)
    }
}

// MARK: - Map host

// MapKit does what maplibre does on the web, with the exact same
// radar source: IEM's cached NEXRAD N0Q composite is plain XYZ, and
// MKTileOverlay speaks {z}/{x}/{y} natively, so the template carries
// over verbatim — ?v= cache-bust included. Warnings sit at
// .aboveLabels with radar at .aboveRoads, the same stacking the web
// enforces by inserting the raster under alerts-fill: a tornado
// polygon must never hide beneath reflectivity.
private struct RadarMap: NSViewRepresentable {
    let features: [RadarPanel.AlertFeature]
    let stamp: String
    let radarVersion: Int

    static let tileTemplate =
        "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png"

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        // Dark base regardless of system theme. The terminal is a
        // dark surface; a light map would glow like a hole in it.
        map.appearance = NSAppearance(named: .darkAqua)
        let config = MKStandardMapConfiguration(elevationStyle: .flat,
                                                emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        map.preferredConfiguration = config
        map.showsCompass = false
        map.showsPitchControl = false
        map.showsZoomControls = true
        // CONUS, the web's center [-98.5, 39.5] at zoom 3.4.
        map.setRegion(MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 39.5, longitude: -98.5),
            span: MKCoordinateSpan(latitudeDelta: 28, longitudeDelta: 60)),
            animated: false)
        sync(map, context.coordinator)
        return map
    }

    func updateNSView(_ map: MKMapView, context: Context) {
        sync(map, context.coordinator)
    }

    // Overlays are diffed by hand: the tile layer swaps only when the
    // version bumps, the polygons only when the payload stamp moves.
    // Rebuilding both on every SwiftUI pass would flash the radar
    // white each time an unrelated @State changes.
    @MainActor
    private func sync(_ map: MKMapView, _ co: Coordinator) {
        if co.radarVersion != radarVersion {
            if let old = co.radar { map.removeOverlay(old) }
            let tiles = MKTileOverlay(
                urlTemplate: Self.tileTemplate + "?v=\(radarVersion)")
            tiles.canReplaceMapContent = false
            map.addOverlay(tiles, level: .aboveRoads)
            co.radar = tiles
            co.radarVersion = radarVersion
        }
        if co.stamp != stamp {
            map.removeOverlays(co.polygons)
            co.polygons = Self.polygons(from: features)
            map.addOverlays(co.polygons, level: .aboveLabels)
            co.stamp = stamp
        }
    }

    // GeoJSON positions are [lon, lat]; CoreLocation wants the other
    // order. The paint color rides in `title` — MKShape already has
    // the slot, and a subclass just to carry a string would drag its
    // own concurrency story along.
    static func polygons(from features: [RadarPanel.AlertFeature]) -> [MKPolygon] {
        features.flatMap { f -> [MKPolygon] in
            guard let rings = f.geometry?.outerRings, !rings.isEmpty else {
                return []
            }
            return rings.compactMap { ring -> MKPolygon? in
                let coords = ring.compactMap { pt -> CLLocationCoordinate2D? in
                    guard pt.count >= 2 else { return nil }
                    return CLLocationCoordinate2D(latitude: pt[1], longitude: pt[0])
                }
                guard coords.count >= 3 else { return nil }
                let poly = MKPolygon(coordinates: coords, count: coords.count)
                poly.title = f.properties?.color
                return poly
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        var radarVersion = 0
        var stamp = ""
        var radar: MKTileOverlay?
        var polygons: [MKPolygon] = []

        func mapView(_ mapView: MKMapView,
                     rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let tiles = overlay as? MKTileOverlay {
                let r = MKTileOverlayRenderer(tileOverlay: tiles)
                r.alpha = 0.6 // the web's raster-opacity
                return r
            }
            if let poly = overlay as? MKPolygon {
                // The web's paint block: fill 0.25, line 0.9 / 1.5px.
                let r = MKPolygonRenderer(polygon: poly)
                let (red, green, blue) = RadarPanel.rgb(poly.title)
                let base = NSColor(srgbRed: red, green: green,
                                   blue: blue, alpha: 1)
                r.fillColor = base.withAlphaComponent(0.25)
                r.strokeColor = base.withAlphaComponent(0.9)
                r.lineWidth = 1.5
                return r
            }
            return MKOverlayRenderer(overlay: overlay)
        }
    }
}
