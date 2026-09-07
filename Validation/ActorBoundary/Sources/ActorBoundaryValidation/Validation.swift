import JavaScriptKit
import JavaScriptEventLoop
#if hasFeature(Embedded)
import ActorSystemEmbedded
#endif
@_spi(Hosting) @testable import SwiftWebCloudflareHost
import SwiftWebCloudflareActorHost
@_spi(Hosting) import SwiftWebActors

@main
struct ActorBoundaryValidation {
    static func main() {}

    #if !hasFeature(Embedded)
    static let host = CloudflareActorServiceHost(authorization: .allowAll) { _, context in
        _ = JSObject.global.actorBoundaryBootstrapping?(Double(context.runtimeID), Double(context.renderingID))
        guard let prepare = JSObject.global.actorBoundaryPrepare.function,
              let promise = JSPromise(from: prepare()) else {
            throw ActorSystemError.activationFailed
        }
        let prepared: Bool = await withCheckedContinuation { continuation in
            _ = promise.then(success: { _ in
                continuation.resume(returning: true)
                return .undefined
            }, failure: { _ in
                continuation.resume(returning: false)
                return .undefined
            })
        }
        guard prepared else { throw ActorSystemError.activationFailed }
    }

    static func provideFrames() {
        do {
            let codec = ActorFrameCodec(configuration: WebActorSystem.shared.configuration)
            let callID = ActorCallID(session: ActorSessionID(77), sequence: 1)
            let cancellation = try codec.encode(.cancellation(callID))
            let invocation = try codec.encode(.invocation(ActorInvocationFrame(
                callID: callID,
                invocation: ActorInvocation(
                    recipient: ActorAddress(type: ActorTypeID(high: 1, low: 2), identity: "expected"),
                    method: ActorMethodID(1),
                    schemaFingerprint: ActorSchemaFingerprint(high: 3, low: 4),
                    payload: ActorByteBuffer()
                ),
                remainingTimeoutNanoseconds: nil
            )))
            _ = JSObject.global.actorBoundaryFrames?(
                JSUint8Array(cancellation.bytes), JSUint8Array(invocation.bytes),
                Double(WebActorSystem.shared.configuration.maximumFrameBytes)
            )
        } catch {
            preconditionFailure("The validation frames must encode: \(error)")
        }
    }
    #endif

    static func validateRequest(_ scenario: Int32) async {
        let client = CloudflareActorRequestClient(
            maximumFrameByteCount: WebActorSystem.shared.configuration.maximumFrameBytes
        )
        let frame = ActorByteBuffer([0, 1, 127, 128, 255])
        let endpoint = ActorEndpoint("validation-\(scenario)")
        let outcome: String
        do {
            let response: ActorByteBuffer?
            if scenario == 4 || scenario == 5 {
                let dispatched = AsyncStream<Void>.makeStream()
                let invocation = Task {
                    try await client.requestActorFrame(frame, to: endpoint) {
                        dispatched.continuation.yield(())
                    }
                }
                var iterator = dispatched.stream.makeAsyncIterator()
                _ = await iterator.next()
                dispatched.continuation.finish()
                if scenario == 4 {
                    invocation.cancel()
                } else {
                    await client.shutdown()
                }
                response = try await invocation.value
            } else if scenario == 6 {
                let invocation = Task {
                    withUnsafeCurrentTask { $0?.cancel() }
                    return try await client.requestActorFrame(frame, to: endpoint) {}
                }
                response = try await invocation.value
            } else {
                response = try await client.requestActorFrame(frame, to: endpoint) {}
            }
            if let response {
                precondition(response == frame, "The owning frame must survive the JavaScript boundary")
                outcome = "bytes"
            } else {
                outcome = "empty"
            }
        } catch let error as ActorSystemError {
            switch error {
            case .overloaded: outcome = "overloaded"
            case .transportUnavailable: outcome = "unavailable"
            case .cancelled: outcome = "cancelled"
            case .transportClosed: outcome = "closed"
            default: outcome = "unexpected:\(error)"
            }
        } catch {
            outcome = "unexpected:unclassified"
        }
        await client.shutdown()
        _ = JSObject.global.actorBoundaryCompleted?(Double(scenario), outcome)
    }
}

@_expose(wasm, "validate_actor_request")
@_cdecl("validate_actor_request")
func validateActorRequest(_ scenario: Int32) {
    Task { await ActorBoundaryValidation.validateRequest(scenario) }
}

@_expose(wasm, "start_actor_validation")
@_cdecl("start_actor_validation")
func startActorValidation() {
    JavaScriptEventLoop.installGlobalExecutor()
}

#if !hasFeature(Embedded)
@_expose(wasm, "prepare_actor_host")
@_cdecl("prepare_actor_host")
func prepareActorHost() {
    ActorBoundaryValidation.provideFrames()
}

@_expose(wasm, "start_actor_host")
@_cdecl("start_actor_host")
func startActorHost() {
    ActorBoundaryValidation.host.start()
}

@_expose(wasm, "invoke_actor_host")
@_cdecl("invoke_actor_host")
func invokeActorHost() {
    ActorBoundaryValidation.host.invokeActorFrame()
}

@_expose(wasm, "shutdownActorService")
@_cdecl("shutdownActorService")
func requestActorServiceShutdown() {
    ActorBoundaryValidation.host.requestShutdown()
}
#endif
