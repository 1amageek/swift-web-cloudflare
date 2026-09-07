#if SWIFTWEB_ACTORS

/// Carries the validated Cloudflare identity into application actor registration.
public struct CloudflareActorServiceBootstrapContext: Sendable, Equatable {
    public let runtimeID: Int
    public let renderingID: Int

    public init(runtimeID: Int, renderingID: Int) {
        self.runtimeID = runtimeID
        self.renderingID = renderingID
    }
}

#endif
