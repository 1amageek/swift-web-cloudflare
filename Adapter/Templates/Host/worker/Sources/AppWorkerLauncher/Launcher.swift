import SwiftWebCloudflareHost
{{application.swiftImport}}
{{actors.swiftImports}}

private enum WorkerRuntime {
    static let host = CloudflareHost(
        actorServiceBindings: [
{{actors.swiftServiceBindings}}
        ]
    )
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

@_expose(wasm, "invokeActorFrame")
@_cdecl("invokeActorFrame")
func invokeActorFrame() {
    WorkerRuntime.host.invokeActorFrame()
}
