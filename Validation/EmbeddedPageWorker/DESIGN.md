# Embedded Page-Worker Validation

## Purpose and Scope

This validation package is a child of the
[swift-web-cloudflare package design](../../DESIGN.md). It composes the existing
generated Embedded page-worker, Cloudflare host, local workerd service binding,
and Native SwiftWeb Actor host into one executable local gate. It has no child
design units.

The fixture proves only the local generated-host path. It does not prove a
deployed Worker, Durable Object persistence, a Swift service compiled to
Cloudflare WASM, or the Standard-WASM browser runtime.

## Responsibilities and Boundaries

This package owns the validation sources, generated-package input, Native
service process, workerd harness, observable assertions, and terminal cleanup.
Production SwiftWeb and swift-web-cloudflare packages continue to own Actor
semantics, generation, host binding, clocks, rendering, and transport behavior.
The fixture invokes the production actor-system CLI for the Native-host and
Embedded-client profiles, selects the generated Embedded source directory from
its authored package manifest, and uses `sweb prepare` to materialize the
unchanged production page-worker launcher and templates. It does not implement
a fixture-specific projector or template path.

The runner uses SwiftWeb's shared `scripts/swift-test-timeout.sh` process-group
owner. That wrapper executes its Python owner directly and drains the complete
child process group before it exits on every terminal path. Its focused
regression script belongs to the same cleanup boundary; this fixture does not
add a second timeout framework.

The fixture reuses `HTTPServerHost`, `Endpoint`, `WebActorSystem`, generated
Actor registration, and `SwiftWebRequestReplyActorTransport`. It does not add an
Embedded local Actor host or a `CloudflareHost` shutdown API. The application
owns its Embedded Actor Core shutdown; the Native service owns its Actor system
shutdown; the harness owns workerd and Native-process lifetime.

## Related Designs

| Design | Relationship | Contract Used | Summary | Cautions |
|---|---|---|---|---|
| [Package](../../DESIGN.md) | parent | Page-worker profile, dependency provenance, and local-workerd proof boundary | Defines what the adapter and generated host guarantee. | Local proof is not deployment proof. |
| [Cloudflare host](../../Sources/SwiftWebCloudflareHost/DESIGN.md) | depends on | Actor request-client and platform-clock installation | Connects generated Actor calls to the JavaScript service bridge. | The host does not own Actor Core shutdown. |
| [Host rendering](../../Documentation/CloudflareHostRendering.md) | depends on | Generated launcher exports and service binding | Defines the production page and Actor event boundaries. | A direct JavaScript handler substitute cannot satisfy this fixture. |
| [SwiftWeb Actors](https://github.com/1amageek/swift-web/blob/main/Sources/SwiftWebRuntime/Actors/DESIGN.md) | depends on | Native `WebActorSystem`, Embedded projection, frame admission, and task-scoped call options | Supplies both sides of the service-backed Actor contract. | Exact dependency revisions, not local edits, define the validated graph. |

## Architecture

```text
authored WebActorSystem actor + schema lock
    |-- Native authored actor + generated registration
    |      -> HTTPServerHost endpoint
    |      -> WebActorSystem -> SwiftActorSystem backend
    |
    `-- Embedded generated client
           -> generated page launcher -> CloudflareHost
           -> __swiftWebActorRequest
           -> local workerd DurableObjectNamespace RPC
           -> proxy Durable Object -> Native HTTP endpoint
```

## Contracts and Invariants

- The generated application consumes external dependencies through exact
  remote source-control revisions. Application-root path composition remains a
  source-composition boundary and is not an external dependency override.
- The first page proof renders an authored `@Page`/`PageDocument` through the
  generated page launcher; a handwritten-HTML endpoint is not equivalent.
- The authored application keeps the same module and `App` type identifier.
  Its Actor binding compiles through the materializer's deterministic
  launcher-only module alias; the fixture does not rename the application or
  add a Native-only source alias.
- One actor source authored with `ActorSystem = WebActorSystem` and one schema
  lock produce the Native registration and Embedded client replacement. Actor,
  method, portable-error, and schema-fingerprint identities remain equal.
- The Native peer is a real `WebActorSystem` facade backed by
  `SwiftActorSystem`; it uses the generated registration and the existing
  SwiftWeb HTTP frame-admission path.
- The fixture binds `primary` and `observer` through the same `ProbeActor`
  service-route template. The generated Embedded page constructs both
  addresses with `ProbeActor.actorTypeDescriptor.id`. In the authored Native
  actor, `observer` constructs the `primary` address from its assigned
  `id.type`; `SwiftActorSystem` derives that value from the same generated
  registration descriptor and rejects a local actor whose assigned type does
  not match it. The fixture therefore neither hand-writes a type ID nor makes
  authored source depend on a generated descriptor extension. It does not add
  an Actor type or adapter route. The `@RemoteActor` page binding remains
  `primary`, while an explicitly resolved generated client reaches `observer`.
- The workerd path performs an actual
  `DurableObjectNamespace.getByName(identity).invokeActorFrame` call. The proxy
  transports owned frame bytes to the Native peer; it does not implement Actor
  results itself.
- A deadline originates from an ordinary generated Embedded call inside
  `ActorCallOptions.withValue`. `CloudflareActorClock` supplies the actual
  caller-side timer. An injected Native inbound deadline or synthetic HTTP
  timeout is not equivalent evidence.
- Typed application failure, system failure, cancellation, and deadline are
  distinct observable outcomes and are not converted to success responses.
- The Embedded page application shuts down its Actor Core and observes
  post-shutdown rejection. The Native service shuts down its own Actor system.
  Its `/shutdown` endpoint acknowledges only after `WebActorSystem.shutdown()`
  completes. The harness then sends SIGTERM to the HTTP listener process and
  joins it within the explicit process deadline; this is bounded process
  cleanup, not a claim that the listener has a graceful shutdown API.
- The shared timeout helper preserves a command's normal or failing exit
  status, returns 124 after a timeout, and returns 128 plus the received signal
  number after SIGINT or SIGTERM. Every terminal path drains the owned process
  group before returning: descendants that outlive a normally or unsuccessfully
  exited leader are terminated without changing that leader's status, while
  timeout and interruption terminate the group before selecting their wrapper
  status. Cleanup escalates from bounded SIGTERM to SIGKILL when required; a
  wrapper exit with a surviving descendant is a failed cleanup.

## Runtime Flows

1. The runner invokes the production actor-system CLI to generate the Native
   registration and Embedded client replacement. The authored package selects
   the generated Embedded sources with
   `JAVASCRIPTKIT_EXPERIMENTAL_EMBEDDED_WASM`; `sweb prepare` then materializes
   the actual `page-worker` launcher and templates. The runner verifies resolved
   external dependency revisions before building with the pinned Swift 6.4
   Embedded-WASM toolchain and matching SDK.
2. Local workerd loads the generated launcher. An authored
   `@Page`/`PageDocument` request crosses the production rendering exports and
   returns HTTP 200.
3. The generated Embedded actor client sends an owned frame through the
   Cloudflare request client. The bound Durable Object namespace selects the
   identity, invokes the proxy RPC, and forwards the bytes to the Native HTTP
   endpoint. Calls under observation use the distinct `observer` address so
   they do not queue behind the `primary` address's execution gate.
4. The Native `WebActorSystem` admits the frame, delegates to its
   `SwiftActorSystem` backend, and returns the encoded result or exact failure
   through the same boundaries. `observer.counts()` resolves `primary` in that
   same actor system with the observer's assigned `id.type`, then uses
   `whenLocal` to read the counters under the primary actor's isolation; the
   observer owns no mirrored counter or shared storage.
5. Cancellation and scoped deadline cases abort their pending request without
   leaking a later completion. The Embedded application then shuts down its
   Actor Core and observes a later-call rejection. The Native `/shutdown`
   endpoint awaits its `WebActorSystem` shutdown and acknowledges it; the
   harness then disposes workerd, sends SIGTERM to the Native HTTP listener, and
   joins the child process within its deadline.

## State, Ownership, and Lifecycle

| State | Owner | Isolation | Lifetime and release |
|---|---|---|---|
| Embedded Actor Core | Generated page application | Existing `EmbeddedActorSystem` isolation | Created with the page runtime; application shutdown completes and later admission is rejected before Worker disposal. |
| Native Actor state and system | Native `WebActorSystem` service process | Existing SwiftWeb Actor isolation | Created before the gate; `/shutdown` acknowledges Core completion before harness-owned SIGTERM and bounded process join. |
| Embedded call options | Calling task | Immutable task-local scope | Restored after success, failure, cancellation, or deadline. |
| Cloudflare timer requests | `CloudflareActorClock` driver | Existing actor isolation | Settled or aborted before Worker disposal. |
| Durable Object proxy and service binding | Local workerd | workerd runtime | Exists only for the fixture run; disposed by the harness. |
| Child processes and diagnostics | Validation harness | Single harness owner | Terminated and joined on success and every failure path. |
| Timeout child process group | SwiftWeb shared timeout wrapper | One Python process-group owner executed directly by the shell wrapper | Every exit path reaches group cleanup; normal/failure status is preserved, while timeout or interruption uses its specified wrapper status after bounded termination and reaping. |

## Failure, Concurrency, and Constraints

The runner fails on generation, provenance, build, startup, protocol,
assertion, shutdown, or process-deadline failure. It preserves separate
application, system, cancellation, and deadline observations. Parallel calls
must not share task-scoped options or leave pending work after cancellation.
The shared timeout-helper regression executes normal exit, command failure,
timeout, SIGINT, and SIGTERM cases and rejects any surviving descendant.

The pinned Embedded baseline provides neither `Task.sleep(for:)` nor the
throwing `Task.sleep(nanoseconds:)`, so the page does not implement its 2.1-second
no-late-completion grace locally. After cancellation and deadline it awaits one
ordinary generated `ProbeActor.waitForObservation()` RPC per grace, for two
calls total; the Native actor performs each 2.1-second grace using Native
`Task.sleep`. The Native host intentionally serializes distributed invocations
for one exact address until execution finishes, so state checks do not call
`counts()` on the in-flight `primary` address. `waitForCounts` instead makes at
most 50 ordinary generated `observer.counts()` RPCs, with no added sleep or
yield; the observer resolves `primary` with
`ActorAddress(type: id.type, identity: "primary")`
and reads it only through `whenLocal`. The outer harness enforces a 20-second
wall-clock bound. This Native observation path is not deadline-clock evidence:
the 750-millisecond caller deadline must still originate in
`ActorCallOptions.withValue` and execute through the production
`CloudflareActorClock`.

JavaScript and HTTP boundaries may copy owned frame bytes as required by their
ABIs. This fixture makes no zero-copy claim and must not replace those boundaries
with an in-process shortcut.

## Verification and Change Impact

The single completion command is `Validation/EmbeddedPageWorker/run.sh`. A
successful compile/link is intermediate evidence only. Completion requires the
actual local-workerd run to assert every outcome below and exit after all owned
processes have terminated.

| Observable | Rejected counterexample |
|---|---|
| Authored `@Page`/`PageDocument` returns HTTP 200 | Launcher builds but does not execute rendering, or a handwritten response bypasses it. |
| Same-named application module/type and qualified Actor binding compile through the launcher alias | The fixture renames the application, changes package module identity, or emits the Actor type unqualified. |
| Actor success crosses namespace/RPC and Native dispatch | JavaScript returns a fixture value directly. |
| Exact typed application and system failures remain distinct | Either failure becomes a success or generic substitute. |
| In-flight cancellation prevents later completion | The request reports cancellation while work remains live. |
| `observer.counts()` sees the primary state while `primary.hold()` owns its address gate | Counts are queued behind the in-flight primary RPC, stored in shared/global fixture state, or the authored Native source depends on the generated descriptor extension instead of its registered `id.type`. |
| Scoped deadline uses the Cloudflare clock | Timeout is injected at the Native boundary or synthesized by HTTP. |
| Embedded Core shutdown completes and a later call is rejected | Only the Worker process is stopped. |
| Worker and Native process cleanup meet the runner deadline | The assertions pass but a child process or pending timer remains. |
| Timeout helper preserves normal/failure, 124, 130, and 143 outcomes while removing descendants | The wrapper exits with a wrong status or leaves any process in its owned group alive. |

Changes to generation, launcher exports, Actor framing, request-client binding,
clock installation, or process ownership require this gate to run again. Tests
inside narrower owners remain necessary for their contracts but do not replace
this integration evidence.

The SwiftWeb materializer's focused compiler regression separately keeps two
modules with the same Actor type name and proves that both references remain
qualified while only the colliding module receives a launcher alias.
