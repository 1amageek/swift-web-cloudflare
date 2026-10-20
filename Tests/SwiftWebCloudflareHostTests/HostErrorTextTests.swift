import Testing
@testable import SwiftWebCloudflareHost
@_spi(Hosting) import SwiftWebActors

@Suite("Host failure diagnostics")
struct HostErrorTextTests {
    @Test("Actor categories have stable reflection-free diagnostic codes")
    func actorCodesRemainDistinct() {
        #expect(HostErrorText.of(ActorSystemError.transportClosed) == "actor-system:14")
        #expect(HostErrorText.of(ActorSystemError.timeout) == "actor-system:15")
        #expect(HostErrorText.of(ActorSystemError.cancelled) == "actor-system:16")
        #expect(HostErrorText.of(ActorSystemError.overloaded) == "actor-system:17")
    }

    @Test("Concurrent diagnostic scopes restore their captured request identity", .timeLimit(.minutes(1)))
    func diagnosticScopesRemainIsolated() async {
        async let first = describe(runtimeID: 1, callID: "1:g1-r1")
        async let second = describe(runtimeID: 2, callID: "2:g1-r1")
        let values = await (first, second)
        #expect(values.0 == "runtime=1 call=1:g1-r1 actor-system:14")
        #expect(values.1 == "runtime=2 call=2:g1-r1 actor-system:14")
        #expect(CloudflareRequestDiagnostics.current == nil)
    }

    private func describe(runtimeID: Int, callID: String) async -> String {
        await CloudflareRequestDiagnostics.$current.withValue(.init(runtimeID: runtimeID, callID: callID)) {
            await Task.yield()
            return HostErrorText.of(ActorSystemError.transportClosed)
        }
    }
}
