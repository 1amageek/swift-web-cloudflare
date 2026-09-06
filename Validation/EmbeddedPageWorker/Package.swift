// swift-tools-version: 6.4
import PackageDescription

let embedded = Context.environment["JAVASCRIPTKIT_EXPERIMENTAL_EMBEDDED_WASM"] == "1"
let buildsNativePeer = Context.environment["SWIFT_WEB_BUILD_NATIVE_PEER"] == "1"
let package = Package(
    name: "EmbeddedPage",
    platforms: [.macOS("26.2")],
    products: [.library(name: "EmbeddedPage", targets: ["EmbeddedPage"])]
        + (buildsNativePeer ? [.executable(name: "NativePeer", targets: ["NativePeer"])] : []),
    dependencies: [
        .package(url: "https://github.com/1amageek/swift-web.git", revision: "3408c74f35143539fa4b79c0785dad72dbb795a1", traits: embedded ? [] : ["Actors"]),
        .package(url: "https://github.com/1amageek/swift-web-cloudflare.git", revision: "6f9d70353e65d01e1cad2dcc8a8e6b783d243844", traits: []),
        .package(url: "https://github.com/1amageek/swift-actor-system.git", revision: "cdbca08b3a08d3cd5620ae16b5c33c372aff1ad3"),
        .package(url: "https://github.com/1amageek/swift-html.git", revision: "573aba6454604780c07ad8a7aabd0e153423fe4b"),
        .package(path: "ServiceAdapter"),
    ],
    targets: [
        .target(
            name: "EmbeddedPage",
            dependencies: [
                .product(name: "SwiftWeb", package: "swift-web"),
                .product(name: "SwiftWebActors", package: "swift-web"),
                .product(name: "SwiftHTML", package: "swift-html"),
                .product(name: "ActorSystemCore", package: "swift-actor-system"),
                .product(name: embedded ? "ActorSystemEmbedded" : "ActorSystemDistributed", package: "swift-actor-system"),
            ],
            path: embedded ? ".generated/embedded/Sources/EmbeddedPage" : "Sources/EmbeddedPage",
            swiftSettings: [.enableUpcomingFeature("ApproachableConcurrency")]
        ),
    ] + (buildsNativePeer ? [
        .executableTarget(name: "NativePeer", dependencies: [
            "EmbeddedPage",
            .product(name: "SwiftWebActors", package: "swift-web"),
            .product(name: "SwiftWebHTTPServerHost", package: "swift-web"),
        ], path: ".generated/native")
    ] : []),
    swiftLanguageModes: [.v6]
)
