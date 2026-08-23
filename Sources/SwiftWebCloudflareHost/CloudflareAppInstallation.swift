#if !SWIFTWEB_PORTABLE_LOGGING
import Logging
#endif
import SwiftWebActors
@_spi(Hosting) import SwiftWebCore

/// A rendered SwiftWeb app bound to one Cloudflare WASM runtime.
final class CloudflareAppInstallation: Sendable {
    let runtimeID: Int
    private let pageServer: CloudflarePageServer

    #if SWIFTWEB_ACTORS
    private let actorSystem: WebActorSystem
    #endif

    #if SWIFTWEB_ACTORS
    init(
        runtimeID: Int,
        renderedApp: RenderedApp,
        sessionStorage: CloudflareSessionStorage,
        logger: Logger,
        actorSystem: WebActorSystem
    ) {
        self.runtimeID = runtimeID
        self.pageServer = CloudflarePageServer(
            renderedApp: renderedApp,
            sessionStorage: sessionStorage,
            logger: logger
        )
        self.actorSystem = actorSystem
    }
    #else
    init(
        runtimeID: Int,
        renderedApp: RenderedApp,
        sessionStorage: CloudflareSessionStorage,
        logger: Logger
    ) {
        self.runtimeID = runtimeID
        self.pageServer = CloudflarePageServer(
            renderedApp: renderedApp,
            sessionStorage: sessionStorage,
            logger: logger
        )
    }
    #endif

    func respond(to request: CloudflarePageRequest) async -> CloudflarePageResponse {
        await pageServer.respond(to: request)
    }

    #if SWIFTWEB_ACTORS
    func invokeActorFrame(
        _ encodedFrame: [UInt8],
        context: SwiftWebActorInvocationContext
    ) async throws -> [UInt8]? {
        try await actorSystem.invokeActorFrame(
            encodedFrame,
            context: context
        )
    }
    #endif
}
