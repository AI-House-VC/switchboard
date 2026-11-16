import AppKit
import Observation
import ServiceManagement

enum Page: String, Hashable, CaseIterable, Identifiable {
    case getStarted, channels, setup, bots
    var id: String { rawValue }
}

enum ServiceState: Equatable {
    case running, stopped, restarting
}

/// A mode change waiting for the user to confirm it.
struct PendingChange: Identifiable, Equatable {
    let channel: Channel
    let from: Mode
    let to: Mode
    var id: String { "\(channel.rawValue)-\(to.rawValue)" }
}

struct AppAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

@MainActor @Observable
final class AppModel {
    // What the service reports.
    private(set) var status: StatusFile?
    private(set) var modes: [Channel: Mode] = Dictionary(uniqueKeysWithValues: Channel.allCases.map { ($0, .off) })
    private(set) var fullDiskAccess: Bool?
    private(set) var claudeCode: String? // registered | not_installed | failed
    private(set) var serviceRunning = false
    private(set) var serviceLastExit: Int32?
    private(set) var loginItem: SMAppService.Status?

    // What the app is doing.
    private(set) var applying: Set<Channel> = []
    private(set) var restarting = false
    private(set) var registeringClaude = false
    private(set) var signingIn = false
    private(set) var setupFinished = false
    var pending: PendingChange?
    var alert: AppAlert?
    var selection: Page? = .channels
    var windowVisible = false {
        didSet { if windowVisible { refresh() } }
    }

    private let defaults = UserDefaults.standard
    private var pollTask: Task<Void, Never>?
    private let signInBox = Runner.Box()

    var setupBlockCopied: Bool {
        get { defaults.bool(forKey: "setupBlockCopied") }
        set { defaults.set(newValue, forKey: "setupBlockCopied") }
    }

    var guideDismissed: Bool {
        get { defaults.bool(forKey: "guideDismissed") }
        set { defaults.set(newValue, forKey: "guideDismissed"); if newValue { selection = .channels } }
    }

    init() {
        if !guideDismissed { selection = .getStarted }
    }

    // MARK: Derived state

    var serviceState: ServiceState {
        if restarting { return .restarting }
        return serviceRunning ? .running : .stopped
    }

    var startsAtLogin: Bool { loginItem == .enabled }
    var loginItemNeedsApproval: Bool { loginItem == .requiresApproval }

    func health(_ c: Channel) -> ChannelHealth {
        ChannelHealth.from(
            status?.channel(c), channel: c, mode: modes[c] ?? .off,
            serviceRunning: serviceState == .running || serviceState == .restarting,
            fullDiskAccess: fullDiskAccess
        )
    }

    /// A channel that's off never asks for attention, even if its app is missing.
    func needsAttention(_ c: Channel) -> Bool { modes[c] != .off && health(c).needsAttention }

    var anyChannelOn: Bool { modes.values.contains { $0 != .off } }

    var linkedInSignedIn: Bool { status?.channel(.linkedin)?.auth == "authenticated" }

    /// Full Disk Access matters once Messages or WhatsApp is on.
    var needsFullDiskAccess: Bool { fullDiskAccess == false }

    var botsConnected: Bool { claudeCode == "registered" || setupBlockCopied }

    enum Overall { case notSetUp, good, attention }

    var overall: Overall {
        if !anyChannelOn { return .notSetUp }
        if serviceState == .stopped { return .attention }
        return Channel.allCases.contains { needsAttention($0) } ? .attention : .good
    }

    var showGuide: Bool { !guideDismissed }

    func pageNeedsAttention(_ p: Page) -> Bool {
        switch p {
        case .getStarted: false
        case .channels: Channel.allCases.contains { needsAttention($0) }
        case .setup:
            anyChannelOn && (serviceState == .stopped
                || (needsFullDiskAccess && (modes[.imessage] != .off || modes[.whatsapp] != .off))
                || (modes[.linkedin] != .off && !linkedInSignedIn))
        case .bots: claudeCode == "failed"
        }
    }

    // MARK: Lifecycle

    /// Launch order: retire the old separate agent, app-setup, then run the service as this app's child
    /// (so the app's Full Disk Access covers it). First run turns on start at login.
    func start() {
        if Paths.isBundled { ServiceRunner.retireOldAgent() }
        refresh()
        Task {
            await runAppSetup()
            ServiceRunner.shared.start()
            if Paths.isBundled, !defaults.bool(forKey: "loginItemDefaultApplied") {
                defaults.set(true, forKey: "loginItemDefaultApplied")
                try? ServiceRunner.setStartsAtLogin(true)
            }
            refresh()
            // A service that fails at once shows as stopped on the next look, not 15 s later.
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            refresh()
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                let seconds: UInt64 = (self?.windowVisible ?? false) ? 3 : 15
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                self?.refresh()
            }
        }
    }

    func refresh() {
        status = StatusFile.load()
        if applying.isEmpty, let m = ConfigFile.loadModes() { modes = m }
        fullDiskAccess = Self.checkFullDiskAccess(status: status)
        serviceRunning = ServiceRunner.shared.isRunning
        serviceLastExit = ServiceRunner.shared.lastExit
        if Paths.isBundled { loginItem = SMAppService.mainApp.status }
    }

    private func runAppSetup() async {
        do {
            claudeCode = try await Switchboard.appSetup().claude_code
        } catch {
            alert = AppAlert(title: "Switchboard couldn't finish setting up",
                             message: describe(error))
        }
    }

    /// Full Disk Access as this app sees it: a protected folder is listable only with the grant. The folder is
    /// listed, never read, and no database is opened. A service report of missing access wins.
    private static func checkFullDiskAccess(status: StatusFile?) -> Bool {
        if let forced = ProcessInfo.processInfo.environment["SWITCHBOARD_FDA"] { return forced == "granted" }
        if status?.channels.contains(where: { $0.problems.contains { $0.contains("Full Disk Access") } }) == true {
            return false
        }
        let safari = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Safari").path
        return (try? FileManager.default.contentsOfDirectory(atPath: safari)) != nil
    }

    // MARK: Channel modes

    /// Called by the picker. Off (from on) and Read & write ask first; Read only applies at once.
    func request(_ c: Channel, _ to: Mode) {
        let from = modes[c] ?? .off
        guard from != to else { return }
        if to != .off, health(c).blocksRow { return }
        if to == .off || to == .read_write {
            pending = PendingChange(channel: c, from: from, to: to)
        } else {
            apply(c, to)
        }
    }

    func confirmPending() {
        guard let p = pending else { return }
        pending = nil
        apply(p.channel, p.to)
    }

    func apply(_ c: Channel, _ to: Mode) {
        let previous = modes[c] ?? .off
        modes[c] = to
        applying.insert(c)
        Task {
            defer { applying.remove(c); refresh() }
            do {
                modes = try await Switchboard.setChannel(c, to)
                // The service reads modes at start and deletes the copy of channels switched off.
                ServiceRunner.shared.restart()
            } catch {
                modes[c] = previous
                alert = AppAlert(title: "\(c.name) wasn't changed", message: describe(error))
            }
        }
    }

    // MARK: Setup actions

    func restartService() {
        restarting = true
        Task {
            defer { restarting = false; refresh() }
            ServiceRunner.shared.restart()
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
    }

    func openFullDiskAccess() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    }

    func openLoginItems() { SMAppService.openSystemSettingsLoginItems() }

    func setStartsAtLogin(_ on: Bool) {
        do { try ServiceRunner.setStartsAtLogin(on) } catch {
            alert = AppAlert(title: on ? "Switchboard couldn't turn on Open at Login" : "Switchboard couldn't turn off Open at Login",
                             message: "You can change it in System Settings → General → Login Items.")
        }
        refresh()
    }

    func stopService() { ServiceRunner.shared.stop() }

    /// `allman login` opens the browser itself and returns once the sign-in finishes.
    func signInToLinkedIn() {
        guard !signingIn else { return }
        signingIn = true
        Task {
            defer { signingIn = false; refresh() }
            do {
                let r = try await Runner.run(Paths.allman, ["login", "--store", Paths.allmanStore], box: signInBox)
                if !r.ok, r.status != SIGTERM {
                    alert = AppAlert(title: "LinkedIn sign-in didn't finish",
                                     message: "Try again. If it keeps failing, run Diagnostics in Setup.")
                }
            } catch {
                alert = AppAlert(title: "LinkedIn sign-in didn't start", message: describe(error))
            }
        }
    }

    func cancelSignIn() { signInBox.process?.terminate() }

    func registerClaudeCode() {
        registeringClaude = true
        Task {
            defer { registeringClaude = false }
            await runAppSetup()
        }
    }

    var setupBlock: String {
        let path = (try? JSONSerialization.data(withJSONObject: Paths.switchboard, options: [.fragmentsAllowed, .withoutEscapingSlashes]))
            .map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
        return """
        {
          "mcpServers": {
            "switchboard": {
              "command": \(path),
              "args": ["mcp", "--client", "openmausbot"]
            }
          }
        }
        """
    }

    func copySetupBlock() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(setupBlock, forType: .string)
        setupBlockCopied = true
    }

    private func open(_ url: String) {
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }

    private func describe(_ error: Error) -> String {
        let e = error as? LocalizedError
        return [e?.errorDescription ?? error.localizedDescription, e?.recoverySuggestion]
            .compactMap { $0 }.joined(separator: " ")
    }
}
