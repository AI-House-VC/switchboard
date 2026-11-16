import AppKit
import SwiftUI

struct ChannelsView: View {
    @Environment(AppModel.self) private var model
    @State private var diagnostics = false

    var body: some View {
        Form {
            Section {
                ForEach(Channel.allCases) { c in
                    ChannelRow(channel: c, showDiagnostics: $diagnostics)
                }
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("**Off:** nothing is read, and Switchboard deletes its copy of the conversations.")
                    Text("**Read only:** bots can search and read these conversations.")
                    Text("**Read & write:** bots can also ask to send. You approve every message on this Mac before it goes.")
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $diagnostics) { DiagnosticsSheet() }
        .onChange(of: model.pending) { _, p in
            if let p { Self.confirm(p, model: model) }
        }
    }

    /// An NSAlert sheet, so the keys are explicit: for Off, Return is Cancel and the delete needs a click.
    static func confirm(_ p: PendingChange, model: AppModel) {
        let a = NSAlert()
        a.messageText = title(p)
        a.informativeText = message(p)
        a.alertStyle = p.to == .off ? .critical : .informational
        let go = a.addButton(withTitle: p.to == .off ? "Turn Off and Delete Copy" : "Allow Sending")
        let cancel = a.addButton(withTitle: "Cancel")
        if p.to == .off {
            go.hasDestructiveAction = true
            go.keyEquivalent = ""
            cancel.keyEquivalent = "\r"
        } else {
            cancel.keyEquivalent = "\u{1b}"
        }
        let done: (NSApplication.ModalResponse) -> Void = { r in
            if r == .alertFirstButtonReturn { model.confirmPending() } else { model.pending = nil }
        }
        if let w = (NSApp.delegate as? AppDelegate)?.settingsWindow, w.isVisible {
            a.beginSheetModal(for: w, completionHandler: done)
        } else {
            done(a.runModal())
        }
    }

    static func title(_ p: PendingChange) -> String {
        p.to == .off ? "Turn off \(p.channel.name)?" : "Let bots ask to send on \(p.channel.name)?"
    }

    static func message(_ p: PendingChange) -> String {
        let app = p.channel == .imessage ? "Messages" : p.channel.name
        if p.to == .off {
            return "Bots will no longer see your \(p.channel.name) conversations, and Switchboard will delete its copy of them from this Mac. "
                + "Your messages in \(app) aren't touched. Turning \(p.channel.name) back on reads them again."
        }
        return "Bots will be able to draft replies and ask to send them on \(p.channel.name). "
            + "Nothing is sent until you approve the exact message on this Mac."
    }
}

private struct ChannelRow: View {
    @Environment(AppModel.self) private var model
    let channel: Channel
    @Binding var showDiagnostics: Bool

    var body: some View {
        let health = model.health(channel)
        let busy = model.applying.contains(channel)
        SettingRow(
            symbol: channel.symbol, tint: channel.tint, title: channel.name,
            state: busy ? StateLine(text: "Applying…", tone: .busy)
                : health.blocksRow && model.modes[channel] != .off ? health.stateLine.tone(.attention)
                : health.stateLine
        ) {
            Picker(channel.name, selection: Binding(
                get: { model.modes[channel] ?? .off },
                set: { model.request(channel, $0) }
            )) {
                ForEach(Mode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            // A missing app blocks switching on, never switching off (Off deletes the copy).
            .disabled(busy || (health.blocksRow && model.modes[channel] == .off))
        } below: {
            fix(for: health)
        }
    }

    @ViewBuilder private func fix(for health: ChannelHealth) -> some View {
        switch health {
        case .needsFullDiskAccess:
            Button("Open Privacy Settings…") { model.openFullDiskAccess() }
                .buttonStyle(.link).font(.callout)
        case .notSignedIn:
            if model.signingIn {
                Button("Cancel Sign-In") { model.cancelSignIn() }.buttonStyle(.link).font(.callout)
            } else {
                Button("Sign In to LinkedIn…") { model.signInToLinkedIn() }.buttonStyle(.link).font(.callout)
            }
        case .paused:
            Button("Open Setup") { model.selection = .setup }.buttonStyle(.link).font(.callout)
        case .unavailable where model.modes[channel] != .off:
            Text("Turn it off to delete Switchboard's copy.").font(.callout).foregroundStyle(.secondary)
        case .problem:
            Button("Run Diagnostics…") { showDiagnostics = true }.buttonStyle(.link).font(.callout)
        default:
            EmptyView()
        }
    }
}
