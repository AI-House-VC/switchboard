import AppKit

/// Development only: SWITCHBOARD_SNAPSHOT=<file.png> writes the window's window-server image, then quits.
/// Used with a stub SWITCHBOARD_BIN and a fixture status.json to review the UI. Does nothing otherwise.
enum Snapshot {
    @MainActor
    static func scheduleIfRequested(delegate: AppDelegate) {
        let env = ProcessInfo.processInfo.environment
        guard let out = env["SWITCHBOARD_SNAPSHOT"] else { return }
        if let page = env["SWITCHBOARD_PAGE"].flatMap(Page.init(rawValue:)) { delegate.model.selection = page }
        delegate.showWindow()
        // SWITCHBOARD_PENDING=<channel>:<mode> shows that change's confirmation, to review its wording.
        let pending = env["SWITCHBOARD_PENDING"]?.split(separator: ":").map(String.init)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            NSApp.activate()
            delegate.settingsWindow?.makeKeyAndOrderFront(nil)
            if let p = pending, p.count == 2, let c = Channel(rawValue: p[0]), let m = Mode(rawValue: p[1]) {
                delegate.model.request(c, m)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
            if let w = delegate.settingsWindow {
                // The real window-server image (vibrancy, active state) when screen capture is allowed;
                // otherwise the view's own drawing.
                // A pending confirmation is its own window: capture that one.
                let alert = NSApp.windows.first { $0 !== w && $0.isVisible && $0.className.contains("Alert") }
                    ?? NSApp.windows.first { $0 !== w && $0.isVisible && $0.frame.width > 100 && $0 is NSPanel }
                let id = pending != nil ? (alert?.windowNumber ?? w.windowNumber) : w.windowNumber
                let r = try? await Runner.run("/usr/sbin/screencapture", ["-x", "-o", "-l\(id)", out])
                if r?.ok != true || !FileManager.default.fileExists(atPath: out) {
                    write(pending != nil ? (alert ?? w) : w, to: out)
                }
            }
            delegate.model.stopService()
            exit(0) // terminate() waits on an open alert
        }
    }

    @MainActor
    private static func write(_ w: NSWindow, to path: String) {
        guard let view = w.contentView?.superview else { return }
        let bounds = view.bounds
        guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { return }
        view.cacheDisplay(in: bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}
