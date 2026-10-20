# Deployment Common Runtime

## Purpose and Scope

This component owns the shared JavaScript/WASM runtime registry and callback
ownership used by generated Page and actor-service Workers. It is a child of the
[SwiftWebCloudflare package design](../../../../DESIGN.md) and coordinates with the
[actor service host](../../../../Sources/SwiftWebCloudflareActorHost/DESIGN.md).
It does not own Calendar routes, database schema, credentials, actor identity
policy, or Swift Actor Core lifecycle.

## Responsibilities and Boundaries

The component instantiates the WASM module supplied by the generated
composition, assigns an isolate-wide runtime ID, stores an optional Durable
Object storage token, and routes bridge callbacks only to the owning runtime.
It owns Page generation/request retirement and Actor service call registries.
The application composition supplies the actual module and policy adapters.
The Swift host owns Actor Core start and shutdown; the common runtime releases
its JavaScript registrations only after the host reports a terminal callback.

## Related Designs

| Design | Relationship | Contract used | Cautions |
|---|---|---|---|
| [Package](../../../../DESIGN.md) | parent | Worker bridge, common failure categories, and materialization | Generated dependencies remain immutable and composition supplies artifacts. |
| [Actor service host](../../../../Sources/SwiftWebCloudflareActorHost/DESIGN.md) | coordinates with | bootstrap, admission, frame invocation, and `shutdown()` | Core completion precedes registry/storage release. |
| Calendar deployment composition | uses | route, header, capacity, DB callback, and actor policy wiring | Calendar does not own a second registry or a Page shutdown API. |

## Architecture

```text
composition supplies WASM module + policy callbacks
                 |
                 v
      ApplicationRuntimeRegistry (one isolate-wide owner)
          | runtime ID + storage token
          +--> Page generation/request calls
          `--> Actor frame + shutdown calls
                         |
                         v
              generic bridge callback routing
                         |
                         v
          terminal callback -> release runtime/storage routes
                              -> composition releases its DB callback
```

## Contracts and Invariants

The registry allocates unique runtime and call IDs within the isolate and never
reuses an ID while its owner is registered. Every callback validates the runtime
ID and call ID against the owning pending registry; unknown, mismatched, and
released IDs are rejected as protocol failures and never delivered to another
runtime. Only a matching terminal callback can release an actor registration.
Runtime IDs fit the signed 32-bit integer boundary used by WASM Swift. Page
wire IDs include the globally unique runtime identity even when two coordinators
have the same local generation and request sequence.
The index is stored under one global symbol so separately materialized module
copies in the same realm also share the allocator and weak routing table.
The existing `actor-frame-limits.ts` owns the binary frame bound. The common
bridge enforces it before input encoding and before output base64 decoding;
invalid or noncanonical response encodings fail without delivering a value.

`createApplicationRuntime(module, storage?)` supplies the existing render,
request, actor-frame, and explicit `shutdown()` operations. Callers never supply
a shutdown call ID. `createPageRuntimeCoordinator(module, options)` composes the
existing bounded Page coordinator with the same module instantiation and weak
callback registry. Generation retirement releases its route; late instantiation
after a deadline is released without starting the discarded generation.

Page runtime retirement is not graceful shutdown. It removes an inactive Page
generation only after its pending start/render calls settle; the Page launcher
has no shutdown export. Durable Object eviction may reconstruct a runtime and
does not imply a graceful callback.

Caller cancellation rejects only that caller's wait, including during shared
cold start. It never terminates a generation or unregisters its callbacks.
Already-dispatched Swift work remains counted against the existing render
capacity until its matching success/failure callback or existing deadline.
Late completion after caller cancellation is therefore an owned completion,
not an unknown callback. This cancels the caller's wait; the Page launcher has
no Swift task-cancellation export. Runtime traps, protocol violations and
deadlines retain their generation-failure contract. No cancelled-call
tombstones or unbounded detached registries are introduced.

Actor service shutdown is explicit. The common registry reserves a unique
`shutdownCallID` and marks admission as stopping. The thin application launcher
delegates to the existing Swift `CloudflareActorServiceHost.shutdown()` through
the host's semantic `requestShutdown()` entry.
The generic bridge captures `runtimeID` and `shutdownCallID` before awaiting the
host operation, then emits exactly one success or failure callback to that
runtime. Only the terminal callback permits rejection of remaining pending
calls and release of runtime/storage routes. The application composition then
releases its own database execution callback; common does not know that callback.
The common runtime does not add a second RPC or a Core lifecycle.

## Runtime Flows

```text
register composition runtime
        -> admit Page or actor calls
        -> explicit actor stop marks stopping
        -> capture IDs before await
        -> await existing Actor Core shutdown
        -> terminal success/failure callback exactly once
        -> settle pending calls and release registrations
```

Database transport construction is a composition concern: the Calendar launcher
creates one transport from its bootstrap runtime identity and injects it into the
existing actor factory. The common runtime only carries opaque bytes and callback
IDs; it does not decode DatabaseWire messages or look up a per-call session ID.

## State, Ownership, and Lifecycle

| State | Owner | Release condition |
|---|---|---|
| runtime instance, storage handle, and registration | DO composition / Page generation | terminal callback and no pending calls, or owner collection after eviction |
| runtime ID and storage token routing | common registry (weak reference) | explicit terminal release or finalizer metadata cleanup |
| Page generation | Page coordinator | retirement/terminal with pending calls settled |
| actor shutdown call | common registry + actor host | exactly one terminal callback |
| database execution callback | Calendar composition | after actor runtime terminal release |

## Failure, Concurrency, and Constraints

The registry is isolate-wide but request data is not module-global. Callback
handlers perform owner lookup and explicit validation before settlement. Promise
operations are awaited or returned. A shutdown failure rejects remaining pending
calls after admission is stopped; it must not silently fall back to a new runtime
or release state early. Actor Core controls frame admission, cancellation, and
in-flight ordering; the common registry must not impose a duplicate raw-frame
concurrency limit.

The actor-request diagnostic bridge accepts captured runtime, Page call,
transport request and phase IDs from Swift. It reports bounded error names and
stack frames before Swift reduces a rejection to an Actor category. Messages,
HTTP/file URLs, request bytes and arbitrary properties are excluded. Malformed values or
a throwing console never replace the original failure.

The global index never strongly retains the DO, WASM instance, storage handle,
or application execution callback. Lookup promotes a weak registration to a
strong local only for dispatch. FinalizationRegistry deletes primitive routing
metadata; it never runs Core shutdown or establishes correctness. Explicit
shutdown releases synchronously after Core completion. Platform eviction has no
graceful callback assumption. The existing isolate-wide Page provider remains a
strong owner for the ordinary Worker Page runtime. Current workerd at the
deployment compatibility date exposes WeakRef and FinalizationRegistry without
an additional flag, consistent with the platform's [in-memory state contract](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/).

## Verification and Change Impact

Strict TypeScript tests cover two coordinators in one isolate, unique runtime and
call IDs, owner-only callback routing, unknown/mismatched/released rejection,
Page retirement, and Actor shutdown terminal ordering. Materialized-file checks
prove that Page and service compositions use the common files without duplicate
registries. The local-workerd adapter fixture owns the actual WASM/DO callback
and shutdown proof; native or Node-only tests cannot claim that boundary.
Cancellation regressions also cover a cancelled cold-start waiter with a live
peer, in-flight peers, retained capacity, late success/failure, retirement and
deadline cleanup. A common-registry test delivers a bridge callback after
cancellation without reporting an unknown runtime.

Moved Page source is checked with the common strict/no-unchecked-index policy.
The official JavaScriptKit declaration file retains its upstream DOM-oriented
types unchanged; Worker builds skip third-party declaration checking, as the
Calendar builds already do. This does not add Worker-thread capability. The
Node ownership check uses explicit GC only to test weak retention; platform
eviction/reconstruction is a separate workerd gate.

Changes to registry ownership, terminal ordering, or bridge IDs require review
of the actor host and each Calendar composition that injects a transport.
