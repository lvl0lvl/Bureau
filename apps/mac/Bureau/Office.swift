import Foundation
import LocalAuthentication
import UserNotifications
import WebKit

/// Talking to the office outside the web view: finding it, signing from a notification.
enum Office {
    static let localDefault = URL(string: "http://localhost:8787")!

    /// Is the office on this Mac, or reached over the network?
    static func isThisMac(_ url: URL?) -> Bool {
        guard let host = url?.host else { return true }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    /// Normalise what someone typed into an address the app can use.
    static func normalise(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            let local = s.hasPrefix("localhost") || s.hasPrefix("127.0.0.1")
            s = (local ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil else { return nil }
        return url
    }

    /// Is there a Bureau at this address?
    static func answers(_ url: URL) async -> Bool {
        var request = URLRequest(url: url.appendingPathComponent("api/session"))
        request.timeoutInterval = 6
        // Only a look: this must not pair a second device, so no cookies either way.
        request.httpShouldHandleCookies = false
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return json["protocol"] != nil && json["paired"] != nil
    }

    /// Copy the web view's session cookie to where requests made outside it can use it.
    @MainActor
    static func syncCookies() async {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        for cookie in cookies where cookie.name == "bureau_session" {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }

    static func cookieHeader(for url: URL) -> String? {
        guard let cookies = HTTPCookieStorage.shared.cookies(for: url), !cookies.isEmpty else { return nil }
        return HTTPCookie.requestHeaderFields(with: cookies)["Cookie"]
    }

    /// Sign a slip. Returns whether the office accepted it.
    static func sign(slipId: String, server: URL) async -> Bool {
        var request = URLRequest(url: server.appendingPathComponent("api/slips/\(slipId)/sign"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 15
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    /// Can this Mac ask who is at the keyboard at all? False only when the account has no password.
    static var canConfirm: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    /// Touch ID, Apple Watch or the account password. macOS shows "Bureau is trying to <reason>."
    /// If the Mac cannot ask, the answer is no: the owner asked for a check, so nothing is signed
    /// without one. The setting can be switched off in Bureau's settings.
    static func confirm(reason: String) async -> Bool {
        let context = LAContext()
        var unavailable: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else {
            debugLog("cannot ask for authentication: \(unavailable?.localizedDescription ?? "unknown")")
            return false
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            debugLog("authentication answered: \(ok)")
            return ok
        } catch {
            debugLog("authentication refused: \(error.localizedDescription)")
            return false
        }
    }

    /// The page says "Sign: <title>"; macOS wants the rest of a sentence.
    static func phrase(_ reason: String) -> String {
        let title = reason.hasPrefix("Sign: ") ? String(reason.dropFirst(6)) : reason
        return title.isEmpty ? "sign a slip" : "sign \u{201C}\(title)\u{201D}"
    }

    static func notify(title: String, body: String, slip: PendingSlip? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let slip {
            content.categoryIdentifier = slip.signable ? "SLIP_SIGNABLE" : "SLIP"
            content.userInfo = ["slipId": slip.id, "title": slip.title]
            content.threadIdentifier = "bureau"
        }
        let request = UNNotificationRequest(identifier: slip?.id ?? UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { debugLog("notification not delivered: \(error.localizedDescription)") }
        }
    }
}
