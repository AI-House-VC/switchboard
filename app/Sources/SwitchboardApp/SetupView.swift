import SwiftUI

struct SetupView: View {
    @Environment(AppModel.self) private var model
    @State private var diagnostics = false

    var body: some View {
        Form {
            Section {
                SettingRow(symbol: "arrow.triangle.2.circlepath", tint: .gray, title: "Background service",
                           state: serviceLine) {
                    Button(model.serviceState == .stopped ? "Start" : "Restart") { model.restartService() }
                        .disabled(model.serviceState == .restarting)
                }
                Toggle(isOn: Binding(get: { model.startsAtLogin }, set: { model.setStartsAtLogin($0) })) {
                    Text("Open Switchboard at login")
                    if model.loginItemNeedsApproval {
                        Text("macOS is waiting for your permission in Login Items.")
                    }
                }
                if model.loginItemNeedsApproval {
                    LabeledContent("") { Button("Open Login Items…") { model.openLoginItems() } }
                }
            } footer: {
                Text("Switchboard reads your channels and handles your approvals while it's in the menu bar. If you quit it, bots lose access until you open it again.")
                    .footnote()
            }

            Section {
                SettingRow(symbol: "lock.shield.fill", tint: .blue, title: "Full Disk Access",
                           state: fdaLine) {
                    Button("Open Privacy Settings…") { model.openFullDiskAccess() }
                }
            } footer: {
                Text("Needed for Messages and WhatsApp. In the list, turn on Switchboard; if it's missing, click + and choose Switchboard in Applications. After an update, if Messages still can't be read, remove Switchboard with − and add it again.")
                    .footnote()
            }

            Section {
                SettingRow(symbol: Channel.linkedin.symbol, tint: Channel.linkedin.tint, title: "LinkedIn",
                           state: linkedInLine) {
                    if model.signingIn {
                        Button("Cancel") { model.cancelSignIn() }
                    } else {
                        Button(model.linkedInSignedIn ? "Sign In Again…" : "Sign In to LinkedIn…") {
                            model.signInToLinkedIn()
                        }
                    }
                }
            } footer: {
                Text("Sign-in happens in your browser. Switchboard never sees your password.").footnote()
            }

            Section {
                LabeledContent {
                    Button("Run Diagnostics…") { diagnostics = true }
                } label: {
                    Text("Diagnostics")
                    Text("A detailed check of every part of Switchboard, to share if you need help.")
                }
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $diagnostics) { DiagnosticsSheet() }
    }

    private var serviceLine: StateLine {
        switch model.serviceState {
        case .running: StateLine(text: "Running", tone: .good)
        case .restarting: StateLine(text: "Restarting…", tone: .busy)
        case .stopped:
            StateLine(text: model.serviceLastExit != nil ? "Stopped unexpectedly. Start it, or run Diagnostics." : "Not running",
                      tone: model.anyChannelOn ? .attention : .neutral)
        }
    }

    private var fdaLine: StateLine {
        switch model.fullDiskAccess {
        case .some(true): StateLine(text: "Allowed", tone: .good)
        case .some(false): StateLine(text: "Not allowed yet", tone: .attention)
        case .none: StateLine(text: "Checking…", tone: .busy)
        }
    }

    private var linkedInLine: StateLine {
        if model.signingIn { return StateLine(text: "Finish signing in in your browser…", tone: .busy) }
        if model.linkedInSignedIn { return StateLine(text: "Signed in", tone: .good) }
        if model.status?.channel(.linkedin)?.auth == "expired" {
            return StateLine(text: "Sign-in expired", tone: model.modes[.linkedin] == .off ? .neutral : .attention)
        }
        return StateLine(text: "Not signed in",
                         tone: model.modes[.linkedin] == .off ? .neutral : .attention)
    }
}

extension Text {
    func footnote() -> some View {
        self.font(.callout).foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}
