import AppKit
import Combine
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private let model = AppModel.shared
    private lazy var office = OfficeController(model: model)
    private lazy var watcher = Watcher(model: model)
    private var window: NSWindow!
    private var settingsWindow: NSWindow?
    private var statusItem: NSStatusItem!
    private var watching: Set<AnyCancellable> = []

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        buildWindow()
        buildStatusItem()
        setUpNotifications()

        watcher.onNewSlip = { [weak self] slip in self?.announce(slip) }
        model.$pending
            .receive(on: RunLoop.main)
            .sink { [weak self] waiting in self?.showCount(waiting.count) }
            .store(in: &watching)
        // Whenever the address changes (first run, or the owner picks another), go there.
        model.$serverURL
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.follow() }
            .store(in: &watching)

        if model.server == nil { lookOnThisMac() }
        showWindow()
    }

    func applicationDidBecomeActive(_ notification: Notification) { model.refreshNotifications() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    /// First run: if the office is on this Mac, there is nothing to ask.
    private func lookOnThisMac() {
        model.looking = true
        Task { @MainActor in
            let found = await Office.answers(Office.localDefault)
            self.model.looking = false
            if found && self.model.server == nil { self.model.serverURL = Office.localDefault.absoluteString }
        }
    }

    private func follow() {
        guard let server = model.server else {
            watcher.stop()
            return
        }
        office.load(Self.firstPage(server))
        watcher.start(server)
    }

    /// The installer run on another Mac leaves a one-time pairing code; the page uses it at once.
    private static func firstPage(_ server: URL) -> URL {
        let defaults = UserDefaults.standard
        guard let code = defaults.string(forKey: "pairCode"), !code.isEmpty else { return server }
        let label = defaults.string(forKey: "pairLabel") ?? ""
        defaults.removeObject(forKey: "pairCode")
        defaults.removeObject(forKey: "pairLabel")
        var parts = URLComponents(url: server.appendingPathComponent("pair"), resolvingAgainstBaseURL: false)
        parts?.queryItems = [URLQueryItem(name: "code", value: code)] + (label.isEmpty ? [] : [URLQueryItem(name: "label", value: label)])
        return parts?.url ?? server
    }

    // MARK: Window

    private func buildWindow() {
        let root = RootView(model: model, office: office, connect: { [weak self] url in self?.model.serverURL = url.absoluteString })
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Bureau"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .white
        window.appearance = NSAppearance(named: .aqua)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 960, height: 640)
        window.contentView = NSHostingView(rootView: root)
        window.setFrameAutosaveName("office")
        if !window.setFrameUsingName("office") {
            if let screen = NSScreen.main?.visibleFrame {
                let size = NSSize(width: min(1440, screen.width - 80), height: min(940, screen.height - 60))
                window.setFrame(NSRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2, width: size.width, height: size.height), display: false)
            }
        }
    }

    @objc func showWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func showSettings() {
        if settingsWindow == nil {
            let w = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Bureau Settings"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: AppSettingsView(model: model))
            w.setContentSize(w.contentView?.fittingSize ?? NSSize(width: 460, height: 320))
            w.center()
            settingsWindow = w
        }
        model.refreshNotifications()
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    @objc private func reload() { office.reload() }

    @objc private func openNotificationSettings() { AppSettingsView.openNotificationSettings() }

    @objc private func go(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        showWindow()
        office.open(path: path)
    }

    // MARK: Menus

    private func buildMainMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ build: (NSMenu) -> Void) {
            let item = NSMenuItem()
            let sub = NSMenu(title: title)
            build(sub)
            item.submenu = sub
            main.addItem(item)
        }
        func add(_ m: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil, path: String? = nil) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = mods
            item.target = target
            item.representedObject = path
            m.addItem(item)
        }

        menu("Bureau") { m in
            add(m, "About Bureau", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
            m.addItem(.separator())
            add(m, "Settings\u{2026}", #selector(showSettings), ",", target: self)
            m.addItem(.separator())
            add(m, "Hide Bureau", #selector(NSApplication.hide(_:)), "h")
            add(m, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
            add(m, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
            m.addItem(.separator())
            add(m, "Quit Bureau", #selector(NSApplication.terminate(_:)), "q")
        }
        menu("File") { m in
            add(m, "Close Window", #selector(NSWindow.performClose(_:)), "w")
        }
        // Without an Edit menu, copy and paste would not work in the office.
        menu("Edit") { m in
            add(m, "Undo", Selector(("undo:")), "z")
            add(m, "Redo", Selector(("redo:")), "z", [.command, .shift])
            m.addItem(.separator())
            add(m, "Cut", #selector(NSText.cut(_:)), "x")
            add(m, "Copy", #selector(NSText.copy(_:)), "c")
            add(m, "Paste", #selector(NSText.paste(_:)), "v")
            add(m, "Select All", #selector(NSText.selectAll(_:)), "a")
        }
        menu("View") { m in
            add(m, "Reload", #selector(reload), "r", target: self)
            m.addItem(.separator())
            add(m, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        }
        menu("Go") { m in
            add(m, "Desk", #selector(go(_:)), "1", target: self, path: "/")
            add(m, "Staff", #selector(go(_:)), "2", target: self, path: "/staff")
            add(m, "Books", #selector(go(_:)), "3", target: self, path: "/books")
            add(m, "Calendar", #selector(go(_:)), "4", target: self, path: "/calendar")
            add(m, "Library", #selector(go(_:)), "5", target: self, path: "/library")
            m.addItem(.separator())
            add(m, "Office Settings", #selector(go(_:)), "6", target: self, path: "/settings")
        }
        menu("Window") { m in
            add(m, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
            add(m, "Zoom", #selector(NSWindow.performZoom(_:)))
            m.addItem(.separator())
            add(m, "Bureau", #selector(showWindow), "0", target: self)
            NSApp.windowsMenu = m
        }
        NSApp.mainMenu = main
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = Self.markImage()
        statusItem.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    /// The mark, drawn as a template so the menu bar tints it.
    private static func markImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
            NSColor.black.setStroke()
            NSColor.black.setFill()
            let frame = NSBezierPath(rect: NSRect(x: 2, y: 2, width: 12, height: 12))
            frame.lineWidth = 2
            frame.stroke()
            NSBezierPath(rect: NSRect(x: 2, y: 2, width: 12, height: 6)).fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    private func showCount(_ count: Int) {
        statusItem.button?.title = count > 0 ? " \(count)" : ""
        statusItem.button?.toolTip = count == 0 ? "Bureau: nothing is waiting for you" : "Bureau: \(count) waiting for you"
        NSApp.dockTile.badgeLabel = count > 0 ? "\(count)" : nil
    }

    /// The menu bar menu is rebuilt each time it opens, from what is waiting now.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === statusItem.menu else { return }
        menu.removeAllItems()
        let waiting = model.pending
        let heading: String
        if model.server == nil { heading = "Not connected to an office" }
        else if waiting.isEmpty { heading = "Nothing is waiting for you" }
        else { heading = waiting.count == 1 ? "One thing is waiting for you" : "\(waiting.count) things are waiting for you" }
        let head = NSMenuItem(title: heading, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        for slip in waiting.prefix(12) {
            let title = slip.title.count > 60 ? String(slip.title.prefix(58)) + "\u{2026}" : slip.title
            let item = NSMenuItem(title: "\(slip.staffName): \(title)", action: #selector(go(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = "/?slip=\(slip.id)"
            menu.addItem(item)
        }
        if model.notifications == .denied {
            let off = NSMenuItem(title: "Notifications are off. Turn them on\u{2026}", action: #selector(openNotificationSettings), keyEquivalent: "")
            off.target = self
            menu.addItem(off)
        }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open Bureau", action: #selector(showWindow), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        menu.addItem(NSMenuItem(title: "Quit Bureau", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""))
    }

    // MARK: Notifications

    private func setUpNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let sign = UNNotificationAction(identifier: "SIGN", title: "Sign", options: [])
        let open = UNNotificationAction(identifier: "OPEN", title: "Read it first", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "SLIP_SIGNABLE", actions: [sign, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "SLIP", actions: [open], intentIdentifiers: []),
        ])
        model.askForNotifications()
    }

    private func announce(_ slip: PendingSlip) {
        debugLog("new slip: \(slip.title) (signable: \(slip.signable))")
        let title: String
        switch slip.kind {
        case "question": title = "\(slip.staffName) has a question"
        case "promotion": title = "A promotion to consider"
        default: title = "\(slip.staffName) needs your signature"
        }
        Office.notify(title: title, body: slip.title, slip: slip)
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "debugSignNew"), slip.signable {
            Task { @MainActor in await self.signFromNotification(slipId: slip.id, title: slip.title) }
        }
        #endif
    }

    /// While the owner is looking at the office there is no need for a banner; the slip is on the Desk.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let watchingDesk = await MainActor.run { NSApp.isActive && self.window.isVisible }
        return watchingDesk ? [] : [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        guard let slipId = info["slipId"] as? String else {
            await MainActor.run { self.showWindow() }
            return
        }
        let title = info["title"] as? String ?? ""
        if action == "SIGN" {
            await signFromNotification(slipId: slipId, title: title)
        } else {
            await MainActor.run {
                self.showWindow()
                self.office.open(path: "/?slip=\(slipId)")
            }
        }
    }

    /// The Sign button on a notification. Same check as signing in the window.
    private func signFromNotification(slipId: String, title: String) async {
        guard let server = model.server else { return }
        if model.confirmBeforeSigning {
            guard await Office.confirm(reason: Office.phrase("Sign: \(title)")) else { return }
        }
        await Office.syncCookies()
        let ok = await Office.sign(slipId: slipId, server: server)
        debugLog("signed from notification: \(ok)")
        if !ok {
            // It did not go through (the slip changed, or the office is away). Bring it up to be read.
            showWindow()
            office.open(path: "/?slip=\(slipId)")
            Office.notify(title: "Not signed", body: "Open Bureau to sign this one.")
        }
    }
}
