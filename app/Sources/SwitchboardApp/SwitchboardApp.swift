import AppKit
import SwiftUI

@main
struct SwitchboardMain: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: delegate.model) { delegate.showWindow() }
        } label: {
            MenuBarLabel(model: delegate.model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = AppModel()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_: Notification) {
        // LSUIElement in the bundle; set here too so `swift run` behaves the same.
        NSApp.setActivationPolicy(.accessory)
        model.start()
        // The window opens on first launch (the guide is still showing), or when something needs fixing.
        if model.showGuide || ProcessInfo.processInfo.environment["SWITCHBOARD_OPEN_WINDOW"] != nil {
            showWindow()
        }
        Snapshot.scheduleIfRequested(delegate: self)
    }

    /// Reopening the app from Finder while it runs shows the window.
    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows _: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_: Notification) {
        model.stopService()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }

    func showWindow() {
        if window == nil {
            let host = NSHostingController(rootView: RootView().environment(model))
            host.sceneBridgingOptions = [.toolbars, .title]
            let w = NSWindow(contentViewController: host)
            w.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
            w.toolbarStyle = .unified
            w.toolbar = NSToolbar(identifier: "main")
            w.setContentSize(NSSize(width: 860, height: 560))
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName("SwitchboardSettings")
            if w.frameAutosaveName.isEmpty || !w.setFrameUsingName("SwitchboardSettings") { w.center() }
            window = w
        }
        model.windowVisible = true
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowWillClose(_: Notification) {
        model.windowVisible = false
    }

    var settingsWindow: NSWindow? { window }
}
