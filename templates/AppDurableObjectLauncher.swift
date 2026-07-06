// The wasm entry for the SwiftWeb Durable Object package. Replace `MyApp`
// with the app type; the two exports are the contract the worker template
// (`Templates/worker/src/index.ts`) drives.
import SwiftWebCloudflareHost

@_expose(wasm, "swiftwebStart")
@_cdecl("swiftwebStart")
func swiftwebStart() {
    CloudflareActorHost.start(MyApp.self)
}

@_expose(wasm, "swiftwebInvoke")
@_cdecl("swiftwebInvoke")
func swiftwebInvoke() {
    CloudflareActorHost.invokePendingEnvelope()
}
