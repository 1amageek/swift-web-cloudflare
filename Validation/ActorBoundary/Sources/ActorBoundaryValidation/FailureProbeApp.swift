import JavaScriptKit
import SwiftWebCore
@_spi(Hosting) import SwiftWebActors
@testable import SwiftWebCloudflareHost

struct FailureProbeApp: App {
    var body: some Scene {
        Endpoint("/health") { _ in Response(body: .init(string: "healthy")) }
        Endpoint("/hold") { _ in
            guard let hold = JSObject.global.failureProbeHold.function,
                  let promise = JSPromise(from: hold()) else { throw ActorSystemError.activationFailed }
            let completed = await withCheckedContinuation { continuation in
                _ = promise.then(success: { _ in
                    continuation.resume(returning: true)
                    return .undefined
                }, failure: { _ in
                    continuation.resume(returning: false)
                    return .undefined
                })
            }
            guard completed else { throw ActorSystemError.transportClosed }
            return Response(body: .init(string: "completed"))
        }
        Endpoint("/transport") { _ -> Response in
            let client = CloudflareActorRequestClient(maximumFrameByteCount: 1024)
            _ = try await client.requestActorFrame(ActorByteBuffer([1]), to: ActorEndpoint("failure-probe")) {}
            return Response(body: .init(string: "unexpected success"))
        }
    }
}
