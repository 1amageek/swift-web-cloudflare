import JavaScriptKit
@_spi(Hosting) import SwiftWebActors

enum CloudflareActorRequestFailureCategory: Sendable {
    case cancelled
    case overloaded
    case unavailable
    case closed
}

enum CloudflareActorPromiseError: Error, Sendable {
    case rejected(CloudflareActorRequestFailureCategory)
}

enum CloudflareActorRequestFailure {
    static func promiseCategory(for reason: JSValue) -> CloudflareActorRequestFailureCategory {
        guard let object = reason.object else {
            return .closed
        }
        if object["name"].string == "AbortError" {
            return .cancelled
        }
        if object["overloaded"].boolean == true {
            return .overloaded
        }
        if object["retryable"].boolean == true {
            return .unavailable
        }
        return .closed
    }

    static func actorSystemError(
        for category: CloudflareActorRequestFailureCategory
    ) -> ActorSystemError {
        switch category {
        case .cancelled:
            .cancelled
        case .overloaded:
            .overloaded
        case .unavailable:
            .transportUnavailable(.swiftWebHTTP)
        case .closed:
            .transportClosed
        }
    }

    static func actorSystemError(status: Int) -> ActorSystemError {
        switch status {
        case 401, 403:
            .unauthorized
        case 408, 504:
            .timeout
        case 429:
            .overloaded
        case 503:
            .transportUnavailable(.swiftWebHTTP)
        default:
            .remoteFailure(ActorRemoteFailure(code: UInt32(clamping: status)))
        }
    }

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
        if let promiseError = error as? CloudflareActorPromiseError,
           case .rejected(let category) = promiseError {
            return actorSystemError(for: category)
        }
        return .transportClosed
    }
}
