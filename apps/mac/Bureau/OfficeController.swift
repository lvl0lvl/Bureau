import AppKit
@preconcurrency import WebKit

/// Owns the web view that shows the office, and the small bridge the page talks to.
/// The view lives as long as the app does, so reopening the window is instant.
@MainActor
final class OfficeController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let webView: WKWebView
    private let model: AppModel
    private var server: URL?
    private var retry: Timer?
    private var loaded = false
    /// A path to show as soon as the office has loaded (a notification arrived while it was closed).
    private var pendingPath: String?

    init(model: AppModel) {
        self.model = model
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "bureau")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    /// What the page sees. `window.bureauNative` is how the interface knows it is inside the app.
    static let bridgeScript = """
    (function () {
      var waiting = {};
      var n = 0;
      function post(m) { window.webkit.messageHandlers.bureau.postMessage(m); }
      window.bureauNative = {
        platform: 'macos',
        confirm: function (reason) {
          return new Promise(function (resolve) {
            var id = String(++n);
            waiting[id] = resolve;
            post({ type: 'confirm', id: id, reason: String(reason || '') });
          });
        },
        haptic: function (kind) { post({ type: 'haptic', kind: String(kind || 'light') }); },
        ready: function () { post({ type: 'ready' }); },
        _resolve: function (id, ok) {
          var f = waiting[id];
          delete waiting[id];
          if (f) f(!!ok);
        }
      };
    })();
    """

    func load(_ url: URL) {
        server = url
        loaded = false
        model.unreachable = false
        retry?.invalidate()
        webView.load(URLRequest(url: url))
    }

    func reload() {
        guard let server else { return }
        if loaded { webView.reload() } else { load(server) }
    }

    /// Show a path inside the office, such as "/staff" or "/?slip=<id>".
    func open(path: String) {
        guard loaded else { pendingPath = path; return }
        let js = "history.pushState(null, '', \(Self.quote(path))); window.dispatchEvent(new PopStateEvent('popstate'));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func quote(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    // MARK: Bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "confirm":
            let id = body["id"] as? String ?? ""
            let reason = Office.phrase(body["reason"] as? String ?? "")
            Task { @MainActor in
                debugLog("the page asks to \(reason); confirmation required: \(self.model.confirmBeforeSigning)")
                let ok = self.model.confirmBeforeSigning ? await Office.confirm(reason: reason) : true
                // The completion-handler form on purpose: the async form traps when the script returns nothing.
                self.webView.evaluateJavaScript("window.bureauNative._resolve(\(Self.quote(id)), \(ok))", completionHandler: nil)
            }
        case "haptic":
            NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .now)
        default:
            break
        }
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // Stay inside the office. Anything else opens in the browser.
        if url.host == server?.host || url.scheme == "about" || url.scheme == "blob" { return decisionHandler(.allow) }
        if action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        model.unreachable = false
        retry?.invalidate()
        if let path = pendingPath {
            pendingPath = nil
            open(path: path)
        }
        #if DEBUG
        runDebugHooks()
        #endif
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }

    private func failed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        loaded = false
        model.unreachable = true
        // The office may simply be starting. Keep trying quietly.
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.model.unreachable, let server = self.server else { return }
                self.webView.load(URLRequest(url: server))
            }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    /// Dictation: the office itself may use the microphone; nothing else may.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == server?.host && type == .microphone ? .grant : .deny)
    }

    /// Anything that asks for a new window (a file from the Library, an outside link) opens in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: Debug

    #if DEBUG
    /// For checking the app from the command line, where nothing can click:
    ///   -debugJS <base64 script>     runs once the office has loaded
    ///   -debugSnapshot <path.png>    writes a picture of the window's contents a few seconds later
    private var ranDebugHooks = false
    private func runDebugHooks() {
        guard !ranDebugHooks else { return }
        ranDebugHooks = true
        let defaults = UserDefaults.standard
        if let encoded = defaults.string(forKey: "debugJS"), let data = Data(base64Encoded: encoded), let js = String(data: data, encoding: .utf8) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.webView.evaluateJavaScript(js, completionHandler: nil) }
        }
        if let path = defaults.string(forKey: "debugSnapshot") {
            let wait = defaults.double(forKey: "debugSnapshotAfter")
            DispatchQueue.main.asyncAfter(deadline: .now() + (wait > 0 ? wait : 4)) { [weak self] in
                self?.webView.takeSnapshot(with: nil) { image, _ in
                    guard let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                    try? png.write(to: URL(fileURLWithPath: path))
                    debugLog("snapshot written")
                }
            }
        }
    }
    #endif
}
