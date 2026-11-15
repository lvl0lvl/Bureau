import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var failed = false
    @State private var reloadToken = UUID()

    var body: some View {
        Group {
            if let server = model.server {
                ZStack {
                    OfficeWebView(server: server, failed: $failed)
                        .id(reloadToken)
                        .ignoresSafeArea()
                    if failed {
                        UnreachableView(server: server, retry: { failed = false; reloadToken = UUID() }, change: { model.serverURL = "" })
                    }
                }
            } else {
                SetupView()
            }
        }
        .background(Color.white)
        .preferredColorScheme(.light)
        .onChange(of: scenePhase) { _, phase in
            // Coming back after a failure: try again without being asked.
            if phase == .active && failed { failed = false; reloadToken = UUID() }
        }
    }
}

/// First run: where is the Mac?
struct SetupView: View {
    @EnvironmentObject private var model: AppModel
    @State private var address = ""
    @State private var checking = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Mark().frame(width: 28, height: 28).padding(.top, 28)
            Text("Where is your office?")
                .font(.system(size: 34, weight: .heavy))
                .tracking(-0.8)
                .padding(.top, 28)
            Text("Bureau runs on your Mac. Enter the address it shows when you turn on remote access, with Tailscale switched on for this phone.")
                .font(.system(size: 16))
                .foregroundStyle(Color(red: 0.35, green: 0.37, blue: 0.40))
                .padding(.top, 10)

            TextField("mac-name.tailnet.ts.net", text: $address)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(connect)
                .font(.system(size: 17))
                .padding(.horizontal, 14)
                .frame(height: 52)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.black, lineWidth: 1.5))
                .padding(.top, 28)

            if let problem {
                Text(problem)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color(red: 0.88, green: 0.21, blue: 0.17))
                    .padding(.top, 10)
            }

            Button(action: connect) {
                HStack {
                    Text(checking ? "Looking for it" : "Connect")
                        .font(.system(size: 17, weight: .semibold))
                    if checking { ProgressView().tint(.white).padding(.leading, 4) }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .foregroundStyle(.white)
                .background(Color("AccentColor"))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .disabled(checking || address.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(address.trimmingCharacters(in: .whitespaces).isEmpty ? 0.45 : 1)
            .padding(.top, 16)

            Spacer()
            Text("On the Mac, run \u{201C}pnpm remote:on\u{201D} in the Bureau folder to see the address.")
                .font(.system(size: 13))
                .foregroundStyle(Color(red: 0.35, green: 0.37, blue: 0.40))
                .padding(.bottom, 12)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity)
        .onAppear { focused = true }
    }

    private func connect() {
        guard let url = Office.normalise(address) else {
            problem = "That does not look like an address."
            return
        }
        checking = true
        problem = nil
        Task {
            let result = await Office.probe(url)
            checking = false
            switch result {
            case .success: model.serverURL = url.absoluteString
            case .failure(let error): problem = error.message
            }
        }
    }
}

/// Shown over the web view when the Mac cannot be reached.
struct UnreachableView: View {
    let server: URL
    let retry: () -> Void
    let change: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Mark().frame(width: 28, height: 28)
            Text("Your Mac is not answering")
                .font(.system(size: 30, weight: .heavy))
                .tracking(-0.6)
                .padding(.top, 24)
            Text("Check that Tailscale is on for this phone, and that the Mac is awake with Bureau running. Nothing has been lost; staff carry on working on the Mac.")
                .font(.system(size: 16))
                .foregroundStyle(Color(red: 0.35, green: 0.37, blue: 0.40))
                .padding(.top, 10)
            Text(server.host ?? server.absoluteString)
                .font(.system(size: 14, weight: .semibold))
                .padding(.top, 14)
            Button(action: retry) {
                Text("Try again")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity).frame(height: 52)
                    .foregroundStyle(.white)
                    .background(Color("AccentColor"))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .padding(.top, 24)
            Button(action: change) {
                Text("Use a different address")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: .infinity).frame(height: 48)
                    .foregroundStyle(.black)
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white)
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
                    Rectangle().fill(Color("AccentColor")).frame(height: s * 0.27)
                }
                Rectangle().strokeBorder(Color.black, lineWidth: stroke)
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
