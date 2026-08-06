import SwiftWebCloudflareHost
import {{application.module}}

private enum WorkerRuntime {
    static let host = CloudflareHost()
}

@_expose(wasm, "renderApplication")
@_cdecl("renderApplication")
func renderApplication() {
    WorkerRuntime.host.render({{application.type}}())
}

@_expose(wasm, "respondToRequest")
@_cdecl("respondToRequest")
func respondToRequest() {
    WorkerRuntime.host.respondToRequest()
}

@_expose(wasm, "invokeActor")
@_cdecl("invokeActor")
func invokeActor() {
    WorkerRuntime.host.invokeActor()
}

@_expose(wasm, "openActorSocket")
@_cdecl("openActorSocket")
func openActorSocket() {
    WorkerRuntime.host.openActorSocket()
}

@_expose(wasm, "receiveActorSocketMessage")
@_cdecl("receiveActorSocketMessage")
func receiveActorSocketMessage() {
    WorkerRuntime.host.receiveActorSocketMessage()
}

@_expose(wasm, "closeActorSocket")
@_cdecl("closeActorSocket")
func closeActorSocket() {
    WorkerRuntime.host.closeActorSocket()
}
