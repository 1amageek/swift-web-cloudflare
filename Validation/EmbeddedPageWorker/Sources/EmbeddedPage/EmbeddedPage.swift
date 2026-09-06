import SwiftWeb
import SwiftWebActors
#if !hasFeature(Embedded)
import ActorSystemCore
import HTTPTypes
@_spi(Hosting) import SwiftWebActors
#endif

public struct EmbeddedPage: App, Sendable {
    public init() {}

    #if !hasFeature(Embedded)
    public var security: SecurityConfiguration {
        var configuration = SecurityConfiguration.defaults
        configuration.actors = .allowAll
        return configuration
    }
    #endif

    public var body: some Scene {
        ProbePage()
            .actor(ProbeActor.self, identity: "primary")
            .actor(ProbeActor.self, identity: "observer")

        #if !hasFeature(Embedded)
        Endpoint("/health", contentType: "text/plain") { _ in "ready" }
        Endpoint("/shutdown", method: .post, security: .external) { _ in
            try await actorSystem.shutdown()
            return Response(status: .ok, body: .init(string: "stopped"))
        }
        ActorGroup(scope: .addressed(authorization: .allowAll)) { ProbeActor(actorSystem: $0) }
        Endpoint("/frame", method: .post, security: .external) { request in
            guard let peer = request.headers[HTTPField.Name("X-SwiftWeb-Actor-Peer-ID")!],
                  let identity = request.headers[HTTPField.Name("X-SwiftWeb-Hosted-Actor-Identity")!],
                  !peer.isEmpty, !identity.isEmpty,
                  let body = try await request.collectedBody(), !body.isEmpty else {
                throw Abort(.badRequest, reason: "The local Durable Object proxy context is required")
            }
            let result = try await actorSystem.invokeActorFrame(
                ActorByteBuffer(body),
                context: SwiftWebActorInvocationContext(peerID: peer, hostedActorIdentity: identity)
            )
            guard let result else { return Response(status: .noContent) }
            var headers = HTTPFields()
            headers[.contentType] = "application/vnd.swift-actor-frame"
            return Response(status: .ok, headers: headers, body: .init(bytes: result.bytes))
        }
        #endif
    }
}
