import SwiftUI

/// The rounded-square icon tile System Settings uses for its panes and rows.
struct IconTile: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 22

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
            .fill(color.gradient)
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: symbol)
                    .font(.system(size: size * 0.52, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }
}

extension Channel {
    var symbol: String {
        switch self {
        case .linkedin: "briefcase.fill"
        case .imessage: "message.fill"
        case .whatsapp: "phone.bubble.fill"
        }
    }

    var tint: Color {
        switch self {
        case .linkedin: Color(red: 0.04, green: 0.40, blue: 0.76)
        case .imessage: Color(red: 0.20, green: 0.78, blue: 0.35)
        case .whatsapp: Color(red: 0.07, green: 0.55, blue: 0.49)
        }
    }
}

extension Page {
    var title: String {
        switch self {
        case .getStarted: "Get Started"
        case .channels: "Channels"
        case .setup: "Setup"
        case .bots: "Connect Your Bots"
        }
    }

    var symbol: String {
        switch self {
        case .getStarted: "hand.wave.fill"
        case .channels: "switch.2"
        case .setup: "gearshape.fill"
        case .bots: "point.3.connected.trianglepath.dotted"
        }
    }

    var tint: Color {
        switch self {
        case .getStarted: .teal
        case .channels: .blue
        case .setup: .gray
        case .bots: .indigo
        }
    }
}

/// A small state line: a symbol and a sentence, coloured only when something needs doing.
struct StateLine: View {
    enum Tone { case neutral, good, attention, busy, unavailable }
    let text: String
    var tone: Tone = .neutral

    func tone(_ t: Tone) -> StateLine { StateLine(text: text, tone: t) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            switch tone {
            case .busy:
                ProgressView().controlSize(.mini)
            case .good:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .attention:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            case .unavailable:
                Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
            case .neutral:
                EmptyView()
            }
            Text(text)
                .foregroundStyle(tone == .attention ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
    }
}

/// A Form row: leading tile, title and state, trailing control.
struct SettingRow<Trailing: View, Below: View>: View {
    let symbol: String
    let tint: Color
    let title: String
    let state: StateLine
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var below: () -> Below

    init(symbol: String, tint: Color, title: String, state: StateLine,
         @ViewBuilder trailing: @escaping () -> Trailing,
         @ViewBuilder below: @escaping () -> Below = { EmptyView() }) {
        self.symbol = symbol
        self.tint = tint
        self.title = title
        self.state = state
        self.trailing = trailing
        self.below = below
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            IconTile(symbol: symbol, color: tint, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                state
                below()
            }
            .layoutPriority(1)
            Spacer(minLength: 12)
            trailing()
        }
        .padding(.vertical, 3)
    }
}

extension ChannelHealth {
    var stateLine: StateLine {
        switch self {
        case .off: StateLine(text: "Not shared with bots")
        case .starting: StateLine(text: "Reading for the first time…", tone: .busy)
        case .paused: StateLine(text: "Paused: service not running", tone: .attention)
        case let .ok(at, n):
            StateLine(text: "Synced \(Self.relative(at))" + (n > 0 ? " · \(n.formatted()) new" : ""),
                      tone: .good)
        case .needsFullDiskAccess: StateLine(text: "Needs Full Disk Access", tone: .attention)
        case let .notSignedIn(expired):
            StateLine(text: expired ? "LinkedIn sign-in expired" : "Not signed in to LinkedIn", tone: .attention)
        case let .unavailable(why): StateLine(text: why, tone: .unavailable)
        case .problem: StateLine(text: "The last sync didn't finish", tone: .attention)
        }
    }

    static func relative(_ date: Date) -> String {
        if Date().timeIntervalSince(date) < 60 { return "just now" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }
}
