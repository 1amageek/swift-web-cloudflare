// swift-tools-version: 6.4

import PackageDescription

// Build with the pinned Swift 6.4 toolchain and matching SDK in build.sh.
let package = Package(
    name: "{{app.kebabName}}-durable-object",
    platforms: [
        .macOS("26.2"),
    ],
    dependencies: [
        .package(path: "{{app.relativePath}}"),
        .package(path: "{{swiftWebCloudflare.relativePath}}"),
    ],
    targets: [
        .executableTarget(
            name: "AppDurableObjectLauncher",
            dependencies: [
                .product(name: "{{app.name}}", package: "{{app.packageName}}"),
                .product(name: "SwiftWebCloudflareHost", package: "swift-web-cloudflare"),
            ]
        ),
    ]
)
