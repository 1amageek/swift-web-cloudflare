import JavaScriptKit

/// Immutable correlation captured before a request leaves the synchronous bridge.
struct CloudflareRequestDiagnostics: Sendable {
    let runtimeID: Int
    let callID: String

    @TaskLocal static var current: CloudflareRequestDiagnostics?

    static func reportRejection(
        _ reason: JSValue,
        requestID: UInt64,
        phase: String
    ) {
        guard let report = JSObject.global.swiftWebActorRequestFailed.function else {
            return
        }
        _ = report(
            current?.runtimeID ?? 0,
            current?.callID ?? "",
            String(requestID),
            phase,
            reason
        )
    }
}
