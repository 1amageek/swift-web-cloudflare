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
