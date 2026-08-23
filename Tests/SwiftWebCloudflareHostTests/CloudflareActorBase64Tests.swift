import Testing
@testable import SwiftWebCloudflareActorHost

@Suite("Cloudflare actor frame Base64")
struct CloudflareActorBase64Tests {
    @Test("Round trips actor frame bytes")
    func roundTripsActorFrameBytes() throws {
        let frame: [UInt8] = [0, 1, 2, 3, 127, 128, 254, 255]

        let encoded = CloudflareActorBase64.encode(frame)

        #expect(CloudflareActorBase64.decode(encoded) == frame)
    }

    @Test("Rejects malformed bridge payloads")
    func rejectsMalformedPayloads() {
        #expect(CloudflareActorBase64.decode("A") == nil)
        #expect(CloudflareActorBase64.decode("A===") == nil)
        #expect(CloudflareActorBase64.decode("AA=A") == nil)
        #expect(CloudflareActorBase64.decode("AA!A") == nil)
    }
}
