import SwiftUI
import UserNotifications

/// Bureau for iPhone.
///
/// The interface is the same one the Mac serves to a browser, shown in a web view. What this
/// app adds is what a web page cannot do: Face ID before a signature, notifications that carry
/// a Sign button, and haptics.
@main
struct BureauApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(Color("AccentColor"))
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // "Sign" asks the phone to unlock first, so a signature from the lock screen still needs Face ID.
        let sign = UNNotificationAction(identifier: "SIGN", title: "Sign", options: [.authenticationRequired])
        let open = UNNotificationAction(identifier: "OPEN", title: "Read it first", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "SLIP_SIGNABLE", actions: [sign, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "SLIP", actions: [open], intentIdentifiers: []),
        ])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in AppModel.shared.deviceToken = token }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Expected on the simulator and before push is set up for the app; the web interface still works.
    }

    /// Show notifications even while the app is open; the slip also appears on the Desk.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let slipId = info["slipId"] as? String
        let path = info["url"] as? String

        if response.actionIdentifier == "SIGN", let slipId {
            let ok = await Office.sign(slipId: slipId)
            if !ok {
                // The signature did not go through (no connection, or the slip changed). Bring it up to be read.
                await MainActor.run { AppModel.shared.pendingPath = path ?? "/" }
                await Office.notifyLocally(title: "Not signed", body: "Open Bureau to sign this one.")
            }
            return
        }
        await MainActor.run { AppModel.shared.pendingPath = path ?? "/" }
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @AppStorage("serverURL") var serverURL: String = ""
    @AppStorage("faceIDToSign") var faceIDToSign: Bool = true
    /// A path inside the app to show next, set when a notification is opened.
    @Published var pendingPath: String?
    @Published var deviceToken: String?

    var server: URL? {
        guard !serverURL.isEmpty else { return nil }
        return URL(string: serverURL)
    }
}
