import SwiftUI
import UIKit
import UserNotifications
@preconcurrency import WebKit

/// The office itself: the interface the Mac serves, with a small bridge to the phone.
struct OfficeWebView: UIViewRepresentable {
    let server: URL
    @Binding var failed: Bool
    @EnvironmentObject private var model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(context.coordinator, name: "bureau")
        config.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .white
        view.scrollView.backgroundColor = .white
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsLinkPreview = false
        view.allowsBackForwardNavigationGestures = true
        #if DEBUG
        view.isInspectable = true
        #endif
        context.coordinator.webView = view
        view.load(URLRequest(url: server))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        if let path = model.pendingPath {
            DispatchQueue.main.async { model.pendingPath = nil }
            context.coordinator.open(path: path)
        }
        if let token = model.deviceToken, token != context.coordinator.sentToken {
            context.coordinator.register(token: token)
        }
    }

    /// What the page sees. `window.bureauNative` is how the web interface knows it is inside the app.
    static let bridgeScript = """
    (function () {
      var waiting = {};
      var n = 0;
      window.bureauNative = {
        platform: 'ios',
        confirm: function (reason) {
          return new Promise(function (resolve) {
            var id = String(++n);
            waiting[id] = resolve;
            window.webkit.messageHandlers.bureau.postMessage({ type: 'confirm', id: id, reason: String(reason || '') });
          });
        },
        haptic: function (kind) {
          window.webkit.messageHandlers.bureau.postMessage({ type: 'haptic', kind: String(kind || 'light') });
        },
        ready: function () {
          window.webkit.messageHandlers.bureau.postMessage({ type: 'ready' });
        },
        _resolve: function (id, ok) {
          var f = waiting[id];
          delete waiting[id];
          if (f) f(!!ok);
        }
      };
    })();
    """

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: OfficeWebView
        weak var webView: WKWebView?
        var sentToken: String?
        private var askedForNotifications = false

        init(_ parent: OfficeWebView) { self.parent = parent }

        func open(path: String) {
            guard let webView, let url = URL(string: path, relativeTo: parent.server) else { return }
            // Let the page route it if it is already loaded; otherwise load it.
            let js = "if (window.history && window.dispatchEvent) { history.pushState(null, '', \(Self.quote(path))); window.dispatchEvent(new PopStateEvent('popstate')); } else { location.href = \(Self.quote(url.absoluteString)); }"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func register(token: String) {
            guard let webView else { return }
            #if DEBUG
            let sandbox = "true"
            #else
            let sandbox = "false"
            #endif
            let js = "fetch('/api/push/apns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: \(Self.quote(token)), sandbox: \(sandbox) }) }).then(function (r) { return r.ok; }).catch(function () { return false; })"
            webView.evaluateJavaScript(js) { [weak self] result, _ in
                if (result as? Bool) == true { self?.sentToken = token }
            }
        }

        private static func quote(_ s: String) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
            let array = String(decoding: data, as: UTF8.self)
            return String(array.dropFirst().dropLast())
        }

        // MARK: Bridge

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "confirm":
                let id = body["id"] as? String ?? ""
                let reason = (body["reason"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Sign this slip"
                Task { @MainActor in
                    let ok = AppModel.shared.faceIDToSign ? await Office.confirmWithFaceID(reason: reason) : true
                    if ok { UINotificationFeedbackGenerator().notificationOccurred(.success) }
                    // The completion-handler form on purpose: the async form traps when the script returns nothing.
                    self.webView?.evaluateJavaScript("window.bureauNative._resolve(\(Self.quote(id)), \(ok))", completionHandler: nil)
                }
            case "haptic":
                let kind = body["kind"] as? String ?? "light"
                if kind == "success" { UINotificationFeedbackGenerator().notificationOccurred(.success) }
                else if kind == "warning" { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
                else { UIImpactFeedbackGenerator(style: kind == "medium" ? .medium : .light).impactOccurred() }
            case "ready":
                askForNotificationsOnce()
            default:
                break
            }
        }

        /// Once the office is showing, ask whether it may send notifications.
        private func askForNotificationsOnce() {
            guard !askedForNotifications else { return }
            askedForNotifications = true
            #if DEBUG
            // Command-line walks in the simulator cannot answer the system prompt: `-skipNotificationPrompt YES`.
            if UserDefaults.standard.bool(forKey: "skipNotificationPrompt") { return }
            #endif
            Task {
                let center = UNUserNotificationCenter.current()
                let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                if granted { await MainActor.run { UIApplication.shared.registerForRemoteNotifications() } }
            }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            // Stay inside the office. Anything else opens in Safari.
            if url.host == parent.server.host || url.scheme == "about" || url.scheme == "blob" { return .allow }
            if action.navigationType == .linkActivated { await UIApplication.shared.open(url) }
            return .cancel
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.failed = false
            Task { @MainActor in
                await Office.syncCookies()
                self.askForNotificationsOnce()
                if let token = AppModel.shared.deviceToken, token != self.sentToken { self.register(token: token) }
            }
            #if DEBUG
            runDebugScript()
            #endif
        }

        #if DEBUG
        /// For walking the app from the command line in the simulator, where nothing can tap:
        /// `xcrun simctl launch booted dev.bureau.app -debugJS "$(printf %s '<script>' | base64)"` runs the
        /// script once the office has loaded. Base64 because launch arguments are read as property lists.
        private var ranDebugScript = false
        private func runDebugScript() {
            guard !ranDebugScript, let encoded = UserDefaults.standard.string(forKey: "debugJS"),
                  let data = Data(base64Encoded: encoded), let js = String(data: data, encoding: .utf8), !js.isEmpty else { return }
            ranDebugScript = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }
        #endif

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { parent.failed = true }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { parent.failed = true }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        /// Dictation: the office itself may use the microphone; nothing else may.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == parent.server.host && type == .microphone ? .grant : .deny)
        }

        /// Links that ask for a new window (a file from the Library) open in Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if url.host == parent.server.host { webView.load(action.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }
    }
}
