import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(selection: $model.selection) {
                ForEach(pages) { page in
                    NavigationLink(value: page) {
                        HStack(spacing: 8) {
                            IconTile(symbol: page.symbol, color: page.tint, size: 20)
                            Text(page.title)
                            Spacer(minLength: 4)
                            if model.pageNeedsAttention(page) {
                                Circle().fill(.orange).frame(width: 7, height: 7)
                                    .accessibilityLabel("Needs attention")
                            }
                        }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 215, ideal: 215, max: 260)
        } detail: {
            Group {
                switch model.selection ?? .channels {
                case .getStarted: GetStartedView()
                case .channels: ChannelsView()
                case .setup: SetupView()
                case .bots: BotsView()
                }
            }
            .navigationTitle((model.selection ?? .channels).title)
            .background(WindowTitle(title: (model.selection ?? .channels).title))
        }
        .frame(minWidth: 800, minHeight: 480)
        .alert(item: $model.alert) { a in
            Alert(title: Text(a.title), message: Text(a.message))
        }
    }

    private var pages: [Page] {
        (model.showGuide ? [.getStarted] : []) + [.channels, .setup, .bots]
    }
}

/// `switchboard doctor`, shown as is. Its output holds counts and checks, never message text.
struct DiagnosticsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var output: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Diagnostics").font(.headline)
            Group {
                if let output {
                    ScrollView {
                        Text(output)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                    }
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Checking every part of Switchboard…").foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(width: 560, height: 320)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            HStack {
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(output ?? "", forType: .string)
                }
                .disabled(output == nil)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .task {
            do { output = try await Switchboard.doctor() } catch { output = error.localizedDescription }
        }
    }
}

/// The hosting window's title follows the selected page, as in System Settings.
struct WindowTitle: NSViewRepresentable {
    let title: String
    func makeNSView(context _: Context) -> NSView { NSView() }
    func updateNSView(_ v: NSView, context _: Context) {
        DispatchQueue.main.async { v.window?.title = title }
    }
}
