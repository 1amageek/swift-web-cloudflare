# SwiftWebCloudflareActorHost

## Purpose and Scope

This module is a child of the [package design](../../DESIGN.md). It owns the
Cloudflare actor-only service host: runtime bootstrap context, application
registration, admission, frame ingress, and terminal shutdown. It does not own
application actors, DatabaseWire, Calendar policy, or the JavaScript request
registry.

## Responsibilities and Boundaries

The host validates the runtime bridge identity, configures the existing
`WebActorSystem`, passes an immutable bootstrap context to the application-owned
registration closure, and admits frames only after registration and system
startup both succeed. The application owns actor factory construction and
authorization policy. Cloudflare owns Durable Object identity and eviction; the
host does not invent a second passivation timer.

## Related Designs

| Design | Relationship | Contract used | Cautions |
|---|---|---|---|
| [Package](../../DESIGN.md) | parent | Generic Cloudflare request and lifecycle boundary | Keep platform errors and raw JavaScript values inside the adapter. |
| [Host module](../SwiftWebCloudflareHost/DESIGN.md) | coordinates with | Request client categories and shared Mutex/actor rules | The request client owns transport bytes; this module owns service admission. |
| [Deployment common runtime](../../Adapter/Templates/Deployment/common/DESIGN.md) | coordinates with | Runtime/call ownership and terminal callback ordering | The common runtime owns registry release; this host owns Core shutdown and does not release JavaScript registrations. |
| SwiftWeb Actors | depends on | `WebActorSystem.configureHosting`, registration, start, invoke, and shutdown | Do not duplicate Actor Core lifecycle or introduce a second RPC. |

## Architecture

```text
Cloudflare runtime identity
        |
        v
bootstrap context -> configure WebActorSystem -> register application actors
                                                   |
                                                   v
                                          start -> ready -> invoke frames
                                                   |
                                                   v
       common shutdown call ID -> existing shutdown() -> terminal callback
                                                   |
                                                   v
                              common registry/storage release
```

## Contracts and Invariants

`CloudflareActorServiceBootstrapContext` contains only the validated runtime
and rendering identifiers. It is immutable and `Sendable`; application policy,
credentials, and database transports are constructed by the registration
closure rather than stored by this generic host. Registration receives the same
context used for startup and is called at most once per successful start.

The state machine is `idle -> starting -> ready -> stopped` or
`starting -> failed`. A failed or stopped host never admits an ingress frame.
An invocation validates runtime identity, call identity, peer identity, hosted
actor identity, and the `WebActorSystem.configuration.maximumFrameBytes` bound
before scheduling asynchronous work. Actor Core owns concurrent invocation
admission, cancellation, and control-frame ordering; this host does not add a
second in-flight limit that could reject a cancellation or control frame.
Each accepted call reports exactly one completion or failure callback. A
shutdown request rejects future calls, stops admission, and delegates Actor
Core cleanup once; an in-flight call is allowed to settle through the Core
contract. The generic bridge captures the validated runtime ID and shutdown call
ID before awaiting `shutdown()`. The thin application launcher is the only
composition-owned export; it reports exactly one terminal success or failure
callback and does not release the common registry, storage token, or database
execution callback.

## State, Ownership, and Lifecycle

| State | Native | Standard WASM | Embedded WASM | Owner and cleanup |
|---|---|---|---|---|
| Host phase and executor installation | `Mutex<State>` | `Mutex<State>` | Not compiled (`SWIFTWEB_ACTORS` unavailable) | Native and standard WASM host builds transition phase and stop admission; Actor Core owns concurrent invocation admission. |
| Actor Core configuration and registrations | `WebActorSystem` | `WebActorSystem` | Not compiled (`SWIFTWEB_ACTORS` unavailable) | SwiftWeb Actors owns registration and shutdown semantics. |
| Invocation frame and callback | bridge-owned value, then Core | bridge-owned value, then Core | Not compiled (`SWIFTWEB_ACTORS` unavailable) | Bridge validates/owns input; Core settles once. |

Native and standard WASM host builds use the same `Mutex<State>` contract.
Embedded page/client code does not compile this `SWIFTWEB_ACTORS` service-host
module, so this design makes no Embedded ActorHost Mutex or runtime claim.
JavaScript bridge values are consumed before the asynchronous task crosses its
Sendable boundary.

## Failure, Concurrency, and Constraints

Startup failure is reported through the existing rendering-failure bridge and
leaves the host non-admitting. Invalid frame input, identity mismatch,
oversize input, not-ready state, cancellation, and shutdown are explicit
failures. The host does not retry registration or invocation and does not turn
an unknown error into success. Actor Core remains the owner of invocation
deadline and cancellation semantics; the host only enforces the bridge's
admission and ownership boundary. A shutdown failure still reaches the owning
runtime as a typed terminal failure; releasing a JavaScript registration before
that callback would strand pending promises and is prohibited.

## Verification and Change Impact

Native tests cover the request failure-category mappings and bridge byte-bound
checks. The actual local-workerd Swift adapter fixture owns proof of bootstrap
context propagation, registration-to-ready admission, identity and size
rejection, cancellation, exactly-once completion, and explicit shutdown across
the real Durable Object namespace/RPC boundary. A native-only or Node-only
test cannot substitute for that proof. This module is not compiled for the
Embedded page/client target, so no Embedded ActorHost behavior is claimed.
The AR-02 composition test additionally proves that the common registry remains
live until the terminal callback and that a failed or released runtime rejects
later callbacks. Calendar composition and DatabaseTransport injection are
verified by the later integration work item.
