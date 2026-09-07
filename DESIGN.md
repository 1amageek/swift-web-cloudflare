# SwiftWeb Cloudflare Adapter

## Purpose and Scope

This package adapts SwiftWeb to Cloudflare Workers. Its host-module design is
[SwiftWebCloudflareHost](Sources/SwiftWebCloudflareHost/DESIGN.md). Existing
deployment profiles and commands remain defined by [the README](README.md).

## Responsibilities and Boundaries

SwiftWeb owns application rendering and Actor semantics. This adapter owns the
Worker bridge, platform capabilities, generated Worker build boundary, and the
Cloudflare request/host boundary. It does not add platform dependencies to
ActorSystemCore or replace a resolved source-control dependency with a local
checkout during a generated build.

## Related Designs

| Design | Relationship | Contract used | Cautions |
|---|---|---|---|
| [Host module](Sources/SwiftWebCloudflareHost/DESIGN.md) | child | Worker clock and host binding | Preserve cancellation and custom-clock ownership. |
| [Actor host module](Sources/SwiftWebCloudflareActorHost/DESIGN.md) | child | Actor request categories, bootstrap admission, and shutdown | Keep application registration and policy outside the generic host. |
| [Deployment common runtime](Adapter/Templates/Deployment/common/DESIGN.md) | child | Isolate-wide runtime registry, callback ownership, and terminal release | Composition supplies the WASM module; the common runtime does not import an application artifact. |
| [Embedded page-worker validation](Validation/EmbeddedPageWorker/DESIGN.md) | child | Generated host, local service proxy, and terminal proof | This local gate is not deployment evidence. |
| [SwiftWeb adapter contract](https://github.com/1amageek/swift-web/blob/main/docs/AdapterContract.md) | depends on | Alias-aware Swift imports, Actor module references, and launcher-only compiler flags | Do not replace compiler aliases with SwiftPM module aliases or application renames. |
| [SwiftWeb Actors](https://github.com/1amageek/swift-web/blob/main/Sources/SwiftWebRuntime/Actors/DESIGN.md) | depends on | Hosting SPI and Actor configuration | Consume the reviewed upstream implementation. |

## Architecture

```text
SwiftWeb App -> CloudflareHost -> common runtime registry -> Worker bridge
generated Actor call -> request client -> __swiftWebActorRequest -> DurableObjectNamespace RPC
ActorSystemCore <- generic failure category / owned frame -> request client
actor service host -> bootstrap context -> configure -> register -> admit -> invoke
explicit service stop -> common registry -> thin launcher -> ActorSystem shutdown
ActorSystemCore -> ActorClock -> Cloudflare scheduler.wait
```

## Contracts and Invariants

The `page-worker` host uses Embedded WASM; the browser remains Standard WASM.
Compiler and SDK use the same pinned Swift 6.4 snapshot. JavaScriptKit and its
vendored JavaScript runtime use the same version. Release 0.6.0 pins SwiftWeb
`0.13.0` at revision `c61cd26a` and JavaScriptKit `0.57.3` at peeled revision
`166dc39`; the release graph contains no local, branch, or editable package
override. The generated Worker build consumes that remote manifest requirement.
The generated application's own local package path is composition of authored
sources, not an external dependency override. The AR-03 artifact comparison
must prove that this released graph preserves the selected SwiftWeb,
JavaScriptKit, ActorSystem, product, trait, and materialized common-source
inputs before reusing any pre-release artifact.

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

The request adapter maps Cloudflare rejection properties and HTTP status into
the platform-independent Actor error categories before the SwiftWeb boundary:
`overloaded`, `transportUnavailable`, `transportClosed`, `unauthorized`,
`timeout`, and `remoteFailure`. A 503 is unavailable, not automatically
overloaded; the adapter does not retry. Cancellation wins over a late Promise
rejection. The adapter receives the existing `WebActorSystem.configuration`
frame limit at installation, owns one bounded input frame for the duration of
the JavaScript call, and materializes one owned output frame only after
validating the returned byte length against that same limit.

The actor service host receives an immutable runtime bootstrap context from the
host bridge. It configures the shared ActorSystem, calls the application-owned
registration closure with that context, and admits ingress only after both
registration and system start have succeeded. Native and standard WASM host
builds use the same `Mutex` contract; the `SWIFTWEB_ACTORS` service-host module
is not compiled for the Embedded page/client target. Shutdown transitions to a
terminal state and no later start or invocation is admitted where the host is
compiled.

The deployment-common runtime owns the isolate-wide `ApplicationRuntimeRegistry`.
Each composition registers a runtime with a unique runtime ID and an optional
storage token; callback dispatch first resolves that owner and rejects unknown,
mismatched, or released IDs. Page retirement remains a generation-local
operation and has no shutdown export. Actor service stop is a separate terminal
handshake: the common registry reserves a unique shutdown call ID, the thin
application launcher delegates to `CloudflareActorServiceHost.requestShutdown()`,
which awaits the existing `shutdown()` operation. The bridge captures
runtime/call IDs before awaiting Core shutdown. Exactly one success or failure
callback is delivered to the owning runtime. The registry releases runtime and
storage routes after that callback; the application composition then releases
its own database execution callback. Failure rejects remaining pending calls
before release.

## Verification and Change Impact

Request/host changes require the focused Swift tests, strict common-template
checks, and one actual local-workerd adapter run with the pinned WASM artifact.
The run must exercise success, rejection categories, cancellation, bounded
frames, bootstrap admission, identity rejection, exactly-once completion, and
explicit shutdown. Generated-build changes additionally require a template
assertion that the release graph has no local SwiftWeb override and a
materialized-file identity check proving that Page and service compositions use
the common runtime owner without duplicate registries. The subsequent
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
