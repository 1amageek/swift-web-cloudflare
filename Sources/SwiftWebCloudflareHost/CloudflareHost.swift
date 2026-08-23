#if canImport(JavaScriptEventLoop)
import JavaScriptEventLoop
#endif
#if !SWIFTWEB_PORTABLE_LOGGING
import Logging
#endif
@_spi(Hosting) import SwiftWebActors
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
    private let actorServiceBindings: [SwiftWebActorServiceBinding]
    private let actorRequestClient: CloudflareActorRequestClient?

    public init(
        serverConfiguration: ServerConfiguration = ServerConfiguration(),
        clientRuntime: ClientRuntimeConfiguration? = nil,
        actorServiceBindings: [SwiftWebActorServiceBinding] = [],
        logger: Logger = Logger(label: "swiftweb.host.cloudflare")
    ) {
        self.serverConfiguration = serverConfiguration
        self.clientRuntime = clientRuntime
        self.actorServiceBindings = actorServiceBindings
        self.actorRequestClient = actorServiceBindings.isEmpty
            ? nil
            : CloudflareActorRequestClient()
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
                #if SWIFTWEB_ACTORS || hasFeature(Embedded)
                if let actorRequestClient {
                    try app.actorSystem.installActorRequestClient(actorRequestClient)
                }
                #endif
                #if SWIFTWEB_ACTORS
                let persistentStore = identity.storageToken.map(
                    DurableObjectActorStateStore.init(token:)
                )
                try await app.actorSystem.configureHosting(
                    authorization: app.security.actors.authorization,
                    activationPolicy: app.security.actors.activation,
                    persistentStore: persistentStore
                )
                #endif
                let renderedApp = try await AppRenderer.render(
                    app,
                    in: AppRenderingContext(
                        serverConfiguration: serverConfiguration,
                        clientRuntime: clientRuntime,
                        developmentHooks: .disabled,
                        actorServiceBindings: actorServiceBindings
                    )
                )
                #if SWIFTWEB_ACTORS
                let installation = CloudflareAppInstallation(
                    runtimeID: identity.runtimeID,
                    renderedApp: renderedApp,
                    sessionStorage: sessionStorage,
                    logger: logger,
                    actorSystem: app.actorSystem
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

    /// Invokes the binary actor frame currently presented by the bridge.
    public func invokeActorFrame() {
        #if SWIFTWEB_ACTORS
        let input: CloudflareActorFrameInvocation
        do {
            input = try CloudflareWorkerBridge.actorFrameInvocation()
        } catch {
            CloudflareWorkerBridge.actorFrameInvocationFailed(
                runtimeID: CloudflareWorkerBridge.currentRuntimeID ?? -1,
                callID: CloudflareWorkerBridge.currentActorFrameCallID ?? "",
                message: HostErrorText.of(error)
            )
            return
        }

        Task {
            guard let installation = readyInstallation(runtimeID: input.runtimeID) else {
                CloudflareWorkerBridge.actorFrameInvocationFailed(
                    runtimeID: input.runtimeID,
                    callID: input.callID,
                    message: "The Cloudflare app is not ready"
                )
                return
            }
            do {
                let result = try await installation.invokeActorFrame(
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
                CloudflareWorkerBridge.actorFrameInvocationCompleted(
                    runtimeID: input.runtimeID,
                    callID: input.callID,
                    encodedFrame: result
                )
            } catch {
                CloudflareWorkerBridge.actorFrameInvocationFailed(
                    runtimeID: input.runtimeID,
                    callID: input.callID,
                    message: HostErrorText.of(error)
                )
            }
        }
        #else
        CloudflareWorkerBridge.actorFrameInvocationFailed(
            runtimeID: CloudflareWorkerBridge.currentRuntimeID ?? -1,
            callID: CloudflareWorkerBridge.currentActorFrameCallID ?? "",
            message: "Actor support is disabled"
        )
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
