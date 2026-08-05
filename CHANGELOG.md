# Changelog

## 0.4.0 - 2026-08-06

### Breaking

- Replaced `CloudflareActorHost.start(App.Type)` with an instance-owned
  `CloudflareHost.render(app)` lifecycle.
- Removed `CloudflareApplication`, `ApplicationProtocol`, app-owned route
  storage, and Cloudflare-specific scene lowering.
- Replaced the `swiftwebStart` family of WASM exports with semantic render,
  request, actor, and socket exports.
- Replaced the `new` and `chat` deployment templates with one `application`
  scaffold.
- Replaced `wrangler.toml` and hand-written Worker binding types with
  `wrangler.jsonc` and `wrangler types` output.
- Updated the deployment baseline to the matching Swift 6.4 development
  snapshot and WASM SDK dated 2026-07-23.
- Verified the host-only, `Actors`-disabled graph with the matching Embedded
  WASM SDK; actor-enabled deployments remain on regular WASM while
  `swift-actor-runtime` requires Foundation.

### Changed

- Cloudflare page serving now consumes `RenderedApp` from SwiftWeb's common
  `AppRenderer`.
- Worker/WASM callbacks are correlated by WASM runtime identity as well as
  operation identity.
- Durable Objects use the current `DurableObject<Env>` base class and generated
  binding types.
- Worker request bodies are streamed into bounded buffers before crossing the
  string-based WASM bridge.
- The generated build resolves Swift 6.4's actual binary directory with
  `swift build --show-bin-path` and verifies both the linked and optimized WASM
  files instead of reporting success for a missing artifact.
- Worker dependency versions are fixed, the transitive HTTP client is pinned
  to its patched release, and `worker-configuration.d.ts` is regenerated from
  `wrangler.jsonc` during typechecking instead of being shipped as stale input.
- The current actor-enabled fixture size is recorded as a blocking production
  boundary rather than being presented as Embedded-compatible.
- The package resolves the released SwiftWeb `0.9.0` rendering contract instead
  of a moving branch dependency.
- Native host tests, Standard and Embedded WASM host builds, Worker
  typechecking and tests, and a Wrangler Worker-bundling dry run validate the
  release boundaries.
