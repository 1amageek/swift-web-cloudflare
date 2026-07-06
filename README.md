# swift-web-cloudflare

The Cloudflare host adapter for [swift-web](https://github.com/1amageek/swift-web):
runs an app's `ActorGroup` distributed actors inside Durable Objects on the
real `WebActorSystem`, with Swift concurrency driven by JavaScriptKit's event
loop (async model A — verified in workerd).

```swift
import SwiftWebCloudflareHost

// Generated wasm entry (reactor model):
@_expose(wasm, "swiftwebStart")
@_cdecl("swiftwebStart")
func swiftwebStart() { CloudflareActorHost.start(MyApp.self) }

@_expose(wasm, "swiftwebInvoke")
@_cdecl("swiftwebInvoke")
func swiftwebInvoke() { CloudflareActorHost.invokePendingEnvelope() }
```

JS protocol (strings only; JS is a no-interpretation trampoline):
`swiftwebReady()/swiftwebFailed(msg)` after start; JS sets
`globalThis.__swiftwebEnvelope` and calls the invoke export;
`swiftwebComplete(callID, json)` / `swiftwebInvokeFailed(callID, msg)` return
results. No JSClosure (JSClosure traps in workerd), no manual wasm memory.

## Building for the Durable Object

```
SWIFTWEB_CORE_ONLY=1 swift build --swift-sdk swift-6.3.1-RELEASE_wasm -c release \
  -Xswiftc -Osize -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
```

Instantiate with three import modules: `wasi_snapshot_preview1`
(browser_wasi_shim), `javascript_kit: swift.wasmImports` (PackageToJS
runtime.mjs), and `bjs` stubs generated from `WebAssembly.Module.imports`.
Working reference: `EdgeActorSpike/jskit-async/worker`.

`Package.swift` references swift-web by local path (`../swift-web`) while both
evolve together — switch to the released URL before tagging.
