import SwiftUI

/// First run: every channel starts Off. A short welcome and the four steps, each with its own button.
struct GetStartedView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            Section {
                HStack(alignment: .center, spacing: 16) {
                    Image(nsImage: MenuIcon.image(attention: false, size: 44))
                        .renderingMode(.template)
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(Color.accentColor.gradient,
                                    in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Welcome to Switchboard")
                            .font(.title2.weight(.semibold))
                        Text("Let your AI assistants (bots, for short) read the LinkedIn, Messages and WhatsApp conversations you choose. Everything stays on this Mac, and nothing is sent without your approval.")
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 6)
            }

            Section("Set up Switchboard") {
                Step(number: 1, title: "Allow Full Disk Access",
                     detail: "Lets Switchboard read Messages and WhatsApp on this Mac.",
                     done: model.fullDiskAccess == true) {
                    Button("Open Privacy Settings…") { model.openFullDiskAccess() }
                }
                Step(number: 2, title: "Choose your channels",
                     detail: "Everything starts off. Pick what bots can read, and whether they can ask to send.",
                     done: model.anyChannelOn) {
                    Button("Choose Channels…") { model.selection = .channels }
                }
                if model.modes[.linkedin] != .off {
                    Step(number: 3, title: "Sign in to LinkedIn",
                         detail: model.signingIn ? "Finish signing in in your browser…"
                             : "Sign-in happens in your browser. Switchboard never sees your password.",
                         done: model.linkedInSignedIn) {
                        if model.signingIn {
                            Button("Cancel") { model.cancelSignIn() }
                        } else {
                            Button("Sign In…") { model.signInToLinkedIn() }
                        }
                    }
                }
                Step(number: model.modes[.linkedin] != .off ? 4 : 3, title: "Connect your bots",
                     detail: "Add Switchboard to Claude, Claude Code or OpenMausBot.",
                     done: model.botsConnected) {
                    Button("Connect Bots…") { model.selection = .bots }
                }
            }

            Section {
                HStack {
                    Text(allDone ? "You're all set. You can change any of this later." : "Everything here is also in Channels, Setup and Connect Your Bots.")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(allDone ? "Done" : "Finish Later") { model.guideDismissed = true }
                        .keyboardShortcut(allDone ? .defaultAction : nil)
                }
            }
        }
        .formStyle(.grouped)
    }

    private var allDone: Bool {
        model.anyChannelOn && model.botsConnected
            && (model.modes[.linkedin] == .off || model.linkedInSignedIn)
            && (model.fullDiskAccess == true || (model.modes[.imessage] == .off && model.modes[.whatsapp] == .off))
    }
}

private struct Step<Action: View>: View {
    let number: Int
    let title: String
    let detail: String
    let done: Bool
    @ViewBuilder var action: () -> Action

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                Circle()
                    .fill(done ? AnyShapeStyle(Color.green) : AnyShapeStyle(.quaternary))
                    .frame(width: 24, height: 24)
                if done {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                } else {
                    Text("\(number)").font(.callout.weight(.semibold).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .accessibilityLabel(done ? "Step \(number), done" : "Step \(number)")
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(done ? .secondary : .primary)
                Text(detail).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            if !done { action() }
        }
        .padding(.vertical, 3)
        .animation(.easeOut(duration: 0.2), value: done)
    }
}
