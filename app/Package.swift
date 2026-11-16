// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SwitchboardApp",
    platforms: [.macOS(.v14)],
    products: [
        // The executable is `Switchboard`; the bundle puts it at Contents/MacOS/Switchboard.
        .executable(name: "Switchboard", targets: ["SwitchboardApp"])
    ],
    targets: [
        .executableTarget(
            name: "SwitchboardApp",
            path: "Sources/SwitchboardApp",
            swiftSettings: [.swiftLanguageMode(.v6)]
        )
    ]
)
