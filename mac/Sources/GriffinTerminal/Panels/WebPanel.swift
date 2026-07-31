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
    @State private var subs: [Sub] = []
    @State private var signInState: String?
    @State private var attempts = 0

    /// A subscription we hold a login for, with the host that login
    /// belongs to. The host is the safety control, not a convenience:
    /// credentials are injected only into a page served by the same host
    /// the subscription names, so a redirect to anywhere else — an
    /// interstitial, an ad network, a phishing page that happened to
    /// catch the navigation — gets nothing.
    struct Sub: Decodable {
        let key: String
        let label: String
        let loginUrl: String?
        let hasCredentials: Bool?
        var host: String? { loginUrl.flatMap { URL(string: $0)?.host?.lowercased() } }
    }

    struct Credential: Decodable { let username: String; let password: String }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            bar
            Divider().overlay(Term.border)
            if let u = current {
                WebView(url: u, nav: nav,
                        onTitle: { title = $0 },
                        onLoading: { loading = $0 },
                        onFailure: { failure = $0 },
                        onHistory: { back, fwd in canGoBack = back; canGoForward = fwd },
                        onPageDone: { host in autoSignIn(on: host) })
            } else if let f = failure {
                PanelMessage(text: f)
            } else {
                PanelMessage(text: "Type a URL, or open a story from TOP or CN.")
            }
        }
        .onAppear { if current == nil, let u = url { load(u) } }
        .onChange(of: url) { _, u in if let u { load(u) } }
        .task { await loadSubs() }
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
            if let s = signInState {
                Text(s).font(Term.mono(9)).foregroundStyle(Term.fgMuted).lineLimit(1)
            }
            if let m = matchingSub, m.hasCredentials == true {
                Button("Sign in as club") { attempts = 0; signIn(m) }
                    .buttonStyle(TermButtonStyle())
                    .help("Fill the club's \(m.label) login on this page")
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

    /// The subscription whose host matches what is on screen. Nil when
    /// the page belongs to nobody we hold a login for, which is most of
    /// the web and is why the button is usually absent.
    private var matchingSub: Sub? {
        guard let h = current?.host?.lowercased() else { return nil }
        return subs.first { s in
            guard let sh = s.host else { return false }
            return h == sh || h.hasSuffix("." + sh) || sh.hasSuffix("." + h)
        }
    }

    private func loadSubs() async {
        struct Wrap: Decodable { let items: [Sub]? }
        guard let data = try? await API.shared.get("/subscriptions"),
              let w = try? await API.shared.decode(Wrap.self, from: data) else { return }
        subs = (w.items ?? []).filter { $0.hasCredentials == true }
    }

    /// Fires when a page finishes loading on a host we have a login for.
    ///
    /// Bounded to three tries per pane because real sign-in flows are
    /// multi-step — WSJ asks for the address, then the password on a
    /// second page — and an unbounded loop on a page that simply has no
    /// form would hammer the site forever. Three covers a two-step form
    /// with one retry and stops.
    private func autoSignIn(on host: String) {
        guard attempts < 3,
              let m = matchingSub, m.hasCredentials == true,
              let h = m.host,
              host == h || host.hasSuffix("." + h) || h.hasSuffix("." + host)
        else { return }
        signIn(m)
    }

    private func signIn(_ sub: Sub) {
        attempts += 1
        signInState = "Signing in as the club…"
        Task {
            guard let data = try? await API.shared.get("/subscriptions/\(sub.key)/credentials"),
                  let c = try? await API.shared.decode(Credential.self, from: data) else {
                signInState = "Could not fetch the \(sub.label) login."
                return
            }
            // Re-checked at the moment of injection, not just when the
            // button was drawn. A page can navigate between the two.
            guard let h = current?.host?.lowercased(), let sh = sub.host,
                  h == sh || h.hasSuffix("." + sh) || sh.hasSuffix("." + h) else {
                signInState = "Page changed host — nothing was filled."
                return
            }
            let result = await nav.fill?(c.username, c.password) ?? "no view"
            signInState = result.hasPrefix("submitted") || result.hasPrefix("formsubmit")
                ? "Signed in as the club."
                : result == "nofields"
                ? "No login form on this page."
                : "Sign-in: \(result)"
        }
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
    /// Fills the login form on the page and submits it. Returns what it
    /// did so the caller can say so rather than claiming success.
    var fill: ((String, String) async -> String)?
}

private struct WebView: NSViewRepresentable {
    let url: URL
    let nav: WebNav
    let onTitle: (String) -> Void
    let onLoading: (Bool) -> Void
    let onFailure: (String) -> Void
    let onHistory: (Bool, Bool) -> Void
    let onPageDone: (String) -> Void

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
        Coordinator((onTitle, onLoading, onFailure, onHistory), onPageDone)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        typealias Callbacks = ((String) -> Void, (Bool) -> Void, (String) -> Void, (Bool, Bool) -> Void)
        var callbacks: Callbacks
        var pageDone: (String) -> Void
        var loaded: URL?
        init(_ c: Callbacks, _ done: @escaping (String) -> Void) { callbacks = c; pageDone = done }

        @MainActor
        func attach(_ v: WKWebView, nav: WebNav) {
            nav.goBack = { [weak v] in v?.goBack() }
            nav.goForward = { [weak v] in v?.goForward() }
            nav.reload = { [weak v] in v?.reload() }
            nav.stop = { [weak v] in v?.stopLoading() }
            nav.fill = { [weak v] user, pass in
                guard let v else { return "no view" }
                return await Self.fillLogin(in: v, user: user, pass: pass)
            }
        }

        /// Fill the login form and submit it.
        ///
        /// The value setter goes through the native property descriptor
        /// rather than assigning el.value, because every modern login page
        /// is a controlled React input: a plain assignment updates the DOM
        /// and the framework overwrites it on the next render, so the form
        /// submits empty. Setting through the prototype and dispatching
        /// input and change is what makes the framework believe a person
        /// typed it.
        ///
        /// Multi-step flows are handled by filling whatever is present and
        /// submitting; the next page load triggers the next round, bounded
        /// by the caller.
        @MainActor
        static func fillLogin(in v: WKWebView, user: String, pass: String) async -> String {
            let u = jsString(user), p = jsString(pass)
            let js = """
            (function () {
              function set(el, value) {
                var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                if (d && d.set) { d.set.call(el, value); } else { el.value = value; }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
              function visible(el) {
                if (!el) return false;
                var r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }
              var pw = Array.prototype.find.call(document.querySelectorAll('input[type=password]'), visible);
              var user = Array.prototype.find.call(
                document.querySelectorAll("input[type=email], input[autocomplete=username], input[name*=user i], input[id*=user i], input[name*=email i], input[id*=email i]"),
                visible);
              var did = [];
              if (user && !user.value) { set(user, \(u)); did.push('user'); }
              if (pw) { set(pw, \(p)); did.push('pass'); }
              if (!did.length) return 'nofields';
              var anchor = pw || user;
              var form = anchor.closest('form');
              var btn = (form && form.querySelector('button[type=submit], input[type=submit]'))
                     || document.querySelector('button[type=submit], input[type=submit]');
              if (btn) { btn.click(); return 'submitted:' + did.join(','); }
              if (form) { form.submit(); return 'formsubmit:' + did.join(','); }
              return 'filled:' + did.join(',');
            })();
            """
            do {
                let r = try await v.evaluateJavaScript(js)
                return (r as? String) ?? "done"
            } catch {
                return "blocked: \(error.localizedDescription)"
            }
        }

        /// JSON-encode so a password containing a quote, a backslash or a
        /// newline cannot break out of the literal and become code. The
        /// whole injection is only as safe as this one function.
        static func jsString(_ s: String) -> String {
            let data = try? JSONSerialization.data(withJSONObject: [s], options: [])
            guard let data, let arr = String(data: data, encoding: .utf8) else { return "\"\"" }
            return String(arr.dropFirst().dropLast())
        }

        func webView(_ w: WKWebView, didStartProvisionalNavigation: WKNavigation!) {
            callbacks.1(true)
        }

        func webView(_ w: WKWebView, didFinish: WKNavigation!) {
            callbacks.1(false)
            callbacks.0(w.title ?? "")
            callbacks.3(w.canGoBack, w.canGoForward)
            if let h = w.url?.host?.lowercased() { pageDone(h) }
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
