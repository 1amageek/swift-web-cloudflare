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
| [Embedded page-worker validation](Validation/EmbeddedPageWorker/DESIGN.md) | child | Generated host, local service proxy, and terminal proof | This local gate is not deployment evidence. |
| [SwiftWeb adapter contract](https://github.com/1amageek/swift-web/blob/main/docs/AdapterContract.md) | depends on | Alias-aware Swift imports, Actor module references, and launcher-only compiler flags | Do not replace compiler aliases with SwiftPM module aliases or application renames. |
| [SwiftWeb Actors](https://github.com/1amageek/swift-web/blob/main/Sources/SwiftWebRuntime/Actors/DESIGN.md) | depends on | Hosting SPI and Actor configuration | Consume the reviewed upstream implementation. |

## Architecture

```text
SwiftWeb App -> CloudflareHost -> Worker bridge
generated Actor call -> __swiftWebActorRequest -> DurableObjectNamespace RPC
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

The worker launcher imports application and Actor modules through the
materialized Swift references. When an imported module qualifier collides with
a known application or service type, only the launcher target receives the
deterministic `-module-alias` compiler setting; the original dependency module,
manifest record, ABI name, and Actor/schema identities remain unchanged. The
template does not apply SwiftPM `moduleAliases`, unqualify Actor types, or
rename the authored application. Non-colliding rendered source keeps its
existing semantics.

The generated `page-worker` is an Embedded Actor client. Its replacement and
the Native service-host registration are generated separately from one actor
source authored against `WebActorSystem` and one schema lock. The Native
`WebActorSystem` facade uses its `SwiftActorSystem` backend; the target-specific
Swift actor types differ while their wire identities and fingerprints remain
equal. A task-scoped `ActorCallOptions` value may supply the page call's
deadline without mutating the shared system, while this adapter supplies the
platform clock.

The production service boundary is
`DurableObjectNamespace.getByName(identity).invokeActorFrame`. Local workerd
validation must cross that namespace/RPC boundary. Its fixture Durable Object
may proxy owned frame bytes to a Native `WebActorSystem` service peer using the
generated Native bootstrap and `SwiftWebRequestReplyActorTransport`; this is
evidence of the local proxy and Swift dispatch path, not a deployed Durable
Object, Durable Object persistence, or a Swift service compiled to Cloudflare
WASM.

## Verification and Change Impact

Host changes require the focused host tests and an actual local-workerd run
with the pinned WASM artifact. Generated-build changes additionally require a
template assertion that no implicit `SWIFT_WEB_ROOT` is exported. The subsequent
generated-host integration gate requires a fresh materialized graph whose
external dependencies are remote source-control checkouts at the expected
immutable revisions. Native tests and compile/link
alone do not prove JavaScript execution. Deployment and public release are
separate operations.

`Validation/EmbeddedPageWorker` owns the generated-page evidence: page
response, generated Actor success, typed application and system failures,
in-flight cancellation, a task-scoped deadline through the production clock,
application-owned Actor Core shutdown, and harness-owned Worker/native-process
cleanup. A JavaScript object substituted directly for the namespace is only a
unit fixture and cannot satisfy this gate.
