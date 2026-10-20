# Actor boundary validation

This fixture executes the production Swift request client and actor service host
inside workerd. It uses an actual Durable Object for binary request/reply and
injects documented rejection categories without exhausting Cloudflare quotas.
It does not prove Calendar business operations or production availability.
The host checks exercise the production `requestShutdown()` terminal bridge:
runtime/call identity capture across suspension, rejection of mismatched and
already-stopped runtimes, and exactly one Core shutdown completion. TypeScript
registry release and application composition have separate owner tests.

`node run-registry-workerd.mjs` (30-second outer timeout) checks two real DOs
sharing the common registry, crossed/released callback rejection, explicit
route/storage release, and platform eviction followed by reconstruction. A local
inspector GC confirms the registry does not retain the discarded DO, WASM memory,
or storage handle. This fixture verifies TypeScript ownership, not Swift Core
shutdown, and never assumes a graceful eviction callback.

Use Swift `swift-6.4.0-RELEASE` with its matching `_wasm` SDK. SwiftWeb is pinned
to the root package's remote `0.13.0` requirement. Set `SWIFT_WEB_NODE_MODULES` to installed deployment dependencies
(esbuild, Miniflare, and browser_wasi_shim).

Build this package with `SWIFTWEB_HOSTED_APPLICATION=1`, `--build-system native`,
`--product ActorBoundaryValidation --jobs 1 --disable-index-store`, and
`-Xswiftc -enable-testing -Xswiftc -gnone`. Supply the SDK's Unicode library
directory with `-Xlinker -L<SDK>/usr/lib/swift/embedded/wasm32-unknown-wasip1`.
Copy the generated `ActorBoundaryValidation.wasm` to `app.wasm`, then execute
`node run-workerd.mjs` with an outer timeout of 90 seconds.

For Embedded, use the matching `_wasm-embedded` SDK,
and `JAVASCRIPTKIT_EXPERIMENTAL_EMBEDDED_WASM=1`. The matching SDK supplies
Embedded mode and WMO to target compilation. Do not forward WMO globally through
`-Xswiftc`: it also reaches Native macro tools and breaks their object-file plan.
Use separate build paths for the two SDK modes: their identical target triple
does not isolate cached objects when the SDK mode changes.
Run the same check with `node run-workerd.mjs --requests-only`. Distributed
actor hosting is not compiled for Embedded; request-client behavior is the
shared boundary under test. Keep Native, standard WASM, and Embedded artifacts
and results distinct.

Set `SWIFT_WEB_ACTOR_PROGRAM` to the freshly built program to keep the retained
historical `app.wasm` unchanged. The requests gate also checks captured runtime,
Page call and transport request identities across Promise rejection, and
reflection-free Actor failure codes on both WASM profiles.

The `/pages` gate runs the actual Swift `CloudflareHost` and production common
coordinator. Two Swift routes suspend; cancelling one caller retains both
in-flight registrations until their completions, while its peer and the next
request return 200. A real Promise rejection through the Swift request client
then produces a request-correlated internal diagnostic and a generic HTTP 500.
No synthetic callback replaces that Page completion path. The explicit gates
and outer process deadline bound the probe; it performs no production request.
