import Foundation
import LocalAuthentication
import UserNotifications
import WebKit

/// Talking to the Mac outside the web view: checking an address, signing from a notification.
enum Office {
    struct Session: Decodable {
        let paired: Bool
        let ownerName: String
        let hostName: String
        let protocolVersion: Int

        enum CodingKeys: String, CodingKey {
            case paired, ownerName, hostName
            case protocolVersion = "protocol"
        }
    }

    /// Normalise what someone typed into an address the app can use.
    static func normalise(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            // Plain http only makes sense for a Mac on the same desk; everything else is https.
            let local = s.hasPrefix("localhost") || s.hasPrefix("127.0.0.1")
            s = (local ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil else { return nil }
        return url
    }

    /// Is there a Bureau at this address?
    static func probe(_ url: URL) async -> Result<Session, ProbeError> {
        var request = URLRequest(url: url.appendingPathComponent("api/session"))
        request.timeoutInterval = 8
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let session = try? JSONDecoder().decode(Session.self, from: data)
            else { return .failure(.notBureau) }
            return .success(session)
        } catch {
            return .failure(.unreachable)
        }
    }

    enum ProbeError: Error {
        case unreachable, notBureau

        var message: String {
            switch self {
            case .unreachable: return "That address did not answer. Check that Tailscale is on for this phone and that Bureau is running on the Mac."
            case .notBureau: return "Something answered at that address, but it is not Bureau."
            }
        }
    }

    /// Copy the web view's session cookie to where background requests can use it.
    @MainActor
    static func syncCookies() async {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        for cookie in cookies where cookie.name == "bureau_session" {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }

    /// Sign a slip from a notification. Returns whether the Mac accepted it.
    static func sign(slipId: String) async -> Bool {
        guard let base = await MainActor.run(body: { AppModel.shared.server }) else { return false }
        var request = URLRequest(url: base.appendingPathComponent("api/slips/\(slipId)/sign"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 15
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    /// Ask for Face ID (or the passcode) before something is signed.
    static func confirmWithFaceID(reason: String) async -> Bool {
        let context = LAContext()
        context.localizedFallbackTitle = "Use passcode"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // No passcode on this phone at all: there is nothing to check against.
            return true
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }

    static func notifyLocally(title: String, body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
