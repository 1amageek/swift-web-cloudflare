#if canImport(FoundationEssentials)
import FoundationEssentials
#elseif canImport(Foundation)
import Foundation
#endif
#if canImport(Logging)
import Logging
#endif
import XCTest

@_spi(Hosting) import SwiftWebCore
@testable import SwiftWebCloudflareHost

final class CloudflarePageServerTests: XCTestCase {
    func testWorkerBuildTemplateDoesNotInjectSwiftWebRoot() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let buildScript = packageRoot
            .appendingPathComponent("Adapter/Templates/Host/worker/build.sh")
        let source = try String(contentsOf: buildScript, encoding: .utf8)

        XCTAssertFalse(source.contains("SWIFT_WEB_ROOT"))
    }

    func testServesRoutesFromRenderedApp() async throws {
        let renderedApp = try await AppRenderer.render(
            CloudflareFixtureApp(),
            in: AppRenderingContext()
        )
        let server = CloudflarePageServer(
            renderedApp: renderedApp,
            sessionStorage: CloudflareSessionStorage(),
            logger: Logger(label: "swiftweb.cloudflare.tests")
        )

        let response = await server.respond(
            to: CloudflarePageRequest(
                runtimeID: 1,
                callID: "request-1",
                method: "GET",
                path: "/health",
                search: nil,
                scheme: "https",
                host: "cloudflare.test",
                headers: [],
                bodyBase64: nil
            )
        )

        XCTAssertEqual(response.status, 200)
        let bytes = try XCTUnwrap(Base64Coding.decode(response.bodyBase64))
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "cloudflare")
        let headers = CloudflarePageWire.decodeHeaders(response.headersWire)
        XCTAssertTrue(
            headers.contains { header in
                header.name.lowercased() == "x-content-type-options" &&
                    header.value == "nosniff"
            }
        )
    }
}

private struct CloudflareFixtureApp: App {
    var body: some Scene {
        Endpoint("/health") { _ in
            Response(body: .init(string: "cloudflare"))
        }
    }
}
