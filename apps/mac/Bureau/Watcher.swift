import Foundation

/// Follows the office over its sync socket so the menu bar and notifications stay right even
/// when the window is closed. It only reads; signing goes through the same HTTP call the page uses.
@MainActor
final class Watcher {
    private let model: AppModel
    private var server: URL?
    private var task: URLSessionWebSocketTask?
    private var generation = 0
    private var backoff: Double = 1
    private var pingTimer: Timer?
    private var retry: DispatchWorkItem?

    private var slips: [String: [String: Any]] = [:]
    private var staff: [String: String] = [:]
    /// Slips already seen as pending, so each is announced once.
    private var announced = Set<String>()
    private var primed = false
    var onNewSlip: ((PendingSlip) -> Void)?

    init(model: AppModel) { self.model = model }

    func start(_ url: URL) {
        stop()
        server = url
        primed = false
        connect()
    }

    func stop() {
        generation += 1
        retry?.cancel()
        pingTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        slips = [:]
        announced = []
        model.pending = []
    }

    private func connect() {
        guard let server else { return }
        let mine = generation
        Task { @MainActor in
            // The page pairs this Mac; its cookie is what lets the socket in.
            await Office.syncCookies()
            guard mine == self.generation else { return }
            guard var parts = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return }
            parts.scheme = parts.scheme == "https" ? "wss" : "ws"
            parts.path = "/api/sync"
            guard let url = parts.url else { return }
            var request = URLRequest(url: url)
            if let cookie = Office.cookieHeader(for: server) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
            let task = URLSession.shared.webSocketTask(with: request)
            self.task = task
            task.resume()
            // No cursor: the first answer is a full snapshot, which is what a fresh watcher wants.
            self.send(["t": "hello", "protocol": 1, "cursor": NSNull(), "thread": NSNull()])
            self.listen(task, mine)
            self.pingTimer?.invalidate()
            self.pingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.send(["t": "ping", "n": Int(Date().timeIntervalSince1970)]) }
            }
        }
    }

    private func send(_ message: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func listen(_ task: URLSessionWebSocketTask, _ mine: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, mine == self.generation else { return }
                switch result {
                case .failure(let error):
                    debugLog("watcher lost the office: \(error.localizedDescription)")
                    self.reconnect(mine)
                case .success(let message):
                    self.backoff = 1
                    if case .string(let text) = message { self.handle(text) }
                    self.listen(task, mine)
                }
            }
        }
    }

    private func reconnect(_ mine: Int) {
        pingTimer?.invalidate()
        task = nil
        let work = DispatchWorkItem { [weak self] in
            guard let self, mine == self.generation else { return }
            self.connect()
        }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff, execute: work)
        backoff = min(backoff * 2, 20)
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let kind = message["t"] as? String else { return }
        switch kind {
        case "snapshot":
            guard let snapshot = message["snapshot"] as? [String: Any] else { return }
            staff = [:]
            for person in snapshot["staff"] as? [[String: Any]] ?? [] { note(staff: person) }
            slips = [:]
            for slip in snapshot["slips"] as? [[String: Any]] ?? [] { if let id = slip["id"] as? String { slips[id] = slip } }
            publish()
        case "delta":
            for change in message["changes"] as? [[String: Any]] ?? [] {
                let value = change["v"] as? [String: Any]
                switch change["k"] as? String {
                case "staff": if let value { note(staff: value) }
                case "slip": if let value, let id = value["id"] as? String { slips[id] = value }
                case "del": if change["kind"] as? String == "slip", let id = change["id"] as? String { slips[id] = nil }
                default: break
                }
            }
            publish()
        default:
            break
        }
    }

    private func note(staff person: [String: Any]) {
        if let id = person["id"] as? String, let name = person["name"] as? String { staff[id] = name }
    }

    private func publish() {
        let waiting: [PendingSlip] = slips.values.compactMap { slip in
            guard slip["status"] as? String == "pending", let id = slip["id"] as? String else { return nil }
            let kind = slip["kind"] as? String ?? "action"
            let read = (slip["origin"] as? [String: Any])?["read"] as? [Any] ?? []
            return PendingSlip(
                id: id, title: slip["title"] as? String ?? "A slip", staffName: staff[slip["staffId"] as? String ?? ""] ?? "Your staff",
                kind: kind, signable: kind == "action" && read.isEmpty, createdAt: slip["createdAt"] as? Double ?? 0)
        }.sorted { $0.createdAt < $1.createdAt }

        // What was already waiting when we connected is not news.
        let fresh = primed ? waiting.filter { !announced.contains($0.id) } : []
        announced.formUnion(waiting.map(\.id))
        primed = true
        if model.pending != waiting { model.pending = waiting }
        debugLog("watcher: \(waiting.count) waiting, \(fresh.count) new")
        for slip in fresh { onNewSlip?(slip) }
    }
}
