// swift-tools-version: 6.4
import PackageDescription

guard let revision = Context.environment["SWIFT_WEB_REVISION"],
      revision.count == 40,
      revision.allSatisfy({ "0123456789abcdef".contains($0) }),
      let unicodeArchive = Context.environment["ACTOR_CLOCK_UNICODE_ARCHIVE"] else {
    fatalError("Set SWIFT_WEB_REVISION to the reviewed commit and ACTOR_CLOCK_UNICODE_ARCHIVE to the matching SDK archive")
}

let package = Package(
    name: "ClockValidation",
    dependencies: [
        .package(url: "https://github.com/1amageek/swift-web.git", revision: revision, traits: []),
        .package(url: "https://github.com/1amageek/JavaScriptKit.git", exact: "0.57.2"),
    ],
    targets: [
        .executableTarget(
            name: "ClockValidation",
            dependencies: [
                .product(name: "SwiftWebActors", package: "swift-web"),
                .product(name: "JavaScriptKit", package: "JavaScriptKit"),
                .product(name: "JavaScriptEventLoop", package: "JavaScriptKit"),
            ],
            linkerSettings: [.unsafeFlags([
                "-Xclang-linker", "-mexec-model=reactor", "-Xlinker", unicodeArchive,
            ], .when(platforms: [.wasi]))]
        ),
    ]
)
