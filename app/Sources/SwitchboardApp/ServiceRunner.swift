// Switchboard.app runs the daemon (Contents/Helpers/switchboard daemon) as its own child process, so the one Full
// Disk Access grant to Switchboard.app covers it: macOS judged a separately registered launchd agent on its own and
// denied it (tested 2026-11-15, docs/DESIGN.md). The app starts at login (SMAppService.mainApp) and stays in the menu
// bar; quitting it stops Switchboard. The daemon also exits if this process disappears (SWITCHBOARD_PARENT_PID).
// Shared with the SwiftUI app (app/): start `ServiceRunner.shared.start()` at launch, `stop()` on terminate,
// `restart()` after `switchboard set-channel`.
import Foundation
import ServiceManagement

@MainActor
final class ServiceRunner {
    static let shared = ServiceRunner()

    private var process: Process?
    private var stopping = false
    private var backoff: TimeInterval = 2
    private var startedAt = Date()
    private(set) var lastExit: Int32?

    var isRunning: Bool { process?.isRunning ?? false }

    /// Contents/Helpers/<name>, or SWITCHBOARD_BIN's folder in development.
    static func helper(_ name: String) -> URL {
        if let dev = ProcessInfo.processInfo.environment["SWITCHBOARD_BIN"] {
            let bin = URL(fileURLWithPath: dev)
            return name == "switchboard" ? bin : bin.deletingLastPathComponent().appendingPathComponent(name)
        }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/\(name)")
    }

    func start() {
        stopping = false
        guard process == nil else { return }
        let p = Process()
        p.executableURL = Self.helper("switchboard")
        p.arguments = ["daemon"]
        var env = ProcessInfo.processInfo.environment
        env["SWITCHBOARD_LOG_TO_FILE"] = "1"
        env["SWITCHBOARD_PARENT_PID"] = String(getpid())
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in self?.exited(proc.terminationStatus) }
        }
        do {
            try p.run()
            process = p
            startedAt = Date()
        } catch {
            lastExit = -1
            scheduleRestart()
        }
    }

    func stop() {
        stopping = true
        process?.terminate() // SIGTERM: the daemon closes its socket and exits
        process?.waitUntilExit()
        process = nil
    }

    /// Apply a config change (the daemon reads channel modes at start and purges channels switched off).
    func restart() {
        stop()
        backoff = 2
        start()
    }

    /// Also how scripts/http-token.sh applies a config change: it stops the daemon and this starts it again.
    private func exited(_ status: Int32) {
        process = nil
        lastExit = status
        // A daemon that ran a while and was stopped isn't crash-looping: come back quickly.
        if Date().timeIntervalSince(startedAt) > 60 { backoff = 2 }
        if !stopping { scheduleRestart() }
    }

    private func scheduleRestart() {
        let delay = backoff
        backoff = min(backoff * 2, 300)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopping else { return }
            self.start()
        }
    }

    // MARK: Start at login

    static var startsAtLogin: Bool { SMAppService.mainApp.status == .enabled }

    static func setStartsAtLogin(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }

    /// Builds before 2026-11-15 registered a separate agent (vc.aihouse.switchboard.agent); retire it once.
    static func retireOldAgent() {
        let old = SMAppService.agent(plistName: "vc.aihouse.switchboard.agent.plist")
        if old.status == .enabled || old.status == .requiresApproval { try? old.unregister() }
    }
}
