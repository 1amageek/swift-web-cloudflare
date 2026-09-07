import Testing
@_spi(Hosting) @testable import SwiftWebCloudflareHost
@_spi(Hosting) import SwiftWebActors

@Suite("Cloudflare actor request failure")
struct CloudflareActorRequestFailureTests {
    @Test("Task cancellation wins an in-flight transport rejection")
    func cancelledTaskReportsCancellation() {
        let error = CloudflareActorRequestFailure.actorSystemError(
            for: PromiseRejection(),
            taskWasCancelled: true
        )

        #expect(error == .cancelled)
    }

    @Test("Swift cancellation reports actor cancellation")
    func cancellationErrorReportsCancellation() {
        let error = CloudflareActorRequestFailure.actorSystemError(
            for: CancellationError(),
            taskWasCancelled: false
        )

        #expect(error == .cancelled)
    }

    @Test("Typed actor failures retain their contract")
    func actorSystemErrorIsPreserved() {
        let error = CloudflareActorRequestFailure.actorSystemError(
            for: ActorSystemError.unauthorized,
            taskWasCancelled: false
        )

        #expect(error == .unauthorized)
    }

    @Test("Unknown promise failures close the transport")
    func promiseRejectionClosesTransport() {
        let error = CloudflareActorRequestFailure.actorSystemError(
            for: PromiseRejection(),
            taskWasCancelled: false
        )

        #expect(error == .transportClosed)
    }

    @Test("Cloudflare overload and unavailable categories remain distinct")
    func cloudflareCategoriesRemainDistinct() {
        #expect(
            CloudflareActorRequestFailure.actorSystemError(
                for: CloudflareActorPromiseError.rejected(.overloaded),
                taskWasCancelled: false
            ) == .overloaded
        )
        #expect(
            CloudflareActorRequestFailure.actorSystemError(
                for: CloudflareActorPromiseError.rejected(.unavailable),
                taskWasCancelled: false
            ) == .transportUnavailable(.swiftWebHTTP)
        )
    }

    @Test("503 is unavailable while 429 is overloaded")
    func statusCategoriesRemainDistinct() {
        #expect(
            CloudflareActorRequestFailure.actorSystemError(status: 503)
                == .transportUnavailable(.swiftWebHTTP)
        )
        #expect(
            CloudflareActorRequestFailure.actorSystemError(status: 429)
                == .overloaded
        )
    }

    private struct PromiseRejection: Error {}
}
