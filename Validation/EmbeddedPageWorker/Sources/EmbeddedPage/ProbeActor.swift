import Distributed
import ActorSystemCore
import SwiftWebActors

public enum ProbeFailure: Error, Codable, Sendable {
    case rejected(Int)
}

public distributed actor ProbeActor {
    public typealias ActorSystem = WebActorSystem

    private var entered: Int = 0
    private var active: Int = 0
    private var cancelled: Int = 0
    private var completed: Int = 0

    public distributed func increment(_ value: Int) async throws -> Int {
        value + 1
    }

    public distributed func validate(_ value: Int) async throws(ProbeFailure) -> Int {
        guard value >= 0 else { throw .rejected(value) }
        return value
    }

    public distributed func hold() async throws -> Int {
        entered += 1
        active += 1
        defer { active -= 1 }
        do {
            try await Task.sleep(for: .seconds(2))
        } catch is CancellationError {
            cancelled += 1
            throw CancellationError()
        }
        completed += 1
        return completed
    }

    public distributed func counts() async throws -> [Int] {
        let address = ActorAddress(type: id.type, identity: "primary")
        let primary = try ProbeActor.resolve(id: address, using: actorSystem)
        // Observe the primary actor without entering its per-address invocation gate.
        guard let counts = await primary.whenLocal({ target in
            [target.entered, target.active, target.cancelled, target.completed]
        }) else {
            throw ActorSystemError.actorNotFound(address)
        }
        return counts
    }

    public distributed func waitForObservation() async throws {
        try await Task.sleep(for: .milliseconds(2_100))
    }
}
