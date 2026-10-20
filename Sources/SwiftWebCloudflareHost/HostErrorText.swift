@_spi(Hosting) import SwiftWebActors

/// Reflection-free categories and request correlation for internal failure logs.
enum HostErrorText {
    static func of(_ error: any Error) -> String {
        let detail = classification(of: error)
        guard let context = CloudflareRequestDiagnostics.current else { return detail }
        return "runtime=\(context.runtimeID) call=\(context.callID) \(detail)"
    }

    private static func classification(of error: any Error) -> String {
        if let failure = error as? ActorSystemError {
            return "actor-system:\(failure.code.rawValue)"
        }
        if error is CancellationError { return "task-cancelled" }
        if let failure = error as? CloudflareHostError {
            switch failure {
            case .invalidBridgeValue: return "invalid-bridge-value"
            case .notReady: return "host-not-ready"
            case .storageDecodeFailed: return "storage-decode-failed"
            }
        }
        #if hasFeature(Embedded)
        return "unclassified-swift-error"
        #else
        return String(describing: error)
        #endif
    }
}
