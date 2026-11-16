import Foundation

enum Channel: String, CaseIterable, Identifiable, Sendable {
    case linkedin, imessage, whatsapp
    var id: String { rawValue }
    var name: String {
        switch self {
        case .linkedin: "LinkedIn"
        case .imessage: "Messages"
        case .whatsapp: "WhatsApp"
        }
    }
}

enum Mode: String, CaseIterable, Identifiable, Sendable {
    case off, read, read_write
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: "Off"
        case .read: "Read only"
        case .read_write: "Read & write"
        }
    }
}

// MARK: - status.json

struct StatusFile: Decodable, Sendable {
    struct ChannelStatus: Decodable, Sendable {
        let channel: String
        let enabled: Bool
        let connected: Bool
        let auth: String
        let last_ingest_at: Date?
        let last_ingest: [String: Int]?
        let problems: [String]
        let listener_running: Bool?
        let mode: String?
    }

    let pid: Int32
    let at: Date
    let approval_port: Int?
    let channels: [ChannelStatus]

    func channel(_ c: Channel) -> ChannelStatus? { channels.first { $0.channel == c.rawValue } }

    static func load(_ url: URL = Paths.statusFile) -> StatusFile? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = f.date(from: s) { return date }
            f.formatOptions = [.withInternetDateTime]
            if let date = f.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "bad date"))
        }
        return try? d.decode(StatusFile.self, from: data)
    }

    /// The daemon process is alive (EPERM still means it exists).
    var processAlive: Bool { kill(pid, 0) == 0 || errno == EPERM }
}

// MARK: - config.json

enum ConfigFile {
    static func modes(from raw: [String: String]) -> [Channel: Mode] {
        var out: [Channel: Mode] = [:]
        for c in Channel.allCases { out[c] = raw[c.rawValue].flatMap(Mode.init(rawValue:)) ?? .off }
        return out
    }

    /// Modes from config.json. A config with no `channels` predates modes: every channel was on.
    static func loadModes(_ url: URL = Paths.configFile) -> [Channel: Mode]? {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        guard let ch = obj["channels"] as? [String: String] else {
            return Dictionary(uniqueKeysWithValues: Channel.allCases.map { ($0, Mode.read_write) })
        }
        return modes(from: ch)
    }
}

// MARK: - What the UI shows per channel

/// A channel's state, reduced to what a person needs: is it working, and if not, what fixes it.
enum ChannelHealth: Equatable {
    case off
    case starting // on, but the service hasn't read it yet
    case paused // on, but the background service isn't running
    case ok(lastSync: Date, newMessages: Int)
    case needsFullDiskAccess
    case notSignedIn(expired: Bool) // LinkedIn
    case unavailable(String) // the app or its data isn't on this Mac: the row is disabled
    case problem // a sync failed; details live in Diagnostics (the daemon's wording isn't shown raw)

    var needsAttention: Bool {
        switch self {
        case .off, .starting, .ok: false
        default: true
        }
    }

    /// Hard blockers disable the picker: nothing to switch on.
    var blocksRow: Bool {
        if case .unavailable = self { return true }
        return false
    }
}

extension ChannelHealth {
    /// Reads the daemon's view. Problem strings are the service's own wording, never message content.
    /// `enabled` is false when the channel's data isn't on this Mac, but without Full Disk Access the service
    /// can't see Messages or WhatsApp data at all, so that case reads as missing access, not a missing app.
    static func from(
        _ s: StatusFile.ChannelStatus?, channel: Channel, mode: Mode, serviceRunning: Bool, fullDiskAccess: Bool?
    ) -> ChannelHealth {
        let problems = s?.problems ?? []
        if problems.contains(where: { $0.contains("allman binary not found") }) {
            return .unavailable("LinkedIn helper missing. Reinstall Switchboard.")
        }
        if channel != .linkedin, let s, !s.enabled {
            if fullDiskAccess == false || problems.contains(where: { $0.contains("Full Disk Access") }) {
                return mode == .off ? .off : .needsFullDiskAccess
            }
            return .unavailable(channel == .imessage ? "Messages isn't set up on this Mac" : "WhatsApp desktop not found")
        }
        guard mode != .off else { return .off }
        guard serviceRunning else { return .paused }
        guard let s else { return .starting }
        if problems.contains(where: { $0.contains("Full Disk Access") }) { return .needsFullDiskAccess }
        if channel == .linkedin, s.auth != "authenticated" { return .notSignedIn(expired: s.auth == "expired") }
        if problems.contains(where: { !$0.hasPrefix("Switched off") }) { return .problem }
        guard let at = s.last_ingest_at else { return .starting }
        return .ok(lastSync: at, newMessages: s.last_ingest?["messages"] ?? 0)
    }
}
