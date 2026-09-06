// swift-tools-version: 6.4

import PackageDescription

// WASM applications build this host with the matching Swift 6.4 snapshot
// toolchain and SDK selected by their deployment package.
let usesSwiftWebPortableLogging =
    Context.environment["SWIFTWEB_HOSTED_APPLICATION"] == "1"
    || Context.environment["SWIFTWEB_CORE_ONLY"] == "1"
let discoversSwiftWebAdapter =
    Context.environment["SWIFTWEB_ADAPTER_DISCOVERY"] == "1"
let swiftWebTraits: Set<Package.Dependency.Trait> = [
    .trait(name: "Actors", condition: .when(traits: ["Actors"]))
]
let swiftWebDependency: Package.Dependency
if let swiftWebRoot = Context.environment["SWIFT_WEB_ROOT"] {
    swiftWebDependency = .package(path: swiftWebRoot, traits: swiftWebTraits)
} else {
    swiftWebDependency = .package(
        url: "https://github.com/1amageek/swift-web.git",
        revision: "78871b0dfe35169029ce7ba5cff7b632406d5a1c",
        traits: swiftWebTraits
    )
}

let package = Package(
    name: "swift-web-cloudflare",
    platforms: [
        .macOS("26.2"),
    ],
    products: discoversSwiftWebAdapter ? [
        .library(
            name: "SwiftWebCloudflareAdapterDiscovery",
            targets: ["SwiftWebCloudflareAdapterDiscovery"]
        ),
    ] : [
        .library(name: "SwiftWebCloudflareHost", targets: ["SwiftWebCloudflareHost"]),
        .library(
            name: "SwiftWebCloudflareActorHost",
            targets: ["SwiftWebCloudflareActorHost"]
        ),
    ],
    // Forwards to swift-web's Actors trait (default-enabled). Disable for
    // page-serving-only Workers to keep Distributed/ActorRuntime out of the
    // wasm binary; the actor invocation and WebSocket paths compile out.
    traits: [
        .default(enabledTraits: ["Actors"]),
        .trait(name: "Actors"),
    ],
    dependencies: discoversSwiftWebAdapter ? [] : [
        swiftWebDependency,
        // The deployment template vendors runtime.mjs from this exact release.
        // Keep the Swift library and JavaScript runtime ABI on one version.
        .package(url: "https://github.com/1amageek/JavaScriptKit.git", exact: "0.57.2"),
    ],
    targets: discoversSwiftWebAdapter ? [
        .target(name: "SwiftWebCloudflareAdapterDiscovery"),
    ] : [
        .target(
            name: "SwiftWebCloudflareActorHost",
            dependencies: [
                .product(name: "SwiftWebActors", package: "swift-web"),
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
        .target(
            name: "SwiftWebCloudflareHost",
            dependencies: [
                "SwiftWebCloudflareActorHost",
                .product(name: "SwiftWebActors", package: "swift-web"),
                .product(name: "SwiftWebCore", package: "swift-web"),
                .product(name: "JavaScriptKit", package: "JavaScriptKit"),
                .product(
                    name: "JavaScriptEventLoop",
                    package: "JavaScriptKit",
                    condition: .when(platforms: [.wasi])
                ),
            ],
            exclude: ["DESIGN.md"],
            swiftSettings: [
                .define("SWIFTWEB_ACTORS", .when(traits: ["Actors"])),
            ] + (usesSwiftWebPortableLogging
                ? [.define("SWIFTWEB_PORTABLE_LOGGING")]
                : [])
        ),
        .testTarget(
            name: "SwiftWebCloudflareHostTests",
            dependencies: [
                "SwiftWebCloudflareActorHost",
                "SwiftWebCloudflareHost",
                .product(name: "SwiftWebCore", package: "swift-web"),
            ]
        ),
    ]
)
