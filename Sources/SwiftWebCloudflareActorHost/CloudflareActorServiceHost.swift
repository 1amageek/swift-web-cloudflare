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
    private enum StartupOutcome: Sendable {
        case ready
        case failed
        case stoppedDuringStartup
        case ignored
    }

    private enum Phase: Sendable {
        case idle
        case starting(runtimeID: Int, renderingID: Int)
        case ready(runtimeID: Int)
        case failed(runtimeID: Int)
        case stopped
    }

    private enum ShutdownAction: Sendable {
        case none
        case join
        case joinAndReportStartupFailure(runtimeID: Int, renderingID: Int)
    }

    private struct State: Sendable {
        var executorInstalled = false
        var phase = Phase.idle
        var startupFailureReported = false
        var actorShutdownStarted = false
    }

    private let state = Mutex(State())
    private let actorSystem: WebActorSystem
    private let maximumFrameByteCount: Int
    private let authorization: SwiftWebActorAuthorization
    private let activationPolicy: WebActorActivationPolicy
    private let registerActors:
        @Sendable (WebActorSystem, CloudflareActorServiceBootstrapContext) async throws -> Void

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
        registerActors: @escaping @Sendable (
            WebActorSystem,
            CloudflareActorServiceBootstrapContext
        ) async throws -> Void
    ) {
        self.actorSystem = actorSystem
        self.maximumFrameByteCount = actorSystem.configuration.maximumFrameBytes
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
                try await registerActors(
                    actorSystem,
                    CloudflareActorServiceBootstrapContext(
                        runtimeID: identity.runtimeID,
                        renderingID: identity.renderingID
                    )
                )
                try await actorSystem.start()
                let outcome = state.withLock { state -> StartupOutcome in
                    switch state.phase {
                    case .starting(let runtimeID, let renderingID)
                        where runtimeID == identity.runtimeID
                            && renderingID == identity.renderingID:
                        state.phase = .ready(runtimeID: identity.runtimeID)
                        return .ready
                    case .stopped where !state.startupFailureReported:
                        state.startupFailureReported = true
                        return .stoppedDuringStartup
                    default:
                        return .ignored
                    }
                }
                switch outcome {
                case .ready:
                    CloudflareActorBridge.startupCompleted(identity)
                case .stoppedDuringStartup:
                    CloudflareActorBridge.startupFailed(
                        runtimeID: identity.runtimeID,
                        renderingID: identity.renderingID,
                        message: "The Cloudflare actor service stopped during startup"
                    )
                case .failed, .ignored:
                    break
                }
            } catch {
                let outcome = state.withLock { state -> StartupOutcome in
                    switch state.phase {
                    case .starting(let runtimeID, let renderingID)
                        where runtimeID == identity.runtimeID
                            && renderingID == identity.renderingID:
                        state.phase = .failed(runtimeID: identity.runtimeID)
                        state.startupFailureReported = true
                        return .failed
                    case .stopped where !state.startupFailureReported:
                        state.startupFailureReported = true
                        return .stoppedDuringStartup
                    default:
                        return .ignored
                    }
                }
                switch outcome {
                case .failed, .stoppedDuringStartup:
                    CloudflareActorBridge.startupFailed(
                        runtimeID: identity.runtimeID,
                        renderingID: identity.renderingID,
                        message: errorText(error)
                    )
                case .ready, .ignored:
                    break
                }
            }
        }
    }

    /// Stops admission and joins the existing Actor Core lifecycle once.
    public func shutdown() async throws {
        let action = state.withLock { state -> ShutdownAction in
            switch state.phase {
            case .idle:
                state.phase = .stopped
                return .none
            case .starting(let runtimeID, let renderingID):
                state.phase = .stopped
                state.actorShutdownStarted = true
                if !state.startupFailureReported {
                    state.startupFailureReported = true
                    return .joinAndReportStartupFailure(
                        runtimeID: runtimeID,
                        renderingID: renderingID
                    )
                }
                return .join
            case .ready, .failed:
                state.phase = .stopped
                state.actorShutdownStarted = true
                return .join
            case .stopped:
                return state.actorShutdownStarted ? .join : .none
            }
        }
        switch action {
        case .none:
            return
        case .join:
            try await actorSystem.shutdown()
        case .joinAndReportStartupFailure(let runtimeID, let renderingID):
            CloudflareActorBridge.startupFailed(
                runtimeID: runtimeID,
                renderingID: renderingID,
                message: "The Cloudflare actor service stopped during startup"
            )
            try await actorSystem.shutdown()
        }
    }

    /// Invokes the actor frame currently presented by the Durable Object bridge.
    public func invokeActorFrame() {
        let input: CloudflareActorFrameInput
        do {
            input = try CloudflareActorBridge.actorFrameInput(
                maximumFrameByteCount: maximumFrameByteCount
            )
        } catch {
            CloudflareActorBridge.actorFrameFailed(
                runtimeID: CloudflareActorBridge.currentRuntimeID ?? -1,
                callID: CloudflareActorBridge.currentActorFrameCallID ?? "",
                message: errorText(error)
            )
            return
        }

        guard isReadyForInvocation(runtimeID: input.runtimeID) else {
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

    private func isReadyForInvocation(runtimeID: Int) -> Bool {
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
