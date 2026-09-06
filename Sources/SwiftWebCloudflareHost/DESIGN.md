# SwiftWebCloudflareHost

## Purpose and Scope

This module is a child of the [package design](../../DESIGN.md). Existing
rendering and shared-state responsibilities remain in the linked contracts;
this document owns the platform deadline-clock boundary.

## Responsibilities and Boundaries

`CloudflareHost` installs the Embedded default system's clock before rendering.
An application-owned custom clock is not replaced. `CloudflareActorClock`
implements the existing `ActorClock` protocol using the native Worker timer;
ActorSystemCore continues to own invocation deadlines and cancellation.

## Related Designs

| Design | Relationship | Contract used | Cautions |
|---|---|---|---|
| [Package](../../DESIGN.md) | parent | Profiles and dependency provenance | Keep browser and host capabilities distinct. |
| [Rendering](../../Documentation/CloudflareHostRendering.md) | coordinates with | One app render and bridge ownership | Install after render reservation and before AppRenderer. |
| [Concurrency](../../Documentation/CloudflareHostConcurrency.md) | coordinates with | Common owner/isolation on all targets | JavaScript objects stay inside the clock driver actor. |
| [SwiftWeb Actors](https://github.com/1amageek/swift-web/blob/main/Sources/SwiftWebRuntime/Actors/DESIGN.md) | depends on | `installActorClock(_:)` | First deadline-clock use seals the shared binding. |

## Architecture

```text
Actor deadline task -> CloudflareActorClock -> actor-isolated driver
    -> scheduler.wait(milliseconds, { signal }) -> Promise settlement
Task cancellation -> driver -> AbortController.abort() -> Promise rejection
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

## State, Ownership, and Lifecycle

| State | Native storage/isolation | Standard WASM storage/isolation | Embedded WASM storage/isolation | Entry points and cleanup |
|---|---|---|---|---|
| Host reservation and installation flags | `Mutex<State>` | `Mutex<State>` | `Mutex<State>` | `render` reserves and updates under the same lock; host release owns storage release. |
| Timer IDs and controllers | Driver actor | Driver actor | Driver actor | `sleep` registers, `abort` looks up, and settlement removes the entry. |

Each clock retains one driver actor. Each active sleep owns one AbortController
and one Promise observation; settlement removes its driver entry. Cancellation
aborts the native timer and resumes the waiter with `CancellationError`.
Actor-system shutdown cancels and joins its deadline tasks through the existing
Core lifecycle; the clock does not introduce a second shutdown coordinator.
Only the Embedded host installs this clock. Native compilation and duration
tests do not claim execution of JavaScript timers outside a JavaScript host.

## Failure, Concurrency, and Constraints

The timer follows [Worker scheduler semantics](https://developers.cloudflare.com/workers/runtime-apis/scheduler/),
not a hard-real-time guarantee. Production Worker time does not advance during
CPU execution. The pinned workerd `v1.20260801.1` implementation
[clears aborted timers](https://github.com/cloudflare/workerd/blob/d82c2a45a8695aac30d4d24828ce1ee7fb11909b/src/workerd/api/basics.c%2B%2B#L986)
and [defines the duration limit](https://github.com/cloudflare/workerd/blob/d82c2a45a8695aac30d4d24828ce1ee7fb11909b/src/workerd/io/io-context.c%2B%2B#L953).
Driver state is accessed only on its actor; no JS handle crosses the
cancellation handler's Sendable boundary.

## Verification and Change Impact

Host tests cover duration conversion. The [local-workerd clock fixture](../../Validation/ActorClock/README.md) must
exercise the production clock under pinned Embedded WASM: automatic firing,
pre-cancellation, in-flight cancellation, no later timer firing, and Core
shutdown racing a deadline. A new platform clock or binding change requires
rechecking the SwiftWeb SPI contract and the actual host execution path.
