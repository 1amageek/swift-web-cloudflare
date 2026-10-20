# SwiftWebCloudflareHost

## Purpose and Scope

This module is a child of the [package design](../../DESIGN.md). Existing
rendering and shared-state responsibilities remain in the linked contracts;
this document owns the platform deadline-clock and Actor request-client
installation boundaries. Actor service bootstrap and admission are specified
by the sibling [Actor host module](../SwiftWebCloudflareActorHost/DESIGN.md).

## Responsibilities and Boundaries

`CloudflareHost` installs the Embedded default system's clock before rendering.
An application-owned custom clock is not replaced. `CloudflareActorClock`
implements the existing `ActorClock` protocol using the native Worker timer;
ActorSystemCore continues to own invocation deadlines and cancellation.
When generated service bindings exist, the host installs the request client
that forwards owned Actor frames to the JavaScript service bridge. It does not
host a local Embedded distributed actor or own Actor Core shutdown. The request
client converts Cloudflare-specific Promise rejection properties into the
generic failure categories accepted by SwiftWeb and never retries a frame.

## Related Designs

| Design | Relationship | Contract used | Cautions |
|---|---|---|---|
| [Package](../../DESIGN.md) | parent | Profiles and dependency provenance | Keep browser and host capabilities distinct. |
| [Rendering](../../Documentation/CloudflareHostRendering.md) | coordinates with | One app render and bridge ownership | Install after render reservation and before AppRenderer. |
| [Concurrency](../../Documentation/CloudflareHostConcurrency.md) | coordinates with | Common owner/isolation on all targets | JavaScript objects stay inside the clock driver actor. |
| [SwiftWeb Actors](https://github.com/1amageek/swift-web/blob/main/Sources/SwiftWebRuntime/Actors/DESIGN.md) | depends on | `installActorClock(_:)`, `installActorRequestClient(_:)`, and task-scoped call options | First deadline-clock use seals the shared binding. |

## Architecture

```text
Actor deadline task -> CloudflareActorClock -> actor-isolated driver
    -> scheduler.wait(milliseconds, { signal }) -> Promise settlement
Task cancellation -> driver -> AbortController.abort() -> Promise rejection
generated Actor call -> CloudflareActorRequestClient -> JavaScript service bridge
Cloudflare rejection -> typed platform category -> SwiftWeb ActorSystem
```

## Contracts and Invariants

Positive durations round up to whole milliseconds using integer arithmetic.
Durations beyond workerd's 3,153,600,000,000 ms timer limit fail explicitly;
they are not silently shortened. Nonpositive waits return immediately unless
the task is cancelled. Missing APIs, synchronous JavaScript exceptions, and
Promise rejection remain observable failures.

## Runtime Flows

Rendering reserves the host, installs the JavaScript executor, installs the
shared clock, then enters AppRenderer. The host remembers a successful clock
install across failed-render retries. A custom-system no-op does not set that
flag, so a retry with the default system still installs its clock. The render
reservation serializes installation attempts; the flag uses the existing
host-state Mutex. Cancellation and settlement follow the architecture flow
above and the lifecycle contract below.

Within a rendered request, an application may scope an ordinary generated
Actor call with swift-actor-system's `ActorCallOptions` contract. The Embedded
facade writes its timeout into the outbound frame and races the request using
the installed Cloudflare clock. Cancellation or timeout aborts the pending
JavaScript request and Core sends its cancellation frame after dispatch. The
host does not select or store an application timeout.

The request client receives the existing `WebActorSystem.configuration` frame
limit when the application is rendered. It borrows the source `ActorByteBuffer`
only while creating the JavaScript typed-array view. The service bridge owns the
bytes after the call boundary; the Swift client copies the response into one
`ActorByteBuffer` after checking the same configured byte bound. A rejected
Promise is classified while its JavaScript value is still local and no raw
Cloudflare object crosses the Sendable boundary.

## State, Ownership, and Lifecycle

| State | Native storage/isolation | Standard WASM storage/isolation | Embedded WASM storage/isolation | Entry points and cleanup |
|---|---|---|---|---|
| Host reservation and installation flags | `Mutex<State>` | `Mutex<State>` | `Mutex<State>` | `render` reserves and updates under the same lock; host release owns storage release. |
| Timer IDs and controllers | Driver actor | Driver actor | Driver actor | `sleep` registers, `abort` looks up, and settlement removes the entry. |
| Request IDs, abort controllers, and admission flag | Request driver actor | Request driver actor | Request driver actor | Request dispatch owns the ID; cancellation or shutdown removes it exactly once. |
| Diagnostic correlation | Immutable task-local value | Immutable task-local value | Immutable task-local value | Host captures IDs before dispatch; lexical scope restores its predecessor after every exit. |

Each clock retains one driver actor. Each active sleep owns one AbortController
and one Promise observation; settlement removes its driver entry. Cancellation
aborts the native timer and resumes the waiter with `CancellationError`.
Actor-system shutdown cancels and joins its deadline tasks through the existing
Core lifecycle; the clock does not introduce a second shutdown coordinator.
Only the Embedded host installs this clock. Native compilation and duration
tests do not claim execution of JavaScript timers outside a JavaScript host.
The application runtime owns Actor Core shutdown. The validation harness owns
workerd disposal and Native service-peer termination/join; no
`CloudflareHost.shutdown` API is implied.

## Failure, Concurrency, and Constraints

The timer follows [Worker scheduler semantics](https://developers.cloudflare.com/workers/runtime-apis/scheduler/),
not a hard-real-time guarantee. Production Worker time does not advance during
CPU execution. The pinned workerd `v1.20260801.1` implementation
[clears aborted timers](https://github.com/cloudflare/workerd/blob/d82c2a45a8695aac30d4d24828ce1ee7fb11909b/src/workerd/api/basics.c%2B%2B#L986)
and [defines the duration limit](https://github.com/cloudflare/workerd/blob/d82c2a45a8695aac30d4d24828ce1ee7fb11909b/src/workerd/io/io-context.c%2B%2B#L953).
Driver state is accessed only on its actor; no JS handle crosses the
cancellation handler's Sendable boundary.

Request cancellation has precedence over a settled error. 401/403 map to
authorization failure, 408/504 to timeout, 429 to overload, 503 to transport
unavailability, and all other non-success statuses to a remote failure code.
Cloudflare `overloaded`, `retryable`, and unknown Promise rejection properties
are classified without a retry policy in this adapter; retry ownership remains
with the caller and idempotency policy.

Page diagnostics capture immutable runtime/call IDs before asynchronous work
and propagate them in a task-local scope on every target. Diagnostics never
read mutable bridge IDs after an await. Known Actor failures use stable numeric
codes on Native, WASM and Embedded; unknown Embedded errors are explicitly
unclassified. Public HTTP error bodies remain generic. Promise rejection is
reported before classification with its transport request ID and phase, while
the JS value is local. The common bridge bounds names/stacks and excludes error
messages, endpoint URLs, request data and arbitrary properties. Reporting never
changes error categories, cancellation precedence or retry behavior.

## Verification and Change Impact

Native tests cover duration conversion, request-category mapping, and byte
bounds. Shutdown and cancellation are proven by the standard-WASM and Embedded
actual-workerd ActorBoundary fixture. The [local-workerd clock fixture](../../Validation/ActorClock/README.md) must
exercise the production clock under pinned Embedded WASM: automatic firing,
pre-cancellation, in-flight cancellation, no later timer firing, and Core
shutdown racing a deadline. A new platform clock or binding change requires
rechecking the SwiftWeb SPI contract and the actual host execution path.
The package-level Embedded page-worker validation separately proves the
generated request client, actual local Durable Object namespace/RPC, Native
`WebActorSystem` service peer backed by `SwiftActorSystem`, failures, deadline,
and terminal cleanup. A direct JavaScript request-handler substitution does not
prove that boundary.
Diagnostic tests verify known codes, task-local isolation/restoration, generic
HTTP errors and bounded JS reporting. A release-toolchain Embedded runtime
probe executes the diagnostic bridge; Native results alone are insufficient.
