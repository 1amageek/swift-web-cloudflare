# Actor boundary validation

This fixture executes the production Swift request client and actor service host
inside workerd. It uses an actual Durable Object for binary request/reply and
injects documented rejection categories without exhausting Cloudflare quotas.
It does not prove Calendar business operations or production availability.

Use Swift `swift-6.4.x-DEVELOPMENT-SNAPSHOT-2026-08-14-a` with its matching
`_wasm` SDK. Set `SWIFT_WEB_ROOT` to the SwiftWeb source selected by the root
package and `SWIFT_WEB_NODE_MODULES` to installed deployment dependencies
(esbuild, Miniflare, and browser_wasi_shim).

Build this package with `SWIFTWEB_HOSTED_APPLICATION=1`, `--build-system native`,
`--product ActorBoundaryValidation --jobs 1 --disable-index-store`, and
`-Xswiftc -enable-testing -Xswiftc -gnone`. Supply the SDK's Unicode library
directory with `-Xlinker -L<SDK>/usr/lib/swift/embedded/wasm32-unknown-wasip1`.
Copy the generated `ActorBoundaryValidation.wasm` to `app.wasm`, then execute
`node run-workerd.mjs` with an outer timeout of 90 seconds.

For Embedded, use the matching `_wasm-embedded` SDK,
`JAVASCRIPTKIT_EXPERIMENTAL_EMBEDDED_WASM=1`, and whole-module optimization.
Use separate build paths for the two SDK modes: their identical target triple
does not isolate cached objects when the SDK mode changes.
Run the same check with `node run-workerd.mjs --requests-only`. Distributed
actor hosting is not compiled for Embedded; request-client behavior is the
shared boundary under test. Keep Native, standard WASM, and Embedded artifacts
and results distinct.
