import SwiftWebCloudflareHost
import {{app.name}}

@_expose(wasm, "swiftwebStart")
@_cdecl("swiftwebStart")
func swiftwebStart() {
    CloudflareActorHost.start({{app.name}}.self)
}

@_expose(wasm, "swiftwebInvoke")
@_cdecl("swiftwebInvoke")
func swiftwebInvoke() {
    CloudflareActorHost.invokePendingEnvelope()
}

@_expose(wasm, "swiftwebSocketOpened")
@_cdecl("swiftwebSocketOpened")
func swiftwebSocketOpened() {
    CloudflareActorHost.socketOpened()
}

@_expose(wasm, "swiftwebSocketMessage")
@_cdecl("swiftwebSocketMessage")
func swiftwebSocketMessage() {
    CloudflareActorHost.socketMessage()
}

@_expose(wasm, "swiftwebSocketClosed")
@_cdecl("swiftwebSocketClosed")
func swiftwebSocketClosed() {
    CloudflareActorHost.socketClosed()
}
