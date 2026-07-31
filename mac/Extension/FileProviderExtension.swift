import FileProvider
import Foundation
import UniformTypeIdentifiers

// The Griffin Fund File Provider.
//
// Runs as its own sandboxed process, so it cannot reach the app's API
// client or its token file. It reads the session token from the App
// Group container the app writes to, and talks to the API itself.
//
// Identifiers encode the whole path, because the system asks about items
// out of order and in isolation — there is no "current directory" here,
// and an identifier that cannot answer "what are you and who is your
// parent" on its own forces a cache that goes stale.
//
//   NSFileProviderItemIdentifier.rootContainer   the top
//   p:<projectId>:<ticker>                       a project folder
//   d:<projectId>:<ticker>:<path>                a folder inside one
//   f:<artifactId>:<projectId>:<ticker>:<path>   a file
enum ID {
    static func project(_ pid: Int, _ ticker: String) -> String { "p:\(pid):\(ticker)" }
    static func dir(_ pid: Int, _ ticker: String, _ path: String) -> String { "d:\(pid):\(ticker):\(path)" }
    static func file(_ aid: Int, _ pid: Int, _ ticker: String, _ path: String) -> String {
        "f:\(aid):\(pid):\(ticker):\(path)"
    }
    /// Split on the first N colons only: a path may contain colons and a
    /// greedy split would lose everything after the first one.
    static func parts(_ raw: String, limit: Int) -> [String] {
        var out: [String] = []
        var rest = Substring(raw)
        for _ in 0..<limit {
            guard let i = rest.firstIndex(of: ":") else { break }
            out.append(String(rest[..<i]))
            rest = rest[rest.index(after: i)...]
        }
        out.append(String(rest))
        return out
    }
}

/// A class, not a struct: NSFileProviderItem inherits NSObjectProtocol,
/// so it can only be adopted by something Objective-C can hold on to.
final class Item: NSObject, NSFileProviderItem {
    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    let isFolder: Bool
    var size: NSNumber?

    init(itemIdentifier: NSFileProviderItemIdentifier,
         parentItemIdentifier: NSFileProviderItemIdentifier,
         filename: String, isFolder: Bool, size: NSNumber? = nil) {
        self.itemIdentifier = itemIdentifier
        self.parentItemIdentifier = parentItemIdentifier
        self.filename = filename
        self.isFolder = isFolder
        self.size = size
        super.init()
    }

    var capabilities: NSFileProviderItemCapabilities {
        // Read-only for now. Advertising write capabilities the extension
        // does not implement makes Finder offer a rename that then fails,
        // which is worse than a folder that is honestly read-only.
        isFolder ? [.allowsReading, .allowsContentEnumerating] : [.allowsReading]
    }
    var contentType: UTType { isFolder ? .folder : (UTType(filenameExtension: (filename as NSString).pathExtension) ?? .data) }
    var documentSize: NSNumber? { size }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data("1".utf8), metadataVersion: Data("1".utf8))
    }
}

/// The smallest API client that can serve a filesystem.
enum API {
    static let base = "https://gcig-api.onrender.com/api"

    static var token: String? {
        // The App Group container: the only place both processes can see.
        guard let dir = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "PW2VT56789.org.thegriffinfund.terminal")
        else { return nil }
        return try? String(contentsOf: dir.appendingPathComponent("session.token"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func get(_ path: String) async throws -> Data {
        guard let token, let url = URL(string: base + path) else {
            throw NSFileProviderError(.notAuthenticated)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 60
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 401 || http.statusCode == 403 {
            throw NSFileProviderError(.notAuthenticated)
        }
        return data
    }

    struct Project: Decodable { let id: Int; let ticker: String?; let name: String? }
    struct Detail: Decodable {
        let artifacts: [Row]?
        struct Row: Decodable { let id: Int; let title: String; let fileRef: String? }
    }

    static func projects() async throws -> [Project] {
        try JSONDecoder().decode([Project].self, from: try await get("/research/projects"))
            .filter { !($0.ticker ?? "").isEmpty }
    }

    static func artifacts(_ pid: Int) async throws -> [Detail.Row] {
        (try JSONDecoder().decode(Detail.self, from: try await get("/research/projects/\(pid)")).artifacts ?? [])
            .filter { ($0.fileRef ?? "").hasPrefix("onedrive:") }
    }
}

@objc(GriffinFileProvider)
final class GriffinFileProvider: NSObject, NSFileProviderReplicatedExtension {
    required init(domain: NSFileProviderDomain) { super.init() }
    func invalidate() {}

    func item(for identifier: NSFileProviderItemIdentifier,
              request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let raw = identifier.rawValue
        if identifier == .rootContainer || raw == NSFileProviderItemIdentifier.rootContainer.rawValue {
            completionHandler(Item(itemIdentifier: .rootContainer, parentItemIdentifier: .rootContainer,
                                   filename: "Griffin Fund", isFolder: true), nil)
            return Progress()
        }
        if raw.hasPrefix("p:") {
            let p = ID.parts(raw, limit: 2)
            completionHandler(Item(itemIdentifier: identifier, parentItemIdentifier: .rootContainer,
                                   filename: p.count > 2 ? p[2] : raw, isFolder: true), nil)
        } else if raw.hasPrefix("d:") {
            let p = ID.parts(raw, limit: 3)
            let path = p.count > 3 ? p[3] : ""
            completionHandler(Item(itemIdentifier: identifier,
                                   parentItemIdentifier: parentOf(path: path, pid: p[1], ticker: p[2]),
                                   filename: (path as NSString).lastPathComponent, isFolder: true), nil)
        } else if raw.hasPrefix("f:") {
            let p = ID.parts(raw, limit: 4)
            let path = p.count > 4 ? p[4] : ""
            completionHandler(Item(itemIdentifier: identifier,
                                   parentItemIdentifier: parentOf(path: path, pid: p[2], ticker: p[3]),
                                   filename: (path as NSString).lastPathComponent, isFolder: false), nil)
        } else {
            completionHandler(nil, NSFileProviderError(.noSuchItem))
        }
        return Progress()
    }

    /// A file at model/x.xlsx has folder "model" as its parent; a file at
    /// the top of a project has the project itself.
    private func parentOf(path: String, pid: String, ticker: String) -> NSFileProviderItemIdentifier {
        let dir = (path as NSString).deletingLastPathComponent
        if dir.isEmpty { return NSFileProviderItemIdentifier("p:\(pid):\(ticker)") }
        return NSFileProviderItemIdentifier("d:\(pid):\(ticker):\(dir)")
    }

    func fetchContents(for identifier: NSFileProviderItemIdentifier,
                       version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let raw = identifier.rawValue
        guard raw.hasPrefix("f:") else {
            completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
            return Progress()
        }
        let p = ID.parts(raw, limit: 4)
        guard p.count > 4, let aid = Int(p[1]), let pid = Int(p[2]) else {
            completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
            return Progress()
        }
        let path = p[4], ticker = p[3]
        Task {
            do {
                let rows = try await API.artifacts(pid)
                guard let row = rows.first(where: { $0.id == aid }),
                      let ref = row.fileRef?.replacingOccurrences(of: "onedrive:", with: ""),
                      let encoded = ref.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
                else { throw NSFileProviderError(.noSuchItem) }
                let bytes = try await API.get("/files/\(encoded)")
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString)
                    .appendingPathExtension((path as NSString).pathExtension)
                try bytes.write(to: tmp)
                completionHandler(tmp, Item(itemIdentifier: identifier,
                                            parentItemIdentifier: parentOf(path: path, pid: p[2], ticker: ticker),
                                            filename: (path as NSString).lastPathComponent,
                                            isFolder: false, size: NSNumber(value: bytes.count)), nil)
            } catch {
                completionHandler(nil, nil, error)
            }
        }
        return Progress()
    }

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields,
                    contents url: URL?, options: NSFileProviderCreateItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
        return Progress()
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                    changedFields: NSFileProviderItemFields, contents newContents: URL?,
                    options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
        return Progress()
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        completionHandler(NSFileProviderError(.noSuchItem))
        return Progress()
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                    request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        Enumerator(container: containerItemIdentifier)
    }
}

final class Enumerator: NSObject, NSFileProviderEnumerator {
    let container: NSFileProviderItemIdentifier
    init(container: NSFileProviderItemIdentifier) { self.container = container }
    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver,
                        startingAt page: NSFileProviderPage) {
        Task {
            do {
                observer.didEnumerate(try await items())
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver,
                          from anchor: NSFileProviderSyncAnchor) {
        // No incremental sync yet. Reporting no changes is honest and
        // keeps Finder from spinning; a refresh re-enumerates.
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("1".utf8)))
    }

    private func items() async throws -> [NSFileProviderItem] {
        let raw = container.rawValue
        if container == .rootContainer || raw == NSFileProviderItemIdentifier.rootContainer.rawValue {
            return try await API.projects().map {
                Item(itemIdentifier: NSFileProviderItemIdentifier(ID.project($0.id, $0.ticker!)),
                     parentItemIdentifier: .rootContainer, filename: $0.ticker!, isFolder: true)
            }
        }
        let pid: Int, ticker: String, prefix: String
        if raw.hasPrefix("p:") {
            let p = ID.parts(raw, limit: 2)
            guard let n = Int(p[1]) else { throw NSFileProviderError(.noSuchItem) }
            pid = n; ticker = p[2]; prefix = ""
        } else if raw.hasPrefix("d:") {
            let p = ID.parts(raw, limit: 3)
            guard let n = Int(p[1]), p.count > 3 else { throw NSFileProviderError(.noSuchItem) }
            pid = n; ticker = p[2]; prefix = p[3]
        } else {
            return []
        }

        let rows = try await API.artifacts(pid)
        var out: [NSFileProviderItem] = []
        var seen = Set<String>()
        for row in rows {
            guard prefix.isEmpty || row.title.hasPrefix(prefix + "/") else { continue }
            let tail = prefix.isEmpty ? row.title : String(row.title.dropFirst(prefix.count + 1))
            if let slash = tail.firstIndex(of: "/") {
                // A folder, named once however many files sit under it.
                let dir = String(tail[..<slash])
                let full = prefix.isEmpty ? dir : "\(prefix)/\(dir)"
                if seen.insert(full).inserted {
                    out.append(Item(itemIdentifier: NSFileProviderItemIdentifier(ID.dir(pid, ticker, full)),
                                    parentItemIdentifier: container, filename: dir, isFolder: true))
                }
            } else {
                out.append(Item(itemIdentifier: NSFileProviderItemIdentifier(ID.file(row.id, pid, ticker, row.title)),
                                parentItemIdentifier: container, filename: tail, isFolder: false))
            }
        }
        return out
    }
}
