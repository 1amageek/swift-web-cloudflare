@_spi(Hosting) import SwiftWebActors

enum CloudflareActorRequestFailure {
    static func actorSystemError(
        for error: any Error,
        taskWasCancelled: Bool
    ) -> ActorSystemError {
        if taskWasCancelled || error is CancellationError {
            return .cancelled
        }
        if let actorSystemError = error as? ActorSystemError {
            return actorSystemError
        }
        return .transportClosed
    }
}
