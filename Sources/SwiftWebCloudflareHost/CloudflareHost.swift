#if SWIFTWEB_ACTORS
@preconcurrency import ActorRuntime
#endif
#if canImport(JavaScriptEventLoop)
import JavaScriptEventLoop
#endif
#if canImport(Logging)
import Logging
#endif
import SwiftWebActors
@_spi(Hosting) import SwiftWebCore
import Synchronization

/// Connects one rendered SwiftWeb app to the Cloudflare Worker event boundary.
///
/// The generated WASM launcher owns one host for the lifetime of its module and
/// forwards Cloudflare events to this value. The host renders the app exactly
/// once through `AppRenderer`; it does not create a second application
/// container or lower scenes itself.
public final class CloudflareHost: Sendable {
    private enum Phase: Sendable {
        case idle
        case rendering(runtimeID: Int, renderingID: Int)
        case ready(CloudflareAppInstallation)
    }

    private struct State: Sendable {
        var executorInstalled = false
        var phase = Phase.idle
    }

    private let state = Mutex(State())
    private let serverConfiguration: ServerConfiguration
    private let clientRuntime: ClientRuntimeConfiguration?
    private let sessionStorage: CloudflareSessionStorage
    private let logger: Logger

    public init(
        serverConfiguration: ServerConfiguration = ServerConfiguration(),
        clientRuntime: ClientRuntimeConfiguration? = nil,
        logger: Logger = Logger(label: "swiftweb.host.cloudflare")
    ) {
        self.serverConfiguration = serverConfiguration
        self.clientRuntime = clientRuntime
        self.sessionStorage = CloudflareSessionStorage()
        self.logger = logger
    }

    /// Renders an app for the current Worker runtime.
    ///
    /// Cloudflare calls the generated synchronous WASM export, so completion is
    /// delivered through the Worker bridge after the asynchronous render ends.
    public func render<AppType: App>(_ app: sending AppType) {
        let identity: CloudflareRenderingIdentity
        do {
            identity = try CloudflareWorkerBridge.renderingIdentity()
        } catch {
            CloudflareWorkerBridge.renderingFailed(
                runtimeID: CloudflareWorkerBridge.currentRuntimeID ?? -1,
                renderingID: CloudflareWorkerBridge.currentRenderingID ?? -1,
                message: HostErrorText.of(error)
            )
            return
        }

        let reservation = state.withLock { state -> (accepted: Bool, installExecutor: Bool) in
            guard case .idle = state.phase else {
                return (false, false)
            }
            let installExecutor = !state.executorInstalled
            state.executorInstalled = true
            state.phase = .rendering(
                runtimeID: identity.runtimeID,
                renderingID: identity.renderingID
            )
            return (true, installExecutor)
        }
        guard reservation.accepted else {
            CloudflareWorkerBridge.renderingFailed(
                runtimeID: identity.runtimeID,
                renderingID: identity.renderingID,
                message: "The Cloudflare host has already rendered an app"
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
                let renderedApp = try await AppRenderer.render(
                    app,
                    in: AppRenderingContext(
                        serverConfiguration: serverConfiguration,
                        clientRuntime: clientRuntime,
                        developmentHooks: .disabled
                    )
                )
                #if SWIFTWEB_ACTORS
                let installation = CloudflareAppInstallation(
                    runtimeID: identity.runtimeID,
                    renderedApp: renderedApp,
                    sessionStorage: sessionStorage,
                    logger: logger,
                    actorSystem: app.actorSystem,
                    actorSecurity: app.security.actors,
                    storageToken: identity.storageToken
                )
                #else
                let installation = CloudflareAppInstallation(
                    runtimeID: identity.runtimeID,
                    renderedApp: renderedApp,
                    sessionStorage: sessionStorage,
                    logger: logger
                )
                #endif
                state.withLock { state in
                    state.phase = .ready(installation)
                }
                CloudflareWorkerBridge.renderingCompleted(identity)
            } catch {
                state.withLock { state in
                    guard case .rendering(let runtimeID, let renderingID) = state.phase,
                          runtimeID == identity.runtimeID,
                          renderingID == identity.renderingID else {
                        return
                    }
                    state.phase = .idle
                }
                CloudflareWorkerBridge.renderingFailed(
                    runtimeID: identity.runtimeID,
                    renderingID: identity.renderingID,
                    message: HostErrorText.of(error)
                )
            }
        }
    }

    /// Serves the Worker request currently presented by the bridge.
    public func respondToRequest() {
        let rawRequest: CloudflarePageRequest
        do {
            rawRequest = try CloudflareWorkerBridge.pageRequest()
        } catch {
            CloudflareWorkerBridge.requestFailed(
                runtimeID: CloudflareWorkerBridge.currentRuntimeID ?? -1,
                callID: CloudflareWorkerBridge.currentRequestCallID ?? "",
                message: HostErrorText.of(error)
            )
            return
        }

        Task {
            guard let installation = readyInstallation(runtimeID: rawRequest.runtimeID) else {
                CloudflareWorkerBridge.requestFailed(
                    runtimeID: rawRequest.runtimeID,
                    callID: rawRequest.callID,
                    message: "The Cloudflare app is not ready"
                )
                return
            }
            let response = await installation.respond(to: rawRequest)
            CloudflareWorkerBridge.requestCompleted(
                runtimeID: rawRequest.runtimeID,
                callID: rawRequest.callID,
                response: response
            )
        }
    }

    /// Invokes the actor envelope currently presented by the bridge.
    public func invokeActor() {
        #if SWIFTWEB_ACTORS
        let input: CloudflareActorInvocation
        do {
            input = try CloudflareWorkerBridge.actorInvocation()
        } catch {
            CloudflareWorkerBridge.actorInvocationFailed(
                runtimeID: CloudflareWorkerBridge.currentRuntimeID ?? -1,
                callID: "",
                message: HostErrorText.of(error)
            )
            return
        }

        Task {
            guard let installation = readyInstallation(runtimeID: input.runtimeID) else {
                CloudflareWorkerBridge.actorInvocationFailed(
                    runtimeID: input.runtimeID,
                    callID: CloudflareWorkerBridge.callID(in: input.envelopeJSON) ?? "",
                    message: "The Cloudflare app is not ready"
                )
                return
            }
            let callID = CloudflareWorkerBridge.callID(in: input.envelopeJSON) ?? ""
            do {
                let result = try await installation.invokeActor(
                    envelopeJSON: input.envelopeJSON,
                    principal: input.principal
                )
                CloudflareWorkerBridge.actorInvocationCompleted(
                    runtimeID: input.runtimeID,
                    callID: result.callID,
                    responseJSON: result.responseJSON
                )
            } catch let error as WebActorAuthorizationError {
                CloudflareWorkerBridge.actorInvocationDenied(
                    runtimeID: input.runtimeID,
                    callID: callID,
                    reason: error.reason
                )
            } catch {
                CloudflareWorkerBridge.actorInvocationFailed(
                    runtimeID: input.runtimeID,
                    callID: callID,
                    message: HostErrorText.of(error)
                )
            }
        }
        #else
        CloudflareWorkerBridge.actorInvocationFailed(
            runtimeID: CloudflareWorkerBridge.currentRuntimeID ?? -1,
            callID: "",
            message: "Actor support is disabled"
        )
        #endif
    }

    public func openActorSocket() {
        #if SWIFTWEB_ACTORS
        do {
            let input = try CloudflareWorkerBridge.socketInput()
            guard let installation = readyInstallation(runtimeID: input.runtimeID) else {
                throw CloudflareHostError.notReady
            }
            installation.openSocket(id: input.socketID, principal: input.principal)
        } catch {
            logger.error("Failed to open actor socket: \(HostErrorText.of(error))")
        }
        #endif
    }

    public func receiveActorSocketMessage() {
        #if SWIFTWEB_ACTORS
        do {
            let input = try CloudflareWorkerBridge.socketMessage()
            guard let installation = readyInstallation(runtimeID: input.runtimeID) else {
                throw CloudflareHostError.notReady
            }
            installation.receiveSocketMessage(id: input.socketID, frame: input.frame)
        } catch {
            logger.error("Failed to receive actor socket message: \(HostErrorText.of(error))")
        }
        #endif
    }

    public func closeActorSocket() {
        #if SWIFTWEB_ACTORS
        do {
            let input = try CloudflareWorkerBridge.socketInput()
            guard let installation = readyInstallation(runtimeID: input.runtimeID) else {
                throw CloudflareHostError.notReady
            }
            installation.closeSocket(id: input.socketID)
        } catch {
            logger.error("Failed to close actor socket: \(HostErrorText.of(error))")
        }
        #endif
    }

    private func readyInstallation(runtimeID: Int) -> CloudflareAppInstallation? {
        state.withLock { state in
            guard case .ready(let installation) = state.phase,
                  installation.runtimeID == runtimeID else {
                return nil
            }
            return installation
        }
    }
}
