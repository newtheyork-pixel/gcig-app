import SwiftUI
import WebKit

// WEB — read the story without leaving the terminal.
//
// Every headline in TOP, CN, FLNG and RSCH used to hand the URL to
// NSWorkspace, which throws the reader into Safari and out of the
// workspace they were reading. On a terminal that is a context switch
// for something the terminal already had: the story is the point of the
// news panel, and it lived one application away.
//
// WebKit is a system framework, so this stays inside the no-third-party
// rule. It is deliberately NOT a browser: no tabs, no bookmarks, no
// history beyond back and forward. It is a pane that renders one page,
// retargetable like any other pane, and it keeps the escape hatch —
// some sites want a real browser, and pretending otherwise would just
// strand somebody on a login wall.
struct WebPanel: View {
    /// The page to load, carried on the pane's args the same way a
    /// ticker is carried on its ticker.
    let url: String?

    @State private var address: String = ""
    @State private var current: URL?
    @State private var title: String = ""
    @State private var loading = false
    @State private var failure: String?
    @State private var canGoBack = false
    @State private var canGoForward = false
    @State private var nav = WebNav()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            bar
            Divider().overlay(Term.border)
            if let u = current {
                WebView(url: u, nav: nav,
                        onTitle: { title = $0 },
                        onLoading: { loading = $0 },
                        onFailure: { failure = $0 },
                        onHistory: { back, fwd in canGoBack = back; canGoForward = fwd })
            } else if let f = failure {
                PanelMessage(text: f)
            } else {
                PanelMessage(text: "Type a URL, or open a story from TOP or CN.")
            }
        }
        .onAppear { if current == nil, let u = url { load(u) } }
        .onChange(of: url) { _, u in if let u { load(u) } }
    }

    private var bar: some View {
        HStack(spacing: 6) {
            Button("◀") { nav.goBack?() }
                .buttonStyle(TermButtonStyle()).disabled(!canGoBack)
            Button("▶") { nav.goForward?() }
                .buttonStyle(TermButtonStyle()).disabled(!canGoForward)
            Button(loading ? "×" : "⟳") { loading ? nav.stop?() : nav.reload?() }
                .buttonStyle(TermButtonStyle())
            // Amber because it is editable, the same rule every other
            // typeable field in this app follows.
            TextField("", text: $address,
                      prompt: Text("URL").foregroundStyle(Term.fgMuted))
                .textFieldStyle(.plain)
                .font(Term.mono(10)).foregroundStyle(Term.amber)
                .padding(4).background(Term.bg).termBorder()
                .onSubmit { load(address) }
            if loading {
                ProgressView().controlSize(.small).tint(Term.amber)
            }
            // Some pages genuinely need a browser: SSO, downloads, video
            // that wants a plugin. Sending them on beats stranding them.
            Button("Safari") {
                if let u = current { NSWorkspace.shared.open(u) }
            }
            .buttonStyle(TermButtonStyle()).disabled(current == nil)
            .help("Open this page in the default browser")
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Term.bgHeader)
    }

    /// Accepts what a person types as well as what a panel passes. A bare
    /// host is a URL to everybody except URLComponents.
    private func load(_ raw: String) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let withScheme = t.contains("://") ? t : "https://\(t)"
        guard let u = URL(string: withScheme), u.host != nil else {
            failure = "\(t) is not a web address."
            return
        }
        failure = nil
        address = u.absoluteString
        current = u
    }
}

/// Handles the web view exposes back up to SwiftUI. A box rather than
/// bindings because the closures are made by the coordinator after the
/// view exists.
@MainActor
final class WebNav: ObservableObject {
    var goBack: (() -> Void)?
    var goForward: (() -> Void)?
    var reload: (() -> Void)?
    var stop: (() -> Void)?
}

private struct WebView: NSViewRepresentable {
    let url: URL
    let nav: WebNav
    let onTitle: (String) -> Void
    let onLoading: (Bool) -> Void
    let onFailure: (String) -> Void
    let onHistory: (Bool, Bool) -> Void

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // The default persistent store, so a login to a paper the club
        // subscribes to survives a relaunch. Nothing of ours is ever in
        // here: the session token lives in Application Support and is
        // never handed to a page.
        cfg.websiteDataStore = .default()
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.navigationDelegate = context.coordinator
        v.setValue(false, forKey: "drawsBackground")
        v.allowsBackForwardNavigationGestures = true
        context.coordinator.attach(v, nav: nav)
        v.load(URLRequest(url: url))
        context.coordinator.loaded = url
        return v
    }

    func updateNSView(_ v: WKWebView, context: Context) {
        context.coordinator.callbacks = (onTitle, onLoading, onFailure, onHistory)
        if context.coordinator.loaded != url {
            context.coordinator.loaded = url
            v.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator((onTitle, onLoading, onFailure, onHistory))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        typealias Callbacks = ((String) -> Void, (Bool) -> Void, (String) -> Void, (Bool, Bool) -> Void)
        var callbacks: Callbacks
        var loaded: URL?
        init(_ c: Callbacks) { callbacks = c }

        @MainActor
        func attach(_ v: WKWebView, nav: WebNav) {
            nav.goBack = { [weak v] in v?.goBack() }
            nav.goForward = { [weak v] in v?.goForward() }
            nav.reload = { [weak v] in v?.reload() }
            nav.stop = { [weak v] in v?.stopLoading() }
        }

        func webView(_ w: WKWebView, didStartProvisionalNavigation: WKNavigation!) {
            callbacks.1(true)
        }

        func webView(_ w: WKWebView, didFinish: WKNavigation!) {
            callbacks.1(false)
            callbacks.0(w.title ?? "")
            callbacks.3(w.canGoBack, w.canGoForward)
        }

        // Both failure callbacks, not just one. didFail covers a load
        // that broke after it started; didFailProvisional covers the far
        // commoner case of never connecting at all, and leaving it out is
        // how a dead link renders as a blank pane that looks like it is
        // still working.
        func webView(_ w: WKWebView, didFail: WKNavigation!, withError error: Error) {
            callbacks.1(false)
            callbacks.2(error.localizedDescription)
        }

        func webView(_ w: WKWebView, didFailProvisionalNavigation: WKNavigation!, withError error: Error) {
            callbacks.1(false)
            // A cancel is what happens when a redirect supersedes a load
            // in flight. It is not a failure and must not paint like one.
            if (error as NSError).code == NSURLErrorCancelled { return }
            callbacks.2(error.localizedDescription)
        }
    }
}
