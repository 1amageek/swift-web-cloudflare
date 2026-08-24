import JavaScriptKit
@_spi(Hosting) import SwiftWebActors

/// Bridges SwiftWeb's request/reply actor transport to the host-provided
/// Cloudflare service-binding function.
final class CloudflareActorRequestClient: SwiftWebActorRequestClient, Sendable {
    private let driver = CloudflareActorRequestDriver()

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
    private var acceptsRequests = true
    private var nextRequestID: UInt64 = 0
    private var abortControllers: [UInt64: JSObject] = [:]
    private let peerID: String

    init() {
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
                let invocation = request(
                    endpoint,
                    JSUint8Array(frame.bytes).jsValue,
                    abortController.signal,
                    peerID
                )
                onDispatched()
                guard let promise = JSPromise(from: invocation) else {
                    throw ActorSystemError.transportClosed
                }
                let response = try await value(of: promise)
                let status = Int(response.status.number ?? 0)
                if status == 204 {
                    return nil
                }
                guard response.ok.boolean == true else {
                    throw actorError(status: status)
                }
                guard let bodyPromise = JSPromise(from: response.arrayBuffer()) else {
                    throw ActorSystemError.transportClosed
                }
                let buffer = try await value(of: bodyPromise)
                guard let object = buffer.object,
                      let constructor = JSObject.global.Uint8Array.function
                else {
                    throw ActorSystemError.decodingFailed
                }
                let bytes = JSUint8Array(unsafelyWrapping: constructor.new(object))
                    .withUnsafeBytes { Array($0) }
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

    private func actorError(status: Int) -> ActorSystemError {
        switch status {
        case 401, 403:
            .unauthorized
        case 408, 504:
            .timeout
        case 429, 503:
            .overloaded
        default:
            .remoteFailure(ActorRemoteFailure(code: UInt32(clamping: status)))
        }
    }

    private func value(of promise: JSPromise) async throws -> JSValue {
        let result: Swift.Result<JSValue, CloudflareActorPromiseError> =
            await withCheckedContinuation { continuation in
                _ = promise.then(
                    success: { value in
                        continuation.resume(returning: .success(value))
                        return .undefined
                    },
                    failure: { _ in
                        continuation.resume(returning: .failure(.rejected))
                        return .undefined
                    }
                )
            }
        return try result.get()
    }
}

private enum CloudflareActorPromiseError: Error, Sendable {
    case rejected
}
