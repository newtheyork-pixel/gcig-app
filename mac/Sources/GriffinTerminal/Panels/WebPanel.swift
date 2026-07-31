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
    /// Reader by default. The point of opening a story in the terminal is
    /// to read it in the terminal, not to run a browser inside a pane
    /// with its own navigation, adverts and consent banners.
    @State private var showPage = false
    @State private var article: Article?
    @State private var extractNote: String?

    struct Article: Decodable {
        let title: String?
        let byline: String?
        let published: String?
        let text: String?
        let words: Int?
    }

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
                ZStack(alignment: .topLeading) {
                    // The web view stays in the hierarchy whatever mode we
                    // are in: it holds the signed-in session and it is
                    // what the extractor reads. Hiding it by not building
                    // it would mean re-loading, and re-loading a paywalled
                    // page is how you lose the session you just used.
                    WebView(url: u, nav: nav,
                            onTitle: { title = $0 },
                            onLoading: { loading = $0 },
                            onFailure: { failure = $0 },
                            onHistory: { back, fwd in canGoBack = back; canGoForward = fwd },
                            onPageDone: { host in
                                autoSignIn(on: host)
                                Task { await pullArticle() }
                            })
                        .opacity(showPage ? 1 : 0)
                    if !showPage { reader }
                }
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
            // The page is still there and one click away, because login
            // forms, consent banners and anything with a CAPTCHA need the
            // real thing.
            Button(showPage ? "Read" : "Page") { showPage.toggle() }
                .buttonStyle(TermButtonStyle())
                .help(showPage ? "Back to the article text" : "Show the page as the site renders it")
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

    /// The story, in the terminal's own type. Measure capped near 90
    /// characters because a full-width column of mono is unreadable, and
    /// the whole point of this mode is that it reads better than the page.
    @ViewBuilder
    private var reader: some View {
        if let a = article, let body = a.text, !body.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text(a.title ?? title)
                        .font(Term.mono(15, weight: .bold)).foregroundStyle(Term.white)
                        .textSelection(.enabled)
                    Text([a.byline, a.published, a.words.map { "\($0) words" }]
                            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(Term.mono(9)).foregroundStyle(Term.fgMuted)
                    Divider().overlay(Term.border)
                    Text(body)
                        .font(Term.mono(12)).foregroundStyle(Term.fgDim)
                        .lineSpacing(6).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Term.bgPanel)
        } else {
            // Never a blank pane. Extraction failing and a page still
            // loading are different states and a reader can act on the
            // difference.
            VStack(alignment: .leading, spacing: 8) {
                Text(loading ? "Loading…" : (extractNote ?? "Nothing to read here yet."))
                    .font(Term.mono(11)).foregroundStyle(Term.fgMuted)
                if !loading {
                    Button("Show the page instead") { showPage = true }
                        .buttonStyle(TermButtonStyle())
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Term.bgPanel)
        }
    }

    private func pullArticle() async {
        guard let raw = await nav.extract?() else { return }
        guard let data = raw.data(using: .utf8),
              let a = try? JSONDecoder().decode(Article.self, from: data) else {
            extractNote = "Could not read this page as an article."
            return
        }
        // A paywall stub and a real story both return text. The word count
        // is what separates them, and saying which one this is beats
        // rendering four sentences as though they were the article.
        if (a.words ?? 0) < 120 {
            article = nil
            extractNote = (a.words ?? 0) == 0
                ? "No article text on this page."
                : "Only \(a.words ?? 0) words came back — this is probably a paywall stub or an index page."
            return
        }
        extractNote = nil
        article = a
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
    /// Pulls the article out of the rendered page as JSON.
    var extract: (() async -> String?)?
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
            nav.extract = { [weak v] in
                guard let v else { return nil }
                return await Self.extractArticle(in: v)
            }
        }

        /// Pull the story out of the rendered page.
        ///
        /// Runs against the DOM the browser actually built, which is the
        /// only version that exists for a site rendering its body in
        /// JavaScript, and the only one that includes what a subscription
        /// unlocked. A server-side fetch would get the logged-out page.
        ///
        /// Scoring rather than a selector list: every publication marks
        /// its article container differently and a list of them is a list
        /// that rots. The container holding the most paragraph text is the
        /// article on essentially every news page, and it needs no
        /// per-site maintenance.
        @MainActor
        static func extractArticle(in v: WKWebView) async -> String? {
            let js = """
            (function () {
              function clean(root) {
                var junk = root.querySelectorAll(
                  'script,style,noscript,nav,aside,header,footer,form,iframe,svg,figure,figcaption,' +
                  '[aria-hidden=true],[role=navigation],[role=complementary],[role=banner],' +
                  '[class*=newsletter i],[class*=promo i],[class*=advert i],[class*=related i],' +
                  '[class*=share i],[class*=subscribe i],[id*=comment i]');
                for (var i = 0; i < junk.length; i++) { junk[i].remove(); }
                return root;
              }
              function textOf(el) {
                var ps = el.querySelectorAll('p, h2, h3, li, blockquote');
                var out = [];
                for (var i = 0; i < ps.length; i++) {
                  var t = (ps[i].innerText || '').replace(/\\s+/g, ' ').trim();
                  // Short fragments are captions, bylines and nav crumbs.
                  if (t.length > 40 || (ps[i].tagName === 'H2' || ps[i].tagName === 'H3') && t.length > 8) {
                    out.push(ps[i].tagName === 'H2' || ps[i].tagName === 'H3' ? '\\n' + t + '\\n' : t);
                  }
                }
                return out.join('\\n\\n');
              }
              var doc = document.cloneNode(true);
              clean(doc);
              var best = null, bestLen = 0;
              var cands = doc.querySelectorAll('article, main, [role=main], [class*=article i], [class*=story i], [class*=body i], [itemprop=articleBody]');
              for (var i = 0; i < cands.length; i++) {
                var t = textOf(cands[i]);
                if (t.length > bestLen) { bestLen = t.length; best = cands[i]; }
              }
              if (!best || bestLen < 400) {
                var b = textOf(doc.body || doc);
                if (b.length > bestLen) { bestLen = b.length; best = doc.body; }
              }
              var text = best ? textOf(best) : '';
              function meta(names) {
                for (var i = 0; i < names.length; i++) {
                  var el = document.querySelector(names[i]);
                  if (el) { var c = el.getAttribute('content') || el.innerText; if (c && c.trim()) return c.trim(); }
                }
                return null;
              }
              var title = meta(['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1']) || document.title || '';
              var byline = meta(['meta[name="author"]', 'meta[property="article:author"]',
                                 '[rel=author]', '[class*=byline i]', '[itemprop=author]']);
              var published = meta(['meta[property="article:published_time"]', 'meta[name="date"]', 'time']);
              var words = text ? text.split(/\\s+/).filter(Boolean).length : 0;
              return JSON.stringify({ title: title, byline: byline, published: published, text: text, words: words });
            })();
            """
            do {
                let r = try await v.evaluateJavaScript(js)
                return r as? String
            } catch {
                return nil
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
