import ActorSystemCore
import SwiftHTML
import SwiftWeb
import SwiftWebActors
#if hasFeature(Embedded)
import ActorSystemEmbedded
#endif

@Page("/")
struct ProbePage {
    @RemoteActor private var actor: ProbeActor

    func load() async throws -> String {
        let remote = actor
        let value = try await remote.increment(41)
        guard value == 42 else { throw Failure.unexpectedSuccess }
        var markers = "actor-result:\(value)"

        #if hasFeature(Embedded)
        let observer = try ProbeActor.resolve(
            id: ActorAddress(type: ProbeActor.actorTypeDescriptor.id, identity: "observer"),
            using: remote.actorSystem
        )
        print("probe:success")
        do {
            _ = try await remote.validate(-42)
            throw Failure.unexpectedSuccess
        } catch let failure as ProbeFailure {
            guard case .rejected(let rejected) = failure, rejected == -42 else {
                throw Failure.unexpectedApplicationFailure
            }
        }
        markers += " typed-failure:rejected(-42)"
        print("probe:typed-failure")

        let pending = Task { try await remote.hold() }
        do {
            try await waitForCounts([1, 1, 0, 0], from: observer)
            print("probe:hold-entered")
            pending.cancel()
            do {
                _ = try await pending.value
                throw Failure.unexpectedSuccess
            } catch let error as ActorSystemError {
                print("probe:cancel-error-code:\(error.code.rawValue)")
                guard error == .cancelled else { throw error }
            }
        } catch let primaryError {
            pending.cancel()
            // Join the owned call before propagating the validation failure.
            do {
                _ = try await pending.value
            } catch let cleanupError as ActorSystemError {
                guard cleanupError == .cancelled else { throw cleanupError }
            }
            throw primaryError
        }
        print("probe:cancel-joined")
        try await remote.waitForObservation()
        print("probe:cancel-observed")
        try await waitForCounts([1, 0, 1, 0], from: observer)
        markers += " cancel:cancelled/active:0/completed:0"
        print("probe:cancelled")

        do {
            _ = try await ActorCallOptions.withValue(.init(timeout: .milliseconds(750))) {
                try await remote.hold()
            }
            throw Failure.unexpectedSuccess
        } catch let error as ActorSystemError {
            guard error == .timeout else { throw error }
        }
        try await remote.waitForObservation()
        try await waitForCounts([2, 0, 2, 0], from: observer)
        markers += " deadline:timeout"
        print("probe:deadline")

        // App.actorSystem defaults to shared; the scene-bound remote uses it.
        try await WebActorSystem.shared.shutdown()
        do {
            _ = try await remote.increment(41)
            throw Failure.unexpectedSuccess
        } catch let error as ActorSystemError {
            guard error == .shuttingDown else { throw error }
        }
        markers += " core:stopped/system-failure:shuttingDown"
        print("probe:stopped")
        #endif
        return markers
    }

    func document(_ markers: String) -> some HTMLDocument {
        PageDocument(title: "Embedded Actor validation") {
            main { markers }
        }
    }

    #if hasFeature(Embedded)
    private func waitForCounts(_ expected: [Int], from remote: ProbeActor) async throws {
        // This bound detects fixture failure; it is not a production SLO.
        for index in 0..<50 {
            let observed = try await remote.counts()
            if observed == expected { return }
            if index == 49 {
                print("probe:counts-timeout:\(observed[0]),\(observed[1]),\(observed[2]),\(observed[3])")
            }
        }
        throw Failure.statusTimeout
    }
    #endif

    private enum Failure: Error {
        case unexpectedSuccess
        case unexpectedApplicationFailure
        case statusTimeout
    }
}
