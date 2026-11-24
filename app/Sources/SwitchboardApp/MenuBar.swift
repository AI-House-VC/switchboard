import AppKit
import SwiftUI

/// Switchboard's glyph: three jacks patched into one. A template image, so the menu bar tints it.
/// Needing attention adds a dot, cut out from the cords, top right.
enum MenuIcon {
    static func image(attention: Bool, size: CGFloat = 18) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let s = size / 18
            ctx.scaleBy(x: s, y: s)
            NSColor.black.setStroke()
            NSColor.black.setFill()
            let right = CGPoint(x: 14.6, y: 9)
            for y in [3.6, 9.0, 14.4] {
                let left = CGPoint(x: 3.2, y: y)
                let cord = NSBezierPath()
                cord.move(to: left)
                cord.curve(to: right, controlPoint1: CGPoint(x: 9.5, y: y), controlPoint2: CGPoint(x: 8.5, y: 9))
                cord.lineWidth = 1.35
                cord.lineCapStyle = .round
                cord.stroke()
                NSBezierPath(ovalIn: CGRect(x: left.x - 1.9, y: y - 1.9, width: 3.8, height: 3.8)).fill()
            }
            NSBezierPath(ovalIn: CGRect(x: right.x - 2.6, y: right.y - 2.6, width: 5.2, height: 5.2)).fill()
            if attention {
                ctx.setBlendMode(.clear)
                NSBezierPath(ovalIn: CGRect(x: 11.2, y: 11.2, width: 7.6, height: 7.6)).fill()
                ctx.setBlendMode(.normal)
                NSBezierPath(ovalIn: CGRect(x: 12.6, y: 12.6, width: 4.8, height: 4.8)).fill()
            }
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = attention ? "Switchboard needs attention" : "Switchboard"
        return img
    }
}

struct MenuBarLabel: View {
    let model: AppModel
    var body: some View {
        Image(nsImage: MenuIcon.image(attention: model.overall == .attention))
    }
}

struct MenuContent: View {
    let model: AppModel
    let openWindow: () -> Void

    var body: some View {
        Text(headline)
        Divider()
        ForEach(Channel.allCases) { c in
            Text(line(c))
        }
        Divider()
        Button("Open Switchboard…", action: openWindow)
            .keyboardShortcut(",")
        Divider()
        // The menu is still closing when this action runs; ask on the next turn of the run loop.
        Button("Quit Switchboard…") { Task { @MainActor in Self.confirmQuit() } }
            .keyboardShortcut("q")
    }

    /// Quitting stops the service too, so it asks first.
    /// A menu-bar-only app isn't always made active (macOS 14 activation is a request), and an alert behind other
    /// apps' windows looked like Quit doing nothing (2026-11-23). Float the alert so it's always seen.
    static func confirmQuit() {
        NSApp.activate()
        let a = NSAlert()
        a.messageText = "Quit Switchboard?"
        a.informativeText = "Bots lose access to your messages until you open Switchboard again."
        a.addButton(withTitle: "Quit")
        a.addButton(withTitle: "Cancel")
        a.window.level = .floating
        if a.runModal() == .alertFirstButtonReturn { NSApp.terminate(nil) }
    }

    private var headline: String {
        switch model.overall {
        case .notSetUp: "Switchboard isn't set up yet"
        case .good: "Switchboard is working"
        case .attention:
            model.serviceState == .stopped ? "Background service isn't running" : "Switchboard needs attention"
        }
    }

    private func line(_ c: Channel) -> String {
        let mode = model.modes[c] ?? .off
        let h = model.health(c)
        let suffix: String = switch h {
        case .needsFullDiskAccess: " · needs Full Disk Access"
        case .notSignedIn: " · not signed in"
        case .problem: " · sync problem"
        case .paused: " · paused"
        case .unavailable: " · not on this Mac"
        default: ""
        }
        return "\(c.name): \(mode.label)\(suffix)"
    }
}
