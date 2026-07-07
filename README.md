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

## Installation

Released as `0.1.0`, depending on the released swift-web (`exact: "0.2.1"`):

```swift
.package(url: "https://github.com/1amageek/swift-web-cloudflare.git", from: "0.1.0"),
```

## Scaffolding a deploy

The `swiftweb-cloudflare` CLI materializes the deploy layout into an app:

```
swift run swiftweb-cloudflare install --app MyApp
```

This writes `deploy/cloudflare` (Worker + wrangler.toml + JS trampoline) and
`deploy/wasm` (the generated launcher package + `build.sh`). The Worker routes
`POST /_swiftweb/actors/invoke` by the envelope's `recipientID`
(`"<contract>:<name>"`) to a per-identity `SwiftWebActorDO` via `idFromName`,
and upgrades `GET /_swiftweb/actors/ws?actor=…` to a WebSocket on the same DO
for bidirectional actor messaging (server → client push included).

## Building for the Durable Object

`deploy/wasm/build.sh` runs the DO build and optimization:

```
SWIFTWEB_DO=1 swift build --swift-sdk swift-6.3.1-RELEASE_wasm -c release \
  -Xswiftc -Osize -Xswiftc -Xclang-linker -Xswiftc -mexec-model=reactor
npx --yes wasm-opt -Oz --strip-debug -o app.wasm <built>.wasm
```

Instantiate with three import modules: `wasi_snapshot_preview1`
(browser_wasi_shim), `javascript_kit: swift.wasmImports` (PackageToJS
runtime.mjs), and `bjs` stubs generated from `WebAssembly.Module.imports`.

Verified end-to-end in workerd: envelope POST → Worker routing →
per-identity DO → activation → state across calls, and WebSocket sessions
with agent → observer pushes over one duplex channel.
