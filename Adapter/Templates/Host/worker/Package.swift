// swift-tools-version: 6.4

import PackageDescription

// Build with the pinned Swift 6.4 toolchain and matching SDK in build.sh.
let package = Package(
    name: "{{application.kebabName}}-cloudflare-worker",
    platforms: [
        .macOS("26.2"),
    ],
    dependencies: [
        .package(path: "{{project.root}}"),
        .package(
            {{adapter.swift-web-cloudflare.swiftPackageRequirement}}{{cloudflare.adapterTraits}}
        ),
    ],
    targets: [
        .executableTarget(
            name: "AppWorkerLauncher",
            dependencies: [
                .product(
                    name: "{{application.product}}",
                    package: "{{application.packageIdentity}}"
                ),
                .product(name: "SwiftWebCloudflareHost", package: "swift-web-cloudflare"),
{{actors.swiftProductDependencies}}
            ],
            linkerSettings: [
                .linkedLibrary("swiftUnicodeDataTables", .when(platforms: [.wasi])),
                .unsafeFlags([
                    "-Xlinker", "-z", "-Xlinker", "stack-size=16777216",
                ]),
            ]
        ),
    ]
)
