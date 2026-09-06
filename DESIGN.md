# SwiftWeb Cloudflare Adapter

## Purpose and Scope

This package adapts SwiftWeb to Cloudflare Workers. Its host-module design is
[SwiftWebCloudflareHost](Sources/SwiftWebCloudflareHost/DESIGN.md). Existing
deployment profiles and commands remain defined by [the README](README.md).

## Responsibilities and Boundaries

SwiftWeb owns application rendering and Actor semantics. This adapter owns the
Worker bridge, platform capabilities, and generated Worker build boundary; it
does not add platform dependencies to ActorSystemCore or replace a resolved
source-control dependency with a local checkout during a generated build.

## Related Designs

| Design | Relationship | Contract used | Cautions |
|---|---|---|---|
| [Host module](Sources/SwiftWebCloudflareHost/DESIGN.md) | child | Worker clock and host binding | Preserve cancellation and custom-clock ownership. |
| [SwiftWeb Actors](https://github.com/1amageek/swift-web/blob/main/Sources/SwiftWebRuntime/Actors/DESIGN.md) | depends on | Hosting SPI and Actor configuration | Consume the reviewed upstream implementation. |

## Architecture

```text
SwiftWeb App -> CloudflareHost -> Worker bridge
ActorSystemCore -> ActorClock -> Cloudflare scheduler.wait
```

## Contracts and Invariants

The `page-worker` host uses Embedded WASM; the browser remains Standard WASM.
Compiler and SDK use the same pinned Swift 6.4 snapshot. JavaScriptKit and its
vendored JavaScript runtime use the same version. Unreleased main may pin a
reviewed upstream Git commit; a future semver release replaces that revision
with a released dependency version. The generated Worker build consumes that
manifest requirement without setting `SWIFT_WEB_ROOT`. `SWIFT_WEB_ROOT` remains
an explicit developer override when invoking this package directly; it is not
part of generated, consumable, or validation graphs. The generated application's
own local package path is composition of authored sources, not an external
dependency override. Branch and local-edit overrides are not part of the
consumable graph.

## Verification and Change Impact

Host changes require the focused host tests and an actual local-workerd run
with the pinned WASM artifact. Generated-build changes additionally require a
template assertion that no implicit `SWIFT_WEB_ROOT` is exported. The subsequent
generated-host integration gate requires a fresh materialized graph whose
external dependencies are remote source-control checkouts at the expected
immutable revisions. Native tests and compile/link
alone do not prove JavaScript execution. Deployment and public release are
separate operations.
