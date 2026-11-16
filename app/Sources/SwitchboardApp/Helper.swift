import Foundation

/// Where everything lives. Development overrides mirror the service's own env vars.
enum Paths {
    private static var env: [String: String] { ProcessInfo.processInfo.environment }
    private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    /// The bundled `switchboard` helper (SWITCHBOARD_BIN overrides it in development).
    @MainActor static var switchboard: String { ServiceRunner.helper("switchboard").path }

    /// allman sits beside the switchboard helper (SWITCHBOARD_ALLMAN overrides it in development).
    @MainActor static var allman: String { env["SWITCHBOARD_ALLMAN"] ?? ServiceRunner.helper("allman").path }

    /// Same rule as the service: SWITCHBOARD_HOME/app in development, else Application Support.
    static var appSupport: URL {
        if let root = env["SWITCHBOARD_HOME"] {
            return URL(fileURLWithPath: root).appendingPathComponent("app", isDirectory: true)
        }
        return home.appendingPathComponent("Library/Application Support/Switchboard", isDirectory: true)
    }

    static var statusFile: URL { appSupport.appendingPathComponent("status.json") }
    static var configFile: URL { appSupport.appendingPathComponent("config.json") }
    static var allmanStore: String { env["SWITCHBOARD_ALLMAN_STORE"] ?? home.appendingPathComponent(".allman").path }

    /// True when running from Switchboard.app rather than `swift run`.
    static var isBundled: Bool { Bundle.main.bundleURL.pathExtension == "app" }
}

struct CommandResult: Sendable {
    let status: Int32
    let stdout: String
    let stderr: String
    var ok: Bool { status == 0 }
}

enum CommandError: LocalizedError {
    case launch(String, String)
    var errorDescription: String? {
        switch self {
        case let .launch(exe, why): "Couldn't start \(URL(fileURLWithPath: exe).lastPathComponent): \(why)"
        }
    }
}

/// Runs helpers with argv arrays only (never a shell). Output can be long (doctor), so both pipes drain concurrently.
enum Runner {
    final class Box: @unchecked Sendable { var process: Process? }
    /// Written once on the reader thread, read after `group.wait()`.
    private final class DataBox: @unchecked Sendable { var data = Data() }

    static func run(_ exe: String, _ args: [String], box: Box? = nil) async throws -> CommandResult {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: exe)
                p.arguments = args
                let out = Pipe(), err = Pipe()
                p.standardOutput = out
                p.standardError = err
                p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch {
                    cont.resume(throwing: CommandError.launch(exe, error.localizedDescription))
                    return
                }
                box?.process = p
                let errBox = DataBox()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async {
                    errBox.data = err.fileHandleForReading.readDataToEndOfFile()
                    group.leave()
                }
                let outData = out.fileHandleForReading.readDataToEndOfFile()
                group.wait()
                let errData = errBox.data
                p.waitUntilExit()
                cont.resume(returning: CommandResult(
                    status: p.terminationStatus,
                    stdout: String(decoding: outData, as: UTF8.self),
                    stderr: String(decoding: errData, as: UTF8.self)
                ))
            }
        }
    }
}

/// The calls into the existing Switchboard program. The logic lives there; the app only asks.
@MainActor
enum Switchboard {
    struct SetupResult: Decodable, Sendable {
        let config_created: Bool
        let old_agent_removed: Bool
        let claude_code: String
    }

    static func appSetup() async throws -> SetupResult {
        let r = try await Runner.run(Paths.switchboard, ["app-setup"])
        guard r.ok, let data = r.stdout.data(using: .utf8) else {
            throw HelperFailure(action: "finish setup", status: r.status)
        }
        return try JSONDecoder().decode(SetupResult.self, from: data)
    }

    static func setChannel(_ channel: Channel, _ mode: Mode) async throws -> [Channel: Mode] {
        let r = try await Runner.run(Paths.switchboard, ["set-channel", channel.rawValue, mode.rawValue])
        guard r.ok, let data = r.stdout.data(using: .utf8),
              let raw = try? JSONDecoder().decode([String: String].self, from: data)
        else { throw HelperFailure(action: "change \(channel.name)", status: r.status) }
        return ConfigFile.modes(from: raw)
    }

    static func doctor() async throws -> String {
        let r = try await Runner.run(Paths.switchboard, ["doctor"])
        return r.stdout + (r.stderr.isEmpty ? "" : "\n" + r.stderr)
    }
}

/// A helper exited non-zero. stderr is never shown: allman's can hold message text.
struct HelperFailure: LocalizedError {
    let action: String
    let status: Int32
    var errorDescription: String? { "Switchboard couldn't \(action)." }
    var recoverySuggestion: String? {
        "Run Diagnostics in Setup for details."
    }
}
