#if canImport(Logging)
import Logging
#endif
import SwiftWebCore

/// The host-neutral application for the Cloudflare host. Routes collect
/// during scene lowering; `CloudflarePageServer` serves the collected page
/// and service routes, and the actor invocation path is dispatched directly
/// by `CloudflareActorHost`.
final class CloudflareApplication: ApplicationProtocol {
    let logger = Logger(label: "swiftweb.cloudflare")
    let storage = ApplicationStorage()
    let serverConfiguration = ServerConfiguration()
    private let webRoutes = Routes()

    var routes: any RoutesBuilder {
        webRoutes
    }

    /// The routes the app's scenes and services registered, read by the page
    /// server after lowering — the same seam `HTTPServerAppRunner` uses.
    var collectedRoutes: [Route] {
        webRoutes.all
    }
}
