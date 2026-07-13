@preconcurrency import ActorRuntime
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif
#if canImport(JavaScriptEventLoop)
import JavaScriptEventLoop
#endif
import JavaScriptKit
import SwiftWebActors
import SwiftWebCore
import Synchronization

/// The Durable Object entry point: hosts an app's `ActorGroup` actors on the
/// real `WebActorSystem`, driven by JavaScriptKit's event loop.
///
/// Edge traffic is external, so every inbound invocation is dispatched under
/// the app's `security.actors` policy — the same authorization and virtual
/// activation bound the host-neutral HTTP endpoint enforces natively. The
/// default policy denies external actor RPC unless the app installs an
/// authorizer, so a deployed app opts in explicitly.
///
/// JS protocol (all strings; JS is a no-interpretation trampoline). The wasm
/// entry module exposes exports that forward here; envelopes cross as the
/// `__swiftwebEnvelope` JS global so no JS closures or manual memory
/// management are involved:
/// - JS sets `globalThis.__swiftwebStartID` and calls the start export; Swift
///   reads it synchronously and echoes it back to `swiftwebReady(startID)`
///   (or `swiftwebFailed(startID, message)`), so concurrent Durable Object
///   cold-starts in one isolate cannot swap each other's readiness resolvers.
/// - JS sets `globalThis.__swiftwebEnvelope` and calls the invoke export; the
///   export reads it via `CloudflareActorHost.invokePendingEnvelope()`.
/// - Swift → JS `swiftwebComplete(callID, responseJSON)` per invocation,
///   `swiftwebInvokeDenied(callID, reason)` when the security policy rejects
///   it, or `swiftwebInvokeFailed(callID, message)` when dispatch threw.
public enum CloudflareActorHost {
    private struct State: Sendable {
        var system: WebActorSystem?
        var actorSecurity: WebActorSecurityPolicy = .defaults
        var executorInstalled = false
        var sockets: [Int: WebSocketActorTransport] = [:]
        var pageServer: CloudflarePageServer?
    }

    private static let state = Mutex(State())
    private static let sessions = WebSocketSessionRouter()

    public static func start<Definition: App>(_ definitionType: Definition.Type) {
        // Capture the start correlation ID synchronously, before the task
        // below suspends: a concurrent DO cold-start in the same isolate can
        // overwrite `__swiftwebStartID` while this one is lowering scenes.
        let startID = JSObject.global.__swiftwebStartID.number.map(Int.init)
        // The DO's storage token, captured now for the same reason. Identifies
        // this DO's SQLite when several DOs share one isolate.
        let storageToken = JSObject.global.__swiftwebStorageToken.number

        let installExecutor = state.withLock { state in
            let first = !state.executorInstalled
            state.executorInstalled = true
            return first
        }
        if installExecutor {
            #if canImport(JavaScriptEventLoop)
            JavaScriptEventLoop.installGlobalExecutor()
            #endif
        }

        Task {
            do {
                let definition = Definition()
                let application = CloudflareWebApplication()
                let security = definition.security
                application.securityConfiguration = security
                let system = definition.actorSystem

                // Mirror HTTPServerAppRunner.configure: middleware chain,
                // action gateway, app services, then scene lowering — so page
                // and service routes behave identically across hosts.
                var chain = WebMiddlewares()
                security.installMiddleware(on: &chain)
                ActionGateway.register(on: application)
                try await definition.services.register(on: application)
                try await _SceneRenderer.make(
                    definition.body,
                    in: .root(application, actorSystem: system)
                )
                system.setTransport(sessions)
                if let storageToken {
                    system.setPersistentStore(DurableObjectActorStateStore(token: storageToken))
                }
                let pageServer = CloudflarePageServer(
                    application: application,
                    matcher: WebRouteMatcher(routes: application.collectedRoutes),
                    chain: chain,
                    sessionStorage: CloudflareSessionStorage(),
                    logger: application.logger
                )
                state.withLock {
                    $0.system = system
                    $0.actorSecurity = definition.security.actors
                    $0.pageServer = pageServer
                }

                signalReady(startID)
            } catch {
                signalFailed(startID, message: String(describing: error))
            }
        }
    }

    // MARK: - Page serving

    /// Reads the request JS placed in `globalThis.__swiftwebRequest` and serves
    /// it through the app's collected page/service routes. Wasm entry modules
    /// forward their request export here.
    ///
    /// Completion crosses back through `swiftwebPageComplete(callID, json)`;
    /// host-level failures (undecodable request, host not started) go through
    /// `swiftwebPageFailed(callID, message)`. HTTP-level errors are proper
    /// responses with error status codes, not failures.
    public static func handlePendingRequest() {
        guard let requestJSON = JSObject.global.__swiftwebRequest.string else {
            _ = JSObject.global.swiftwebPageFailed.function?(
                JSValue.string(""),
                JSValue.string("__swiftwebRequest must be a JSON string")
            )
            return
        }
        handleRequest(requestJSON)
    }

    public static func handleRequest(_ requestJSON: String) {
        Task {
            let request: CloudflarePageRequest
            do {
                request = try JSONDecoder().decode(
                    CloudflarePageRequest.self,
                    from: Data(requestJSON.utf8)
                )
            } catch {
                _ = JSObject.global.swiftwebPageFailed.function?(
                    JSValue.string(""),
                    JSValue.string("invalid page request: \(String(describing: error))")
                )
                return
            }

            guard let server = state.withLock({ $0.pageServer }) else {
                _ = JSObject.global.swiftwebPageFailed.function?(
                    JSValue.string(request.callID),
                    JSValue.string(String(describing: CloudflareHostError.notReady))
                )
                return
            }

            let response = await server.respond(to: request)
            do {
                let responseJSON = String(
                    decoding: try JSONEncoder().encode(response),
                    as: UTF8.self
                )
                _ = JSObject.global.swiftwebPageComplete.function?(
                    JSValue.string(request.callID),
                    JSValue.string(responseJSON)
                )
            } catch {
                _ = JSObject.global.swiftwebPageFailed.function?(
                    JSValue.string(request.callID),
                    JSValue.string("failed to encode page response: \(String(describing: error))")
                )
            }
        }
    }

    /// Reads the envelope JS placed in `globalThis.__swiftwebEnvelope` and
    /// dispatches it. Wasm entry modules forward their invoke export here.
    ///
    /// The principal is read synchronously from `globalThis.__swiftwebPrincipal`
    /// — the uid the Worker verified from the caller's token, set on the
    /// trusted Worker → DO hop. It is a separate channel from the envelope so a
    /// client cannot forge it. An empty value means the request is
    /// unauthenticated.
    public static func invokePendingEnvelope() {
        guard let envelopeJSON = JSObject.global.__swiftwebEnvelope.string else {
            _ = JSObject.global.swiftwebInvokeFailed.function?(
                JSValue.string(""),
                JSValue.string("__swiftwebEnvelope must be a JSON string")
            )
            return
        }
        let principal = Self.nonEmpty(JSObject.global.__swiftwebPrincipal.string)
        invoke(envelopeJSON, principal: principal)
    }

    public static func invoke(_ envelopeJSON: String, principal: String? = nil) {
        Task {
            let (system, actorSecurity) = state.withLock { ($0.system, $0.actorSecurity) }
            let callID = Self.callID(in: envelopeJSON) ?? ""
            do {
                guard let system else {
                    throw CloudflareHostError.notReady
                }
                let envelope = try JSONDecoder().decode(
                    InvocationEnvelope.self,
                    from: Data(envelopeJSON.utf8)
                )
                // The invocation crosses the edge, so it is external: the
                // security policy decides whether it runs and how many virtual
                // actors may activate, and the Worker-verified principal is
                // what an app authorizer matches against.
                let context = WebActorInvocationContext(transport: .http, principalID: principal)
                let response = try await system.invoke(
                    envelope: envelope,
                    context: context,
                    authorization: actorSecurity.authorization,
                    activationPolicy: actorSecurity.activation
                )
                let responseJSON = String(
                    decoding: try JSONEncoder().encode(response),
                    as: UTF8.self
                )
                _ = JSObject.global.swiftwebComplete.function?(
                    JSValue.string(envelope.callID),
                    JSValue.string(responseJSON)
                )
            } catch let error as WebActorAuthorizationError {
                _ = JSObject.global.swiftwebInvokeDenied.function?(
                    JSValue.string(callID),
                    JSValue.string(error.reason)
                )
            } catch {
                _ = JSObject.global.swiftwebInvokeFailed.function?(
                    JSValue.string(callID),
                    JSValue.string(String(describing: error))
                )
            }
        }
    }

    // MARK: - WebSocket sessions
    //
    // JS drives these through exports after placing the socket ID (and frame)
    // in the __swiftwebSocketID/__swiftwebSocketFrame globals; Swift sends
    // frames back by calling the swiftwebSocketSend(id, text) JS global.

    public static func socketOpened() {
        guard let id = JSObject.global.__swiftwebSocketID.number.map(Int.init) else {
            return
        }
        // The principal is verified by the Worker at upgrade time and bound to
        // the connection: every invocation on this socket carries it.
        let principal = Self.nonEmpty(JSObject.global.__swiftwebSocketPrincipal.string)
        let (system, actorSecurity) = state.withLock { ($0.system, $0.actorSecurity) }
        let transport = WebSocketActorTransport(
            // The client's observer ID is a push return address, not a
            // principal. Trust-on-supply keeps agent → client push working;
            // authorization uses the connection-bound principal above, not this.
            inboundSenderPolicy: .trustClientSupplied
        ) { text in
            _ = JSObject.global.swiftwebSocketSend.function?(
                JSValue.number(Double(id)),
                JSValue.string(text)
            )
        }
        if let system {
            transport.bind(
                system,
                context: WebActorInvocationContext(transport: .webSocket, principalID: principal),
                authorization: actorSecurity.authorization,
                activationPolicy: actorSecurity.activation
            )
        }
        transport.onInboundSender { peerID, transport in
            sessions.register(peerID, transport: transport)
        }
        state.withLock { $0.sockets[id] = transport }
    }

    public static func socketMessage() {
        guard let id = JSObject.global.__swiftwebSocketID.number.map(Int.init),
              let frame = JSObject.global.__swiftwebSocketFrame.string else {
            return
        }
        state.withLock { $0.sockets[id] }?.receive(frame)
    }

    public static func socketClosed() {
        guard let id = JSObject.global.__swiftwebSocketID.number.map(Int.init) else {
            return
        }
        let transport = state.withLock { $0.sockets.removeValue(forKey: id) }
        guard let transport else {
            return
        }
        sessions.unregister(transport: transport)
        transport.closed()
    }

    private static func signalReady(_ startID: Int?) {
        _ = JSObject.global.swiftwebReady.function?(Self.startIDValue(startID))
    }

    private static func signalFailed(_ startID: Int?, message: String) {
        _ = JSObject.global.swiftwebFailed.function?(
            Self.startIDValue(startID),
            JSValue.string(message)
        )
    }

    private static func startIDValue(_ startID: Int?) -> JSValue {
        startID.map { JSValue.number(Double($0)) } ?? .null
    }

    /// Treats a missing or empty JS string as "no value": the Worker clears the
    /// principal globals to "" on unauthenticated requests, and those globals
    /// persist across calls, so an empty read must not leak a prior principal.
    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func callID(in envelopeJSON: String) -> String? {
        struct CallIDProbe: Decodable {
            let callID: String?
        }
        do {
            return try JSONDecoder().decode(CallIDProbe.self, from: Data(envelopeJSON.utf8)).callID
        } catch {
            return nil
        }
    }
}

enum CloudflareHostError: Error {
    case notReady
    case storageDecodeFailed(String)
}
