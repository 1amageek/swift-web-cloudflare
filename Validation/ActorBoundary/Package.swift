// swift-tools-version: 6.4
import PackageDescription

let embedded = Context.environment["JAVASCRIPTKIT_EXPERIMENTAL_EMBEDDED_WASM"] == "1"
let package = Package(
    name: "ActorBoundaryValidation",
    platforms: [.macOS("26.2")],
    dependencies: [
        .package(path: "../..", traits: embedded ? [] : ["Actors"]),
        .package(url: "https://github.com/1amageek/swift-web.git", exact: "0.13.0", traits: embedded ? [] : ["Actors"]),
        .package(url: "https://github.com/1amageek/JavaScriptKit.git", exact: "0.57.3"),
    ],
    targets: [
        .executableTarget(
            name: "ActorBoundaryValidation",
            dependencies: [
                .product(name: "SwiftWebCloudflareHost", package: "swift-web-cloudflare"),
                .product(name: "SwiftWebCloudflareActorHost", package: "swift-web-cloudflare"),
                .product(name: "SwiftWebActors", package: "swift-web"),
                .product(name: "SwiftWebCore", package: "swift-web"),
                .product(name: "JavaScriptKit", package: "JavaScriptKit"),
                .product(name: "JavaScriptEventLoop", package: "JavaScriptKit"),
            ],
            linkerSettings: [
                .linkedLibrary("swiftUnicodeDataTables", .when(platforms: [.wasi])),
                .unsafeFlags([
                "-Xclang-linker", "-mexec-model=reactor",
                "-Xlinker", "-z", "-Xlinker", "stack-size=8388608",
                ], .when(platforms: [.wasi]))
            ]
        ),
    ]
)
