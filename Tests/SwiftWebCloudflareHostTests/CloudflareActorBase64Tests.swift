import Testing
@testable import SwiftWebCloudflareActorHost

@Suite("Cloudflare actor frame Base64")
struct CloudflareActorBase64Tests {
    @Test("Computes padded encoded lengths for small frames")
    func computesPaddedEncodedLengths() {
        #expect(CloudflareActorBase64.encodedLength(forMaximumByteCount: 0) == 0)
        #expect(CloudflareActorBase64.encodedLength(forMaximumByteCount: 1) == 4)
        #expect(CloudflareActorBase64.encodedLength(forMaximumByteCount: 3) == 4)
    }

    @Test("Does not overflow at the integer limit")
    func doesNotOverflowAtIntegerLimit() {
        #expect(
            CloudflareActorBase64.encodedLength(
                forMaximumByteCount: Int.max - 2
            ) == nil
        )
        #expect(
            CloudflareActorBase64.encodedLength(
                forMaximumByteCount: Int.max
            ) == nil
        )
    }

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
