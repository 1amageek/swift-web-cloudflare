import SwiftWebCloudflareHost
import {{app.name}}

private let cloudflareHost = CloudflareHost()

@_expose(wasm, "renderApplication")
@_cdecl("renderApplication")
func renderApplication() {
    cloudflareHost.render({{app.name}}())
}

@_expose(wasm, "respondToRequest")
@_cdecl("respondToRequest")
func respondToRequest() {
    cloudflareHost.respondToRequest()
}

@_expose(wasm, "invokeActor")
@_cdecl("invokeActor")
func invokeActor() {
    cloudflareHost.invokeActor()
}

@_expose(wasm, "openActorSocket")
@_cdecl("openActorSocket")
func openActorSocket() {
    cloudflareHost.openActorSocket()
}

@_expose(wasm, "receiveActorSocketMessage")
@_cdecl("receiveActorSocketMessage")
func receiveActorSocketMessage() {
    cloudflareHost.receiveActorSocketMessage()
}

@_expose(wasm, "closeActorSocket")
@_cdecl("closeActorSocket")
func closeActorSocket() {
    cloudflareHost.closeActorSocket()
}
