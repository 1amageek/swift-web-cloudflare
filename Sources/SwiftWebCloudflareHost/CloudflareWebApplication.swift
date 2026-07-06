import Logging
import SwiftWebCore

/// The host-neutral application for the Durable Object host. Routes collect
/// during scene lowering; the DO serves only the actor invocation path, so
/// page routes are collected and left unlowered.
final class CloudflareWebApplication: WebApplicationProtocol {
    let logger = Logger(label: "swiftweb.cloudflare")
    let storage = WebApplicationStorage()
    let serverConfiguration = WebServerConfiguration()
    private let webRoutes = WebRoutes()

    var routes: any WebRoutesBuilder {
        webRoutes
    }
}
