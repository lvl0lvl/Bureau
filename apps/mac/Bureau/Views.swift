import SwiftUI
import WebKit

private let graphite = Color(red: 0.35, green: 0.37, blue: 0.40)
private let blue = Color(red: 0x1D / 255, green: 0x3F / 255, blue: 0xE3 / 255)
private let red = Color(red: 0.88, green: 0.21, blue: 0.17)

/// What the window shows: the office, or how to find it.
struct RootView: View {
    @ObservedObject var model: AppModel
    let office: OfficeController
    let connect: (URL) -> Void

    var body: some View {
        ZStack {
            Color.white
            if model.server != nil {
                WebContainer(webView: office.webView)
                if model.unreachable {
                    UnreachableView(server: model.server, retry: { office.reload() }, change: { model.serverURL = "" })
                }
            } else if model.looking {
                ProgressView().controlSize(.small)
            } else {
                SetupView(connect: connect)
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .preferredColorScheme(.light)
    }
}

struct WebContainer: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

/// No office found on this Mac: where is it?
struct SetupView: View {
    let connect: (URL) -> Void
    @State private var address = ""
    @State private var checking = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Mark().frame(width: 28, height: 28)
            Text("Where is your office?")
                .font(.system(size: 34, weight: .heavy))
                .tracking(-0.8)
                .padding(.top, 24)
            Text("Bureau is not running on this Mac. Start it here with \u{201C}pnpm start\u{201D} in the Bureau folder, or enter the address of the Mac it runs on.")
                .font(.system(size: 15))
                .foregroundStyle(graphite)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)

            HStack(spacing: 10) {
                TextField("localhost:8787 or mac-name.tailnet.ts.net", text: $address)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15))
                    .focused($focused)
                    .onSubmit(submit)
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.black, lineWidth: 1.5))
                Button(action: submit) {
                    Text(checking ? "Looking" : "Connect")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .frame(height: 40)
                        .background(blue.opacity(address.trimmingCharacters(in: .whitespaces).isEmpty ? 0.45 : 1))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .disabled(checking || address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.top, 24)

            if let problem {
                Text(problem).font(.system(size: 13, weight: .semibold)).foregroundStyle(red).padding(.top, 10)
            }
            Button("Look on this Mac again") { address = "localhost:8787"; submit() }
                .buttonStyle(.link)
                .padding(.top, 14)
        }
        .frame(width: 520, alignment: .leading)
        .onAppear { focused = true }
    }

    private func submit() {
        guard let url = Office.normalise(address) else {
            problem = "That does not look like an address."
            return
        }
        checking = true
        problem = nil
        Task {
            let found = await Office.answers(url)
            checking = false
            if found { connect(url) } else { problem = "Nothing answered there as Bureau. Check that it is running, and that Tailscale is on if it is another Mac." }
        }
    }
}

/// Shown over the web view when the office cannot be reached. The app keeps trying on its own.
struct UnreachableView: View {
    let server: URL?
    let retry: () -> Void
    let change: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Mark().frame(width: 28, height: 28)
            Text("The office is not answering")
                .font(.system(size: 30, weight: .heavy))
                .tracking(-0.6)
                .padding(.top, 24)
            Text("Bureau will keep trying. If it is not running, start it with \u{201C}pnpm start\u{201D} in the Bureau folder, or \u{201C}pnpm service:install\u{201D} to keep it running from now on.")
                .font(.system(size: 15))
                .foregroundStyle(graphite)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
            Text(server?.absoluteString ?? "")
                .font(.system(size: 13, weight: .semibold))
                .padding(.top, 14)
            HStack(spacing: 14) {
                Button(action: retry) {
                    Text("Try now")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .frame(height: 40)
                        .background(blue)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                Button("Use a different address", action: change).buttonStyle(.link)
            }
            .padding(.top, 22)
        }
        .frame(width: 520, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white)
    }
}

/// The app's own few settings. The office's settings are in the office.
struct AppSettingsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Form {
            Section {
                Toggle("Ask for Touch ID or my password before I sign", isOn: $model.confirmBeforeSigning)
                Text("Applies to signing in this app and from its notifications. Without Touch ID or an Apple Watch, macOS asks for your password each time.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if model.confirmBeforeSigning && !Office.canConfirm {
                    Text("This Mac has no account password, so it cannot ask. While this is on, nothing can be signed here.")
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Section {
                LabeledContent("Office address") {
                    Text(model.serverURL.isEmpty ? "Not connected" : model.serverURL).textSelection(.enabled)
                }
                Button("Use a different address") { model.serverURL = "" }
                    .disabled(model.serverURL.isEmpty)
            }
            Section {
                switch model.notifications {
                case .denied?:
                    Text("Notifications are off for Bureau, so it cannot tell you when a slip arrives.")
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Open Notification Settings") { Self.openNotificationSettings() }
                case .notDetermined?:
                    Text("Bureau has not been allowed to send notifications yet.")
                    Button("Allow notifications") { model.askForNotifications() }
                default:
                    Text("Notifications are on.")
                }
                Text("Bureau stays in the menu bar when its window is closed, so it can tell you when a slip arrives.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear { model.refreshNotifications() }
    }

    static func openNotificationSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
    }
}

/// The Bureau mark: a framed sheet with a blue sign-off band along the bottom.
struct Mark: View {
    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width
            let stroke = s * 0.115
            ZStack(alignment: .bottom) {
                Rectangle().fill(Color.white)
                VStack(spacing: 0) {
                    Rectangle().fill(Color.black).frame(height: stroke)
                    Rectangle().fill(blue).frame(height: s * 0.27)
                }
                Rectangle().strokeBorder(Color.black, lineWidth: stroke)
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
