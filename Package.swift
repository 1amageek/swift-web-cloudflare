// swift-tools-version: 6.3

import PackageDescription

// WASM builds resolve swift-web with SWIFTWEB_CORE_ONLY=1 (the 6.3.1 wasm
// toolchain cannot resolve swift-web's full manifest, and core-only keeps
// macros/swift-syntax out of the wasm graph):
//   SWIFTWEB_CORE_ONLY=1 swift build --swift-sdk swift-6.3.1-RELEASE_wasm -c release \
//     -Xswiftc -Osize -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
let package = Package(
    name: "swift-web-cloudflare",
    platforms: [
        .macOS("26.2"),
    ],
    products: [
        .library(name: "SwiftWebCloudflareHost", targets: ["SwiftWebCloudflareHost"]),
        .executable(name: "swiftweb-cloudflare", targets: ["swiftweb-cloudflare"]),
    ],
    dependencies: [
        // swift-web 0.3.0 carries the edge authorization seam, @ActorStorage
        // persistence, and the SwiftWebHost rename this adapter depends on.
        .package(url: "https://github.com/1amageek/swift-web.git", from: "0.3.0"),
        .package(url: "https://github.com/1amageek/JavaScriptKit.git", from: "0.57.0"),
    ],
    targets: [
        .executableTarget(
            name: "swiftweb-cloudflare",
            resources: [
                .copy("Templates"),
            ]
        ),
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
            ]
        ),
    ]
)
