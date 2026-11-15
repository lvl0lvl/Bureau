import Combine
import Foundation
import LocalAuthentication
import UserNotifications

/// A slip that is waiting for the owner, as the menu bar and notifications need it.
struct PendingSlip: Identifiable, Equatable {
    let id: String
    let title: String
    let staffName: String
    let kind: String
    /// A plain action that traces back to nothing read from outside may be signed from a notification.
    let signable: Bool
    let createdAt: Double
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    private let defaults = UserDefaults.standard

    /// Where the office is. Empty until the first run finds it or the owner types it.
    @Published var serverURL: String { didSet { defaults.set(serverURL, forKey: "serverURL") } }
    /// Ask for Touch ID (or the password) before a signature.
    @Published var confirmBeforeSigning: Bool { didSet { defaults.set(confirmBeforeSigning, forKey: "confirmBeforeSigning") } }
    @Published var pending: [PendingSlip] = []
    /// The office did not answer the last time the window tried to load it.
    @Published var unreachable = false
    /// The first-run check for an office on this Mac is still going.
    @Published var looking = false
    /// Whether macOS lets this app show notifications. Nil until asked.
    @Published var notifications: UNAuthorizationStatus?

    func refreshNotifications() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in self.notifications = status }
        }
    }

    func askForNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            debugLog("notifications allowed: \(granted)\(error.map { " (\($0.localizedDescription))" } ?? "")")
            Task { @MainActor in self.refreshNotifications() }
        }
    }

    var server: URL? { serverURL.isEmpty ? nil : URL(string: serverURL) }

    private init() {
        serverURL = defaults.string(forKey: "serverURL") ?? ""
        if defaults.object(forKey: "confirmBeforeSigning") != nil {
            confirmBeforeSigning = defaults.bool(forKey: "confirmBeforeSigning")
        } else {
            // On by default only where it is a touch, not a typed password.
            confirmBeforeSigning = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        }
    }
}

func debugLog(_ text: @autoclosure () -> String) {
    #if DEBUG
    if UserDefaults.standard.bool(forKey: "debugLog") { FileHandle.standardError.write(Data("[bureau] \(text())\n".utf8)) }
    #endif
}
