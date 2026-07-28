// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "GriffinTerminal",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "GriffinTerminal",
            path: "Sources/GriffinTerminal"
        ),
        .testTarget(
            name: "GriffinTerminalTests",
            dependencies: ["GriffinTerminal"],
            path: "Tests/GriffinTerminalTests"
        )
    ]
)
