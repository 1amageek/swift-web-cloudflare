// swift-tools-version: 6.4

import PackageDescription

// WASM applications build this host with the matching Swift 6.4 snapshot
// toolchain and SDK selected by their deployment package.
let package = Package(
    name: "swift-web-cloudflare",
    platforms: [
        .macOS("26.2"),
    ],
    products: [
        .library(name: "SwiftWebCloudflareHost", targets: ["SwiftWebCloudflareHost"]),
    ],
    // Forwards to swift-web's Actors trait (default-enabled). Disable for
    // page-serving-only Workers to keep Distributed/ActorRuntime out of the
    // wasm binary; the actor invocation and WebSocket paths compile out.
    traits: [
        .default(enabledTraits: ["Actors"]),
        .trait(name: "Actors"),
    ],
    dependencies: [
        .package(
            url: "https://github.com/1amageek/swift-web.git",
            from: "0.10.0",
            traits: [.trait(name: "Actors", condition: .when(traits: ["Actors"]))]
        ),
        // The deployment template vendors runtime.mjs from this exact release.
        // Keep the Swift library and JavaScript runtime ABI on one version.
        .package(url: "https://github.com/1amageek/JavaScriptKit.git", exact: "0.57.2"),
    ],
    targets: [
        .target(
            name: "SwiftWebCloudflareHost",
            dependencies: [
                .product(name: "SwiftWebActors", package: "swift-web"),
                .product(name: "SwiftWebCore", package: "swift-web"),
                .product(name: "JavaScriptKit", package: "JavaScriptKit"),
                .product(
                    name: "JavaScriptEventLoop",
                    package: "JavaScriptKit",
                    condition: .when(platforms: [.wasi])
                ),
            ],
            swiftSettings: [
                .define("SWIFTWEB_ACTORS", .when(traits: ["Actors"])),
            ]
        ),
        .testTarget(
            name: "SwiftWebCloudflareHostTests",
            dependencies: [
                "SwiftWebCloudflareHost",
                .product(name: "SwiftWebCore", package: "swift-web"),
            ]
        ),
    ]
)
