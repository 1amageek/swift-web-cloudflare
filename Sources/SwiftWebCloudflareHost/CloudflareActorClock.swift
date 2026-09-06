import JavaScriptKit
@_spi(Hosting) import SwiftWebActors

/// Supplies the Worker's cancellable scheduler to Embedded actor deadlines.
struct CloudflareActorClock: ActorClock, Sendable {
    private let driver = CloudflareActorClockDriver()

    func sleep(for duration: Duration) async throws {
        if Task.isCancelled { throw CancellationError() }
        guard duration > .zero else { return }
        try await driver.sleep(for: Self.milliseconds(for: duration))
    }

    static func milliseconds(for duration: Duration) throws -> Double {
        guard duration > .zero else { return 0 }
        let components = duration.components
        guard components.seconds >= 0, components.attoseconds >= 0 else {
            throw CloudflareActorClockError.invalidDuration
        }

        // workerd truncates fractional milliseconds and caps timers at 100
        // years. Round in integers so Double cannot erase a sub-ms remainder.
        let maximumMilliseconds: Int64 = 3_153_600_000_000
        guard components.seconds <= maximumMilliseconds / 1_000 else {
            throw CloudflareActorClockError.durationOutOfRange
        }
        let attosecondsPerMillisecond: Int64 = 1_000_000_000_000_000
        let milliseconds = components.seconds * 1_000
            + components.attoseconds / attosecondsPerMillisecond
            + (components.attoseconds % attosecondsPerMillisecond == 0 ? 0 : 1)
        guard milliseconds <= maximumMilliseconds else {
            throw CloudflareActorClockError.durationOutOfRange
        }
        return Double(milliseconds)
    }
}

enum CloudflareActorClockError: Error, Sendable, Equatable {
    case unavailable
    case promiseRejected
    case invalidDuration
    case durationOutOfRange
}

private actor CloudflareActorClockDriver {
    private var nextWaitID: UInt64 = 0
    private var abortControllers: [UInt64: JSObject] = [:]

    func sleep(for milliseconds: Double) async throws {
        if Task.isCancelled { throw CancellationError() }
        guard let scheduler = JSObject.global.scheduler.object,
              let wait = scheduler.wait.function,
              let abortControllerConstructor = JSObject.global.AbortController.function
        else {
            throw CloudflareActorClockError.unavailable
        }
        guard nextWaitID < UInt64.max else {
            throw ActorSystemError.overloaded
        }

        nextWaitID += 1
        let waitID = nextWaitID
        let controller = try JSThrowingFunction(abortControllerConstructor)
            .new(arguments: [JSValue]())
        abortControllers[waitID] = controller
        defer {
            abortControllers[waitID] = nil
        }

        let options = JSObject(dictionaryLiteral: ("signal", controller.signal))
        let invocation = try JSThrowingFunction(wait).callAsFunction(
            this: scheduler,
            arguments: [milliseconds.jsValue, options.jsValue]
        )
        guard let promise = JSPromise(from: invocation) else {
            throw CloudflareActorClockError.promiseRejected
        }

        do {
            try await withTaskCancellationHandler {
                try await waitForPromise(promise)
                if Task.isCancelled { throw CancellationError() }
            } onCancel: {
                Task {
                    await self.abort(waitID: waitID)
                }
            }
        } catch {
            if Task.isCancelled {
                throw CancellationError()
            }
            throw error
        }
    }

    private func waitForPromise(_ promise: JSPromise) async throws {
        let result: Swift.Result<Void, CloudflareActorClockError> =
            await withCheckedContinuation { continuation in
                _ = promise.then(
                    success: { _ in
                        continuation.resume(returning: .success(()))
                        return .undefined
                    },
                    failure: { _ in
                        continuation.resume(
                            returning: .failure(.promiseRejected)
                        )
                        return .undefined
                    }
                )
            }
        try result.get()
    }

    private func abort(waitID: UInt64) {
        _ = abortControllers[waitID]?.abort?()
    }
}
