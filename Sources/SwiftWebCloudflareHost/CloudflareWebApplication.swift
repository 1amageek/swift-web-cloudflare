import Logging
import SwiftWebCore

/// The host-neutral application for the Cloudflare host. Routes collect
/// during scene lowering; `CloudflarePageServer` serves the collected page
/// and service routes, and the actor invocation path is dispatched directly
/// by `CloudflareActorHost`.
final class CloudflareWebApplication: WebApplicationProtocol {
    let logger = Logger(label: "swiftweb.cloudflare")
    let storage = WebApplicationStorage()
    let serverConfiguration = WebServerConfiguration()
    private let webRoutes = WebRoutes()

    var routes: any WebRoutesBuilder {
        webRoutes
    }

    /// The routes the app's scenes and services registered, read by the page
    /// server after lowering — the same seam `HTTPServerAppRunner` uses.
    var collectedRoutes: [WebRoute] {
        webRoutes.all
    }
}
