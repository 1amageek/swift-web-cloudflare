// swift-tools-version: 6.3

import PackageDescription

// Build with the DO toolchain (see build.sh): SWIFTWEB_DO=1 resolves
// swift-web's core chain plus macros, so app sources compile as-is.
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
