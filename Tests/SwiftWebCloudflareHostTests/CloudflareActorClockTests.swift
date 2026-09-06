import Testing
@testable import SwiftWebCloudflareHost

@Suite("Cloudflare actor clock")
struct CloudflareActorClockTests {
    @Test("Duration conversion never rounds a positive remainder down")
    func millisecondsPreserveDeadline() throws {
        #expect(try CloudflareActorClock.milliseconds(for: .zero) == 0)
        #expect(try CloudflareActorClock.milliseconds(for: .seconds(-1)) == 0)
        #expect(try CloudflareActorClock.milliseconds(for: .nanoseconds(1)) == 1)
        #expect(try CloudflareActorClock.milliseconds(for: .milliseconds(900)) == 900)
        #expect(try CloudflareActorClock.milliseconds(for: Duration(
            secondsComponent: 0,
            attosecondsComponent: 900_000_000_000_000_001
        )) == 901)
        #expect(try CloudflareActorClock.milliseconds(for: Duration(
            secondsComponent: 1,
            attosecondsComponent: -1
        )) == 1_000)

        let maximum = Duration.seconds(3_153_600_000)
        #expect(try CloudflareActorClock.milliseconds(for: maximum) == 3_153_600_000_000)
        #expect(throws: CloudflareActorClockError.durationOutOfRange) {
            try CloudflareActorClock.milliseconds(for: maximum + .nanoseconds(1))
        }
        #expect(throws: CloudflareActorClockError.durationOutOfRange) {
            try CloudflareActorClock.milliseconds(for: .seconds(Int64.max))
        }
    }
}
