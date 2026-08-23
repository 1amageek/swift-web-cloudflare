#if SWIFTWEB_ACTORS
#if canImport(JavaScriptEventLoop)
import JavaScriptEventLoop
#endif
@_spi(Hosting) import SwiftWebActors
import Synchronization

/// Hosts Swift distributed actors inside an actor-only Cloudflare WASM module.
///
/// This host deliberately has no `App`, `Scene`, page router, middleware, or
/// HTML dependency. A service adapter registers its actor factories directly,
/// then Durable Object RPC submits the ordinary SwiftWeb actor frames.
public final class CloudflareActorServiceHost: Sendable {
    private enum Phase: Sendable {
        case idle
        case starting(runtimeID: Int, renderingID: Int)
        case ready(runtimeID: Int)
        case failed(runtimeID: Int)
    }

    private struct State: Sendable {
        var executorInstalled = false
        var phase = Phase.idle
    }

    private let state = Mutex(State())
    private let actorSystem: WebActorSystem
    private let authorization: SwiftWebActorAuthorization
    private let activationPolicy: WebActorActivationPolicy
    private let registerActors: @Sendable (WebActorSystem) async throws -> Void

    public init(
        actorSystem: WebActorSystem = .shared,
        authorization: SwiftWebActorAuthorization = .trustedOnly,
        // A Durable Object instance is already scoped to one actor identity.
        // Cloudflare owns instance eviction, so an additional Swift idle timer
        // would extend the isolate lifetime without providing passivation.
        activationPolicy: WebActorActivationPolicy = WebActorActivationPolicy(
            maximumVirtualActorCount: 1,
            idleTimeout: nil
        ),
        registerActors: @escaping @Sendable (WebActorSystem) async throws -> Void
    ) {
        self.actorSystem = actorSystem
        self.authorization = authorization
        self.activationPolicy = activationPolicy
        self.registerActors = registerActors
    }

    /// Starts the actor system for the current Durable Object runtime.
    public func start() {
        let identity: CloudflareActorRuntimeIdentity
        do {
            identity = try CloudflareActorBridge.runtimeIdentity()
        } catch {
            CloudflareActorBridge.startupFailed(
                runtimeID: CloudflareActorBridge.currentRuntimeID ?? -1,
                renderingID: CloudflareActorBridge.currentRenderingID ?? -1,
                message: errorText(error)
            )
            return
        }

        let reservation = state.withLock { state -> (accepted: Bool, installExecutor: Bool) in
            guard case .idle = state.phase else {
                return (false, false)
            }
            let installExecutor = !state.executorInstalled
            state.executorInstalled = true
            state.phase = .starting(
                runtimeID: identity.runtimeID,
                renderingID: identity.renderingID
            )
            return (true, installExecutor)
        }
        guard reservation.accepted else {
            CloudflareActorBridge.startupFailed(
                runtimeID: identity.runtimeID,
                renderingID: identity.renderingID,
                message: "The Cloudflare actor service has already started"
            )
            return
        }

        if reservation.installExecutor {
            #if canImport(JavaScriptEventLoop)
            JavaScriptEventLoop.installGlobalExecutor()
            #endif
        }

        Task {
            do {
                try await actorSystem.configureHosting(
                    authorization: authorization,
                    activationPolicy: activationPolicy
                )
                try await registerActors(actorSystem)
                try await actorSystem.start()
                state.withLock { state in
                    state.phase = .ready(runtimeID: identity.runtimeID)
                }
                CloudflareActorBridge.startupCompleted(identity)
            } catch {
                state.withLock { state in
                    state.phase = .failed(runtimeID: identity.runtimeID)
                }
                CloudflareActorBridge.startupFailed(
                    runtimeID: identity.runtimeID,
                    renderingID: identity.renderingID,
                    message: errorText(error)
                )
            }
        }
    }

    /// Invokes the actor frame currently presented by the Durable Object bridge.
    public func invokeActorFrame() {
        let input: CloudflareActorFrameInput
        do {
            input = try CloudflareActorBridge.actorFrameInput()
        } catch {
            CloudflareActorBridge.actorFrameFailed(
                runtimeID: CloudflareActorBridge.currentRuntimeID ?? -1,
                callID: CloudflareActorBridge.currentActorFrameCallID ?? "",
                message: errorText(error)
            )
            return
        }

        guard isReady(runtimeID: input.runtimeID) else {
            CloudflareActorBridge.actorFrameFailed(
                runtimeID: input.runtimeID,
                callID: input.callID,
                message: "The Cloudflare actor service is not ready"
            )
            return
        }

        Task {
            do {
                let result = try await actorSystem.invokeActorFrame(
                    input.encodedFrame,
                    context: SwiftWebActorInvocationContext(
                        principalID: input.principalID,
                        sessionID: input.sessionID,
                        tenantID: input.tenantID,
                        remoteAddress: input.remoteAddress,
                        peerID: input.peerID,
                        hostedActorIdentity: input.hostedActorIdentity
                    )
                )
                CloudflareActorBridge.actorFrameCompleted(
                    runtimeID: input.runtimeID,
                    callID: input.callID,
                    encodedFrame: result
                )
            } catch {
                CloudflareActorBridge.actorFrameFailed(
                    runtimeID: input.runtimeID,
                    callID: input.callID,
                    message: errorText(error)
                )
            }
        }
    }

    private func isReady(runtimeID: Int) -> Bool {
        state.withLock { state in
            guard case .ready(let readyRuntimeID) = state.phase else {
                return false
            }
            return readyRuntimeID == runtimeID
        }
    }

    private func errorText(_ error: any Error) -> String {
        String(describing: error)
    }
}
#endif
