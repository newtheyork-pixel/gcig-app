// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "GriffinTerminal",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "GriffinTerminal",
            path: "Sources/GriffinTerminal",
            // The system SQLite, for reading the phone's own call
            // record. A system library, not a package: the no-third-party
            // rule is about what we ship, and libsqlite3 is already on
            // every Mac this runs on.
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .testTarget(
            name: "GriffinTerminalTests",
            dependencies: ["GriffinTerminal"],
            path: "Tests/GriffinTerminalTests"
        )
    ]
)
