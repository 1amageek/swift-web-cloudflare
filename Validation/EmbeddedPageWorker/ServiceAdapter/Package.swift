// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "EmbeddedPageServiceAdapter",
    products: [.library(name: "EmbeddedPageServiceAdapter", targets: ["EmbeddedPageServiceAdapter"])],
    targets: [.target(name: "EmbeddedPageServiceAdapter")]
)
