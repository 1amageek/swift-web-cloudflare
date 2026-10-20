import JavaScriptKit
@_spi(Hosting) import SwiftWebActors

/// Bridges SwiftWeb's request/reply actor transport to the host-provided
/// Cloudflare service-binding function.
final class CloudflareActorRequestClient: SwiftWebActorRequestClient, Sendable {
    private let driver: CloudflareActorRequestDriver

    init(maximumFrameByteCount: Int) {
        precondition(maximumFrameByteCount >= 0)
        self.driver = CloudflareActorRequestDriver(
            maximumFrameByteCount: maximumFrameByteCount
        )
    }

    func requestActorFrame(
        _ encodedFrame: ActorByteBuffer,
        to endpoint: ActorEndpoint,
        onDispatched: @escaping @Sendable () -> Void
    ) async throws -> ActorByteBuffer? {
        return try await driver.request(
            frame: encodedFrame,
            endpoint: endpoint.transportSpecificAddress,
            onDispatched: onDispatched
        )
    }

    func shutdown() async {
        await driver.shutdown()
    }
}

private actor CloudflareActorRequestDriver {
    private let maximumFrameByteCount: Int
    private var acceptsRequests = true
    private var nextRequestID: UInt64 = 0
    private var abortControllers: [UInt64: JSObject] = [:]
    private let peerID: String

    init(maximumFrameByteCount: Int) {
        self.maximumFrameByteCount = maximumFrameByteCount
        peerID = "swiftweb-cloudflare-\(UInt64.random(in: 1...UInt64.max))"
    }

    func request(
        frame: ActorByteBuffer,
        endpoint: String,
        onDispatched: @escaping @Sendable () -> Void
    ) async throws -> ActorByteBuffer? {
        guard acceptsRequests else {
            throw ActorSystemError.transportClosed
        }
        guard !Task.isCancelled else {
            throw ActorSystemError.cancelled
        }
        guard nextRequestID < UInt64.max else {
            throw ActorSystemError.overloaded
        }
        guard frame.count <= maximumFrameByteCount else {
            throw ActorSystemError.encodingFailed
        }
        guard let request = JSObject.global.__swiftWebActorRequest.function,
              let abortControllerConstructor = JSObject.global.AbortController.function
        else {
            throw ActorSystemError.transportUnavailable(.swiftWebHTTP)
        }

        nextRequestID += 1
        let requestID = nextRequestID
        let abortController = abortControllerConstructor.new()
        abortControllers[requestID] = abortController
        defer {
            abortControllers[requestID] = nil
        }

        do {
            return try await withTaskCancellationHandler {
                guard !Task.isCancelled else {
                    abort(requestID: requestID)
                    throw ActorSystemError.cancelled
                }
                // JavaScriptKit passes the copied buffer count to its WASM
                // bridge as Int32; reject an unrepresentable length explicitly.
                guard frame.count <= Int(Int32.max) else {
                    throw ActorSystemError.encodingFailed
                }
                // The frame owner retains its byte-aligned storage for this
                // synchronous borrow. JavaScriptKit copies it into one JS
                // owner; no pointer escapes the closure or survives await.
                let requestBody = frame.withUnsafeBytes { bytes in
                    JSUint8Array(buffer: bytes.bindMemory(to: UInt8.self))
                }
                let invocation = request(
                    endpoint,
                    requestBody.jsValue,
                    abortController.signal,
                    peerID
                )
                onDispatched()
                guard let promise = JSPromise(from: invocation) else {
                    throw ActorSystemError.transportClosed
                }
                let response = try await value(of: promise, requestID: requestID, phase: "dispatch")
                let status = Int(response.status.number ?? 0)
                if status == 204 {
                    return nil
                }
                guard response.ok.boolean == true else {
                    throw CloudflareActorRequestFailure.actorSystemError(status: status)
                }
                guard let bodyPromise = JSPromise(from: response.arrayBuffer()) else {
                    throw ActorSystemError.transportClosed
                }
                let buffer = try await value(of: bodyPromise, requestID: requestID, phase: "response-body")
                guard let object = buffer.object,
                      let constructor = JSObject.global.Uint8Array.function
                else {
                    throw ActorSystemError.decodingFailed
                }
                let typedArray = JSUint8Array(
                    unsafelyWrapping: constructor.new(object)
                )
                let byteCount: Int
                do {
                    byteCount = try typedArray.validatedByteLength()
                } catch {
                    throw ActorSystemError.decodingFailed
                }
                guard byteCount <= maximumFrameByteCount else {
                    throw ActorSystemError.decodingFailed
                }
                // Array owns one allocation and exactly-once release. The
                // destination is borrowed only during this synchronous copy.
                let bytes = [UInt8](unsafeUninitializedCapacity: byteCount) {
                    buffer,
                    initializedCount in
                    if byteCount > 0 {
                        typedArray.copyMemory(to: buffer)
                    }
                    initializedCount = byteCount
                }
                return ActorByteBuffer(bytes)
            } onCancel: {
                Task {
                    await self.abort(requestID: requestID)
                }
            }
        } catch {
            throw CloudflareActorRequestFailure.actorSystemError(
                for: error,
                taskWasCancelled: Task.isCancelled
            )
        }
    }

    func shutdown() {
        guard acceptsRequests else {
            return
        }
        acceptsRequests = false
        let controllers = Array(abortControllers.values)
        abortControllers.removeAll(keepingCapacity: false)
        for controller in controllers {
            _ = controller.abort?()
        }
    }

    private func abort(requestID: UInt64) {
        guard let controller = abortControllers.removeValue(forKey: requestID) else {
            return
        }
        _ = controller.abort?()
    }

    private func value(of promise: JSPromise, requestID: UInt64, phase: String) async throws -> JSValue {
        let diagnostics = CloudflareRequestDiagnostics.current
        let result: Swift.Result<JSValue, CloudflareActorPromiseError> =
            await withCheckedContinuation { continuation in
                _ = promise.then(
                    success: { value in
                        continuation.resume(returning: .success(value))
                        return .undefined
                    },
                    failure: { reason in
                        CloudflareRequestDiagnostics.$current.withValue(diagnostics) {
                            CloudflareRequestDiagnostics.reportRejection(reason, requestID: requestID, phase: phase)
                        }
                        let category = CloudflareActorRequestFailure.promiseCategory(
                            for: reason
                        )
                        continuation.resume(
                            returning: .failure(.rejected(category))
                        )
                        return .undefined
                    }
                )
            }
        return try result.get()
    }
}
