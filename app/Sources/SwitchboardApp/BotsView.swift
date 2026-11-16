import SwiftUI

struct BotsView: View {
    @Environment(AppModel.self) private var model
    @State private var justCopied = false
    @State private var showBlock = false

    var body: some View {
        Form {
            Section {
                SettingRow(symbol: "sparkles", tint: .orange, title: "Claude", state: desktopLine) {
                    switch model.claudeDesktop {
                    case "registered", "updated": EmptyView()
                    case "not_installed": Button("Check Again") { model.registerClaudeCode() }
                    default: Button("Connect") { model.registerClaudeCode() }
                    }
                }
                .disabled(model.registeringClaude)
            } footer: {
                Text("Switchboard adds itself to the Claude app's local tools. Quit and reopen Claude to pick it up.")
                    .footnote()
            }

            Section {
                SettingRow(symbol: "chevron.left.forwardslash.chevron.right", tint: .brown, title: "Claude Code",
                           state: claudeLine) {
                    switch model.claudeCode {
                    case "registered": EmptyView()
                    case "not_installed": Button("Check Again") { model.registerClaudeCode() }
                    default: Button("Connect") { model.registerClaudeCode() }
                    }
                }
                .disabled(model.registeringClaude)
            } footer: {
                Text("Switchboard adds itself to Claude Code's tools for your user account. Reopen Claude Code to pick it up.")
                    .footnote()
            }

            Section {
                SettingRow(symbol: "bubble.left.and.text.bubble.right.fill", tint: .purple, title: "OpenMausBot",
                           state: StateLine(text: justCopied ? "Copied to the clipboard" : "Paste this setup block into OpenMausBot",
                                            tone: justCopied ? .good : .neutral)) {
                    Button("Copy Setup Block") {
                        model.copySetupBlock()
                        justCopied = true
                        Task { try? await Task.sleep(nanoseconds: 2_500_000_000); justCopied = false }
                    }
                }
                DisclosureGroup("Show Setup Block", isExpanded: $showBlock) {
                    Text(model.setupBlock)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("Setup block")
                }
            } footer: {
                Text("To let only some of your bots use Switchboard, choose them in OpenMausBot under Tools → Access → MCP servers.")
                    .footnote()
            }
        }
        .formStyle(.grouped)
    }

    private var desktopLine: StateLine {
        if model.registeringClaude { return StateLine(text: "Connecting…", tone: .busy) }
        switch model.claudeDesktop {
        case "registered": return StateLine(text: "Connected", tone: .good)
        case "updated": return StateLine(text: "Added. Quit and reopen Claude to finish", tone: .attention)
        case "not_installed": return StateLine(text: "The Claude app isn't installed on this Mac")
        case "failed": return StateLine(text: "Couldn't read Claude's settings file", tone: .attention)
        default: return StateLine(text: "Checking…", tone: .busy)
        }
    }

    private var claudeLine: StateLine {
        if model.registeringClaude { return StateLine(text: "Connecting…", tone: .busy) }
        switch model.claudeCode {
        case "registered": return StateLine(text: "Connected", tone: .good)
        case "not_installed": return StateLine(text: "Claude Code isn't installed on this Mac")
        case "failed": return StateLine(text: "Couldn't connect", tone: .attention)
        default: return StateLine(text: "Checking…", tone: .busy)
        }
    }
}
