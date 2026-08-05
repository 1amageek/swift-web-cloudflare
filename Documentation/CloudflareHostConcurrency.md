# Cloudflare Host Concurrency Contract

The Cloudflare host uses the same synchronization contract on native, WASM,
and Embedded WASM builds. Worker isolate scheduling is not used as evidence
that shared mutable state is race-free.

| Logical state | Storage type | Isolation | Read entry point | Mutation entry point | Release |
|---|---|---|---|---|---|
| Host phase and rendered installation | `Mutex<CloudflareHost.State>` | `Synchronization.Mutex` | Scoped ready-installation snapshot | Render reservation, success, and failure transitions | Generated launcher's immutable host lifetime |
| Actor socket transports | `Mutex<[Int: WebSocketActorTransport]>` | `Synchronization.Mutex` | Scoped socket lookup | Open and close operations | Removed on socket close; callbacks run after unlocking |
| Session records | `Mutex<[String: [String: String]]>` | `Synchronization.Mutex` | `CloudflareSessionStorage.read` | `write` and `delete` | Host lifetime |
| Request session state | `Mutex<CloudflareSessionBox.State>` | `Synchronization.Mutex` | `RequestSession` reader closures | Writer, destroy, and finalize closures | Request session lifetime |
| Streaming response collection | `CollectingBodyChunks` actor | Actor isolation | `all()` | `append(_:)` | Response collection task lifetime |

No lock scope performs `await`, JavaScript calls, storage I/O, response
encoding, or WebSocket delivery. Values needed by those operations are captured
under the lock and used after it is released.

The Worker bridge assigns a runtime identifier to every WASM instance and keeps
pending request state inside that runtime object. Module-level ownership is
limited to the runtime registry and page-runtime cache; request payloads are
captured synchronously by Swift before the Worker global bridge slots can be
reused.

Target-specific conditional compilation may remove actor functionality when
the `Actors` trait is disabled, but it does not change the isolation of host,
page, session, or request state.
