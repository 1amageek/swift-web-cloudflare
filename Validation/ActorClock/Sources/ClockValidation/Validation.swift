import JavaScriptKit
import JavaScriptEventLoop
import ActorSystemEmbedded
@_spi(Hosting) import SwiftWebActors

@main
struct ClockValidation {
    static func main() {}
}

@_expose(wasm, "validate_clock")
@_cdecl("validate_clock")
func validateClock(_ unavailableScenario: Int32) {
    JavaScriptEventLoop.installGlobalExecutor()
    Task {
        do {
            if unavailableScenario == 1 {
                do {
                    try await WebActorSystem.shared.configuration.clock.sleep(for: .milliseconds(1))
                    preconditionFailure("Default Embedded clock unexpectedly succeeded")
                } catch is ActorClockUnavailable {}
                do {
                    try WebActorSystem.shared.installActorClock(CloudflareActorClock())
                    preconditionFailure("Unavailable use did not seal clock binding")
                } catch let error as SwiftWebActorSystemConfigurationError {
                    precondition(error == .actorClockInstallationTooLate)
                }
            } else {
                try await runValidation()
            }
            _ = JSObject.global.clockValidationDone?("passed")
        } catch {
            _ = JSObject.global.clockValidationDone?("failed")
        }
    }
}

private func runValidation() async throws {
    let concrete = CloudflareActorClock()
    let custom = EmbeddedActorSystem(configuration: ActorSystemConfiguration(
        sessionIdentitySource: FixedActorSessionIdentitySource(ActorSessionID(99)),
        clock: ContinuousActorClock()
    ))
    let customInstalled = try custom.installActorClock(CloudflareActorClock())
    precondition(!customInstalled)
    do {
        try await custom.configuration.clock.sleep(for: .milliseconds(1))
        preconditionFailure("Custom clock was replaced")
    } catch is ActorClockUnavailable {}
    let installed = try WebActorSystem.shared.installActorClock(concrete)
    precondition(installed)
    do {
        try WebActorSystem.shared.installActorClock(CloudflareActorClock())
        preconditionFailure("Repeated installation succeeded")
    } catch let error as SwiftWebActorSystemConfigurationError {
        precondition(error == .actorClockAlreadyInstalled)
    }
    let clock = WebActorSystem.shared.configuration.clock
    try await clock.sleep(for: .milliseconds(10))
    do {
        try WebActorSystem.shared.installActorClock(CloudflareActorClock())
        preconditionFailure("Late installation succeeded")
    } catch let error as SwiftWebActorSystemConfigurationError {
        precondition(error == .actorClockInstallationTooLate)
    }

    let preCancelled = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        try await clock.sleep(for: .zero)
    }
    do {
        try await preCancelled.value
        preconditionFailure("Pre-cancelled zero wait succeeded")
    } catch is CancellationError {}

    let cancelled = Task { try await clock.sleep(for: .milliseconds(500)) }
    try await clock.sleep(for: .milliseconds(10))
    cancelled.cancel()
    do {
        try await cancelled.value
        preconditionFailure("Cancelled timer succeeded")
    } catch is CancellationError {}

    let directory = ActorDirectory()
    let target = SlowTarget(clock: clock)
    try directory.register(target)
    let core = ActorSystemCore(
        directory: directory,
        configuration: ActorSystemConfiguration(
            sessionIdentitySource: FixedActorSessionIdentitySource(ActorSessionID(1)),
            clock: clock
        )
    )
    try await core.start()
    let invocation = ActorInvocation(
        recipient: target.address,
        method: ActorMethodID(1),
        schemaFingerprint: target.descriptor.schemaFingerprint,
        payload: ActorByteBuffer()
    )
    do {
        _ = try await core.invoke(invocation, options: ActorCallOptions(timeout: .milliseconds(20)))
        preconditionFailure("Deadline did not fire")
    } catch let error as ActorSystemError {
        precondition(error == .timeout)
    }

    let inFlight = Task {
        try await core.invoke(invocation, options: ActorCallOptions(timeout: .seconds(60)))
    }
    try await clock.sleep(for: .milliseconds(10))
    try await core.shutdown()
    do {
        _ = try await inFlight.value
        preconditionFailure("Shutdown left a successful invocation")
    } catch let error as ActorSystemError {
        precondition(error == .cancelled)
    }
    do {
        _ = try await core.invoke(invocation)
        preconditionFailure("Shutdown was not terminal")
    } catch let error as ActorSystemError {
        precondition(error == .shuttingDown)
    }
}

private struct SlowTarget: ActorInvocationTarget {
    let clock: any ActorClock
    let address = ActorAddress(type: ActorTypeID(high: 1, low: 1), identity: "clock")
    let descriptor = ActorTypeDescriptor(
        id: ActorTypeID(high: 1, low: 1),
        schemaFingerprint: ActorSchemaFingerprint(high: 1, low: 1),
        methods: [ActorMethodDescriptor(
            id: ActorMethodID(1), parameterTypeIDs: [], resultTypeID: nil, errorTypeID: nil
        )]
    )

    func invoke(
        _ invocation: ActorInvocation,
        context: ActorInvocationContext
    ) async throws -> ActorInvocationResult {
        try await clock.sleep(for: .seconds(60))
        return ActorInvocationResult()
    }
}
