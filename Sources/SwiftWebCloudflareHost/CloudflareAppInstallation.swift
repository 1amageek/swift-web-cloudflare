#if SWIFTWEB_ACTORS
@preconcurrency import ActorRuntime
#if canImport(FoundationEssentials)
import FoundationEssentials
#elseif canImport(Foundation)
import Foundation
#endif
#endif
#if canImport(Logging)
import Logging
#endif
import SwiftWebActors
@_spi(Hosting) import SwiftWebCore
import Synchronization

/// A rendered SwiftWeb app bound to one Cloudflare WASM runtime.
final class CloudflareAppInstallation: Sendable {
    let runtimeID: Int
    private let pageServer: CloudflarePageServer

    #if SWIFTWEB_ACTORS
    private let actorSystem: WebActorSystem
    private let actorSecurity: WebActorSecurityPolicy
    private let sessions: WebSocketSessionRouter
    private let sockets = Mutex<[Int: WebSocketActorTransport]>([:])
    #endif

    #if SWIFTWEB_ACTORS
    init(
        runtimeID: Int,
        renderedApp: RenderedApp,
        sessionStorage: CloudflareSessionStorage,
        logger: Logger,
        actorSystem: WebActorSystem,
        actorSecurity: WebActorSecurityPolicy,
        storageToken: Double?
    ) {
        self.runtimeID = runtimeID
        self.pageServer = CloudflarePageServer(
            renderedApp: renderedApp,
            sessionStorage: sessionStorage,
            logger: logger
        )
        self.actorSystem = actorSystem
        self.actorSecurity = actorSecurity
        self.sessions = WebSocketSessionRouter()
        actorSystem.setTransport(sessions)
        if let storageToken {
            actorSystem.setPersistentStore(
                DurableObjectActorStateStore(token: storageToken)
            )
        }
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
    func invokeActor(
        envelopeJSON: String,
        principal: String?
    ) async throws -> (callID: String, responseJSON: String) {
        let envelope = try JSONDecoder().decode(
            InvocationEnvelope.self,
            from: Data(envelopeJSON.utf8)
        )
        let context = WebActorInvocationContext(
            transport: .http,
            principalID: principal
        )
        let response = try await actorSystem.invoke(
            envelope: envelope,
            context: context,
            authorization: actorSecurity.authorization,
            activationPolicy: actorSecurity.activation
        )
        return (
            envelope.callID,
            String(decoding: try JSONEncoder().encode(response), as: UTF8.self)
        )
    }

    func openSocket(id: Int, principal: String?) {
        let transport = WebSocketActorTransport(
            inboundSenderPolicy: .trustClientSupplied
        ) { [runtimeID] text in
            CloudflareWorkerBridge.sendSocketFrame(
                runtimeID: runtimeID,
                socketID: id,
                frame: text
            )
        }
        transport.bind(
            actorSystem,
            context: WebActorInvocationContext(
                transport: .webSocket,
                principalID: principal
            ),
            authorization: actorSecurity.authorization,
            activationPolicy: actorSecurity.activation
        )
        transport.onInboundSender { [sessions] peerID, transport in
            sessions.register(peerID, transport: transport)
        }
        sockets.withLock { $0[id] = transport }
    }

    func receiveSocketMessage(id: Int, frame: String) {
        let transport = sockets.withLock { $0[id] }
        transport?.receive(frame)
    }

    func closeSocket(id: Int) {
        let transport = sockets.withLock { $0.removeValue(forKey: id) }
        guard let transport else {
            return
        }
        sessions.unregister(transport: transport)
        transport.closed()
    }
    #endif
}
