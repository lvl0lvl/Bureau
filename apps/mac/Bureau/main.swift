import AppKit

// Bureau for Mac. The interface is the one the office serves; this app gives it a window of its
// own, a menu bar item that counts what is waiting, notifications, and Touch ID before a signature.
MainActor.assumeIsolated {
    let delegate = AppDelegate()
    let app = NSApplication.shared
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    // The delegate is held weakly by the app; `run` never returns, so this scope keeps it alive.
    app.run()
}
